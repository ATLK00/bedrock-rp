import express from "express";
import cookieParser from "cookie-parser";
import { config } from "./config/index.js";
import { adminRouter } from "./modules/admin/index.js";
import { authRouter } from "./modules/auth/routes.js";
import { sessionMiddleware } from "./modules/auth/index.js";
import { bridgeRouter } from "./modules/bridge/index.js";
import { characterRouter } from "./modules/character/routes.js";
import { tradeRouter } from "./modules/trade/routes.js";
import { shopRouter } from "./modules/shop/routes.js";
import { authLimiter, bridgeLimiter, adminLimiter } from "./middleware/rateLimit.js";
import { requestLogger } from "./middleware/logging.js";
import { verifyBridgeSignature, BridgeSignatureError } from "./modules/bridge/signature.js";

/**
 * Builds the Express app without starting a server or connecting to
 * anything — importing this has no side effects, which is what makes
 * integration tests possible (createApp().listen(0) in a test).
 */
export function createApp(): express.Express {
  const app = express();

  // Must be set before any middleware that reads req.ip (rate limiting,
  // audit logging) — see config/index.ts's TRUST_PROXY comment.
  const trustProxySetting: boolean | number | string =
    config.TRUST_PROXY === "true"
      ? true
      : config.TRUST_PROXY === "false"
      ? false
      : /^\d+$/.test(config.TRUST_PROXY)
      ? Number(config.TRUST_PROXY)
      : config.TRUST_PROXY;
  app.set("trust proxy", trustProxySetting);

  app.use(requestLogger);

  // Capture the raw request body string so the bridge signature can be
  // verified byte-for-byte against what the behavior pack signed (the
  // parsed body alone is not enough — HMAC must cover the exact bytes).
  app.use(
    express.json({
      limit: "32kb",
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    })
  );
  app.use(cookieParser());
  app.use(sessionMiddleware); // sets req.userId when a valid session cookie is present; never rejects by itself

  /**
   * Bridge auth: shared secret + optional replay-protection signature.
   * See modules/bridge/signature.ts for the scheme. A legacy pack sending
   * only the secret still works (signature checks skipped, not required).
   */
  app.use("/bridge", async (req, res, next) => {
    const secret = req.header("x-bds-bridge-secret");
    if (secret !== config.BDS_BRIDGE_SECRET) {
      return res.status(401).json({ error: "invalid bridge secret" });
    }

    const sigHeadersPresent = [
      req.header("x-bds-ts"),
      req.header("x-bds-nonce"),
      req.header("x-bds-sig"),
    ].every((h) => h !== undefined);
    if (!sigHeadersPresent) {
      return next(); // legacy client (shared secret only) — accepted
    }

    try {
      await verifyBridgeSignature({
        secret: config.BDS_BRIDGE_SECRET,
        ts: req.header("x-bds-ts"),
        nonce: req.header("x-bds-nonce"),
        sig: req.header("x-bds-sig"),
        rawBody: (req as unknown as { rawBody?: string }).rawBody ?? "",
      });
      next();
    } catch (err: any) {
      if (err instanceof BridgeSignatureError) {
        return res.status(401).json({ error: "invalid bridge signature" });
      }
      next(err); // let the global error handler deal with unexpected failures
    }
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/auth", authLimiter, authRouter);
  app.use("/character/link-code", adminLimiter); // reuse the moderate tier — session-authenticated, not the tightest surface
  app.use("/character", characterRouter);
  app.use("/trade", adminLimiter, tradeRouter);
  app.use("/shop", adminLimiter, shopRouter);
  app.use("/bridge", bridgeLimiter, bridgeRouter);
  app.use("/admin", adminLimiter, adminRouter);

  // Global error handler — last line of defense.
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err && typeof err.status === "number" ? err.status : 500;
    const requestId = (req as unknown as { requestId?: string }).requestId ?? "unknown";
    if (status >= 500) {
      console.error(`[error] ${requestId}:`, err);
    }
    if (res.headersSent) {
      return res.end();
    }
    res.status(status).json({
      error: status >= 500 ? "internal error" : err?.message ?? "bad request",
      requestId,
    });
  });

  return app;
}