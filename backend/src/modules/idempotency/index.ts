import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

/**
 * Reusable idempotency guard (see migrations/022_idempotency.sql).
 *
 * Usage — inside an existing transaction (a `withTransaction` callback):
 *
 *   const guard = await withIdempotencyKey({
 *     client,
 *     key: req.header("Idempotency-Key"),
 *     scope: "economy.grant",
 *     requestData: { characterId, amountCents, reason },
 *     actorUserId: req.userId,
 *   });
 *   if (guard.replayed) return; // first attempt already recorded this exact request
 *   ... do the mutation ...
 *
 * The idempotency INSERT happens BEFORE the mutation in the same
 * transaction, so two concurrent deliveries of the same request cannot
 * both apply (the second INSERT finds the key already present and is a
 * no-op), and if the mutation throws, the whole transaction rolls back
 * including the idempotency row — a failed request can be retried.
 *
 * `replayed = true` is only returned when the stored request hash matches
 * the current one; a key reused with a DIFFERENT body throws
 * IdempotencyKeyMismatchError (callers map that to HTTP 409).
 */

export class IdempotencyKeyMismatchError extends Error {
  constructor() {
    super("Idempotency-Key was already used with a different request body");
  }
}

function requestHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input ?? {})).digest("hex");
}

export interface IdempotencyGuardResult {
  replayed: boolean;
}

export async function withIdempotencyKey(params: {
  client: PoolClient;
  key?: string | null;
  scope: string;
  requestData: unknown;
  actorUserId?: number | null;
}): Promise<IdempotencyGuardResult> {
  if (!params.key) return { replayed: false };

  const hash = requestHash(params.requestData);
  const { rowCount } = await params.client.query(
    `INSERT INTO idempotency_keys (id_key, scope, request_hash, result_status, created_by)
     VALUES ($1, $2, $3, 202, $4)
     ON CONFLICT (id_key, scope) DO NOTHING`,
    [params.key, params.scope, hash, params.actorUserId ?? null]
  );

  if (rowCount === 1) return { replayed: false }; // claimed the key — caller proceeds

  // Key already exists (retry or concurrent duplicate). Verify the body matches.
  const { rows } = await params.client.query(
    `SELECT request_hash FROM idempotency_keys WHERE id_key = $1 AND scope = $2`,
    [params.key, params.scope]
  );
  if (rows.length === 0) return { replayed: false }; // raced but not committed yet; treat as fresh
  if (rows[0].request_hash !== hash) throw new IdempotencyKeyMismatchError();
  return { replayed: true };
}