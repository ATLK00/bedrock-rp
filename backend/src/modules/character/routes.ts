import { Router } from "express";
import { pool } from "../../db/pool.js";
import {
  generateLinkCodeForUser,
  createCharacter,
  getOwnCharacter,
  getOwnCharacterDetails,
  updateOwnCharacterDetails,
  confirmCharacter,
  softDeleteCharacter,
  CharacterAlreadyLinkedError,
  CharacterAlreadyExistsError,
  NoCharacterFoundError,
  CharacterLockedFieldError,
  CharacterIncompleteError,
  CharacterFieldConflictError,
  type CharacterDetailsFields,
} from "./index.js";
import { getInventory } from "../inventory/index.js";
import { getWalletAndHistory } from "../economy/index.js";
import { getGarageSummary as getVehicleGarage } from "../vehicle/index.js";
import { createCase } from "../cases/index.js";

export const characterRouter = Router();

function requireUserId(req: any, res: any): number | null {
  const userId = req.userId as number | undefined;
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
  return userId;
}

/** GET /character — the logged-in user's own character summary (link state, last seen). */
characterRouter.get("/", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;
  const character = await getOwnCharacter(userId);
  if (!character) return res.status(404).json({ error: "no character found for this user" });
  res.json(character);
});

/**
 * GET /character/details — the full RP profile including the details
 * fields, confirmation and lock state. Kept separate from GET /character
 * so existing consumers of the summary payload are untouched.
 */
characterRouter.get("/details", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;
  const character = await getOwnCharacterDetails(userId);
  if (!character) return res.status(404).json({ error: "no character found for this user" });
  res.json(character);
});

/**
 * PATCH /character/details — update the user's own details. After
 * confirmation the locked (identity) fields are refused and must go
 * through the case/approval path (POST /character/change-request).
 */
characterRouter.patch("/details", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;
  const details = (req.body ?? {}) as CharacterDetailsFields;
  if (typeof details !== "object" || details === null) {
    return res.status(400).json({ error: "request body must be an object" });
  }
  try {
    await updateOwnCharacterDetails({
      userId,
      details,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof CharacterLockedFieldError) return res.status(403).json({ error: err.message });
    if (err instanceof CharacterFieldConflictError) return res.status(400).json({ error: err.message });
    if (err instanceof NoCharacterFoundError) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/** POST /character/confirm — lock the profile in after review. */
characterRouter.post("/confirm", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;
  try {
    await confirmCharacter({
      userId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof CharacterIncompleteError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /character/change-request — open a staff case requesting a change
 * to a locked (identity) field. Staff approves via
 * POST /admin/character/update (permission character.edit), which applies
 * the change and resolves the case. Mirrors Master Prompt's
 * "Player Case/Ticket -> Admin Review -> Approval -> Audit Log" flow.
 */
characterRouter.post("/change-request", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;
  const { field, value, note } = (req.body ?? {}) as { field?: unknown; value?: unknown; note?: unknown };

  if (typeof field !== "string" || typeof value !== "string") {
    return res.status(400).json({ error: "field (string) and value (string) are required" });
  }

  const { rows } = await pool.query(
    `SELECT id FROM characters WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "no character found for this user" });
  const characterId = rows[0].id;

  try {
    const { id } = await createCase({
      userId,
      category: "character_issue",
      subject: `Change request: ${field}`,
      description: `Requested new value for "${field}". Note: ${typeof note === "string" ? note : "—"}`,
      characterId,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
    });
    res.status(201).json({ caseId: Number(id) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /character — create the user's own character (one per Discord account, enforced in DB). */
characterRouter.post("/", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;

  const { name } = (req.body ?? {}) as { name?: unknown };
  if (typeof name !== "string" || name.trim().length === 0) {
    return res.status(400).json({ error: "name (non-empty string) is required" });
  }
  const trimmed = name.trim();
  if (trimmed.length > 32) {
    return res.status(400).json({ error: "name must be 32 characters or fewer" });
  }

  try {
    const character = await createCharacter({ userId, name: trimmed });
    res.status(201).json(character);
  } catch (err: any) {
    if (err instanceof CharacterAlreadyExistsError) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /character — soft-delete the user's own character (clears link/link-code, keeps history). */
characterRouter.delete("/", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;
  try {
    await softDeleteCharacter(userId);
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof NoCharacterFoundError) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

/** POST /character/link-code — logged-in user requests a code to type in-game as `!link <code>`. */
characterRouter.post("/link-code", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;

  try {
    const { code, expiresAt } = await generateLinkCodeForUser(userId);
    res.json({ code, expiresAt });
  } catch (err: any) {
    if (err instanceof CharacterAlreadyLinkedError) {
      return res.status(409).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

/** GET /character/inventory — the logged-in user's own character's inventory. No RBAC needed: everyone can see their own items. */
characterRouter.get("/inventory", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;

  const { rows } = await pool.query(
    `SELECT id FROM characters WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "no character found for this user" });

  const items = await getInventory(rows[0].id);
  res.json({ characterId: rows[0].id, items });
});

/** GET /character/wallet — own character's money + recent ledger history. */
characterRouter.get("/wallet", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;

  const { rows } = await pool.query(
    `SELECT id FROM characters WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "no character found for this user" });

  const wallet = await getWalletAndHistory(rows[0].id);
  res.json({ characterId: rows[0].id, ...wallet });
});

/** GET /character/vehicles — own character's garage summary (read-only for the player web). */
characterRouter.get("/vehicles", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;

  const { rows } = await pool.query(
    `SELECT id FROM characters WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "no character found for this user" });

  const summary = await getVehicleGarage(rows[0].id);
  res.json({ characterId: rows[0].id, ...summary });
});