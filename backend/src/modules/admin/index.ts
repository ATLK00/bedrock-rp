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
import * as vehicleAdmin from "../vehicle/index.js";
import * as propertyAdmin from "../property/index.js";
import * as policeAdmin from "../police/index.js";
import * as emsAdmin from "../ems/index.js";
import * as phoneAdmin from "../phone/index.js";

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
 * Read-only: paged user directory for staff (player management). Search
 * matches discord_tag / discord_id / character name. Includes each user's
 * roles and their (single) character reference in one pass.
 */
adminRouter.get("/users", requirePermission("auth.manage"), async (req, res) => {
  const query = typeof req.query.query === "string" ? req.query.query.trim() : null;
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const { rows } = await pool.query(
    `SELECT
       u.id, u.discord_id, u.discord_tag, u.is_banned, u.ban_reason,
       u.created_at, u.last_login_at,
       COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles,
       c.id AS character_id, c.name AS character_name,
       c.persistent_id IS NOT NULL AS linked,
       c.is_deleted AS character_deleted
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     LEFT JOIN characters c ON c.user_id = u.id
     WHERE ($1::text IS NULL OR u.discord_tag ILIKE '%' || $1 || '%'
        OR u.discord_id ILIKE '%' || $1 || '%' OR c.name ILIKE '%' || $1 || '%')
     GROUP BY u.id, c.id
     ORDER BY u.id DESC
     LIMIT $2 OFFSET $3`,
    [query, limit, offset]
  );
  res.json({ users: rows });
});

/**
 * Read-only: paged character directory for staff. Search matches character
 * name / linked Discord tag / persistentId.
 */
adminRouter.get("/characters", requirePermission("character.view"), async (req, res) => {
  const query = typeof req.query.query === "string" ? req.query.query.trim() : null;
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const { rows } = await pool.query(
    `SELECT c.id, c.user_id, c.name, c.whitelisted, c.persistent_id,
       c.created_at, c.last_seen_at, c.is_deleted, u.discord_tag
     FROM characters c
     JOIN users u ON u.id = c.user_id
     WHERE ($1::text IS NULL OR c.name ILIKE '%' || $1 || '%'
        OR u.discord_tag ILIKE '%' || $1 || '%' OR c.persistent_id ILIKE '%' || $1 || '%')
     ORDER BY c.id DESC
     LIMIT $2 OFFSET $3`,
    [query, limit, offset]
  );
  res.json({ characters: rows });
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

// ---------------------------------------------------------------------------
// Vehicles — create, grant, seize, delete, override state, list/details.
// All routes delegate to the vehicle module (which audits every transition).
// ---------------------------------------------------------------------------

function vehicleAdminError(res: any, err: any) {
  if (err instanceof vehicleAdmin.VehicleNotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof vehicleAdmin.VehicleGarageFullError) return res.status(409).json({ error: err.message });
  if (err instanceof vehicleAdmin.VehicleInUseError) return res.status(409).json({ error: err.message });
  if (err instanceof inventory.InventoryFullError || err instanceof inventory.CarryWeightExceededError) {
    return res.status(409).json({ error: "owner doesn't have room in their carry for the key item" });
  }
  return res.status(500).json({ error: err.message });
}

async function parseVehicleIdOr400(req: any, res: any): Promise<number | null> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "vehicle id must be a positive integer" });
    return null;
  }
  return id;
}

