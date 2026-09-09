import { Router, type Request, type Response } from "express";
import { config } from "../../config/index.js";
import { exchangeDiscordCode, issueSessionToken, setSessionCookie, revokeSession } from "./index.js";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { emitSecurityEvent } from "../security/index.js";

export const authRouter = Router();

// OAuth state: a random value minted at login, echoed back on the
// callback. This prevents login CSRF (an attacker initiating a login with
// the victim's session and completing it as themselves / redirecting the
// victim). Cross-checked against the session cookie below.
function generateOAuthState(): { value: string; expiresAt: number } {
  return { value: randomBytes(18).toString("hex"), expiresAt: Date.now() + 10 * 60 * 1000 };
}

const AUTH_STATE_COOKIE = "bedrock_rp_oauth_state";

// State-cookie failure rendered for browsers: the #1 cause is opening the
// panel on a different host than the registered DISCORD_REDIRECT_URI (a
// 127.0.0.1-opened login mints a state cookie Discord's callback on
// localhost never receives — cookies are host-bound). Panels auto-jump to
// the canonical origin, but a direct callback hit still deserves a readable
// hint instead of a bare JSON body. API clients keep the machine format.
function stateErrorResponse(req: Request, res: Response) {
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

authRouter.get("/discord/login", (_req, res) => {
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
    // Browser navigation (the Player Web login flow) lands on the panel;
    // API clients that fetched this endpoint with a JSON accept header
    // still get the machine-readable body.
    if ((req.headers.accept ?? "").includes("text/html")) {
      return res.redirect("/player");
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
