import { pool } from "../../db/pool.js";
import { publish, type SecuritySeverity } from "../../eventbus/index.js";
import type { PoolClient } from "pg";

/**
 * Security Center. Append-only `security_events` feed surfaced to staff
 * (see migrations/023_security_events.sql). Every security-relevant
 * occurrence in the codebase funnels through emitSecurityEvent so it
 * lands in one place with a severity and request correlation:
 *   - failed Discord logins          (auth/routes)
 *   - rate-limit trips               (middleware/rateLimit)
 *   - bad/expired bridge signature + replay (app.ts bridge gate)
 *   - economy anomalies              (modules/economy)
 *   - unexpected server errors       (app.ts global error handler)
 *   - admin-sensitive actions        (modules/admin)
 */

export interface SecurityEventInput {
  eventType: string;
  severity: SecuritySeverity;
  actorUserId?: number | null;
  ip?: string | null;
  requestId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  payload?: Record<string, unknown>;
}

export async function emitSecurityEvent(input: SecurityEventInput, client?: PoolClient) {
  const runner = client ?? pool;
  await runner.query(
    `INSERT INTO security_events
       (event_type, severity, actor_user_id, ip, request_id, target_type, target_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.eventType,
      input.severity,
      input.actorUserId ?? null,
      input.ip ?? null,
      input.requestId ?? null,
      input.targetType ?? null,
      input.targetId ?? null,
      JSON.stringify(input.payload ?? {}),
    ]
  );
  publish({ type: "SECURITY_ALERT", eventType: input.eventType, severity: input.severity });
}

export interface SecurityEventListParams {
  limit?: number;
  offset?: number;
  severity?: SecuritySeverity | null;
  acknowledged?: boolean | null;
}

export async function listSecurityEvents(params: SecurityEventListParams = {}) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
  const offset = Math.max(0, params.offset ?? 0);

  const where: string[] = [];
  const values: unknown[] = [];
  if (params.severity) {
    values.push(params.severity);
    where.push(`severity = $${values.length}`);
  }
  if (params.acknowledged !== null && params.acknowledged !== undefined) {
    values.push(params.acknowledged);
    where.push(params.acknowledged ? `acknowledged_at IS NOT NULL` : `acknowledged_at IS NULL`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  values.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT id, event_type, severity, actor_user_id, ip, request_id,
            target_type, target_id, payload, acknowledged_at, created_at
     FROM security_events
     ${whereClause}
     ORDER BY id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return rows;
}

export async function acknowledgeSecurityEvent(params: { eventId: number; actorUserId: number; requestId?: string | null }) {
  const { eventId, actorUserId, requestId } = params;
  const { rows } = await pool.query(
    `UPDATE security_events SET acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL RETURNING id, event_type`,
    [eventId]
  );
  if (rows.length === 0) return false;
  await pool.query(
    `INSERT INTO audit_log (actor_user_id, action, target_type, target_id, payload, result, request_id)
     VALUES ($1, 'security.acknowledge', 'security_event', $2, $3, 'success', $4)`,
    [actorUserId, eventId, JSON.stringify({ eventType: rows[0].event_type }), requestId ?? null]
  );
  return true;
}