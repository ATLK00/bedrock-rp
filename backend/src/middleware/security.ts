import type { NextFunction, Request, Response } from "express";
import { config } from "../config/index.js";

/**
 * API / browser security layer:
 *  - security headers on every response,
 *  - CORS negotiated ONLY against the configured allowlist (with
 *    credentials) — anything else stays same-origin,
 *  - a normalized error body for malformed JSON instead of the raw
 *    express body-parser HTML/stack output, and no internal detail leak.
 */

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  if (config.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
}

const allowedOrigins = config.CORS_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function cors(req: Request, res: Response, next: NextFunction) {
  const origin = req.header("origin");
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Idempotency-Key,X-Request-Id");
    res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
  }

  if (req.method === "OPTIONS") {
    // Preflight passes only if the origin was allowlisted above.
    return origin && allowedOrigins.includes(origin)
      ? res.status(204).end()
      : res.status(403).json({ error: "cross-origin requests are not allowed", code: "cors_origin_not_allowed" });
  }
  next();
}

/**
 * express.json() hands body-parse failures (limit exceeded, invalid JSON)
 * to the error handler with a status of 400 (limit) or throws a
 * SyntaxError with status 400. Normalize both into our standard error
 * shape and never leak internal detail.
 */
export function jsonParseError(
  err: any,
  _req: Request,
  res: Response,
  next: NextFunction
) {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "request body too large", code: "request_body_too_large" });
  }
  if (err instanceof SyntaxError && (err as any).status === 400) {
    return res.status(400).json({ error: "malformed JSON body", code: "invalid_json" });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "malformed JSON body", code: "invalid_json" });
  }
  next(err);
}