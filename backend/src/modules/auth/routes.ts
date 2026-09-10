import { Router, type Request, type Response } from "express";
import { config } from "../../config/index.js";
import {
  exchangeDiscordCode,
  findUserByUsername,
  verifyPassword,
  issueSessionToken,
  setSessionCookie,
  revokeSession,
} from "./index.js";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { emitSecurityEvent } from "../security/index.js";
import { pool } from "../../db/pool.js";

export const authRouter = Router();

const USERNAME_RE = /^[A-Za-z0-9_\-]{3,32}$/;

// OAuth state: a random value minted at login, echoed back on the
// callback. This prevents login CSRF (an attacker initiating a login with
// the victim's session and completing it as themselves / redirecting the
// victim). Cross-checked against the session cookie below.
function generateOAuthState(): { value: string; expiresAt: number } {
  return { value: randomBytes(18).toString("hex"), expiresAt: Date.now() + 10 * 60 * 1000 };
}

const AUTH_STATE_COOKIE = "bedrock_rp_oauth_state";
const AUTH_NEXT_COOKIE = "bedrock_rp_oauth_next";

// Only ever redirect back to a local path after login (never an open
// redirect): must start with "/", not start with "//", no backslash.
function sanitizeNext(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) return "/player";
  if (!v.startsWith("/") || v.startsWith("//") || v.includes("\\")) return "/player";
  return v;
}

// State-cookie failure rendered for browsers: the #1 cause is opening the
// panel on a different host than the registered DISCORD_REDIRECT_URI (a
// 127.0.0.1-opened login mints a state cookie Discord's callback on
// localhost never receives — cookies are host-bound). Panels auto-jump to
// the canonical origin, but a direct callback hit still deserves a readable
// hint instead of a bare JSON body. API clients keep the machine format.
function stateErrorResponse(req: Request, res: Response) {
  res.clearCookie(AUTH_NEXT_COOKIE);
  if ((req.headers.accept ?? "").includes("text/html")) {
    const uri = config.DISCORD_REDIRECT_URI;
    if (!uri) return res.status(400).json({ error: "invalid state" });
    const origin = new URL(uri).origin;
    return res.status(400).send(
      `<!doctype html><html lang="th"><head><meta charset="utf-8">` +
        `<title>เข้าสู่ระบบขัดจังหวะ</title></head>` +
        `<body style="font-family:system-ui;background:#101317;color:#e6e6e6;padding:24px">` +
        `<h1>การเข้าสู่ระบบขัดจังหวะ (invalid state)</h1>` +
        `<p>คุกกี้ OAuth state ไม่ตรงกัน — ส่วนใหญ่เกิดจากการเปิดแผงด้วย host ที่ไม่ตรงกับที่ลงทะเบียนกับ Discord ไว้.</p>` +
        `<p>ให้เปิดแผงด้วยลิงก์นี้แล้วลองล็อกอินอีกครั้ง: <a href="${origin}/">${origin}/</a></p>` +
        `</body></html>`
    );
  }
  return res.status(400).json({ error: "invalid state" });
}