adminRouter.get("/vehicles", requirePermission("vehicle.view"), async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const forSale = req.query.forSale !== undefined;
    const vehicles = await vehicleAdmin.listVehicles({
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
      offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
      status,
      forSale,
    });
    res.json({ vehicles });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get("/vehicles/:id", requirePermission("vehicle.view"), async (req, res) => {
  const id = await parseVehicleIdOr400(req, res);
  if (!id) return;
  const vehicleRow = await vehicleAdmin.getVehicle(id);
  if (!vehicleRow) return res.status(404).json({ error: "vehicle not found" });
  const trunk = vehicleRow.trunkInventoryId != null ? await inventory.getContainerInventory(vehicleRow.trunkInventoryId) : null;
  res.json({ vehicle: vehicleRow, trunk });
});

adminRouter.post("/vehicles", requirePermission("vehicle.manage"), async (req, res) => {
  const { entityType, ownerCharacterId, salePriceCents, saleCurrency, locked } = req.body ?? {};
  const ownerId = ownerCharacterId == null ? null : Number(ownerCharacterId);
  if (ownerId !== null && (!Number.isInteger(ownerId) || ownerId <= 0)) {
    return res.status(400).json({ error: "ownerCharacterId must be a positive integer or null" });
  }
  try {
    const view = await vehicleAdmin.createVehicle({
      entityType: typeof entityType === "string" ? entityType : undefined,
      ownerCharacterId: ownerId,
      salePriceCents: typeof salePriceCents === "number" ? salePriceCents : null,
      saleCurrency: typeof saleCurrency === "string" ? saleCurrency : undefined,
      locked: typeof locked === "boolean" ? locked : undefined,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.status(201).json({ vehicle: view });
  } catch (err: any) {
    vehicleAdminError(res, err);
  }
});

adminRouter.post("/vehicles/:id/grant", requirePermission("vehicle.manage"), async (req, res) => {
  const id = await parseVehicleIdOr400(req, res);
  if (!id) return;
  const ownerId = Number((req.body ?? {}).ownerCharacterId);
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    return res.status(400).json({ error: "ownerCharacterId (positive integer) is required" });
  }
  try {
    const view = await vehicleAdmin.grantVehicle({ vehicleId: id, ownerCharacterId: ownerId, actorUserId: req.userId!, requestId: requestIdOf(req) });
    res.json({ vehicle: view });
  } catch (err: any) {
    vehicleAdminError(res, err);
  }
});

adminRouter.post("/vehicles/:id/seize", requirePermission("vehicle.manage"), async (req, res) => {
  const id = await parseVehicleIdOr400(req, res);
  if (!id) return;
  try {
    const view = await vehicleAdmin.seizeVehicle({ vehicleId: id, actorUserId: req.userId!, requestId: requestIdOf(req) });
    res.json({ vehicle: view });
  } catch (err: any) {
    vehicleAdminError(res, err);
  }
});

adminRouter.post("/vehicles/:id/repair", requirePermission("vehicle.manage"), async (req, res) => {
  const id = await parseVehicleIdOr400(req, res);
  if (!id) return;
  try {
    const view = await vehicleAdmin.overrideVehicleState({
      vehicleId: id,
      engineHealth: 100,
      suspensionHealth: 100,
      bodyDamage: 0,
      fuelLevel: 100,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ vehicle: view });
  } catch (err: any) {
    vehicleAdminError(res, err);
  }
});

adminRouter.post("/vehicles/:id/maintenance", requirePermission("vehicle.manage"), async (req, res) => {
  const id = await parseVehicleIdOr400(req, res);
  if (!id) return;
  const { fuelLevel, engineHealth, suspensionHealth, bodyDamage, locked } = req.body ?? {};
  try {
    const view = await vehicleAdmin.overrideVehicleState({
      vehicleId: id,
      fuelLevel: typeof fuelLevel === "number" ? fuelLevel : undefined,
      engineHealth: typeof engineHealth === "number" ? engineHealth : undefined,
      suspensionHealth: typeof suspensionHealth === "number" ? suspensionHealth : undefined,
      bodyDamage: typeof bodyDamage === "number" ? bodyDamage : undefined,
      locked: typeof locked === "boolean" ? locked : undefined,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ vehicle: view });
  } catch (err: any) {
    vehicleAdminError(res, err);
  }
});

adminRouter.delete("/vehicles/:id", requirePermission("vehicle.manage"), async (req, res) => {
  const id = await parseVehicleIdOr400(req, res);
  if (!id) return;
  try {
    await vehicleAdmin.deleteVehicle({ vehicleId: id, actorUserId: req.userId!, requestId: requestIdOf(req) });
    res.status(204).end();
  } catch (err: any) {
    vehicleAdminError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Properties — create, grant, seize, delete, set for sale, list/details.
// Mirrors the vehicle admin surface; delegates to the property module (which
// audits every transition and issues/revokes deeds).
// ---------------------------------------------------------------------------

function propertyAdminError(res: any, err: any) {
  if (err instanceof propertyAdmin.PropertyNotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof propertyAdmin.PropertyInUseError) return res.status(409).json({ error: err.message });
  if (err instanceof inventory.InventoryFullError || err instanceof inventory.CarryWeightExceededError) {
    return res.status(409).json({ error: "owner doesn't have room in their carry for the deed key item" });
  }
  return res.status(500).json({ error: err.message });
}

async function parsePropertyIdOr400(req: any, res: any): Promise<number | null> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "property id must be a positive integer" });
    return null;
  }
  return id;
}

adminRouter.get("/properties", requirePermission("property.view"), async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const forSale = req.query.forSale !== undefined;
    const properties = await propertyAdmin.listProperties({
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
      offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
      status,
      forSale,
    });
    res.json({ properties });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get("/properties/:id", requirePermission("property.view"), async (req, res) => {
  const id = await parsePropertyIdOr400(req, res);
  if (!id) return;
  const propertyRow = await propertyAdmin.getProperty(id);
  if (!propertyRow) return res.status(404).json({ error: "property not found" });
  const storage = propertyRow.storageInventoryId != null ? await inventory.getContainerInventory(propertyRow.storageInventoryId) : null;
  res.json({ property: propertyRow, storage });
});

adminRouter.post("/properties", requirePermission("property.manage"), async (req, res) => {
  const { propertyType, address, ownerCharacterId, garageCapacity, salePriceCents, saleCurrency, locked } = req.body ?? {};
  const ownerId = ownerCharacterId == null ? null : Number(ownerCharacterId);
  if (ownerId !== null && (!Number.isInteger(ownerId) || ownerId <= 0)) {
    return res.status(400).json({ error: "ownerCharacterId must be a positive integer or null" });
  }
  if (typeof address !== "string" || address.trim() === "") {
    return res.status(400).json({ error: "address is required" });
  }
  try {
    const view = await propertyAdmin.createProperty({
      propertyType: typeof propertyType === "string" ? propertyType : undefined,
      address,
      ownerCharacterId: ownerId,
      garageCapacity: typeof garageCapacity === "number" ? garageCapacity : undefined,
      salePriceCents: typeof salePriceCents === "number" ? salePriceCents : null,
      saleCurrency: typeof saleCurrency === "string" ? saleCurrency : undefined,
      locked: typeof locked === "boolean" ? locked : undefined,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.status(201).json({ property: view });
  } catch (err: any) {
    propertyAdminError(res, err);
  }
});

adminRouter.post("/properties/:id/grant", requirePermission("property.manage"), async (req, res) => {
  const id = await parsePropertyIdOr400(req, res);
  if (!id) return;
  const ownerId = Number((req.body ?? {}).ownerCharacterId);
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    return res.status(400).json({ error: "ownerCharacterId (positive integer) is required" });
  }
  try {
    const view = await propertyAdmin.grantProperty({ propertyId: id, ownerCharacterId: ownerId, actorUserId: req.userId!, requestId: requestIdOf(req) });
    res.json({ property: view });
  } catch (err: any) {
    propertyAdminError(res, err);
  }
});

adminRouter.post("/properties/:id/seize", requirePermission("property.manage"), async (req, res) => {
  const id = await parsePropertyIdOr400(req, res);
  if (!id) return;
  try {
    const view = await propertyAdmin.seizeProperty({ propertyId: id, actorUserId: req.userId!, requestId: requestIdOf(req) });
    res.json({ property: view });
  } catch (err: any) {
    propertyAdminError(res, err);
  }
});

adminRouter.post("/properties/:id/sell", requirePermission("property.manage"), async (req, res) => {
  const id = await parsePropertyIdOr400(req, res);
  if (!id) return;
  const { priceCents, currency } = req.body ?? {};
  if (priceCents !== undefined && priceCents !== null && (typeof priceCents !== "number" || !Number.isSafeInteger(priceCents) || priceCents <= 0)) {
    return res.status(400).json({ error: "priceCents must be a positive integer or omitted to unlist" });
  }
  try {
    const view = await propertyAdmin.setSaleListing({
      propertyId: id,
      characterId: Number((req.body ?? {}).ownerCharacterId) || 0,
      priceCents: typeof priceCents === "number" ? priceCents : null,
      currency: currency === "cash" || currency === "bank" || currency === "red_money" ? currency : undefined,
      isStaff: true,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ property: view });
  } catch (err: any) {
    propertyAdminError(res, err);
  }
});

adminRouter.delete("/properties/:id", requirePermission("property.manage"), async (req, res) => {
  const id = await parsePropertyIdOr400(req, res);
  if (!id) return;
  try {
    await propertyAdmin.deleteProperty({ propertyId: id, actorUserId: req.userId!, requestId: requestIdOf(req) });
    res.status(204).end();
  } catch (err: any) {
    propertyAdminError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Police — MDT (citizen/vehicle records), fines, warrants, reports, licenses,
// arrests. Mirrors the bridge police surface; delegates to the police module
// (which audits everything). Ranking: police.view read, police.manage write,
// police.admin senior actions (warrant revoke, early release).
// ---------------------------------------------------------------------------

function policeAdminError(res: any, err: any) {
  const e = err as any;
  if (
    e instanceof policeAdmin.CitizenNotFoundError ||
    e instanceof policeAdmin.VehicleNotFoundError ||
    e instanceof policeAdmin.LicenseNotFoundError ||
    e instanceof policeAdmin.FineNotFoundError ||
    e instanceof policeAdmin.ReportNotFoundError ||
    e instanceof policeAdmin.WarrantNotFoundError ||
    e instanceof policeAdmin.ArrestNotFoundError
  ) {
    return res.status(404).json({ error: e.message });
  }
  if (
    e instanceof policeAdmin.FineAccessDeniedError ||
    e instanceof policeAdmin.LicenseExistsError ||
    e instanceof policeAdmin.FineAlreadyPaidError ||
    e instanceof policeAdmin.WarrantNotActiveError ||
    e instanceof policeAdmin.CharacterAlreadyInJailError ||
    e instanceof policeAdmin.ArrestNotActiveError ||
    e instanceof economy.InsufficientFundsError
  ) {
    return res.status(409).json({ error: e.message });
  }
  return res.status(500).json({ error: e.message });
}

async function parsePoliceIdOr400(req: any, res: any): Promise<number | null> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "police id must be a positive integer" });
    return null;
  }
  return id;
}

async function parseCharacterIdOr400(req: any, res: any): Promise<number | null> {
  const id = Number(req.body.characterId ?? req.body.targetCharacterId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "characterId must be a positive integer" });
    return null;
  }
  return id;
}

