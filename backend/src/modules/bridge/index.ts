import { Router } from "express";
import { consumeLinkCode, InvalidLinkCodeError, PersistentIdAlreadyLinkedError, findCharacterByPersistentId } from "../character/index.js";
import { registerPlayerJoin, heartbeat, playerLeft } from "../player_session/index.js";
import * as inventory from "../inventory/index.js";

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

// ---------------------------------------------------------------------------
// In-game inventory (called by the behavior pack's `!inv` UI — action identity
// is the player's persistentId captured at join, NOT a client-supplied id).
// ---------------------------------------------------------------------------

/** Parse a move target: "character" (own slots) or a container id. */
function parseMoveTarget(value: unknown): { kind: "character" } | { kind: "container"; id: number } | null {
  if (value === "character") return { kind: "character" };
  const n =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (Number.isInteger(n) && n > 0) return { kind: "container", id: n };
  return null;
}

/**
 * Resolve the live character for a persistentId (the only identity the pack
 * has), return the character's own slots + carry weight + owned containers.
 */
bridgeRouter.post("/inventory/view", async (req, res) => {
  const startedAt = Date.now();
  const { playerId } = (req.body ?? {}) as { playerId?: unknown };
  if (!isNonEmptyString(playerId) || playerId.length > MAX_IDENTIFIER_LENGTH) {
    logBridge("inv.view", req, startedAt, 400);
    return res.status(400).json({ ok: false, message: "playerId is required." });
  }

  const character = await findCharacterByPersistentId(String(playerId));
  if (!character) {
    logBridge("inv.view", req, startedAt, 404);
    return res.status(404).json({ ok: false, message: "This Minecraft account is not linked to a character yet." });
  }

  const slots = await inventory.getInventory(character.id);
  const containersRaw = await inventory.listInventories({ ownerCharacterId: character.id });
  const containers = [];
  for (const c of containersRaw) {
    const full = await inventory.getContainerInventory(Number(c.id));
    if (full) containers.push({ ...full, id: Number(full.id) });
  }
  const usedWeightG = slots.reduce((sum: number, s: any) => sum + Number(s.quantity) * Number(s.weight_g ?? 0), 0);

  logBridge("inv.view", req, startedAt, 200);
  res.json({
    ok: true,
    character: { id: character.id, name: character.name },
    carryWeightG: usedWeightG,
    carryWeightLimitG: character.carryWeightG,
    slots,
    containers,
  });
});

/**
 * Move items between own inventory surfaces: character <-> container, or
 * container <-> container (same owner). Ownership is enforced server-side —
 * a container that exists but belongs to another character is 403.
 */
bridgeRouter.post("/inventory/move", async (req, res) => {
  const startedAt = Date.now();
  const { playerId, itemId, quantity, from, to } = (req.body ?? {}) as {
    playerId?: unknown;
    itemId?: unknown;
    quantity?: unknown;
    from?: unknown;
    to?: unknown;
  };

  if (!isNonEmptyString(playerId) || playerId.length > MAX_IDENTIFIER_LENGTH) {
    return res.status(400).json({ ok: false, message: "playerId is required." });
  }
  if (!isNonEmptyString(itemId) || String(itemId).length > 64) {
    return res.status(400).json({ ok: false, message: "itemId is required." });
  }
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ ok: false, message: "quantity must be a positive integer." });
  }

  const fromTarget = parseMoveTarget(from);
  const toTarget = parseMoveTarget(to);
  if (!fromTarget || !toTarget) {
    return res.status(400).json({ ok: false, message: "from/to must be 'character' or a container id." });
  }
  const same =
    fromTarget.kind === "character" && toTarget.kind === "character"
      ? true
      : fromTarget.kind === "container" && toTarget.kind === "container" && fromTarget.id === toTarget.id;
  if (same) {
    return res.status(400).json({ ok: false, message: "from and to must be different." });
  }

  const character = await findCharacterByPersistentId(String(playerId));
  if (!character) {
    logBridge("inv.move", req, startedAt, 404);
    return res.status(404).json({ ok: false, message: "This Minecraft account is not linked to a character yet." });
  }

  // Ownership: every container involved must be this character's own.
  const containerIds: number[] = [];
  for (const target of [fromTarget, toTarget]) {
    if (target.kind === "container") containerIds.push(target.id);
  }
  for (const id of new Set(containerIds)) {
    const container = await inventory.getContainerInventory(id);
    if (!container) {
      logBridge("inv.move", req, startedAt, 404);
      return res.status(404).json({ ok: false, message: "Container not found." });
    }
    if (container.owner_character_id !== null && Number(container.owner_character_id) !== character.id) {
      logBridge("inv.move", req, startedAt, 403);
      return res.status(403).json({ ok: false, message: "You can only move items in containers you own." });
    }
  }

  const common = { itemId: String(itemId), quantity, actorUserId: character.userId };
  try {
    if (fromTarget.kind === "character" && toTarget.kind === "container") {
      await inventory.transferCharacterToContainer({ ...common, characterId: character.id, containerId: toTarget.id });
    } else if (fromTarget.kind === "container" && toTarget.kind === "character") {
      await inventory.transferContainerToCharacter({ ...common, containerId: fromTarget.id, characterId: character.id });
    } else if (fromTarget.kind === "container" && toTarget.kind === "container") {
      await inventory.transferItemBetweenContainers({ ...common, fromContainerId: fromTarget.id, toContainerId: toTarget.id });
    } else {
      throw new Error("unreachable: validated earlier that from !== to");
    }
  } catch (err: any) {
    if (err instanceof inventory.ItemNotFoundError) {
      return res.status(404).json({ ok: false, message: "That item doesn't exist." });
    }
    if (err instanceof inventory.InsufficientItemsError) {
      return res.status(409).json({ ok: false, message: "You don't have that many." });
    }
    if (err instanceof inventory.InventoryFullError || err instanceof inventory.CarryWeightExceededError) {
      return res.status(409).json({ ok: false, message: "No room to carry that." });
    }
    if (err instanceof inventory.ContainerCapacityExceededError) {
      return res.status(409).json({ ok: false, message: "That container can't hold that much weight." });
    }
    console.error("[bridge] inventory move failed", err);
    logBridge("inv.move", req, startedAt, 500);
    return res.status(500).json({ ok: false, message: "Something went wrong moving your items. Try again." });
  }

  logBridge("inv.move", req, startedAt, 200);
  res.json({ ok: true, message: "Done." });
});