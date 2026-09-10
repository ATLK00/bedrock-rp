import { world, system } from "@minecraft/server";
import { beforeEvents as adminBeforeEvents } from "@minecraft/server-admin";
import { http, HttpRequest, HttpRequestMethod, HttpHeader } from "@minecraft/server-net";
import { getBridgeConfig } from "./bridgeConfig.js";
import { hmacSha256Hex } from "./crypto_hmac.js";
import { openInventoryUi, tryOpenInventoryUi, promptJoinLinkStatus } from "./inventory_ui.js";
import { tryHandleAdminCommand } from "./admin_commands.js";
import {
  tryOpenVehicleUi,
  handleVehicleInteract,
  runVehicleSync,
  reconcileVehicleBoot,
} from "./vehicle_ui.js";
import { tryOpenPropertyUi } from "./property_ui.js";
import { tryOpenPoliceUi, tryPoliceSpawnEnforcement } from "./police_ui.js";
import { tryOpenEmsUi, tryEmsSpawnEnforcement } from "./ems_ui.js";
import { tryOpenPhoneUi } from "./phone_ui.js";

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
 * backend join-notify/heartbeat/leave calls, and the !link chat command).
 *
 * persistentId is NOT necessarily the literal Xbox Live xuid string —
 * it's an opaque stable identifier. The wire field (`xuid` in
 * /bridge/character/link) is kept unchanged for compatibility.
 */
const persistentIdByName = new Map();

/**
 * Bedrock's playerSpawn can fire more than once around a join, so gate the
 * join greeting ("เชื่อมต่อแล้ว" / link-code form) to exactly once per
 * player per entry — reset on leave so a rejoin gets its one message again.
 */
const linkStatusNotified = new Set();

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

/**
 * Build a signed HttpRequest to the backend. In addition to the shared
 * secret (which proves "this is our game server"), every call carries a
 * timestamp + per-request nonce + HMAC-SHA256 signature over
 * `${ts}\n${nonce}\n${rawBody}`. The backend rejects stale timestamps
 * and replayed nonces, so a captured request can't be fed back later.
 * The HMAC is implemented in pure JS (no crypto module in the Script
 * API) — crypto_hmac.js is verified against RFC 4231 vectors.
 */
function makeSignedRequest(path, body) {
  const rawBody = JSON.stringify(body);
  const ts = String(Date.now());
  const nonce = `${ts}-${Math.random().toString(36).slice(2, 12)}`;
  const sig = hmacSha256Hex(cachedBridgeConfig.bridgeSecret, `${ts}\n${nonce}\n${rawBody}`);

  const req = new HttpRequest(`${cachedBridgeConfig.backendUrl}${path}`);
  req.method = HttpRequestMethod.Post;
  req.headers = [
    new HttpHeader("Content-Type", "application/json"),
    new HttpHeader("x-bds-bridge-secret", cachedBridgeConfig.bridgeSecret),
    new HttpHeader("x-bds-ts", ts),
    new HttpHeader("x-bds-nonce", nonce),
    new HttpHeader("x-bds-sig", sig),
  ];
  req.body = rawBody;
  return req;
}