adminRouter.get("/police/citizens", requirePermission("police.view"), async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const query = typeof req.query.query === "string" ? req.query.query : undefined;
    const citizens = await policeAdmin.listCitizens({
      query,
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
      offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
    });
    res.json({ citizens });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get("/police/citizens/:id", requirePermission("police.view"), async (req, res) => {
  const id = await parsePoliceIdOr400(req, res);
  if (!id) return;
  try {
    const citizen = await policeAdmin.getCitizenMdt(id);
    if (!citizen) return res.status(404).json({ error: "citizen not found" });
    res.json({ citizen });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get("/police/vehicles", requirePermission("police.view"), async (req, res) => {
  try {
    const plate = typeof req.query.plate === "string" ? req.query.plate.trim().toUpperCase() : "";
    if (plate.length === 0) return res.json({ vehicles: [] });
    const vehicleRow = await policeAdmin.lookupVehicle(plate);
    res.json({ vehicles: vehicleRow ? [vehicleRow] : [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/police/licenses", requirePermission("police.manage"), async (req, res) => {
  const { licenseType, action, notes } = req.body ?? {};
  const characterId = await parseCharacterIdOr400(req, res);
  if (!characterId) return;
  if (typeof licenseType !== "string" || !policeAdmin.VALID_LICENSE_TYPES.has(licenseType)) {
    return res.status(400).json({ error: "licenseType must be one of: driving, weapon, business, fishing, aviation" });
  }
  if (!["issue", "suspend", "revoke"].includes(String(action ?? ""))) {
    return res.status(400).json({ error: "action must be issue, suspend or revoke" });
  }
  try {
    const license = await policeAdmin.setLicense({
      characterId,
      licenseType,
      action: String(action) as "issue" | "suspend" | "revoke",
      notes: notes == null ? null : String(notes),
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ license });
  } catch (err: any) {
    policeAdminError(res, err);
  }
});

adminRouter.get("/police/fines", requirePermission("police.view"), async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const fines = await policeAdmin.listFines({
      status,
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
      offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
    });
    res.json({ fines });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/police/fines", requirePermission("police.manage"), async (req, res) => {
  const { amountCents, currency, reason } = req.body ?? {};
  const characterId = await parseCharacterIdOr400(req, res);
  if (!characterId) return;
  const cents = Number(amountCents);
  if (!Number.isSafeInteger(cents) || cents <= 0) return res.status(400).json({ error: "amountCents must be a positive integer" });
  const cur = currency === undefined || currency === null ? "cash" : String(currency);
  if (!policeAdmin.VALID_CURRENCIES.has(cur as economy.Currency)) {
    return res.status(400).json({ error: "currency must be cash, bank or red_money" });
  }
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 1000) {
    return res.status(400).json({ error: "reason (1-1000 chars) is required" });
  }
  try {
    const fine = await policeAdmin.issueFine({
      targetCharacterId: characterId,
      officerCharacterId: null,
      amountCents: cents,
      currency: cur as economy.Currency,
      reason: reason.trim(),
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ fine });
  } catch (err: any) {
    policeAdminError(res, err);
  }
});

/** Pay a specific outstanding fine on the citizen's behalf. */
adminRouter.post("/police/fines/:id/pay", requirePermission("police.manage"), async (req, res) => {
  const id = await parsePoliceIdOr400(req, res);
  if (!id) return;
  try {
    const fine = await policeAdmin.getFine(id);
    if (!fine || fine.status !== "outstanding") return res.status(404).json({ error: "outstanding fine not found" });
    const paid = await policeAdmin.payFine({
      fineId: id,
      characterId: fine.targetCharacterId,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ fine: paid });
  } catch (err: any) {
    policeAdminError(res, err);
  }
});

adminRouter.get("/police/warrants", requirePermission("police.view"), async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const warrants = await policeAdmin.listWarrants({
      status,
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
      offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
    });
    res.json({ warrants });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/police/warrants", requirePermission("police.manage"), async (req, res) => {
  const { warrantType, reason, minutes } = req.body ?? {};
  const characterId = await parseCharacterIdOr400(req, res);
  if (!characterId) return;
  if (typeof warrantType !== "string" || !policeAdmin.VALID_WARRANT_TYPES.has(warrantType)) {
    return res.status(400).json({ error: "warrantType must be arrest or search" });
  }
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 1000) {
    return res.status(400).json({ error: "reason (1-1000 chars) is required" });
  }
  const m = minutes == null ? 0 : Number(minutes);
  if (!Number.isSafeInteger(m) || m < 0 || m > 10080) return res.status(400).json({ error: "minutes must be 0-10080 (0 = no expiry)" });
  try {
    const warrant = await policeAdmin.issueWarrant({
      targetCharacterId: characterId,
      warrantType,
      reason: reason.trim(),
      officerCharacterId: null,
      expiresAt: m > 0 ? new Date(Date.now() + m * 60_000) : null,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ warrant });
  } catch (err: any) {
    policeAdminError(res, err);
  }
});

adminRouter.post("/police/warrants/:id/revoke", requirePermission("police.admin"), async (req, res) => {
  const id = await parsePoliceIdOr400(req, res);
  if (!id) return;
  try {
    const warrant = await policeAdmin.revokeWarrant({ warrantId: id, actorUserId: req.userId!, requestId: requestIdOf(req) });
    res.json({ warrant });
  } catch (err: any) {
    policeAdminError(res, err);
  }
});

adminRouter.get("/police/reports", requirePermission("police.view"), async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const reports = await policeAdmin.listReports({
      status,
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
      offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
    });
    res.json({ reports });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/police/reports", requirePermission("police.manage"), async (req, res) => {
  const { title, body, classification } = req.body ?? {};
  if (typeof title !== "string" || title.trim().length === 0 || title.length > 200) {
    return res.status(400).json({ error: "title (1-200 chars) is required" });
  }
  if (typeof body !== "string" || body.trim().length === 0 || body.length > 10000) {
    return res.status(400).json({ error: "body (1-10000 chars) is required" });
  }
  if (classification != null && !["general", "restricted", "classified"].includes(String(classification))) {
    return res.status(400).json({ error: "classification must be general, restricted or classified" });
  }
  try {
    const report = await policeAdmin.createReport({
      officerCharacterId: null,
      title: title.trim(),
      body: body.trim(),
      classification: classification == null ? "general" : String(classification),
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ report });
  } catch (err: any) {
    policeAdminError(res, err);
  }
});

adminRouter.post("/police/reports/:id/close", requirePermission("police.manage"), async (req, res) => {
  const id = await parsePoliceIdOr400(req, res);
  if (!id) return;
  try {
    const report = await policeAdmin.closeReport({ reportId: id, actorUserId: req.userId!, requestId: requestIdOf(req) });
    res.json({ report });
  } catch (err: any) {
    policeAdminError(res, err);
  }
});

adminRouter.get("/police/arrests", requirePermission("police.view"), async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const arrests = await policeAdmin.listArrests({
      status,
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
      offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
    });
    res.json({ arrests });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/police/arrests", requirePermission("police.manage"), async (req, res) => {
  const { reason, minutes } = req.body ?? {};
  const characterId = await parseCharacterIdOr400(req, res);
  if (!characterId) return;
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 1000) {
    return res.status(400).json({ error: "reason (1-1000 chars) is required" });
  }
  const m = minutes == null ? 120 : Math.round(Number(minutes));
  if (!Number.isSafeInteger(m) || m < policeAdmin.MIN_ARREST_MINUTES || m > policeAdmin.MAX_ARREST_MINUTES) {
    return res.status(400).json({ error: `minutes must be between ${policeAdmin.MIN_ARREST_MINUTES} and ${policeAdmin.MAX_ARREST_MINUTES}` });
  }
  try {
    const arrest = await policeAdmin.arrestCharacter({
      characterId,
      officerCharacterId: null,
      reason: reason.trim(),
      minutes: m,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ arrest });
  } catch (err: any) {
    policeAdminError(res, err);
  }
});

/** Early release of a jailed citizen (senior staff). */
adminRouter.post("/police/release", requirePermission("police.admin"), async (req, res) => {
  const characterId = await parseCharacterIdOr400(req, res);
  if (!characterId) return;
  try {
    const arrest = await policeAdmin.releaseArrest({
      characterId,
      releasedByCharacterId: null,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ arrest });
  } catch (err: any) {
    policeAdminError(res, err);
  }
});

/** Update a citizen's police record (alias / threat level / notes). */
adminRouter.post("/police/records", requirePermission("police.manage"), async (req, res) => {
  const { alias, threatLevel, notes } = req.body ?? {};
  const characterId = await parseCharacterIdOr400(req, res);
  if (!characterId) return;
  if (threatLevel != null && !policeAdmin.VALID_THREAT_LEVELS.has(String(threatLevel))) {
    return res.status(400).json({ error: "threatLevel must be none, low, medium, high or critical" });
  }
  try {
    const record = await policeAdmin.upsertRecord({
      characterId,
      alias: alias == null ? null : String(alias),
      threatLevel: threatLevel == null ? null : String(threatLevel),
      notes: notes == null ? null : String(notes),
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ record });
  } catch (err: any) {
    policeAdminError(res, err);
  }
});

// ===========================================================================
// EMS / Medical (web admin surface). Ranking mirrors the bridge:
// ems.view read, ems.manage write, ems.admin senior actions (waive/reset).
// ===========================================================================

function emsAdminError(res: any, err: any) {
  const e = err as any;
  if (e instanceof emsAdmin.MedicalRecordNotFoundError || e instanceof emsAdmin.BillNotFoundError) {
    return res.status(404).json({ error: e.message });
  }
  if (
    e instanceof emsAdmin.BillAccessDeniedError ||
    e instanceof emsAdmin.BillAlreadyPaidError ||
    e instanceof emsAdmin.StateTransitionError ||
    e instanceof economy.InsufficientFundsError
  ) {
    return res.status(409).json({ error: e.message });
  }
  return res.status(500).json({ error: e.message });
}

async function parseEmsIdOr400(req: any, res: any): Promise<number | null> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "medical id must be a positive integer" });
    return null;
  }
  return id;
}

