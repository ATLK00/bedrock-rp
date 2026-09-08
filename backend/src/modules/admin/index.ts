import { Router } from "express";
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

/**
 * Admin HTTP routes. Every route:
 *   1. requires a specific permission (RBAC),
 *   2. delegates to the owning module (economy/character), which itself audits.
 * Do not put business logic here â€” this file is routing + authorization only.
 */
export const adminRouter = Router();

adminRouter.use((req, res, next) => {
  if (typeof req.userId !== "number") {
    return res.status(401).json({ error: "unauthenticated" });
  }
  next();
});

adminRouter.post("/economy/grant", requirePermission("economy.grant"), async (req, res) => {
  const { characterId, amountCents, reason } = req.body ?? {};
  if (!characterId || !amountCents || !reason) {
    return res.status(400).json({ error: "characterId, amountCents, reason are required" });
  }
  try {
    await economy.grant({ characterId, amountCents, reason, actorUserId: req.userId! });
    res.status(204).end();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Claw money back from a character (anti-negative enforced inside
 * economy.deduct). Gated on the same permission as grant — minting and
 * clawback are two sides of one economy superpower.
 */
adminRouter.post("/economy/deduct", requirePermission("economy.grant"), async (req, res) => {
  const { characterId, amountCents, reason } = req.body ?? {};
  if (typeof characterId !== "number" || typeof amountCents !== "number" || !reason) {
    return res.status(400).json({ error: "characterId (number), amountCents (number), reason are required" });
  }
  try {
    await economy.deduct({ characterId, amountCents, reason, actorUserId: req.userId! });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof economy.InsufficientFundsError) return res.status(409).json({ error: err.message });
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

