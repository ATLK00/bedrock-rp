// ---------------------------------------------------------------------------
// Admin Control API (`/control`) — the single external surface for the future
// admin EXE, admin web panel and AI/automation. Contrast with `/admin`:
//
//   /admin  = browser session (JWT cookie) + RBAC on the logged-in user.
//   /bridge = behavior pack (shared secret + HMAC signature).
//   /control= machine-to-machine (strong API key, x-control-api-key header).
//
// Rule from the roadmap: EXE / Web Admin / AI never touch PostgreSQL/Redis/BDS
// directly — everything goes through this API into the backend services.
// Surface (roadmap #3 #4 #5 #6):
//   observability  /ping /status /players /audit /security/events /health
//   resources      /resources*             (registered resources + verbs)
//   backup         /backups*  /wipe/*      (backup/verify/restore + wipe)
//   monitoring     /monitoring             (dashboard snapshot)
//   overview       /overview               (every-domain count snapshot)
//
// Auth: single CONTROL_API_KEY (config, min 16 chars), compared constant-time.
// Wrong/missing key -> HIGH security event + 401. Attribution: optional
// `x-control-actor-user-id` header names the staff user performing the call
// (validated to exist) so control actions are traceable to a person in the
// audit log even though authorization is the API key, not a session. A call
// that carries no actor header is recorded as the API key itself (system).
//
// Per-request auditing: read-only GETs are NOT individually audited (status
// polling would flood audit_log). A call IS audited when it carries the
// actor-attribution header — "who used the control API" — and every mutating
// verb (resources register/update/restart/..., backup create/restore, wipe)
// writes its own action row.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "../../db/pool.js";
import { redis } from "../../cache/redis.js";
import { config } from "../../config/index.js";
import { writeAudit } from "../../audit/index.js";
import { emitSecurityEvent, listSecurityEvents } from "../security/index.js";
import * as playerSession from "../player_session/index.js";
import { appVersion, ctl, parseLimitOffset, qstr, requestIdOf } from "./common.js";
import { resourceRouter } from "./resourceManager.js";
import { backupRouter } from "./backupManager.js";
import { monitoringRouter } from "./monitoring.js";
import { overviewRouter } from "./overview.js";

export const controlRouter = Router();

