// ---------------------------------------------------------------------------
// Police / law-enforcement module (player-operated MDT).
//
// Server-authoritative citizen records, licenses, fines, warrants, evidence,
// reports and arrests/jail. The behavior pack (`!police` / `!mdt`) and the
// admin web talk to this module's verbs through the bridge / admin routes;
// every write is audited, and reads are RBAC-gated (police.view / manage /
// admin) but — per current server policy — do NOT require a search warrant:
// the warrant feature is a record-keeping / arrest tool, not a read gate.
//
// Fine money is a deliberate money sink: paying a fine calls economy.debit
// with refType 'fine' and refId "fine:<id>". There is no government account
// yet, so the cash leaves circulation (mirrors vehicle/property government
// purchases) — if a state treasury is added later, redirect the debit there.
// ---------------------------------------------------------------------------

import { pool, withTransaction } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";
import * as character from "../character/index.js";
import * as economy from "../economy/index.js";

// ---------------------------------------------------------------------------
// Domain errors (mapped to HTTP by bridge/admin route wrappers)
// ---------------------------------------------------------------------------

export class CitizenNotFoundError extends Error {}
export class VehicleNotFoundError extends Error {}
export class LicenseNotFoundError extends Error {}
export class LicenseExistsError extends Error {}
export class FineNotFoundError extends Error {}
export class FineAccessDeniedError extends Error {}
export class FineAlreadyPaidError extends Error {}
export class ReportNotFoundError extends Error {}
export class WarrantNotFoundError extends Error {}
export class WarrantNotActiveError extends Error {}
export class CharacterAlreadyInJailError extends Error {}
export class ArrestNotFoundError extends Error {}
export class ArrestNotActiveError extends Error {}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VALID_CURRENCIES = new Set<economy.Currency>(["cash", "bank", "red_money"]);
export const VALID_LICENSE_TYPES = new Set(["driving", "weapon", "business", "fishing", "aviation"]);
export const VALID_THREAT_LEVELS = new Set(["none", "low", "medium", "high", "critical"]);
export const VALID_WARRANT_TYPES = new Set(["arrest", "search"]);
export const VALID_FINE_STATUSES = new Set(["outstanding", "paid"]);
export const VALID_WARRANT_STATUSES = new Set(["active", "executed", "expired", "revoked"]);
export const VALID_REPORT_STATUSES = new Set(["open", "closed"]);
export const VALID_ARREST_STATUSES = new Set(["active", "served", "released", "escaped"]);

export const MIN_ARREST_MINUTES = 1;
export const MAX_ARREST_MINUTES = 24 * 60; // hard cap: 24 hours per sentence

// ---------------------------------------------------------------------------
// Views (DB rows -> wire shape)
// ---------------------------------------------------------------------------

export interface LicenseView {
  id: number;
  characterId: number;
  licenseType: string;
  status: string;
  issuedAt: string | null;
  expiresAt: string | null;
  notes: string | null;
}

export interface RecordView {
  knownAlias: string | null;
  threatLevel: string;
  notes: string | null;
  updatedAt: string | null;
}

export interface FineView {
  id: number;
  officerId: number | null;
  targetCharacterId: number;
  amountCents: number;
  currency: string;
  reason: string;
  status: string;
  paidAt: string | null;
  issuedAt: string | null;
}

export interface WarrantView {
  id: number;
  targetCharacterId: number;
  warrantType: string;
  status: string;
  officerId: number | null;
  reason: string;
  issuedAt: string | null;
  expiresAt: string | null;
  closedAt: string | null;
}

export interface ReportView {
  id: number;
  officerId: number | null;
  title: string;
  body: string;
  classification: string;
  status: string;
  createdAt: string | null;
  evidence: EvidenceView[];
}

export interface EvidenceView {
  id: number;
  reportId: number | null;
  officerId: number | null;
  description: string;
  itemId: string | null;
  quantity: number;
  status: string;
  createdAt: string | null;
}

export interface ArrestView {
  id: number;
  characterId: number;
  officerId: number | null;
  reason: string;
  jailUntil: string | null;
  minutesRemaining: number;
  status: string;
  createdAt: string | null;
}

