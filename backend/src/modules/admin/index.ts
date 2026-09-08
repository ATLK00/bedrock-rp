import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requirePermission } from "../../rbac/index.js";
import * as economy from "../economy/index.js";
import * as character from "../character/index.js";
import * as inventory from "../inventory/index.js";
import * as rbacAdmin from "../../rbac/admin.js";
import * as users from "../users/index.js";
import * as shop from "../shop/index.js";
import * as trade from "../trade/index.js";
import * as playerSession from "../player_session/index.js";
import { cleanupOldSessions } from "../auth/index.js";
import * as cases from "../cases/index.js";
import * as security from "../security/index.js";

/**
 * Admin HTTP routes. Every route:
 *   1. requires a specific permission (RBAC),
 *   2. delegates to the owning module (economy/character), which itself audits.
 * Do not put business logic here — this file is routing + authorization only.
 */
export const adminRouter = Router();

const requestIdOf = (req: any) => (req as unknown as { requestId?: string }).requestId ?? null;

adminRouter.use((req, res, next) => {
  if (typeof req.userId !== "number") {
    return res.status(401).json({ error: "unauthenticated" });
  }
  next();
});

adminRouter.post("/economy/grant", requirePermission("economy.grant"), async (req, res) => {
  const { characterId, amountCents, reason, currency, idempotencyKey } = req.body ?? {};
  if (!characterId || !amountCents || !reason) {
    return res.status(400).json({ error: "characterId, amountCents, reason are required" });
  }
  try {
    await economy.grant({
      characterId,
      amountCents,
      reason,
      actorUserId: req.userId!,
      currency,
      idempotencyKey: idempotencyKey ?? null,
      requestId: requestIdOf(req),
    });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof (await import("../idempotency/index.js")).IdempotencyKeyMismatchError) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * Claw money back from a character (anti-negative enforced inside
 * economy.deduct). Gated on the same permission as grant — minting and
 * clawback are two sides of one economy superpower.
 */
adminRouter.post("/economy/deduct", requirePermission("economy.grant"), async (req, res) => {
  const { characterId, amountCents, reason, currency, idempotencyKey } = req.body ?? {};
  if (typeof characterId !== "number" || typeof amountCents !== "number" || !reason) {
    return res.status(400).json({ error: "characterId (number), amountCents (number), reason are required" });
  }
  try {
    await economy.deduct({
      characterId,
      amountCents,
      reason,
      actorUserId: req.userId!,
      currency,
      idempotencyKey: idempotencyKey ?? null,
      requestId: requestIdOf(req),
    });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof economy.InsufficientFundsError) return res.status(409).json({ error: err.message });
    if (err instanceof (await import("../idempotency/index.js")).IdempotencyKeyMismatchError) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/character/whitelist", requirePermission("character.whitelist"), async (req, res) => {
  const { characterId, whitelisted } = req.body ?? {};
  if (typeof characterId !== "number" || typeof whitelisted !== "boolean") {
    return res.status(400).json({ error: "characterId (number) and whitelisted (boolean) are required" });
  }
  await character.setWhitelisted({ characterId, whitelisted, actorUserId: req.userId! });
  res.status(204).end();
});

adminRouter.post("/inventory/give", requirePermission("inventory.give"), async (req, res) => {
  const { characterId, itemId, quantity, meta } = req.body ?? {};
  if (typeof characterId !== "number" || !itemId || typeof quantity !== "number") {
    return res.status(400).json({ error: "characterId (number), itemId (string), quantity (number) are required" });
  }
  if (meta !== undefined && (typeof meta !== "object" || meta === null || Array.isArray(meta))) {
    return res.status(400).json({ error: "meta (optional) must be an object" });
  }
  try {
    await inventory.giveItem({
      characterId,
      itemId,
      quantity,
      actorUserId: req.userId!,
      ...(meta !== undefined ? { meta: meta as Record<string, unknown> } : {}),
    });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof inventory.ItemNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof inventory.InventoryFullError) return res.status(409).json({ error: err.message });
    if (err instanceof inventory.CarryWeightExceededError) return res.status(409).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/inventory/remove", requirePermission("inventory.remove"), async (req, res) => {
  const { characterId, itemId, quantity } = req.body ?? {};
  if (typeof characterId !== "number" || !itemId || typeof quantity !== "number") {
    return res.status(400).json({ error: "characterId (number), itemId (string), quantity (number) are required" });
  }
  try {
    await inventory.removeItem({ characterId, itemId, quantity, actorUserId: req.userId! });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof inventory.InsufficientItemsError) return res.status(409).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * Role management is gated behind 'rbac.manage_roles'. Now granted to
 * `admin` (see 012_role_hierarchy.sql) â€” safe because grantRole/revokeRole
 * enforce a rank hierarchy internally (see rbac/admin.ts): an `admin`
 * can hand out `moderator` but not `admin` or `owner`, so this doesn't
 * open a self-escalation path. `owner`'s RBAC bypass can still manage
 * any role regardless.
 */
adminRouter.post("/roles/grant", requirePermission("rbac.manage_roles"), async (req, res) => {
  const { userId, roleName } = req.body ?? {};
  if (typeof userId !== "number" || !roleName) {
    return res.status(400).json({ error: "userId (number) and roleName (string) are required" });
  }
  try {
    await rbacAdmin.grantRole({ userId, roleName, actorUserId: req.userId! });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof rbacAdmin.RoleNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof rbacAdmin.InsufficientRankError) return res.status(403).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/roles/revoke", requirePermission("rbac.manage_roles"), async (req, res) => {
  const { userId, roleName } = req.body ?? {};
  if (typeof userId !== "number" || !roleName) {
    return res.status(400).json({ error: "userId (number) and roleName (string) are required" });
  }
  try {
    await rbacAdmin.revokeRole({ userId, roleName, actorUserId: req.userId! });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof rbacAdmin.RoleNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof rbacAdmin.InsufficientRankError) return res.status(403).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/** Read-only: the full role/permission matrix — what each role can do. */
adminRouter.get("/roles", requirePermission("rbac.manage_roles"), async (_req, res) => {
  const roles = await rbacAdmin.listRolesWithPermissions();
  res.json({ roles });
});

/** Read-only: which roles a specific user holds. */
adminRouter.get("/users/:id/roles", requirePermission("rbac.manage_roles"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "user id must be a positive integer" });
  }
  const roles = await rbacAdmin.listRoles(id);
  res.json({ userId: id, roles });
});

/**
 * Read-only: players currently online (Redis presence). Useful for an
 * admin dashboard or a "who's on" widget — gated on auth.manage since it
 * exposes live player identity.
 */
adminRouter.get("/presence/online", requirePermission("auth.manage"), async (_req, res) => {
  const online = await playerSession.listOnlinePlayers();
  res.json({ online });
});

/**
 * Banning revokes every active session for the user immediately â€” a ban
 * that leaves existing sessions valid until natural JWT expiry isn't a
 * real ban. See modules/users/index.ts and modules/auth/index.ts's
 * sessions table for how revocation actually takes effect.
 */
adminRouter.post("/users/ban", requirePermission("user.ban"), async (req, res) => {
  const { userId, reason } = req.body ?? {};
  if (typeof userId !== "number" || !reason) {
    return res.status(400).json({ error: "userId (number) and reason (string) are required" });
  }
  await users.banUser({ userId, reason, actorUserId: req.userId! });
  res.status(204).end();
});

adminRouter.post("/users/unban", requirePermission("user.ban"), async (req, res) => {
  const { userId } = req.body ?? {};
  if (typeof userId !== "number") {
    return res.status(400).json({ error: "userId (number) is required" });
  }
  await users.unbanUser({ userId, actorUserId: req.userId! });
  res.status(204).end();
});

/**
 * Read-only: lets an admin see a listing's current values before
 * calling upsertListing (which fully overwrites all three price/stock
 * fields â€” there was previously no way to check what you'd be
 * clobbering without querying the DB directly).
 */
adminRouter.get("/shop/listing/:itemId", requirePermission("shop.manage"), async (req, res) => {
  const listing = await shop.getListing(req.params.itemId);
  if (!listing) return res.status(404).json({ error: "this item is not listed in the shop" });
  res.json(listing);
});

/**
 * Upsert = create-or-update. Pass null explicitly for buyPriceCents/
 * sellPriceCents/stock to mean "not purchasable"/"not sellable"/
 * "unlimited" respectively â€” omitting a field is NOT the same as null
 * here, so the client must send the field even to clear it.
 */
adminRouter.post("/shop/listing", requirePermission("shop.manage"), async (req, res) => {
  const { itemId, buyPriceCents, sellPriceCents, stock } = req.body ?? {};
  if (!itemId) return res.status(400).json({ error: "itemId (string) is required" });
  if (buyPriceCents !== undefined && buyPriceCents !== null && typeof buyPriceCents !== "number") {
    return res.status(400).json({ error: "buyPriceCents must be a number or null" });
  }
  if (sellPriceCents !== undefined && sellPriceCents !== null && typeof sellPriceCents !== "number") {
    return res.status(400).json({ error: "sellPriceCents must be a number or null" });
  }
  if (stock !== undefined && stock !== null && typeof stock !== "number") {
    return res.status(400).json({ error: "stock must be a number or null" });
  }

  try {
    await shop.upsertListing({
      itemId,
      buyPriceCents: buyPriceCents ?? null,
      sellPriceCents: sellPriceCents ?? null,
      stock: stock ?? null,
      actorUserId: req.userId!,
    });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof shop.ItemDoesNotExistError) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/shop/listing/remove", requirePermission("shop.manage"), async (req, res) => {
  const { itemId } = req.body ?? {};
  if (!itemId) return res.status(400).json({ error: "itemId (string) is required" });
  await shop.removeListing({ itemId, actorUserId: req.userId! });
  res.status(204).end();
});

/**
 * Manually triggers the trade expiry sweep immediately instead of
 * waiting for the periodic job's next tick â€” mainly useful for ops/
 * testing. The periodic job (see trade/index.ts's startExpiryJob())
 * runs this same function automatically every hour in normal operation.
 */
adminRouter.post("/trades/expire-check", requirePermission("trade.manage"), async (req, res) => {
  const count = await trade.expireOldTrades();
  res.json({ expiredCount: count });
});

/**
 * Manually triggers stale-session cleanup immediately instead of
 * waiting for the periodic job's next tick â€” mainly useful for ops/
 * testing. The periodic job (see auth/index.ts's startSessionCleanupJob())
 * runs this same function automatically every hour in normal operation.
 * Deletes rows only â€” does not affect any currently-valid session.
 */
adminRouter.post("/sessions/cleanup-check", requirePermission("auth.manage"), async (req, res) => {
  const count = await cleanupOldSessions();
  res.json({ cleanedUpCount: count });
});

// ------------------------- Backend foundation routes -------------------------

/**
 * Audit log viewer (audit.view). Read-only. Supports paging via
 * ?limit=..&offset=.. and action filtering via ?action=..
 */
adminRouter.get("/audit", requirePermission("audit.view"), async (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const action = typeof req.query.action === "string" ? req.query.action : null;

  const where = action ? "WHERE action = $1" : "";
  const values: unknown[] = action ? [action] : [];
  values.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT id, actor_user_id, action, target_type, target_id, payload, result, request_id, before, after, reason, created_at
     FROM audit_log ${where} ORDER BY id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  res.json({ entries: rows });
});

// Security center
adminRouter.get("/security/events", requirePermission("security.view"), async (req, res) => {
  const severity = typeof req.query.severity === "string" ? req.query.severity : null;
  const acknowledged =
    req.query.acknowledged === "true" ? true : req.query.acknowledged === "false" ? false : null;
  const events = await security.listSecurityEvents({
    limit: Number(req.query.limit) || 50,
    offset: Number(req.query.offset) || 0,
    severity: severity as any,
    acknowledged,
  });
  res.json({ events });
});

adminRouter.post("/security/events/:id/acknowledge", requirePermission("security.manage"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "event id must be a positive integer" });
  const ok = await security.acknowledgeSecurityEvent({ eventId: id, actorUserId: req.userId!, requestId: requestIdOf(req) });
  if (!ok) return res.status(404).json({ error: "security event not found or already acknowledged" });
  res.status(204).end();
});

// Cases (staff)
adminRouter.get("/cases", requirePermission("case.manage"), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const list = await cases.listAllCases({ status, limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0 });
  res.json({ cases: list });
});

