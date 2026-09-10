// Backup / Wipe / Restore (#5) — /control/backups* and /control/wipe*
//
// Pipeline from the roadmap: Backup -> Dry Run -> Confirm -> Wipe ->
// Integrity Check -> (rollback on failure).
//
// Dump engine: an in-process logical dump (CREATE TABLE + COPY blocks in a
// plain-SQL file, restorable with either `psql` when present on the host or
// our own replay parser). Schema round-trip is full for tables/columns/
// defaults/serial-identity; FKs/indexes/constraints created by migrations
// are NOT part of the dump (the current migrations re-create them) — see the
// backup-rules note in AI_HANDOFF. Wipe drops the whole `public` schema and
// re-runs every migration, so a restore AFTER wipe collapses back into the
// migrated shape and works even if the dump predates the wipe.

import { Router } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { pool } from "../../db/pool.js";
import { config } from "../../config/index.js";
import { runMigrations } from "../../db/migrate.js";
import { emitSecurityEvent } from "../security/index.js";
import { ControlError, appVersion, ctl, controlAudit, controlActorOf, qstr, requestIdOf } from "./common.js";

export const backupRouter = Router();

const backupDir = path.resolve(config.BACKUP_DIR);
const WIPE_TOKEN_TTL_MS = 10 * 60 * 1000;

// One outstanding wipe confirmation per dry-run; single Map so tokens are
// short-lived, single-use, and never persisted.
const pendingWipes = new Map<string, { expiresAt: number }>();

function quoteIdent(name: string) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function copyValue(v: unknown): string {
  if (v === null || v === undefined) return "\\N";
  if (typeof v === "boolean") return v ? "t" : "f";
  if (v instanceof Date) return v.toISOString().replace("T", " ").replace("Z", "+00");
  let s: string;
  if (typeof v === "object") {
    try {
      s = JSON.stringify(v);
    } catch {
      return "\\N";
    }
  } else {
    s = String(v);
  }
  return s.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function parseCopyValue(cell: string): unknown {
  if (cell === "\\N") return null;
  let out = "";
  for (let i = 0; i < cell.length; i++) {
    const ch = cell[i];
    if (ch === "\\" && i + 1 < cell.length) {
      const next = cell[i + 1];
      i++;
      if (next === "t") out += "\t";
      else if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else out += next;
    } else {
      out += ch;
    }
  }
  return out;
}

async function listTables(): Promise<string[]> {
  // Topologically ordered by FK dependency (referenced tables first) so a
  // restore can insert straight through — parents always exist before their
  // children. The dependency graph here is a DAG; leftovers (shouldn't
  // happen) are appended alphabetically so no table is ever lost.
  const { rows: fkRows } = await pool.query(
    `SELECT tc.table_name AS child, ccu.table_name AS parent
     FROM information_schema.table_constraints tc
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
     GROUP BY tc.table_name, ccu.table_name`
  );
  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_migrations' ORDER BY tablename`
  );
  const names = rows.map((r: any) => r.tablename as string);
  const nameSet = new Set(names);

  const indegree = new Map<string, number>(names.map((n) => [n, 0]));
  const dependents = new Map<string, string[]>();
  for (const fk of fkRows as any[]) {
    const { child, parent } = fk;
    if (!nameSet.has(child) || !nameSet.has(parent) || child === parent) continue;
    indegree.set(child, (indegree.get(child) ?? 0) + 1);
    const arr = dependents.get(parent) ?? [];
    arr.push(child);
    dependents.set(parent, arr);
  }

  const queue = names.filter((n) => (indegree.get(n) ?? 0) === 0);
  const result: string[] = [];
  while (queue.length) {
    const node = queue.shift()!;
    result.push(node);
    for (const child of dependents.get(node) ?? []) {
      const deg = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, deg);
      if (deg === 0) queue.push(child);
    }
  }
  if (result.length !== names.length) {
    const seen = new Set(result);
    result.push(...names.filter((n) => !seen.has(n)));
  }
  return result;
}

