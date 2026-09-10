// Resource Manager (#4) — /control/resources/*
// Operator-registered server resources probed and operated through the
// control API. The EXE/web-admin/AI give verbs; the backend executes them.
//
// Safety: install/update/restart/status only ever run a command the OPERATOR
// wrote into the resources registry at registration time. A verb with no
// configured command returns 409 — the API never guesses a command.

import { Router } from "express";
import type { Request } from "express";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { pool } from "../../db/pool.js";
import { emitSecurityEvent } from "../security/index.js";
import { ControlError, ctl, controlAudit, controlActorOf, qstr, requestIdOf } from "./common.js";

const execAsync = promisify(exec);

export const resourceRouter = Router();

const KINDS = ["http", "docker", "process"] as const;
type ResourceKind = (typeof KINDS)[number];
const VERBS = ["install", "update", "restart", "status"] as const;
const NAME_RE = /^[a-z0-9_-]{1,64}$/i;

interface ResourceRow {
  id: number;
  name: string;
  kind: ResourceKind;
  target: string;
  enabled: boolean;
  version: string | null;
  dependencies: string[];
  commands: Record<string, string>;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  detail: string | null;
}

async function findResource(name: string): Promise<ResourceRow | null> {
  const { rows } = await pool.query(`SELECT * FROM resources WHERE name = $1`, [name]);
  return rows[0] ?? null;
}

/** Best-effort health probe per resource kind. Never throws — a probe failure is a status, not an error. */
async function probeResource(row: ResourceRow): Promise<ProbeResult> {
  if (!row.enabled) return { ok: false, latencyMs: null, detail: "disabled" };
  switch (row.kind) {
    case "http": {
      const start = Date.now();
      try {
        const r = await fetch(row.target, { signal: AbortSignal.timeout(5000) });
        const ok = r.status >= 200 && r.status < 500;
        return { ok, latencyMs: Date.now() - start, detail: `http ${r.status}` };
      } catch (e: any) {
        return { ok: false, latencyMs: Date.now() - start, detail: String(e?.message ?? e).split("\n")[0].slice(0, 200) };
      }
    }
    case "docker": {
      try {
        const { stdout } = await execAsync(`docker inspect -f '{{.State.Running}}' ${row.target}`, { timeout: 8000 });
        const state = stdout.trim();
        return { ok: state === "true", latencyMs: null, detail: `state=${state || "unknown"}` };
      } catch (e: any) {
        return { ok: false, latencyMs: null, detail: String(e?.message ?? e).split("\n")[0].slice(0, 200) };
      }
    }
    case "process": {
      const check =
        process.platform === "win32"
          ? `tasklist /FI "IMAGENAME eq ${row.target}"`
          : `pgrep -f "${row.target}" || true`;
      try {
        const { stdout } = await execAsync(check, { timeout: 8000 });
        const hit = String(stdout).trim().length > 0;
        return { ok: hit, latencyMs: null, detail: hit ? String(stdout).trim().split("\n")[0].slice(0, 200) : "not found" };
      } catch (e: any) {
        return { ok: false, latencyMs: null, detail: String(e?.message ?? e).split("\n")[0].slice(0, 200) };
      }
    }
  }
}

async function withStatus(row: ResourceRow) {
  return { ...row, status: await probeResource(row) };
}

// ---------------------------------------------------------------------------
// Registry CRUD
// ---------------------------------------------------------------------------

resourceRouter.get(
  "/resources",
  ctl(async () => {
    const { rows } = await pool.query(`SELECT * FROM resources ORDER BY id ASC`);
    const resources = await Promise.all(rows.map((r: ResourceRow) => withStatus(r)));
    return { ok: true, count: resources.length, resources };
  })
);

