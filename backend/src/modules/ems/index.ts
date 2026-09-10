// ---------------------------------------------------------------------------
// EMS / emergency medical module (player-operated).
//
// Server-authoritative health state machine + medical records + billing:
//
//   healthy --(report down)--> downed --(rescue)--> treated --(treat)--> healthy
//   downed --(downed-expiry, lazy on read)--> dead
//   any --(declare death / entityDie)--> dead --(hospitalize on respawn)--> healthy
//
// A citizen who dies is flagged `must_respawn_hospital`; the behavior pack
// teleports them to the hospital point on every spawn and calls
// /bridge/ems/hospitalize, which returns them to healthy and issues a
// hospital bill. Downed expiry is lazy (settled on read using the server
// clock, mirroring warrant expiry in 027) — no background job needed.
//
// Bills are a deliberate money sink: paying one calls economy.debit with
// refType 'medical' and refId "medical:<billId>". There is no hospital
// account yet, so the cash leaves circulation. Treatment cost comes from
// config (MEDICAL_BILL_CENTS = MASTER_PROMPT §26 "medical cost").
//
// Own state transitions (down/die/hospitalize) are self-service — the pack
// reports against the caller's own persistentId. Medic verbs (rescue / treat
// / declare-death) are RBAC-gated (ems.manage); bill waiving + admin reset
// need ems.admin. Every transition and bill action is audited.
// ---------------------------------------------------------------------------

import { pool, withTransaction } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";
import { config } from "../../config/index.js";
import * as character from "../character/index.js";
import * as economy from "../economy/index.js";
import { publish } from "../../eventbus/index.js";

// ---------------------------------------------------------------------------
// Domain errors (mapped to HTTP by bridge / admin route wrappers)
// ---------------------------------------------------------------------------

export class MedicalRecordNotFoundError extends Error {}
export class BillNotFoundError extends Error {}
export class BillAccessDeniedError extends Error {}
export class BillAlreadyPaidError extends Error {}
export class StateTransitionError extends Error {}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VALID_HEALTH_STATES = new Set(["healthy", "downed", "treated", "dead"]);
export const VALID_BILL_STATUSES = new Set(["unpaid", "paid", "waived"]);
export const VALID_CURRENCIES = new Set<economy.Currency>(["cash", "bank", "red_money"]);

// ---------------------------------------------------------------------------
// Views (DB rows -> wire shape)
// ---------------------------------------------------------------------------

export interface MedicalView {
  characterId: number;
  healthState: string;
  downedAt: string | null;
  downedBy: number | null;
  downedRemainingSeconds: number | null; // only meaningful while downed
  downedLocation: { x: number; y: number; z: number; dimension: string } | null;
  treatedBy: number | null;
  treatedAt: string | null;
  diedAt: string | null;
  mustRespawnHospital: boolean;
  hospitalizationCount: number;
  notes: string | null;
  updatedAt: string | null;
}

export interface BillView {
  id: number;
  patientId: number;
  issuedBy: number | null;
  amountCents: number;
  currency: string;
  reason: string;
  status: string;
  issuedAt: string | null;
  paidAt: string | null;
  paidBy: number | null;
}

export interface MedicalRowView {
  id: number;
  name: string;
  citizenId: string | null;
  persistentId: string | null;
  healthState: string;
  downedRemainingSeconds: number | null;
  mustRespawnHospital: boolean;
  unpaidBillCount: number;
  hospitalizationCount: number;
}

export interface MineMedicalView {
  healthState: string;
  downedRemainingSeconds: number | null;
  mustRespawnHospital: boolean;
  hospitalizationCount: number;
  notes: string | null;
  bills: BillView[];
}

// ---------------------------------------------------------------------------
// Row -> view mappers
// ---------------------------------------------------------------------------

