import pg from "pg";
import { config } from "../config/index.js";

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  // A dropped idle connection should not crash the process.
  console.error("[db] unexpected error on idle client", err);
});

/**
 * Run `fn` inside a transaction. Rolls back on any thrown error.
 * Use this for anything that touches money or inventory —
 * never issue multi-statement writes outside a transaction.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
