import { withTransaction } from "../../db/pool.js";
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
