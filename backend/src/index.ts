import express from "express";
import cookieParser from "cookie-parser";
import { config } from "./config/index.js";
import { connectRedis } from "./cache/redis.js";
import { adminRouter } from "./modules/admin/index.js";
import { authRouter } from "./modules/auth/routes.js";
import { sessionMiddleware, startSessionCleanupJob } from "./modules/auth/index.js";
import { bridgeRouter } from "./modules/bridge/index.js";
import { characterRouter } from "./modules/character/routes.js";
import { tradeRouter } from "./modules/trade/routes.js";
import { shopRouter } from "./modules/shop/routes.js";
import { startExpiryJob } from "./modules/trade/index.js";
import { authLimiter, bridgeLimiter, adminLimiter } from "./middleware/rateLimit.js";

const app = express();

// Must be set before any middleware that reads req.ip (rate limiting,
// audit logging) — see config/index.ts's TRUST_PROXY comment. Parses
// express's accepted formats: "true"/"false" -> boolean, a plain
// integer -> hop count, anything else -> passed through as-is (IP/CIDR
// list or a named preset like "loopback").
const trustProxySetting: boolean | number | string =
  config.TRUST_PROXY === "true"
    ? true
    : config.TRUST_PROXY === "false"
    ? false
    : /^\d+$/.test(config.TRUST_PROXY)
    ? Number(config.TRUST_PROXY)
    : config.TRUST_PROXY;
app.set("trust proxy", trustProxySetting);

app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware); // sets req.userId when a valid session cookie is present; never rejects by itself

/**
 * Bridge auth: every request coming from the BDS behavior pack
 * (@minecraft/server-net) must carry this header. This is a shared
 * secret, NOT per-user auth — it just proves the request came from our
 * own game server and not the open internet. Per-user auth (RBAC) is
 * separate and happens per-route via requirePermission().
 */
app.use("/bridge", (req, res, next) => {
  const secret = req.header("x-bds-bridge-secret");
  if (secret !== config.BDS_BRIDGE_SECRET) {
    return res.status(401).json({ error: "invalid bridge secret" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/auth", authLimiter, authRouter);
app.use("/character/link-code", adminLimiter); // reuse the moderate tier — session-authenticated, not the tightest surface
app.use("/character", characterRouter);
app.use("/trade", adminLimiter, tradeRouter); // reuse the moderate tier — session-authenticated player action, not the tightest surface
app.use("/shop", adminLimiter, shopRouter);
app.use("/bridge", bridgeLimiter, bridgeRouter);
app.use("/admin", adminLimiter, adminRouter); // req.userId now comes from sessionMiddleware; requirePermission() 401s if absent or unpermitted

async function main() {
  await connectRedis();
  startExpiryJob(); // periodic: marks pending trades older than 24h as expired
  startSessionCleanupJob(); // periodic: deletes expired/revoked sessions rows
  app.listen(config.PORT, () => {
    console.log(`[backend] listening on :${config.PORT} (${config.NODE_ENV})`);
  });
}

main().catch((err) => {
  console.error("[backend] fatal startup error", err);
  process.exit(1);
});
