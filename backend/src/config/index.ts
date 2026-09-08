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
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
