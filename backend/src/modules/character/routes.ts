import { Router } from "express";
import { pool } from "../../db/pool.js";
import { generateLinkCodeForUser, CharacterAlreadyLinkedError } from "./index.js";
import { getInventory } from "../inventory/index.js";

export const characterRouter = Router();

/** POST /character/link-code — logged-in user requests a code to type in-game as `/link <code>`. */
characterRouter.post("/link-code", async (req, res) => {
  const userId = req.userId as number | undefined;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });

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
  const userId = req.userId as number | undefined;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });

  const { rows } = await pool.query(
    `SELECT id FROM characters WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "no character found for this user" });

  const items = await getInventory(rows[0].id);
  res.json({ characterId: rows[0].id, items });
});