export interface CitizenProfileView {
  id: number;
  name: string;
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  citizenId: string | null;
  gender: string | null;
  dateOfBirth: string | null;
  persistentId: string | null;
}

export interface CitizenMdtView extends CitizenProfileView {
  record: RecordView | null;
  licenses: LicenseView[];
  fines: FineView[];
  warrants: WarrantView[]; // active only
  arrest: ArrestView | null; // active sentence (null when not in jail)
}

export interface VehicleMdtView {
  id: number;
  plate: string;
  entityType: string;
  status: string;
  locked: boolean;
  fuelLevel: number;
  engineHealth: number;
  suspensionHealth: number;
  bodyDamage: number;
  salePriceCents: number | null;
  saleCurrency: string | null;
  ownerName: string | null;
  ownerCitizenId: string | null;
}

export interface CitizenRowView {
  id: number;
  name: string;
  citizenId: string | null;
  persistentId: string | null;
  threatLevel: string;
  licenseCount: number;
  warrantCount: number;
  outstandingFineCount: number;
}

export interface MineStateView {
  licenses: LicenseView[];
  fines: FineView[];
  warrants: WarrantView[]; // active only
  arrest: ArrestView | null;
}

// ---------------------------------------------------------------------------
// Row -> view mappers
// ---------------------------------------------------------------------------