/** Constant-time key comparison — never leak timing on a wrong key length/shape. */
function keyMatches(provided: string | undefined): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(config.CONTROL_API_KEY, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Middleware: API key auth + optional actor attribution
// ---------------------------------------------------------------------------

controlRouter.use(async (req, res, next) => {
  if (!keyMatches(req.header("x-control-api-key"))) {
    // Security Center: a bad API key is either a misconfigured client or an
    // attacker probing the control plane — HIGH either way, staff sees it.
    emitSecurityEvent({
      eventType: "control_invalid_key",
      severity: "HIGH",
      ip: req.ip ?? null,
      requestId: requestIdOf(req),
      payload: { path: req.path },
    }).catch(() => {});
    return res.status(401).json({ ok: false, error: "invalid control API key" });
  }

  const actorHeader = req.header("x-control-actor-user-id");
  let actorUserId: number | null = null;
  if (actorHeader !== undefined && actorHeader !== "") {
    if (!/^\d+$/.test(actorHeader)) {
      return res.status(400).json({ ok: false, error: "x-control-actor-user-id must be a numeric user id" });
    }
    actorUserId = Number(actorHeader);
    const { rows } = await pool.query(`SELECT id FROM users WHERE id = $1 LIMIT 1`, [actorUserId]);
    if (rows.length === 0) {
      return res.status(400).json({ ok: false, error: "x-control-actor-user-id is not a known user" });
    }
  }

  (req as unknown as { controlActorUserId: number | null }).controlActorUserId = actorUserId;

  // Only audit calls that carry an actor — those are a named person acting
  // through the control API, which is exactly what the audit trail is for.
  if (actorUserId !== null) {
    try {
      await writeAudit({
        actorUserId,
        action: "control.call",
        targetType: "route",
        targetId: req.path,
        payload: { method: req.method },
        result: "success",
        requestId: requestIdOf(req),
      });
    } catch (err) {
      console.error(`[control] audit write failed: ${err}`);
    }
  }

  next();
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Liveness for the control client: proves key, server identity and clock. */
controlRouter.get(
  "/ping",
  ctl(async () => ({
    ok: true,
    app: "bedrock-rp-backend",
    version: appVersion,
    serverTime: new Date().toISOString(),
  }))
);

/** Full process + dependency + presence snapshot for the monitoring client. */
controlRouter.get(
  "/status",
  ctl(async () => {
    const dbStart = Date.now();
    let dbOk = false;
    let dbLatencyMs: number | null = null;
    try {
      await pool.query("SELECT 1");
      dbOk = true;
      dbLatencyMs = Date.now() - dbStart;
    } catch {
      dbLatencyMs = null;
    }

    const redisStart = Date.now();
    let redisOk = false;
    let redisLatencyMs: number | null = null;
    try {
      await redis.ping();
      redisOk = true;
      redisLatencyMs = Date.now() - redisStart;
    } catch {
      redisLatencyMs = null;
    }

    let onlinePlayers: Awaited<ReturnType<typeof playerSession.listOnlinePlayers>> = [];
    try {
      onlinePlayers = await playerSession.listOnlinePlayers();
    } catch (err) {
      console.error(`[control] presence read failed: ${err}`);
    }

    const memory = process.memoryUsage();
    return {
      ok: dbOk && redisOk,
      app: "bedrock-rp-backend",
      version: appVersion,
      process: {
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        node: process.version,
        memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
      },
      dependencies: {
        database: { ok: dbOk, latencyMs: dbLatencyMs },
        redis: { ok: redisOk, latencyMs: redisLatencyMs },
      },
      onlinePlayerCount: onlinePlayers.length,
      onlinePlayers: onlinePlayers.map((p) => ({
        playerName: p.playerName,
        persistentId: p.persistentId,
        characterId: p.characterId,
      })),
    };
  })
);

/** Characters with live presence overlay (isOnline from Redis, not just DB). */
controlRouter.get(
  "/players",
  ctl(async (req) => {
    const query = typeof req.query.query === "string" ? req.query.query.trim() : null;
    const { limit, offset } = parseLimitOffset(req, 50);

    let onlineByPersistentId = new Map<string, boolean>();
    try {
      const online = await playerSession.listOnlinePlayers();
      onlineByPersistentId = new Map(online.map((p) => [p.persistentId, true]));
    } catch {
      // presence read failed — report everyone as offline rather than failing the call
    }

    const params: unknown[] = [];
    let where = `1 = 1`;
    if (query) {
      params.push(`%${query}%`);
      where += ` AND c.name ILIKE $${params.length}`;
    }
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT c.id, c.user_id, c.name, c.whitelisted, c.persistent_id, c.is_deleted,
              c.created_at, c.last_seen_at, u.discord_tag
       FROM characters c
       JOIN users u ON u.id = c.user_id
       WHERE ${where}
       ORDER BY c.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const players = rows.map((r: any) => ({
      id: Number(r.id),
      userId: r.user_id == null ? null : Number(r.user_id),
      name: r.name,
      whitelisted: r.whitelisted,
      persistentId: r.persistent_id,
      isDeleted: r.is_deleted,
      discordTag: r.discord_tag,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
      isOnline: r.persistent_id ? onlineByPersistentId.has(r.persistent_id) : false,
    }));
    return { ok: true, count: players.length, players };
  })
);

/** Recent audit tail — the "recent admin actions" feed for monitoring. */
controlRouter.get(
  "/audit",
  ctl(async (req) => {
    const { limit, offset } = parseLimitOffset(req, 50);
    const actionQ = qstr(req.query.action);
    const action = actionQ && actionQ.trim() ? actionQ.trim() : null;
    const actorQ = qstr(req.query.actorUserId);
    const actorUserId = actorQ && /^\d+$/.test(actorQ) ? Number(actorQ) : null;

    const params: unknown[] = [];
    let where = `1 = 1`;
    if (action) {
      params.push(action);
      where += ` AND action ILIKE '%' || $${params.length} || '%'`;
    }
    if (actorUserId !== null) {
      params.push(actorUserId);
      where += ` AND actor_user_id = $${params.length}`;
    }
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT id, actor_user_id, action, target_type, target_id, payload, result, request_id, created_at
       FROM audit_log
       WHERE ${where}
       ORDER BY id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const audit = rows.map((r: any) => ({
      id: Number(r.id),
      actorUserId: r.actor_user_id == null ? null : Number(r.actor_user_id),
      action: r.action,
      targetType: r.target_type ?? null,
      targetId: r.target_id ?? null,
      payload: r.payload,
      result: r.result,
      requestId: r.request_id ?? null,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
    return { ok: true, count: audit.length, audit };
  })
);

/** Security Center tail for the monitoring client (unresolved first). */
controlRouter.get(
  "/security/events",
  ctl(async (req) => {
    const { limit, offset } = parseLimitOffset(req, 50);
    const severityQ = qstr(req.query.severity);
    const severity =
      severityQ &&
      ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(severityQ.toUpperCase())
        ? (severityQ.toUpperCase() as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL")
        : null;
    const ackQ = qstr(req.query.acknowledged);
    const acknowledged =
      ackQ === "true" ? true : ackQ === "false" ? false : null;
    const rows = await listSecurityEvents({ limit, offset, severity, acknowledged });
    return { ok: true, count: rows.length, events: rows };
  })
);

/** Readiness probe — mirrors /health/ready, key-authenticated for the EXE. */
controlRouter.get(
  "/health",
  ctl(async () => {
    let dbOk = false;
    try {
      await pool.query("SELECT 1");
      dbOk = true;
    } catch {
      dbOk = false;
    }
    let redisOk = false;
    try {
      await redis.ping();
      redisOk = true;
    } catch {
      redisOk = false;
    }
    return {
      ok: dbOk && redisOk,
      checks: {
        database: dbOk ? "ok" : "degraded",
        redis: redisOk ? "ok" : "degraded",
      },
    };
  })
);

// ---------------------------------------------------------------------------
// Sub-surfaces (roadmap #4 #5 #6) — mounted after the auth middleware above,
// so every route below is key-authenticated + actor-attributable.
// ---------------------------------------------------------------------------

controlRouter.use(resourceRouter);
controlRouter.use(backupRouter);
controlRouter.use(monitoringRouter);
controlRouter.use(overviewRouter);