import { Router } from "express";
import { consumeLinkCode, InvalidLinkCodeError, PersistentIdAlreadyLinkedError } from "../character/index.js";
import { registerPlayerJoin, heartbeat, playerLeft } from "../player_session/index.js";

/**
 * Routes called BY the BDS behavior pack (see behavior_pack/scripts/main.js).
 * Auth for these is the shared-secret middleware mounted on /bridge in
 * index.ts — there is no per-player auth here, just "this is our game server."
 * Input validation is deliberate and inline (no schema lib pulled in per
 * module): every field is type-checked and length-capped before touching
 * the DB.
 *
 * Idempotency: join/leave/heartbeat are idempotent BY CONSTRUCTION — a
 * double-delivered packet produces the same end state (one open window, no
 * presence after leave) without double effects, so no separate
 * idempotency-key guarding is needed on top of the existing nonce (exact
 * replays) + drift (old packets) checks in the bridge signature.
 */
export const bridgeRouter = Router();

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const MAX_IDENTIFIER_LENGTH = 64; // persistent ids / player names are short; refuse anything absurd
const PLAYER_NAME_MAX = 32;

/**
 * Structured bridge log line (one per handled call). Logs never contain
 * the shared secret or other credentials — just action/player/status/time.
 */
function logBridge(action: string, req: any, startedAt: number, status: number) {
  const playerId = (req.body ?? {}).playerId ?? (req.body ?? {}).xuid ?? "?";
  console.log(
    `[bridge] ${action} playerId=${String(playerId).slice(0, 40)} status=${status} ${Date.now() - startedAt}ms`
  );
}

function validatePlayerBody(body: unknown): { playerId: string; playerName: string | null } | null {
  const { playerId, playerName } = (body ?? {}) as { playerId?: unknown; playerName?: unknown };
  if (!isNonEmptyString(playerId)) return null;
  if (playerId.length > MAX_IDENTIFIER_LENGTH) return null;
  if (playerName !== undefined && playerName !== null) {
    if (!isNonEmptyString(playerName) || playerName.length > PLAYER_NAME_MAX) return null;
  }
  return { playerId, playerName: playerName ?? null };
}

bridgeRouter.post("/player/join", async (req, res) => {
  const startedAt = Date.now();
  const parsed = validatePlayerBody(req.body);
  if (!parsed) {
    logBridge("join", req, startedAt, 400);
    return res.status(400).json({ error: "playerId (non-empty string) is required" });
  }

  await registerPlayerJoin({
    persistentId: parsed.playerId,
    playerName: parsed.playerName ?? "unknown",
  });
  logBridge("join", req, startedAt, 204);
  res.status(204).end();
});

bridgeRouter.post("/player/leave", async (req, res) => {
  const startedAt = Date.now();
  const parsed = validatePlayerBody(req.body);
  if (!parsed) {
    logBridge("leave", req, startedAt, 400);
    return res.status(400).json({ error: "playerId (non-empty string) is required" });
  }

  await playerLeft({ persistentId: parsed.playerId });
  logBridge("leave", req, startedAt, 204);
  res.status(204).end();
});

bridgeRouter.post("/player/heartbeat", async (req, res) => {
  const startedAt = Date.now();
  const parsed = validatePlayerBody(req.body);
  if (!parsed) {
    logBridge("heartbeat", req, startedAt, 400);
    return res.status(400).json({ error: "playerId (non-empty string) is required" });
  }

  await heartbeat({
    persistentId: parsed.playerId,
    playerName: parsed.playerName ?? "unknown",
  });
  logBridge("heartbeat", req, startedAt, 204);
  res.status(204).end();
});

/**
 * Called when a player types `!link <code>` in chat (behavior pack
 * intercepts the chat command and posts here). Returns a short
 * human-readable message the pack shows back to the player.
 */
bridgeRouter.post("/character/link", async (req, res) => {
  const startedAt = Date.now();
  // NOTE: wire field is still named `xuid` for compatibility with the
  // currently-deployed behavior_pack — see migration 015's comment.
  // Internally we call it persistentId from here on.
  const { code, xuid: persistentId } = (req.body ?? {}) as { code?: unknown; xuid?: unknown };

  if (!isNonEmptyString(code) || code.length > 32) {
    return res.status(400).json({ ok: false, message: "code is required and must be short." });
  }
  if (!isNonEmptyString(persistentId) || persistentId.length > MAX_IDENTIFIER_LENGTH) {
    return res.status(400).json({ ok: false, message: "xuid is required and must be a short identifier." });
  }

  try {
    await consumeLinkCode({ code: String(code).trim().toUpperCase(), persistentId: String(persistentId) });
    logBridge("link", req, startedAt, 200);
    res.json({ ok: true, message: "Linked! Your Discord character is now connected to this account." });
  } catch (err: any) {
    if (err instanceof InvalidLinkCodeError) {
      return res.status(400).json({ ok: false, message: "That code is invalid or expired. Request a new one." });
    }
    if (err instanceof PersistentIdAlreadyLinkedError) {
      return res.status(409).json({ ok: false, message: "This Minecraft account is already linked to a different character." });
    }
    console.error("[bridge] character link failed", err);
    res.status(500).json({ ok: false, message: "Something went wrong linking your account. Try again." });
  }
});