function toLicenseView(row: any): LicenseView {
  return {
    id: Number(row.id),
    characterId: Number(row.character_id),
    licenseType: row.license_type,
    status: row.status,
    issuedAt: row.issued_at ? new Date(row.issued_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    notes: row.notes ?? null,
  };
}

function toRecordView(row: any): RecordView | null {
  if (!row) return null;
  return {
    knownAlias: row.known_alias ?? null,
    threatLevel: row.threat_level,
    notes: row.notes ?? null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function toFineView(row: any): FineView {
  return {
    id: Number(row.id),
    officerId: row.officer_id == null ? null : Number(row.officer_id),
    targetCharacterId: Number(row.target_character_id),
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    issuedAt: row.issued_at ? new Date(row.issued_at).toISOString() : null,
  };
}

function toWarrantView(row: any): WarrantView {
  return {
    id: Number(row.id),
    targetCharacterId: Number(row.target_character_id),
    warrantType: row.warrant_type,
    status: row.status,
    officerId: row.officer_id == null ? null : Number(row.officer_id),
    reason: row.reason,
    issuedAt: row.issued_at ? new Date(row.issued_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
  };
}

function toEvidenceView(row: any): EvidenceView {
  return {
    id: Number(row.id),
    reportId: row.report_id == null ? null : Number(row.report_id),
    officerId: row.officer_id == null ? null : Number(row.officer_id),
    description: row.description,
    itemId: row.item_id ?? null,
    quantity: Number(row.quantity),
    status: row.status,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function toArrestView(row: any, nowMs: number = Date.now()): ArrestView {
  const jailUntilMs = row.jail_until ? new Date(row.jail_until).getTime() : 0;
  const remaining = row.status === "active" ? Math.max(0, Math.ceil((jailUntilMs - nowMs) / 60_000)) : 0;
  return {
    id: Number(row.id),
    characterId: Number(row.character_id),
    officerId: row.officer_id == null ? null : Number(row.officer_id),
    reason: row.reason,
    jailUntil: row.jail_until ? new Date(row.jail_until).toISOString() : null,
    minutesRemaining: remaining,
    status: row.status,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function toCitizenProfile(row: any): CitizenProfileView {
  return {
    id: Number(row.id),
    name: row.name,
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
    nickname: row.nickname ?? null,
    citizenId: row.citizen_id ?? null,
    gender: row.gender ?? null,
    dateOfBirth: row.date_of_birth ? new Date(row.date_of_birth).toISOString().slice(0, 10) : null,
    persistentId: row.persistent_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/** One character by citizen_id (used for MDT lookup by citizen id). */
export async function findCitizenByCitizenId(citizenId: string): Promise<{ id: number } | null> {
  const { rows } = await pool.query(
    `SELECT id FROM characters WHERE citizen_id = $1 AND is_deleted = false LIMIT 1`,
    [citizenId]
  );
  return rows.length === 0 ? null : { id: Number(rows[0].id) };
}

/** One character by display name (used for MDT lookup by name). */
export async function findCitizenByName(name: string): Promise<{ id: number } | null> {
  const { rows } = await pool.query(
    `SELECT id FROM characters WHERE LOWER(name) = LOWER($1) AND is_deleted = false ORDER BY id DESC LIMIT 1`,
    [name.trim()]
  );
  return rows.length === 0 ? null : { id: Number(rows[0].id) };
}

/** Active arrest for a character, auto-marking an expired sentence as 'served'. */
async function getActiveArrest(characterId: number): Promise<any | null> {
  const { rows } = await pool.query(
    `SELECT * FROM arrests WHERE character_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`,
    [characterId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (new Date(row.jail_until).getTime() <= Date.now()) {
    await pool.query(
      `UPDATE arrests SET status = 'served' WHERE id = $1 AND status = 'active'`,
      [row.id]
    );
    return null;
  }
  return row;
}

async function listLicensesFor(characterId: number): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT * FROM licenses WHERE character_id = $1 ORDER BY issued_at DESC`,
    [characterId]
  );
  return rows;
}

async function listFinesFor(characterId: number, status?: string): Promise<any[]> {
  const params: unknown[] = [characterId];
  let sql = `SELECT * FROM fines WHERE target_character_id = $1`;
  if (status && VALID_FINE_STATUSES.has(status)) {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }
  sql += ` ORDER BY issued_at DESC`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function listActiveWarrantsFor(characterId: number): Promise<any[]> {
  const { rows } = await pool.query(
    `SELECT * FROM warrants WHERE target_character_id = $1 AND status = 'active' ORDER BY issued_at DESC`,
    [characterId]
  );
  return rows;
}

/** Full civil state for a character (used by MDT detail + /bridge/police/me). */
export async function getMineState(characterId: number): Promise<MineStateView> {
  const activeWarrants = await listActiveWarrantsFor(characterId);
  // auto-expire past-dated warrants on read (server clock is authoritative)
  const now = Date.now();
  for (const w of activeWarrants) {
    if (w.expires_at && new Date(w.expires_at).getTime() <= now && w.status === "active") {
      await pool.query(
        `UPDATE warrants SET status = 'expired', closed_at = now() WHERE id = $1 AND status = 'active'`,
        [w.id]
      );
    }
  }
  const activeArrest = await getActiveArrest(characterId);
  return {
    licenses: (await listLicensesFor(characterId)).map(toLicenseView),
    fines: (await listFinesFor(characterId)).map(toFineView),
    warrants: (await listActiveWarrantsFor(characterId)).map(toWarrantView),
    arrest: activeArrest ? toArrestView(activeArrest) : null,
  };
}

/** Full citizen MDT dossier (profile + record + licenses + fines + warrants + arrest). */
export async function getCitizenMdt(characterId: number): Promise<CitizenMdtView | null> {
  const profile = await character.getCharacterById(characterId);
  if (!profile) return null;
  const civil = await getMineState(characterId);
  const recRow = (await pool.query(
    `SELECT * FROM police_records WHERE character_id = $1`, [characterId]
  )).rows[0] ?? null;
  const activeWarrants = (await pool.query(
    `SELECT * FROM warrants WHERE target_character_id = $1 AND status = 'active' ORDER BY issued_at DESC`, [characterId]
  )).rows;
  return {
    ...toCitizenProfile(profile),
    record: toRecordView(recRow),
    licenses: civil.licenses,
    fines: civil.fines,
    warrants: activeWarrants.map(toWarrantView),
    arrest: civil.arrest,
  };
}

/** MDT vehicle record lookup by plate (server-authoritative copy of the vehicle row). */
export async function lookupVehicle(plate: string): Promise<VehicleMdtView | null> {
  const normalized = String(plate).trim().toUpperCase();
  if (normalized.length === 0 || normalized.length > 16) return null;
  const { rows } = await pool.query(
    `SELECT v.id, v.plate, v.entity_type AS "entityType", v.status, v.locked,
            v.fuel_level AS "fuelLevel", v.engine_health AS "engineHealth",
            v.suspension_health AS "suspensionHealth", v.body_damage AS "bodyDamage",
            v.sale_price_cents AS "salePriceCents", v.sale_currency AS "saleCurrency",
            o.name AS "ownerName", o.citizen_id AS "ownerCitizenId"
     FROM vehicles v
     LEFT JOIN characters o ON o.id = v.owner_character_id
     WHERE v.plate = $1`,
    [normalized]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    plate: r.plate,
    entityType: r.entityType,
    status: r.status,
    locked: r.locked,
    fuelLevel: Number(r.fuelLevel),
    engineHealth: Number(r.engineHealth),
    suspensionHealth: Number(r.suspensionHealth),
    bodyDamage: Number(r.bodyDamage),
    salePriceCents: r.salePriceCents == null ? null : Number(r.salePriceCents),
    saleCurrency: r.saleCurrency ?? null,
    ownerName: r.ownerName ?? null,
    ownerCitizenId: r.ownerCitizenId ?? null,
  };
}

/** Citizen directory search (admin web MDT search box). */
export async function listCitizens(opts: {
  query?: string;
  limit: number;
  offset: number;
}): Promise<CitizenRowView[]> {
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = Math.max(0, opts.offset || 0);
  const q = String(opts.query ?? "").trim();
  const params: unknown[] = [];
  let where = `c.is_deleted = false`;
  if (q.length > 0) {
    params.push(`%${q}%`);
    where += ` AND (c.name ILIKE $${params.length} OR c.citizen_id ILIKE $${params.length} OR c.persistent_id ILIKE $${params.length})`;
  }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.citizen_id AS "citizenId", c.persistent_id AS "persistentId",
            pr.threat_level AS "threatLevel",
            (SELECT COUNT(*) FROM licenses l WHERE l.character_id = c.id)::int AS "licenseCount",
            (SELECT COUNT(*) FROM warrants w WHERE w.target_character_id = c.id AND w.status = 'active')::int AS "warrantCount",
            (SELECT COUNT(*) FROM fines f WHERE f.target_character_id = c.id AND f.status = 'outstanding')::int AS "outstandingFineCount"
     FROM characters c
     LEFT JOIN police_records pr ON pr.character_id = c.id
     WHERE ${where}
     ORDER BY c.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map((r: any) => ({
    id: Number(r.id),
    name: r.name,
    citizenId: r.citizenId ?? null,
    persistentId: r.persistentId ?? null,
    threatLevel: r.threatLevel ?? "none",
    licenseCount: Number(r.licenseCount),
    warrantCount: Number(r.warrantCount),
    outstandingFineCount: Number(r.outstandingFineCount),
  }));
}

export async function listFines(opts: { status?: string; limit: number; offset: number }): Promise<FineView[]> {
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = Math.max(0, opts.offset || 0);
  const params: unknown[] = [];
  let where = `1 = 1`;
  if (opts.status && VALID_FINE_STATUSES.has(opts.status)) {
    params.push(opts.status);
    where = `status = $1`;
  }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT * FROM fines WHERE ${where} ORDER BY issued_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(toFineView);
}

/** Single fine by id (used by the admin police UI to pay on a citizen's behalf). */
export async function getFine(fineId: number): Promise<FineView | null> {
  if (!Number.isSafeInteger(fineId) || fineId <= 0) throw new TypeError("fineId must be a positive integer.");
  const { rows } = await pool.query(
    `SELECT id, target_character_id AS "targetCharacterId",
            officer_name AS "officerName", officer_citizen_id AS "officerCitizenId",
            amount_cents AS "amountCents", currency, reason, status,
            issued_at AS "issuedAt", paid_at AS "paidAt"
     FROM fines WHERE id = $1`,
    [fineId]
  );
  return rows.length === 0 ? null : toFineView(rows[0]);
}

export async function listWarrants(opts: { status?: string; limit: number; offset: number }): Promise<WarrantView[]> {
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = Math.max(0, opts.offset || 0);
  const params: unknown[] = [];
  let where = `1 = 1`;
  if (opts.status && VALID_WARRANT_STATUSES.has(opts.status)) {
    params.push(opts.status);
    where = `status = $1`;
  }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT * FROM warrants WHERE ${where} ORDER BY issued_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(toWarrantView);
}

export async function listReports(opts: { status?: string; limit: number; offset: number }): Promise<ReportView[]> {
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = Math.max(0, opts.offset || 0);
  const params: unknown[] = [];
  let where = `1 = 1`;
  if (opts.status && VALID_REPORT_STATUSES.has(opts.status)) {
    params.push(opts.status);
    where = `status = $1`;
  }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT * FROM police_reports WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const views: ReportView[] = [];
  for (const r of rows) {
    const ev = (await pool.query(`SELECT * FROM evidence WHERE report_id = $1`, [r.id])).rows.map(toEvidenceView);
    views.push({
      id: Number(r.id),
      officerId: r.officer_id == null ? null : Number(r.officer_id),
      title: r.title,
      body: r.body,
      classification: r.classification,
      status: r.status,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      evidence: ev,
    });
  }
  return views;
}

export async function listArrests(opts: { status?: string; limit: number; offset: number }): Promise<ArrestView[]> {
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const offset = Math.max(0, opts.offset || 0);
  const params: unknown[] = [];
  let where = `1 = 1`;
  if (opts.status && VALID_ARREST_STATUSES.has(opts.status)) {
    params.push(opts.status);
    where = `status = $1`;
  }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT * FROM arrests WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map((r: any) => toArrestView(r));
}

// ---------------------------------------------------------------------------
// Writes (all audited)
// ---------------------------------------------------------------------------

const AUDIT_SUCCESS = "success" as const;

/** Upsert the police record (alias / threat level / notes) for a citizen. */
export async function upsertRecord(params: {
  characterId: number;
  alias?: string | null;
  threatLevel?: string | null;
  notes?: string | null;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<RecordView> {
  const { characterId, actorUserId, requestId } = params;
  const alias = params.alias == null || String(params.alias).trim() === "" ? null : String(params.alias).trim().slice(0, 64);
  const notes = params.notes == null || String(params.notes).trim() === "" ? null : String(params.notes).trim().slice(0, 2000);
  const threatLevel = params.threatLevel && VALID_THREAT_LEVELS.has(params.threatLevel) ? params.threatLevel : "none";

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO police_records (character_id, known_alias, threat_level, notes, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (character_id) DO UPDATE SET
         known_alias = COALESCE(EXCLUDED.known_alias, police_records.known_alias),
         threat_level = EXCLUDED.threat_level,
         notes = COALESCE(EXCLUDED.notes, police_records.notes),
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [characterId, alias, threatLevel, notes, actorUserId]
    );
    await writeAudit(
      { actorUserId, action: "police.record", targetType: "character", targetId: String(characterId), payload: { alias, threatLevel, notes }, result: AUDIT_SUCCESS, requestId },
      client
    );
  });
  const row = (await pool.query(`SELECT * FROM police_records WHERE character_id = $1`, [characterId])).rows[0];
  return toRecordView(row)!;
}

/** Issue / suspend / revoke a license. One active instance per type. */
export async function setLicense(params: {
  characterId: number;
  licenseType: string;
  action: "issue" | "suspend" | "revoke";
  notes?: string | null;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<LicenseView> {
  const { characterId, licenseType, actorUserId, requestId } = params;
  const notes = params.notes == null ? null : String(params.notes).trim().slice(0, 500);
  if (!VALID_LICENSE_TYPES.has(licenseType)) throw new LicenseNotFoundError("unknown license type");
  if (!["issue", "suspend", "revoke"].includes(params.action)) throw new Error("action must be issue, suspend or revoke");

  const action = params.action as "issue" | "suspend" | "revoke";
  let targetRow: any;

  await withTransaction(async (client) => {
    if (action === "issue") {
      const existing = (await client.query(
        `SELECT * FROM licenses WHERE character_id = $1 AND license_type = $2 AND status <> 'revoked' FOR UPDATE`,
        [characterId, licenseType]
      )).rows[0];
      if (existing) throw new LicenseExistsError(`${licenseType} license already active for this citizen`);
      const inserted = (await client.query(
        `INSERT INTO licenses (character_id, license_type, status, issued_by, notes)
         VALUES ($1, $2, 'valid', $3, $4) RETURNING *`,
        [characterId, licenseType, null, notes]
      )).rows[0];
      targetRow = inserted;
    } else {
      const target = (await client.query(
        `SELECT * FROM licenses WHERE character_id = $1 AND license_type = $2 AND status <> 'revoked' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [characterId, licenseType]
      )).rows[0];
      if (!target) throw new LicenseNotFoundError(`${licenseType} license not found for this citizen`);
      const newStatus = action === "suspend" ? "suspended" : "revoked";
      const updated = (await client.query(
        `UPDATE licenses SET status = $1 WHERE id = $2 RETURNING *`,
        [newStatus, target.id]
      )).rows[0];
      targetRow = updated;
    }
    await writeAudit(
      { actorUserId, action: `police.license.${action}`, targetType: "license", targetId: String(targetRow.id), payload: { characterId, licenseType, notes }, result: AUDIT_SUCCESS, requestId },
      client
    );
  });
  return toLicenseView(targetRow);
}

/** Issue a fine (money NOT moved yet — the citizen pays it later as a sink). */
export async function issueFine(params: {
  targetCharacterId: number;
  officerCharacterId: number | null;
  amountCents: number;
  currency: string;
  reason: string;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<FineView> {
  const { targetCharacterId, officerCharacterId, actorUserId, requestId } = params;
  const amount = Math.round(Number(params.amountCents));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("amountCents must be a positive integer");
  const currency = String(params.currency);
  if (!VALID_CURRENCIES.has(currency as economy.Currency)) throw new Error("currency must be cash, bank or red_money");
  const reason = String(params.reason ?? "").trim().slice(0, 1000);
  if (reason.length === 0) throw new Error("reason is required");

  const row: any = await withTransaction(async (client) => {
    const inserted = (await client.query(
      `INSERT INTO fines (officer_id, target_character_id, amount_cents, currency, reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [officerCharacterId, targetCharacterId, amount, currency, reason]
    )).rows[0];
    await writeAudit(
      { actorUserId, action: "police.fine.issue", targetType: "fine", targetId: String(inserted.id), payload: { targetCharacterId, amountCents: amount, currency, reason }, result: AUDIT_SUCCESS, requestId },
      client
    );
    return inserted;
  });
  return toFineView(row);
}

/**
 * Citizen pays an outstanding fine. The money is a deliberate sink
 * (economy.fine = debit, refType 'fine'), removed from circulation.
 * The fine row is locked for the whole payment so a concurrent double-pay
 * attempt blocks, then sees 'paid' and gets FineAlreadyPaidError (409).
 */
export async function payFine(params: {
  fineId: number;
  characterId: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<FineView> {
  const { fineId, characterId, actorUserId, requestId } = params;
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM fines WHERE id = $1 FOR UPDATE`, [fineId]);
    if (rows.length === 0) throw new FineNotFoundError("fine not found");
    const fine = rows[0];
    if (Number(fine.target_character_id) !== characterId) throw new FineAccessDeniedError("this fine belongs to another citizen");
    if (fine.status !== "outstanding") throw new FineAlreadyPaidError("this fine is already paid");

    const amountCents = Number(fine.amount_cents);
    const currency = fine.currency as economy.Currency;
    await economy.fine({
      characterId,
      amountCents,
      currency,
      reason: `fine #${fineId}: ${fine.reason}`,
      actorUserId,
      refId: `fine:${fineId}`,
      requestId,
    });

    await client.query(`UPDATE fines SET status = 'paid', paid_at = now() WHERE id = $1`, [fineId]);
    await writeAudit(
      { actorUserId, action: "police.fine.pay", targetType: "fine", targetId: String(fineId), payload: { characterId, amountCents, currency, reason: fine.reason }, result: AUDIT_SUCCESS, requestId },
      client
    );
    return toFineView({ ...fine, status: "paid", paid_at: new Date() });
  });
}

export async function createReport(params: {
  officerCharacterId: number | null;
  title: string;
  body: string;
  classification?: string | null;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<ReportView> {
  const { actorUserId, requestId } = params;
  const title = String(params.title ?? "").trim().slice(0, 200);
  const body = String(params.body ?? "").trim().slice(0, 10000);
  if (title.length === 0 || body.length === 0) throw new Error("title and body are required");
  const classification = params.classification && ["general", "restricted", "classified"].includes(params.classification)
    ? params.classification
    : "general";

  const row: any = await withTransaction(async (client) => {
    const inserted = (await client.query(
      `INSERT INTO police_reports (officer_id, title, body, classification) VALUES ($1, $2, $3, $4) RETURNING *`,
      [params.officerCharacterId, title, body, classification]
    )).rows[0];
    await writeAudit(
      { actorUserId, action: "police.report.create", targetType: "report", targetId: String(inserted.id), payload: { title, classification }, result: AUDIT_SUCCESS, requestId },
      client
    );
    return inserted;
  });
  return { ...toReportRow(row), evidence: [] };
}

function toReportRow(row: any): Omit<ReportView, "evidence"> {
  return {
    id: Number(row.id),
    officerId: row.officer_id == null ? null : Number(row.officer_id),
    title: row.title,
    body: row.body,
    classification: row.classification,
    status: row.status,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export async function closeReport(params: {
  reportId: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<ReportView> {
  const { actorUserId, requestId } = params;
  const row: any = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM police_reports WHERE id = $1 FOR UPDATE`, [params.reportId]);
    if (rows.length === 0) throw new ReportNotFoundError("report not found");
    const updated = (await client.query(
      `UPDATE police_reports SET status = 'closed', updated_at = now() WHERE id = $1 RETURNING *`,
      [params.reportId]
    )).rows[0];
    await writeAudit(
      { actorUserId, action: "police.report.close", targetType: "report", targetId: String(params.reportId), result: AUDIT_SUCCESS, requestId },
      client
    );
    return updated;
  });
  const ev = (await pool.query(`SELECT * FROM evidence WHERE report_id = $1`, [row.id])).rows.map(toEvidenceView);
  return { ...toReportRow(row), evidence: ev };
}

export async function addEvidence(params: {
  reportId?: number | null;
  officerCharacterId: number | null;
  description: string;
  itemId?: string | null;
  quantity?: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<EvidenceView> {
  const { actorUserId, requestId } = params;
  const description = String(params.description ?? "").trim().slice(0, 1000);
  if (description.length === 0) throw new Error("description is required");
  const quantity = Math.round(Number(params.quantity ?? 1));
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("quantity must be a positive integer");
  const itemId = params.itemId && String(params.itemId).trim() !== "" ? String(params.itemId).trim().slice(0, 128) : null;

  const row: any = await withTransaction(async (client) => {
    if (params.reportId != null) {
      const rep = (await client.query(`SELECT 1 FROM police_reports WHERE id = $1`, [params.reportId])).rows;
      if (rep.length === 0) throw new ReportNotFoundError("report not found");
    }
    const inserted = (await client.query(
      `INSERT INTO evidence (report_id, officer_id, description, item_id, quantity) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [params.reportId ?? null, params.officerCharacterId, description, itemId, quantity]
    )).rows[0];
    await writeAudit(
      { actorUserId, action: "police.evidence.add", targetType: "evidence", targetId: String(inserted.id), payload: { reportId: params.reportId ?? null, description, itemId, quantity }, result: AUDIT_SUCCESS, requestId },
      client
    );
    return inserted;
  });
  return toEvidenceView(row);
}

export async function issueWarrant(params: {
  targetCharacterId: number;
  warrantType: string;
  reason: string;
  officerCharacterId: number | null;
  expiresAt?: Date | null;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<WarrantView> {
  const { actorUserId, requestId } = params;
  const warrantType = String(params.warrantType);
  if (!VALID_WARRANT_TYPES.has(warrantType)) throw new Error("warrantType must be arrest or search");
  const reason = String(params.reason ?? "").trim().slice(0, 1000);
  if (reason.length === 0) throw new Error("reason is required");

  const row: any = await withTransaction(async (client) => {
    const inserted = (await client.query(
      `INSERT INTO warrants (target_character_id, warrant_type, reason, officer_id, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [params.targetCharacterId, warrantType, reason, params.officerCharacterId, params.expiresAt ?? null]
    )).rows[0];
    await writeAudit(
      { actorUserId, action: "police.warrant.issue", targetType: "warrant", targetId: String(inserted.id), payload: { targetCharacterId: params.targetCharacterId, warrantType, reason, expiresAt: params.expiresAt ?? null }, result: AUDIT_SUCCESS, requestId },
      client
    );
    return inserted;
  });
  return toWarrantView(row);
}

export async function revokeWarrant(params: {
  warrantId: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<WarrantView> {
  const { actorUserId, requestId } = params;
  const row: any = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM warrants WHERE id = $1 FOR UPDATE`, [params.warrantId]);
    if (rows.length === 0) throw new WarrantNotFoundError("warrant not found");
    if (rows[0].status !== "active") throw new WarrantNotActiveError("warrant is not active");
    const updated = (await client.query(
      `UPDATE warrants SET status = 'revoked', closed_at = now() WHERE id = $1 RETURNING *`,
      [params.warrantId]
    )).rows[0];
    await writeAudit(
      { actorUserId, action: "police.warrant.revoke", targetType: "warrant", targetId: String(params.warrantId), payload: { warrantType: rows[0].warrant_type }, result: AUDIT_SUCCESS, requestId },
      client
    );
    return updated;
  });
  return toWarrantView(row);
}

export async function arrestCharacter(params: {
  characterId: number;
  officerCharacterId: number | null;
  reason: string;
  minutes: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<ArrestView> {
  const { actorUserId, requestId } = params;
  const reason = String(params.reason ?? "").trim().slice(0, 1000);
  if (reason.length === 0) throw new Error("reason is required");
  const minutes = Math.round(Number(params.minutes));
  if (!Number.isSafeInteger(minutes) || minutes < MIN_ARREST_MINUTES || minutes > MAX_ARREST_MINUTES) {
    throw new Error(`minutes must be between ${MIN_ARREST_MINUTES} and ${MAX_ARREST_MINUTES}`);
  }

  const row: any = await withTransaction(async (client) => {
    const active = (await client.query(
      `SELECT id FROM arrests WHERE character_id = $1 AND status = 'active' FOR UPDATE`,
      [params.characterId]
    )).rows[0];
    if (active) throw new CharacterAlreadyInJailError("this citizen is already in jail");

    const inserted = (await client.query(
      `INSERT INTO arrests (character_id, officer_id, reason, jail_until)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING *`,
      [params.characterId, params.officerCharacterId, reason, minutes]
    )).rows[0];

    // executing an open arrest warrant closes it (records which arrest it was)
    const warrant = (await client.query(
      `SELECT * FROM warrants WHERE target_character_id = $1 AND status = 'active' AND warrant_type = 'arrest' ORDER BY issued_at DESC LIMIT 1 FOR UPDATE`,
      [params.characterId]
    )).rows[0];
    if (warrant) {
      await client.query(
        `UPDATE warrants SET status = 'executed', closed_at = now() WHERE id = $1`,
        [warrant.id]
      );
    }

    await writeAudit(
      { actorUserId, action: "police.arrest.issue", targetType: "arrest", targetId: String(inserted.id), payload: { characterId: params.characterId, reason, minutes, executedWarrantId: warrant ? Number(warrant.id) : null }, result: AUDIT_SUCCESS, requestId },
      client
    );
    return inserted;
  });
  return toArrestView(row);
}

/** Release the citizen's currently active sentence (warden / senior officer). */
export async function releaseArrest(params: {
  characterId: number;
  releasedByCharacterId: number | null;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<ArrestView> {
  const { actorUserId, requestId } = params;
  const row: any = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM arrests WHERE character_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [params.characterId]
    );
    if (rows.length === 0) throw new ArrestNotFoundError("no active sentence for this citizen");
    const updated = (await client.query(
      `UPDATE arrests SET status = 'released', released_by = $1, released_at = now() WHERE id = $2 RETURNING *`,
      [params.releasedByCharacterId, rows[0].id]
    )).rows[0];
    await writeAudit(
      { actorUserId, action: "police.arrest.release", targetType: "arrest", targetId: String(rows[0].id), payload: { characterId: params.characterId, releasedBy: params.releasedByCharacterId }, result: AUDIT_SUCCESS, requestId },
      client
    );
    return updated;
  });
  return toArrestView(row);
}