interface ColumnDef {
  name: string;
  dataType: string;
  notNull: boolean;
  defaultExpr: string | null;
  identity: "a" | "d" | "";
}

async function tableColumns(table: string): Promise<ColumnDef[]> {
  const { rows } = await pool.query(
    `SELECT a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null,
            pg_get_expr(d.adbin, d.adrelid) AS default_expr,
            a.attidentity AS identity
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [table]
  );
  return rows.map((r: any) => ({
    name: r.name as string,
    dataType: r.data_type as string,
    notNull: r.not_null as boolean,
    defaultExpr: r.default_expr as string | null,
    identity: (r.identity ?? "") as ColumnDef["identity"],
  }));
}

function createTableSql(table: string, cols: ColumnDef[]): string {
  const lines = cols.map((c) => {
    let type = c.dataType;
    let tail = "";
    if (c.identity) {
      tail += c.identity === "a" ? " GENERATED ALWAYS AS IDENTITY" : " GENERATED BY DEFAULT AS IDENTITY";
    } else if (c.defaultExpr && /^nextval\(/.test(c.defaultExpr)) {
      // serial family: recreate sequence + default with the SERIAL keywords
      type = c.dataType === "smallint" ? "SMALLSERIAL" : c.dataType === "integer" ? "SERIAL" : c.dataType === "bigint" ? "BIGSERIAL" : c.dataType;
      if (type === c.dataType) tail += ` NOT NULL DEFAULT ${c.defaultExpr}`;
    } else {
      if (c.notNull) tail += " NOT NULL";
      if (c.defaultExpr) tail += ` DEFAULT ${c.defaultExpr}`;
    }
    return `  ${quoteIdent(c.name)} ${type}${tail}`;
  });
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (\n${lines.join(",\n")}\n);`;
}

async function dumpTableData(table: string): Promise<string[]> {
  const { rows: colRows } = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table]
  );
  const cols = colRows.map((r: any) => r.column_name as string);
  if (cols.length === 0) return [];
  const colList = cols.map(quoteIdent).join(", ");
  // JSON/jsonb cells come back from node-pg already parsed — a string inside a
  // jsonb column arrives as a bare JS string. Re-canonicalizing by column type
  // keeps the dump well-formed JSON on restore (both psql and in-process).
  const jsonish = new Set(
    colRows.filter((r: any) => r.data_type === "json" || r.data_type === "jsonb").map((r: any) => r.column_name)
  );
  const lines: string[] = [`COPY ${quoteIdent(table)} (${colList}) FROM stdin;`];
  const { rows } = await pool.query(`SELECT ${colList} FROM ${quoteIdent(table)}`);
  for (const r of rows) {
    lines.push(
      cols
        .map((c) => {
          const v = r[c];
          if (v === null || v === undefined) return "\\N";
          return copyValue(jsonish.has(c) ? JSON.stringify(v) : v);
        })
        .join("\t")
    );
  }
  lines.push("\\.", "");
  return lines;
}

