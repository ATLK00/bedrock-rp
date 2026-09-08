import { randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction, pool } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";
import { publish } from "../../eventbus/index.js";

export class CharacterAlreadyExistsError extends Error {
  constructor() {
    super("user already has a character");
  }
}

/** DB UNIQUE(user_id) on `characters` is the real enforcement; this gives a clean error. */
export async function createCharacter(params: { userId: number; name: string }) {
  const { userId, name } = params;
  try {
    const { pool } = await import("../../db/pool.js");
    const { rows } = await pool.query(
      `INSERT INTO characters (user_id, name) VALUES ($1, $2) RETURNING id, name`,
      [userId, name]
    );
    publish({ type: "CHARACTER_CREATED", characterId: Number(rows[0].id), by: userId });
    return rows[0];
  } catch (err: any) {
    if (err.code === "23505") throw new CharacterAlreadyExistsError(); // unique_violation
    throw err;
  }
}

export async function setWhitelisted(params: {
  characterId: number;
  whitelisted: boolean;
  actorUserId: number;
}) {
  const { characterId, whitelisted, actorUserId } = params;
  await withTransaction(async (client) => {
    await client.query(`UPDATE characters SET whitelisted = $1 WHERE id = $2`, [
      whitelisted,
      characterId,
    ]);
    await writeAudit(
      {
        actorUserId,
        action: whitelisted ? "character.whitelist" : "character.unwhitelist",
        targetType: "character",
        targetId: String(characterId),
        result: "success",
      },
      client
    );
  });

  if (whitelisted) {
    publish({ type: "character.whitelisted", characterId, by: actorUserId });
  }
}

const LINK_CODE_TTL_MINUTES = 15;
const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I, avoid ambiguity when a player types it in chat

function generateLinkCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)];
  }
  return code;
}

export class CharacterAlreadyLinkedError extends Error {
  constructor() {
    super("character is already linked to a Bedrock account");
  }
}

/** Called from the web session (POST /character/link-code). Generates/refreshes a short-lived code for the caller's own character. */
export async function generateLinkCodeForUser(userId: number): Promise<{ code: string; expiresAt: Date }> {
  const { pool } = await import("../../db/pool.js");
  const { rows: charRows } = await pool.query(
    `SELECT id, persistent_id FROM characters WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  if (charRows.length === 0) throw new Error("no character found for this user");
  if (charRows[0].persistent_id) throw new CharacterAlreadyLinkedError();

  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);
  await pool.query(
    `UPDATE characters SET link_code = $1, link_code_expires_at = $2 WHERE id = $3`,
    [code, expiresAt, charRows[0].id]
  );
  return { code, expiresAt };
}

export class InvalidLinkCodeError extends Error {
  constructor() {
    super("link code is invalid or expired");
  }
}

/** The user's own (non-deleted) character, with link/presence summary. Null if none. */
export async function getOwnCharacter(userId: number) {
  const { rows } = await pool.query(
    `SELECT id, name, whitelisted, persistent_id, created_at, last_seen_at
     FROM characters
     WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    whitelisted: row.whitelisted,
    linked: row.persistent_id !== null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export class NoCharacterFoundError extends Error {
  constructor() {
    super("no character found for this user");
  }
}

/**
 * Soft-delete the user's own character. Keeps the row (audit/wallet
 * history stay intact), clears the link so the same Bedrock account can
 * later link to a new character, and invalidates any outstanding link
 * code. Returns nothing; throws NoCharacterFoundError if the user has
 * no live character.
 */
export async function softDeleteCharacter(userId: number) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE characters
       SET is_deleted = true, persistent_id = NULL, link_code = NULL, link_code_expires_at = NULL
       WHERE user_id = $1 AND is_deleted = false
       RETURNING id`,
      [userId]
    );
    if (rows.length === 0) throw new NoCharacterFoundError();
    await writeAudit(
      {
        actorUserId: userId,
        action: "character.delete",
        targetType: "character",
        targetId: String(rows[0].id),
        result: "success",
      },
      client
    );
  });
}
export class PersistentIdAlreadyLinkedError extends Error {
  constructor() {
    super("this Bedrock account is already linked to a different character");
  }
}
/** @deprecated kept as an alias so any external import of the old name doesn't break at compile time; use PersistentIdAlreadyLinkedError going forward. */
export const XuidAlreadyLinkedError = PersistentIdAlreadyLinkedError;

/**
 * Called from the BDS bridge (POST /bridge/character/link) when a player
 * types `!link <code>` in chat. Consumes the code — it cannot be reused
 * once claimed, whether the attempt succeeds or fails on the persistent-id check.
 *
 * NOTE: the wire-level JSON field from the bridge route is still named
 * `xuid` (see bridge/index.ts) even though this function's param is now
 * `persistentId` — that's deliberate, see migration 015's comment.
 */
export async function consumeLinkCode(params: { code: string; persistentId: string }) {
  const { code, persistentId } = params;
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, user_id FROM characters
       WHERE link_code = $1 AND link_code_expires_at > now() AND is_deleted = false
       FOR UPDATE`,
      [code]
    );
    if (rows.length === 0) throw new InvalidLinkCodeError();
    const character = rows[0];

    const { rows: persistentIdRows } = await client.query(
      `SELECT id FROM characters WHERE persistent_id = $1 AND is_deleted = false`,
      [persistentId]
    );
    if (persistentIdRows.length > 0 && persistentIdRows[0].id !== character.id) {
      throw new PersistentIdAlreadyLinkedError();
    }

    await client.query(
      `UPDATE characters SET persistent_id = $1, link_code = NULL, link_code_expires_at = NULL WHERE id = $2`,
      [persistentId, character.id]
    );
    await writeAudit(
      {
        actorUserId: character.user_id,
        action: "character.link",
        targetType: "character",
        targetId: String(character.id),
        payload: { persistentId },
        result: "success",
      },
      client
    );
    return { characterId: character.id };
  });
}