function toMedicalView(row: any, nowMs: number = Date.now()): MedicalView {
  const isDowned = row.health_state === "downed";
  let remaining: number | null = null;
  if (isDowned && row.downed_at) {
    const deadline = new Date(row.downed_at).getTime() + config.EMS_DOWNED_EXPIRY_SECONDS * 1000;
    remaining = Math.max(0, Math.floor((deadline - nowMs) / 1000));
  }
  return {
    characterId: Number(row.character_id),
    healthState: row.health_state,
    downedAt: row.downed_at ? new Date(row.downed_at).toISOString() : null,
    downedBy: row.downed_by == null ? null : Number(row.downed_by),
    downedRemainingSeconds: remaining,
    downedLocation: row.downed_location ? { ...(row.downed_location as object) } as { x: number; y: number; z: number; dimension: string } : null,
    treatedBy: row.treated_by == null ? null : Number(row.treated_by),
    treatedAt: row.treated_at ? new Date(row.treated_at).toISOString() : null,
    diedAt: row.died_at ? new Date(row.died_at).toISOString() : null,
    mustRespawnHospital: row.must_respawn_hospital,
    hospitalizationCount: Number(row.hospitalization_count),
    notes: row.notes ?? null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function toBillView(row: any): BillView {
  return {
    id: Number(row.id),
    patientId: Number(row.patient_id),
    issuedBy: row.issued_by == null ? null : Number(row.issued_by),
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    issuedAt: row.issued_at ? new Date(row.issued_at).toISOString() : null,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    paidBy: row.paid_by == null ? null : Number(row.paid_by),
  };
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/** Locks a citizen's medical record row (must exist — see ensureMedicalRow). */
async function loadMedicalRow(client: any, characterId: number, forUpdate = false): Promise<any> {
  const { rows } = await client.query(
    `SELECT * FROM medical_records WHERE character_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [characterId]
  );
  if (rows.length === 0) throw new MedicalRecordNotFoundError("no medical record for this citizen");
  return rows[0];
}

/**
 * Settles an expired 'downed' state -> 'dead' (server clock authoritative,
 * mirrors warrant expiry in the police module). Returns the row afterwards.
 * Audited so a lazy expiry is traceable.
 */
async function settleOnRead(client: any, row: any): Promise<any> {
  if (row.health_state !== "downed" || !row.downed_at) return row;
  const deadline = new Date(row.downed_at).getTime() + config.EMS_DOWNED_EXPIRY_SECONDS * 1000;
  if (Date.now() < deadline) return row;
  const updated = (await client.query(
    `UPDATE medical_records
     SET health_state = 'dead', died_at = now(), died_by = downed_by,
         notes = COALESCE(notes, '') || E'\n[auto] downed state expired without EMS intervention',
         updated_at = now()
     WHERE character_id = $1 AND health_state = 'downed'
     RETURNING *`,
    [row.character_id]
  )).rows[0];
  await writeAudit(
    {
      actorUserId: null,
      action: "ems.down.expire",
      targetType: "character",
      targetId: String(row.character_id),
      payload: { secondsDowned: config.EMS_DOWNED_EXPIRY_SECONDS },
      result: "success",
    },
    client
  );
  publish({ type: "PHONE_MEDICAL_CHANGED", characterId: Number(row.character_id), healthState: "dead" });
  return updated;
}

/** Full medical dossier for one citizen (record + all bills) - medic/admin view. */
export async function getMedical(characterId: number, opts?: { actorUserId?: number | null; requestId?: string | null }): Promise<{ record: MedicalView; bills: BillView[] } | null> {
  const profile = await character.getCharacterById(characterId);
  if (!profile) return null;
  let row: any;
  await withTransaction(async (client) => {
    await ensureMedicalRow(client, characterId);
    row = await loadMedicalRow(client, characterId, true);
    row = await settleOnRead(client, row);
    await writeAudit(
      {
        actorUserId: opts?.actorUserId ?? null,
        action: "ems.lookup",
        targetType: "character",
        targetId: String(characterId),
        payload: {},
        result: AUDIT_SUCCESS,
        requestId: opts?.requestId ?? null,
      },
      client
    );
  });
  const { rows: billRows } = await pool.query(
    `SELECT * FROM medical_bills WHERE patient_id = $1 ORDER BY issued_at DESC`,
    [characterId]
  );
  return { record: toMedicalView(row), bills: billRows.map(toBillView) };
}

/** EMS medic search by citizen id or name (mirrors police MDT lookup). */
export async function searchMedical(query: string): Promise<{ record: MedicalView; bills: BillView[]; name: string; citizenId: string | null; persistentId: string | null } | null> {
  const q = String(query ?? "").trim();
  if (q.length === 0 || q.length > 128) return null;
  let row = (await pool.query(
    `SELECT id FROM characters WHERE is_deleted = false AND citizen_id = $1 LIMIT 1`,
    [q]
  )).rows[0];
  if (!row) {
    row = (await pool.query(
      `SELECT id FROM characters WHERE is_deleted = false AND name ILIKE $1 LIMIT 1`,
      [`%${q}%`]
    )).rows[0];
  }
  if (!row) return null;
  const characterId = Number(row.id);
  const medical = await getMedical(characterId);
  if (!medical) return null;
  const profile = await character.getCharacterById(characterId);
  return {
    ...medical,
    name: profile?.name ?? "?",
    citizenId: profile?.citizen_id ?? null,
    persistentId: profile?.persistent_id ?? null,
  };
}

/**
 * The citizen's own medical state (`/bridge/ems/me`, pack spawn hook + phone
 * app). Also the single source that lazily settles downed expiry.
 */
export async function getMineMedicalState(characterId: number): Promise<MineMedicalView> {
  await withTransaction(async (client) => {
    await ensureMedicalRow(client, characterId);
    const row = await loadMedicalRow(client, characterId, true);
    await settleOnRead(client, row);
  });
  const row = (await pool.query(`SELECT * FROM medical_records WHERE character_id = $1`, [characterId])).rows[0];
  const { rows: bills } = await pool.query(
    `SELECT * FROM medical_bills WHERE patient_id = $1 ORDER BY issued_at DESC LIMIT 50`,
    [characterId]
  );
  const view = toMedicalView(row);
  return {
    healthState: view.healthState,
    downedRemainingSeconds: view.downedRemainingSeconds,
    mustRespawnHospital: view.mustRespawnHospital,
    hospitalizationCount: view.hospitalizationCount,
    notes: view.notes,
    bills: bills.map(toBillView),
  };
}

/** Ensure a medical record row exists for a character (created lazily). */
async function ensureMedicalRow(client: any, characterId: number): Promise<void> {
  await client.query(
    `INSERT INTO medical_records (character_id) VALUES ($1)
     ON CONFLICT (character_id) DO NOTHING`,
    [characterId]
  );
}

/** Medic / admin record list (searchable). */
export async function listMedicalRecords(opts: {
  state?: string;
  query?: string;
  limit: number;
  offset: number;
}): Promise<MedicalRowView[]> {
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = Math.max(0, opts.offset || 0);
  const params: unknown[] = [];
  let where = `1 = 1`;
  if (opts.state && VALID_HEALTH_STATES.has(opts.state)) {
    params.push(opts.state);
    where += ` AND mr.health_state = $${params.length}`;
  }
  const q = String(opts.query ?? "").trim();
  if (q.length > 0) {
    params.push(`%${q}%`);
    where += ` AND (c.name ILIKE $${params.length} OR c.citizen_id ILIKE $${params.length} OR c.persistent_id ILIKE $${params.length})`;
  }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.citizen_id AS "citizenId", c.persistent_id AS "persistentId",
            mr.health_state AS "healthState",
            mr.downed_at AS "downedAt", mr.must_respawn_hospital AS "mustRespawnHospital",
            mr.hospitalization_count AS "hospitalizationCount",
            (SELECT COUNT(*) FROM medical_bills b WHERE b.patient_id = c.id AND b.status = 'unpaid')::int AS "unpaidBillCount"
     FROM characters c
     JOIN medical_records mr ON mr.character_id = c.id
     WHERE ${where}
     ORDER BY c.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const nowMs = Date.now();
  return rows.map((r: any) => {
    let remaining: number | null = null;
    if (r.healthState === "downed" && r.downedAt) {
      const deadline = new Date(r.downedAt).getTime() + config.EMS_DOWNED_EXPIRY_SECONDS * 1000;
      remaining = Math.max(0, Math.floor((deadline - nowMs) / 1000));
    }
    return {
      id: Number(r.id),
      name: r.name,
      citizenId: r.citizenId ?? null,
      persistentId: r.persistentId ?? null,
      healthState: r.healthState,
      downedRemainingSeconds: remaining,
      mustRespawnHospital: r.mustRespawnHospital,
      unpaidBillCount: Number(r.unpaidBillCount),
      hospitalizationCount: Number(r.hospitalizationCount),
    };
  });
}

/** Admin bill list (status filter). */
export async function listBills(opts: { status?: string; limit: number; offset: number }): Promise<BillView[]> {
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = Math.max(0, opts.offset || 0);
  const params: unknown[] = [];
  let where = `1 = 1`;
  if (opts.status && VALID_BILL_STATUSES.has(opts.status)) {
    params.push(opts.status);
    where = `status = $1`;
  }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT * FROM medical_bills WHERE ${where} ORDER BY issued_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(toBillView);
}

export async function getBill(billId: number): Promise<BillView | null> {
  if (!Number.isSafeInteger(billId) || billId <= 0) throw new TypeError("billId must be a positive integer.");
  const { rows } = await pool.query(`SELECT * FROM medical_bills WHERE id = $1`, [billId]);
  return rows.length === 0 ? null : toBillView(rows[0]);
}

// ---------------------------------------------------------------------------
// Writes (all audited)
// ---------------------------------------------------------------------------

const AUDIT_SUCCESS = "success" as const;

function auditTransition(client: any, params: {
  actorUserId: number | null;
  action: string;
  characterId: number;
  payload: Record<string, unknown>;
  requestId?: string | null;
}) {
  return writeAudit(
    {
      actorUserId: params.actorUserId,
      action: params.action,
      targetType: "character",
      targetId: String(params.characterId),
      payload: params.payload,
      result: AUDIT_SUCCESS,
      requestId: params.requestId,
    },
    client
  );
}

/** Self-service: the citizen reports themselves downed (any previous state -> downed). */
export async function reportDown(params: {
  characterId: number;
  byCharacterId: number | null;
  location?: { x: number; y: number; z: number; dimension?: string } | null;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<MedicalView> {
  const { characterId, byCharacterId, actorUserId, requestId } = params;
  const location = params.location
    ? {
        x: Number(params.location.x) || 0,
        y: Number(params.location.y) || 0,
        z: Number(params.location.z) || 0,
        dimension: String((params.location as any).dimensionId ?? params.location.dimension ?? "overworld").slice(0, 64),
      }
    : null;

  let row: any;
  await withTransaction(async (client) => {
    await ensureMedicalRow(client, characterId);
    const current = await loadMedicalRow(client, characterId, true);
    if (current.health_state === "dead") {
      throw new StateTransitionError("a dead citizen cannot go down — respawn at the hospital");
    }
    const updated = (await client.query(
      `UPDATE medical_records
       SET health_state = 'downed', downed_at = now(), downed_by = $2, downed_location = $3,
           treated_by = NULL, treated_at = NULL, died_at = NULL, died_by = NULL,
           must_respawn_hospital = false, updated_at = now()
       WHERE character_id = $1 RETURNING *`,
      [characterId, byCharacterId, location ? JSON.stringify(location) : null]
    )).rows[0];
    await auditTransition(client, { actorUserId, action: "ems.down", characterId, payload: { by: byCharacterId, location }, requestId });
    row = updated;
  });
  publish({ type: "PHONE_MEDICAL_CHANGED", characterId, healthState: "downed" });
  return toMedicalView(row);
}

/** Medic (ems.manage) rescues a downed citizen -> treated (stabilized). */
export async function rescue(params: {
  characterId: number;
  medicCharacterId: number | null;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<MedicalView> {
  const { characterId, medicCharacterId, actorUserId, requestId } = params;
  let row: any;
  await withTransaction(async (client) => {
    await ensureMedicalRow(client, characterId);
    const current = await loadMedicalRow(client, characterId, true);
    if (current.health_state !== "downed") {
      throw new StateTransitionError("only a downed citizen can be rescued");
    }
    const updated = (await client.query(
      `UPDATE medical_records
       SET health_state = 'treated', treated_by = $2, treated_at = now(),
           died_at = NULL, died_by = NULL, updated_at = now()
       WHERE character_id = $1 RETURNING *`,
      [characterId, medicCharacterId]
    )).rows[0];
    await auditTransition(client, { actorUserId, action: "ems.rescue", characterId, payload: { medic: medicCharacterId }, requestId });
    row = updated;
  });
  publish({ type: "PHONE_MEDICAL_CHANGED", characterId, healthState: "treated" });
  return toMedicalView(row);
}

/**
 * Medic (ems.manage) fully treats a stabilized citizen -> healthy and issues
 * a treatment bill (the medical cost money sink; amount overridable per call,
 * currency defaults to cash).
 */
export async function treat(params: {
  characterId: number;
  medicCharacterId: number | null;
  amountCents?: number;
  currency?: string;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<{ record: MedicalView; bill: BillView }> {
  const { characterId, medicCharacterId, actorUserId, requestId } = params;
  const amount = Math.round(Number(params.amountCents ?? config.MEDICAL_BILL_CENTS));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("amountCents must be a positive integer");
  const currency = String(params.currency ?? "cash");
  if (!VALID_CURRENCIES.has(currency as economy.Currency)) throw new Error("currency must be cash, bank or red_money");

  let result: { record: any; bill: any };
  await withTransaction(async (client) => {
    await ensureMedicalRow(client, characterId);
    const current = await loadMedicalRow(client, characterId, true);
    if (current.health_state !== "treated") {
      throw new StateTransitionError("only a rescued (treated) citizen can be fully healed");
    }
    const record = (await client.query(
      `UPDATE medical_records
       SET health_state = 'healthy', updated_at = now()
       WHERE character_id = $1 RETURNING *`,
      [characterId]
    )).rows[0];
    const bill = (await client.query(
      `INSERT INTO medical_bills (patient_id, issued_by, amount_cents, currency, reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [characterId, medicCharacterId, amount, currency, "ค่ารักษาพยาบาล (EMS treatment)"]
    )).rows[0];
    await auditTransition(client, {
      actorUserId, action: "ems.treat", characterId,
      payload: { medic: medicCharacterId, amountCents: amount, currency, billId: Number(bill.id) },
      requestId,
    });
    result = { record, bill };
  });
  publish({ type: "PHONE_MEDICAL_CHANGED", characterId, healthState: "healthy" });
  return { record: toMedicalView(result!.record), bill: toBillView(result!.bill) };
}

/**
 * Death: `selfReport` allows a citizen to declare their own death from any
 * non-dead state (the entityDie hook in the behavior pack). Medic declaration
 * (ems.manage) requires the target to be downed or treated. Either way the
 * citizen must respawn at the hospital and is billed there.
 */
export async function declareDeath(params: {
  characterId: number;
  byCharacterId: number | null;
  selfReport: boolean;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<MedicalView> {
  const { characterId, byCharacterId, selfReport, actorUserId, requestId } = params;
  let row: any;
  await withTransaction(async (client) => {
    await ensureMedicalRow(client, characterId);
    const current = await loadMedicalRow(client, characterId, true);
    if (current.health_state === "dead") {
      throw new StateTransitionError("this citizen is already dead");
    }
    if (!selfReport && !["downed", "treated"].includes(current.health_state)) {
      throw new StateTransitionError("only a downed/unconscious citizen can be declared dead");
    }
    const updated = (await client.query(
      `UPDATE medical_records
       SET health_state = 'dead', died_at = now(), died_by = $2,
           must_respawn_hospital = true, downed_at = NULL, downed_by = NULL,
           downed_location = NULL, treated_by = NULL, treated_at = NULL,
           updated_at = now()
       WHERE character_id = $1 RETURNING *`,
      [characterId, byCharacterId]
    )).rows[0];
    await auditTransition(client, {
      actorUserId, action: "ems.death", characterId,
      payload: { by: byCharacterId, selfReport }, requestId,
    });
    row = updated;
  });
  publish({ type: "PHONE_MEDICAL_CHANGED", characterId, healthState: "dead" });
  return toMedicalView(row);
}

/**
 * Self-service: called by the pack after the citizen respawned at the
 * hospital point. Returns the citizen to healthy and issues a hospital bill
 * (medical cost sink). Only applies when must_respawn_hospital is set.
 */
export async function hospitalize(params: {
  characterId: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<{ record: MedicalView; bill: BillView }> {
  const { characterId, actorUserId, requestId } = params;
  const amount = config.MEDICAL_BILL_CENTS;
  let result: { record: any; bill: any };
  await withTransaction(async (client) => {
    await ensureMedicalRow(client, characterId);
    const current = await loadMedicalRow(client, characterId, true);
    if (!current.must_respawn_hospital) {
      throw new StateTransitionError("no hospital respawn pending for this citizen");
    }
    const record = (await client.query(
      `UPDATE medical_records
       SET health_state = 'healthy', must_respawn_hospital = false,
           hospitalization_count = hospitalization_count + 1,
           died_at = NULL, died_by = NULL, downed_at = NULL, downed_by = NULL,
           downed_location = NULL, treated_by = NULL, treated_at = NULL,
           updated_at = now()
       WHERE character_id = $1 RETURNING *`,
      [characterId]
    )).rows[0];
    const bill = (await client.query(
      `INSERT INTO medical_bills (patient_id, issued_by, amount_cents, currency, reason)
       VALUES ($1, NULL, $2, 'cash', 'ค่าอนุบาลโรงพยาบาล (hospital)') RETURNING *`,
      [characterId, amount]
    )).rows[0];
    await auditTransition(client, {
      actorUserId, action: "ems.hospitalize", characterId,
      payload: { amountCents: amount, currency: "cash", billId: Number(bill.id), hospitalizationCount: Number(record.hospitalization_count) },
      requestId,
    });
    result = { record, bill };
  });
  publish({ type: "PHONE_MEDICAL_CHANGED", characterId, healthState: "healthy" });
  return { record: toMedicalView(result!.record), bill: toBillView(result!.bill) };
}

/** Patient pays their own medical bill (money sink, economy.debit refType 'medical'). */
export async function payBill(params: {
  billId: number;
  characterId: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<BillView> {
  const { billId, characterId, actorUserId, requestId } = params;
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM medical_bills WHERE id = $1 FOR UPDATE`, [billId]);
    if (rows.length === 0) throw new BillNotFoundError("bill not found");
    const bill = rows[0];
    if (Number(bill.patient_id) !== characterId) throw new BillAccessDeniedError("this bill belongs to another citizen");
    if (bill.status !== "unpaid") throw new BillAlreadyPaidError("this bill is already settled");

    const amountCents = Number(bill.amount_cents);
    const currency = bill.currency as economy.Currency;
    await economy.debit({
      characterId,
      amountCents,
      currency,
      reason: `medical bill #${billId}: ${bill.reason}`,
      actorUserId,
      refType: "medical",
      refId: `medical:${billId}`,
      requestId,
    });

    await client.query(`UPDATE medical_bills SET status = 'paid', paid_at = now(), paid_by = $1 WHERE id = $2`, [characterId, billId]);
    await writeAudit(
      {
        actorUserId,
        action: "ems.bill.pay",
        targetType: "medical_bill",
        targetId: String(billId),
        payload: { characterId, amountCents, currency, reason: bill.reason },
        result: AUDIT_SUCCESS,
        requestId,
      },
      client
    );
    return toBillView({ ...bill, status: "paid", paid_at: new Date(), paid_by: characterId });
  });
}

/** Senior EMS (ems.admin) waives a bill without money moving. */
export async function waiveBill(params: {
  billId: number;
  actorUserId: number;
  reason?: string | null;
  requestId?: string | null;
}): Promise<BillView> {
  const { billId, actorUserId, requestId } = params;
  const reason = params.reason ? String(params.reason).trim().slice(0, 500) : "waived by staff";
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM medical_bills WHERE id = $1 FOR UPDATE`, [billId]);
    if (rows.length === 0) throw new BillNotFoundError("bill not found");
    if (rows[0].status !== "unpaid") throw new BillAlreadyPaidError("this bill is already settled");
    const updated = (await client.query(
      `UPDATE medical_bills SET status = 'waived', waived_by = $1, waived_at = now() WHERE id = $2 RETURNING *`,
      [actorUserId, billId]
    )).rows[0];
    await writeAudit(
      {
        actorUserId,
        action: "ems.bill.waive",
        targetType: "medical_bill",
        targetId: String(billId),
        payload: { patientId: Number(rows[0].patient_id), reason },
        result: AUDIT_SUCCESS,
        requestId,
      },
      client
    );
    return toBillView(updated);
  });
}

/** Senior EMS (ems.admin) forces a citizen back to healthy (oops-fix / RP overrides). */
export async function adminReset(params: {
  characterId: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<MedicalView> {
  const { characterId, actorUserId, requestId } = params;
  let row: any;
  await withTransaction(async (client) => {
    await ensureMedicalRow(client, characterId);
    await loadMedicalRow(client, characterId, true);
    const updated = (await client.query(
      `UPDATE medical_records
       SET health_state = 'healthy', downed_at = NULL, downed_by = NULL, downed_location = NULL,
           treated_by = NULL, treated_at = NULL, died_at = NULL, died_by = NULL,
           must_respawn_hospital = false, notes = COALESCE(notes, '') || E'\n[admin] state reset by staff',
           updated_at = now()
       WHERE character_id = $1 RETURNING *`,
      [characterId]
    )).rows[0];
    await auditTransition(client, { actorUserId, action: "ems.reset", characterId, payload: {}, requestId });
    row = updated;
  });
  publish({ type: "PHONE_MEDICAL_CHANGED", characterId, healthState: "healthy" });
  return toMedicalView(row);
}