async function createBackup(actorUserId: number | null, requestId: string | null, note?: string) {
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `backup-${stamp}.sql`;
  const filePath = path.join(backupDir, filename);

  const tables = await listTables();
  const parts: string[] = [
    "-- bedrock-rp logical backup",
    `-- generated ${new Date().toISOString()} | app ${appVersion} | tables ${tables.length}`,
    "-- restore: psql -f <file> (or the /control restore endpoint)",
    "",
  ];
  for (const t of tables) {
    const cols = await tableColumns(t);
    if (cols.length === 0) continue;
    parts.push(createTableSql(t, cols), "");
  }
  for (const t of tables) {
    parts.push(...(await dumpTableData(t)));
  }
  const sql = parts.join("\n") + "\n";

  await writeFile(filePath, sql, "utf8");
  const { size } = await stat(filePath);
  const sha = createHash("sha256").update(sql).digest("hex");
  const { rows } = await pool.query(
    `INSERT INTO backup_records (filename, app_version, size_bytes, checksum_sha256, created_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [filename, appVersion, size, sha, actorUserId, note ? JSON.stringify({ note }) : null]
  );
  return {
    id: Number(rows[0].id),
    filename,
    filePath,
    sizeBytes: size,
    checksumSha256: sha,
    appVersion,
    createdByUserId: actorUserId,
    tables: tables.length,
  };
}

async function findBackup(idInput: string): Promise<any> {
  const id = Number(idInput);
  if (!Number.isInteger(id) || id <= 0) throw new ControlError(400, `invalid backup id: ${idInput}`);
  const { rows } = await pool.query(`SELECT * FROM backup_records WHERE id = $1`, [id]);
  if (rows.length === 0) throw new ControlError(404, `backup not found: ${id}`);
  return rows[0];
}

async function readBackupFile(rec: any): Promise<string> {
  const filePath = path.join(backupDir, rec.filename);
  const content = await readFile(filePath, "utf8");
  const sha = createHash("sha256").update(content).digest("hex");
  if (sha !== rec.checksum_sha256) {
    throw new ControlError(409, `backup ${rec.id} fails its checksum — file changed on disk, refusing`);
  }
  return content;
}

// ---------------------------------------------------------------------------
// Backup endpoints
// ---------------------------------------------------------------------------

backupRouter.get(
  "/backups",
  ctl(async (req) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const { rows } = await pool.query(
      `SELECT id, filename, app_version, size_bytes, checksum_sha256, created_by, status, notes, created_at
       FROM backup_records ORDER BY id DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return { ok: true, count: rows.length, backups: rows.map(mapBackupRow) };
  })
);

backupRouter.post(
  "/backups",
  ctl(async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const note = qstr(body.note) ?? undefined;
    const backup = await createBackup(controlActorOf(req), requestIdOf(req), note);
    await controlAudit(req, "control.backup.create", String(backup.id), {
      after: { filename: backup.filename, sizeBytes: backup.sizeBytes, checksumSha256: backup.checksumSha256, tables: backup.tables },
    });
    return { ok: true, ...backup };
  })
);

backupRouter.get(
  "/backups/:id",
  ctl(async (req) => {
    const rec = await findBackup(req.params.id);
    return { ok: true, backup: mapBackupRow(rec) };
  })
);

backupRouter.post(
  "/backups/:id/verify",
  ctl(async (req) => {
    const rec = await findBackup(req.params.id);
    const filePath = path.join(backupDir, rec.filename);
    const content = await readFile(filePath, "utf8");
    const sha = createHash("sha256").update(content).digest("hex");
    const checksumMatch = sha === rec.checksum_sha256;
    const parseOk = content.includes("COPY ") && content.trim().length > 0;
    return {
      ok: checksumMatch && parseOk,
      id: Number(rec.id),
      filename: rec.filename,
      checksumMatch,
      parseOk,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      recordedSizeBytes: Number(rec.size_bytes),
      createdAt: new Date(rec.created_at).toISOString(),
    };
  })
);

backupRouter.post(
  "/backups/:id/restore",
  ctl(async (req) => {
    const rec = await findBackup(req.params.id);
    const content = await readBackupFile(rec);
    const actorUserId = controlActorOf(req);
    const requestId = requestIdOf(req);

    emitSecurityEvent({
      eventType: "control_backup_restore",
      severity: "HIGH",
      actorUserId,
      ip: req.ip ?? null,
      requestId,
      targetType: "backup",
      targetId: String(rec.id),
    }).catch(() => {});

    await applyDump(content, rec.id, actorUserId, requestId);
    await pool.query(
      `UPDATE backup_records SET status = 'restored', notes = COALESCE(notes, '') || 'restored_at=' || now() WHERE id = $1`,
      [rec.id]
    );
    const restoredAt = new Date().toISOString();
    await controlAudit(req, "control.backup.restore", String(rec.id), { after: { restoredAt } });
    return { ok: true, id: Number(rec.id), restoredAt };
  })
);

