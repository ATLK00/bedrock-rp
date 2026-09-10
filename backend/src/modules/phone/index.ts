// ---------------------------------------------------------------------------
// Phone / mobile framework (expandable app framework, MASTER_PROMPT §15).
//
// v1 ships eight seed apps on one server-authoritative store:
//   contacts, messages, calls, bank, GPS, taxi, emergency, business
// (the "app store" row is a placeholder for future apps). Everything is
// owned by the caller's own character — there is no web/phone login here,
// the bridge resolves the actor from the persistentId the pack captured at
// join and RBAC is re-checked for the shared/operator surfaces:
//   phone.taxi.manage        -> taxi job board
//   phone.emergency.view/manage -> dispatch
//
// Calls are modelled as a server-authoritative state machine
// (ringing -> connected -> ended | missed) with NO audio — Bedrock has no
// voice API. The state machine + PHONE_CALL_CHANGED eventbus events are the
// "realtime" handshake a future speech/voice provider (MASTER_PROMPT §15 /
// §10 "phone calls") can attach to without schema changes. A "ringing" call
// auto-misses after RING_TIMEOUT_SECONDS (settled lazily on read, like
// warrant/downed expiry), and a call to an offline number is recorded missed
// immediately.
//
// Every write is audited. Money only ever moves for bank transfers (via
// economy.transfer) and taxi fares (same, on completion) — the phone itself
// is not a balance store.
// ---------------------------------------------------------------------------

import { pool, withTransaction } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";
import * as character from "../character/index.js";
import * as economy from "../economy/index.js";
import * as playerSession from "../player_session/index.js";
import { publish } from "../../eventbus/index.js";

// ---------------------------------------------------------------------------
// Domain errors (mapped to HTTP by the bridge route wrappers)
// ---------------------------------------------------------------------------

export class PhoneNumberNotFoundError extends Error {}
export class ContactNotFoundError extends Error {}
export class MessageNotFoundError extends Error {}
export class CallNotFoundError extends Error {}
export class CallAccessDeniedError extends Error {}
export class CallNotActiveError extends Error {}
export class TaxiRequestNotFoundError extends Error {}
export class TaxiAccessDeniedError extends Error {}
export class TaxiNotActionableError extends Error {}
export class EmergencyCallNotFoundError extends Error {}
export class EmergencyNotActionableError extends Error {}
export class SelfActionError extends Error {}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VALID_CURRENCIES = new Set<economy.Currency>(["cash", "bank", "red_money"]);
export const VALID_CALL_STATUSES = new Set(["ringing", "connected", "ended", "missed"]);
export const VALID_TAXI_STATUSES = new Set(["pending", "accepted", "completed", "cancelled"]);
export const VALID_EMERGENCY_CATEGORIES = new Set(["police", "ems", "fire", "general"]);
export const VALID_EMERGENCY_STATUSES = new Set(["open", "dispatched", "closed"]);
export const RING_TIMEOUT_SECONDS = 60;
export const NAME_MAX = 64;
export const BODY_MAX = 1000;

// ---------------------------------------------------------------------------
// Views (DB rows -> wire shape)
// ---------------------------------------------------------------------------

export interface ContactView {
  id: number;
  name: string;
  number: string;
  note: string | null;
}

export interface MessageView {
  id: number;
  fromCharacterId: number;
  fromName: string | null;
  toCharacterId: number;
  toName: string | null;
  body: string;
  readAt: string | null;
  createdAt: string | null;
}

export interface CallView {
  id: number;
  callerCharacterId: number;
  callerName: string | null;
  calleeCharacterId: number;
  calleeName: string | null;
  status: string;
  startedAt: string | null;
  acceptedAt: string | null;
  endedAt: string | null;
  missedReason: string | null;
}

export interface WaypointView {
  id: number;
  name: string;
  dimensionId: string;
  x: number;
  y: number;
  z: number;
  note: string | null;
}

export interface TaxiRequestView {
  id: number;
  requesterCharacterId: number;
  requesterName: string | null;
  pickupName: string | null;
  dimensionId: string;
  pickupX: number;
  pickupY: number;
  pickupZ: number;
  destination: string;
  fareCents: number;
  currency: string;
  status: string;
  driverCharacterId: number | null;
  driverName: string | null;
}

export interface EmergencyCallView {
  id: number;
  callerCharacterId: number;
  callerName: string | null;
  category: string;
  subject: string;
  dimensionId: string;
  locationX: number | null;
  locationY: number | null;
  locationZ: number | null;
  status: string;
  responderCharacterId: number | null;
  note: string | null;
  createdAt: string | null;
}

export interface PhoneInfoView {
  number: string;
  unreadCount: number;
  hasEmergencyView: boolean;
  hasEmergencyManage: boolean;
  hasTaxiManage: boolean;
  healthState: string | null;
}

// ---------------------------------------------------------------------------
// Row -> view mappers
// ---------------------------------------------------------------------------

