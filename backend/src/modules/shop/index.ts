import { withTransaction, pool } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";

export class ItemNotListedError extends Error {
  constructor() {
    super("this item is not listed in the shop");
  }
}
export class NotPurchasableError extends Error {
  constructor() {
    super("the shop does not sell this item");
  }
}
export class NotSellableError extends Error {
  constructor() {
    super("the shop does not buy this item back");
  }
}
export class OutOfStockError extends Error {
  constructor() {
    super("the shop is out of stock for this item");
  }
}
export class InsufficientFundsError extends Error {
  constructor() {
    super("not enough money for this purchase");
  }
}
export class InsufficientItemsError extends Error {
  constructor() {
    super("not enough of this item to sell");
  }
}

const DEFAULT_INVENTORY_SIZE = 36;

export async function getCatalog() {
  const { rows } = await pool.query(
    `SELECT s.item_id, s.buy_price_cents, s.sell_price_cents, s.stock, i.display_name, i.stackable, i.max_stack
     FROM shop_listings s
     JOIN items i ON i.id = s.item_id
     ORDER BY s.item_id`
  );
  return rows;
}

/** Fetch a single listing's current values (or null if not listed) — lets an admin see what they're about to overwrite before calling upsertListing. */
export async function getListing(itemId: string) {
  const { rows } = await pool.query(
    `SELECT s.item_id, s.buy_price_cents, s.sell_price_cents, s.stock, i.display_name, i.stackable, i.max_stack
     FROM shop_listings s
     JOIN items i ON i.id = s.item_id
     WHERE s.item_id = $1`,
    [itemId]
  );
  return rows[0] ?? null;
}

export class ItemDoesNotExistError extends Error {
  constructor(itemId: string) {
    super(`item does not exist in the item catalog: ${itemId}`);
  }
}

/**
 * Create or update a shop listing. `buyPriceCents`/`sellPriceCents`/`stock`
 * are each explicitly nullable — pass `null` to mean "not purchasable"/
 * "not sellable"/"unlimited" respectively, matching the schema. Upserts
 * so the same call adds a new listing or edits an existing one.
 */
export async function upsertListing(params: {
  itemId: string;
  buyPriceCents: number | null;
  sellPriceCents: number | null;
  stock: number | null;
  actorUserId: number;
}) {
  const { itemId, buyPriceCents, sellPriceCents, stock, actorUserId } = params;

  const { rows: itemRows } = await pool.query(`SELECT id FROM items WHERE id = $1`, [itemId]);
  if (itemRows.length === 0) throw new ItemDoesNotExistError(itemId);

  await pool.query(
    `INSERT INTO shop_listings (item_id, buy_price_cents, sell_price_cents, stock)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (item_id) DO UPDATE SET
       buy_price_cents = $2, sell_price_cents = $3, stock = $4, updated_at = now()`,
    [itemId, buyPriceCents, sellPriceCents, stock]
  );

  await writeAudit({
    actorUserId,
    action: "shop.listing.upsert",
    targetType: "item",
    targetId: itemId,
    payload: { buyPriceCents, sellPriceCents, stock },
    result: "success",
  });
}

export async function removeListing(params: { itemId: string; actorUserId: number }) {
  const { itemId, actorUserId } = params;
  await pool.query(`DELETE FROM shop_listings WHERE item_id = $1`, [itemId]);
  await writeAudit({
    actorUserId,
    action: "shop.listing.remove",
    targetType: "item",
    targetId: itemId,
    result: "success",
  });
}

/**
 * Buy: character pays `buy_price_cents * quantity`, gains the item,
 * shop stock (if limited) decrements. All in one transaction — if the
 * character can't afford it or the shop is out of stock, nothing moves.
 */
