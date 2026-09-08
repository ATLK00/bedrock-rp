import { withTransaction, pool } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";

export class TradeNotFoundError extends Error {
  constructor() {
    super("trade not found or already resolved");
  }
}
export class NotYourTradeError extends Error {
  constructor() {
    super("you are not a party to this trade");
  }
}
export class InsufficientFundsError extends Error {
  constructor(who: string) {
    super(`${who} does not have enough money for this trade`);
  }
}
export class InsufficientItemsError extends Error {
  constructor(who: string) {
    super(`${who} does not have enough of the item for this trade`);
  }
}

interface TradeOffer {
  cents?: number;
  itemId?: string;
  itemQty?: number;
}

/**
 * Create a pending trade. Does NOT move anything yet — items/money stay
 * with their owners until the counterparty accepts. `initiatorGives` is
 * what the initiator hands over; `initiatorWants` is what they expect
 * back from the counterparty.
 */
export async function proposeTrade(params: {
  initiatorId: number;
  counterpartyId: number;
  initiatorGives: TradeOffer;
  initiatorWants: TradeOffer;
  actorUserId: number;
}) {
  const { initiatorId, counterpartyId, initiatorGives, initiatorWants, actorUserId } = params;
  if (initiatorId === counterpartyId) throw new Error("cannot trade with yourself");

  const { rows } = await pool.query(
    `INSERT INTO trades (
       initiator_id, counterparty_id,
       initiator_cents, initiator_item_id, initiator_item_qty,
       counterparty_cents, counterparty_item_id, counterparty_item_qty
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      initiatorId,
      counterpartyId,
      initiatorGives.cents ?? 0,
      initiatorGives.itemId ?? null,
      initiatorGives.itemQty ?? 0,
      initiatorWants.cents ?? 0,
      initiatorWants.itemId ?? null,
      initiatorWants.itemQty ?? 0,
    ]
  );

  await writeAudit({
    actorUserId,
    action: "trade.propose",
    targetType: "trade",
    targetId: String(rows[0].id),
    payload: { initiatorId, counterpartyId, initiatorGives, initiatorWants },
    result: "success",
  });

  return { tradeId: rows[0].id };
}

async function getPendingTrade(client: any, tradeId: number) {
  const { rows } = await client.query(
    `SELECT * FROM trades WHERE id = $1 AND status = 'pending' FOR UPDATE`,
    [tradeId]
  );
  if (rows.length === 0) throw new TradeNotFoundError();
  return rows[0];
}

async function moveCents(client: any, fromCharacterId: number, toCharacterId: number, cents: number, who: string) {
  if (cents <= 0) return;
  const { rows } = await client.query(
    `SELECT balance_cents FROM wallets WHERE character_id = $1 FOR UPDATE`,
    [fromCharacterId]
  );
  const balance = rows[0] ? BigInt(rows[0].balance_cents) : 0n;
  if (balance < BigInt(cents)) throw new InsufficientFundsError(who);

  await client.query(
    `UPDATE wallets SET balance_cents = balance_cents - $1, updated_at = now() WHERE character_id = $2`,
    [cents, fromCharacterId]
  );
  await client.query(
    `INSERT INTO wallets (character_id, balance_cents) VALUES ($1, 0) ON CONFLICT (character_id) DO NOTHING`,
    [toCharacterId]
  );
  await client.query(
    `UPDATE wallets SET balance_cents = balance_cents + $1, updated_at = now() WHERE character_id = $2`,
    [cents, toCharacterId]
  );
  await client.query(
    `INSERT INTO transactions (character_id, counterparty_id, amount_cents, reason, ref_type)
     VALUES ($1, $2, $3, 'trade', 'trade')`,
    [fromCharacterId, toCharacterId, -cents]
  );
  await client.query(
    `INSERT INTO transactions (character_id, counterparty_id, amount_cents, reason, ref_type)
     VALUES ($1, $2, $3, 'trade', 'trade')`,
    [toCharacterId, fromCharacterId, cents]
  );
}

async function moveItem(
  client: any,
  fromCharacterId: number,
  toCharacterId: number,
  itemId: string | null,
  qty: number,
  who: string,
  inventorySize = 36
) {
  if (!itemId || qty <= 0) return;

  const { rows: itemRows } = await client.query(
    `SELECT stackable, max_stack FROM items WHERE id = $1`,
    [itemId]
  );
  if (itemRows.length === 0) throw new Error(`item not found: ${itemId}`);
  const maxStack = itemRows[0].stackable ? itemRows[0].max_stack : 1;

  // remove from sender
  const { rows: senderSlots } = await client.query(
    `SELECT slot_index, quantity FROM inventory_slots WHERE character_id = $1 AND item_id = $2 ORDER BY slot_index FOR UPDATE`,
    [fromCharacterId, itemId]
  );
  const have = senderSlots.reduce((sum: number, r: any) => sum + r.quantity, 0);
  if (have < qty) throw new InsufficientItemsError(who);

  let remaining = qty;
  for (const slot of senderSlots) {
    if (remaining <= 0) break;
    const take = Math.min(slot.quantity, remaining);
    const newQty = slot.quantity - take;
    if (newQty === 0) {
      await client.query(`DELETE FROM inventory_slots WHERE character_id = $1 AND slot_index = $2`, [fromCharacterId, slot.slot_index]);
    } else {
      await client.query(`UPDATE inventory_slots SET quantity = $1 WHERE character_id = $2 AND slot_index = $3`, [newQty, fromCharacterId, slot.slot_index]);
    }
    remaining -= take;
  }

  // give to receiver
  const { rows: receiverSlots } = await client.query(
    `SELECT slot_index, item_id, quantity FROM inventory_slots WHERE character_id = $1 ORDER BY slot_index FOR UPDATE`,
    [toCharacterId]
  );
  const occupied = new Set(receiverSlots.map((r: any) => r.slot_index));
  let toPlace = qty;

  for (const slot of receiverSlots) {
    if (toPlace <= 0) break;
    if (slot.item_id !== itemId) continue;
    const space = maxStack - slot.quantity;
    if (space <= 0) continue;
    const add = Math.min(space, toPlace);
    await client.query(`UPDATE inventory_slots SET quantity = quantity + $1 WHERE character_id = $2 AND slot_index = $3`, [add, toCharacterId, slot.slot_index]);
    toPlace -= add;
  }
  for (let idx = 0; idx < inventorySize && toPlace > 0; idx++) {
    if (occupied.has(idx)) continue;
    const add = Math.min(maxStack, toPlace);
    await client.query(`INSERT INTO inventory_slots (character_id, slot_index, item_id, quantity) VALUES ($1, $2, $3, $4)`, [toCharacterId, idx, itemId, add]);
    toPlace -= add;
    occupied.add(idx);
  }
  if (toPlace > 0) throw new Error(`${who}'s inventory has no room for the incoming item`);
}

/**
 * Accepting a trade moves BOTH sides atomically in one transaction —
 * if either side can't afford their part (insufficient funds/items/no
 * inventory room), the whole thing rolls back and neither side loses
 * anything. This is the core anti-scam guarantee of this design.
 */
export async function acceptTrade(params: { tradeId: number; callerCharacterId: number; actorUserId: number }) {
  const { tradeId, callerCharacterId, actorUserId } = params;

  await withTransaction(async (client) => {
    const trade = await getPendingTrade(client, tradeId);
    if (trade.counterparty_id !== callerCharacterId) {
      // Only the counterparty can accept — the initiator already committed to the terms by proposing.
      throw new NotYourTradeError();
    }

    await moveCents(client, trade.initiator_id, trade.counterparty_id, trade.initiator_cents, "initiator");
    await moveCents(client, trade.counterparty_id, trade.initiator_id, trade.counterparty_cents, "counterparty");
    await moveItem(client, trade.initiator_id, trade.counterparty_id, trade.initiator_item_id, trade.initiator_item_qty, "initiator");
    await moveItem(client, trade.counterparty_id, trade.initiator_id, trade.counterparty_item_id, trade.counterparty_item_qty, "counterparty");

    await client.query(`UPDATE trades SET status = 'accepted', resolved_at = now() WHERE id = $1`, [tradeId]);

    await writeAudit(
      {
        actorUserId,
        action: "trade.accept",
        targetType: "trade",
        targetId: String(tradeId),
        result: "success",
      },
      client
    );
  });
}

export async function declineTrade(params: { tradeId: number; callerCharacterId: number; actorUserId: number }) {
  const { tradeId, callerCharacterId, actorUserId } = params;
  const { rows } = await pool.query(`SELECT * FROM trades WHERE id = $1 AND status = 'pending'`, [tradeId]);
  if (rows.length === 0) throw new TradeNotFoundError();
  if (rows[0].counterparty_id !== callerCharacterId) throw new NotYourTradeError();

  await pool.query(`UPDATE trades SET status = 'declined', resolved_at = now() WHERE id = $1`, [tradeId]);
  await writeAudit({ actorUserId, action: "trade.decline", targetType: "trade", targetId: String(tradeId), result: "success" });
}

export async function cancelTrade(params: { tradeId: number; callerCharacterId: number; actorUserId: number }) {
  const { tradeId, callerCharacterId, actorUserId } = params;
  const { rows } = await pool.query(`SELECT * FROM trades WHERE id = $1 AND status = 'pending'`, [tradeId]);
  if (rows.length === 0) throw new TradeNotFoundError();
  if (rows[0].initiator_id !== callerCharacterId) throw new NotYourTradeError(); // only the initiator can cancel their own proposal

  await pool.query(`UPDATE trades SET status = 'cancelled', resolved_at = now() WHERE id = $1`, [tradeId]);
  await writeAudit({ actorUserId, action: "trade.cancel", targetType: "trade", targetId: String(tradeId), result: "success" });
}

/** Pending trades where this character is either side — for a "my trades" view. */
export async function listPendingTradesForCharacter(characterId: number) {
  const { rows } = await pool.query(
    `SELECT * FROM trades WHERE status = 'pending' AND (initiator_id = $1 OR counterparty_id = $1) ORDER BY created_at DESC`,
    [characterId]
  );
  return rows;
}

const TRADE_EXPIRY_HOURS = 24;

/**
 * Marks any `pending` trade older than TRADE_EXPIRY_HOURS as `expired`.
 * No money/items ever moved for a pending trade (see propose/accept
 * design above), so expiring one is just a status flip — nothing to
 * roll back. Intended to be called periodically (see `startExpiryJob`
 * below), not from an HTTP route.
 */
export async function expireOldTrades(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE trades SET status = 'expired', resolved_at = now()
     WHERE status = 'pending' AND created_at < now() - interval '${TRADE_EXPIRY_HOURS} hours'`
  );
  return rowCount ?? 0;
}

let expiryJobHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Starts a periodic job that expires old pending trades. Call once at
 * backend startup. In-process only — if the backend ever runs as
 * multiple instances, this would run redundantly in each (harmless,
 * since the UPDATE is idempotent, just slightly wasteful) but won't
 * miss trades since every instance shares the same DB.
 */
export function startExpiryJob(intervalMs = 60 * 60 * 1000) {
  if (expiryJobHandle) return; // already running, don't double-start
  expiryJobHandle = setInterval(async () => {
    try {
      const count = await expireOldTrades();
      if (count > 0) console.log(`[trade] expired ${count} old pending trade(s)`);
    } catch (err) {
      console.error("[trade] expiry job failed", err);
    }
  }, intervalMs);
}

export function stopExpiryJob() {
  if (expiryJobHandle) {
    clearInterval(expiryJobHandle);
    expiryJobHandle = null;
  }
}