function toContactView(row: any): ContactView {
  return { id: Number(row.id), name: row.name, number: row.number, note: row.note ?? null };
}

function toMessageView(row: any): MessageView {
  return {
    id: Number(row.id),
    fromCharacterId: Number(row.from_character_id),
    fromName: row.from_name ?? null,
    toCharacterId: Number(row.to_character_id),
    toName: row.to_name ?? null,
    body: row.body,
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function toCallView(row: any): CallView {
  return {
    id: Number(row.id),
    callerCharacterId: Number(row.caller_character_id),
    callerName: row.caller_name ?? null,
    calleeCharacterId: Number(row.callee_character_id),
    calleeName: row.callee_name ?? null,
    status: row.status,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    missedReason: row.missed_reason ?? null,
  };
}

function toWaypointView(row: any): WaypointView {
  return {
    id: Number(row.id),
    name: row.name,
    dimensionId: row.dimension_id,
    x: Number(row.x),
    y: Number(row.y),
    z: Number(row.z),
    note: row.note ?? null,
  };
}

function toTaxiRequestView(row: any): TaxiRequestView {
  return {
    id: Number(row.id),
    requesterCharacterId: Number(row.requester_character_id),
    requesterName: row.requester_name ?? null,
    pickupName: row.pickup_name ?? null,
    dimensionId: row.dimension_id,
    pickupX: Number(row.pickup_x),
    pickupY: Number(row.pickup_y),
    pickupZ: Number(row.pickup_z),
    destination: row.destination,
    fareCents: Number(row.fare_cents),
    currency: row.currency,
    status: row.status,
    driverCharacterId: row.driver_character_id == null ? null : Number(row.driver_character_id),
    driverName: row.driver_name ?? null,
  };
}

function toEmergencyCallView(row: any): EmergencyCallView {
  return {
    id: Number(row.id),
    callerCharacterId: Number(row.caller_character_id),
    callerName: row.caller_name ?? null,
    category: row.category,
    subject: row.subject,
    dimensionId: row.dimension_id,
    locationX: row.location_x == null ? null : Number(row.location_x),
    locationY: row.location_y == null ? null : Number(row.location_y),
    locationZ: row.location_z == null ? null : Number(row.location_z),
    status: row.status,
    responderCharacterId: row.responder_character_id == null ? null : Number(row.responder_character_id),
    note: row.note ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

function randomNumber(): string {
  return `09${String(Math.floor(10000000 + Math.random() * 90000000))}`; // "09" + 8 digits
}

/**
 * Get the citizen's phone number, issuing a fresh one on first use
 * (deterministic row_number backfill happened in migration 029 for the
 * pre-existing population; new issues are random 8-digit suffixes with
 * unique-conflict retry). Pass `client` inside a transaction.
 */
export async function ensurePhoneNumber(characterId: number): Promise<string> {
  return withTransaction(async (client) => {
    const existing = (await client.query(
      `SELECT number FROM phone_numbers WHERE character_id = $1`,
      [characterId]
    )).rows[0];
    if (existing) return existing.number;

    for (let attempt = 0; attempt < 25; attempt++) {
      const number = randomNumber();
      try {
        const { rows } = await client.query(
          `INSERT INTO phone_numbers (character_id, number) VALUES ($1, $2) RETURNING number`,
          [characterId, number]
        );
        await writeAudit(
          { actorUserId: null, action: "phone.number.issue", targetType: "phone_number", targetId: String(characterId), payload: { number }, result: "success" },
          client
        );
        return rows[0].number;
      } catch (err: any) {
        if (err?.code !== "23505") throw err;
        const raced = (await client.query(`SELECT number FROM phone_numbers WHERE character_id = $1`, [characterId])).rows[0];
        if (raced) return raced.number;
        // unique conflict was on the number — try another suffix
      }
    }
    throw new Error("phone number pool exhausted");
  });
}

/** Resolve a character by phone number (must have been issued one). */
export async function findCharacterByPhoneNumber(number: string): Promise<{ characterId: number; name: string } | null> {
  const { rows } = await pool.query(
    `SELECT pn.character_id AS "characterId", c.name FROM phone_numbers pn
     JOIN characters c ON c.id = pn.character_id AND c.is_deleted = false
     WHERE pn.number = $1 LIMIT 1`,
    [String(number).trim()]
  );
  return rows.length === 0 ? null : { characterId: Number(rows[0].characterId), name: rows[0].name };
}

export async function getPhoneNumber(characterId: number): Promise<string | null> {
  const { rows } = await pool.query(`SELECT number FROM phone_numbers WHERE character_id = $1`, [characterId]);
  return rows.length === 0 ? null : rows[0].number;
}

function validateNumber(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const n = v.trim();
  if (n.length < 4 || n.length > 24) return null;
  if (!/^\d+$/.test(n)) return null;
  return n;
}

// ---------------------------------------------------------------------------
// Contacts (address book)
// ---------------------------------------------------------------------------

export async function listContacts(characterId: number): Promise<ContactView[]> {
  const { rows } = await pool.query(
    `SELECT * FROM phone_contacts WHERE owner_character_id = $1 ORDER BY name ASC`,
    [characterId]
  );
  return rows.map(toContactView);
}

export async function addContact(params: {
  characterId: number;
  name: string;
  number: string;
  note?: string | null;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<ContactView> {
  const name = String(params.name ?? "").trim().slice(0, NAME_MAX);
  const number = validateNumber(params.number);
  if (name.length === 0) throw new Error("contact name is required");
  if (!number) throw new Error("contact number must be 4-24 digits");
  const note = params.note == null || String(params.note).trim() === "" ? null : String(params.note).trim().slice(0, 200);

  const row: any = await withTransaction(async (client) => {
    const inserted = (await client.query(
      `INSERT INTO phone_contacts (owner_character_id, name, number, note)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [params.characterId, name, number, note]
    )).rows[0];
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.contact.add", targetType: "phone_contact", targetId: String(inserted.id), payload: { name, number }, result: "success", requestId: params.requestId },
      client
    );
    return inserted;
  });
  return toContactView(row);
}

export async function updateContact(params: {
  characterId: number;
  contactId: number;
  name?: string | null;
  number?: string | null;
  note?: string | null;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<ContactView> {
  const { characterId, contactId } = params;
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM phone_contacts WHERE id = $1 AND owner_character_id = $2 FOR UPDATE`,
      [contactId, characterId]
    );
    if (rows.length === 0) throw new ContactNotFoundError("contact not found");
    const name = params.name == null ? rows[0].name : String(params.name).trim().slice(0, NAME_MAX);
    let number = rows[0].number;
    if (params.number != null) {
      const parsed = validateNumber(params.number);
      if (!parsed) throw new Error("contact number must be 4-24 digits");
      number = parsed;
    }
    if (name.length === 0) throw new Error("contact name is required");
    const note = params.note == null ? rows[0].note : (String(params.note).trim() === "" ? null : String(params.note).trim().slice(0, 200));
    const updated = (await client.query(
      `UPDATE phone_contacts SET name = $1, number = $2, note = $3 WHERE id = $4 RETURNING *`,
      [name, number, note, contactId]
    )).rows[0];
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.contact.edit", targetType: "phone_contact", targetId: String(contactId), payload: { name, number, note }, result: "success", requestId: params.requestId },
      client
    );
    return toContactView(updated);
  });
}

export async function deleteContact(params: {
  characterId: number;
  contactId: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM phone_contacts WHERE id = $1 AND owner_character_id = $2`,
      [params.contactId, params.characterId]
    );
    if (rows.length === 0) throw new ContactNotFoundError("contact not found");
    await client.query(`DELETE FROM phone_contacts WHERE id = $1`, [params.contactId]);
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.contact.delete", targetType: "phone_contact", targetId: String(params.contactId), payload: { name: rows[0].name }, result: "success", requestId: params.requestId },
      client
    );
  });
}

// ---------------------------------------------------------------------------
// Messages (SMS-style)
// ---------------------------------------------------------------------------

async function toMessageRows(rows: any[]): Promise<MessageView[]> {
  const seen = new Map<number, string | null>();
  for (const r of rows) {
    if (!seen.has(Number(r.from_character_id))) seen.set(Number(r.from_character_id), r.from_name ?? null);
    if (!seen.has(Number(r.to_character_id))) seen.set(Number(r.to_character_id), r.to_name ?? null);
  }
  return rows.map((r) => ({
    ...toMessageView(r),
    fromName: r.from_name ?? seen.get(Number(r.from_character_id)) ?? null,
    toName: r.to_name ?? seen.get(Number(r.to_character_id)) ?? null,
  }));
}

export async function unreadCount(characterId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM phone_messages WHERE to_character_id = $1 AND read_at IS NULL`,
    [characterId]
  );
  return rows[0].n;
}

export async function sendMessage(params: {
  fromCharacterId: number;
  toNumber: string;
  body: string;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<MessageView> {
  const number = validateNumber(params.toNumber);
  if (!number) throw new PhoneNumberNotFoundError("a valid phone number is required");
  const body = String(params.body ?? "").trim().slice(0, BODY_MAX);
  if (body.length === 0) throw new Error("message body is required");

  const row: any = await withTransaction(async (client) => {
    const target = (await client.query(
      `SELECT pn.character_id, c.name FROM phone_numbers pn
       JOIN characters c ON c.id = pn.character_id AND c.is_deleted = false
       WHERE pn.number = $1 LIMIT 1`,
      [number]
    )).rows[0];
    if (!target) throw new PhoneNumberNotFoundError("no citizen has that phone number");
    if (Number(target.character_id) === params.fromCharacterId) throw new SelfActionError("you can't message your own number");
    const inserted = (await client.query(
      `INSERT INTO phone_messages (from_character_id, to_character_id, body)
       VALUES ($1, $2, $3) RETURNING *`,
      [params.fromCharacterId, Number(target.character_id), body]
    )).rows[0];
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.message.send", targetType: "phone_message", targetId: String(inserted.id), payload: { toCharacterId: Number(target.character_id), bodyLength: body.length }, result: "success", requestId: params.requestId },
      client
    );
    return { ...inserted, to_name: target.name };
  });
  return toMessageView(row);
}

/** Inbox: newest first, all messages addressed to me (marks them read). */
export async function getInbox(characterId: number, limit = 50): Promise<MessageView[]> {
  await pool.query(`UPDATE phone_messages SET read_at = COALESCE(read_at, now()) WHERE to_character_id = $1 AND read_at IS NULL`, [characterId]);
  const { rows } = await pool.query(
    `SELECT m.*, c.name AS "from_name", me.name AS "to_name"
     FROM phone_messages m
     JOIN characters c ON c.id = m.from_character_id
     JOIN characters me ON me.id = m.to_character_id
     WHERE m.to_character_id = $1
     ORDER BY m.id DESC
     LIMIT $2`,
    [characterId, Math.max(1, Math.min(limit, 200))]
  );
  const views = await toMessageRows(rows);
  return views;
}

/** Outbox: newest first, messages I sent. */
export async function getOutbox(characterId: number, limit = 50): Promise<MessageView[]> {
  const { rows } = await pool.query(
    `SELECT m.*, c.name AS "from_name", me.name AS "to_name"
     FROM phone_messages m
     JOIN characters c ON c.id = m.from_character_id
     JOIN characters me ON me.id = m.to_character_id
     WHERE m.from_character_id = $1
     ORDER BY m.id DESC
     LIMIT $2`,
    [characterId, Math.max(1, Math.min(limit, 200))]
  );
  return toMessageRows(rows);
}

// ---------------------------------------------------------------------------
// Calls (server-authoritative state machine; no audio in Bedrock)
// ---------------------------------------------------------------------------

/** Lazily settle stale 'ringing' calls -> missed (server clock authoritative). */
async function settleStaleCalls(characterId: number): Promise<void> {
  await pool.query(
    `UPDATE phone_calls
     SET status = 'missed', missed_reason = 'timeout'
     WHERE status = 'ringing' AND (caller_character_id = $1 OR callee_character_id = $1)
       AND started_at < now() - make_interval(secs => $2)`,
    [characterId, RING_TIMEOUT_SECONDS]
  );
}

async function toCallRows(rows: any[]): Promise<CallView[]> {
  return rows.map((r) => {
    const v = toCallView(r);
    v.callerName = r.caller_name ?? null;
    v.calleeName = r.callee_name ?? null;
    return v;
  });
}

export async function listCalls(characterId: number, limit = 20): Promise<CallView[]> {
  await settleStaleCalls(characterId);
  const { rows } = await pool.query(
    `SELECT c.*, caller.name AS "caller_name", callee.name AS "callee_name"
     FROM phone_calls c
     JOIN characters caller ON caller.id = c.caller_character_id
     JOIN characters callee ON callee.id = c.callee_character_id
     WHERE c.caller_character_id = $1 OR c.callee_character_id = $1
     ORDER BY c.id DESC
     LIMIT $2`,
    [characterId, Math.max(1, Math.min(limit, 100))]
  );
  return toCallRows(rows);
}

/**
 * Place a call to a phone number. An offline number is recorded as a missed
 * call (offline) so history is right; an online number is ringing and the
 * callee accepts/declines from their own phone UI.
 */
export async function initiateCall(params: {
  callerCharacterId: number;
  toNumber: string;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<CallView> {
  const number = validateNumber(params.toNumber);
  if (!number) throw new PhoneNumberNotFoundError("a valid phone number is required");

  const row: any = await withTransaction(async (client) => {
    const target = (await client.query(
      `SELECT pn.character_id, c.name FROM phone_numbers pn
       JOIN characters c ON c.id = pn.character_id AND c.is_deleted = false
       WHERE pn.number = $1 LIMIT 1`,
      [number]
    )).rows[0];
    if (!target) throw new PhoneNumberNotFoundError("no citizen has that phone number");
    const calleeId = Number(target.character_id);
    if (calleeId === params.callerCharacterId) throw new SelfActionError("you can't call your own number");

    // Open (ringing/connected) call to the same callee is refused (busy-like).
    const busy = (await client.query(
      `SELECT id FROM phone_calls
       WHERE (caller_character_id = $1 OR callee_character_id = $1)
         AND status IN ('ringing', 'connected') LIMIT 1`,
      [params.callerCharacterId]
    )).rows[0];
    if (busy) throw new CallNotActiveError("you already have an active call");

    const online = await playerSession.listOnlinePlayers();
    const isOnline = online.some((p) => p.characterId != null && Number(p.characterId) === calleeId);
    const status = isOnline ? "ringing" : "missed";

    const inserted = (await client.query(
      `INSERT INTO phone_calls (caller_character_id, callee_character_id, status, missed_reason)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [params.callerCharacterId, calleeId, status, isOnline ? null : "offline"]
    )).rows[0];
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.call.initiate", targetType: "phone_call", targetId: String(inserted.id), payload: { calleeCharacterId: calleeId, status }, result: "success", requestId: params.requestId },
      client
    );
    return { ...inserted, callee_name: target.name };
  });
  publish({ type: "PHONE_CALL_CHANGED", callId: Number(row.id), status: row.status, callerCharacterId: params.callerCharacterId, calleeCharacterId: Number(row.callee_character_id) });
  return toCallView(row);
}

export async function acceptCall(params: {
  callId: number;
  calleeCharacterId: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<CallView> {
  const { callId, calleeCharacterId } = params;
  const row: any = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM phone_calls WHERE id = $1 FOR UPDATE`, [callId]);
    if (rows.length === 0) throw new CallNotFoundError("call not found");
    const call = rows[0];
    if (Number(call.callee_character_id) !== calleeCharacterId) throw new CallAccessDeniedError("only the callee can accept this call");
    if (call.status !== "ringing") throw new CallNotActiveError("this call is no longer ringing");
    const updated = (await client.query(
      `UPDATE phone_calls SET status = 'connected', accepted_at = now() WHERE id = $1 RETURNING *`,
      [callId]
    )).rows[0];
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.call.accept", targetType: "phone_call", targetId: String(callId), payload: { callerCharacterId: Number(call.caller_character_id) }, result: "success", requestId: params.requestId },
      client
    );
    return updated;
  });
  publish({ type: "PHONE_CALL_CHANGED", callId: Number(row.id), status: row.status, callerCharacterId: Number(row.caller_character_id), calleeCharacterId: calleeCharacterId });
  return toCallView(row);
}

/** Either party hangs up a connected/ringing call. */
export async function hangupCall(params: {
  callId: number;
  actorCharacterId: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<CallView> {
  const { callId, actorCharacterId } = params;
  const row: any = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM phone_calls WHERE id = $1 FOR UPDATE`, [callId]);
    if (rows.length === 0) throw new CallNotFoundError("call not found");
    const call = rows[0];
    const involved = Number(call.caller_character_id) === actorCharacterId || Number(call.callee_character_id) === actorCharacterId;
    if (!involved) throw new CallAccessDeniedError("you are not a party to this call");
    if (!["ringing", "connected"].includes(call.status)) throw new CallNotActiveError("this call is already finished");
    const updated = (await client.query(
      `UPDATE phone_calls SET status = 'ended', ended_at = now(), ended_by = $1 WHERE id = $2 RETURNING *`,
      [actorCharacterId, callId]
    )).rows[0];
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.call.hangup", targetType: "phone_call", targetId: String(callId), payload: { endedBy: actorCharacterId }, result: "success", requestId: params.requestId },
      client
    );
    return updated;
  });
  publish({ type: "PHONE_CALL_CHANGED", callId: Number(row.id), status: row.status, callerCharacterId: Number(row.caller_character_id), calleeCharacterId: Number(row.callee_character_id) });
  return toCallView(row);
}

// ---------------------------------------------------------------------------
// GPS waypoints
// ---------------------------------------------------------------------------

export async function listWaypoints(characterId: number): Promise<WaypointView[]> {
  const { rows } = await pool.query(
    `SELECT * FROM phone_waypoints WHERE owner_character_id = $1 ORDER BY created_at ASC`,
    [characterId]
  );
  return rows.map(toWaypointView);
}

export async function addWaypoint(params: {
  characterId: number;
  name: string;
  x: number;
  y: number;
  z: number;
  dimensionId?: string;
  note?: string | null;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<WaypointView> {
  const name = String(params.name ?? "").trim().slice(0, NAME_MAX);
  if (name.length === 0) throw new Error("waypoint name is required");
  const x = Number(params.x), y = Number(params.y), z = Number(params.z);
  if (![x, y, z].every((v) => Number.isFinite(v))) throw new Error("waypoint coordinates must be numbers");
  const dimensionId = String(params.dimensionId ?? "overworld").trim().slice(0, 64) || "overworld";
  const note = params.note == null || String(params.note).trim() === "" ? null : String(params.note).trim().slice(0, 200);

  const row: any = await withTransaction(async (client) => {
    const inserted = (await client.query(
      `INSERT INTO phone_waypoints (owner_character_id, name, dimension_id, x, y, z, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [params.characterId, name, dimensionId, x, y, z, note]
    )).rows[0];
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.gps.add", targetType: "phone_waypoint", targetId: String(inserted.id), payload: { name, x, y, z, dimensionId }, result: "success", requestId: params.requestId },
      client
    );
    return inserted;
  });
  return toWaypointView(row);
}

export async function deleteWaypoint(params: {
  characterId: number;
  waypointId: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM phone_waypoints WHERE id = $1 AND owner_character_id = $2`,
      [params.waypointId, params.characterId]
    );
    if (rows.length === 0) throw new ContactNotFoundError("waypoint not found");
    await client.query(`DELETE FROM phone_waypoints WHERE id = $1`, [params.waypointId]);
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.gps.delete", targetType: "phone_waypoint", targetId: String(params.waypointId), payload: { name: rows[0].name }, result: "success", requestId: params.requestId },
      client
    );
  });
}

// ---------------------------------------------------------------------------
// Taxi (job board, fare settles on completion)
// ---------------------------------------------------------------------------

const TAXI_PICKUP_JOIN = `
  SELECT tr.*, requester.name AS "requester_name", driver.name AS "driver_name"
  FROM phone_taxi_requests tr
  JOIN characters requester ON requester.id = tr.requester_character_id
  LEFT JOIN characters driver ON driver.id = tr.driver_character_id`;

export async function requestTaxi(params: {
  requesterCharacterId: number;
  pickupName?: string | null;
  x: number;
  y: number;
  z: number;
  dimensionId?: string;
  destination: string;
  fareCents: number;
  currency?: string;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<TaxiRequestView> {
  const destination = String(params.destination ?? "").trim().slice(0, 200);
  if (destination.length === 0) throw new Error("destination is required");
  const fare = Math.round(Number(params.fareCents));
  if (!Number.isSafeInteger(fare) || fare <= 0) throw new Error("fareCents must be a positive integer");
  const currency = String(params.currency ?? "cash");
  if (!VALID_CURRENCIES.has(currency as economy.Currency)) throw new Error("currency must be cash, bank or red_money");
  const x = Number(params.x), y = Number(params.y), z = Number(params.z);
  if (![x, y, z].every((v) => Number.isFinite(v))) throw new Error("pickup coordinates must be numbers");

  const row: any = await withTransaction(async (client) => {
    const inserted = (await client.query(
      `INSERT INTO phone_taxi_requests (requester_character_id, pickup_name, dimension_id, pickup_x, pickup_y, pickup_z, destination, fare_cents, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [params.requesterCharacterId, params.pickupName ?? null, String(params.dimensionId ?? "overworld").slice(0, 64) || "overworld", x, y, z, destination, fare, currency]
    )).rows[0];
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.taxi.request", targetType: "phone_taxi_request", targetId: String(inserted.id), payload: { destination, fareCents: fare, currency }, result: "success", requestId: params.requestId },
      client
    );
    return inserted;
  });
  return toTaxiRequestView({ ...row, requester_name: null, driver_name: null });
}

/** Driver board: pending + accepted jobs (`phone.taxi.manage`). */
export async function listTaxiRequests(limit = 30, status?: string): Promise<TaxiRequestView[]> {
  const params: unknown[] = [];
  let where = "";
  if (status && VALID_TAXI_STATUSES.has(status)) {
    params.push(status);
    where = `WHERE tr.status = $1`;
  }
  params.push(Math.max(1, Math.min(limit, 100)));
  const { rows } = await pool.query(`${TAXI_PICKUP_JOIN} ${where} ORDER BY tr.id DESC LIMIT $${params.length}`, params);
  return rows.map(toTaxiRequestView);
}

export async function myTaxiRequests(characterId: number): Promise<TaxiRequestView[]> {
  const { rows } = await pool.query(
    `${TAXI_PICKUP_JOIN} WHERE tr.requester_character_id = $1 ORDER BY tr.id DESC LIMIT 20`,
    [characterId]
  );
  return rows.map(toTaxiRequestView);
}

export async function acceptTaxi(params: {
  taxiRequestId: number;
  driverCharacterId: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<TaxiRequestView> {
  const { taxiRequestId, driverCharacterId } = params;
  const row: any = await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM phone_taxi_requests WHERE id = $1 FOR UPDATE`, [taxiRequestId]);
    if (rows.length === 0) throw new TaxiRequestNotFoundError("taxi request not found");
    if (rows[0].status !== "pending") throw new TaxiNotActionableError("this trip is no longer available");
    if (Number(rows[0].requester_character_id) === driverCharacterId) throw new SelfActionError("you can't drive your own taxi request");
    const updated = (await client.query(
      `UPDATE phone_taxi_requests SET status = 'accepted', driver_character_id = $1, accepted_at = now() WHERE id = $2 RETURNING *`,
      [driverCharacterId, taxiRequestId]
    )).rows[0];
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.taxi.accept", targetType: "phone_taxi_request", targetId: String(taxiRequestId), payload: { driverCharacterId }, result: "success", requestId: params.requestId },
      client
    );
    return updated;
  });
  return toTaxiRequestView(row);
}

/** Complete the trip — fare moves requester -> driver via economy.transfer. */
export async function completeTaxi(params: {
  taxiRequestId: number;
  driverCharacterId: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<TaxiRequestView> {
  const { taxiRequestId, driverCharacterId, actorUserId, requestId } = params;
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM phone_taxi_requests WHERE id = $1 FOR UPDATE`,
      [taxiRequestId]
    );
    if (rows.length === 0) throw new TaxiRequestNotFoundError("taxi request not found");
    const req = rows[0];
    if (Number(req.driver_character_id) !== driverCharacterId) throw new TaxiAccessDeniedError("only the assigned driver can complete this trip");
    if (req.status !== "accepted") throw new TaxiNotActionableError("only an accepted trip can be completed");

    const fare = Number(req.fare_cents);
    const currency = req.currency as economy.Currency;
    await economy.transfer({
      fromCharacterId: Number(req.requester_character_id),
      toCharacterId: driverCharacterId,
      amountCents: fare,
      reason: `taxi fare #${req.id}: ${req.destination}`,
      actorUserId,
      currency,
      requestId,
    });

    const updated = (await client.query(
      `UPDATE phone_taxi_requests SET status = 'completed', completed_at = now() WHERE id = $1 RETURNING *`,
      [taxiRequestId]
    )).rows[0];
    await writeAudit(
      { actorUserId, action: "phone.taxi.complete", targetType: "phone_taxi_request", targetId: String(taxiRequestId), payload: { driverCharacterId, fareCents: fare, currency }, result: "success", requestId },
      client
    );
    return toTaxiRequestView(updated);
  });
}

/** Requester cancels their own pending trip; a driver can bail on an accepted one. */
export async function cancelTaxi(params: {
  taxiRequestId: number;
  characterId: number;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<TaxiRequestView> {
  const { taxiRequestId, characterId } = params;
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM phone_taxi_requests WHERE id = $1 FOR UPDATE`, [taxiRequestId]);
    if (rows.length === 0) throw new TaxiRequestNotFoundError("taxi request not found");
    const req = rows[0];
    const isRequester = Number(req.requester_character_id) === characterId;
    const isDriver = Number(req.driver_character_id) === characterId;
    const canCancel = (req.status === "pending" && isRequester) || (req.status === "accepted" && isDriver);
    if (!canCancel) throw new TaxiAccessDeniedError("this trip can't be cancelled by you right now");
    const updated = (await client.query(
      `UPDATE phone_taxi_requests SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [taxiRequestId]
    )).rows[0];
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.taxi.cancel", targetType: "phone_taxi_request", targetId: String(taxiRequestId), payload: { byCharacterId: characterId }, result: "success", requestId: params.requestId },
      client
    );
    return toTaxiRequestView(updated);
  });
}