export async function buyItem(params: {
  characterId: number;
  itemId: string;
  quantity: number;
  actorUserId: number;
  inventorySize?: number;
}): Promise<void> {
  const { characterId, itemId, quantity, actorUserId } = params;
  const inventorySize = params.inventorySize ?? DEFAULT_INVENTORY_SIZE;
  if (quantity <= 0) throw new Error("quantity must be positive");

  await withTransaction(async (client) => {
    const { rows: listingRows } = await client.query(
      `SELECT buy_price_cents, stock FROM shop_listings WHERE item_id = $1 FOR UPDATE`,
      [itemId]
    );
    if (listingRows.length === 0) throw new ItemNotListedError();
    const listing = listingRows[0];
    if (listing.buy_price_cents === null) throw new NotPurchasableError();
    if (listing.stock !== null && listing.stock < quantity) throw new OutOfStockError();

    const totalCost = Number(listing.buy_price_cents) * quantity;

    const { rows: walletRows } = await client.query(
      `SELECT balance_cents FROM wallets WHERE character_id = $1 FOR UPDATE`,
      [characterId]
    );
    const balance = walletRows[0] ? BigInt(walletRows[0].balance_cents) : 0n;
    if (balance < BigInt(totalCost)) throw new InsufficientFundsError();

    await client.query(
      `INSERT INTO wallets (character_id, balance_cents) VALUES ($1, 0)
       ON CONFLICT (character_id) DO NOTHING`,
      [characterId]
    );
    await client.query(
      `UPDATE wallets SET balance_cents = balance_cents - $1, updated_at = now() WHERE character_id = $2`,
      [totalCost, characterId]
    );
    await client.query(
      `INSERT INTO transactions (character_id, amount_cents, reason, ref_type, ref_id) VALUES ($1, $2, 'shop purchase', 'shop', $3)`,
      [characterId, -totalCost, itemId]
    );

    if (listing.stock !== null) {
      await client.query(`UPDATE shop_listings SET stock = stock - $1, updated_at = now() WHERE item_id = $2`, [quantity, itemId]);
    }

    const { rows: itemRows } = await client.query(`SELECT stackable, max_stack FROM items WHERE id = $1`, [itemId]);
    const maxStack = itemRows[0].stackable ? itemRows[0].max_stack : 1;

    const { rows: slotRows } = await client.query(
      `SELECT slot_index, item_id, quantity FROM inventory_slots WHERE character_id = $1 ORDER BY slot_index FOR UPDATE`,
      [characterId]
    );
    const occupied = new Set(slotRows.map((r: any) => r.slot_index));
    let remaining = quantity;

    for (const slot of slotRows) {
      if (remaining <= 0) break;
      if (slot.item_id !== itemId) continue;
      const space = maxStack - slot.quantity;
      if (space <= 0) continue;
      const add = Math.min(space, remaining);
      await client.query(`UPDATE inventory_slots SET quantity = quantity + $1 WHERE character_id = $2 AND slot_index = $3`, [add, characterId, slot.slot_index]);
      remaining -= add;
    }
    for (let idx = 0; idx < inventorySize && remaining > 0; idx++) {
      if (occupied.has(idx)) continue;
      const add = Math.min(maxStack, remaining);
      await client.query(`INSERT INTO inventory_slots (character_id, slot_index, item_id, quantity) VALUES ($1, $2, $3, $4)`, [characterId, idx, itemId, add]);
      remaining -= add;
      occupied.add(idx);
    }
    if (remaining > 0) throw new Error("inventory has no room for this purchase");

    await writeAudit(
      { actorUserId, action: "shop.buy", targetType: "character", targetId: String(characterId), payload: { itemId, quantity, totalCost }, result: "success" },
      client
    );
  });
}

/**
 * Sell: character loses the item, gains `sell_price_cents * quantity`,
 * shop stock (if limited) increments (the shop now "has" the item back).
 */
export async function sellItem(params: {
  characterId: number;
  itemId: string;
  quantity: number;
  actorUserId: number;
}): Promise<void> {
  const { characterId, itemId, quantity, actorUserId } = params;
  if (quantity <= 0) throw new Error("quantity must be positive");

  await withTransaction(async (client) => {
    const { rows: listingRows } = await client.query(
      `SELECT sell_price_cents, stock FROM shop_listings WHERE item_id = $1 FOR UPDATE`,
      [itemId]
    );
    if (listingRows.length === 0) throw new ItemNotListedError();
    const listing = listingRows[0];
    if (listing.sell_price_cents === null) throw new NotSellableError();

    const { rows: slotRows } = await client.query(
      `SELECT slot_index, quantity FROM inventory_slots WHERE character_id = $1 AND item_id = $2 ORDER BY slot_index FOR UPDATE`,
      [characterId, itemId]
    );
    const have = slotRows.reduce((sum: number, r: any) => sum + r.quantity, 0);
    if (have < quantity) throw new InsufficientItemsError();

    let remaining = quantity;
    for (const slot of slotRows) {
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

    const totalProceeds = Number(listing.sell_price_cents) * quantity;
    await client.query(
      `INSERT INTO wallets (character_id, balance_cents) VALUES ($1, $2)
       ON CONFLICT (character_id) DO UPDATE SET balance_cents = wallets.balance_cents + $2, updated_at = now()`,
      [characterId, totalProceeds]
    );
    await client.query(
      `INSERT INTO transactions (character_id, amount_cents, reason, ref_type, ref_id) VALUES ($1, $2, 'shop sale', 'shop', $3)`,
      [characterId, totalProceeds, itemId]
    );

    if (listing.stock !== null) {
      await client.query(`UPDATE shop_listings SET stock = stock + $1, updated_at = now() WHERE item_id = $2`, [quantity, itemId]);
    }

    await writeAudit(
      { actorUserId, action: "shop.sell", targetType: "character", targetId: String(characterId), payload: { itemId, quantity, totalProceeds }, result: "success" },
      client
    );
  });
}
