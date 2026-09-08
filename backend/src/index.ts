import { config } from "./config/index.js";
import { connectRedis } from "./cache/redis.js";
import { startSessionCleanupJob } from "./modules/auth/index.js";
import { startExpiryJob } from "./modules/trade/index.js";
import { startSecurityEventRetentionJob } from "./modules/security/index.js";
import { startIdempotencyRetentionJob } from "./modules/idempotency/index.js";
import { createApp } from "./app.js";

async function main() {
  await connectRedis();
  startExpiryJob(); // periodic: marks pending trades older than 24h as expired
  startSessionCleanupJob(); // periodic: deletes expired/revoked sessions rows
  // periodic (daily): stop security_events / idempotency_keys from growing forever
  startSecurityEventRetentionJob(config.SECURITY_EVENT_RETENTION_DAYS);
  startIdempotencyRetentionJob(config.IDEMPOTENCY_KEY_RETENTION_DAYS);
  const app = createApp();
  const server = app.listen(config.PORT, () => {
    console.log(`[backend] listening on :${config.PORT} (${config.NODE_ENV})`);
  });
  // Fail fast on slow/stuck handlers instead of holding connections open
  // indefinitely (Node's default is 5 minutes).
  server.requestTimeout = 30_000;
  server.timeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
}

// ES module top-level await is available; but keep the explicit catch for a
// clean fatal-startup message instead of an unhandled rejection.
main().catch((err) => {
  console.error("[backend] fatal startup error", err);
  process.exit(1);
});