function mapBackupRow(r: any) {
  return {
    id: Number(r.id),
    filename: r.filename,
    appVersion: r.app_version,
    sizeBytes: Number(r.size_bytes),
    checksumSha256: r.checksum_sha256,
    createdByUserId: r.created_by == null ? null : Number(r.created_by),
    status: r.status,
    notes: r.notes,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Dump engine (restore path)
// ---------------------------------------------------------------------------

/** Apply a dump to the current `public` schema. Uses `psql` when the binary is
 * on the host; otherwise falls back to an in-process replay of the same format. */
async function applyDump(content: string, backupId: number, actorUserId: number | null, requestId: string | null) {
  const psql = spawn("psql", ["--version"], { stdio: "ignore" });
  const psqlAvailable = await new Promise<boolean>((resolve) => {
    psql.once("error", () => resolve(false));
    psql.once("exit", (code) => resolve(code === 0));
  });
  if (psqlAvailable) {
    // Replace semantics (a restore is a full rollback to the snapshot, not an
    // append) must match the in-process replay: drop current contents first so
    // migration seeds / rows written since the dump was taken never collide on
    // PK. `_migrations` is excluded so the migration ledger survives the wipe.
    const tables = await listTables();
    const script =
      `BEGIN;\n` +
      `TRUNCATE ${tables.map(quoteIdent).join(", ")} RESTART IDENTITY CASCADE;\n` +
      content +
      `\nCOMMIT;\n`;
    const out = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn("psql", ["-v", "ON_ERROR_STOP=1", config.DATABASE_URL, "-f", "-"], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => resolve({ code: -1, stderr: String(e) }));
      child.on("close", (code) => resolve({ code, stderr }));
      child.stdin.write(script);
      child.stdin.end();
    });
    if (out.code !== 0) {
      throw new ControlError(500, `psql restore failed: ${out.stderr.slice(0, 2000)}`);
    }
    // Restored rows carry explicit ids; COPY doesn't advance serial sequences,
    // so bring every sequence forward just like replayDump does.
    await rebaseSequences(tables);
    return;
  }
  await replayDump(content, backupId, actorUserId, requestId);
}

/** Re-sync serial sequences to the maximum restored `id` per table. Only
 * tables that actually have an `id` column are considered (calling
 * pg_get_serial_sequence on an id-less table raises and would abort). */
async function rebaseSequences(tables: string[]) {
  const seqRes = await pool.query(
    `SELECT c.relname AS t,
            pg_get_serial_sequence(c.oid::regclass::text, 'id') AS seq
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r'
       AND EXISTS (
         SELECT 1 FROM pg_attribute a
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND a.attname = 'id'
       )`
  );
  const seqByTable = new Map(seqRes.rows.map((r: any) => [r.t as string, r.seq as string]));
  for (const t of tables) {
    const seq = seqByTable.get(t);
    if (seq) {
      await pool.query(`SELECT setval($1, GREATEST(COALESCE((SELECT MAX(id) FROM ${quoteIdent(t)}), 0), 1))`, [seq]);
    }
  }
}

