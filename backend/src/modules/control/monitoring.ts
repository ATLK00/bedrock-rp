// Monitoring (#6) — /control/monitoring
// One aggregated, on-demand snapshot for the admin EXE / web dashboard:
// OS (cpu/ram/disk), process, dependency health, live players, error rate,
// Security Center tail, economy anomalies and the recent admin-action feed.
// Computed on request (no background sampling in v1 — a cheap read on a
// lightweight dashboard; rolling metrics + alerts are a later round).

import { Router } from "express";
import os from "node:os";
import { statfsSync } from "node:fs";
import { pool } from "../../db/pool.js";
import { redis } from "../../cache/redis.js";
import { ctl } from "./common.js";
import * as playerSession from "../player_session/index.js";

export const monitoringRouter = Router();

monitoringRouter.get(
  "/monitoring",
  ctl(async () => {
    // dependency health
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

    // live players (Redis presence, never a PK-graph scan)
    let online: Awaited<ReturnType<typeof playerSession.listOnlinePlayers>> = [];
    try {
      online = await playerSession.listOnlinePlayers();
    } catch {
      // presence read failed — report zero rather than failing the dashboard
    }

    // error rate (last hour)
    const auditFailures = (
      await pool.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE result = 'failure' AND created_at > now() - interval '1 hour'`
      )
    ).rows[0].n;
    const serverErrors = (
      await pool.query(
        `SELECT count(*)::int AS n FROM security_events WHERE event_type = 'server_error' AND created_at > now() - interval '1 hour'`
      )
    ).rows[0].n;

    // security center
    const openHigh = (
      await pool.query(
        `SELECT count(*)::int AS n FROM security_events WHERE acknowledged_at IS NULL AND severity IN ('HIGH','CRITICAL')`
      )
    ).rows[0].n;
    const openTotal = (
      await pool.query(`SELECT count(*)::int AS n FROM security_events WHERE acknowledged_at IS NULL`)
    ).rows[0].n;
    const recentSecurity = (
      await pool.query(
        `SELECT id, event_type, severity, actor_user_id, target_id, acknowledged_at, created_at
         FROM security_events ORDER BY id DESC LIMIT 10`
      )
    ).rows;

    // economy anomalies (unresolved)
    const openAnomalies = (
      await pool.query(
        `SELECT count(*)::int AS n FROM security_events WHERE event_type = 'economy_anomaly' AND acknowledged_at IS NULL`
      )
    ).rows[0].n;
    const recentAnomalies = (
      await pool.query(
        `SELECT id, event_type, severity, payload, acknowledged_at, created_at
         FROM security_events WHERE event_type = 'economy_anomaly' ORDER BY id DESC LIMIT 5`
      )
    ).rows;

    // recent admin actions = audit tail
    const recentActions = (
      await pool.query(
        `SELECT id, actor_user_id, action, target_type, target_id, result, created_at
         FROM audit_log ORDER BY id DESC LIMIT 20`
      )
    ).rows;

    // OS + process
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    let disk: { freeBytes: number | null; usedBytes: number | null; usedPercent: number | null } = {
      freeBytes: null,
      usedBytes: null,
      usedPercent: null,
    };
    try {
      const s = statfsSync(process.cwd());
      disk = {
        freeBytes: s.bavail * s.bsize,
        usedBytes: (s.blocks - s.bfree) * s.bsize,
        usedPercent: s.blocks > 0 ? Math.round(((s.blocks - s.bfree) / s.blocks) * 100) : null,
      };
    } catch {
      // statfs unsupported on this platform/version — leave disk null
    }
    const mem = process.memoryUsage();

    const toIso = (d: any) => (d ? new Date(d).toISOString() : null);

    return {
      ok: dbOk && redisOk,
      generatedAt: new Date().toISOString(),
      process: {
        pid: process.pid,
        node: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
      },
      system: {
        cpuLoad: os.loadavg().map((n) => Number(n.toFixed(2))),
        hostUptimeSeconds: Math.floor(os.uptime()),
        memory: {
          totalBytes: totalMem,
          freeBytes: freeMem,
          usedPercent: totalMem > 0 ? Math.round((1 - freeMem / totalMem) * 100) : null,
        },
        disk,
      },
      services: {
        database: { ok: dbOk, latencyMs: dbLatencyMs },
        redis: { ok: redisOk, latencyMs: redisLatencyMs },
      },
      playersOnline: {
        count: online.length,
        players: online.map((p) => ({ playerName: p.playerName, persistentId: p.persistentId, characterId: p.characterId })),
      },
      errorRate: {
        auditFailuresLastHour: auditFailures,
        serverErrorsLastHour: serverErrors,
        totalLastHour: auditFailures + serverErrors,
      },
      security: {
        openHighAlerts: openHigh,
        openTotal,
        recent: recentSecurity.map((r: any) => ({
          id: Number(r.id),
          eventType: r.event_type,
          severity: r.severity,
          acknowledged: r.acknowledged_at !== null,
          createdAt: toIso(r.created_at),
        })),
      },
      economy: {
        openAnomalies,
        recent: recentAnomalies.map((r: any) => ({
          id: Number(r.id),
          eventType: r.event_type,
          severity: r.severity,
          amountCents: Number.isFinite(Number(r.payload?.amountCents)) ? Number(r.payload.amountCents) : null,
          acknowledged: r.acknowledged_at !== null,
          createdAt: toIso(r.created_at),
        })),
      },
      recentAdminActions: recentActions.map((r: any) => ({
        id: Number(r.id),
        actorUserId: r.actor_user_id == null ? null : Number(r.actor_user_id),
        action: r.action,
        targetType: r.target_type ?? null,
        targetId: r.target_id ?? null,
        result: r.result,
        createdAt: toIso(r.created_at),
      })),
    };
  })
);