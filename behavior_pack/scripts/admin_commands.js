import { system } from "@minecraft/server";

/**
 * In-game staff commands (`!give`, `!deduct`). Staff commands are just chat
 * triggers like `!inv`/`!link` — the pack never decides who may run them. It
 * only forwards the actor's own persistentId (captured at join, so it can't
 * be spoofed by the client) and lets the backend authorize via the staff
 * user's Discord account + RBAC. Attempts without permission are rejected
 * server-side and raised as security events.
 *
 * Syntax:
 *   !give <player> <amount> [cash|bank|red_money]   (amount in whole units)
 *   !deduct <player> <amount> [cash|bank|red_money]
 *
 * Note: forms/messages must run on the script main thread — network promise
 * callbacks run in a different context, so everything funnels through
 * system.run.
 */
function sendMsg(player, text) {
  system.run(() => player.sendMessage(text));
}

/** Call a signed bridge endpoint and normalize the JSON response. */
async function bridgeCall(postToBackend, path, body) {
  let response;
  try {
    response = await postToBackend(path, body);
  } catch (err) {
    console.warn(`[bedrock-rp] admin command backend unreachable (${path}): ${err}`);
    return { ok: false, status: 0, message: "Couldn't reach the server. Try again in a moment." };
  }
  let parsed = { ok: false, message: `Unexpected response (HTTP ${response.status}).` };
  try {
    if (response.body) parsed = JSON.parse(response.body);
  } catch {
    // keep the fallback message
  }
  parsed.status = response.status;
  return parsed;
}

/** `!give <player> <amount> [currency]` — amount in whole units. */
async function handleGive(player, deps, argv) {
  if (!deps.isConfigured()) {
    sendMsg(player, "§cStaff commands aren't available right now — the server isn't configured for it. Tell an admin.");
    return;
  }
  const actorPersistentId = deps.getPersistentId();
  if (!actorPersistentId) {
    sendMsg(player, "§cCouldn't determine your account identity — try rejoining the server.");
    return;
  }

  const targetName = argv[0];
  const amount = Number(argv[1]);
  const currency = argv[2] || "cash";

  if (!targetName || !Number.isFinite(amount) || amount <= 0) {
    sendMsg(player, "§eUsage: !give <player> <amount> [cash|bank|red_money]§r — e.g. §e!give Steve 5000 cash");
    return;
  }
  if (!["cash", "bank", "red_money"].includes(currency)) {
    sendMsg(player, "§cCurrency must be cash, bank or red_money.");
    return;
  }
  if (amount > 100000000) {
    sendMsg(player, "§cAmount too large — refund/flag on the site instead if this is a big correction.");
    return;
  }

  const targetPersistentId = deps.getPersistentIdByName(targetName);
  if (!targetPersistentId) {
    sendMsg(player, `§c${targetName} isn't online right now.`);
    return;
  }
  // Self-grant is intentionally allowed: the backend RBAC + audit already
  // govern it (same as /admin/economy/grant), and staff legitimately need
  // to fund their own character for setup/testing. Identity still comes
  // from the actor's persistentId — no spoofing possible.

  const amountCents = Math.round(amount * 100);
  const result = await bridgeCall(deps.postToBackend, "/bridge/admin/give", {
    actorName: player.name,
    actorPersistentId,
    targetName,
    targetPersistentId,
    amountCents,
    currency,
  });
  sendMsg(player, result.ok ? `§a${result.message}` : `§c${result.message}`);
}

/** `!deduct <player> <amount> [currency]` — claw back money. */
async function handleDeduct(player, deps, argv) {
  if (!deps.isConfigured()) {
    sendMsg(player, "§cStaff commands aren't available right now — the server isn't configured for it. Tell an admin.");
    return;
  }
  const actorPersistentId = deps.getPersistentId();
  if (!actorPersistentId) {
    sendMsg(player, "§cCouldn't determine your account identity — try rejoining the server.");
    return;
  }

  const targetName = argv[0];
  const amount = Number(argv[1]);
  const currency = argv[2] || "cash";

  if (!targetName || !Number.isFinite(amount) || amount <= 0) {
    sendMsg(player, "§eUsage: !deduct <player> <amount> [cash|bank|red_money]§r — e.g. §e!deduct Steve 5000 cash");
    return;
  }
  if (!["cash", "bank", "red_money"].includes(currency)) {
    sendMsg(player, "§cCurrency must be cash, bank or red_money.");
    return;
  }
  if (amount > 100000000) {
    sendMsg(player, "§cAmount too large — refund/flag on the site instead if this is a big correction.");
    return;
  }

  const targetPersistentId = deps.getPersistentIdByName(targetName);
  if (!targetPersistentId) {
    sendMsg(player, `§c${targetName} isn't online right now.`);
    return;
  }
  // Self-deduct is intentionally allowed: backend RBAC + audit govern it.

  const amountCents = Math.round(amount * 100);
  const result = await bridgeCall(deps.postToBackend, "/bridge/admin/deduct", {
    actorName: player.name,
    actorPersistentId,
    targetName,
    targetPersistentId,
    amountCents,
    currency,
  });
  sendMsg(player, result.ok ? `§a${result.message}` : `§c${result.message}`);
}

/**
 * main.js calls this from its chatSend interceptor. Returns true if the
 * message was one of our admin triggers (and the command was run/attempted).
 */
export function tryHandleAdminCommand(message, player, deps) {
  const lower = message.trim().toLowerCase();
  if (lower === "!give" || lower.startsWith("!give ")) {
    handleGive(player, deps, message.trim().split(/\s+/).slice(1));
    return true;
  }
  if (lower === "!deduct" || lower.startsWith("!deduct ")) {
    handleDeduct(player, deps, message.trim().split(/\s+/).slice(1));
    return true;
  }
  return false;
}