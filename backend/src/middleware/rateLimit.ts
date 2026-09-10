import rateLimit from "express-rate-limit";
import type { Request } from "express";
import { emitSecurityEvent } from "../modules/security/index.js";
import { config } from "../config/index.js";
import type { SecuritySeverity } from "../eventbus/index.js";

/**
 * Three tiers, matched to how sensitive/abusable each route group is:
 *
 * - authLimiter: login/callback — the classic brute-force/credential-stuffing
 *   surface. Tight limit per IP.
 * - bridgeLimiter: called by the BDS behavior pack itself (shared-secret
 *   authenticated, not per-user) — generous, since a busy server with many
 *   players joining/linking in a short window is legitimate traffic, but
 *   still bounded so a misconfigured/compromised pack can't hammer the
 *   backend unboundedly.
 * - adminLimiter: authenticated admin actions — moderate. These already
 *   require a valid session + RBAC permission, so the main risk here is
 *   a compromised admin account or a buggy client retrying in a loop,
 *   not anonymous abuse.
 *
 * All three key on IP by default (express-rate-limit's standard
 * behavior). `app.set('trust proxy', ...)` is now configured from the
 * TRUST_PROXY env var (see config/index.ts + index.ts) — defaults to
 * "false" (no proxy). If deployed behind a reverse proxy/load
 * balancer, TRUST_PROXY must be set correctly or these will all key
 * on the proxy's IP instead of the real client's.
 *
 * Every trip also records a security event (HIGH for auth — that's
 * likely a brute-forcer; LOW for the API tiers — that's an abuser).
 */

function tripHandler(severity: SecuritySeverity, tier: string, message: string) {
  return (req: Request, res: import("express").Response) => {
    emitSecurityEvent({
      eventType: "rate_limit_exceeded",
      severity,
      ip: req.ip ?? null,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
      targetType: "tier",
      targetId: tier,
      payload: { path: req.path },
    }).catch(() => {});
    // The custom `handler` fully replaces express-rate-limit's default
    // response — it must always answer or call next(), otherwise a
    // throttled client hangs forever with no reply.
    if (res.headersSent) return res.end();
    res.status(429).json({ error: message });
  };
}

/**
 * authLimiter: login/callback — the classic brute-force/credential-stuffing
 * surface. Bucketed per login username when the request carries one (so one
 * account's failed guesses don't lock every admin behind the same IP / NAT),
 * falling back to per-IP for /auth routes without a username (Discord OAuth).
 * Successful logins never consume the bucket (`skipSuccessfulRequests`), so a
 * legit admin typing a password slowly can't accidentally lock themselves out.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: config.RATE_LIMIT_AUTH_MAX,
  keyGenerator: (req: Request) => {
    const username = (req.body as Record<string, unknown> | undefined)?.username;
    if (typeof username === "string" && username.trim().length > 0) {
      return `login:${username.trim().toLowerCase()}`;
    }
    return `ip:${req.ip ?? "unknown"}`;
  },
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many auth attempts, try again later" },
  handler: tripHandler("HIGH", "auth", "too many auth attempts, try again later"),
});

export const bridgeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: config.RATE_LIMIT_BRIDGE_MAX, // generous — a busy server with many concurrent players is legitimate
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "bridge rate limit exceeded" },
  handler: tripHandler("MEDIUM", "bridge", "bridge rate limit exceeded"),
});

export const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.RATE_LIMIT_ADMIN_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests, slow down" },
  handler: tripHandler("LOW", "admin", "too many requests, slow down"),
});

// controlLimiter: external /control admin API calls (API-key authenticated).
// Generous like the bridge tier — automation polls status legitimately — but
// still bounded so a stolen key can't brute-force or hammer unboundedly.
// MEDIUM: the API key screens out anonymous abuse; the residual risk is a
// compromised key being used at scale, which we want visibly flagged.
export const controlLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.RATE_LIMIT_CONTROL_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many control requests, slow down" },
  handler: tripHandler("MEDIUM", "control", "too many control requests, slow down"),
});
