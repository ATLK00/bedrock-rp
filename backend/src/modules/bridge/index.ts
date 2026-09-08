import { Router } from "express";
import { pool } from "../../db/pool.js";
import { consumeLinkCode, InvalidLinkCodeError, XuidAlreadyLinkedError } from "../character/index.js";

/**
 * Routes called BY the BDS behavior pack (see behavior_pack/scripts/main.js).
 * Auth for these is the shared-secret middleware mounted on /bridge in
 * index.ts — there is no per-player auth here, just "this is our game server."
 */
export const bridgeRouter = Router();

bridgeRouter.post("/player/join", async (req, res) => {
  const { playerId } = req.body ?? {};
  if (!playerId) return res.status(400).json({ error: "playerId is required" });

  // Only updates last_seen_at for a character already linked to this xuid.
  // Linking a fresh xuid to a character happens during onboarding/whitelist
  // flow, not here — this route must stay a no-op for unrecognized players
  // rather than guessing who they are.
  const { rowCount } = await pool.query(
    `UPDATE characters SET last_seen_at = now() WHERE xuid = $1 AND is_deleted = false`,
    [playerId]
  );

  res.status(204).end();
  if (rowCount === 0) {
    console.log(`[bridge] player join for unlinked xuid ${playerId} (no character found, ignored)`);
  }
});

/**
 * Called when a player types `/link <code>` in chat (behavior pack
 * intercepts the chat command and posts here — see behavior_pack docs).
 * Returns a short human-readable message the pack shows back to the player.
 */
bridgeRouter.post("/character/link", async (req, res) => {
  const { code, xuid } = req.body ?? {};
  if (!code || !xuid) return res.status(400).json({ error: "code and xuid are required" });

  try {
    await consumeLinkCode({ code: String(code).toUpperCase(), xuid: String(xuid) });
    res.json({ ok: true, message: "Linked! Your Discord character is now connected to this account." });
  } catch (err: any) {
    if (err instanceof InvalidLinkCodeError) {
      return res.status(400).json({ ok: false, message: "That code is invalid or expired. Request a new one." });
    }
    if (err instanceof XuidAlreadyLinkedError) {
      return res.status(409).json({ ok: false, message: "This Minecraft account is already linked to a different character." });
    }
    console.error("[bridge] character link failed", err);
    res.status(500).json({ ok: false, message: "Something went wrong linking your account. Try again." });
  }
});
