import { withTransaction, pool } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";
import { publish } from "../../eventbus/index.js";
import type { PoolClient } from "pg";

/**
 * Support cases / tickets (see migrations/024_cases.sql).
 * Lifecycle: open -> in_progress -> resolved | closed | rejected.
 * Every state transition and every message is recorded on the case
 * timeline (case_events) AND mirrored to the global audit log; the bus
 * gets CASE_CREATED / CASE_UPDATED so other systems can react.
 *
 * Permissions are enforced in the routes: players may create/view their
 * own cases, staff (case.manage) may view any case and change its state.
 */

export const CASE_CATEGORIES = [
  "bug",
  "lost_item",
  "lost_vehicle",
  "character_issue",
  "payment_issue",
  "ban_appeal",
  "report_player",
  "other",
] as const;

export type CaseCategory = (typeof CASE_CATEGORIES)[number];
export type CaseStatus = "open" | "in_progress" | "resolved" | "closed" | "rejected";

export class InvalidCaseCategoryError extends Error {
  constructor(category: string) {
    super(`unknown case category: ${category}`);
  }
}
export class CaseNotFoundError extends Error {
  constructor() {
    super("case not found");
  }
}
export class InvalidCaseStatusError extends Error {
  constructor(status: string) {
    super(`invalid case status: ${status}`);
  }
}

async function addCaseEvent(client: PoolClient, caseId: number, eventType: string, actorUserId: number | null, payload: Record<string, unknown>) {
  await client.query(
    `INSERT INTO case_events (case_id, event_type, actor_user_id, payload) VALUES ($1, $2, $3, $4)`,
    [caseId, eventType, actorUserId, JSON.stringify(payload)]
  );
}

export async function createCase(params: {
  userId: number;
  category: string;
  subject: string;
  description: string;
  characterId?: number | null;
  requestId?: string | null;
}): Promise<{ id: number }> {
  const { userId, category, subject, description, characterId } = params;
  if (!(CASE_CATEGORIES as readonly string[]).includes(category)) {
    throw new InvalidCaseCategoryError(category);
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO cases (user_id, category_key, subject, description, created_by, character_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, category, subject, description, userId, characterId ?? null]
    );
    const caseId = rows[0].id;
    await addCaseEvent(client, caseId, "created", userId, { category });
    await writeAudit(
      {
        actorUserId: userId,
        action: "case.create",
        targetType: "case",
        targetId: String(caseId),
        payload: { category, subject },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    publish({ type: "CASE_CREATED", caseId, by: userId });
    return { id: caseId };
  });
}

export async function listCasesForUser(userId: number, limit = 50) {
  const rows = await pool.query(
    `SELECT id, user_id, character_id, category_key, status, subject, description, created_at, updated_at
     FROM cases WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [userId, Math.max(1, Math.min(limit, 100))]
  );
  return rows.rows;
}

export async function listAllCases(params: { status?: string | null; limit?: number; offset?: number } = {}) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
  const offset = Math.max(0, params.offset ?? 0);
  const where: string[] = [];
  const values: unknown[] = [];
  if (params.status) {
    values.push(params.status);
    where.push(`status = $${values.length}`);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  values.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT id, user_id, character_id, category_key, status, subject, description, created_by, created_at, updated_at
     FROM cases ${whereClause} ORDER BY id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return rows;
}

export async function getCaseById(caseId: number) {
  const { rows } = await pool.query(
    `SELECT id, user_id, character_id, category_key, status, subject, description, created_by, created_at, updated_at
     FROM cases WHERE id = $1`,
    [caseId]
  );
  if (rows.length === 0) return null;
  return rows[0];
}

export async function listCaseMessages(caseId: number) {
  const { rows } = await pool.query(
    `SELECT id, author_user_id, body, created_at FROM case_messages WHERE case_id = $1 ORDER BY id`,
    [caseId]
  );
  return rows;
}

export async function listCaseEvents(caseId: number) {
  const { rows } = await pool.query(
    `SELECT id, event_type, actor_user_id, payload, created_at FROM case_events WHERE case_id = $1 ORDER BY id`,
    [caseId]
  );
  return rows;
}

export async function addCaseMessage(params: {
  caseId: number;
  authorUserId: number;
  body: string;
  requestId?: string | null;
}): Promise<void> {
  const { caseId, authorUserId, body } = params;
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO case_messages (case_id, author_user_id, body) VALUES ($1, $2, $3)`,
      [caseId, authorUserId, body]
    );
    await client.query(`UPDATE cases SET updated_at = now() WHERE id = $1`, [caseId]);
    await addCaseEvent(client, caseId, "message_added", authorUserId, {});
    await writeAudit(
      {
        actorUserId: authorUserId,
        action: "case.message",
        targetType: "case",
        targetId: String(caseId),
        payload: {},
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    publish({ type: "CASE_UPDATED", caseId, by: authorUserId });
  });
}

export async function setCaseStatus(params: {
  caseId: number;
  status: CaseStatus;
  actorUserId: number;
  note?: string | null;
  requestId?: string | null;
}): Promise<void> {
  const { caseId, status, actorUserId, note } = params;
  if (!["open", "in_progress", "resolved", "closed", "rejected"].includes(status)) {
    throw new InvalidCaseStatusError(status);
  }
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE cases SET status = $1, updated_at = now()
       WHERE id = $2
       RETURNING id, status`,
      [status, caseId]
    );
    if (rows.length === 0) throw new CaseNotFoundError();

    await addCaseEvent(client, caseId, "status_changed", actorUserId, { status, note: note ?? null });
    if (note) {
      await client.query(
        `INSERT INTO case_messages (case_id, author_user_id, body) VALUES ($1, $2, $3)`,
        [caseId, actorUserId, note]
      );
    }
    await writeAudit(
      {
        actorUserId,
        action: "case.status",
        targetType: "case",
        targetId: String(caseId),
        payload: { status },
        reason: note ?? undefined,
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    publish({ type: "CASE_UPDATED", caseId, by: actorUserId });
  });
}