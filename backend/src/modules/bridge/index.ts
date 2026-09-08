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
 */
export const bridgeRouter = Router();

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const MAX_IDENTIFIER_LENGTH = 64; // persistent ids / player names are short; refuse anything absurd
const PLAYER_NAME_MAX = 32;

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
  const parsed = validatePlayerBody(req.body);
  if (!parsed) return res.status(400).json({ error: "playerId (non-empty string) is required" });

  await registerPlayerJoin({
    persistentId: parsed.playerId,
    playerName: parsed.playerName ?? "unknown",
  });
  res.status(204).end();
});

bridgeRouter.post("/player/leave", async (req, res) => {
  const parsed = validatePlayerBody(req.body);
  if (!parsed) return res.status(400).json({ error: "playerId (non-empty string) is required" });

  await playerLeft({ persistentId: parsed.playerId });
  res.status(204).end();
});

bridgeRouter.post("/player/heartbeat", async (req, res) => {
  const parsed = validatePlayerBody(req.body);
  if (!parsed) return res.status(400).json({ error: "playerId (non-empty string) is required" });

  await heartbeat({
    persistentId: parsed.playerId,
    playerName: parsed.playerName ?? "unknown",
  });
  res.status(204).end();
});

/**
 * Called when a player types `!link <code>` in chat (behavior pack
 * intercepts the chat command and posts here). Returns a short
 * human-readable message the pack shows back to the player.
 */
bridgeRouter.post("/character/link", async (req, res) => {
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