adminRouter.get("/cases/:id", requirePermission("case.manage"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "case id must be a positive integer" });
  const caseRow = await cases.getCaseById(id);
  if (!caseRow) return res.status(404).json({ error: "case not found" });
  const messages = await cases.listCaseMessages(id);
  const events = await cases.listCaseEvents(id);
  res.json({ ...caseRow, messages, events });
});

adminRouter.post("/cases/:id/messages", requirePermission("case.manage"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "case id must be a positive integer" });
  const { body } = req.body ?? {};
  if (typeof body !== "string" || body.trim().length < 1 || body.trim().length > 4000) {
    return res.status(400).json({ error: "body (string, 1-4000 chars) is required" });
  }
  await cases.addCaseMessage({ caseId: id, authorUserId: req.userId!, body: body.trim(), requestId: requestIdOf(req) });
  res.status(204).end();
});

adminRouter.post("/cases/:id/status", requirePermission("case.manage"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "case id must be a positive integer" });
  const { status, note } = req.body ?? {};
  if (typeof status !== "string") return res.status(400).json({ error: "status (string) is required" });
  try {
    await cases.setCaseStatus({
      caseId: id,
      status: status as any,
      actorUserId: req.userId!,
      note: typeof note === "string" ? note : null,
      requestId: requestIdOf(req),
    });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof cases.CaseNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof cases.InvalidCaseStatusError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * Approve a locked-character-field change (character.edit). The request
 * arrives as a staff case; applying the change here resolves the case
 * (see character.applyCharacterLockedChange). Requires `reason` and an
 * optional caseId. Audited with before/after.
 */
adminRouter.post("/character/update", requirePermission("character.edit"), async (req, res) => {
  const { characterId, changes, reason, caseId } = req.body ?? {};
  if (typeof characterId !== "number" || typeof changes !== "object" || changes === null || Array.isArray(changes)) {
    return res.status(400).json({ error: "characterId (number) and changes (object) are required" });
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return res.status(400).json({ error: "reason (string) is required" });
  }
  try {
    await character.applyCharacterLockedChange({
      characterId,
      actorUserId: req.userId!,
      changes,
      reason: reason.trim(),
      caseId:
        typeof caseId === "number"
          ? caseId
          : typeof caseId === "string" && /^\d+$/.test(caseId)
            ? Number(caseId)
            : null,
      requestId: requestIdOf(req),
    });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof character.CharacterFieldConflictError) return res.status(400).json({ error: err.message });
    if (err instanceof character.CharacterNotFoundForUserError) return res.status(404).json({ error: err.message });
    if (err instanceof character.NoCharacterFoundError) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/** Read any character profile (character.view). */
adminRouter.get("/character/:id", requirePermission("character.view"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "character id must be a positive integer" });
  const characterRow = await character.getCharacterById(id);
  if (!characterRow) return res.status(404).json({ error: "character not found" });
  res.json(characterRow);
});

// Economy read (economy.view): multi-currency summary + history.
adminRouter.get("/economy/character/:id", requirePermission("economy.view"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "character id must be a positive integer" });
  const currency = (typeof req.query.currency === "string" ? req.query.currency : null) as economy.Currency | null;
  const summary = await economy.getWalletSummary(id);
  const history = await economy.getHistory(id, { currency, limit: Number(req.query.limit) || 50 });
  res.json({ characterId: id, ...summary, history });
});

