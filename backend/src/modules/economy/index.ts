import { withTransaction, pool } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";
import { publish } from "../../eventbus/index.js";
import { withIdempotencyKey } from "../idempotency/index.js";
import { emitSecurityEvent } from "../security/index.js";
import { config } from "../../config/index.js";

export class InsufficientFundsError extends Error {
  constructor(who?: string) {
    super(who ? `insufficient funds (${who})` : "insufficient funds");
  }
}

export type Currency = "cash" | "bank" | "red_money";
const VALID_CURRENCIES: Currency[] = ["cash", "bank", "red_money"];

function assertCurrency(c: string | undefined): Currency {
  if (c === undefined || c === null) return "cash";
  if (!(VALID_CURRENCIES as string[]).includes(c)) throw new Error(`unknown currency: ${c}`);
  return c as Currency;
}

/**
 * Ledger insert that tags the currency. `wallets`/`wallet_balances` are
 * caches; `transactions` is the permanent, append-only source of truth.
 * (migration 021 keeps cash on `wallets` for legacy compatibility —
 * trade/shop still read it — so cash money moves through the same code
 * path as before, and bank/red_money move through wallet_balances.)
 */
async function insertLedgerRow(
  client: import("pg").PoolClient,
  params: {
    characterId: number;
    counterpartyId?: number | null;
    amountCents: number; // signed: + credit, - debit
    reason: string;
    refType?: string | null;
    refId?: string | null;
    createdBy?: number | null;
    currency: Currency;
  }
) {
  await client.query(
    `INSERT INTO transactions
       (character_id, counterparty_id, amount_cents, reason, ref_type, ref_id, created_by, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.characterId,
      params.counterpartyId ?? null,
      params.amountCents,
      params.reason,
      params.refType ?? null,
      params.refId ?? null,
      params.createdBy ?? null,
      params.currency,
    ]
  );
}

/** Read the wallet row for a currency, locking it for update (anti-double-spend). */
async function lockWallet(client: import("pg").PoolClient, characterId: number, currency: Currency): Promise<bigint> {
  if (currency === "cash") {
    const { rows } = await client.query<{ balance_cents: string }>(
      `SELECT balance_cents FROM wallets WHERE character_id = $1 FOR UPDATE`,
      [characterId]
    );
    return rows[0] ? BigInt(rows[0].balance_cents) : 0n;
  }
  const { rows } = await client.query<{ balance_cents: string }>(
    `SELECT balance_cents FROM wallet_balances WHERE character_id = $1 AND currency = $2 FOR UPDATE`,
    [characterId, currency]
  );
  return rows[0] ? BigInt(rows[0].balance_cents) : 0n;
}

async function addMoney(client: import("pg").PoolClient, characterId: number, amountCents: number, currency: Currency) {
  if (currency === "cash") {
    await client.query(
      `INSERT INTO wallets (character_id, balance_cents) VALUES ($1, $2)
       ON CONFLICT (character_id) DO UPDATE SET balance_cents = wallets.balance_cents + $2, updated_at = now()`,
      [characterId, amountCents]
    );
    return;
  }
  await client.query(
    `INSERT INTO wallet_balances (character_id, currency, balance_cents) VALUES ($1, $2, $3)
     ON CONFLICT (character_id, currency) DO UPDATE SET balance_cents = wallet_balances.balance_cents + $3`,
    [characterId, currency, amountCents]
  );
}

async function subtractMoney(client: import("pg").PoolClient, characterId: number, amountCents: number, currency: Currency) {
  if (currency === "cash") {
    await client.query(
      `UPDATE wallets SET balance_cents = balance_cents - $1, updated_at = now() WHERE character_id = $2`,
      [amountCents, characterId]
    );
    return;
  }
  await client.query(
    `UPDATE wallet_balances SET balance_cents = balance_cents - $1 WHERE character_id = $2 AND currency = $3`,
    [amountCents, characterId, currency]
  );
}

function publishMoneyEvent(characterId: number, amountCents: number, reason: string, currency: Currency) {
  publish({ type: "economy.transaction", characterId, amountCents, reason });
  publish({ type: "PLAYER_MONEY_CHANGED", characterId, amountCents, reason, currency });
}

/**
 * Economy anomaly detection: a single credit above the configured
 * threshold is suspicious (duplicated grant, compromised admin, etc.) and
 * raises a HIGH severity security event for staff review. True anomaly
 * analysis on velocity/etc. can layer on top of the ledger later; this
 * catches the loud cases.
 */
async function detectAnomaly(client: import("pg").PoolClient | undefined, params: {
  characterId: number;
  amountCents: number;
  currency: Currency;
  actorUserId: number | null;
  requestId?: string | null;
}) {
  const threshold = config.ECONOMY_ANOMALY_THRESHOLD_CENTS;
  if (params.amountCents >= threshold) {
    await emitSecurityEvent(
      {
        eventType: "economy_anomaly",
        severity: "HIGH",
        actorUserId: params.actorUserId,
        requestId: params.requestId,
        targetType: "character",
        targetId: String(params.characterId),
        payload: { amountCents: params.amountCents, currency: params.currency },
      },
      client
    );
  }
}

/**
 * Move money between characters inside one transaction. Cash (default)
 * uses the legacy wallets path; bank/red_money use wallet_balances.
 * Negative amounts are only possible via `debit`/`deduct` (which lock the
 * row and refuse to overdraw).
 */
export async function transfer(params: {
  fromCharacterId: number;
  toCharacterId: number;
  amountCents: number;
  reason: string;
  actorUserId: number | null;
  currency?: Currency;
  requestId?: string | null;
}): Promise<void> {
  const { fromCharacterId, toCharacterId, amountCents, reason, actorUserId } = params;
  const currency = assertCurrency(params.currency);
  if (amountCents <= 0) throw new Error("amountCents must be positive");

  await withTransaction(async (client) => {
    if (currency === "cash") {
      // Legacy cash path — wallets row, same guarantees as before.
      await client.query(
        `INSERT INTO wallets (character_id, balance_cents) VALUES ($1, 0)
         ON CONFLICT (character_id) DO NOTHING`,
        [toCharacterId]
      );
    }
    const balance = await lockWallet(client, fromCharacterId, currency);
    if (balance < BigInt(amountCents)) throw new InsufficientFundsError("from character");

    await subtractMoney(client, fromCharacterId, amountCents, currency);
    await addMoney(client, toCharacterId, amountCents, currency);

    await insertLedgerRow(client, { characterId: fromCharacterId, counterpartyId: toCharacterId, amountCents: -amountCents, reason, refType: "transfer", createdBy: actorUserId, currency });
    await insertLedgerRow(client, { characterId: toCharacterId, counterpartyId: fromCharacterId, amountCents, reason, refType: "transfer", createdBy: actorUserId, currency });

    await writeAudit(
      {
        actorUserId,
        action: "economy.transfer",
        targetType: "character",
        targetId: String(fromCharacterId),
        payload: { toCharacterId, amountCents, reason, currency },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
  });

  publishMoneyEvent(fromCharacterId, -amountCents, reason, currency);
  publishMoneyEvent(toCharacterId, amountCents, reason, currency);
}

export interface MoneyMutationParams {
  characterId: number;
  amountCents: number;
  reason: string;
  actorUserId: number | null;
  currency?: Currency;
  refType?: string | null;
  refId?: string | null;
  idempotencyKey?: string | null;
  requestId?: string | null;
}

/** Add money to a character in the given currency. Audited + ledgered + published. */
export async function credit(params: MoneyMutationParams): Promise<void> {
  const { characterId, amountCents, reason, actorUserId } = params;
  const currency = assertCurrency(params.currency);
  if (amountCents <= 0) throw new Error("amountCents must be positive");

  await withTransaction(async (client) => {
    const guard = await withIdempotencyKey({
      client,
      key: params.idempotencyKey,
      scope: `economy.credit:${currency}`,
      requestData: { characterId, amountCents, reason, refType: params.refType ?? null },
      actorUserId,
    });
    if (guard.replayed) return;

    await addMoney(client, characterId, amountCents, currency);
    await insertLedgerRow(client, { characterId, amountCents, reason, refType: params.refType ?? null, refId: params.refId ?? null, createdBy: actorUserId, currency });
    await detectAnomaly(client, { characterId, amountCents, currency, actorUserId, requestId: params.requestId });
    await writeAudit(
      {
        actorUserId,
        action: "economy.credit",
        targetType: "character",
        targetId: String(characterId),
        payload: { amountCents, reason, currency, refType: params.refType ?? null },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
  });

  publishMoneyEvent(characterId, amountCents, reason, currency);
}

/** Remove money (locked against going negative, same as deduct). */
export async function debit(params: MoneyMutationParams): Promise<void> {
  const { characterId, amountCents, reason, actorUserId } = params;
  const currency = assertCurrency(params.currency);
  if (amountCents <= 0) throw new Error("amountCents must be positive");

  await withTransaction(async (client) => {
    const guard = await withIdempotencyKey({
      client,
      key: params.idempotencyKey,
      scope: `economy.debit:${currency}`,
      requestData: { characterId, amountCents, reason, refType: params.refType ?? null },
      actorUserId,
    });
    if (guard.replayed) return;

    const balance = await lockWallet(client, characterId, currency);
    if (balance < BigInt(amountCents)) throw new InsufficientFundsError("from character");
    await subtractMoney(client, characterId, amountCents, currency);
    await insertLedgerRow(client, { characterId, amountCents: -amountCents, reason, refType: params.refType ?? null, refId: params.refId ?? null, createdBy: actorUserId, currency });
    await writeAudit(
      {
        actorUserId,
        action: "economy.debit",
        targetType: "character",
        targetId: String(characterId),
        payload: { amountCents, reason, currency, refType: params.refType ?? null },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
  });

  publishMoneyEvent(characterId, -amountCents, reason, currency);
}

// ---- High-level economy verbs (each is credit/debit with a ref type) ----

export function salary(params: Omit<MoneyMutationParams, "refType">) {
  return credit({ ...params, refType: "salary" });
}

export function fine(params: Omit<MoneyMutationParams, "refType">) {
  return debit({ ...params, refType: "fine" });
}

export function refund(params: Omit<MoneyMutationParams, "refType">) {
  return credit({ ...params, refType: "refund" });
}

export function purchase(params: Omit<MoneyMutationParams, "refType">) {
  return debit({ ...params, refType: "purchase" });
}

/**
 * Admin-only: mint money into a character's wallet (backward compatible
 * signature — extra fields optional). Idempotency-key aware.
 */
export async function grant(params: {
  characterId: number;
  amountCents: number;
  reason: string;
  actorUserId: number;
  currency?: Currency;
  idempotencyKey?: string | null;
  requestId?: string | null;
}): Promise<void> {
  await credit({
    characterId: params.characterId,
    amountCents: params.amountCents,
    reason: params.reason,
    actorUserId: params.actorUserId,
    currency: params.currency,
    idempotencyKey: params.idempotencyKey,
    requestId: params.requestId,
    refType: "admin_grant",
  });
}

/**
 * Admin-only: claw money back (anti-negative enforced inside debit).
 */
export async function deduct(params: {
  characterId: number;
  amountCents: number;
  reason: string;
  actorUserId: number;
  currency?: Currency;
  idempotencyKey?: string | null;
  requestId?: string | null;
}): Promise<void> {
  await debit({
    characterId: params.characterId,
    amountCents: params.amountCents,
    reason: params.reason,
    actorUserId: params.actorUserId,
    currency: params.currency,
    idempotencyKey: params.idempotencyKey,
    requestId: params.requestId,
    refType: "admin_deduct",
  });
}

/** Read-only: the character's CASH wallet balance plus recent ledger rows (legacy shape). */
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

/** Read-only: all three wallet balances (cash/bank/red_money) in one call. */
export async function getWalletSummary(characterId: number) {
  const { rows } = await pool.query(
    `SELECT balance_cents FROM wallets WHERE character_id = $1`,
    [characterId]
  );
  const cash = rows.length > 0 ? Number(rows[0].balance_cents) : 0;

  const { rows: bankRows } = await pool.query(
    `SELECT currency, balance_cents FROM wallet_balances WHERE character_id = $1`,
    [characterId]
  );
  const bank = bankRows.find((r) => r.currency === "bank")?.balance_cents ?? 0;
  const red = bankRows.find((r) => r.currency === "red_money")?.balance_cents ?? 0;
  return { cashCents: cash, bankCents: Number(bank), redMoneyCents: Number(red) };
}

/** Read-only: ledger history filtered by currency (defaults to all). */
export async function getHistory(characterId: number, params: { currency?: Currency | null; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
  const where = params.currency ? `WHERE character_id = $1 AND currency = $2` : `WHERE character_id = $1`;
  const values: unknown[] = params.currency ? [characterId, params.currency] : [characterId];
  values.push(limit);
  const { rows } = await pool.query(
    `SELECT id, counterparty_id, amount_cents, reason, ref_type, ref_id, currency, created_by, created_at
     FROM transactions ${where} ORDER BY id DESC LIMIT $${values.length}`,
    values
  );
  return rows;
}