authRouter.get("/discord/login", (req, res) => {
  if (!config.DISCORD_CLIENT_ID || !config.DISCORD_REDIRECT_URI) {
    return res.status(500).json({ error: "Discord OAuth2 not configured" });
  }
  const state = generateOAuthState();
  res.cookie(AUTH_STATE_COOKIE, `${state.value}.${state.expiresAt}`, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
  });
  if (req.query.next !== undefined) {
    res.cookie(AUTH_NEXT_COOKIE, sanitizeNext(req.query.next), {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 10 * 60 * 1000,
    });
  }
  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    redirect_uri: config.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state: state.value,
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

authRouter.get("/discord/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code) return res.status(400).json({ error: "missing code" });

  // Login-CSRF / state check: the callback must echo the state we set on
  // the login redirect. Absence or mismatch is suspicious.
  const expected = req.cookies?.[AUTH_STATE_COOKIE] as string | undefined;
  if (!state || !expected) {
    const requestId = (req as unknown as { requestId?: string }).requestId ?? null;
    emitSecurityEvent({
      eventType: "oauth_state_missing",
      severity: "MEDIUM",
      ip: req.ip ?? null,
      requestId,
      payload: { detail: "callback without a login-generated state" },
    }).catch(() => {});
    return stateErrorResponse(req, res);
  }
  const [stateValue, expiresAt] = expected.split(".");
  if (stateValue !== state || Number(expiresAt) < Date.now()) {
    emitSecurityEvent({
      eventType: "oauth_state_mismatch",
      severity: "HIGH",
      ip: req.ip ?? null,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
      payload: { detail: "state mismatch or expired state on OAuth callback" },
    }).catch(() => {});
    res.clearCookie(AUTH_STATE_COOKIE);
    return stateErrorResponse(req, res);
  }
  res.clearCookie(AUTH_STATE_COOKIE);

  try {
    const user = await exchangeDiscordCode(code);
    const token = await issueSessionToken(user.id);
    setSessionCookie(res, token);
    // Browser navigation (the Player Web login flow) lands on the panel —
    // or the local path requested via ?next= (used by /admin, which is
    // gated). API clients that fetched this endpoint with a JSON accept
    // header still get the machine-readable body.
    if ((req.headers.accept ?? "").includes("text/html")) {
      const next = req.cookies?.[AUTH_NEXT_COOKIE];
      res.clearCookie(AUTH_NEXT_COOKIE);
      return res.redirect(sanitizeNext(next));
    }
    res.json({ ok: true, discordTag: user.discord_tag });
  } catch (err: any) {
    // Security-relevant: a failed login with a *valid* state means the
    // Discord exchange itself failed (bad code, banned account, network).
    const msg: string = err?.message ?? "unknown";
    emitSecurityEvent({
      eventType: msg.includes("banned") ? "login_banned_account" : "login_failure",
      severity: msg.includes("banned") ? "MEDIUM" : "LOW",
      ip: req.ip ?? null,
      requestId: (req as unknown as { requestId?: string }).requestId ?? null,
      payload: { detail: msg.slice(0, 200) },
    }).catch(() => {});
    // Deliberately not leaking internal error detail to the client beyond a generic message,
    // full error still goes to the server log for debugging.
    console.error("[auth] discord callback failed", err);
    res.status(401).json({ error: "login failed" });
  }
});

/**
 * Username/password login for local admin accounts (created via the
 * `admin:create` bootstrap script). Success issues the same JWT session
 * cookie as the Discord flow, so every existing session/RBAC surface
 * (web admin, player panel, /admin) works unchanged. Failure paths emit
 * Security Center events mirroring the Discord login failure handling.
 * Rate-limited via authLimiter (10 req / 15 min) in app.ts, like every
 * other /auth route.
 */
authRouter.post("/login", async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const requestId = (req as unknown as { requestId?: string }).requestId ?? null;

  if (!USERNAME_RE.test(username) || password.length === 0 || password.length > 256) {
    return res.status(400).json({ error: "invalid username or password" });
  }

  try {
    const user = await findUserByUsername(username);
    if (!user) {
      await emitSecurityEvent({
        eventType: "login_failure",
        severity: "LOW",
        ip: req.ip ?? null,
        requestId,
        payload: { method: "username", username, detail: "unknown username" },
      }).catch(() => {});
      return res.status(401).json({ error: "invalid username or password" });
    }

    if (user.is_banned) {
      await emitSecurityEvent({
        eventType: "login_banned_account",
        severity: "MEDIUM",
        ip: req.ip ?? null,
        requestId,
        payload: { method: "username", username },
      }).catch(() => {});
      return res.status(403).json({ error: "account is banned" });
    }

    const check = await verifyPassword(password, user.password_hash);
    if (!check.ok) {
      await emitSecurityEvent({
        eventType: "login_failure",
        severity: "LOW",
        ip: req.ip ?? null,
        requestId,
        payload: { method: "username", username, detail: "wrong password" },
      }).catch(() => {});
      return res.status(401).json({ error: "invalid username or password" });
    }

    await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    const token = await issueSessionToken(user.id);
    setSessionCookie(res, token);
    await pool.query(
      `INSERT INTO audit_log (actor_user_id, action, target_type, target_id, payload, result)
       VALUES ($1, 'auth.login', 'user', $2, $3, 'success')`,
      [user.id, String(user.id), JSON.stringify({ method: "username" })]
    );
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[auth] username/password login failed", err);
    res.status(500).json({ error: "login failed" });
  }
});

/**
 * Revokes the current session (not just clearing the cookie client-side —
 * the underlying `sessions` row is marked revoked, so even if someone
 * captured the cookie value beforehand it stops working immediately).
 */
authRouter.post("/logout", async (req, res) => {
  const token = req.cookies?.["bedrock_rp_session"];
  if (token) {
    try {
      const payload = jwt.decode(token) as { jti?: string } | null;
      if (payload?.jti) await revokeSession(payload.jti);
    } catch {
      // malformed token, nothing to revoke — fall through to clearing the cookie anyway
    }
  }
  res.clearCookie("bedrock_rp_session");
  res.status(204).end();
});
