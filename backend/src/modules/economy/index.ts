import { withTransaction, pool } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";
import { publish } from "../../eventbus/index.js";

export class InsufficientFundsError extends Error {
  constructor() {
    super("insufficient funds");
  }
}

/**
 * Move money between characters. Ledger row is the source of truth;
 * `wallets.balance_cents` is a cache updated in the same transaction.
 * Negative amountCents == debit only allowed via `debit()`.
 */
export async function transfer(params: {
  fromCharacterId: number;
  toCharacterId: number;
  amountCents: number;
  reason: string;
  actorUserId: number | null;
}): Promise<void> {
  const { fromCharacterId, toCharacterId, amountCents, reason, actorUserId } = params;
  if (amountCents <= 0) throw new Error("amountCents must be positive");

  await withTransaction(async (client) => {
    // Lock the payer's wallet row so concurrent transfers can't overdraw it.
    const { rows } = await client.query<{ balance_cents: string }>(
      `SELECT balance_cents FROM wallets WHERE character_id = $1 FOR UPDATE`,
      [fromCharacterId]
    );
    const balance = rows[0] ? BigInt(rows[0].balance_cents) : 0n;
    if (balance < BigInt(amountCents)) {
      throw new InsufficientFundsError();
    }

    await client.query(
      `UPDATE wallets SET balance_cents = balance_cents - $1, updated_at = now() WHERE character_id = $2`,
      [amountCents, fromCharacterId]
    );
    await client.query(
      `INSERT INTO wallets (character_id, balance_cents) VALUES ($1, 0)
       ON CONFLICT (character_id) DO NOTHING`,
      [toCharacterId]
    );
    await client.query(
      `UPDATE wallets SET balance_cents = balance_cents + $1, updated_at = now() WHERE character_id = $2`,
      [amountCents, toCharacterId]
    );

    await client.query(
      `INSERT INTO transactions (character_id, counterparty_id, amount_cents, reason, ref_type, created_by)
       VALUES ($1, $2, $3, $4, 'transfer', $5)`,
      [fromCharacterId, toCharacterId, -amountCents, reason, actorUserId]
    );
    await client.query(
      `INSERT INTO transactions (character_id, counterparty_id, amount_cents, reason, ref_type, created_by)
       VALUES ($1, $2, $3, $4, 'transfer', $5)`,
      [toCharacterId, fromCharacterId, amountCents, reason, actorUserId]
    );

    await writeAudit(
      {
        actorUserId,
        action: "economy.transfer",
        targetType: "character",
        targetId: String(fromCharacterId),
        payload: { toCharacterId, amountCents, reason },
        result: "success",
      },
      client
    );
  });

  publish({ type: "economy.transaction", characterId: fromCharacterId, amountCents: -amountCents, reason });
  publish({ type: "economy.transaction", characterId: toCharacterId, amountCents, reason });
}

/** Admin-only: mint money into a character's wallet. Always audited. */
export async function grant(params: {
  characterId: number;
  amountCents: number;
  reason: string;
  actorUserId: number;
}): Promise<void> {
  const { characterId, amountCents, reason, actorUserId } = params;
  if (amountCents <= 0) throw new Error("amountCents must be positive");

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO wallets (character_id, balance_cents) VALUES ($1, $2)
       ON CONFLICT (character_id) DO UPDATE SET balance_cents = wallets.balance_cents + $2, updated_at = now()`,
      [characterId, amountCents]
    );
    await client.query(
      `INSERT INTO transactions (character_id, amount_cents, reason, ref_type, created_by)
       VALUES ($1, $2, $3, 'admin_grant', $4)`,
      [characterId, amountCents, reason, actorUserId]
    );
    await writeAudit(
      {
        actorUserId,
        action: "economy.grant",
        targetType: "character",
        targetId: String(characterId),
        payload: { amountCents, reason },
        result: "success",
      },
      client
    );
  });

  publish({ type: "economy.transaction", characterId, amountCents, reason });
}

/** Read-only: the character's wallet balance plus recent ledger rows. */
export async function getWalletAndHistory(characterId: number, limit = 20) {
  const { rows: walletRows } = await pool.query(
    `SELECT balance_cents FROM wallets WHERE character_id = $1`,
    [characterId]
  );
  const { rows: txRows } = await pool.query(
    `SELECT id, counterparty_id, amount_cents, reason, ref_type, ref_id, created_at
     FROM transactions
     WHERE character_id = $1
     ORDER BY id DESC
     LIMIT $2`,
    [characterId, Math.max(1, Math.min(limit, 100))]
  );
  return {
    balanceCents: walletRows.length > 0 ? Number(walletRows[0].balance_cents) : 0,
    transactions: txRows,
  };
}

/**
 * Admin-only: claw money back out of a character's wallet (anti-negative
 * enforced with a FOR UPDATE lock + balance check, same as transfer).
 * Audited, ledgered, and published like grant.
 */
export async function deduct(params: {
  characterId: number;
  amountCents: number;
  reason: string;
  actorUserId: number;
}): Promise<void> {
  const { characterId, amountCents, reason, actorUserId } = params;
  if (amountCents <= 0) throw new Error("amountCents must be positive");

  await withTransaction(async (client) => {
    const { rows } = await client.query<{ balance_cents: string }>(
      `SELECT balance_cents FROM wallets WHERE character_id = $1 FOR UPDATE`,
      [characterId]
    );
    const balance = rows[0] ? BigInt(rows[0].balance_cents) : 0n;
    if (balance < BigInt(amountCents)) {
      throw new InsufficientFundsError();
    }

    await client.query(
      `UPDATE wallets SET balance_cents = balance_cents - $1, updated_at = now() WHERE character_id = $2`,
      [amountCents, characterId]
    );
    await client.query(
      `INSERT INTO transactions (character_id, amount_cents, reason, ref_type, created_by)
       VALUES ($1, $2, $3, 'admin_deduct', $4)`,
      [characterId, -amountCents, reason, actorUserId]
    );
    await writeAudit(
      {
        actorUserId,
        action: "economy.deduct",
        targetType: "character",
        targetId: String(characterId),
        payload: { amountCents, reason },
        result: "success",
      },
      client
    );
  });

  publish({ type: "economy.transaction", characterId, amountCents: -amountCents, reason });
}
