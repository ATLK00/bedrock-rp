#!/usr/bin/env node
// ---------------------------------------------------------------------------
// control-cli.cjs — CJS build entry point for `pkg` (which can't trace ESM).
// This file re-uses the exact same logic as control-cli.mjs.
// Build:  npx pkg tools/package.json --targets node18-win-x64,node18-linux-x64
// ---------------------------------------------------------------------------

const process = require("node:process");
const { Buffer } = require("node:buffer");

const BASE_URL = (process.env.CTL_BASE_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
const API_KEY = process.env.CTL_API_KEY || "";
const ACTOR = process.env.CTL_ACTOR || null;

if (!API_KEY) {
  console.error("error: CTL_API_KEY is required (the backend CONTROL_API_KEY)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// arg parsing (tiny, no deps)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      let key = a.slice(2);
      let value = "true";
      const eq = key.indexOf("=");
      if (eq !== -1) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        value = argv[++i];
      }
      flags[key] = value;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function bool(v, dflt) {
  if (v === undefined) return dflt;
  return v === "true" || v === "1" || v === "yes";
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
async function call(method, path, body) {
  const headers = { "x-control-api-key": API_KEY };
  if (ACTOR) headers["x-control-actor-user-id"] = String(ACTOR);
  let payload = undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, error: `non-JSON response (${res.status})` };
  }
  if (!res.ok) {
    throw new Error(
      `${res.status} ${method} ${path} failed: ${data?.error || data?.message || text.slice(0, 200)}`
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// pretty printers
// ---------------------------------------------------------------------------
function fmtBytes(n) {
  if (n === null || n === undefined) return "-";
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GiB";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MiB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KiB";
  return n + " B";
}

function fmtDur(ms) {
  if (ms === null || ms === undefined) return "-";
  return ms + "ms";
}

const f = (v) => v ?? "-";

function fmtStatus(st) {
  if (!st || typeof st !== "object") return "-";
  return `${st.ok ? "up" : "down"}${st.latencyMs != null ? ` (${fmtDur(st.latencyMs)})` : ""}${st.detail ? ` ${st.detail}` : ""}`;
}

function dump(title, obj) {
  console.log(`# ${title}`);
  console.log(JSON.stringify(obj, null, 2));
  console.log();
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
async function cmdPing() {
  const r = await call("GET", "/control/ping");
  console.log(`app=${r.app} version=${r.version} serverTime=${r.serverTime} ok=${r.ok}`);
}

async function cmdStatus() {
  const r = await call("GET", "/control/status");
  console.log(`ok=${r.ok} app=${r.app} v${r.version}`);
  console.log(`process: pid=${r.process.pid} up=${r.process.uptimeSeconds}s node=${r.process.node}`);
  console.log(`memory : rss=${fmtBytes(r.process.memory.rssBytes)} heap=${fmtBytes(r.process.memory.heapUsedBytes)}`);
  console.log(
    `db   : ${r.dependencies.database.ok ? "ok" : "DOWN"} (${fmtDur(r.dependencies.database.latencyMs)})`
  );
  console.log(
    `redis: ${r.dependencies.redis.ok ? "ok" : "DOWN"} (${fmtDur(r.dependencies.redis.latencyMs)})`
  );
  console.log(`players: ${r.onlinePlayerCount}`);
  for (const p of r.onlinePlayers) console.log(`  - ${p.playerName} (${p.persistentId}) char#${p.characterId}`);
}

async function cmdHealth() {
  const r = await call("GET", "/control/health");
  console.log(`ok=${r.ok} db=${r.checks.database} redis=${r.checks.redis}`);
}

async function cmdPlayers(flags) {
  const query = flags.query ? `&query=${encodeURIComponent(flags.query)}` : "";
  const limit = flags.limit ? `&limit=${flags.limit}` : "";
  const offset = flags.offset ? `&offset=${flags.offset}` : "";
  const r = await call("GET", `/control/players?x=1${query}${limit}${offset}`);
  console.log(`players: ${r.count}`);
  for (const p of r.players) {
    console.log(
      `  #${f(p.id).padEnd(4)} ${p.name || "-"} (${f(p.discordTag)}) online=${p.isOnline} whitelisted=${p.whitelisted}`
    );
  }
}

async function cmdAudit(flags) {
  const q = flags.action ? `&action=${encodeURIComponent(flags.action)}` : "";
  const a = flags.actor ? `&actorUserId=${flags.actor}` : "";
  const lim = flags.limit ? `&limit=${flags.limit}` : "";
  const r = await call("GET", `/control/audit?x=1${q}${a}${lim}`);
  console.log(`audit rows: ${r.count}`);
  for (const e of r.audit) {
    console.log(`  #${String(e.id).padEnd(4)} ${e.createdAt} actor=${f(e.actorUserId)} ${e.action} ${e.targetType}/${e.targetId} [${e.result}]`);
  }
}

async function cmdSecurity(flags) {
  const sev = flags.severity ? `&severity=${encodeURIComponent(flags.severity)}` : "";
  const ack = flags.acknowledged === undefined ? "" : `&acknowledged=${flags.acknowledged}`;
  const lim = flags.limit ? `&limit=${flags.limit}` : "";
  const r = await call("GET", `/control/security/events?x=1${sev}${ack}${lim}`);
  console.log(`security events: ${r.count} (shown: ${r.events.length})`);
  for (const e of r.events) {
    const type = e.event_type ?? "-";
    const actor = e.actor_user_id ?? "-";
    const acked = e.acknowledged_at != null;
    console.log(`  #${String(e.id).padEnd(4)} [${e.severity}] ${type} actor=${actor} acked=${acked}`);
  }
}

async function cmdMonitoring() {
  const r = await call("GET", "/control/monitoring");
  console.log(`monitoring ok=${r.ok} generatedAt=${r.generatedAt}`);
  console.log(
    `system: load=${r.system.cpuLoad.join(", ")} mem=${r.system.memory.usedPercent}% (${fmtBytes(r.system.memory.freeBytes)} free) disk=${r.system.disk.usedPercent}% used`
  );
  console.log(`services: db=${r.services.database.ok ? "ok" : "DOWN"} (${fmtDur(r.services.database.latencyMs)}) redis=${r.services.redis.ok ? "ok" : "DOWN"} (${fmtDur(r.services.redis.latencyMs)})`);
  console.log(`players online: ${r.playersOnline.count}`);
  for (const p of r.playersOnline.players) console.log(`  - ${p.playerName} (${p.persistentId})`);
  console.log(`error rate (1h): auditFailures=${r.errorRate.auditFailuresLastHour} serverErrors=${r.errorRate.serverErrorsLastHour}`);
  console.log(`security: open=${r.security.openTotal} (high/critical=${r.security.openHighAlerts}) anomalies=${r.economy.openAnomalies}`);
  for (const e of r.security.recent) console.log(`  [${e.severity}] ${e.eventType} acked=${e.acknowledged} ${e.createdAt}`);
  console.log(`recent admin actions:`);
  for (const a of r.recentAdminActions) console.log(`  ${a.createdAt} actor=${f(a.actorUserId)} ${a.action} ${f(a.targetType)}/${f(a.targetId)} [${a.result}]`);
}

function fmtMoney(cents) {
  if (cents === null || cents === undefined) return "-";
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function cmdOverview() {
  const r = await call("GET", "/control/overview");
  console.log(`overview ok=${r.ok} generatedAt=${r.generatedAt}`);
  console.log(`services: db=${r.services.database.ok ? "ok" : "DOWN"} (${fmtDur(r.services.database.latencyMs)}) redis=${r.services.redis.ok ? "ok" : "DOWN"} (${fmtDur(r.services.redis.latencyMs)})`);
  console.log(`players online: ${r.playersOnline.count}`);
  for (const p of r.playersOnline.players) console.log(`  - ${p.playerName} (${p.persistentId})`);

  console.log(`\nCORE`);
  console.log(`  users: ${r.core.users}  characters: ${r.core.characters} (active ${r.core.charactersActive})  sessions: ${r.core.sessions}  items: ${r.core.items}`);

  console.log(`\nECONOMY`);
  console.log(`  money: cash=${fmtMoney(r.economy.cashCents)}  bank=${fmtMoney(r.economy.bankCents)}  red=${fmtMoney(r.economy.redMoneyCents)}`);
  console.log(`  transactions: ${r.economy.transactions}  open anomalies: ${r.economy.openAnomalies}`);

  console.log(`\nINVENTORY`);
  console.log(`  carry slots: ${r.inventory.carrySlots}  containers: ${r.inventory.containers}  container items: ${r.inventory.containerItems}`);

  console.log(`\nVEHICLES`);
  console.log(`  total: ${r.vehicles.total}  garaged: ${r.vehicles.garaged}  deployed: ${r.vehicles.deployed}  seized: ${r.vehicles.seized}  for-sale: ${r.vehicles.forSale}`);

  console.log(`\nPROPERTIES`);
  console.log(`  total: ${r.properties.total}  owned: ${r.properties.owned}  seized: ${r.properties.seized}  for-sale: ${r.properties.forSale}`);

  console.log(`\nPOLICE`);
  console.log(`  licenses: ${r.police.licenses}  records: ${r.police.records}  reports: ${r.police.reports} (open ${r.police.reportsOpen})`);
  console.log(`  fines: ${r.police.fines} (outstanding ${r.police.finesOutstanding})  warrants: ${r.police.warrants} (active ${r.police.warrantsActive})`);
  console.log(`  evidence: ${r.police.evidence}  arrests: ${r.police.arrests} (active ${r.police.arrestsActive})`);

  console.log(`\nEMS`);
  console.log(`  records: ${r.ems.records}  downed: ${r.ems.downed}  dead: ${r.ems.dead}  bills: ${r.ems.bills} (unpaid ${r.ems.billsUnpaid})`);

  console.log(`\nPHONE`);
  console.log(`  numbers: ${r.phone.numbers}  contacts: ${r.phone.contacts}  messages: ${r.phone.messages}  calls: ${r.phone.calls}  waypoints: ${r.phone.waypoints}`);
  console.log(`  taxi: ${r.phone.taxiRequests} (pending ${r.phone.taxiPending})  emergency: ${r.phone.emergencyCalls} (open ${r.phone.emergencyOpen})`);

  console.log(`\nCASES`);
  console.log(`  total: ${r.cases.total}  open: ${r.cases.open}  messages: ${r.cases.messages}`);

  console.log(`\nTRADES / SHOP`);
  console.log(`  trades: ${r.trades.total} (pending ${r.trades.pending})  shop listings: ${r.shop.listings}`);

  console.log(`\nSECURITY`);
  console.log(`  events: ${r.security.events}  open: ${r.security.open}  high/critical: ${r.security.openHigh}  audit failures(1h): ${r.security.auditFailures1h}`);
  console.log(`  recent:`);
  for (const a of r.recentAdminActions) console.log(`    ${a.createdAt} actor=${f(a.actorUserId)} ${a.action} ${f(a.targetType)}/${f(a.targetId)} [${a.result}]`);

  console.log(`\nOPS`);
  console.log(`  audit entries: ${r.ops.auditEntries}  resources: ${r.ops.resources} (enabled ${r.ops.resourcesEnabled})  backups: ${r.ops.backups} (last ${f(r.ops.lastBackupAt)})`);
}

async function cmdResources(flags, positional) {
  const sub = positional[0];
  if (!sub || sub === "list") {
    const r = await call("GET", "/control/resources");
    console.log(`resources: ${r.count}`);
    for (const res of r.resources) {
      console.log(`  ${res.name.padEnd(24)} ${res.kind.padEnd(8)} ${res.target} v${f(res.version)} enabled=${res.enabled} status=${fmtStatus(res.status)}`);
    }
    return;
  }
  if (sub === "show") {
    const r = await call("GET", `/control/resources/${encodeURIComponent(positional[1] ?? "")}`);
    dump("resource", r.resource);
    return;
  }
  if (sub === "register") {
    const name = positional[1];
    if (!name) throw new Error("usage: resources register <name> --kind=... --target=...");
    const body = {
      name,
      kind: flags.kind || "http",
      target: flags.target,
      version: flags.version,
      enabled: bool(flags.enabled, true),
      dependencies: flags.dependencies ? flags.dependencies.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      commands: flags.commands ? JSON.parse(flags.commands) : undefined,
      notes: flags.notes,
    };
    const r = await call("POST", "/control/resources", body);
    console.log(`registered ${r.resource.name} (#${r.resource.id}) status=${fmtStatus(r.resource.status)}`);
    return;
  }
  if (sub === "update") {
    const name = positional[1];
    if (!name) throw new Error("usage: resources update <name> [--target=...] [--version=...] [--enabled=...]");
    const body = {};
    if (flags.target !== undefined) body.target = flags.target;
    if (flags.version !== undefined) body.version = flags.version;
    if (flags.enabled !== undefined) body.enabled = bool(flags.enabled);
    if (flags.commands !== undefined) body.commands = JSON.parse(flags.commands);
    if (flags.dependencies !== undefined) body.dependencies = flags.dependencies.split(",").map((s) => s.trim()).filter(Boolean);
    if (flags.notes !== undefined) body.notes = flags.notes;
    const r = await call("PATCH", `/control/resources/${encodeURIComponent(name)}`, body);
    console.log(`updated ${r.resource.name} (#${r.resource.id}) status=${fmtStatus(r.resource.status)}`);
    return;
  }
  if (sub === "unregister") {
    const name = positional[1];
    if (!name) throw new Error("usage: resources unregister <name>");
    const r = await call("DELETE", `/control/resources/${encodeURIComponent(name)}`);
    console.log(`unregistered ${r.unregistered}`);
    return;
  }
  if (sub === "enable" || sub === "disable") {
    const name = positional[1];
    if (!name) throw new Error(`usage: resources ${sub} <name>`);
    const r = await call("POST", `/control/resources/${encodeURIComponent(name)}/${sub}`);
    console.log(`${r.resource} now enabled=${r.enabled}`);
    return;
  }
  if (sub === "version") {
    const name = positional[1];
    if (!name) throw new Error("usage: resources version <name>");
    const r = await call("GET", `/control/resources/${encodeURIComponent(name)}/version`);
    console.log(`version=${f(r.version)}`);
    for (const [dep, st] of Object.entries(r.dependencies)) console.log(`  dep ${dep}: ${st ? st.status : "missing"}`);
    return;
  }
  for (const verb of ["install", "update", "restart", "status"]) {
    if (sub === verb) {
      const name = positional[1];
      if (!name) throw new Error(`usage: resources ${verb} <name>`);
      const r = await call("POST", `/control/resources/${encodeURIComponent(name)}/${verb}`);
      console.log(`${verb} ${r.resource}: ok=${r.ok} duration=${fmtDur(r.durationMs)}`);
      if (r.stdoutHead) console.log(r.stdoutHead.slice(0, 500));
      if (r.stderrHead) console.error(r.stderrHead.slice(0, 500));
      return;
    }
  }
  throw new Error(`unknown resources subcommand: ${sub}`);
}

async function cmdBackups(flags, positional) {
  const sub = positional[0];
  if (!sub || sub === "list") {
    const r = await call("GET", "/control/backups");
    console.log(`backups: ${r.count}`);
    for (const b of r.backups) {
      console.log(
        `  #${String(b.id).padEnd(3)} ${b.createdAt} ${b.filename} ${fmtBytes(b.sizeBytes)} status=${b.status} by=${f(b.createdByUserId)}`
      );
    }
    return;
  }
  if (sub === "create") {
    const r = await call("POST", "/control/backups", { note: flags.note });
    console.log(`backup #${r.id}: ${r.filename} (${r.tables} tables, ${fmtBytes(r.sizeBytes)})`);
    console.log(`sha256=${r.checksumSha256}`);
    return;
  }
  if (sub === "show") {
    const r = await call("GET", `/control/backups/${encodeURIComponent(positional[1] ?? "")}`);
    dump("backup", r.backup);
    return;
  }
  if (sub === "verify") {
    const r = await call("POST", `/control/backups/${encodeURIComponent(positional[1] ?? "")}/verify`);
    console.log(`verify #${r.id}: ok=${r.ok} checksumMatch=${r.checksumMatch} parseOk=${r.parseOk}`);
    console.log(`  size ${fmtBytes(r.sizeBytes)} (recorded ${fmtBytes(r.recordedSizeBytes)})`);
    return;
  }
  if (sub === "restore") {
    const r = await call("POST", `/control/backups/${encodeURIComponent(positional[1] ?? "")}/restore`);
    console.log(`restored backup #${r.id} at ${r.restoredAt}`);
    return;
  }
  throw new Error(`unknown backups subcommand: ${sub}`);
}

async function cmdWipe(flags, positional) {
  const sub = positional[0];
  if (sub === "dry-run") {
    const r = await call("POST", "/control/wipe/dry-run");
    console.log(
      `wipe plan: ${r.plan.users} users, ${r.plan.characters} characters, ${r.plan.tables} tables`
    );
    console.log(`confirmationToken=${r.confirmationToken} (expires in ${r.tokenTtlSeconds}s)`);
    if (r.requiresPassphrase) console.log("note: backend requires --passphrase on confirm");
    return;
  }
  if (sub === "confirm") {
    const token = positional[1];
    if (!token) throw new Error("usage: wipe confirm <confirmationToken> [--mode=schema|data] [--auto-backup=true] [--passphrase=...]");
    const body = {
      confirmationToken: token,
      mode: flags.mode === "data" ? "data" : "schema",
      autoBackup: bool(flags["auto-backup"], true),
    };
    if (flags.passphrase !== undefined) body.passphrase = flags.passphrase;
    const r = await call("POST", "/control/wipe/confirm", body);
    console.log(`wipe done mode=${r.mode}`);
    console.log(
      `integrity: migrations=${r.integrity.migrationsApplied} tables=${r.integrity.publicTables} roles=${r.integrity.seededRoles} items=${r.integrity.seededItems}`
    );
    if (r.autoBackupBackupId) console.log(`auto snapshot backup #${r.autoBackupBackupId}`);
    return;
  }
  throw new Error("unknown wipe subcommand (use: dry-run | confirm <token>)");
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------
(async () => {
  const [cmd, ...rest] = args;
  const { flags, positional } = parseFlags(rest);

  const handlers = {
    ping: cmdPing,
    status: cmdStatus,
    health: cmdHealth,
    players: () => cmdPlayers(flags),
    audit: () => cmdAudit(flags),
    security: () => cmdSecurity(flags),
    monitoring: cmdMonitoring,
    overview: cmdOverview,
    resources: () => cmdResources(flags, positional),
    backups: () => cmdBackups(flags, positional),
    wipe: () => cmdWipe(flags, positional),
  };

  if (!handlers[cmd]) {
    console.error(
      `usage: control-cli <command>\n` +
        `commands: ping | status | health | players | audit | security | monitoring | overview | resources | backups | wipe\n` +
        `env: CTL_BASE_URL (default http://127.0.0.1:4000), CTL_API_KEY (required), CTL_ACTOR (optional)`
    );
    process.exit(1);
  }

  try {
    await handlers[cmd]();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
})();