resourceRouter.post(
  "/resources",
  ctl(
    async (req) => {
      const body = (req.body ?? {}) as Record<string, any>;
      const name = qstr(body.name) ?? "";
      if (!NAME_RE.test(name)) {
        throw new ControlError(400, "name must be 1-64 chars of [a-z0-9_-]");
      }
      const kind = qstr(body.kind) ?? "http";
      if (!(KINDS as readonly string[]).includes(kind)) {
        throw new ControlError(400, `kind must be one of: ${KINDS.join(", ")}`);
      }
      const target = qstr(body.target) ?? "";
      if (!target || target.length > 512) {
        throw new ControlError(400, "target is required (<= 512 chars)");
      }
      const commands = sanitizeCommands(body.commands);

      const existing = await findResource(name);
      if (existing) throw new ControlError(409, `resource already exists: ${name}`);

      const { rows } = await pool.query(
        `INSERT INTO resources (name, kind, target, enabled, version, dependencies, commands, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, created_at`,
        [
          name,
          kind,
          target,
          body.enabled === undefined ? true : Boolean(body.enabled),
          qstr(body.version) ?? null,
          JSON.stringify(normalizeDeps(body.dependencies)),
          JSON.stringify(commands),
          qstr(body.notes) ?? null,
        ]
      );
      const row = await findResource(name);
      await controlAudit(req, "control.resource.register", name, {
        after: { id: Number(rows[0].id), kind, target },
      });
      return { ok: true, resource: await withStatus(row!) };
    },
    201
  )
);

resourceRouter.get(
  "/resources/:name",
  ctl(async (req) => {
    const row = await findResource(req.params.name);
    if (!row) throw new ControlError(404, `resource not found: ${req.params.name}`);
    return { ok: true, resource: await withStatus(row) };
  })
);

resourceRouter.patch(
  "/resources/:name",
  ctl(async (req) => {
    const row = await findResource(req.params.name);
    if (!row) throw new ControlError(404, `resource not found: ${req.params.name}`);
    const body = (req.body ?? {}) as Record<string, any>;

    const kind = body.kind !== undefined ? qstr(body.kind) : undefined;
    if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) {
      throw new ControlError(400, `kind must be one of: ${KINDS.join(", ")}`);
    }
    const target = body.target !== undefined ? qstr(body.target) : undefined;
    if (target !== undefined && (!target || target.length > 512)) {
      throw new ControlError(400, "target must be non-empty (<= 512 chars)");
    }
    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : undefined;
    const version = body.version !== undefined ? (qstr(body.version) ?? null) : undefined;
    const dependencies = body.dependencies !== undefined ? normalizeDeps(body.dependencies) : undefined;
    const commands = body.commands !== undefined ? sanitizeCommands(body.commands) : undefined;
    const notes = body.notes !== undefined ? (qstr(body.notes) ?? null) : undefined;

    const { rows } = await pool.query(
      `UPDATE resources
       SET kind = COALESCE($2, kind),
           target = COALESCE($3, target),
           enabled = COALESCE($4, enabled),
           version = COALESCE($5, version),
           dependencies = COALESCE($6, dependencies),
           commands = COALESCE($7, commands),
           notes = COALESCE($8, notes),
           updated_at = now()
       WHERE name = $1
       RETURNING *`,
      [row.name, kind ?? null, target ?? null, enabled ?? null, version ?? null,
       dependencies !== undefined ? JSON.stringify(dependencies) : null,
       commands !== undefined ? JSON.stringify(commands) : null,
       notes ?? null]
    );
    await controlAudit(req, "control.resource.update", row.name, { before: row, after: rows[0] });
    return { ok: true, resource: await withStatus(rows[0] as ResourceRow) };
  })
);

resourceRouter.delete(
  "/resources/:name",
  ctl(async (req) => {
    const row = await findResource(req.params.name);
    if (!row) throw new ControlError(404, `resource not found: ${req.params.name}`);
    await pool.query(`DELETE FROM resources WHERE name = $1`, [row.name]);
    await controlAudit(req, "control.resource.unregister", row.name, { before: row });
    return { ok: true, unregistered: row.name };
  })
);

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

