import { withTransaction, pool } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";
import { publish } from "../../eventbus/index.js";

export class ItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`item not found: ${itemId}`);
  }
}
export class InventoryFullError extends Error {
  constructor() {
    super("inventory has no free slot for this item");
  }
}
export class InsufficientItemsError extends Error {
  constructor() {
    super("character does not have enough of this item to remove");
  }
}

const DEFAULT_INVENTORY_SIZE = 36; // matches Bedrock's player inventory size; adjust if the RP uses a different container size

/** Sorted-key JSON so two semantically-equal metadata objects compare equal. */
export function canonicalMeta(meta: unknown): string {
  if (meta === null || meta === undefined) meta = {};
  if (typeof meta !== "object") return String(meta);
  const keys = Object.keys(meta as Record<string, unknown>).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (meta as Record<string, unknown>)[k];
  return JSON.stringify(out);
}

/**
 * Give `quantity` of `itemId` to a character. Server-authoritative: this
 * is the only path that should ever increase a character's item count.
 * Stacks onto an existing slot of the same item first (up to max_stack),
 * then fills new slots, then throws if the inventory has no room left
 * for the remainder — partial application inside one call is avoided by
 * doing the whole operation in a single transaction.
 */
export async function giveItem(params: {
  characterId: number;
  itemId: string;
  quantity: number;
  actorUserId: number;
  inventorySize?: number;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const { characterId, itemId, actorUserId } = params;
  const meta = params.meta ?? {};
  let remaining = params.quantity;
  const inventorySize = params.inventorySize ?? DEFAULT_INVENTORY_SIZE;
  if (remaining <= 0) throw new Error("quantity must be positive");

  await withTransaction(async (client) => {
    const { rows: itemRows } = await client.query(
      `SELECT id, stackable, max_stack, weight_g FROM items WHERE id = $1`,
      [itemId]
    );
    if (itemRows.length === 0) throw new ItemNotFoundError(itemId);
    const item = itemRows[0];
    const maxStack = item.stackable ? item.max_stack : 1;

    // Weight-aware: the character's carried weight may not exceed their
    // carry limit (migrations/020_inventory_weight.sql). Checked inside the
    // same transaction as the slot writes.
    const weightPerUnit = Number(item.weight_g ?? 0);
    if (weightPerUnit > 0) {
      const { rows: weightRows } = await client.query(
        `SELECT COALESCE((SELECT SUM(s.quantity * i.weight_g) FROM inventory_slots s JOIN items i ON i.id = s.item_id WHERE s.character_id = $1), 0)::bigint AS current, carry_weight_g FROM characters WHERE id = $2`,
        [characterId, characterId]
      );
      const current = BigInt(weightRows[0].current);
      const limit = BigInt(weightRows[0].carry_weight_g);
      if (current + BigInt(params.quantity) * BigInt(weightPerUnit) > limit) {
        throw new CarryWeightExceededError();
      }
    }

    // Lock this character's existing slots for the duration of the transaction
    // to prevent a concurrent give/remove from racing on the same slots.
    const { rows: slotRows } = await client.query(
      `SELECT slot_index, item_id, quantity, item_metadata FROM inventory_slots
       WHERE character_id = $1 ORDER BY slot_index FOR UPDATE`,
      [characterId]
    );
    const occupiedIndexes = new Set(slotRows.map((r) => r.slot_index));

    // Canonical form for metadata comparison: two stacks merge only when
    // their item_metadata is deep-equal (e.g. same durability). JSON
    // stringify key order is normalized via a sorted serialization.
    const metaKey = canonicalMeta(meta);

    // First pass: top up existing stacks of the same item AND the same metadata.
    for (const slot of slotRows) {
      if (remaining <= 0) break;
      if (slot.item_id !== itemId) continue;
      if (canonicalMeta(slot.item_metadata) !== metaKey) continue;
      const space = maxStack - slot.quantity;
      if (space <= 0) continue;
      const add = Math.min(space, remaining);
      await client.query(
        `UPDATE inventory_slots SET quantity = quantity + $1 WHERE character_id = $2 AND slot_index = $3`,
        [add, characterId, slot.slot_index]
      );
      remaining -= add;
    }

    // Second pass: fill empty slot indexes with new stacks.
    for (let idx = 0; idx < inventorySize && remaining > 0; idx++) {
      if (occupiedIndexes.has(idx)) continue;
      const add = Math.min(maxStack, remaining);
      await client.query(
        `INSERT INTO inventory_slots (character_id, slot_index, item_id, quantity, item_metadata) VALUES ($1, $2, $3, $4, $5)`,
        [characterId, idx, itemId, add, JSON.stringify(meta)]
      );
      remaining -= add;
      occupiedIndexes.add(idx);
    }

    if (remaining > 0) {
      // Roll back the whole grant rather than leaving a partially-applied give —
      // the transaction wrapper handles this since we throw here.
      throw new InventoryFullError();
    }

    await writeAudit(
      {
        actorUserId,
        action: "inventory.give",
        targetType: "character",
        targetId: String(characterId),
        payload: { itemId, quantity: params.quantity, meta },
        result: "success",
      },
      client
    );
  });
}

/**
 * Remove up to `quantity` of `itemId` from a character, oldest slot
 * (lowest index) first. Throws if the character doesn't have enough —
 * never removes a partial amount silently.
 */
export async function removeItem(params: {
  characterId: number;
  itemId: string;
  quantity: number;
  actorUserId: number;
}): Promise<void> {
  const { characterId, itemId, actorUserId } = params;
  let remaining = params.quantity;
  if (remaining <= 0) throw new Error("quantity must be positive");

  await withTransaction(async (client) => {
    const { rows: slotRows } = await client.query(
      `SELECT slot_index, quantity FROM inventory_slots
       WHERE character_id = $1 AND item_id = $2 ORDER BY slot_index FOR UPDATE`,
      [characterId, itemId]
    );
    const have = slotRows.reduce((sum, r) => sum + r.quantity, 0);
    if (have < remaining) throw new InsufficientItemsError();

    for (const slot of slotRows) {
      if (remaining <= 0) break;
      const take = Math.min(slot.quantity, remaining);
      const newQty = slot.quantity - take;
      if (newQty === 0) {
        await client.query(
          `DELETE FROM inventory_slots WHERE character_id = $1 AND slot_index = $2`,
          [characterId, slot.slot_index]
        );
      } else {
        await client.query(
          `UPDATE inventory_slots SET quantity = $1 WHERE character_id = $2 AND slot_index = $3`,
          [newQty, characterId, slot.slot_index]
        );
      }
      remaining -= take;
    }

    await writeAudit(
      {
        actorUserId,
        action: "inventory.remove",
        targetType: "character",
        targetId: String(characterId),
        payload: { itemId, quantity: params.quantity },
        result: "success",
      },
      client
    );
  });
}

export async function getInventory(characterId: number) {
  const { rows } = await pool.query(
    `SELECT s.slot_index, s.item_id, s.quantity, s.item_metadata, i.display_name, i.weight_g
     FROM inventory_slots s
     JOIN items i ON i.id = s.item_id
     WHERE s.character_id = $1
     ORDER BY s.slot_index`,
    [characterId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Weight + generic containers (migrations/020_inventory_weight.sql)
// ---------------------------------------------------------------------------

export class CarryWeightExceededError extends Error {
  constructor() {
    super("carrying too much weight for the character's carry limit");
  }
}
export class ContainerNotFoundError extends Error {
  constructor() {
    super("container not found");
  }
}
export class ContainerCapacityExceededError extends Error {
  constructor() {
    super("this container would exceed its weight capacity");
  }
}
export class ContainerNotEmptyError extends Error {
  constructor() {
    super("container still has items; empty it before deleting");
  }
}

const STORAGE_TYPES = ["vehicle", "house", "business", "locker", "warehouse"] as const;
export type StorageType = (typeof STORAGE_TYPES)[number];
const MAX_LABEL_LENGTH = 64;
const DEFAULT_CONTAINER_CAPACITY_G = 50000;

type Client = import("pg").PoolClient;

async function containerWeight(client: Client, inventoryId: number): Promise<bigint> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(ci.quantity * i.weight_g), 0)::bigint AS total
     FROM inventory_items ci JOIN items i ON i.id = ci.item_id
     WHERE ci.inventory_id = $1`,
    [inventoryId]
  );
  return BigInt(rows[0].total);
}

/** Add to a container inside the caller's transaction. Stacking + capacity enforced. */
async function addToContainerCore(
  client: Client,
  params: { inventoryId: number; itemId: string; quantity: number; meta: Record<string, unknown> }
): Promise<void> {
  const { inventoryId, itemId, quantity, meta } = params;
  const { rows: itemRows } = await client.query<{ stackable: boolean; max_stack: number; weight_g: number }>(
    `SELECT stackable, max_stack, weight_g FROM items WHERE id = $1`,
    [itemId]
  );
  if (itemRows.length === 0) throw new ItemNotFoundError(itemId);
  const item = itemRows[0];
  const maxStack = item.stackable ? item.max_stack : 1;
  const weightPerUnit = Number(item.weight_g ?? 0);

  const { rows: cRows } = await client.query<{ capacity_weight_g: number }>(
    `SELECT capacity_weight_g FROM inventories WHERE id = $1 FOR UPDATE`,
    [inventoryId]
  );
  if (cRows.length === 0) throw new ContainerNotFoundError();

  const current = await containerWeight(client, inventoryId);
  if (current + BigInt(quantity) * BigInt(weightPerUnit) > BigInt(cRows[0].capacity_weight_g)) {
    throw new ContainerCapacityExceededError();
  }

  const metaKey = canonicalMeta(meta);
  let remaining = quantity;

  // Stack onto an existing row with the same item + identical metadata.
  const { rows: existingRows } = await client.query(
    `SELECT id, quantity FROM inventory_items
     WHERE inventory_id = $1 AND item_id = $2 ORDER BY id FOR UPDATE`,
    [inventoryId, itemId]
  );
  for (const row of existingRows) {
    if (remaining <= 0) break;
    const { rows: metaRow } = await client.query(
      `SELECT (item_metadata::text = $2) AS same FROM inventory_items WHERE id = $1`,
      [row.id, metaKey]
    );
    if (!metaRow[0]?.same) continue;
    const space = maxStack - row.quantity;
    if (space <= 0) continue;
    const add = Math.min(space, remaining);
    await client.query(`UPDATE inventory_items SET quantity = quantity + $1 WHERE id = $2`, [add, row.id]);
    remaining -= add;
  }

  while (remaining > 0) {
    const add = Math.min(maxStack, remaining);
    await client.query(
      `INSERT INTO inventory_items (inventory_id, item_id, quantity, item_metadata) VALUES ($1, $2, $3, $4)`,
      [inventoryId, itemId, add, JSON.stringify(meta)]
    );
    remaining -= add;
  }
}

/** Remove up to `quantity` from a container inside the caller's transaction. */
async function removeFromContainerCore(client: Client, inventoryId: number, itemId: string, quantity: number) {
  if (quantity <= 0) throw new Error("quantity must be positive");
  const { rows } = await client.query(
    `SELECT id, quantity FROM inventory_items
     WHERE inventory_id = $1 AND item_id = $2 ORDER BY id FOR UPDATE`,
    [inventoryId, itemId]
  );
  const have = rows.reduce((s, r) => s + r.quantity, 0);
  if (have < quantity) throw new InsufficientItemsError();
  let remaining = quantity;
  for (const row of rows) {
    if (remaining <= 0) break;
    const take = Math.min(row.quantity, remaining);
    const newQty = row.quantity - take;
    if (newQty === 0) {
      await client.query(`DELETE FROM inventory_items WHERE id = $1`, [row.id]);
    } else {
      await client.query(`UPDATE inventory_items SET quantity = $1 WHERE id = $2`, [newQty, row.id]);
    }
    remaining -= take;
  }
}

/** Remove up to `quantity` of an item from the character's personal slots (in-txn core). */
async function deductFromSlotsCore(client: Client, characterId: number, itemId: string, quantity: number) {
  if (quantity <= 0) throw new Error("quantity must be positive");
  const { rows } = await client.query(
    `SELECT slot_index, quantity FROM inventory_slots
     WHERE character_id = $1 AND item_id = $2 ORDER BY slot_index FOR UPDATE`,
    [characterId, itemId]
  );
  const have = rows.reduce((s, r) => s + r.quantity, 0);
  if (have < quantity) throw new InsufficientItemsError();
  let remaining = quantity;
  for (const slot of rows) {
    if (remaining <= 0) break;
    const take = Math.min(slot.quantity, remaining);
    const newQty = slot.quantity - take;
    if (newQty === 0) {
      await client.query(`DELETE FROM inventory_slots WHERE character_id = $1 AND slot_index = $2`, [characterId, slot.slot_index]);
    } else {
      await client.query(`UPDATE inventory_slots SET quantity = $1 WHERE character_id = $2 AND slot_index = $3`, [newQty, characterId, slot.slot_index]);
    }
    remaining -= take;
  }
}

export async function createInventory(params: {
  storageType: string;
  ownerCharacterId?: number | null;
  label?: string | null;
  capacityWeightG?: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<{ id: number }> {
  const storageType = params.storageType;
  if (!(STORAGE_TYPES as readonly string[]).includes(storageType as StorageType)) {
    throw new Error(`storageType must be one of: ${STORAGE_TYPES.join(", ")}`);
  }
  const capacityWeightG = params.capacityWeightG ?? DEFAULT_CONTAINER_CAPACITY_G;
  if (capacityWeightG <= 0) throw new Error("capacityWeightG must be positive");
  const label = (params.label ?? "").trim().slice(0, MAX_LABEL_LENGTH) || null;

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO inventories (storage_type, owner_character_id, label, capacity_weight_g)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [storageType, params.ownerCharacterId ?? null, label, capacityWeightG]
    );
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "inventory.create_container",
        targetType: "inventory",
        targetId: String(rows[0].id),
        payload: { storageType, label, capacityWeightG, ownerCharacterId: params.ownerCharacterId ?? null },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return { id: Number(rows[0].id) };
  });
}

export async function listInventories(params: { ownerCharacterId?: number | null; limit?: number; offset?: number } = {}) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
  const offset = Math.max(0, params.offset ?? 0);
  const where = params.ownerCharacterId ? `WHERE owner_character_id = $1` : "";
  const values: unknown[] = params.ownerCharacterId ? [params.ownerCharacterId] : [];
  values.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT id, storage_type, owner_character_id, label, capacity_weight_g, created_at
     FROM inventories ${where} ORDER BY id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return rows;
}

export async function getContainerItems(inventoryId: number) {
  const { rows } = await pool.query(
    `SELECT ci.id, ci.item_id, ci.quantity, ci.item_metadata, i.display_name, i.weight_g
     FROM inventory_items ci JOIN items i ON i.id = ci.item_id
     WHERE ci.inventory_id = $1 ORDER BY ci.id`,
    [inventoryId]
  );
  return rows;
}

export async function getContainerInventory(inventoryId: number) {
  const { rows } = await pool.query(
    `SELECT id, storage_type, owner_character_id, label, capacity_weight_g, created_at FROM inventories WHERE id = $1`,
    [inventoryId]
  );
  if (rows.length === 0) return null;
  const items = await getContainerItems(inventoryId);
  const used = items.reduce((s: number, i: any) => s + i.quantity * i.weight_g, 0);
  return { ...rows[0], usedWeightG: used, items };
}

export async function addItemsToContainer(params: {
  containerId: number;
  itemId: string;
  quantity: number;
  meta?: Record<string, unknown>;
  actorUserId: number;
  requestId?: string | null;
}): Promise<void> {
  const { containerId, itemId, quantity, actorUserId } = params;
  if (quantity <= 0) throw new Error("quantity must be positive");
  await withTransaction(async (client) => {
    await addToContainerCore(client, { inventoryId: containerId, itemId, quantity, meta: params.meta ?? {} });
    await writeAudit(
      {
        actorUserId,
        action: "inventory.container_add",
        targetType: "inventory",
        targetId: String(containerId),
        payload: { itemId, quantity, meta: params.meta ?? {} },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
  });
}

export async function removeItemsFromContainer(params: {
  containerId: number;
  itemId: string;
  quantity: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<void> {
  const { containerId, itemId, quantity, actorUserId } = params;
  await withTransaction(async (client) => {
    await removeFromContainerCore(client, containerId, itemId, quantity);
    await writeAudit(
      {
        actorUserId,
        action: "inventory.container_remove",
        targetType: "inventory",
        targetId: String(containerId),
        payload: { itemId, quantity },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
  });
}

/** Move items between two containers (or character slots <-> container). Atomic. */
export async function transferItemBetweenContainers(params: {
  fromContainerId: number;
  toContainerId: number;
  itemId: string;
  quantity: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<void> {
  const { fromContainerId, toContainerId, itemId, quantity, actorUserId } = params;
  if (quantity <= 0) throw new Error("quantity must be positive");
  await withTransaction(async (client) => {
    // Order locks deterministically to avoid deadlocks.
    const [lowId, highId] = fromContainerId < toContainerId ? [fromContainerId, toContainerId] : [toContainerId, fromContainerId];
    await client.query(`SELECT id FROM inventories WHERE id = $1 FOR UPDATE`, [lowId]);
    if (highId !== lowId) await client.query(`SELECT id FROM inventories WHERE id = $1 FOR UPDATE`, [highId]);

    const { rows: metaRows } = await client.query(
      `SELECT item_metadata FROM inventory_items WHERE inventory_id = $1 AND item_id = $2 ORDER BY id LIMIT 1`,
      [fromContainerId, itemId]
    );
    const sourceMeta = (metaRows[0]?.item_metadata ?? {}) as Record<string, unknown>;

    await removeFromContainerCore(client, fromContainerId, itemId, quantity);
    await addToContainerCore(client, { inventoryId: toContainerId, itemId, quantity, meta: sourceMeta });
    await writeAudit(
      {
        actorUserId,
        action: "inventory.transfer",
        targetType: "inventory",
        targetId: String(fromContainerId),
        payload: { toContainerId, itemId, quantity },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
  });
  publish({ type: "ITEM_TRANSFERRED", itemId, quantity, fromInventoryId: fromContainerId, toInventoryId: toContainerId, characterId: null });
}

/** Move items from the character's personal slots into a container. Atomic. */
export async function transferCharacterToContainer(params: {
  characterId: number;
  containerId: number;
  itemId: string;
  quantity: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<void> {
  const { characterId, containerId, itemId, quantity, actorUserId } = params;
  if (quantity <= 0) throw new Error("quantity must be positive");
  await withTransaction(async (client) => {
    await client.query(`SELECT id FROM inventories WHERE id = $1 FOR UPDATE`, [containerId]);
    const { rows: metaRows } = await client.query(
      `SELECT item_metadata FROM inventory_slots WHERE character_id = $1 AND item_id = $2 AND item_metadata IS NOT NULL ORDER BY slot_index LIMIT 1`,
      [characterId, itemId]
    );
    const sourceMeta = (metaRows[0]?.item_metadata ?? {}) as Record<string, unknown>;
    await deductFromSlotsCore(client, characterId, itemId, quantity);
    await addToContainerCore(client, { inventoryId: containerId, itemId, quantity, meta: sourceMeta });
    await writeAudit(
      {
        actorUserId,
        action: "inventory.move_to_container",
        targetType: "inventory",
        targetId: String(containerId),
        payload: { characterId, itemId, quantity },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
  });
  publish({ type: "ITEM_TRANSFERRED", itemId, quantity, fromInventoryId: null, toInventoryId: containerId, characterId });
}

/** Move items from a container into the character's personal slots. Atomic. */
export async function transferContainerToCharacter(params: {
  containerId: number;
  characterId: number;
  itemId: string;
  quantity: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<void> {
  const { containerId, characterId, itemId, quantity, actorUserId } = params;
  if (quantity <= 0) throw new Error("quantity must be positive");
  await withTransaction(async (client) => {
    await client.query(`SELECT id FROM inventories WHERE id = $1 FOR UPDATE`, [containerId]);
    const { rows: countRows } = await client.query(`SELECT count(*)::int AS n FROM inventories WHERE id = $1`, [containerId]);
    if (countRows[0].n === 0) throw new ContainerNotFoundError();
    const { rows: metaRows } = await client.query(
      `SELECT item_metadata FROM inventory_items WHERE inventory_id = $1 AND item_id = $2 ORDER BY id LIMIT 1`,
      [containerId, itemId]
    );
    const sourceMeta = (metaRows[0]?.item_metadata ?? {}) as Record<string, unknown>;
    await removeFromContainerCore(client, containerId, itemId, quantity);
    // Reuse the slots-insert logic: lock character's slots and insert into
    // the first free slot, enforcing the character's carry limit.
    const { rows: itemRows } = await client.query(`SELECT max_stack, stackable, weight_g FROM items WHERE id = $1`, [itemId]);
    if (itemRows.length === 0) throw new ItemNotFoundError(itemId);

    const { rows: weightRows } = await client.query(
      `SELECT COALESCE((SELECT SUM(s.quantity * i.weight_g) FROM inventory_slots s JOIN items i ON i.id = s.item_id WHERE s.character_id = $1), 0)::bigint AS current, carry_weight_g FROM characters WHERE id = $2`,
      [characterId, characterId]
    );
    const weightPerUnit = Number(itemRows[0].weight_g ?? 0);
    if (BigInt(weightRows[0].current) + BigInt(quantity) * BigInt(weightPerUnit) > BigInt(weightRows[0].carry_weight_g)) {
      throw new CarryWeightExceededError();
    }

    const { rows: slotRows } = await client.query(
      `SELECT slot_index, item_id, quantity, item_metadata FROM inventory_slots WHERE character_id = $1 ORDER BY slot_index FOR UPDATE`,
      [characterId]
    );
    const occupied = new Set(slotRows.map((r) => r.slot_index));
    const maxStack = itemRows[0].stackable ? itemRows[0].max_stack : 1;
    let remaining = quantity;
    const metaKey = canonicalMeta(sourceMeta);
    for (const slot of slotRows) {
      if (remaining <= 0) break;
      if (slot.item_id !== itemId || canonicalMeta(slot.item_metadata) !== metaKey) continue;
      const space = maxStack - slot.quantity;
      if (space <= 0) continue;
      const add = Math.min(space, remaining);
      await client.query(`UPDATE inventory_slots SET quantity = quantity + $1 WHERE character_id = $2 AND slot_index = $3`, [add, characterId, slot.slot_index]);
      remaining -= add;
    }
    for (let idx = 0; idx < 36 && remaining > 0; idx++) {
      if (occupied.has(idx)) continue;
      const add = Math.min(maxStack, remaining);
      await client.query(`INSERT INTO inventory_slots (character_id, slot_index, item_id, quantity, item_metadata) VALUES ($1, $2, $3, $4, $5)`, [characterId, idx, itemId, add, JSON.stringify(sourceMeta)]);
      remaining -= add;
      occupied.add(idx);
    }
    if (remaining > 0) throw new InventoryFullError();

    await writeAudit(
      {
        actorUserId,
        action: "inventory.move_to_character",
        targetType: "inventory",
        targetId: String(containerId),
        payload: { characterId, itemId, quantity },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
  });
  publish({ type: "ITEM_TRANSFERRED", itemId, quantity, fromInventoryId: containerId, toInventoryId: null, characterId });
}

/** Delete an empty container. Refuses while it still holds items. */
export async function deleteInventory(params: {
  containerId: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<void> {
  const { containerId, actorUserId } = params;
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM inventory_items WHERE inventory_id = $1`,
      [containerId]
    );
    if (rows[0].count > 0) throw new ContainerNotEmptyError();
    const { rowCount } = await client.query(`DELETE FROM inventories WHERE id = $1`, [containerId]);
    if (rowCount === 0) throw new ContainerNotFoundError();
    await writeAudit(
      {
        actorUserId,
        action: "inventory.delete_container",
        targetType: "inventory",
        targetId: String(containerId),
        result: "success",
        requestId: params.requestId,
      },
      client
    );
  });
}
