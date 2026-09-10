// Shared helpers for the /control surface (see modules/control/index.ts for
// the auth story). Extracted so the sub-routers (resources, backup/wipe,
// monitoring) get the same error convention, actor attribution and audit
// plumbing as the core endpoints.

import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { writeAudit } from "../../audit/index.js";
import { emitSecurityEvent } from "../security/index.js";

export const requestIdOf = (req: Request) =>
  (req as unknown as { requestId?: string }).requestId ?? null;

/** The validated actor user id set by the control auth middleware (null = bare key = system). */
export function controlActorOf(req: Request): number | null {
  return (req as unknown as { controlActorUserId?: number | null }).controlActorUserId ?? null;
}

export function qstr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseLimitOffset(req: Request, fallback: number) {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || fallback, 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return { limit, offset };
}

/** Error with an HTTP status — ctl renders it as `{ ok, error }` without logging or security events. */
export class ControlError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/** Express handler wrapper: JSON result, or a statused error / 500 + MEDIUM security event. */
export function ctl(handler: (req: Request) => Promise<Record<string, unknown>> | Record<string, unknown>, status = 200) {
  return async (req: Request, res: Response) => {
    try {
      res.status(status).json(await handler(req));
    } catch (err: any) {
      if (err && typeof err.status === "number") {
        if (res.headersSent) return res.end();
        return res.status(err.status).json({ ok: false, error: err.message });
      }
      console.error(`[control] ${requestIdOf(req) ?? "?"}:`, err);
      emitSecurityEvent({
        eventType: "control_handler_error",
        severity: "MEDIUM",
        ip: req.ip ?? null,
        requestId: requestIdOf(req),
        payload: { path: req.path },
      }).catch(() => {});
      if (res.headersSent) return res.end();
      res.status(500).json({ ok: false, error: "internal error" });
    }
  };
}

/** Audit a mutating control action. Attribution comes from the actor header; a bare
 * (key-only) call is recorded as actor NULL = "the control API key itself". */
export async function controlAudit(
  req: Request,
  action: string,
  targetId: string,
  opts: { result?: "success" | "failure"; before?: unknown; after?: unknown; reason?: string } = {}
) {
  const actor = controlActorOf(req);
  try {
    await writeAudit({
      actorUserId: actor,
      action,
      targetType: "control",
      targetId,
      payload: { via: "control" },
      result: opts.result ?? "success",
      requestId: requestIdOf(req),
      before: opts.before,
      after: opts.after,
      reason: opts.reason,
    });
  } catch (err) {
    console.error(`[control] audit write failed (${action}): ${err}`);
  }
  return actor;
}

let _appVersion = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  _appVersion = typeof pkg?.version === "string" && pkg.version ? pkg.version : "0.0.0";
} catch {
  // keep the fallback
}
export const appVersion = _appVersion;