resourceRouter.post(
  "/resources/:name/enable",
  ctl(async (req) => {
    const row = await findResource(req.params.name);
    if (!row) throw new ControlError(404, `resource not found: ${req.params.name}`);
    await pool.query(`UPDATE resources SET enabled = true, updated_at = now() WHERE name = $1`, [row.name]);
    await controlAudit(req, "control.resource.enable", row.name);
    return { ok: true, resource: row.name, enabled: true };
  })
);

resourceRouter.post(
  "/resources/:name/disable",
  ctl(async (req) => {
    const row = await findResource(req.params.name);
    if (!row) throw new ControlError(404, `resource not found: ${req.params.name}`);
    await pool.query(`UPDATE resources SET enabled = false, updated_at = now() WHERE name = $1`, [row.name]);
    await controlAudit(req, "control.resource.disable", row.name);
    return { ok: true, resource: row.name, enabled: false };
  })
);

resourceRouter.get(
  "/resources/:name/version",
  ctl(async (req) => {
    const row = await findResource(req.params.name);
    if (!row) throw new ControlError(404, `resource not found: ${req.params.name}`);
    const dependencyStatus: Record<string, ProbeResult | null> = {};
    for (const dep of row.dependencies) {
      const depRow = await findResource(dep);
      dependencyStatus[dep] = depRow ? await probeResource(depRow) : null;
    }
    return {
      ok: true,
      resource: row.name,
      version: row.version,
      dependencies: dependencyStatus,
    };
  })
);

for (const verb of VERBS) {
  resourceRouter.post(
    `/resources/:name/${verb}`,
    ctl(async (req) => runVerb(req, req.params.name, verb))
  );
}

async function runVerb(req: Request, name: string, verb: (typeof VERBS)[number]) {
  const row = await findResource(name);
  if (!row) throw new ControlError(404, `resource not found: ${name}`);
  if (!row.enabled && verb !== "status") throw new ControlError(409, `resource is disabled: ${name}`);
  const cmd = row.commands?.[verb];
  if (!cmd || !cmd.trim()) throw new ControlError(409, `no ${verb} command configured for resource: ${name}`);
  const actorUserId = controlActorOf(req);
  const requestId = requestIdOf(req);

  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let ok = true;
  try {
    const result = await execAsync(cmd, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (e: any) {
    ok = false;
    stdout = String(e?.stdout ?? "");
    stderr = String(e?.stderr ?? e?.message ?? e);
    emitSecurityEvent({
      eventType: "control_resource_command_failed",
      severity: "MEDIUM",
      actorUserId,
      ip: req.ip ?? null,
      requestId,
      targetType: "resource",
      targetId: name,
      payload: { verb },
    }).catch(() => {});
  }
  const durationMs = Date.now() - startedAt;
  await controlAudit(req, `control.resource.${verb}`, name, {
    result: ok ? "success" : "failure",
    after: { durationMs, stdoutHead: stdout.slice(0, 1000), stderrHead: stderr.slice(0, 1000) },
  });

  return {
    ok,
    resource: name,
    verb,
    durationMs,
    stdout: stdout.slice(0, 5000),
    stderr: stderr.slice(0, 2000),
  };
}

function sanitizeCommands(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (input === undefined) return out;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ControlError(400, "commands must be an object of verb -> command string");
  }
  for (const [key, value] of Object.entries(input)) {
    if (!(VERBS as readonly string[]).includes(key)) {
      throw new ControlError(400, `unknown command verb: ${key} (allowed: ${VERBS.join(", ")})`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new ControlError(400, `command for '${key}' must be a non-empty string`);
    }
    out[key] = value;
  }
  return out;
}

function normalizeDeps(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.some((d) => typeof d !== "string" || !NAME_RE.test(d))) {
    throw new ControlError(400, "dependencies must be an array of resource names ([a-z0-9_-])");
  }
  return [...new Set(input as string[])];
}