import { Router } from "express";
import { consumeLinkCode, InvalidLinkCodeError, PersistentIdAlreadyLinkedError, findCharacterByPersistentId } from "../character/index.js";
import { registerPlayerJoin, heartbeat, playerLeft } from "../player_session/index.js";
import * as inventory from "../inventory/index.js";
import * as economy from "../economy/index.js";
import * as vehicle from "../vehicle/index.js";
import * as property from "../property/index.js";
import * as police from "../police/index.js";
import { hasPermission } from "../../rbac/index.js";
import { emitSecurityEvent } from "../security/index.js";

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
  const accessibleIds = await property.listAccessibleContainerInventoryIds(character.id);
  const containers = [];
  for (const id of accessibleIds) {
    const full = await inventory.getContainerInventory(id);
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

  // Ownership: every container involved must be the character's own, OR owned
  // by them via a held property deed key (property storage).
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
    const canAccess = await property.canAccessContainer(character.id, id);
    if (!canAccess) {
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

// ---------------------------------------------------------------------------
// In-game staff commands (called by the behavior pack's `!give` — mirrors the
// /admin route for economy, but re-authorizes on the staff player's identity
// because bridge calls have no web session: the actor is identified by their
// own persistentId captured at join, and RBAC is re-checked server-side. The
// pack is never trusted — a player without economy.grant is refused here
// regardless of what the client sends, and the attempt is raised as a
// HIGH security event for the Security Center.
// ---------------------------------------------------------------------------

const VALID_GRANT_CURRENCIES = new Set<economy.Currency>(["cash", "bank", "red_money"]);

/**
 * Shared staff-command gate for bridge admin verbs. Resolves the actor's
 * character by persistentId and re-checks RBAC server-side (the pack is never
 * trusted to decide who may act). On any refusal it records a HIGH
 * staff_command_forbidden security event and sends the HTTP response — the
 * caller can tell because it returns null. Returns the authorized actor's
 * own character + Discord userId on success.
 */
async function authorizeStaffActor(params: {
  req: any;
  res: any;
  logAction: string;
  command: string;
  actorName: string | null;
  actorPersistentId: string | null;
  targetName: string | null;
  amountCents: number;
  currency: string;
}): Promise<{ actorCharacterId: number; actorUserId: number; actorName: string } | null> {
  const { req, res, logAction, command, actorName, actorPersistentId, targetName, amountCents, currency } = params;
  const startedAt = Date.now();

  // The actor's own character — if this staff player is not linked to a
  // character, they can't be authorized to act as staff in-game.
  const actorCharacter = actorPersistentId ? await findCharacterByPersistentId(actorPersistentId) : null;
  if (!actorCharacter || !actorPersistentId) {
    logBridge(logAction, req, startedAt, 404);
    res.status(404).json({ ok: false, message: "Your Minecraft account isn't linked to a character — log in to the site and link it before using staff commands." });
    return null;
  }

  // Server-side RBAC on the actor's Discord user. The pack only proves "this
  // is the game server"; the staff identity + permission is settled here.
  const allowed = await hasPermission(actorCharacter.userId, "economy.grant");
  if (!allowed) {
    await emitSecurityEvent({
      eventType: "staff_command_forbidden",
      severity: "HIGH",
      actorUserId: actorCharacter.userId,
      targetType: "character",
      targetId: String(actorCharacter.id),
      payload: { command, actorName: actorName ?? null, targetName: targetName ?? null, amountCents, currency },
    });
    logBridge(logAction, req, startedAt, 403);
    res.status(403).json({ ok: false, message: "You don't have permission to run staff commands in-game." });
    return null;
  }
  return { actorCharacterId: Number(actorCharacter.id), actorUserId: Number(actorCharacter.userId), actorName: actorName ?? "unknown" };
}

/** Shared body validation for in-game money verbs (give/deduct). */
function parseMoneyVerbBody(body: any, res: any, logAction: string, req: any) {
  const { actorName, actorPersistentId, targetName, targetPersistentId, amountCents, currency } = (body ?? {}) as {
    actorName?: unknown;
    actorPersistentId?: unknown;
    targetName?: unknown;
    targetPersistentId?: unknown;
    amountCents?: unknown;
    currency?: unknown;
  };
  const aName = isNonEmptyString(actorName) && actorName.length <= PLAYER_NAME_MAX ? actorName : null;
  const aId = isNonEmptyString(actorPersistentId) && actorPersistentId.length <= MAX_IDENTIFIER_LENGTH ? actorPersistentId : null;
  const tName = isNonEmptyString(targetName) && targetName.length <= PLAYER_NAME_MAX ? targetName : null;
  const tId = isNonEmptyString(targetPersistentId) && targetPersistentId.length <= MAX_IDENTIFIER_LENGTH ? targetPersistentId : null;
  const aCents = typeof amountCents === "number" && Number.isSafeInteger(amountCents) && amountCents > 0 ? amountCents : null;
  const cur = currency === undefined || currency === null ? "cash" : String(currency);

  const fail = (message: string, status: number) => {
    logBridge(logAction, req, Date.now(), status);
    res.status(status).json({ ok: false, message });
  };

  if (!aName || !aId || !tName || !tId || aCents === null) {
    fail("actor/target identity and a positive integer amount are required.", 400);
    return null;
  }
  if (!VALID_GRANT_CURRENCIES.has(cur as economy.Currency)) {
    fail("currency must be cash, bank or red_money.", 400);
    return null;
  }
  return { actorName: aName, actorPersistentId: aId, targetName: tName, targetPersistentId: tId, amountCents: aCents, currency: cur };
}

/** Shared target resolution for in-game money verbs. Returns the target character id or null (response already sent). */
async function resolveTargetCharacter(params: {
  targetPersistentId: string;
  targetName: string;
  res: any;
  logAction: string;
  req: any;
}): Promise<{ targetCharacterId: number } | null> {
  const { targetPersistentId, targetName, res, logAction, req } = params;
  const targetCharacter = await findCharacterByPersistentId(targetPersistentId);
  if (!targetCharacter) {
    logBridge(logAction, req, Date.now(), 404);
    res.status(404).json({ ok: false, message: `${targetName} isn't linked to a character on the server yet.` });
    return null;
  }
  return { targetCharacterId: Number(targetCharacter.id) };
}

/**
 * Called when a staff player types `!give <player> <amount> [currency]` in
 * chat. `actor` is the staff member, `target` the player being granted money.
 * Both are resolved by persistentId (the only identity the pack has), never
 * by client-supplied character ids.
 */
bridgeRouter.post("/admin/give", async (req, res) => {
  const startedAt = Date.now();
  const parsed = parseMoneyVerbBody(req.body, res, "admin.give", req);
  if (!parsed) return;

  const actor = await authorizeStaffActor({
    req, res, logAction: "admin.give", command: "give",
    actorName: parsed.actorName, actorPersistentId: parsed.actorPersistentId,
    targetName: parsed.targetName, amountCents: parsed.amountCents, currency: parsed.currency,
  });
  if (!actor) return;

  const target = await resolveTargetCharacter({
    targetPersistentId: parsed.targetPersistentId, targetName: parsed.targetName, res, logAction: "admin.give", req,
  });
  if (!target) return;

  try {
    await economy.grant({
      characterId: target.targetCharacterId,
      amountCents: parsed.amountCents,
      reason: `in-game grant by ${actor.actorName}`,
      actorUserId: actor.actorUserId,
      currency: parsed.currency as economy.Currency,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    logBridge("admin.give", req, startedAt, 200);
    return res.json({ ok: true, message: `Given ${parsed.amountCents / 100} ${parsed.currency} to ${parsed.targetName}.` });
  } catch (err: any) {
    console.error("[bridge] admin give failed", err);
    logBridge("admin.give", req, startedAt, 500);
    return res.status(500).json({ ok: false, message: "Something went wrong granting money. Try again." });
  }
});

/**
 * `!deduct` — claw money back from an online player (anti-negative enforced
 * inside economy.deduct; insufficient funds → 409 to the actor).
 */
bridgeRouter.post("/admin/deduct", async (req, res) => {
  const startedAt = Date.now();
  const parsed = parseMoneyVerbBody(req.body, res, "admin.deduct", req);
  if (!parsed) return;

  const actor = await authorizeStaffActor({
    req, res, logAction: "admin.deduct", command: "deduct",
    actorName: parsed.actorName, actorPersistentId: parsed.actorPersistentId,
    targetName: parsed.targetName, amountCents: parsed.amountCents, currency: parsed.currency,
  });
  if (!actor) return;

  const target = await resolveTargetCharacter({
    targetPersistentId: parsed.targetPersistentId, targetName: parsed.targetName, res, logAction: "admin.deduct", req,
  });
  if (!target) return;

  try {
    await economy.deduct({
      characterId: target.targetCharacterId,
      amountCents: parsed.amountCents,
      reason: `in-game deduct by ${actor.actorName}`,
      actorUserId: actor.actorUserId,
      currency: parsed.currency as economy.Currency,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    logBridge("admin.deduct", req, startedAt, 200);
    return res.json({ ok: true, message: `Deducted ${parsed.amountCents / 100} ${parsed.currency} from ${parsed.targetName}.` });
  } catch (err: any) {
    if (err instanceof economy.InsufficientFundsError) {
      logBridge("admin.deduct", req, startedAt, 409);
      return res.status(409).json({ ok: false, message: `${parsed.targetName} doesn't have that much to take.` });
    }
    console.error("[bridge] admin deduct failed", err);
    logBridge("admin.deduct", req, startedAt, 500);
    return res.status(500).json({ ok: false, message: "Something went wrong deducting money. Try again." });
  }
});

// ---------------------------------------------------------------------------
// Vehicles (called by the behavior pack's vehicle_ui.js — `!car` command and
// the in-world entity handlers). Authority model: ownership/garage/plate/
// fuel/damage/lock all live here; the pack only reports sensors (ticks driven,
// damage observed) and applies the authoritative snapshot we echo back.
// ---------------------------------------------------------------------------

const VALID_VEHICLE_CURRENCIES = new Set<economy.Currency>(["cash", "bank", "red_money"]);

function parseVehicleId(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function pickCurrency(v: unknown): economy.Currency | null {
  const cur = v === undefined || v === null ? "cash" : String(v);
  return VALID_VEHICLE_CURRENCIES.has(cur as economy.Currency) ? (cur as economy.Currency) : null;
}

/** Resolve the live character driving a vehicle action by persistentId. */
async function requireBridgeActor(res: any, body: any): Promise<{ characterId: number; userId: number } | null> {
  const { playerId } = (body ?? {}) as { playerId?: unknown };
  if (!isNonEmptyString(playerId) || playerId.length > MAX_IDENTIFIER_LENGTH) {
    res.status(400).json({ ok: false, message: "playerId is required." });
    return null;
  }
  const character = await findCharacterByPersistentId(String(playerId));
  if (!character) {
    res.status(404).json({ ok: false, message: "This Minecraft account isn't linked to a character yet." });
    return null;
  }
  return { characterId: character.id, userId: character.userId };
}

/**
 * Wraps a vehicle action with uniform error -> HTTP mapping, so each route
 * below is just validation + a one-line module call.
 */
async function vehicleCall(req: any, res: any, action: string, fn: () => Promise<object>): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    logBridge(action, req, startedAt, 200);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    let status = 500;
    if (err instanceof vehicle.VehicleNotFoundError) status = 404;
    else if (err instanceof vehicle.VehicleAccessDeniedError) status = 403;
    else if (err instanceof vehicle.VehicleInUseError || err instanceof vehicle.VehicleGarageFullError) status = 409;
    else if (err instanceof economy.InsufficientFundsError) status = 409;
    else if (
      err instanceof inventory.InventoryFullError ||
      err instanceof inventory.CarryWeightExceededError ||
      err instanceof inventory.InsufficientItemsError
    ) {
      status = 409;
    }
    logBridge(action, req, startedAt, status);
    res.status(status).json({ ok: false, message: err && err.message ? err.message : "Something went wrong. Try again." });
  }
}

/**
 * Wraps a property action with uniform error -> HTTP mapping, mirroring
 * vehicleCall (same error vocabulary: inventory + economy errors surface as
 * 409 so a full inventory on deed delivery is tellable by the pack).
 */
async function propertyCall(req: any, res: any, action: string, fn: () => Promise<object>): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    logBridge(action, req, startedAt, 200);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    let status = 500;
    if (err instanceof property.PropertyNotFoundError) status = 404;
    else if (err instanceof property.PropertyAccessDeniedError) status = 403;
    else if (err instanceof property.PropertyInUseError) status = 409;
    else if (err instanceof economy.InsufficientFundsError) status = 409;
    else if (
      err instanceof inventory.InventoryFullError ||
      err instanceof inventory.CarryWeightExceededError ||
      err instanceof inventory.InsufficientItemsError
    ) {
      status = 409;
    }
    logBridge(action, req, startedAt, status);
    res.status(status).json({ ok: false, message: err && err.message ? err.message : "Something went wrong. Try again." });
  }
}

// ---------------------------------------------------------------------------
// Properties (called by behavior_pack/scripts/property_ui.js — `!house`).
// Authority model mirrors vehicles: ownership, deeds, money and listing
// state all live here; the pack sends a player choice and renders the
// authoritative result. Sale is 2-phase like vehicle buy (money first, then
// ownership swap, race refunds via PropertyInUseError).
// ---------------------------------------------------------------------------

function parsePropertyId(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsePropertyType(v: unknown): string | null {
  const t = String(v ?? "").trim();
  return /^(house|apartment|warehouse|business|office)$/.test(t) ? t : null;
}

/** `!house` -> owned properties + deed-held access + total garage capacity. */
bridgeRouter.post("/property/mine", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const summary = await property.getPropertySummary(actor.characterId);
  if (!summary) return res.status(404).json({ ok: false, message: "Character not found." });
  logBridge("property.mine", req, Date.now(), 200);
  res.json({ ok: true, ...summary });
});

/** For-sale / government lot browsing (`!house` shop). */
bridgeRouter.post("/property/shop", async (_req, res) => {
  const properties = await property.listProperties({ forSale: true });
  logBridge("property.shop", _req, Date.now(), 200);
  res.json({ ok: true, properties });
});

bridgeRouter.post("/property/lock", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const propertyId = parsePropertyId((req.body ?? {}).propertyId);
  if (!propertyId) return res.status(400).json({ ok: false, message: "propertyId is required." });
  const { locked } = (req.body ?? {}) as { locked?: unknown };
  if (typeof locked !== "boolean") return res.status(400).json({ ok: false, message: "locked must be a boolean." });
  await propertyCall(req, res, "property.lock", async () => {
    const view = await property.setPropertyLocked({
      propertyId, characterId: actor.characterId, locked,
      actorUserId: actor.userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { property: view };
  });
});

/** List for sale / remove the listing (`!house` sell) — owner or staff. */
bridgeRouter.post("/property/sell", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const propertyId = parsePropertyId((req.body ?? {}).propertyId);
  if (!propertyId) return res.status(400).json({ ok: false, message: "propertyId is required." });
  const { priceCents, currency } = (req.body ?? {}) as { priceCents?: unknown; currency?: unknown };
  if (priceCents !== null && priceCents !== undefined) {
    if (typeof priceCents !== "number" || !Number.isSafeInteger(priceCents) || priceCents <= 0) {
      return res.status(400).json({ ok: false, message: "priceCents must be a positive integer or omitted to unlist." });
    }
  }
  const cur = pickCurrency(currency);
  if (!cur) return res.status(400).json({ ok: false, message: "currency must be cash, bank or red_money." });
  const isStaff = await hasPermission(actor.userId, "property.manage");
  await propertyCall(req, res, "property.sell", async () => {
    const view = await property.setSaleListing({
      propertyId, characterId: actor.characterId,
      priceCents: typeof priceCents === "number" ? priceCents : null,
      currency: typeof priceCents === "number" ? cur : undefined,
      isStaff, actorUserId: actor.userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { property: view };
  });
});

/** Free handover to another linked player (deed key moves atomically). */
bridgeRouter.post("/property/transfer", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const { propertyId, targetPersistentId } = (req.body ?? {}) as { propertyId?: unknown; targetPersistentId?: unknown };
  const id = parsePropertyId(propertyId);
  if (!id) return res.status(400).json({ ok: false, message: "propertyId is required." });
  if (!isNonEmptyString(targetPersistentId) || targetPersistentId.length > MAX_IDENTIFIER_LENGTH) {
    return res.status(400).json({ ok: false, message: "targetPersistentId is required." });
  }
  const target = await findCharacterByPersistentId(String(targetPersistentId));
  if (!target) return res.status(404).json({ ok: false, message: "That player isn't linked to a character on the server." });
  await propertyCall(req, res, "property.transfer", async () => {
    const view = await property.transferProperty({
      propertyId: id, fromCharacterId: actor.characterId, toCharacterId: target.id,
      actorUserId: actor.userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { property: view };
  });
});

/** Buy a listed property (government lot or player listing). */
bridgeRouter.post("/property/buy", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const propertyId = parsePropertyId((req.body ?? {}).propertyId);
  if (!propertyId) return res.status(400).json({ ok: false, message: "propertyId is required." });
  await propertyCall(req, res, "property.buy", async () => {
    const view = await property.buyProperty({
      propertyId, buyerCharacterId: actor.characterId,
      actorUserId: actor.userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { property: view };
  });
});

/** `!car` -> my garage (owned vehicles with state + garage capacity). */
bridgeRouter.post("/vehicle/mine", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const summary = await vehicle.getGarageSummary(actor.characterId);
  if (!summary) return res.status(404).json({ ok: false, message: "Character not found." });
  logBridge("vehicle.mine", req, Date.now(), 200);
  res.json({ ok: true, ...summary });
});

/** Deploy a garaged vehicle into the world (status -> deployed; pack spawns the entity). */
bridgeRouter.post("/vehicle/deploy", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const vehicleId = parseVehicleId((req.body ?? {}).vehicleId);
  if (!vehicleId) return res.status(400).json({ ok: false, message: "vehicleId is required." });
  const isStaff = await hasPermission(actor.userId, "vehicle.manage");
  await vehicleCall(req, res, "vehicle.deploy", async () => {
    const view = await vehicle.deployVehicle({
      vehicleId, characterId: actor.characterId, isStaff,
      actorUserId: actor.userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { vehicle: view };
  });
});

/** Send a vehicle back to the garage (pack despawns the entity). */
bridgeRouter.post("/vehicle/store", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const vehicleId = parseVehicleId((req.body ?? {}).vehicleId);
  if (!vehicleId) return res.status(400).json({ ok: false, message: "vehicleId is required." });
  const isStaff = await hasPermission(actor.userId, "vehicle.manage");
  await vehicleCall(req, res, "vehicle.store", async () => {
    const view = await vehicle.storeVehicle({
      vehicleId, characterId: actor.characterId, isStaff,
      actorUserId: actor.userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { vehicle: view };
  });
});

/** Lock / unlock a vehicle (blocks boarding by non-owners via the disabled rideable). */
bridgeRouter.post("/vehicle/lock", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const vehicleId = parseVehicleId((req.body ?? {}).vehicleId);
  if (!vehicleId) return res.status(400).json({ ok: false, message: "vehicleId is required." });
  const locked = (req.body ?? {}).locked;
  if (typeof locked !== "boolean") return res.status(400).json({ ok: false, message: "locked must be a boolean." });
  const isStaff = await hasPermission(actor.userId, "vehicle.manage");
  await vehicleCall(req, res, "vehicle.lock", async () => {
    const view = await vehicle.setVehicleLocked({
      vehicleId, characterId: actor.characterId, locked, isStaff,
      actorUserId: actor.userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { vehicle: view };
  });
});

/** Refuel from the wallet — cost settled server-side, fuel only ever added here. */
bridgeRouter.post("/vehicle/refuel", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const { vehicleId, units, currency } = (req.body ?? {}) as { vehicleId?: unknown; units?: unknown; currency?: unknown };
  const id = parseVehicleId(vehicleId);
  const cur = pickCurrency(currency);
  if (!id) return res.status(400).json({ ok: false, message: "vehicleId is required." });
  if (typeof units !== "number" || !Number.isFinite(units) || units <= 0) {
    return res.status(400).json({ ok: false, message: "units must be a positive number." });
  }
  if (!cur) return res.status(400).json({ ok: false, message: "currency must be cash, bank or red_money." });
  const isStaff = await hasPermission(actor.userId, "vehicle.manage");
  await vehicleCall(req, res, "vehicle.refuel", async () => {
    const { vehicle: view, costCents, refilledUnits } = await vehicle.refuelVehicle({
      vehicleId: id, characterId: actor.characterId, units, currency: cur, isStaff,
      actorUserId: actor.userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { vehicle: view, costCents, refilledUnits };
  });
});

/** Repair all mechanical/cosmetic damage — cost = missing health x per-point rates. */
bridgeRouter.post("/vehicle/repair", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const vehicleId = parseVehicleId((req.body ?? {}).vehicleId);
  const currency = pickCurrency((req.body ?? {}).currency);
  if (!vehicleId) return res.status(400).json({ ok: false, message: "vehicleId is required." });
  if (!currency) return res.status(400).json({ ok: false, message: "currency must be cash, bank or red_money." });
  const isStaff = await hasPermission(actor.userId, "vehicle.manage");
  await vehicleCall(req, res, "vehicle.repair", async () => {
    const { vehicle: view, costCents } = await vehicle.repairVehicle({
      vehicleId, characterId: actor.characterId, currency, isStaff,
      actorUserId: actor.userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { vehicle: view, costCents };
  });
});

/**
 * Sensor heartbeat from the pack (no identity required — it's the installed
 * server speaking, not a player). Fuel is only consumed here; damage/health
 * only ever increase here. Returns the authoritative snapshot the pack must
 * apply to the entity.
 */
bridgeRouter.post("/vehicle/state", async (req, res) => {
  const { vehicleId, drivingTicks, engineHealth, suspensionHealth, bodyDamage } = (req.body ?? {}) as {
    vehicleId?: unknown;
    drivingTicks?: unknown;
    engineHealth?: unknown;
    suspensionHealth?: unknown;
    bodyDamage?: unknown;
  };
  const id = parseVehicleId(vehicleId);
  if (!id) return res.status(400).json({ ok: false, message: "vehicleId is required." });
  const ticks = typeof drivingTicks === "number" && Number.isFinite(drivingTicks) ? Math.max(0, drivingTicks) : 0;
  await vehicleCall(req, res, "vehicle.state", async () => {
    const view = await vehicle.ingestVehicleState({
      vehicleId: id,
      drivingTicks: ticks,
      engineHealth: typeof engineHealth === "number" && Number.isFinite(engineHealth) ? engineHealth : undefined,
      suspensionHealth: typeof suspensionHealth === "number" && Number.isFinite(suspensionHealth) ? suspensionHealth : undefined,
      bodyDamage: typeof bodyDamage === "number" && Number.isFinite(bodyDamage) ? bodyDamage : undefined,
    });
    return { vehicle: view };
  });
});

/** Dealership / player-for-sale vehicles (read list for `!car shop`). */
bridgeRouter.post("/vehicle/shop", async (_req, res) => {
  const vehicles = await vehicle.listVehicles({ forSale: true });
  logBridge("vehicle.shop", _req, Date.now(), 200);
  res.json({ ok: true, vehicles });
});

/** Buy a listed vehicle — money moves first, ownership only on success (refund on race). */
bridgeRouter.post("/vehicle/buy", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const vehicleId = parseVehicleId((req.body ?? {}).vehicleId);
  if (!vehicleId) return res.status(400).json({ ok: false, message: "vehicleId is required." });
  await vehicleCall(req, res, "vehicle.buy", async () => {
    const view = await vehicle.buyVehicle({
      vehicleId, buyerCharacterId: actor.characterId,
      actorUserId: actor.userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { vehicle: view };
  });
});

/** List a vehicle for sale / remove the listing (`!car sell`) — seller must own + be parked. */
bridgeRouter.post("/vehicle/sell", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const { vehicleId, priceCents, currency } = (req.body ?? {}) as { vehicleId?: unknown; priceCents?: unknown; currency?: unknown };
  const id = parseVehicleId(vehicleId);
  if (!id) return res.status(400).json({ ok: false, message: "vehicleId is required." });
  if (priceCents !== null && priceCents !== undefined) {
    if (typeof priceCents !== "number" || !Number.isSafeInteger(priceCents) || priceCents <= 0) {
      return res.status(400).json({ ok: false, message: "priceCents must be a positive integer or omitted to unlist." });
    }
  }
  const cur = pickCurrency(currency);
  if (!cur) return res.status(400).json({ ok: false, message: "currency must be cash, bank or red_money." });
  const isStaff = await hasPermission(actor.userId, "vehicle.manage");
  await vehicleCall(req, res, "vehicle.sell", async () => {
    const view = await vehicle.setSaleListing({
      vehicleId: id, characterId: actor.characterId,
      priceCents: typeof priceCents === "number" ? priceCents : null,
      currency: typeof priceCents === "number" ? cur : undefined,
      isStaff,
      actorUserId: actor.userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { vehicle: view };
  });
});

/** Free handover to another linked player (key revokes/granted atomically). */
bridgeRouter.post("/vehicle/transfer", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const { vehicleId, targetPersistentId } = (req.body ?? {}) as { vehicleId?: unknown; targetPersistentId?: unknown };
  const id = parseVehicleId(vehicleId);
  if (!id) return res.status(400).json({ ok: false, message: "vehicleId is required." });
  if (!isNonEmptyString(targetPersistentId) || targetPersistentId.length > MAX_IDENTIFIER_LENGTH) {
    return res.status(400).json({ ok: false, message: "targetPersistentId is required." });
  }
  const target = await findCharacterByPersistentId(String(targetPersistentId));
  if (!target) return res.status(404).json({ ok: false, message: "That player isn't linked to a character on the server." });
  await vehicleCall(req, res, "vehicle.transfer", async () => {
    const view = await vehicle.transferVehicle({
      vehicleId: id, fromCharacterId: actor.characterId, toCharacterId: target.id,
      actorUserId: actor.userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { vehicle: view };
  });
});

/**
 * Called once at pack boot: any vehicle marked 'deployed' whose entity no
 * longer exists (or was never re-acked this boot) returns to the garage,
 * so a world/server restart can't strand vehicles.
 */
bridgeRouter.post("/vehicle/reconcile", async (req, res) => {
  const deployed = Array.isArray((req.body ?? {}).deployedVehicleIds)
    ? ((req.body ?? {}).deployedVehicleIds as unknown[]).map(Number)
    : [];
  const resetToGarage = await vehicle.reconcileDeployed({
    deployedVehicleIds: deployed.filter((n) => Number.isInteger(n) && n > 0),
    requestId: (req as unknown as { requestId?: string }).requestId ?? null,
  });
  logBridge("vehicle.reconcile", req, Date.now(), 200);
  res.json({ ok: true, resetToGarage });
});

// ---------------------------------------------------------------------------
// Police (called by behavior_pack/scripts/police_ui.js — `!police`/`!mdt`).
// Authority model mirrors !give: the pack forwards the officer's own
// persistentId and RBAC is re-checked server-side (police.view / manage /
// admin). The pack is never trusted — a player without the permission is
// refused here and the attempt is raised as a HIGH security event.
// Citizen-pays routes (fine/pay, me) use the caller's own identity instead.
// ---------------------------------------------------------------------------

function parsePoliceId(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsePlates(v: unknown): string | null {
  if (!isNonEmptyString(v)) return null;
  const p = String(v).trim().toUpperCase();
  return p.length >= 1 && p.length <= 16 ? p : null;
}

async function policeCall(req: any, res: any, action: string, fn: () => Promise<object>): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    logBridge(action, req, startedAt, 200);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    let status = 500;
    if (
      err instanceof police.CitizenNotFoundError ||
      err instanceof police.VehicleNotFoundError ||
      err instanceof police.LicenseNotFoundError ||
      err instanceof police.FineNotFoundError ||
      err instanceof police.ReportNotFoundError ||
      err instanceof police.WarrantNotFoundError ||
      err instanceof police.ArrestNotFoundError
    ) {
      status = 404;
    } else if (err instanceof police.FineAccessDeniedError) {
      status = 403;
    } else if (
      err instanceof police.LicenseExistsError ||
      err instanceof police.FineAlreadyPaidError ||
      err instanceof police.WarrantNotActiveError ||
      err instanceof police.CharacterAlreadyInJailError ||
      err instanceof police.ArrestNotActiveError ||
      err instanceof economy.InsufficientFundsError
    ) {
      status = 409;
    }
    logBridge(action, req, startedAt, status);
    res.status(status).json({ ok: false, message: err && err.message ? err.message : "Something went wrong. Try again." });
  }
}

/**
 * Officer gate for police verbs: the actor's character is resolved from their
 * own persistentId and a specific permission re-checked server-side. On any
 * refusal a HIGH staff_command_forbidden security event is recorded and the
 * HTTP response sent — the caller can tell because it returns null.
 */
async function authorizePoliceActor(params: {
  req: any;
  res: any;
  permission: string;
  command: string;
  actorName: string | null;
  actorPersistentId: string | null;
  extra?: Record<string, unknown>;
}): Promise<{ actorCharacterId: number; actorUserId: number; actorName: string } | null> {
  const { req, res, permission, command, actorName, actorPersistentId, extra } = params;
  const startedAt = Date.now();
  const logAction = `police.${command}`;

  const actorCharacter = actorPersistentId ? await findCharacterByPersistentId(actorPersistentId) : null;
  if (!actorCharacter || !actorPersistentId) {
    logBridge(logAction, req, startedAt, 404);
    res.status(404).json({ ok: false, message: "Your Minecraft account isn't linked to a character — log in to the site and link it before using police commands." });
    return null;
  }

  const allowed = await hasPermission(actorCharacter.userId, permission);
  if (!allowed) {
    await emitSecurityEvent({
      eventType: "staff_command_forbidden",
      severity: "HIGH",
      actorUserId: actorCharacter.userId,
      targetType: "character",
      targetId: String(actorCharacter.id),
      payload: { command: logAction, actorName: actorName ?? null, ...(extra ?? {}) },
    });
    logBridge(logAction, req, startedAt, 403);
    res.status(403).json({ ok: false, message: "You don't have permission to use police commands in-game." });
    return null;
  }
  return { actorCharacterId: Number(actorCharacter.id), actorUserId: Number(actorCharacter.userId), actorName: actorName ?? "unknown" };
}

function parsePoliceBodyLogin(body: any): { actorName: string | null; actorPersistentId: string | null } {
  const { actorName, actorPersistentId } = (body ?? {}) as { actorName?: unknown; actorPersistentId?: unknown };
  const aName = isNonEmptyString(actorName) && actorName.length <= PLAYER_NAME_MAX ? actorName : null;
  const aId = isNonEmptyString(actorPersistentId) && actorPersistentId.length <= MAX_IDENTIFIER_LENGTH ? actorPersistentId : null;
  return { actorName: aName, actorPersistentId: aId };
}

/**
 * `!police` root — every player can call this: officers get their role flags +
 * the full citizen view of their own civil state, citizens get fines/licenses/
 * warrants/jail status. The pack uses it to render the correct menu.
 */
bridgeRouter.post("/police/me", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const mine = await police.getMineState(actor.characterId);
  logBridge("police.me", req, Date.now(), 200);
  res.json({ ok: true, mine });
});

/** MDT roles — read-only flags so the pack can build the officer menu. */
bridgeRouter.post("/police/roles", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const [canView, canManage, canAdmin] = await Promise.all([
    hasPermission(actor.userId, "police.view"),
    hasPermission(actor.userId, "police.manage"),
    hasPermission(actor.userId, "police.admin"),
  ]);
  logBridge("police.roles", req, Date.now(), 200);
  res.json({ ok: true, roles: { canView, canManage, canAdmin } });
});

/** MDT lookup by citizen name or citizen id (officer). */
bridgeRouter.post("/police/lookup/character", async (req, res) => {
  const login = parsePoliceBodyLogin(req.body);
  const actor = await authorizePoliceActor({ req, res, permission: "police.view", command: "lookup.character", actorName: login.actorName, actorPersistentId: login.actorPersistentId });
  if (!actor) return;
  const query = isNonEmptyString((req.body ?? {}).query) ? String((req.body ?? {}).query).trim() : "";
  if (query.length === 0 || query.length > 128) {
    return res.status(400).json({ ok: false, message: "query (citizen name or citizen id) is required." });
  }
  let target = await police.findCitizenByCitizenId(query);
  if (!target) target = await police.findCitizenByName(query);
  if (!target) return res.status(404).json({ ok: false, message: "No citizen found for that name or citizen id." });

  const citizen = await police.getCitizenMdt(target.id);
  if (!citizen) return res.status(404).json({ ok: false, message: "Citizen not found." });
  logBridge("police.lookup.character", req, Date.now(), 200);
  res.json({ ok: true, citizen });
});

/** MDT vehicle record lookup by plate (officer). */
bridgeRouter.post("/police/lookup/vehicle", async (req, res) => {
  const login = parsePoliceBodyLogin(req.body);
  const actor = await authorizePoliceActor({ req, res, permission: "police.view", command: "lookup.vehicle", actorName: login.actorName, actorPersistentId: login.actorPersistentId });
  if (!actor) return;
  const plate = parsePlates((req.body ?? {}).plate);
  if (!plate) return res.status(400).json({ ok: false, message: "plate (1-16 chars) is required." });
  const vehicleRow = await police.lookupVehicle(plate);
  if (!vehicleRow) return res.status(404).json({ ok: false, message: "No vehicle found with that plate." });
  logBridge("police.lookup.vehicle", req, Date.now(), 200);
  res.json({ ok: true, vehicle: vehicleRow });
});

/** Issue / suspend / revoke a license for an online citizen. */
bridgeRouter.post("/police/license", async (req, res) => {
  const login = parsePoliceBodyLogin(req.body);
  const { action, licenseType, notes, targetName, targetPersistentId } = (req.body ?? {}) as { action?: unknown; licenseType?: unknown; notes?: unknown; targetName?: unknown; targetPersistentId?: unknown };
  if (!["issue", "suspend", "revoke"].includes(String(action))) {
    return res.status(400).json({ ok: false, message: "action must be issue, suspend or revoke." });
  }
  if (typeof licenseType !== "string" || !police.VALID_LICENSE_TYPES.has(licenseType)) {
    return res.status(400).json({ ok: false, message: "licenseType must be one of: driving, weapon, business, fishing, aviation." });
  }
  if (!isNonEmptyString(targetPersistentId) || targetPersistentId.length > MAX_IDENTIFIER_LENGTH) {
    return res.status(400).json({ ok: false, message: "targetPersistentId is required." });
  }
  const actor = await authorizePoliceActor({ req, res, permission: "police.manage", command: "license", actorName: login.actorName, actorPersistentId: login.actorPersistentId, extra: { licenseType, action } });
  if (!actor) return;
  const target = await resolveTargetCharacter({ targetPersistentId: String(targetPersistentId), targetName: isNonEmptyString(targetName) ? String(targetName) : "target", res, logAction: "police.license", req });
  if (!target) return;

  await policeCall(req, res, "police.license", async () => {
    const license = await police.setLicense({
      characterId: target.targetCharacterId,
      licenseType: String(licenseType),
      action: String(action) as "issue" | "suspend" | "revoke",
      notes: notes == null ? null : String(notes),
      actorUserId: actor.actorUserId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { license };
  });
});

/** Issue a fine to an online citizen (money moves only when the citizen pays). */
bridgeRouter.post("/police/fine", async (req, res) => {
  const login = parsePoliceBodyLogin(req.body);
  const { amountCents, currency, reason, targetName, targetPersistentId } = (req.body ?? {}) as { amountCents?: unknown; currency?: unknown; reason?: unknown; targetName?: unknown; targetPersistentId?: unknown };
  const cents = typeof amountCents === "number" && Number.isSafeInteger(amountCents) && amountCents > 0 ? amountCents : null;
  if (cents === null) return res.status(400).json({ ok: false, message: "amountCents must be a positive integer." });
  const cur = (currency === undefined || currency === null) ? "cash" : String(currency);
  if (!police.VALID_CURRENCIES.has(cur as economy.Currency)) {
    return res.status(400).json({ ok: false, message: "currency must be cash, bank or red_money." });
  }
  if (!isNonEmptyString(reason) || String(reason).length > 1000) {
    return res.status(400).json({ ok: false, message: "reason (1-1000 chars) is required." });
  }
  if (!isNonEmptyString(targetPersistentId) || targetPersistentId.length > MAX_IDENTIFIER_LENGTH) {
    return res.status(400).json({ ok: false, message: "targetPersistentId is required." });
  }
  const actor = await authorizePoliceActor({ req, res, permission: "police.manage", command: "fine", actorName: login.actorName, actorPersistentId: login.actorPersistentId, extra: { amountCents: cents, currency: cur, reason: String(reason) } });
  if (!actor) return;
  const target = await resolveTargetCharacter({ targetPersistentId: String(targetPersistentId), targetName: isNonEmptyString(targetName) ? String(targetName) : "target", res, logAction: "police.fine", req });
  if (!target) return;

  await policeCall(req, res, "police.fine", async () => {
    const fine = await police.issueFine({
      targetCharacterId: target.targetCharacterId,
      officerCharacterId: actor.actorCharacterId,
      amountCents: cents,
      currency: cur as economy.Currency,
      reason: String(reason),
      actorUserId: actor.actorUserId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { fine };
  });
});

/** A citizen pays their own outstanding fine (money sink). Not an officer verb. */
bridgeRouter.post("/police/fine/pay", async (req, res) => {
  const actor = await requireBridgeActor(res, req.body);
  if (!actor) return;
  const fineId = parsePoliceId((req.body ?? {}).fineId);
  if (!fineId) return res.status(400).json({ ok: false, message: "fineId is required." });
  await policeCall(req, res, "police.fine.pay", async () => {
    const fine = await police.payFine({
      fineId,
      characterId: actor.characterId,
      actorUserId: actor.userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { fine };
  });
});

/** Officer writes a police report. */
bridgeRouter.post("/police/report", async (req, res) => {
  const login = parsePoliceBodyLogin(req.body);
  const { title, body, classification } = (req.body ?? {}) as { title?: unknown; body?: unknown; classification?: unknown };
  if (!isNonEmptyString(title) || String(title).length > 200) return res.status(400).json({ ok: false, message: "title (1-200 chars) is required." });
  if (!isNonEmptyString(body) || String(body).length > 10000) return res.status(400).json({ ok: false, message: "body (1-10000 chars) is required." });
  if (classification != null && !["general", "restricted", "classified"].includes(String(classification))) {
    return res.status(400).json({ ok: false, message: "classification must be general, restricted or classified." });
  }
  const actor = await authorizePoliceActor({ req, res, permission: "police.manage", command: "report", actorName: login.actorName, actorPersistentId: login.actorPersistentId, extra: { title: String(title) } });
  if (!actor) return;
  await policeCall(req, res, "police.report", async () => {
    const report = await police.createReport({
      officerCharacterId: actor.actorCharacterId,
      title: String(title),
      body: String(body),
      classification: classification == null ? "general" : String(classification),
      actorUserId: actor.actorUserId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { report };
  });
});

/** Officer closes a report. */
bridgeRouter.post("/police/report/close", async (req, res) => {
  const login = parsePoliceBodyLogin(req.body);
  const reportId = parsePoliceId((req.body ?? {}).reportId);
  if (!reportId) return res.status(400).json({ ok: false, message: "reportId is required." });
  const actor = await authorizePoliceActor({ req, res, permission: "police.manage", command: "report.close", actorName: login.actorName, actorPersistentId: login.actorPersistentId, extra: { reportId } });
  if (!actor) return;
  await policeCall(req, res, "police.report.close", async () => {
    const report = await police.closeReport({ reportId, actorUserId: actor.actorUserId, requestId: (req as unknown as { requestId?: string }).requestId ?? null });
    return { report };
  });
});

/** Officer logs an evidence record (optionally attached to a report). */
bridgeRouter.post("/police/evidence", async (req, res) => {
  const login = parsePoliceBodyLogin(req.body);
  const { reportId, description, itemId, quantity } = (req.body ?? {}) as { reportId?: unknown; description?: unknown; itemId?: unknown; quantity?: unknown };
  if (!isNonEmptyString(description) || String(description).length > 1000) return res.status(400).json({ ok: false, message: "description (1-1000 chars) is required." });
  if (reportId != null && parsePoliceId(reportId) === null) return res.status(400).json({ ok: false, message: "reportId must be a positive integer." });
  const actor = await authorizePoliceActor({ req, res, permission: "police.manage", command: "evidence", actorName: login.actorName, actorPersistentId: login.actorPersistentId, extra: { description: String(description) } });
  if (!actor) return;
  await policeCall(req, res, "police.evidence", async () => {
    const evidence = await police.addEvidence({
      reportId: reportId == null ? null : parsePoliceId(reportId),
      officerCharacterId: actor.actorCharacterId,
      description: String(description),
      itemId: itemId == null ? null : String(itemId),
      quantity: typeof quantity === "number" ? quantity : undefined,
      actorUserId: actor.actorUserId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { evidence };
  });
});

/** Officer issues an arrest/search warrant (minutes = optional self-expiry). */
bridgeRouter.post("/police/warrant", async (req, res) => {
  const login = parsePoliceBodyLogin(req.body);
  const { warrantType, reason, minutes, targetName, targetPersistentId } = (req.body ?? {}) as { warrantType?: unknown; reason?: unknown; minutes?: unknown; targetName?: unknown; targetPersistentId?: unknown };
  if (typeof warrantType !== "string" || !police.VALID_WARRANT_TYPES.has(warrantType)) {
    return res.status(400).json({ ok: false, message: "warrantType must be arrest or search." });
  }
  if (!isNonEmptyString(reason) || String(reason).length > 1000) return res.status(400).json({ ok: false, message: "reason (1-1000 chars) is required." });
  if (!isNonEmptyString(targetPersistentId) || targetPersistentId.length > MAX_IDENTIFIER_LENGTH) {
    return res.status(400).json({ ok: false, message: "targetPersistentId is required." });
  }
  const m = minutes == null ? 0 : Number(minutes);
  if (!Number.isSafeInteger(m) || m < 0 || m > 10080) return res.status(400).json({ ok: false, message: "minutes must be 0-10080 (0 = no expiry)." });
  const actor = await authorizePoliceActor({ req, res, permission: "police.manage", command: "warrant", actorName: login.actorName, actorPersistentId: login.actorPersistentId, extra: { warrantType: String(warrantType) } });
  if (!actor) return;
  const target = await resolveTargetCharacter({ targetPersistentId: String(targetPersistentId), targetName: isNonEmptyString(targetName) ? String(targetName) : "target", res, logAction: "police.warrant", req });
  if (!target) return;
  await policeCall(req, res, "police.warrant", async () => {
    const warrant = await police.issueWarrant({
      targetCharacterId: target.targetCharacterId,
      warrantType: String(warrantType),
      reason: String(reason),
      officerCharacterId: actor.actorCharacterId,
      expiresAt: m > 0 ? new Date(Date.now() + m * 60_000) : null,
      actorUserId: actor.actorUserId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { warrant };
  });
});

/** Senior staff revokes a warrant. */
bridgeRouter.post("/police/warrant/revoke", async (req, res) => {
  const login = parsePoliceBodyLogin(req.body);
  const warrantId = parsePoliceId((req.body ?? {}).warrantId);
  if (!warrantId) return res.status(400).json({ ok: false, message: "warrantId is required." });
  const actor = await authorizePoliceActor({ req, res, permission: "police.admin", command: "warrant.revoke", actorName: login.actorName, actorPersistentId: login.actorPersistentId, extra: { warrantId } });
  if (!actor) return;
  await policeCall(req, res, "police.warrant.revoke", async () => {
    const warrant = await police.revokeWarrant({ warrantId, actorUserId: actor.actorUserId, requestId: (req as unknown as { requestId?: string }).requestId ?? null });
    return { warrant };
  });
});

/** Officer arrests an online citizen (optional auto-executed arrest warrant). */
bridgeRouter.post("/police/arrest", async (req, res) => {
  const login = parsePoliceBodyLogin(req.body);
  const { reason, minutes, targetName, targetPersistentId } = (req.body ?? {}) as { reason?: unknown; minutes?: unknown; targetName?: unknown; targetPersistentId?: unknown };
  if (!isNonEmptyString(reason) || String(reason).length > 1000) return res.status(400).json({ ok: false, message: "reason (1-1000 chars) is required." });
  const m = typeof minutes === "number" ? Math.round(minutes) : 120;
  if (!Number.isSafeInteger(m) || m < police.MIN_ARREST_MINUTES || m > police.MAX_ARREST_MINUTES) {
    return res.status(400).json({ ok: false, message: `minutes must be between ${police.MIN_ARREST_MINUTES} and ${police.MAX_ARREST_MINUTES}.` });
  }
  if (!isNonEmptyString(targetPersistentId) || targetPersistentId.length > MAX_IDENTIFIER_LENGTH) {
    return res.status(400).json({ ok: false, message: "targetPersistentId is required." });
  }
  const actor = await authorizePoliceActor({ req, res, permission: "police.manage", command: "arrest", actorName: login.actorName, actorPersistentId: login.actorPersistentId, extra: { minutes: m, reason: String(reason) } });
  if (!actor) return;
  const target = await resolveTargetCharacter({ targetPersistentId: String(targetPersistentId), targetName: isNonEmptyString(targetName) ? String(targetName) : "target", res, logAction: "police.arrest", req });
  if (!target) return;
  await policeCall(req, res, "police.arrest", async () => {
    const arrest = await police.arrestCharacter({
      characterId: target.targetCharacterId,
      officerCharacterId: actor.actorCharacterId,
      reason: String(reason),
      minutes: m,
      actorUserId: actor.actorUserId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { arrest };
  });
});

/** Warden/senior officer releases a jailed citizen early. */
bridgeRouter.post("/police/release", async (req, res) => {
  const login = parsePoliceBodyLogin(req.body);
  const { targetName, targetPersistentId } = (req.body ?? {}) as { targetName?: unknown; targetPersistentId?: unknown };
  if (!isNonEmptyString(targetPersistentId) || targetPersistentId.length > MAX_IDENTIFIER_LENGTH) {
    return res.status(400).json({ ok: false, message: "targetPersistentId is required." });
  }
  const actor = await authorizePoliceActor({ req, res, permission: "police.manage", command: "release", actorName: login.actorName, actorPersistentId: login.actorPersistentId });
  if (!actor) return;
  const target = await resolveTargetCharacter({ targetPersistentId: String(targetPersistentId), targetName: isNonEmptyString(targetName) ? String(targetName) : "target", res, logAction: "police.release", req });
  if (!target) return;
  await policeCall(req, res, "police.release", async () => {
    const arrest = await police.releaseArrest({
      characterId: target.targetCharacterId,
      releasedByCharacterId: actor.actorCharacterId,
      actorUserId: actor.actorUserId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { arrest };
  });
});

/** Officer updates a citizen's police record (alias / threat level / notes). */
bridgeRouter.post("/police/record", async (req, res) => {
  const login = parsePoliceBodyLogin(req.body);
  const { alias, threatLevel, notes, targetName, targetPersistentId } = (req.body ?? {}) as { alias?: unknown; threatLevel?: unknown; notes?: unknown; targetName?: unknown; targetPersistentId?: unknown };
  if (threatLevel != null && !police.VALID_THREAT_LEVELS.has(String(threatLevel))) {
    return res.status(400).json({ ok: false, message: "threatLevel must be none, low, medium, high or critical." });
  }
  if (!isNonEmptyString(targetPersistentId) || targetPersistentId.length > MAX_IDENTIFIER_LENGTH) {
    return res.status(400).json({ ok: false, message: "targetPersistentId is required." });
  }
  const actor = await authorizePoliceActor({ req, res, permission: "police.manage", command: "record", actorName: login.actorName, actorPersistentId: login.actorPersistentId, extra: { threatLevel: threatLevel ?? null } });
  if (!actor) return;
  const target = await resolveTargetCharacter({ targetPersistentId: String(targetPersistentId), targetName: isNonEmptyString(targetName) ? String(targetName) : "target", res, logAction: "police.record", req });
  if (!target) return;
  await policeCall(req, res, "police.record", async () => {
    const record = await police.upsertRecord({
      characterId: target.targetCharacterId,
      alias: alias == null ? null : String(alias),
      threatLevel: threatLevel == null ? null : String(threatLevel),
      notes: notes == null ? null : String(notes),
      actorUserId: actor.actorUserId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    return { record };
  });
});