// ---------------------------------------------------------------------------
// RP profile details + confirmation/lock (migrations/018_character_details.sql)
// ---------------------------------------------------------------------------

export interface CharacterDetailsFields {
  first_name?: string | null;
  last_name?: string | null;
  nickname?: string | null;
  date_of_birth?: string | null; // YYYY-MM-DD
  gender?: string | null;
  nationality?: string | null;
  photo_url?: string | null;
  citizen_id?: string | null;
  biography?: string | null;
  personality?: string | null;
  strengths?: string | null;
  weaknesses?: string | null;
  abilities?: string | null;
  previous_job?: string | null;
  hometown?: string | null;
  reason_for_moving?: string | null;
  life_goals?: string | null;
}

/**
 * Identity fields are locked once the character is confirmed (they shape
 * who the character legally IS on the server). Everything else stays
 * editable after confirmation.
 */
const LOCKED_FIELDS = new Set([
  "first_name",
  "last_name",
  "date_of_birth",
  "gender",
  "nationality",
  "citizen_id",
]);

export class CharacterLockedFieldError extends Error {
  constructor(fields: string[]) {
    super(`these fields are locked after confirmation: ${fields.join(", ")}`);
  }
}
export class CharacterIncompleteError extends Error {
  constructor() {
    super("identity fields must be completed before confirming the character");
  }
}
export class CharacterFieldConflictError extends Error {
  constructor(msg: string) {
    super(msg);
  }
}
export class CharacterNotFoundForUserError extends Error {
  constructor() {
    super("no character found for this user");
  }
}

const SHORT_TEXT_MAX = 100;
const LONG_TEXT_MAX = 2000;

function cleanText(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

function validateDob(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new CharacterFieldConflictError("date_of_birth must be a YYYY-MM-DD string");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) throw new CharacterFieldConflictError("date_of_birth must be a YYYY-MM-DD string");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (
    d.getUTCFullYear() !== Number(m[1]) ||
    d.getUTCMonth() !== Number(m[2]) - 1 ||
    d.getUTCDate() !== Number(m[3])
  ) {
    throw new CharacterFieldConflictError("date_of_birth is not a real calendar date");
  }
  if (Number(m[1]) < 1920) throw new CharacterFieldConflictError("date_of_birth is out of range");
  return value.trim();
}

/**
 * Validate and normalize a details patch. Returns the column-name -> value
 * map ready for an UPDATE (unknown/empty-valued fields are dropped).
 * Values that were explicitly cleared come through as null.
 */
