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
    `SELECT id, xuid FROM characters WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  if (charRows.length === 0) throw new Error("no character found for this user");
  if (charRows[0].xuid) throw new CharacterAlreadyLinkedError();

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
export class XuidAlreadyLinkedError extends Error {
  constructor() {
    super("this Bedrock account is already linked to a different character");
  }
}

/**
 * Called from the BDS bridge (POST /bridge/character/link) when a player
 * types `/link <code>` in chat. Consumes the code — it cannot be reused
 * once claimed, whether the attempt succeeds or fails on the xuid check.
 */
export async function consumeLinkCode(params: { code: string; xuid: string }) {
  const { code, xuid } = params;
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, user_id FROM characters
       WHERE link_code = $1 AND link_code_expires_at > now() AND is_deleted = false
       FOR UPDATE`,
      [code]
    );
    if (rows.length === 0) throw new InvalidLinkCodeError();
    const character = rows[0];

    const { rows: xuidRows } = await client.query(
      `SELECT id FROM characters WHERE xuid = $1 AND is_deleted = false`,
      [xuid]
    );
    if (xuidRows.length > 0 && xuidRows[0].id !== character.id) {
      throw new XuidAlreadyLinkedError();
    }

    await client.query(
      `UPDATE characters SET xuid = $1, link_code = NULL, link_code_expires_at = NULL WHERE id = $2`,
      [xuid, character.id]
    );
    await writeAudit(
      {
        actorUserId: character.user_id,
        action: "character.link",
        targetType: "character",
        targetId: String(character.id),
        payload: { xuid },
        result: "success",
      },
      client
    );
    return { characterId: character.id };
  });
}
