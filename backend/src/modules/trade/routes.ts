import { Router } from "express";
import { pool } from "../../db/pool.js";
import * as trade from "./index.js";

export const tradeRouter = Router();

/** Every route here resolves "my character" from the session — never trust a client-supplied character id as "mine". */
async function getOwnCharacterId(userId: number): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT id FROM characters WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );
  return rows[0]?.id ?? null;
}

tradeRouter.post("/propose", async (req, res) => {
  const userId = req.userId as number | undefined;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const myCharacterId = await getOwnCharacterId(userId);
  if (!myCharacterId) return res.status(404).json({ error: "no character found for this user" });

  const { counterpartyCharacterId, give, want } = req.body ?? {};
  if (typeof counterpartyCharacterId !== "number") {
    return res.status(400).json({ error: "counterpartyCharacterId (number) is required" });
  }

  try {
    const result = await trade.proposeTrade({
      initiatorId: myCharacterId,
      counterpartyId: counterpartyCharacterId,
      initiatorGives: give ?? {},
      initiatorWants: want ?? {},
      actorUserId: userId,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

tradeRouter.post("/:id/accept", async (req, res) => {
  const userId = req.userId as number | undefined;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const myCharacterId = await getOwnCharacterId(userId);
  if (!myCharacterId) return res.status(404).json({ error: "no character found for this user" });

  const tradeId = Number(req.params.id);
  try {
    await trade.acceptTrade({ tradeId, callerCharacterId: myCharacterId, actorUserId: userId });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof trade.TradeNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof trade.NotYourTradeError) return res.status(403).json({ error: err.message });
    if (err instanceof trade.InsufficientFundsError || err instanceof trade.InsufficientItemsError) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

tradeRouter.post("/:id/decline", async (req, res) => {
  const userId = req.userId as number | undefined;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const myCharacterId = await getOwnCharacterId(userId);
  if (!myCharacterId) return res.status(404).json({ error: "no character found for this user" });

  try {
    await trade.declineTrade({ tradeId: Number(req.params.id), callerCharacterId: myCharacterId, actorUserId: userId });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof trade.TradeNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof trade.NotYourTradeError) return res.status(403).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

tradeRouter.post("/:id/cancel", async (req, res) => {
  const userId = req.userId as number | undefined;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const myCharacterId = await getOwnCharacterId(userId);
  if (!myCharacterId) return res.status(404).json({ error: "no character found for this user" });

  try {
    await trade.cancelTrade({ tradeId: Number(req.params.id), callerCharacterId: myCharacterId, actorUserId: userId });
    res.status(204).end();
  } catch (err: any) {
    if (err instanceof trade.TradeNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof trade.NotYourTradeError) return res.status(403).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

tradeRouter.get("/pending", async (req, res) => {
  const userId = req.userId as number | undefined;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const myCharacterId = await getOwnCharacterId(userId);
  if (!myCharacterId) return res.status(404).json({ error: "no character found for this user" });

  const trades = await trade.listPendingTradesForCharacter(myCharacterId);
  res.json({ characterId: myCharacterId, trades });
});
