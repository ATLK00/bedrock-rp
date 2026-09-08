import { Router } from "express";
import { pool } from "../../db/pool.js";
import * as cases from "./index.js";

/**
 * Player-facing support case routes (see modules/cases/index.ts for the
 * model). Permission enforcement:
 *   - create/list       — any authenticated user (case.create, granted to
 *                         everyone who holds a role; unassigned users get
 *                         it via the moderator grant set OR explicit seed)
 *   - read own case     — the case owner, or staff (case.manage)
 *   - message own case  — the case owner, or staff
 * `case.create` is not required for authenticated users on the routes
 * below because they are strictly scoped to your OWN cases — the route
 * checks ownership rather than the permission. Staff access is gated by
 * `case.manage` via requirePermission.
 */
export const casesRouter = Router();

function requireUserId(req: any, res: any): number | null {
  const userId = req.userId as number | undefined;
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
  return userId;
}

casesRouter.post("/", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;

  const { category, subject, description } = (req.body ?? {}) as {
    category?: unknown;
    subject?: unknown;
    description?: unknown;
  };
  if (typeof category !== "string" || typeof subject !== "string" || typeof description !== "string") {
    return res.status(400).json({ error: "category (string), subject (string), description (string) are required" });
  }
  if (subject.trim().length < 3 || subject.trim().length > 200) {
    return res.status(400).json({ error: "subject must be between 3 and 200 characters" });
  }
  if (description.trim().length < 10 || description.trim().length > 5000) {
    return res.status(400).json({ error: "description must be between 10 and 5000 characters" });
  }

  const { rows } = await pool.query(
    `SELECT id FROM characters WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );

  try {
    const { id } = await cases.createCase({
      userId,
      category,
      subject: subject.trim(),
      description: description.trim(),
      characterId: rows.length > 0 ? rows[0].id : null,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    res.status(201).json({ caseId: id });
  } catch (err: any) {
    if (err instanceof cases.InvalidCaseCategoryError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

casesRouter.get("/", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;
  const list = await cases.listCasesForUser(userId);
  res.json({ cases: list });
});

casesRouter.get("/:id", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "case id must be a positive integer" });

  const caseRow = await cases.getCaseById(id);
  if (!caseRow) return res.status(404).json({ error: "case not found" });
  if (Number(caseRow.user_id) !== userId) {
    return res.status(403).json({ error: "you can only view your own cases" });
  }

  const messages = await cases.listCaseMessages(id);
  const events = await cases.listCaseEvents(id);
  res.json({ ...caseRow, messages, events });
});

casesRouter.post("/:id/messages", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "case id must be a positive integer" });
  const { body } = (req.body ?? {}) as { body?: unknown };
  if (typeof body !== "string" || body.trim().length < 1 || body.trim().length > 4000) {
    return res.status(400).json({ error: "body (string, 1-4000 chars) is required" });
  }

  const caseRow = await cases.getCaseById(id);
  if (!caseRow) return res.status(404).json({ error: "case not found" });
  if (Number(caseRow.user_id) !== userId) {
    return res.status(403).json({ error: "you can only message your own cases" });
  }

  await cases.addCaseMessage({
    caseId: id,
    authorUserId: userId,
    body: body.trim(),
    requestId: (req as unknown as { requestId?: string }).requestId ?? null,
  });
  res.status(204).end();
});