import { withTransaction } from "../../db/pool.js";
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
    code += LINK_CODE_ALPHABET[Math.floor(Math.random() * LINK_CODE_ALPHABET.length)];
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
