import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";

export interface AuditEntry {
  actorUserId: number | null;
  action: string;
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
  result: "success" | "failure";
}

/**
 * Write an audit_log row. Pass `client` when called inside an existing
 * transaction (e.g. alongside an economy transfer) so the audit entry
 * commits or rolls back atomically with the action it describes.
 */
export async function writeAudit(entry: AuditEntry, client?: PoolClient) {
  const runner = client ?? pool;
  await runner.query(
    `INSERT INTO audit_log (actor_user_id, action, target_type, target_id, payload, result)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.actorUserId,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      JSON.stringify(entry.payload ?? {}),
      entry.result,
    ]
  );
}
