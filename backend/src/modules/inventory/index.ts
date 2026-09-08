import { withTransaction, pool } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";

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
}): Promise<void> {
  const { characterId, itemId, actorUserId } = params;
  let remaining = params.quantity;
  const inventorySize = params.inventorySize ?? DEFAULT_INVENTORY_SIZE;
  if (remaining <= 0) throw new Error("quantity must be positive");

  await withTransaction(async (client) => {
    const { rows: itemRows } = await client.query(
      `SELECT id, stackable, max_stack FROM items WHERE id = $1`,
      [itemId]
    );
    if (itemRows.length === 0) throw new ItemNotFoundError(itemId);
    const item = itemRows[0];
    const maxStack = item.stackable ? item.max_stack : 1;

    // Lock this character's existing slots for the duration of the transaction
    // to prevent a concurrent give/remove from racing on the same slots.
    const { rows: slotRows } = await client.query(
      `SELECT slot_index, item_id, quantity FROM inventory_slots
       WHERE character_id = $1 ORDER BY slot_index FOR UPDATE`,
      [characterId]
    );
    const occupiedIndexes = new Set(slotRows.map((r) => r.slot_index));

    // First pass: top up existing stacks of the same item.
    if (item.stackable) {
      for (const slot of slotRows) {
        if (remaining <= 0) break;
        if (slot.item_id !== itemId) continue;
        const space = maxStack - slot.quantity;
        if (space <= 0) continue;
        const add = Math.min(space, remaining);
        await client.query(
          `UPDATE inventory_slots SET quantity = quantity + $1 WHERE character_id = $2 AND slot_index = $3`,
          [add, characterId, slot.slot_index]
        );
        remaining -= add;
      }
    }

    // Second pass: fill empty slot indexes with new stacks.
    for (let idx = 0; idx < inventorySize && remaining > 0; idx++) {
      if (occupiedIndexes.has(idx)) continue;
      const add = Math.min(maxStack, remaining);
      await client.query(
        `INSERT INTO inventory_slots (character_id, slot_index, item_id, quantity) VALUES ($1, $2, $3, $4)`,
        [characterId, idx, itemId, add]
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
        payload: { itemId, quantity: params.quantity },
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
    `SELECT s.slot_index, s.item_id, s.quantity, s.item_metadata, i.display_name
     FROM inventory_slots s
     JOIN items i ON i.id = s.item_id
     WHERE s.character_id = $1
     ORDER BY s.slot_index`,
    [characterId]
  );
  return rows;
}