async function replayDump(content: string, backupId: number, actorUserId: number | null, requestId: string | null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lines = content.split("\n");
    const touchedTables: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith("--") || line.trim() === "") {
        i++;
        continue;
      }
      if (line.startsWith("COPY ") && line.endsWith(" FROM stdin;")) {
        // Header: COPY "table" ("col1", "col2") FROM stdin;
        const header = line.slice(5, line.length - " FROM stdin;".length);
        const parOpen = header.indexOf(" (");
        let tableToken = header;
        let colStr = "";
        if (parOpen !== -1) {
          tableToken = header.slice(0, parOpen);
          colStr = header.slice(parOpen + 2, -1);
        }
        const table = tableToken.startsWith('"')
          ? tableToken.slice(1, -1).replace(/""/g, '"')
          : tableToken;
        const cols = colStr
          ? colStr.split(",").map((s) => s.trim().replace(/^"|"$/g, "").replace(/""/g, '"'))
          : [];
        i++;
        const values: unknown[][] = [];
        while (i < lines.length && lines[i] !== "\\.") {
          values.push(lines[i].split("\t").map(parseCopyValue));
          i++;
        }
        i++; // consume the terminator line
if (cols.length === 0) continue;
        // Replace semantics (a restore is a full rollback to the snapshot, not
        // an append): drop the current contents first so PKs and sequences
        // never collide with rows written since the dump was taken.
        try {
          await client.query(`TRUNCATE ${quoteIdent(table)} RESTART IDENTITY CASCADE`);
        } catch (truncErr) {
          throw new Error(`TRUNCATE ${table}: ${String(truncErr)}`);
        }
        for (let r = 0; r < values.length; r += 500) {
          const chunk = values.slice(r, r + 500);
          const placeholders = chunk
            .map((_, ri) => `(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(",")})`)
            .join(",");
          try {
            await client.query(
              `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(",")}) VALUES ${placeholders}`,
              chunk.flat()
            );
          } catch (e) {
            throw new Error(`table ${table} row ${r}: ${String(e)}`);
          }
        }
        touchedTables.push(table);
      } else if (line.startsWith("CREATE TABLE")) {
        let sql = line;
        while (!sql.trimEnd().endsWith(";")) {
          i++;
          sql += "\n" + lines[i];
        }
        await client.query(sql);
        i++;
      } else {
        i++;
      }
    }
    // Restored rows carry explicit ids; bring every serial sequence forward so
    // the next plain insert can't collide with restored ids.
    await rebaseSequences(touchedTables);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[backup] replay of backup ${backupId} failed:`, err);
    throw new ControlError(500, `restore replay failed: ${String(err)}`);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Wipe (Dry Run -> Confirm -> Wipe -> Integrity Check -> rollback)
// ---------------------------------------------------------------------------

backupRouter.post(
  "/wipe/dry-run",
  ctl(async (req) => {
    sweepExpiredWipeTokens();
    const tables = (await pool.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0].n;
    const users = (await pool.query(`SELECT count(*)::int AS n FROM users`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    const characters = (await pool.query(`SELECT count(*)::int AS n FROM characters`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    const token = randomBytes(24).toString("hex");
    pendingWipes.set(token, { expiresAt: Date.now() + WIPE_TOKEN_TTL_MS });
    await controlAudit(req, "control.wipe.dry_run", "public", { after: { tables, users, characters } });
    return {
      ok: true,
      plan: { tables, users, characters },
      confirmationToken: token,
      tokenTtlSeconds: WIPE_TOKEN_TTL_MS / 1000,
      requiresPassphrase: Boolean(config.WIPE_PASSPHRASE),
    };
  })
);

backupRouter.post(
  "/wipe/confirm",
  ctl(async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = qstr(body.confirmationToken) ?? "";
    const pending = pendingWipes.get(token);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new ControlError(400, "invalid or expired confirmation token — run dry-run again");
    }
    pendingWipes.delete(token);

    const requestId = requestIdOf(req);
    const actorUserId = controlActorOf(req);
    const mode = body.mode === "data" ? "data" : "schema";
    const autoBackup = body.autoBackup === undefined ? true : Boolean(body.autoBackup);

    // Optional second factor from config, constant-time compared.
    if (config.WIPE_PASSPHRASE) {
      const provided = qstr(body.passphrase) ?? "";
      const a = Buffer.from(provided, "utf8");
      const b = Buffer.from(config.WIPE_PASSPHRASE, "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new ControlError(401, "invalid wipe passphrase");
      }
    }

    emitSecurityEvent({
      eventType: "control_wipe_confirm",
      severity: "CRITICAL",
      actorUserId,
      ip: req.ip ?? null,
      requestId,
      payload: { mode },
    }).catch(() => {});

    let backupId: number | null = null;
    let snapshot: Awaited<ReturnType<typeof createBackup>> | null = null;
    if (autoBackup) {
      const b = await createBackup(actorUserId, requestId, "pre-wipe safety snapshot");
      backupId = b.id;
      snapshot = b;
      await controlAudit(req, "control.backup.create", String(b.id), { reason: "pre-wipe auto snapshot" });
    }

    let failed = false;
    try {
      if (mode === "schema") {
        await pool.query(`DROP SCHEMA public CASCADE`);
        await pool.query(`CREATE SCHEMA public`);
        await runMigrations(pool);
        // The auto snapshot's ledger row was just destroyed with `public`.
        // Re-insert it (same id the client already received) so the safety
        // snapshot stays restorable right after the wipe.
        if (snapshot !== null) {
          await pool.query(
            `INSERT INTO backup_records (id, filename, app_version, size_bytes, checksum_sha256, created_by, status, notes)
             VALUES ($1,$2,$3,$4,$5,$6,'ok',$7)`,
            [
              snapshot.id,
              snapshot.filename,
              snapshot.appVersion,
              snapshot.sizeBytes,
              snapshot.checksumSha256,
              snapshot.createdByUserId,
              JSON.stringify({ label: "pre-wipe safety snapshot (autoBackup, ledger rebuilt after wipe)" }),
            ]
          );
          await pool.query(
            `SELECT setval(pg_get_serial_sequence('backup_records','id'),
                           GREATEST((SELECT COALESCE(MAX(id),1) FROM backup_records), 1))`
          );
        }
      } else {
        const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
        const tables = rows.map((r: any) => quoteIdent(r.tablename));
        if (tables.length > 0) {
          await pool.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
        }
      }
    } catch (err) {
      failed = true;
      let rollbackAttempted = false;
      if (backupId !== null) {
        rollbackAttempted = true;
        try {
          const rec = await findBackup(String(backupId));
          const content = await readBackupFile(rec);
          await applyDump(content, rec.id, actorUserId, requestId);
        } catch (rollbackErr) {
          console.error(`[control] wipe rollback failed: ${rollbackErr}`);
        }
      }
      throw new ControlError(500, `wipe failed: ${String(err)}${rollbackAttempted ? " (rollback attempted)" : ""}`);
    }

    const integrity = await integrityCheck();
    await controlAudit(req, "control.wipe.confirm", mode, {
      result: failed ? "failure" : "success",
      after: { integrity, autoBackupBackupId: backupId },
    });
    // The pre-wipe CRITICAL event above was destroyed with `public` — the
    // wipe-complete event re-records the irreversible action in the fresh feed.
    if (mode === "schema") {
      emitSecurityEvent({
        eventType: "control_wipe_confirm",
        severity: "CRITICAL",
        actorUserId,
        ip: req.ip ?? null,
        requestId,
        payload: { mode, phase: "complete", integrity },
      }).catch(() => {});
    }
    return { ok: true, mode, integrity, autoBackupBackupId: backupId };
  })
);

async function integrityCheck() {
  const migrationsApplied = (await pool.query(`SELECT count(*)::int AS n FROM _migrations`)).rows[0].n;
  const publicTables = (await pool.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0].n;
  const seededRoles = (await pool.query(`SELECT count(*)::int AS n FROM roles`)).rows[0].n;
  const seededItems = (await pool.query(`SELECT count(*)::int AS n FROM items`)).rows[0].n;
  return { migrationsApplied, publicTables, seededRoles, seededItems };
}

function sweepExpiredWipeTokens() {
  const now = Date.now();
  for (const [token, p] of pendingWipes) {
    if (p.expiresAt < now) pendingWipes.delete(token);
  }
}