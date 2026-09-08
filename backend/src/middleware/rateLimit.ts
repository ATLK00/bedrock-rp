import rateLimit from "express-rate-limit";

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
 */

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many auth attempts, try again later" },
});

export const bridgeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 120, // generous — a busy server with many concurrent players is legitimate
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "bridge rate limit exceeded" },
});

export const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests, slow down" },
});
