import "dotenv/config";
import { z } from "zod";

// Fail fast on boot if config is missing/malformed, rather than
// failing later mid-transaction with an unclear error.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  PORT: z.coerce.number().default(8080),
  // Express `trust proxy` setting. Only matters when deployed behind a
  // reverse proxy/load balancer — otherwise rate limiting (see
  // middleware/rateLimit.ts) keys on the proxy's IP instead of the
  // real client's, making per-IP limits meaningless. Accepts express's
  // own formats: boolean ("true"/"false"), a hop count ("1"), or a
  // comma-separated list of IPs/CIDRs/hostnames ("loopback, 10.0.0.0/8").
  // Defaults to "false" (no proxy) — safe for direct/no-proxy deployments,
  // must be set explicitly before deploying behind any reverse proxy.
  TRUST_PROXY: z.string().default("false"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  BDS_BRIDGE_SECRET: z.string().min(16, "BDS_BRIDGE_SECRET must be at least 16 chars"),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  DISCORD_REDIRECT_URI: z.string().optional(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  // Player presence: how long a Redis "online" key stays valid without a
  // heartbeat. Should be a few seconds more than the behavior pack's
  // heartbeat interval (see behavior_pack/scripts/main.js) so a dropped
  // connection and a slow heartbeat are distinguishable from "online".
  PRESENCE_TTL_SECONDS: z.coerce.number().default(90),
  // Bridge signature replay protection window: |now - x-bds-ts| larger
  // than this is rejected as a stale/attacker-replayed request (only
  // enforced when the behavior pack sends x-bds-ts/nonce/sig headers;
  // a legacy client that sends only the shared secret still works).
  BRIDGE_SIG_DRIFT_SECONDS: z.coerce.number().default(300),
  // How long a seen x-bds-nonce is remembered (Redis SET NX EX) to
  // reject exact replays of a captured request.
  BRIDGE_NONCE_TTL_SECONDS: z.coerce.number().default(600),
  // Comma-separated browser origins allowed to call the session API with
  // credentials (e.g. "http://localhost:5173,https://rp.example.com").
  // CORS is only negotiated for requests that send an Origin header from
  // this list; everything else is treated same-origin. Empty = no
  // cross-origin access.
  CORS_ORIGINS: z.string().default(""),
  // A single credit at or above this many cents raises a HIGH severity
  // economy-anomaly security event (duplicated grants, compromised admin,
  // scaling bugs). Default 1,000,000 cents = 10,000 units of the 100-cent
  // base currency.
  ECONOMY_ANOMALY_THRESHOLD_CENTS: z.coerce.number().default(1_000_000),
  // Append-only tables that grow forever would sink a long-running server.
  // These two jobs sweep them (run daily at startup). Retention windows in
  // DAYS; acknowledged-only for security_events so unresolved threats are
  // never silently dropped.
  SECURITY_EVENT_RETENTION_DAYS: z.coerce.number().default(90),
  IDEMPOTENCY_KEY_RETENTION_DAYS: z.coerce.number().default(7),
  // Request throttling tiers (see middleware/rateLimit.ts). Per-window
  // max requests keyed by client IP. Overridable so a high-traffic
  // deployment can tune without a code change, and so the integration
  // suite (which legitimately fires hundreds of admin calls in one
  // window) can raise them in test env.
  RATE_LIMIT_AUTH_MAX: z.coerce.number().default(10),
  RATE_LIMIT_BRIDGE_MAX: z.coerce.number().default(120),
  RATE_LIMIT_ADMIN_MAX: z.coerce.number().default(60),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
