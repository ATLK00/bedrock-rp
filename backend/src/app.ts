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
import { casesRouter } from "./modules/cases/routes.js";
import { inventoryRouter } from "./modules/inventory/routes.js";
import { authLimiter, bridgeLimiter, adminLimiter } from "./middleware/rateLimit.js";
import { playerWebRouter } from "./web/playerWeb.js";
import { adminWebRouter } from "./web/adminWeb.js";
import { requestLogger } from "./middleware/logging.js";
import { securityHeaders, cors, jsonParseError } from "./middleware/security.js";
import { verifyBridgeSignature, BridgeSignatureError } from "./modules/bridge/signature.js";
import { emitSecurityEvent } from "./modules/security/index.js";

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
  app.use(securityHeaders);
  app.use(cors);

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
      emitSecurityEvent({
        eventType: "bridge_invalid_secret",
        severity: "HIGH",
        ip: req.ip ?? null,
        requestId: (req as unknown as { requestId?: string }).requestId ?? null,
        payload: { path: req.path },
      }).catch(() => {});
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
        // Security Center: a failed signature is either an attacker or a
        // broken client — either way staff should be able to see it.
        const msg: string = err?.message ?? "signature failure";
        emitSecurityEvent({
          eventType: msg === "replayed nonce" ? "bridge_replay" : "bridge_invalid_signature",
          severity: msg === "replayed nonce" ? "HIGH" : "MEDIUM",
          ip: req.ip ?? null,
          requestId: (req as unknown as { requestId?: string }).requestId ?? null,
          payload: { detail: msg, path: req.path },
        }).catch(() => {});
        return res.status(401).json({ error: "invalid bridge signature" });
      }
      next(err); // let the global error handler deal with unexpected failures
    }
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      const { pool } = await import("./db/pool.js");
      await pool.query("SELECT 1");
      const { redis } = await import("./cache/redis.js");
      await redis.ping();
      res.json({ status: "ok", checks: { db: "ok", redis: "ok" } });
    } catch (err) {
      res.status(503).json({ status: "degraded", error: "dependency check failed" });
    }
  });

  app.use("/auth", authLimiter, authRouter);
  app.use("/character/link-code", adminLimiter); // reuse the moderate tier — session-authenticated, not the tightest surface
  app.use("/character", characterRouter);
  app.use("/trade", adminLimiter, tradeRouter);
  app.use("/shop", adminLimiter, shopRouter);
  app.use("/cases", adminLimiter, casesRouter);
  app.use("/inventories", adminLimiter, inventoryRouter);
  app.use("/bridge", bridgeLimiter, bridgeRouter);

  // Admin console (static SPA) mounted BEFORE the rate-limited adminRouter so
  // the page/assets bypass the limiter; every data call still hits the
  // limited + RBAC-guarded /admin JSON routes below.
  app.use("/admin", adminWebRouter);
  app.use("/admin", adminLimiter, adminRouter);

  // Player-facing web. Mounted after the JSON/routers (same-origin, no
  // rate limit — it's static + reuses the session-authenticated routes).
  app.use("/player", playerWebRouter);
  app.get("/", (_req, res) => res.redirect("/player"));

  // Normalize body-parse failures (invalid JSON, body too large) before the
  // generic handler so they get our standard error shape, not HTML/stack.
  app.use(jsonParseError);

  // Global error handler — last line of defense.
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err && typeof err.status === "number" ? err.status : 500;
    const requestId = (req as unknown as { requestId?: string }).requestId ?? "unknown";
    if (status >= 500) {
      console.error(`[error] ${requestId}:`, err);
      // Security Center: unexpected server errors are worth surfacing.
      emitSecurityEvent({
        eventType: "server_error",
        severity: "MEDIUM",
        ip: req.ip ?? null,
        requestId: requestId === "unknown" ? null : requestId,
        payload: { path: req.path },
      }).catch(() => {});
    }
    if (res.headersSent) {
      return res.end();
    }
    res.status(status).json({
      error: status >= 500 ? "internal error" : err?.message ?? "bad request",
      code: status >= 500 ? "internal_error" : (err?.code as string | undefined) ?? "bad_request",
      requestId,
    });
  });

  return app;
}