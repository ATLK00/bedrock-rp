import { Router } from "express";
import { config } from "../../config/index.js";
import { exchangeDiscordCode, issueSessionToken, setSessionCookie, revokeSession } from "./index.js";
import jwt from "jsonwebtoken";

export const authRouter = Router();

authRouter.get("/discord/login", (_req, res) => {
  if (!config.DISCORD_CLIENT_ID || !config.DISCORD_REDIRECT_URI) {
    return res.status(500).json({ error: "Discord OAuth2 not configured" });
  }
  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    redirect_uri: config.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

authRouter.get("/discord/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) return res.status(400).json({ error: "missing code" });

  try {
    const user = await exchangeDiscordCode(code);
    const token = await issueSessionToken(user.id);
    setSessionCookie(res, token);
    res.json({ ok: true, discordTag: user.discord_tag });
  } catch (err: any) {
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
