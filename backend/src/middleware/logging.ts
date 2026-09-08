import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

/**
 * Adds a request id (echoes a client-supplied `x-request-id`, else mints
 * one), stamps it on the response header, and logs one line per request
 * on completion: requestId method path status duration. Kept tiny and
 * dependency-free on purpose.
 */
declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
    rawBody?: string;
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const inbound = req.header("x-request-id");
  req.requestId = inbound && inbound.length <= 128 ? inbound : randomUUID();
  res.setHeader("x-request-id", req.requestId);

  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    console.log(
      `[req] ${req.requestId} ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`
    );
  });
  next();
}