function postToBackend(path, body) {
  return http.request(makeSignedRequest(path, body));
}

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

  postToBackend("/bridge/player/join", { playerName: event.playerName, playerId: persistentId }).then(
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

world.afterEvents.playerLeave.subscribe((event) => {
  linkStatusNotified.delete(event.playerName); // rejoin should get its one message again
  if (cachedBridgeConfig) {
    const persistentId = persistentIdByName.get(event.playerName);
    if (persistentId) {
      postToBackend("/bridge/player/leave", { playerName: event.playerName, playerId: persistentId }).then(
        (response) => {
          if (response.status < 200 || response.status >= 300) {
            console.warn(`[bedrock-rp] backend rejected player leave notify: HTTP ${response.status}`);
          }
        },
        (err) => {
          console.warn(`[bedrock-rp] backend unreachable for player leave notify: ${err}`);
        }
      );
    } else {
      console.warn(`[bedrock-rp] no persistentId captured for leaving player ${event.playerName}`);
    }
  }
  persistentIdByName.delete(event.playerName); // avoid an unbounded map across a long-running server
});

/**
 * Heartbeat every ~30s for players still marked online (join fires once at
 * connect; the heartbeat keeps the Redis presence TTL alive and updates
 * last_seen in the DB). If a player hard-disconnects without a clean
 * leave event, the heartbeat stops and the presence TTL (config, default
 * 90s) expires them on its own — that's the "last seen / dropped conn"
 * distinction.
 */
system.runInterval(() => {
  if (!cachedBridgeConfig || persistentIdByName.size === 0) return;
  for (const [playerName, persistentId] of persistentIdByName.entries()) {
    postToBackend("/bridge/player/heartbeat", { playerName, playerId: persistentId }).then(
      (response) => {
        if (response.status >= 300) {
          console.warn(`[bedrock-rp] backend rejected heartbeat: HTTP ${response.status}`);
        }
      },
      (err) => {
        console.warn(`[bedrock-rp] backend unreachable for heartbeat: ${err}`);
      }
    );
  }
}, 30 * 20); // 30 seconds (script ticks run ~20/sec)

/**
 * NOTE (BDS 1.26.45.1): verified empirically that `world.beforeEvents.chatSend`
 * still fires AND `event.cancel` still suppresses the broadcast on this build —
 * the standalone `@minecraft/server-chat` module is NOT bundled here
 * ("depends on unknown module" for both 1.0.0 and 1.0.0-beta), so this is the
 * one true chat hook. Do not "migrate" to @minecraft/server-chat on 1.26.
 *
 * A leading `/` is deliberately NOT used as the trigger — Minecraft
 * intercepts any `/`-prefixed chat message as an attempted game command
 * client-side (confirmed by testing: shows "Cheats aren't enabled in
 * this world" and never reaches this handler at all on a world with
 * cheats/commands off, which this RP's worlds intentionally have off).
 */
world.beforeEvents.chatSend.subscribe((event) => {
  const message = event.message.trim();
  const lower = message.toLowerCase();

  // In-game staff commands (!give) — authorization happens on the backend.
  if (tryHandleAdminCommand(message, event.sender, {
    postToBackend,
    getPersistentId: () => persistentIdByName.get(event.sender.name),
    getPersistentIdByName: (name) => persistentIdByName.get(name),
    isConfigured: () => !!cachedBridgeConfig,
  })) {
    event.cancel = true; // never hit public chat
    return;
  }

  // In-game RP inventory UI (separate from the vanilla backpack).
  if (tryOpenInventoryUi(message, event.sender, {
    postToBackend,
    getPersistentId: () => persistentIdByName.get(event.sender.name),
    isConfigured: () => !!cachedBridgeConfig,
  })) {
    event.cancel = true; // never hit public chat
    return;
  }

  // In-game vehicle system (`!car`).
  if (tryOpenVehicleUi(message, event.sender, {
    postToBackend,
    getPersistentId: () => persistentIdByName.get(event.sender.name),
    getPersistentIdByName: (name) => persistentIdByName.get(name),
    isConfigured: () => !!cachedBridgeConfig,
  })) {
    event.cancel = true; // never hit public chat
    return;
  }

  // In-game property system (`!house`).
  if (tryOpenPropertyUi(message, event.sender, {
    postToBackend,
    getPersistentId: () => persistentIdByName.get(event.sender.name),
    getPersistentIdByName: (name) => persistentIdByName.get(name),
    isConfigured: () => !!cachedBridgeConfig,
  })) {
    event.cancel = true; // never hit public chat
    return;
  }

  // In-game police system (`!police` / `!mdt`).
  if (tryOpenPoliceUi(message, event.sender, {
    postToBackend,
    getPersistentId: () => persistentIdByName.get(event.sender.name),
    getPersistentIdByName: (name) => persistentIdByName.get(name),
    isConfigured: () => !!cachedBridgeConfig,
  })) {
    event.cancel = true; // never hit public chat
    return;
  }

  // In-game EMS system (`!ems` / `!medic`).
  if (tryOpenEmsUi(message, event.sender, {
    postToBackend,
    getPersistentId: () => persistentIdByName.get(event.sender.name),
    getPersistentIdByName: (name) => persistentIdByName.get(name),
    isConfigured: () => !!cachedBridgeConfig,
  })) {
    event.cancel = true; // never hit public chat
    return;
  }

  // In-game phone system (`!phone`).
  if (tryOpenPhoneUi(message, event.sender, {
    postToBackend,
    getPersistentId: () => persistentIdByName.get(event.sender.name),
    getPersistentIdByName: (name) => persistentIdByName.get(name),
    isConfigured: () => !!cachedBridgeConfig,
  })) {
    event.cancel = true; // never hit public chat
    return;
  }

  if (!lower.startsWith("!link ")) return;

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

  postToBackend("/bridge/character/link", { code, xuid: persistentId }).then(
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

/**
 * First spawn only: already linked -> "เชื่อมต่อแล้ว", not linked yet -> the
 * code form pops automatically (whole "เข้าซิฟแล้วกรอกโค้ด" flow). `deps` a
 * bove. Short delay so the client has actually finished spawning first.
 */
world.afterEvents.playerSpawn.subscribe((event) => {
  if (!event.initialSpawn || !cachedBridgeConfig) return;
  if (linkStatusNotified.has(event.player.name)) return; // spawn may fire twice around a join
  linkStatusNotified.add(event.player.name);
  const persistentId = persistentIdByName.get(event.player.name);
  if (!persistentId) return;
  system.runTimeout(() => {
    promptJoinLinkStatus(event.player, {
      postToBackend,
      getPersistentId: () => persistentId,
      isConfigured: () => !!cachedBridgeConfig,
    });
  }, 40); // ~2s after spawn
});

/**
 * Jail enforcement: runs on EVERY spawn (initial join, death respawn, etc.).
 * The backend decides who's serving time (server clock is authoritative); if
 * so, the player is dragged back to the configured prison point.
 */
world.afterEvents.playerSpawn.subscribe((event) => {
  if (!cachedBridgeConfig) return;
  const persistentId = persistentIdByName.get(event.player.name);
  if (!persistentId) return;
  system.runTimeout(() => {
    tryPoliceSpawnEnforcement(event.player, {
      postToBackend,
      getPersistentId: () => persistentId,
      getPersistentIdByName: (name) => persistentIdByName.get(name),
      isConfigured: () => !!cachedBridgeConfig,
    });
  }, 40); // ~2s after spawn, after the join prompt
});

/**
 * EMS hospital enforcement: runs on EVERY spawn (initial join, death respawn,
 * etc.), mirrors jail enforcement above. If the backend says the citizen must
 * respawn at the hospital (`mustRespawnHospital`), the pack drags them to the
 * configured hospital point and fires `/bridge/ems/hospitalize`, which returns
 * them to healthy and issues the hospital bill.
 */
world.afterEvents.playerSpawn.subscribe((event) => {
  if (!cachedBridgeConfig) return;
  const persistentId = persistentIdByName.get(event.player.name);
  if (!persistentId) return;
  system.runTimeout(() => {
    tryEmsSpawnEnforcement(event.player, {
      postToBackend,
      getPersistentId: () => persistentId,
      getPersistentIdByName: (name) => persistentIdByName.get(name),
      isConfigured: () => !!cachedBridgeConfig,
    });
  }, 40); // ~2s after spawn, after the join prompt
});

/**
 * EMS death reporting: when a player entity dies, self-report to the backend
 * (`/bridge/ems/death` -> declareDeath selfReport:true). The backend marks the
 * citizen dead + `mustRespawnHospital`, so their next spawn gets hospital
 * enforcement above. Fire-and-forget like the join/heartbeat notifies — the
 * UI flows read the resulting state via `/bridge/ems/me`.
 */
world.afterEvents.entityDie.subscribe((event) => {
  if (!cachedBridgeConfig) return;
  const dead = event.deadEntity;
  if (!dead || dead.typeId !== "minecraft:player") return;
  const persistentId = persistentIdByName.get(dead.name);
  if (!persistentId) return;
  postToBackend("/bridge/ems/death", { playerId: persistentId }).then(
    (response) => {
      if (response.status < 200 || response.status >= 300) {
        console.warn(`[bedrock-rp] backend rejected death report: HTTP ${response.status}`);
      }
    },
    (err) => {
      console.warn(`[bedrock-rp] backend unreachable for death report: ${err}`);
    }
  );
});

/**
 * RP inventory opener via ITEM USE (right-click "use" on a compass) —
 * placeholder trigger item for now, per the player-side preference. Same
 * deps + flow as the `!inv` chat fallback above. NOTE: vanilla Bedrock
 * `itemUse` fires for items with a use action; a plain compass is not one,
 * so if right-clicking it does nothing live we switch to a usable item
 * (e.g. carrot_on_a_stick) — `!inv` remains as the reliable fallback meanwhile.
 */
world.afterEvents.itemUse.subscribe((event) => {
  if (!event.itemStack || event.itemStack.typeId !== "minecraft:compass") return;
  openInventoryUi(event.source, {
    postToBackend,
    getPersistentId: () => persistentIdByName.get(event.source.name),
    isConfigured: () => !!cachedBridgeConfig,
  });
});

// Vehicle system: world-side handling of megaverse: cars (sneak-interact menu,
// locked-car feedback), per-vehicle sensor sync while being driven, and the
// once-at-boot reconcile that returns stranded 'deployed' vehicles to the
// garage (the Car AllDay Town addon = pure physics, no opinion on state).
world.afterEvents.playerInteractWithEntity.subscribe((event) => {
  if (!cachedBridgeConfig) return;
  handleVehicleInteract(event, {
    postToBackend,
    getPersistentId: () => persistentIdByName.get(event.player.name),
    getPersistentIdByName: (name) => persistentIdByName.get(name),
    isConfigured: () => !!cachedBridgeConfig,
  });
});

system.runInterval(() => {
  if (!cachedBridgeConfig) return;
  runVehicleSync({
    postToBackend,
    getPersistentId: () => "",
    getPersistentIdByName: () => null,
    isConfigured: () => !!cachedBridgeConfig,
  });
}, 100); // every ~5s (matches vehicle_ui.js SYNC_INTERVAL_TICKS)

system.run(() => {
  if (cachedBridgeConfig) {
    reconcileVehicleBoot({
      postToBackend,
      getPersistentId: () => "",
      getPersistentIdByName: () => null,
      isConfigured: () => !!cachedBridgeConfig,
    });
  }
});

system.run(() => {
  console.warn("[bedrock-rp] behavior pack loaded");
});