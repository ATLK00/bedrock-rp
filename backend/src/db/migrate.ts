import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type pg from "pg";
import { pool } from "./pool.js";

// Deliberately raw SQL + a tracking table, no ORM auto-migrate.
// Per project rule: no hidden/implicit schema changes.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../migrations");

async function ensureMigrationsTable(targetPool: pg.Pool) {
  await targetPool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedMigrations(targetPool: pg.Pool): Promise<Set<string>> {
  const { rows } = await targetPool.query<{ filename: string }>(
    "SELECT filename FROM _migrations"
  );
  return new Set(rows.map((r) => r.filename));
}

/**
 * Apply all *.sql migrations in backend/migrations in filename order, each
 * inside its own transaction, tracked in `_migrations`. Exported so the
 * integration test suite can migrate a throwaway test database. Uses a
 * dedicated client checkout per file so a failure never leaves a partial
 * migration marked applied.
 */
export async function runMigrations(targetPool: pg.Pool = pool): Promise<void> {
  await ensureMigrationsTable(targetPool);
  const applied = await appliedMigrations(targetPool);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // filenames are numerically prefixed, sort = execution order

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] skip ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    console.log(`[migrate] applying ${file}`);
    const client = await targetPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
} catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`migration FAILED on ${file}: ${String(err)}`);
    } finally {
      client.release();
    }
  }

  console.log("[migrate] done");
}

/**
 * CLI entry (tsx src/db/migrate.ts / npm run migrate). When imported by
 * other code (tests), main() is not run.
 */
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runMigrations()
    .then(async () => {
      await pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
