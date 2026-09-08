import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { pool } from "../../db/pool.js";
import { config } from "../../config/index.js";

const DISCORD_API = "https://discord.com/api/v10";

interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
}
interface DiscordUserResponse {
  id: string;
  username: string;
  discriminator: string;
}

/**
 * Exchange a Discord OAuth2 authorization code for the user's Discord
 * identity, then upsert our local `users` row. Requires
 * DISCORD_CLIENT_ID/SECRET/REDIRECT_URI to be set â€” throws a clear error
 * if they aren't, rather than silently failing partway through.
 *
 * NOT YET TESTED against a real Discord app (no network in the
 * environment that wrote this) â€” verify the token/user endpoints and
 * error handling against a real Discord OAuth2 app before trusting this
 * in production. See CHANGELOG_AI.md for this iteration.
 */
export async function exchangeDiscordCode(code: string) {
  if (!config.DISCORD_CLIENT_ID || !config.DISCORD_CLIENT_SECRET || !config.DISCORD_REDIRECT_URI) {
    throw new Error(
      "Discord OAuth2 is not configured: set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI"
    );
  }

  const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID,
      client_secret: config.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.DISCORD_REDIRECT_URI,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Discord token exchange failed: HTTP ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const token = (await tokenRes.json()) as DiscordTokenResponse;

  const userRes = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `${token.token_type} ${token.access_token}` },
  });
  if (!userRes.ok) {
    throw new Error(`Discord user fetch failed: HTTP ${userRes.status} ${await userRes.text()}`);
  }
  const discordUser = (await userRes.json()) as DiscordUserResponse;

  const user = await upsertUserByDiscordId(discordUser.id, discordUser.username);
  if (user.is_banned) {
    throw new Error("this Discord account is banned");
  }
  return user;
}

/** Find or create the local user row for a given verified Discord ID. */
export async function upsertUserByDiscordId(discordId: string, discordTag: string) {
  const { rows } = await pool.query(
    `INSERT INTO users (discord_id, discord_tag, last_login_at)
     VALUES ($1, $2, now())
     ON CONFLICT (discord_id) DO UPDATE SET discord_tag = $2, last_login_at = now()
     RETURNING id, discord_id, discord_tag, is_banned`,
    [discordId, discordTag]
  );
  return rows[0];
}

const SESSION_COOKIE = "bedrock_rp_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Issues a JWT AND records its `jti` in the `sessions` table. The JWT's
 * own signature/expiry is still checked first (cheap, no DB hit), but
 * every verification also checks `sessions.revoked_at IS NULL` â€” this
 * is what makes it possible to kill a specific session (or all of a
 * user's sessions) before natural JWT expiry, e.g. when banning someone.
 */
export async function issueSessionToken(userId: number): Promise<string> {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  await pool.query(
    `INSERT INTO sessions (jti, user_id, expires_at) VALUES ($1, $2, $3)`,
    [jti, userId, expiresAt]
  );

  return jwt.sign({ sub: userId, jti }, config.JWT_SECRET, { expiresIn: SESSION_TTL_SECONDS });
}

/**
 * Verifies the JWT signature/expiry, then checks the session hasn't
 * been revoked and the user isn't banned. Every check after the JWT
 * signature is a DB round trip â€” acceptable for this project's scale;
 * revisit with a cache if this becomes a hot path under real load.
 *
 * SECURITY: the returned user id comes from `sessions.user_id` (the DB
 * row owning the jti), NOT from the JWT's `sub` claim. A JWT's claims
 * are only as trustworthy as the signing secret; if that secret is
 * ever exposed (leaked env var, compromised host, etc.), an attacker
 * who also has any single valid, unrevoked jti could otherwise mint a
 * token with an arbitrary `sub` and be authenticated as that user. Tying
 * the trusted identity to the DB row the jti actually belongs to closes
 * that path: forging a session still requires an INSERT into `sessions`
 * for the target user, not just knowledge of the secret.
 */
export async function verifySessionToken(token: string): Promise<number | null> {
  let payload: { sub: number; jti: string };
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);

    if (
      typeof decoded === "string" ||
      typeof decoded.sub !== "number" ||
      typeof decoded.jti !== "string"
    ) {
      return null;
    }

    payload = {
      sub: decoded.sub,
      jti: decoded.jti,
    };
  } catch {
    return null; // expired/invalid signature â€” treat as unauthenticated, not a crash
  }
  if (!payload.jti) return null; // old-format token issued before this migration â€” force re-login

  const { rows } = await pool.query(
    `SELECT s.user_id, s.revoked_at, s.expires_at, u.is_banned
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.jti = $1`,
    [payload.jti]
  );
  if (rows.length === 0) return null; // session record missing (e.g. DB reset) â€” force re-login
  const session = rows[0];
  if (session.revoked_at || session.is_banned) return null;
  if (new Date(session.expires_at) < new Date()) return null;
  if (String(session.user_id) !== String(payload.sub)) return null; // jti belongs to a different user than claimed â€” forged/mismatched token

  return payload.sub;
}

export async function revokeSession(jti: string) {
  await pool.query(`UPDATE sessions SET revoked_at = now() WHERE jti = $1 AND revoked_at IS NULL`, [jti]);
}

/** Kills every active session for a user â€” call this when banning someone. */
export async function revokeAllSessionsForUser(userId: number) {
  await pool.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

/** Express middleware: reads the session cookie, sets req.userId if valid. Does NOT reject if missing â€” routes that need auth use requirePermission() separately, which itself 401s. */
export async function sessionMiddleware(req: any, _res: any, next: any) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      const userId = await verifySessionToken(token);
      if (userId) req.userId = userId;
    }
    next();
  } catch (err) {
    // A DB hiccup here should degrade to "unauthenticated", not crash the request.
    console.error("[auth] sessionMiddleware error, treating as unauthenticated", err);
    next();
  }
}

export function setSessionCookie(res: any, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export const authRouterCookieName = SESSION_COOKIE;

/**
 * Deletes `sessions` rows that are no longer useful for anything: past
 * their `expires_at`, or already `revoked_at`. Safe to run any time â€”
 * a deleted row was never going to authenticate anyone again anyway
 * (verifySessionToken already rejects both expired and revoked
 * sessions); this is purely table hygiene so `sessions` doesn't grow
 * unboundedly on a long-running server. Kept separate from
 * revocation/expiry logic itself â€” deleting a row is not what makes a
 * session stop working, it's already not working by the time this runs.
 */
export async function cleanupOldSessions(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM sessions WHERE expires_at < now() OR revoked_at IS NOT NULL`
  );
  return rowCount ?? 0;
}

let sessionCleanupHandle: ReturnType<typeof setInterval> | null = null;

/** Starts a periodic job that deletes stale session rows. Call once at backend startup. */
export function startSessionCleanupJob(intervalMs = 60 * 60 * 1000) {
  if (sessionCleanupHandle) return;
  sessionCleanupHandle = setInterval(async () => {
    try {
      const count = await cleanupOldSessions();
      if (count > 0) console.log(`[auth] cleaned up ${count} stale session row(s)`);
    } catch (err) {
      console.error("[auth] session cleanup job failed", err);
    }
  }, intervalMs);
}

export function stopSessionCleanupJob() {
  if (sessionCleanupHandle) {
    clearInterval(sessionCleanupHandle);
    sessionCleanupHandle = null;
  }
}

