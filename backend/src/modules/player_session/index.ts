import { withTransaction, pool } from "../../db/pool.js";
import { redis } from "../../cache/redis.js";
import { config } from "../../config/index.js";
import { publish } from "../../eventbus/index.js";

/**
 * Player presence: "currently online" is a transient fact (Redis), while
 * session *history* (every join..leave window) is permanent (Postgres
 * `player_sessions`, migration 016). Redis can be flushed freely; the
 * DB is the record of record. If Redis is unavailable, presence degrades
 * to DB-only tracking (join/leave still recorded, just no fast lookup).
 */

const PRESENCE_KEY_PREFIX = "bedrock-rp:presence:online:";

interface PresenceValue {
  persistentId: string;
  playerName: string;
  joinedAt: string;
  characterId: number | null;
}

function presenceKey(persistentId: string): string {
  return `${PRESENCE_KEY_PREFIX}${persistentId}`;
}

async function setPresence(value: PresenceValue): Promise<void> {
  try {
    await redis.set(presenceKey(value.persistentId), JSON.stringify(value), {
      EX: config.PRESENCE_TTL_SECONDS,
    });
  } catch {
    /* presence via Redis is best-effort; DB tracking still runs */
  }
}

/**
 * Called from POST /bridge/player/join. Opens a new session window for a
 * player: closes any still-open window first (reconnect), creates the new
 * row, marks the character's last_seen. Idempotent per persistent_id by
 * construction — DB partial unique index uq_player_sessions_one_active is
 * the backstop if we ever race two joins.
 */
export async function registerPlayerJoin(params: {
  persistentId: string;
  playerName: string;
}): Promise<void> {
  const { persistentId } = params;

  await withTransaction(async (client) => {
    // Close any previous open window for this player (reconnect handling).
    await client.query(
      `UPDATE player_sessions SET left_at = now()
       WHERE persistent_id = $1 AND left_at IS NULL`,
      [persistentId]
    );

    // Resolve character_id if this persistent id is already linked.
    const { rows: charRows } = await client.query(
      `SELECT id FROM characters WHERE persistent_id = $1 AND is_deleted = false`,
      [persistentId]
    );
    const characterId = charRows.length > 0 ? charRows[0].id : null;

    try {
      await client.query(
        `INSERT INTO player_sessions (persistent_id, player_name, character_id)
         VALUES ($1, $2, $3)`,
        [persistentId, params.playerName, characterId]
      );
    } catch (err: any) {
      // 23505 from uq_player_sessions_one_active: two concurrent joins for
      // the same player raced and the other one already opened the window.
      // The reconnect semantics above keep exactly one open window, so a
      // lost race is a successful (idempotent) join, not an error.
      if (err?.code === "23505") return;
      throw err;
    }

    if (characterId !== null) {
      await client.query(
        `UPDATE characters SET last_seen_at = now() WHERE id = $1`,
        [characterId]
      );
    }
  });

  await setPresence({
    persistentId,
    playerName: params.playerName,
    joinedAt: new Date().toISOString(),
    characterId: await resolveCharacterId(persistentId),
  });
  publish({ type: "PLAYER_CONNECTED", persistentId, characterId: await resolveCharacterId(persistentId) });
}

/**
 * Called from POST /bridge/player/heartbeat: refresh presence TTL +
 * last_seen. Guard: only a player with an OPEN session window may
 * heartbeat. A heartbeat that arrives after the window was closed (or was
 * never opened — reconnect after the join call was lost, etc.) is a
 * stale/rogue packet: it must NOT revive presence for someone the DB says
 * is offline, or we would report ghost players as online forever.
 */
export async function heartbeat(params: {
  persistentId: string;
  playerName: string;
}): Promise<void> {
  const { persistentId } = params;

  const { rows } = await pool.query(
    `SELECT id FROM player_sessions WHERE persistent_id = $1 AND left_at IS NULL`,
    [persistentId]
  );
  if (rows.length === 0) {
    // Stale heartbeat — drop any lingering presence so a crash between
    // leave and here can't leave a ghost.
    try {
      await redis.del(presenceKey(persistentId));
    } catch {
      /* best-effort */
    }
    return;
  }

  await setPresence({
    persistentId,
    playerName: params.playerName,
    joinedAt: new Date().toISOString(),
    characterId: await resolveCharacterId(persistentId),
  });
  await pool.query(
    `UPDATE player_sessions SET last_seen_at = now()
     WHERE persistent_id = $1 AND left_at IS NULL`,
    [persistentId]
  );
  await pool.query(
    `UPDATE characters SET last_seen_at = now()
     WHERE persistent_id = $1 AND is_deleted = false`,
    [persistentId]
  );
}

/** Called from POST /bridge/player/leave: close the window, drop presence. */
export async function playerLeft(params: { persistentId: string }): Promise<void> {
  const { persistentId } = params;
  try {
    await redis.del(presenceKey(persistentId));
  } catch {
    /* best-effort */
  }
  const { rowCount } = await pool.query(
    `UPDATE player_sessions SET left_at = now()
     WHERE persistent_id = $1 AND left_at IS NULL`,
    [persistentId]
  );
  await pool.query(
    `UPDATE characters SET last_seen_at = now()
     WHERE persistent_id = $1 AND is_deleted = false`,
    [persistentId]
  );
  if (rowCount !== 0) {
    publish({ type: "PLAYER_DISCONNECTED", persistentId });
  }
}

/** List currently-online players (Redis presence). */
export async function listOnlinePlayers(): Promise<PresenceValue[]> {
  const values: PresenceValue[] = [];
  try {
    let cursor = 0;
    do {
      const result = await redis.scan(cursor, {
        MATCH: `${PRESENCE_KEY_PREFIX}*`,
        COUNT: 100,
      });
      cursor = result.cursor;
      const keys = result.keys;
      if (keys.length > 0) {
        const vals = await redis.mGet(keys);
        for (let i = 0; i < keys.length; i++) {
          if (vals[i]) {
            try {
              values.push(JSON.parse(vals[i]!));
            } catch {
              /* ignore malformed presence values */
            }
          }
        }
      }
    } while (cursor !== 0);
  } catch {
    return []; // Redis down -> report no one online rather than crash
  }
  return values;
}

async function resolveCharacterId(persistentId: string): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT id FROM characters WHERE persistent_id = $1 AND is_deleted = false`,
    [persistentId]
  );
  return rows.length > 0 ? rows[0].id : null;
}