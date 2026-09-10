import { randomBytes } from "node:crypto";
import { pool } from "../db/pool.js";
import { hashPassword } from "../modules/auth/index.js";

const USERNAME_RE = /^[A-Za-z0-9_\-]{3,32}$/;

function randomPassword(len = 20): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * Bootstrap a local username/password admin account and grant it the
 * `owner` role (full permission bypass — see 002_rbac_audit.sql).
 *
 *   npm run admin:create -- <username> <password>
 *   npm run admin:create -- <username> --random   (generates a strong password)
 */
async function main() {
  const username = process.argv[2];
  let password = process.argv[3];
  const generated = password === "--random";

  if (!username || !USERNAME_RE.test(username)) {
    console.error("usage: npm run admin:create -- <username> <password>");
    console.error("username: 3-32 chars, letters/digits/_/- only");
    process.exit(1);
  }
  if (generated) password = randomPassword(20);
  if (!password || password.length < 8 || password.length > 128) {
    console.error("password must be 8-128 characters");
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  const { rows } = await pool.query(
    `INSERT INTO users (username, discord_tag, password_hash, last_login_at)
     VALUES ($1, $1, $2, now())
     ON CONFLICT (username)
     DO UPDATE SET password_hash = EXCLUDED.password_hash, last_login_at = now()
     RETURNING id, username`,
    [username, passwordHash]
  );
  const user = rows[0];

  await pool.query(
    `INSERT INTO user_roles (user_id, role_id, granted_by)
     SELECT $1, r.id, NULL FROM roles r WHERE r.name = 'owner'
     ON CONFLICT DO NOTHING`,
    [user.id]
  );

  console.log(`admin account OK: ${user.username} (id=${user.id}), granted role 'owner'`);
  if (generated) console.log(`generated password (shown once): ${password}`);
}

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (err) => {
    console.error(err);
    try {
      await pool.end();
    } catch {
      /* noop */
    }
    process.exit(1);
  });