function validateDetailsPatch(details: CharacterDetailsFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entries = Object.entries(details).filter(([k, v]) => v !== undefined);

  for (const [field, value] of entries) {
    switch (field) {
      case "first_name":
      case "last_name":
      case "nickname":
      case "previous_job":
      case "hometown":
        out[field] = cleanText(value, SHORT_TEXT_MAX) || null;
        break;
      case "nationality":
        out[field] = cleanText(value, SHORT_TEXT_MAX) || null;
        break;
      case "biography":
      case "personality":
      case "strengths":
      case "weaknesses":
      case "abilities":
      case "reason_for_moving":
      case "life_goals":
        out[field] = cleanText(value, LONG_TEXT_MAX) || null;
        break;
      case "photo_url": {
        const s = cleanText(value, 500);
        if (s && !/^https?:\/\/\S+$/i.test(s)) {
          throw new CharacterFieldConflictError("photo_url must be an http(s) URL");
        }
        out[field] = s || null;
        break;
      }
      case "gender": {
        const g = cleanText(value, SHORT_TEXT_MAX).toLowerCase();
        if (g && !["male", "female", "other"].includes(g)) {
          throw new CharacterFieldConflictError("gender must be male, female or other");
        }
        out[field] = g || null;
        break;
      }
      case "date_of_birth":
        out[field] = validateDob(value);
        break;
      case "citizen_id": {
        const id = cleanText(value, 20).toUpperCase();
        if (id && !/^[A-Z0-9-]{3,20}$/.test(id)) {
          throw new CharacterFieldConflictError("citizen_id may only contain letters, digits and dashes");
        }
        out[field] = id || null;
        break;
      }
      default:
        throw new CharacterFieldConflictError(`unknown character field: ${field}`);
    }
  }
  return out;
}

