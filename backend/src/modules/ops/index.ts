// Server-ops surface for the admin web panel / desktop app (`/admin/ops`).
//
// The full ops toolbox (status/monitoring, backups, wipe, resources) lives in
// the Control API (`/control`, API-key auth) for the EXE and AI-automation.
// This module exposes the SAME handlers under a browser session instead:
// session cookie + role-based access instead of the shared key. That keeps
// the ops actions fully usable from the web panel and the desktop app while
// never shipping the CONTROL_API_KEY into a browser/frontend.
//
// RBAC: `ops.manage` (migration 033), or the `owner` role (bypasses all
// checks). Mounted at /admin/ops, behind adminLimiter, after the global
// sessionMiddleware so req.userId is available.
//
// Audit/safety semantics are inherited unchanged from the control handlers:
// backups/wipe/resources actions write their own audit rows and security
// events; read-only GETs are not individually audited.

import { Router } from "express";
import { pool } from "../../db/pool.js";
import { redis } from "../../cache/redis.js";
import { requirePermission } from "../../rbac/index.js";
import { resourceRouter } from "../control/resourceManager.js";
import { backupRouter } from "../control/backupManager.js";
import { monitoringRouter } from "../control/monitoring.js";
import { overviewRouter } from "../control/overview.js";
import * as playerSession from "../player_session/index.js";

export const opsRouter = Router();

// Everything below requires a logged-in staff member with ops rights.
opsRouter.use(requirePermission("ops.manage"));

// Reused control handlers attribute mutating actions via `controlActorOf(req)`.
// Under the session surface that is our logged-in staff user, so map it in —
// audit rows for app/web ops actions get the real operator, not NULL.
opsRouter.use((req, _res, next) => {
  (req as unknown as { controlActorUserId?: number | null }).controlActorUserId =
    req.userId ?? null;
  next();
});

opsRouter.get("/status", async (_req, res, next) => {
  try {
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
      console.error(`[ops] presence read failed: ${err}`);
    }

    const memory = process.memoryUsage();
    return res.json({
      ok: dbOk && redisOk,
      app: "bedrock-rp-backend",
      version: "0.1.0",
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
    });
  } catch (err) {
    next(err);
  }
});

// Reuse the exact control handlers (same routes relative to this mount point):
//   /admin/ops/monitoring   /admin/ops/overview
//   /admin/ops/backups*     /admin/ops/wipe/*
//   /admin/ops/resources*
opsRouter.use(backupRouter);
opsRouter.use(resourceRouter);
opsRouter.use(monitoringRouter);
opsRouter.use(overviewRouter);