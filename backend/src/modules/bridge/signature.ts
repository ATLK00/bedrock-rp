import { createHmac } from "node:crypto";
import { redis } from "../../cache/redis.js";
import { config } from "../../config/index.js";

/**
 * Bridge request signature (replay protection on top of the static shared
 * secret). The behavior pack sends three extra headers with every bridge
 * call:
 *   x-bds-ts     — ms epoch at send time
 *   x-bds-nonce  — a fresh per-request random value
 *   x-bds-sig    — hex HMAC-SHA256(secret, `${ts}\n${nonce}\n${rawBody}`)
 *
 * The backend rejects requests whose signature is bad, too old (drift >
 * BRIDGE_SIG_DRIFT_SECONDS), or whose nonce was already seen (the Redis
 * SET NX EX check below) — the last one makes a captured request
 * unreplayable even inside the drift window.
 *
 * A client that sends only the shared secret (older behavior pack) is
 * still accepted without these checks, so upgrading the pack is
 * non-breaking for the protocol.
 */

export function signBridgeRequest(secret: string, ts: string, nonce: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${ts}\n${nonce}\n${rawBody}`).digest("hex");
}

export class BridgeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    // Subclassed Errors don't inherit the class name as `name` in V8 (it
    // stays "Error"), so set it explicitly — app.ts matches on it.
    this.name = "BridgeSignatureError";
  }
}

/**
 * Validate all three signature headers against a captured raw body.
 * Throws BridgeSignatureError on any failure. Call only when the headers
 * are present — absence means a legacy client.
 */
export async function verifyBridgeSignature(params: {
  secret: string;
  ts: string | undefined;
  nonce: string | undefined;
  sig: string | undefined;
  rawBody: string;
}): Promise<void> {
  const { secret, ts, nonce, sig, rawBody } = params;
  if (!ts || !nonce || !sig) {
    throw new BridgeSignatureError("incomplete signature headers");
  }
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) {
    throw new BridgeSignatureError("bad x-bds-ts");
  }
  const driftSeconds = Math.abs(Date.now() - tsNum) / 1000;
  if (driftSeconds > config.BRIDGE_SIG_DRIFT_SECONDS) {
    throw new BridgeSignatureError("stale timestamp");
  }
  const expected = signBridgeRequest(secret, ts, nonce, rawBody);
  if (expected !== sig || sig.length !== expected.length) {
    throw new BridgeSignatureError("signature mismatch");
  }
  // Exact-replay rejection: remember this nonce for a short window. If it
  // was already seen (SET returned null = key already existed), reject.
  let seen = false;
  try {
    const setResult = await redis.set(`bedrock-rp:bridge:nonce:${nonce}`, "1", {
      NX: true,
      EX: config.BRIDGE_NONCE_TTL_SECONDS,
    });
    seen = setResult === null;
  } catch {
    // Redis unavailable — replay cache is best-effort; signature + drift
    // checks above still hold. Do not fail the request here.
  }
  if (seen) {
    throw new BridgeSignatureError("replayed nonce");
  }
}