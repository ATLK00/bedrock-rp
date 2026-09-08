import { Router } from "express";
import { pool } from "../../db/pool.js";
import * as inventory from "./index.js";
import { requirePermission } from "../../rbac/index.js";

/**
 * Player-facing container routes. A user acts on their OWN containers
 * (created by staff/ops, or the owner of the storage). Staff access to
 * any container goes through the admin routes (inventory.manage /
 * inventory.view). Container creation and deletion are staff-only —
 * players can add/remove/transfer in containers they own.
 */
export const inventoryRouter = Router();

function requireUserId(req: any, res: any): number | null {
  const userId = req.userId as number | undefined;
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
  return userId;
}

async function ownCharacterId(userId: number): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT id FROM characters WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  return rows.length > 0 ? rows[0].id : null;
}

function applyContainerErrors(res: any, err: any) {
  if (err instanceof inventory.ContainerNotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof inventory.ItemNotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof inventory.InsufficientItemsError) return res.status(409).json({ error: err.message });
  if (err instanceof inventory.ContainerCapacityExceededError) return res.status(409).json({ error: err.message });
  if (err instanceof inventory.CarryWeightExceededError) return res.status(409).json({ error: err.message });
  if (err instanceof inventory.InventoryFullError) return res.status(409).json({ error: err.message });
  res.status(500).json({ error: err.message });
}

/** GET /inventories — the user's own containers. */
inventoryRouter.get("/", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;
  const characterId = await ownCharacterId(userId);
  if (!characterId) return res.status(404).json({ error: "no character found for this user" });
  const list = await inventory.listInventories({ ownerCharacterId: characterId });
  res.json({ inventories: list });
});

/** GET /inventories/:id — a container's content (own containers only). */
inventoryRouter.get("/:id", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "container id must be a positive integer" });

  const characterId = await ownCharacterId(userId);
  if (!characterId) return res.status(404).json({ error: "no character found for this user" });
  const container = await inventory.getContainerInventory(id);
  if (!container) return res.status(404).json({ error: "container not found" });
  if (container.owner_character_id !== null && Number(container.owner_character_id) !== Number(characterId)) {
    return res.status(403).json({ error: "you can only access your own containers" });
  }
  res.json(container);
});

/** POST /inventories/:id/items — put an item from the character's own slots into their container. */
inventoryRouter.post("/:id/items", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "container id must be a positive integer" });
  const { itemId, quantity } = (req.body ?? {}) as { itemId?: unknown; quantity?: unknown };
  if (typeof itemId !== "string" || typeof quantity !== "number" || quantity <= 0 || !Number.isInteger(quantity)) {
    return res.status(400).json({ error: "itemId (string) and quantity (positive integer) are required" });
  }

  const characterId = await ownCharacterId(userId);
  if (!characterId) return res.status(404).json({ error: "no character found for this user" });
  const container = await inventory.getContainerInventory(id);
  if (!container) return res.status(404).json({ error: "container not found" });
  if (container.owner_character_id !== null && Number(container.owner_character_id) !== Number(characterId)) {
    return res.status(403).json({ error: "you can only access your own containers" });
  }

  try {
    await inventory.transferCharacterToContainer({
      characterId,
      containerId: id,
      itemId,
      quantity,
      actorUserId: userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    res.status(204).end();
  } catch (err: any) {
    applyContainerErrors(res, err);
  }
});

/** POST /inventories/:id/take — take an item from the user's container into their own slots. */
inventoryRouter.post("/:id/take", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "container id must be a positive integer" });
  const { itemId, quantity } = (req.body ?? {}) as { itemId?: unknown; quantity?: unknown };
  if (typeof itemId !== "string" || typeof quantity !== "number" || quantity <= 0 || !Number.isInteger(quantity)) {
    return res.status(400).json({ error: "itemId (string) and quantity (positive integer) are required" });
  }

  const characterId = await ownCharacterId(userId);
  if (!characterId) return res.status(404).json({ error: "no character found for this user" });
  const container = await inventory.getContainerInventory(id);
  if (!container) return res.status(404).json({ error: "container not found" });
  if (container.owner_character_id !== null && Number(container.owner_character_id) !== Number(characterId)) {
    return res.status(403).json({ error: "you can only access your own containers" });
  }

  try {
    await inventory.transferContainerToCharacter({
      containerId: id,
      characterId,
      itemId,
      quantity,
      actorUserId: userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    res.status(204).end();
  } catch (err: any) {
    applyContainerErrors(res, err);
  }
});

/**
 * Staff: create a container. Routed at /inventories for path symmetry but
 * gated on inventory.manage (players do not self-provision containers).
 */
inventoryRouter.post("/", requirePermission("inventory.manage"), async (req, res) => {
  const { storageType, ownerCharacterId, label, capacityWeightG } = (req.body ?? {}) as {
    storageType?: unknown;
    ownerCharacterId?: unknown;
    label?: unknown;
    capacityWeightG?: unknown;
  };
  if (typeof storageType !== "string") {
    return res.status(400).json({ error: "storageType (string) is required" });
  }
  if (ownerCharacterId !== undefined && ownerCharacterId !== null && typeof ownerCharacterId !== "number") {
    return res.status(400).json({ error: "ownerCharacterId must be a number or null" });
  }
  if (label !== undefined && label !== null && typeof label !== "string") {
    return res.status(400).json({ error: "label must be a string or null" });
  }
  if (capacityWeightG !== undefined && capacityWeightG !== null && typeof capacityWeightG !== "number") {
    return res.status(400).json({ error: "capacityWeightG must be a number or null" });
  }

  try {
    const created = await inventory.createInventory({
      storageType,
      ownerCharacterId: ownerCharacterId ?? null,
      label: label ?? null,
      capacityWeightG: capacityWeightG ?? undefined,
      actorUserId: req.userId!,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** Staff: list all containers (inventory.view). */
inventoryRouter.get("/admin/all", requirePermission("inventory.view"), async (_req, res) => {
  const list = await inventory.listInventories();
  res.json({ inventories: list });
});