// Inventory admin: create a container, list all, view one, manipulate.
adminRouter.post("/inventory/containers", requirePermission("inventory.manage"), async (req, res) => {
  const { storageType, ownerCharacterId, label, capacityWeightG } = req.body ?? {};
  if (typeof storageType !== "string") return res.status(400).json({ error: "storageType (string) is required" });
  if (ownerCharacterId !== undefined && ownerCharacterId !== null && typeof ownerCharacterId !== "number") {
    return res.status(400).json({ error: "ownerCharacterId must be a number or null" });
  }
  try {
    const created = await inventory.createInventory({
      storageType,
      ownerCharacterId: ownerCharacterId ?? null,
      label: typeof label === "string" ? label : null,
      capacityWeightG: typeof capacityWeightG === "number" ? capacityWeightG : undefined,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

adminRouter.get("/inventory/containers", requirePermission("inventory.view"), async (_req, res) => {
  const list = await inventory.listInventories();
  res.json({ inventories: list });
});

adminRouter.get("/inventory/containers/:id", requirePermission("inventory.view"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "container id must be a positive integer" });
  const container = await inventory.getContainerInventory(id);
  if (!container) return res.status(404).json({ error: "container not found" });
  res.json(container);
});

adminRouter.post("/inventory/containers/:id/items", requirePermission("inventory.manage"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "container id must be a positive integer" });
  const { itemId, quantity } = req.body ?? {};
  if (typeof itemId !== "string" || typeof quantity !== "number" || quantity <= 0) {
    return res.status(400).json({ error: "itemId (string) and quantity (positive number) are required" });
  }
  try {
    await inventory.addItemsToContainer({
      containerId: id,
      itemId,
      quantity,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof inventory.ContainerNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof inventory.ItemNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof inventory.ContainerCapacityExceededError) return res.status(409).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/inventory/containers/:id/items/remove", requirePermission("inventory.manage"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "container id must be a positive integer" });
  const { itemId, quantity } = req.body ?? {};
  if (typeof itemId !== "string" || typeof quantity !== "number" || quantity <= 0) {
    return res.status(400).json({ error: "itemId (string) and quantity (positive number) are required" });
  }
  try {
    await inventory.removeItemsFromContainer({
      containerId: id,
      itemId,
      quantity,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof inventory.ContainerNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof inventory.InsufficientItemsError) return res.status(409).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

adminRouter.delete("/inventory/containers/:id", requirePermission("inventory.manage"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "container id must be a positive integer" });
  try {
    await inventory.deleteInventory({ containerId: id, actorUserId: req.userId!, requestId: requestIdOf(req) });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof inventory.ContainerNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof inventory.ContainerNotEmptyError) return res.status(409).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

