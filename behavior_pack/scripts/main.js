import { world, system } from "@minecraft/server";
import { beforeEvents as adminBeforeEvents } from "@minecraft/server-admin";
import { http, HttpRequest, HttpRequestMethod, HttpHeader } from "@minecraft/server-net";
import { getBridgeConfig } from "./bridgeConfig.js";

/**
 * IDENTITY NOTE: `world.afterEvents.playerJoin`'s `event.playerId` is
 * NOT a real player identifier — Mojang's own docs describe it as "no
 * meaning should be inferred from the value", and testing confirmed it
 * does not match the real Xbox Live xuid printed in the server's own
 * console log (`Player connected: <name>, xuid: <id>`).
 *
 * The correct source is `@minecraft/server-admin`'s
 * `beforeEvents.asyncPlayerJoin` event, whose `persistentId` field is
 * documented as "an identifier that can be used to identify a player
 * across sessions" — stable per player, which is what a linking scheme
 * actually needs. It is captured here (by player name) and looked up
 * again wherever we need "this player's persistent identity" (the
 * backend join-notify call, and the !link chat command).
 *
 * persistentId is NOT necessarily the literal Xbox Live xuid string —
 * it's an opaque stable identifier. The backend's `characters.persistent_id`
 * column stores this value (renamed from the old `characters.xuid`, a
 * holdover name that didn't mean literal Xbox xuid). Don't assume this
 * value has any external meaning outside this system. The wire field
 * (`xuid` in /bridge/character/link) is kept unchanged for compatibility.
 */
const persistentIdByName = new Map();

/**
 * Cached once at load time. `world.beforeEvents.chatSend`'s callback
 * runs in "restricted execution" mode, where `@minecraft/server-admin`'s
 * `variables.get()` (used inside `getBridgeConfig()`) cannot be called —
 * confirmed by testing (`Native function [ServerVariables::get] cannot
 * be used in restricted execution`). Reading it once up front and
 * reusing the cached value avoids calling it from a restricted context.
 * This means a variables.json change requires a server restart to take
 * effect — acceptable for how rarely this changes.
 */
let cachedBridgeConfig = null;

system.run(() => {
  cachedBridgeConfig = getBridgeConfig();
  if (!cachedBridgeConfig) {
    console.warn(
      "[bedrock-rp] bridge not configured (missing bedrock-rp:backendUrl/bridgeSecret in variables.json) — bridge calls will be skipped all session"
    );
  }

  adminBeforeEvents.asyncPlayerJoin.subscribe((event) => {
    persistentIdByName.set(event.name, event.persistentId);
    event.allowJoin();
  });
});

world.afterEvents.playerJoin.subscribe((event) => {
  if (!cachedBridgeConfig) return;

  const persistentId = persistentIdByName.get(event.playerName);
  if (!persistentId) {
    console.warn(
      `[bedrock-rp] no persistentId captured for ${event.playerName} — asyncPlayerJoin may not have fired first, skipping backend call`
    );
    return;
  }

  const req = new HttpRequest(`${cachedBridgeConfig.backendUrl}/bridge/player/join`);
  req.method = HttpRequestMethod.Post;
  req.headers = [
    new HttpHeader("Content-Type", "application/json"),
    new HttpHeader("x-bds-bridge-secret", cachedBridgeConfig.bridgeSecret),
  ];
  req.body = JSON.stringify({ playerName: event.playerName, playerId: persistentId });

  http.request(req).then(
    (response) => {
      if (response.status < 200 || response.status >= 300) {
        console.warn(`[bedrock-rp] backend rejected player join notify: HTTP ${response.status}`);
      }
    },
    (err) => {
      console.warn(`[bedrock-rp] backend unreachable for player join notify: ${err}`);
    }
  );
});

/**
 * `!link <code>` — player types this in chat after requesting a code on
 * the web (POST /character/link-code while logged in). We intercept the
 * chat message before it's broadcast (cancel it so other players don't
 * see codes/failed attempts in public chat), then call the backend to
 * consume the code and tie this player's persistentId to their character.
 *
 * A leading `/` is deliberately NOT used as the trigger — Minecraft
 * intercepts any `/`-prefixed chat message as an attempted game command
 * client-side (confirmed by testing: shows "Cheats aren't enabled in
 * this world" and never reaches this handler at all on a world with
 * cheats/commands off, which this RP's worlds intentionally have off).
 */
world.beforeEvents.chatSend.subscribe((event) => {
  const message = event.message.trim();
  if (!message.toLowerCase().startsWith("!link ")) return;

  event.cancel = true; // never let this hit public chat, whether it succeeds or fails
  const code = message.slice(6).trim();
  const player = event.sender;

  if (!cachedBridgeConfig) {
    player.sendMessage("§cLinking is not available right now — the server isn't configured for it. Tell an admin.");
    return;
  }
  if (!code) {
    player.sendMessage("§cUsage: !link <code> — get a code from the website after logging in with Discord.");
    return;
  }

  const persistentId = persistentIdByName.get(player.name);
  if (!persistentId) {
    player.sendMessage("§cCouldn't determine your account identity — try rejoining the server and linking again.");
    return;
  }

  const req = new HttpRequest(`${cachedBridgeConfig.backendUrl}/bridge/character/link`);
  req.method = HttpRequestMethod.Post;
  req.headers = [
    new HttpHeader("Content-Type", "application/json"),
    new HttpHeader("x-bds-bridge-secret", cachedBridgeConfig.bridgeSecret),
  ];
  req.body = JSON.stringify({ code, xuid: persistentId });

  http.request(req).then(
    (response) => {
      try {
        const body = JSON.parse(response.body);
        // system.run: sendMessage must happen back on the main thread, not inside the promise callback's raw context
        system.run(() => player.sendMessage(body.ok ? `§a${body.message}` : `§c${body.message}`));
      } catch {
        system.run(() => player.sendMessage("§cLink failed — unexpected response from server."));
      }
    },
    (err) => {
      system.run(() => player.sendMessage("§cCouldn't reach the server to link your account. Try again in a moment."));
      console.warn(`[bedrock-rp] link request failed: ${err}`);
    }
  );
});

world.afterEvents.playerLeave.subscribe((event) => {
  persistentIdByName.delete(event.playerName); // avoid an unbounded map across a long-running server
});

system.run(() => {
  console.warn("[bedrock-rp] behavior pack loaded");
});