// ---------------------------------------------------------------------------
// Emergency calls (911-style; dispatch = police/ems, RBAC-gated)
// ---------------------------------------------------------------------------

export async function createEmergencyCall(params: {
  callerCharacterId: number;
  category: string;
  subject: string;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  dimensionId?: string;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<EmergencyCallView> {
  const category = String(params.category);
  if (!VALID_EMERGENCY_CATEGORIES.has(category)) throw new Error("category must be police, ems, fire or general");
  const subject = String(params.subject ?? "").trim().slice(0, 300);
  if (subject.length === 0) throw new Error("subject is required");
  const x = params.x == null ? null : Number(params.x);
  const y = params.y == null ? null : Number(params.y);
  const z = params.z == null ? null : Number(params.z);
  const dim = String(params.dimensionId ?? "overworld").trim().slice(0, 64) || "overworld";

  const row: any = await withTransaction(async (client) => {
    const inserted = (await client.query(
      `INSERT INTO phone_emergency_calls (caller_character_id, category, subject, dimension_id, location_x, location_y, location_z)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [params.callerCharacterId, category, subject, dim, x, y, z]
    )).rows[0];
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.emergency.create", targetType: "phone_emergency_call", targetId: String(inserted.id), payload: { category, subject }, result: "success", requestId: params.requestId },
      client
    );
    return inserted;
  });
  return toEmergencyCallView(row);
}

/** Own calls always; dispatchers (`includeAll`) see everything. */
export async function listEmergencyCalls(characterId: number, opts: { includeAll?: boolean; status?: string; limit?: number } = {}): Promise<EmergencyCallView[]> {
  const params: unknown[] = [];
  let where = opts.includeAll ? `1 = 1` : `tr.caller_character_id = $1`;
  if (!opts.includeAll) params.push(characterId);
  if (opts.status && VALID_EMERGENCY_STATUSES.has(opts.status)) {
    params.push(opts.status);
    where += ` AND tr.status = $${params.length}`;
  }
  params.push(Math.max(1, Math.min(opts.limit ?? 30, 100)));
  const { rows } = await pool.query(
    `SELECT tr.*, c.name AS "caller_name" FROM phone_emergency_calls tr
     JOIN characters c ON c.id = tr.caller_character_id
     WHERE ${where} ORDER BY tr.id DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(toEmergencyCallView);
}

/** Web admin surface: list every emergency call regardless of caller. */
export async function listEmergencyCallsForAdmin(opts: { status?: string; limit?: number } = {}): Promise<EmergencyCallView[]> {
  const params: unknown[] = [];
  let where = `1 = 1`;
  if (opts.status && VALID_EMERGENCY_STATUSES.has(opts.status)) {
    params.push(opts.status);
    where = `tr.status = $1`;
  }
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 200)));
  const { rows } = await pool.query(
    `SELECT tr.*, c.name AS "caller_name" FROM phone_emergency_calls tr
     JOIN characters c ON c.id = tr.caller_character_id
     WHERE ${where} ORDER BY tr.id DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(toEmergencyCallView);
}

export async function closeEmergencyCall(params: {
  callId: number;
  responderCharacterId: number | null;
  note?: string | null;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<EmergencyCallView> {
  const { callId, responderCharacterId } = params;
  const note = params.note == null || String(params.note).trim() === "" ? null : String(params.note).trim().slice(0, 300);
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM phone_emergency_calls WHERE id = $1 FOR UPDATE`, [callId]);
    if (rows.length === 0) throw new EmergencyCallNotFoundError("emergency call not found");
    if (rows[0].status === "closed") throw new EmergencyNotActionableError("this call is already closed");
    const updated = (await client.query(
      `UPDATE phone_emergency_calls SET status = 'closed', responder_character_id = $1, note = COALESCE($2, note), responded_at = COALESCE(responded_at, now()), closed_at = now() WHERE id = $3 RETURNING *`,
      [responderCharacterId, note, callId]
    )).rows[0];
    await writeAudit(
      { actorUserId: params.actorUserId, action: "phone.emergency.close", targetType: "phone_emergency_call", targetId: String(callId), payload: { responderCharacterId, note, category: rows[0].category }, result: "success", requestId: params.requestId },
      client
    );
    return toEmergencyCallView(updated);
  });
}

// ---------------------------------------------------------------------------
// Bank (read + transfer between numbers — money moved via economy.transfer)
// ---------------------------------------------------------------------------

export async function getBankState(characterId: number) {
  const [, wallet] = await Promise.all([ensurePhoneNumber(characterId), economy.getWalletSummary(characterId)]);
  return wallet;
}

export async function transferByPhone(params: {
  fromCharacterId: number;
  toNumber: string;
  amountCents: number;
  currency?: string;
  reason?: string | null;
  actorUserId: number | null;
  requestId?: string | null;
}): Promise<{ toCharacterId: number; toName: string; amountCents: number; currency: string }> {
  const number = validateNumber(params.toNumber);
  if (!number) throw new PhoneNumberNotFoundError("a valid phone number is required");
  const amount = Math.round(Number(params.amountCents));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("amountCents must be a positive integer");
  const currency = String(params.currency ?? "cash");
  if (!VALID_CURRENCIES.has(currency as economy.Currency)) throw new Error("currency must be cash, bank or red_money");
  const reason = params.reason == null || String(params.reason).trim() === "" ? "โอนเงินผ่านโทรศัพท์ (phone transfer)" : String(params.reason).trim().slice(0, 200);

  const target = await findCharacterByPhoneNumber(number);
  if (!target) throw new PhoneNumberNotFoundError("no citizen has that phone number");
  if (target.characterId === params.fromCharacterId) throw new SelfActionError("you can't transfer to your own number");

  await economy.transfer({
    fromCharacterId: params.fromCharacterId,
    toCharacterId: target.characterId,
    amountCents: amount,
    reason,
    actorUserId: params.actorUserId,
    currency: currency as economy.Currency,
    requestId: params.requestId,
  });

  return { toCharacterId: target.characterId, toName: target.name, amountCents: amount, currency };
}

// ---------------------------------------------------------------------------
// Combined "phone me" (pack root endpoint)
// ---------------------------------------------------------------------------

export async function getPhoneInfo(params: {
  characterId: number;
  canEmergencyView: boolean;
  canEmergencyManage: boolean;
  canTaxiManage: boolean;
}): Promise<PhoneInfoView> {
  const number = await ensurePhoneNumber(params.characterId);
  const [unread, medical] = await Promise.all([unreadCount(params.characterId), (async () => {
    try {
      const emsModule = await import("../ems/index.js");
      const mine = await emsModule.getMineMedicalState(params.characterId);
      return mine.healthState;
    } catch {
      return null;
    }
  })()]);
  return {
    number,
    unreadCount: unread,
    hasEmergencyView: params.canEmergencyView,
    hasEmergencyManage: params.canEmergencyManage,
    hasTaxiManage: params.canTaxiManage,
    healthState: medical,
  };
}