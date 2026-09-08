import { Router } from "express";
import { pool } from "../../db/pool.js";
import * as shop from "./index.js";

export const shopRouter = Router();

async function getOwnCharacterId(userId: number): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT id FROM characters WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  return rows[0]?.id ?? null;
}

shopRouter.get("/catalog", async (_req, res) => {
  const catalog = await shop.getCatalog();
  res.json({ catalog });
});

shopRouter.post("/buy", async (req, res) => {
  const userId = req.userId as number | undefined;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const myCharacterId = await getOwnCharacterId(userId);
  if (!myCharacterId) return res.status(404).json({ error: "no character found for this user" });

  const { itemId, quantity } = req.body ?? {};
  if (!itemId || typeof quantity !== "number") {
    return res.status(400).json({ error: "itemId (string) and quantity (number) are required" });
  }

  try {
    await shop.buyItem({ characterId: myCharacterId, itemId, quantity, actorUserId: userId });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof shop.ItemNotListedError || err instanceof shop.NotPurchasableError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof shop.OutOfStockError || err instanceof shop.InsufficientFundsError) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

shopRouter.post("/sell", async (req, res) => {
  const userId = req.userId as number | undefined;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const myCharacterId = await getOwnCharacterId(userId);
  if (!myCharacterId) return res.status(404).json({ error: "no character found for this user" });

  const { itemId, quantity } = req.body ?? {};
  if (!itemId || typeof quantity !== "number") {
    return res.status(400).json({ error: "itemId (string) and quantity (number) are required" });
  }

  try {
    await shop.sellItem({ characterId: myCharacterId, itemId, quantity, actorUserId: userId });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof shop.ItemNotListedError || err instanceof shop.NotSellableError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof shop.InsufficientItemsError) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});
