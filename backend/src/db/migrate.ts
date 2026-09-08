import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./pool.js";

// Deliberately raw SQL + a tracking table, no ORM auto-migrate.
// Per project rule: no hidden/implicit schema changes.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../migrations");

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>(
    "SELECT filename FROM _migrations"
  );
  return new Set(rows.map((r) => r.filename));
}

async function main() {
  await ensureMigrationsTable();
  const applied = await appliedMigrations();

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
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[migrate] FAILED on ${file}:`, err);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log("[migrate] done");
  await pool.end();
}

main();