adminRouter.get("/ems/records", requirePermission("ems.view"), async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const query = typeof req.query.query === "string" ? req.query.query : undefined;
    const records = await emsAdmin.listMedicalRecords({
      query,
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
      offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
    });
    res.json({ records });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get("/ems/records/:id", requirePermission("ems.view"), async (req, res) => {
  const id = await parseEmsIdOr400(req, res);
  if (!id) return;
  try {
    const record = await emsAdmin.getMedical(id, { actorUserId: req.userId!, requestId: requestIdOf(req) });
    res.json({ record });
  } catch (err: any) {
    emsAdminError(res, err);
  }
});

adminRouter.get("/ems/bills", requirePermission("ems.view"), async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const bills = await emsAdmin.listBills({
      status,
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
      offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
    });
    res.json({ bills });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get("/ems/bills/:id", requirePermission("ems.view"), async (req, res) => {
  const id = await parseEmsIdOr400(req, res);
  if (!id) return;
  try {
    const bill = await emsAdmin.getBill(id);
    res.json({ bill });
  } catch (err: any) {
    emsAdminError(res, err);
  }
});

/** Pay a specific outstanding medical bill on the citizen's behalf. */
adminRouter.post("/ems/bills/:id/pay", requirePermission("ems.manage"), async (req, res) => {
  const id = await parseEmsIdOr400(req, res);
  if (!id) return;
  try {
    const bill = await emsAdmin.getBill(id);
    if (!bill || bill.status !== "unpaid") return res.status(404).json({ error: "unpaid medical bill not found" });
    const paid = await emsAdmin.payBill({
      billId: id,
      characterId: bill.patientId,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ bill: paid });
  } catch (err: any) {
    emsAdminError(res, err);
  }
});

/** Waive a bill entirely (senior admin; no money moves). */
adminRouter.post("/ems/bills/:id/waive", requirePermission("ems.admin"), async (req, res) => {
  const id = await parseEmsIdOr400(req, res);
  if (!id) return;
  try {
    const bill = await emsAdmin.waiveBill({
      billId: id,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ bill });
  } catch (err: any) {
    emsAdminError(res, err);
  }
});

/** Force a citizen back to healthy (medical emergency triage). */
adminRouter.post("/ems/reset", requirePermission("ems.admin"), async (req, res) => {
  const characterId = await parseCharacterIdOr400(req, res);
  if (!characterId) return;
  try {
    const medical = await emsAdmin.adminReset({ characterId, actorUserId: req.userId!, requestId: requestIdOf(req) });
    res.json({ medical });
  } catch (err: any) {
    emsAdminError(res, err);
  }
});

// ===========================================================================
// Phone (web admin + operations). Read = phone.view, write = phone.manage,
// taxi board ops phone.taxi.manage, emergency dispatch phone.emergency.manage.
// ===========================================================================

adminRouter.get("/phone/numbers", requirePermission("phone.view"), async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const query = typeof req.query.query === "string" ? req.query.query : undefined;
    const { rows } = await pool.query(
      `SELECT pn.character_id AS "characterId", c.name AS "characterName", pn.number, pn.created_at AS "createdAt"
       FROM phone_numbers pn JOIN characters c ON c.id = pn.character_id
       WHERE ($1::text IS NULL OR c.name ILIKE '%' || $1 || '%' OR pn.number ILIKE '%' || $1 || '%')
       ORDER BY pn.character_id DESC LIMIT $2 OFFSET $3`,
      [query ?? null, Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50, Number.isFinite(offset) ? Math.max(0, offset) : 0]
    );
    res.json({ numbers: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get("/phone/emergency", requirePermission("phone.emergency.view"), async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = Number(req.query.limit ?? 50);
    const calls = await phoneAdmin.listEmergencyCallsForAdmin({
      status,
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
    });
    res.json({ calls });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/phone/emergency/:id/close", requirePermission("phone.emergency.manage"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "emergency call id must be a positive integer" });
  const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : null;
  try {
    const call = await phoneAdmin.closeEmergencyCall({
      callId: id,
      responderCharacterId: null,
      note,
      actorUserId: req.userId!,
      requestId: requestIdOf(req),
    });
    res.json({ call });
  } catch (err: any) {
    const e = err as any;
    if (e instanceof phoneAdmin.EmergencyCallNotFoundError) return res.status(404).json({ error: e.message });
    if (e instanceof phoneAdmin.EmergencyNotActionableError) return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

adminRouter.get("/phone/taxi", requirePermission("phone.taxi.manage"), async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = Number(req.query.limit ?? 50);
    const requests = await phoneAdmin.listTaxiRequests(Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50, status);
    res.json({ requests });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

