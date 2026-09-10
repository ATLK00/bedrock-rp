// Overview (#7 dashboard) — /control/overview
// The "check everything" snapshot for the admin EXE / console: one call that
// returns a count for every domain table in the project so a single overview
// screen shows the whole server at a glance. Complements /control/monitoring
// (OS/process/error-rate) with the domain facts (economy, inventory, vehicles,
// properties, police, ems, phone, cases, trades, shop, security, backups).
//
// Read-only. No audit row is written (like the other control GETs) — polling
// an overview screen must not flood audit_log.

import { Router } from "express";
import { pool } from "../../db/pool.js";
import { redis } from "../../cache/redis.js";
import { ctl } from "./common.js";
import * as playerSession from "../player_session/index.js";

export const overviewRouter = Router();

overviewRouter.get(
  "/overview",
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

    // live players (Redis presence, never a PK-graph scan)
    let online: Awaited<ReturnType<typeof playerSession.listOnlinePlayers>> = [];
    try {
      online = await playerSession.listOnlinePlayers();
    } catch {
      // presence read failed — report zero rather than failing the dashboard
    }

    // Everything in one snapshot: one round-trip, scalar counts + money sums.
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM users)                                             AS users,
        (SELECT count(*)::int FROM characters)                                        AS characters,
        (SELECT count(*)::int FROM characters WHERE is_deleted = false)               AS characters_active,
        (SELECT count(*)::int FROM wallets)                                           AS wallets,
        (SELECT coalesce(sum(balance_cents), 0)::bigint FROM wallets)                 AS cash_cents,
        (SELECT coalesce(sum(balance_cents), 0)::bigint FROM wallet_balances WHERE currency = 'bank')      AS bank_cents,
        (SELECT coalesce(sum(balance_cents), 0)::bigint FROM wallet_balances WHERE currency = 'red_money') AS red_money_cents,
        (SELECT count(*)::int FROM transactions)                                      AS transactions,
        (SELECT count(*)::int FROM security_events WHERE event_type = 'economy_anomaly' AND acknowledged_at IS NULL) AS economy_anomalies_open,
        (SELECT count(*)::int FROM items)                                             AS items,
        (SELECT count(*)::int FROM inventory_slots)                                   AS inventory_slots,
        (SELECT count(*)::int FROM inventories)                                       AS inventories,
        (SELECT count(*)::int FROM inventory_items)                                   AS inventory_items,
        (SELECT count(*)::int FROM vehicles)                                          AS vehicles,
        (SELECT count(*)::int FROM vehicles WHERE status = 'garaged')                 AS vehicles_garaged,
        (SELECT count(*)::int FROM vehicles WHERE status = 'deployed')                AS vehicles_deployed,
        (SELECT count(*)::int FROM vehicles WHERE status = 'seized')                  AS vehicles_seized,
        (SELECT count(*)::int FROM vehicles WHERE sale_price_cents IS NOT NULL)       AS vehicles_for_sale,
        (SELECT count(*)::int FROM properties)                                        AS properties,
        (SELECT count(*)::int FROM properties WHERE status = 'owned')                 AS properties_owned,
        (SELECT count(*)::int FROM properties WHERE status = 'seized')                AS properties_seized,
        (SELECT count(*)::int FROM properties WHERE sale_price_cents IS NOT NULL)     AS properties_for_sale,
        (SELECT count(*)::int FROM licenses)                                          AS licenses,
        (SELECT count(*)::int FROM police_records)                                    AS police_records,
        (SELECT count(*)::int FROM police_reports)                                    AS police_reports_total,
        (SELECT count(*)::int FROM police_reports WHERE status = 'open')              AS police_reports_open,
        (SELECT count(*)::int FROM fines)                                             AS fines,
        (SELECT count(*)::int FROM fines WHERE status = 'outstanding')                AS fines_outstanding,
        (SELECT count(*)::int FROM warrants)                                          AS warrants,
        (SELECT count(*)::int FROM warrants WHERE status = 'active')                  AS warrants_active,
        (SELECT count(*)::int FROM evidence)                                          AS evidence,
        (SELECT count(*)::int FROM arrests)                                           AS arrests,
        (SELECT count(*)::int FROM arrests WHERE status = 'active')                   AS arrests_active,
        (SELECT count(*)::int FROM medical_records)                                   AS medical_records,
        (SELECT count(*)::int FROM medical_records WHERE health_state = 'downed')     AS medical_downed,
        (SELECT count(*)::int FROM medical_records WHERE health_state = 'dead')       AS medical_dead,
        (SELECT count(*)::int FROM medical_bills)                                     AS medical_bills,
        (SELECT count(*)::int FROM medical_bills WHERE status = 'unpaid')             AS medical_bills_unpaid,
        (SELECT count(*)::int FROM phone_numbers)                                     AS phone_numbers,
        (SELECT count(*)::int FROM phone_contacts)                                    AS phone_contacts,
        (SELECT count(*)::int FROM phone_messages)                                    AS phone_messages,
        (SELECT count(*)::int FROM phone_calls)                                       AS phone_calls,
        (SELECT count(*)::int FROM phone_waypoints)                                   AS phone_waypoints,
        (SELECT count(*)::int FROM phone_taxi_requests)                               AS taxi_requests,
        (SELECT count(*)::int FROM phone_taxi_requests WHERE status = 'pending')      AS taxi_pending,
        (SELECT count(*)::int FROM phone_emergency_calls)                             AS emergency_calls,
        (SELECT count(*)::int FROM phone_emergency_calls WHERE status = 'open')       AS emergency_open,
        (SELECT count(*)::int FROM cases)                                             AS cases,
        (SELECT count(*)::int FROM cases WHERE status IN ('open','in_progress'))      AS cases_open,
        (SELECT count(*)::int FROM case_messages)                                     AS case_messages,
        (SELECT count(*)::int FROM trades)                                            AS trades,
        (SELECT count(*)::int FROM trades WHERE status = 'pending')                   AS trades_pending,
        (SELECT count(*)::int FROM shop_listings)                                     AS shop_listings,
        (SELECT count(*)::int FROM security_events)                                   AS security_events,
        (SELECT count(*)::int FROM security_events WHERE acknowledged_at IS NULL)     AS security_open,
        (SELECT count(*)::int FROM security_events WHERE acknowledged_at IS NULL AND severity IN ('HIGH','CRITICAL')) AS security_open_high,
        (SELECT count(*)::int FROM audit_log)                                         AS audit_entries,
        (SELECT count(*)::int FROM audit_log WHERE result = 'failure' AND created_at > now() - interval '1 hour') AS audit_failures_1h,
        (SELECT count(*)::int FROM sessions)                                          AS sessions,
        (SELECT count(*)::int FROM resources)                                         AS resources,
        (SELECT count(*)::int FROM resources WHERE enabled = true)                    AS resources_enabled,
        (SELECT count(*)::int FROM backup_records)                                    AS backups,
        (SELECT max(created_at) FROM backup_records)                                  AS last_backup_at,
        (SELECT count(*)::int FROM player_sessions WHERE left_at IS NULL) AS player_sessions_active
    `);
    const r: any = rows[0];

    // recent admin actions = audit tail (reuse the same feed as monitoring)
    const recentActions = (
      await pool.query(
        `SELECT id, actor_user_id, action, target_type, target_id, result, created_at
         FROM audit_log ORDER BY id DESC LIMIT 15`
      )
    ).rows;

    const toIso = (d: any) => (d ? new Date(d).toISOString() : null);

    return {
      ok: dbOk && redisOk,
      generatedAt: new Date().toISOString(),
      services: {
        database: { ok: dbOk, latencyMs: dbLatencyMs },
        redis: { ok: redisOk, latencyMs: redisLatencyMs },
      },
      playersOnline: {
        count: online.length,
        players: online.map((p) => ({ playerName: p.playerName, persistentId: p.persistentId, characterId: p.characterId })),
      },
      core: {
        users: Number(r.users),
        characters: Number(r.characters),
        charactersActive: Number(r.characters_active),
        wallets: Number(r.wallets),
        sessions: Number(r.sessions),
        items: Number(r.items),
      },
      economy: {
        cashCents: Number(r.cash_cents),
        bankCents: Number(r.bank_cents),
        redMoneyCents: Number(r.red_money_cents),
        transactions: Number(r.transactions),
        openAnomalies: Number(r.economy_anomalies_open),
      },
      inventory: {
        carrySlots: Number(r.inventory_slots),
        containers: Number(r.inventories),
        containerItems: Number(r.inventory_items),
      },
      vehicles: {
        total: Number(r.vehicles),
        garaged: Number(r.vehicles_garaged),
        deployed: Number(r.vehicles_deployed),
        seized: Number(r.vehicles_seized),
        forSale: Number(r.vehicles_for_sale),
      },
      properties: {
        total: Number(r.properties),
        owned: Number(r.properties_owned),
        seized: Number(r.properties_seized),
        forSale: Number(r.properties_for_sale),
      },
      police: {
        licenses: Number(r.licenses),
        records: Number(r.police_records),
        reports: Number(r.police_reports_total),
        reportsOpen: Number(r.police_reports_open),
        fines: Number(r.fines),
        finesOutstanding: Number(r.fines_outstanding),
        warrants: Number(r.warrants),
        warrantsActive: Number(r.warrants_active),
        evidence: Number(r.evidence),
        arrests: Number(r.arrests),
        arrestsActive: Number(r.arrests_active),
      },
      ems: {
        records: Number(r.medical_records),
        downed: Number(r.medical_downed),
        dead: Number(r.medical_dead),
        bills: Number(r.medical_bills),
        billsUnpaid: Number(r.medical_bills_unpaid),
      },
      phone: {
        numbers: Number(r.phone_numbers),
        contacts: Number(r.phone_contacts),
        messages: Number(r.phone_messages),
        calls: Number(r.phone_calls),
        waypoints: Number(r.phone_waypoints),
        taxiRequests: Number(r.taxi_requests),
        taxiPending: Number(r.taxi_pending),
        emergencyCalls: Number(r.emergency_calls),
        emergencyOpen: Number(r.emergency_open),
      },
      cases: {
        total: Number(r.cases),
        open: Number(r.cases_open),
        messages: Number(r.case_messages),
      },
      trades: {
        total: Number(r.trades),
        pending: Number(r.trades_pending),
      },
      shop: {
        listings: Number(r.shop_listings),
      },
      security: {
        events: Number(r.security_events),
        open: Number(r.security_open),
        openHigh: Number(r.security_open_high),
        auditFailures1h: Number(r.audit_failures_1h),
      },
      ops: {
        auditEntries: Number(r.audit_entries),
        resources: Number(r.resources),
        resourcesEnabled: Number(r.resources_enabled),
        backups: Number(r.backups),
        lastBackupAt: toIso(r.last_backup_at),
        playerSessionsActive: Number(r.player_sessions_active),
      },
      recentAdminActions: recentActions.map((a: any) => ({
        id: Number(a.id),
        actorUserId: a.actor_user_id == null ? null : Number(a.actor_user_id),
        action: a.action,
        targetType: a.target_type ?? null,
        targetId: a.target_id ?? null,
        result: a.result,
        createdAt: toIso(a.created_at),
      })),
    };
  })
);