/** Full profile for the *current* user (own character) — includes confirmation state. */
export async function getOwnCharacterDetails(userId: number) {
  const { rows } = await pool.query(
    `SELECT id, name, whitelisted, persistent_id, created_at, last_seen_at,
            first_name, last_name, nickname, date_of_birth, gender, nationality,
            photo_url, citizen_id, biography, personality, strengths, weaknesses,
            abilities, previous_job, hometown, reason_for_moving, life_goals,
            confirmed_at, lock_version
     FROM characters
     WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  if (rows.length === 0) return null;
  const c = rows[0];
  return {
    id: c.id,
    name: c.name,
    whitelisted: c.whitelisted,
    linked: c.persistent_id !== null,
    confirmed: c.confirmed_at !== null,
    confirmedAt: c.confirmed_at,
    lockVersion: c.lock_version,
    createdAt: c.created_at,
    lastSeenAt: c.last_seen_at,
    details: {
      first_name: c.first_name,
      last_name: c.last_name,
      nickname: c.nickname,
      date_of_birth: c.date_of_birth,
      gender: c.gender,
      nationality: c.nationality,
      photo_url: c.photo_url,
      citizen_id: c.citizen_id,
      biography: c.biography,
      personality: c.personality,
      strengths: c.strengths,
      weaknesses: c.weaknesses,
      abilities: c.abilities,
      previous_job: c.previous_job,
      hometown: c.hometown,
      reason_for_moving: c.reason_for_moving,
      life_goals: c.life_goals,
    },
  };
}

async function ownCharacterId(client: PoolClient, userId: number): Promise<{ characterId: number; confirmed: boolean }> {
  const { rows } = await client.query(
    `SELECT id, confirmed_at IS NOT NULL AS confirmed FROM characters
     WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  if (rows.length === 0) throw new CharacterNotFoundForUserError();
  return { characterId: rows[0].id, confirmed: rows[0].confirmed };
}

/**
 * Update the user's own character details. Unlocked fields may be edited
 * anytime; locked (identity) fields may only be edited BEFORE confirmation
 * — afterwards they go through the case/approval path
 * (applyCharacterLockedChange, gated on character.edit).
 */
export async function updateOwnCharacterDetails(params: {
  userId: number;
  details: CharacterDetailsFields;
  requestId?: string | null;
}): Promise<void> {
  const { userId, details, requestId } = params;

  await withTransaction(async (client) => {
    const { characterId, confirmed } = await ownCharacterId(client, userId);
    const patch = validateDetailsPatch(details);
    if (Object.keys(patch).length === 0) return;

    if (confirmed) {
      const lockedTouched = Object.keys(patch).filter((f) => LOCKED_FIELDS.has(f));
      if (lockedTouched.length > 0) throw new CharacterLockedFieldError(lockedTouched);
    }

    const { rows: beforeRows } = await client.query(
      `SELECT to_jsonb(characters) AS before_state FROM characters WHERE id = $1`,
      [characterId]
    );

    const sets = Object.keys(patch)
      .map((f, i) => `${f} = $${i + 2}`)
      .join(", ");
    await client.query(`UPDATE characters SET ${sets} WHERE id = $1`, [characterId, ...Object.values(patch)]);

    const { rows: afterRows } = await client.query(
      `SELECT to_jsonb(characters) AS after_state FROM characters WHERE id = $1`,
      [characterId]
    );

    await writeAudit(
      {
        actorUserId: userId,
        action: "character.update_details",
        targetType: "character",
        targetId: String(characterId),
        payload: { fields: Object.keys(patch) },
        before: beforeRows[0]?.before_state,
        after: afterRows[0]?.after_state,
        result: "success",
        requestId,
      },
      client
    );
  });
}

/**
 * Lock the character in after the player reviewed their profile. Requires
 * the identity fields to be present (they become immutable afterwards).
 */
export async function confirmCharacter(params: {
  userId: number;
  requestId?: string | null;
}): Promise<void> {
  const { userId, requestId } = params;
  let confirmedCharacterId: number | null = null;
  await withTransaction(async (client) => {
    const { characterId, confirmed } = await ownCharacterId(client, userId);
    if (confirmed) return; // already confirmed — idempotent
    confirmedCharacterId = characterId;

    const { rows } = await client.query(
      `SELECT first_name, last_name, date_of_birth, gender, nationality FROM characters WHERE id = $1`,
      [characterId]
    );
    const c = rows[0];
    if (!c.first_name || !c.last_name || !c.date_of_birth || !c.gender || !c.nationality) {
      throw new CharacterIncompleteError();
    }

    await client.query(
      `UPDATE characters SET confirmed_at = now(), lock_version = lock_version + 1 WHERE id = $1`,
      [characterId]
    );
    await writeAudit(
      {
        actorUserId: userId,
        action: "character.confirm",
        targetType: "character",
        targetId: String(characterId),
        result: "success",
        requestId,
      },
      client
    );
  });
  if (confirmedCharacterId !== null) {
    publish({ type: "CHARACTER_CONFIRMED", characterId: confirmedCharacterId, by: userId });
  }
}

/**
 * Staff-approved change to locked character fields (the case/approval
 * path). Enforced in the route by the `character.edit` permission. When a
 * caseId is given, the case that authorized the change is moved to
 * `resolved` and a timeline entry is recorded.
 */
export async function applyCharacterLockedChange(params: {
  characterId: number;
  actorUserId: number;
  changes: CharacterDetailsFields;
  reason: string;
  caseId?: number | null;
  requestId?: string | null;
}): Promise<void> {
  const { characterId, actorUserId, changes, reason, caseId, requestId } = params;

  await withTransaction(async (client) => {
    const patch = validateDetailsPatch(changes);
    if (Object.keys(patch).length === 0) throw new CharacterFieldConflictError("no valid changes provided");

    const { rows: beforeRows } = await client.query(
      `SELECT to_jsonb(characters) AS before_state FROM characters WHERE id = $1 FOR UPDATE`,
      [characterId]
    );
    if (beforeRows.length === 0) throw new CharacterNotFoundForUserError();

    const sets = Object.keys(patch)
      .map((f, i) => `${f} = $${i + 2}`)
      .join(", ");
    await client.query(
      `UPDATE characters SET ${sets}, lock_version = lock_version + 1 WHERE id = $1`,
      [characterId, ...Object.values(patch)]
    );

    const { rows: afterRows } = await client.query(
      `SELECT to_jsonb(characters) AS after_state FROM characters WHERE id = $1`,
      [characterId]
    );

    await writeAudit(
      {
        actorUserId,
        action: "character.update_locked",
        targetType: "character",
        targetId: String(characterId),
        payload: { fields: Object.keys(patch), caseId },
        before: beforeRows[0]?.before_state,
        after: afterRows[0]?.after_state,
        reason,
        result: "success",
        requestId,
      },
      client
    );

    if (caseId) {
      await client.query(
        `UPDATE cases SET status = 'resolved', updated_at = now() WHERE id = $1`,
        [caseId]
      );
      await client.query(
        `INSERT INTO case_events (case_id, event_type, actor_user_id, payload) VALUES ($1, 'approved_character_change', $2, $3)`,
        [caseId, actorUserId, JSON.stringify({ characterId, reason })]
      );
    }
  });
}

/** Staff read of any character profile (character.view permission in route). */
export async function getCharacterById(characterId: number) {
  const { rows } = await pool.query(
    `SELECT id, name, whitelisted, persistent_id, created_at, last_seen_at,
            first_name, last_name, nickname, date_of_birth, gender, nationality,
            photo_url, citizen_id, biography, personality, strengths, weaknesses,
            abilities, previous_job, hometown, reason_for_moving, life_goals,
            confirmed_at, lock_version, carry_weight_g, is_deleted
     FROM characters WHERE id = $1`,
    [characterId]
  );
  return rows.length === 0 ? null : rows[0];
}
