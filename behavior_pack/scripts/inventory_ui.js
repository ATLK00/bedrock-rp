import { system } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

/**
 * In-game RP inventory UI (`!inv`). The RP inventory is a SEPARATE system
 * from the vanilla player inventory — it lives in the backend DB
 * (weight-aware, with owned containers), and this UI is the only in-game
 * window onto it. All reads/writes go through the signed bridge endpoints
 * (`/bridge/inventory/view`, `/bridge/inventory/move`); the player's
 * identity is the persistentId captured at join, so there is no
 * client-supplied character id to spoof.
 *
 * Flow:
 *   root form  -> list of carried slots + owned containers (with weight)
 *   slot       -> modal: pick quantity + target container -> move
 *   container  -> list its items -> modal: pick quantity -> take to body
 * After every move the affected view re-fetches and re-renders, so the UI
 * always shows server-confirmed state (no optimistic updates to mislead).
 *
 * Note: form.show() must be invoked on the script main thread; network
 * promise callbacks run in a different context, so everything funnels
 * through `showOnMainThread`.
 */

const TRIGGERS = ["!inv", "!inventory", "!bag"];

function sendMsg(player, text) {
  system.run(() => player.sendMessage(text));
}

function showOnMainThread(player, form) {
  return new Promise((resolve) => {
    system.run(() => {
      form
        .show(player)
        .then(resolve, (err) => {
          console.warn(`[bedrock-rp] inventory UI form failed: ${err}`);
          resolve({ canceled: true });
        });
    });
  });
}

/** Compact weight for display: >=1000g shows kg, else grams. */
function fmtWeight(g) {
  return g >= 1000 ? `${(g / 1000).toFixed(1)}kg` : `${g}g`;
}

/** Call a signed bridge endpoint and normalize the JSON response. */
async function bridgeCall(postToBackend, path, body) {
  let response;
  try {
    response = await postToBackend(path, body);
  } catch (err) {
    console.warn(`[bedrock-rp] inventory UI backend unreachable (${path}): ${err}`);
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

async function fetchView(postToBackend, persistentId) {
  return bridgeCall(postToBackend, "/bridge/inventory/view", { playerId: persistentId });
}

async function fetchMove(postToBackend, persistentId, itemId, quantity, from, to) {
  return bridgeCall(postToBackend, "/bridge/inventory/move", {
    playerId: persistentId,
    itemId,
    quantity,
    from,
    to,
  });
}

function slotLabel(slot) {
  const metaKeys = Object.keys(slot.item_metadata ?? {}).length;
  const metaTag = metaKeys > 0 ? " (dmg)" : "";
  return `${slot.display_name}x${slot.quantity}${metaTag}  §7[${fmtWeight(slot.quantity * slot.weight_g)}]§r`;
}

function containerLabel(c) {
  const used = c.usedWeightG ?? c.items.reduce((s, i) => s + i.quantity * i.weight_g, 0);
  return `${c.label ?? c.storage_type}  §7[${fmtWeight(used)}/${fmtWeight(c.capacity_weight_g)}]§r`;
}

/**
 * Root screen: personal carry (slots) + owned containers. Exported so
 * main.js can open it from the compass item ("use" on a compass) or via
 * the `!inv` chat fallback. `deps` = { postToBackend, getPersistentId, isConfigured }.
 *
 * Not linked yet (backend 404) -> pops the link-code form instead of just
 * an error: player types the code from the website right there. Linked ->
 * confirms with "เชื่อมต่อสำเร็จ" and opens the inventory.
 */
export async function openInventoryUi(player, deps) {
  if (!deps.isConfigured()) {
    sendMsg(player, "§cThe RP inventory isn't available right now — the server isn't configured for it. Tell an admin.");
    return;
  }
  const persistentId = deps.getPersistentId();
  if (!persistentId) {
    sendMsg(player, "§cCouldn't determine your account identity — rejoin and try again, or link first with §e!link <code>§c.");
    return;
  }

  const view = await fetchView(deps.postToBackend, persistentId);
  if (!view.ok) {
    if (view.status === 404) {
      await openLinkForm(player, deps, persistentId);
      return;
    }
    sendMsg(player, `§c${view.message}`);
    return;
  }
  await renderRoot(player, deps, persistentId, view);
}

/**
 * On first join: already linked -> says "เชื่อมต่อแล้ว", not linked yet ->
 * pops the code-entry form automatically (no command / item needed).
 * Backend hiccups / non-404 errors stay quiet so we don't nag.
 */
export async function promptJoinLinkStatus(player, deps) {
  if (!deps.isConfigured()) return;
  const persistentId = deps.getPersistentId();
  if (!persistentId) return;
  const view = await fetchView(deps.postToBackend, persistentId);
  if (view.ok) {
    sendMsg(player, "§aเชื่อมต่อแล้ว");
    return;
  }
  if (view.status !== 404) return;
  await openLinkForm(player, deps, persistentId);
}

/**
 * Modal asking for the link code from the website, then consumes it the
 * same way as the `!link <code>` chat command. On success says "เชื่อมต่อแล้ว"
 * and re-opens the inventory so the connected state is visible immediately.
 */
async function openLinkForm(player, deps, persistentId) {
  const form = new ModalFormData()
    .title("ลิงก์บัญชี RP")
    .textField("Code จากเว็บ", "วาง code ที่นี่");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const [rawCode] = resp.formValues;
  const code = String(rawCode ?? "").trim();
  if (!code) {
    sendMsg(player, "§cต้องใส่ code ก่อน — เอาจากเว็บหลังล็อกอิน Discord ครับ");
    return;
  }

  const result = await bridgeCall(deps.postToBackend, "/bridge/character/link", { code, xuid: persistentId });
  if (!result.ok) {
    sendMsg(player, `§c${result.message}`);
    return;
  }
  sendMsg(player, "§aเชื่อมต่อแล้ว");

  const view = await fetchView(deps.postToBackend, persistentId);
  if (view.ok) await renderRoot(player, deps, persistentId, view);
  else sendMsg(player, `§c${view.message}`);
}

/** Reusable render loop for the root form. */
async function renderRoot(player, deps, persistentId, view) {
  const slots = view.slots ?? [];
  const containers = view.containers ?? [];

  let body = `§fน้ำหนัก §7${fmtWeight(view.carryWeightG)}§f / §7${fmtWeight(view.carryWeightLimitG)}§r\n`;
  if (slots.length === 0 && containers.length === 0) {
    body += "§7กระเป๋าว่างเปล่า§r";
  }

  const form = new ActionFormData().title("RP Inventory").body(body);
  for (const slot of slots) form.button(slotLabel(slot));
  for (const c of containers) form.button(`§2${containerLabel(c)}§r`);
  form.button("§7⟲ Reload§r");
  form.button("§7Close§r");

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const idx = resp.selection;

  const closeIdx = slots.length + containers.length + 1;
  if (idx === closeIdx) return;
  if (idx === slots.length + containers.length) {
    const fresh = await fetchView(deps.postToBackend, persistentId);
    if (fresh.ok) await renderRoot(player, deps, persistentId, fresh);
    return;
  }

  if (idx < slots.length) {
    await moveFromSlot(player, deps, persistentId, slots[idx], containers);
  } else {
    await viewContainer(player, deps, persistentId, containers[idx - slots.length]);
  }

  // after an action, refresh and return to root so state is server-true
  const fresh = await fetchView(deps.postToBackend, persistentId);
  if (fresh.ok) await renderRoot(player, deps, persistentId, fresh);
}

/** Pick quantity + target container for a carried item. */
async function moveFromSlot(player, deps, persistentId, slot, containers) {
  const slotQty = slot.quantity;
  if (containers.length === 0) {
    sendMsg(player, "§cYou don't own any containers to move items into.");
    return;
  }

  const form = new ModalFormData()
    .title(`Move ${slot.display_name}`)
    .slider("Quantity", 1, Math.max(1, slotQty), 1, slotQty)
    .dropdown("To container", containers.map((c) => c.label ?? c.storage_type), 0);

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const [quantity, containerIdx] = resp.formValues;
  const target = containers[containerIdx];

  const result = await fetchMove(deps.postToBackend, persistentId, slot.item_id, quantity, "character", target.id);
  sendMsg(player, result.ok ? `§a${result.message}` : `§c${result.message}`);
}

/** Container contents screen — tap an item to take some/all to the body. */
async function viewContainer(player, deps, persistentId, container) {
  const items = container.items ?? [];
  const used = container.usedWeightG ?? items.reduce((s, i) => s + i.quantity * i.weight_g, 0);

  let body = `§7${container.storage_type}§r • §7${fmtWeight(used)}/${fmtWeight(container.capacity_weight_g)}§r\n`;
  if (items.length === 0) body += "§7ยังไม่มีของ§r";

  const form = new ActionFormData()
    .title(`${container.label ?? container.storage_type}`)
    .body(body);
  for (const it of items) form.button(slotLabel(it));
  form.button("§7Close§r");

  const resp = await showOnMainThread(player, form);
  if (resp.canceled || resp.selection === items.length) return;
  const item = items[resp.selection];

  const takeForm = new ModalFormData()
    .title(`Take ${item.display_name} to carry`)
    .slider("Quantity", 1, Math.max(1, item.quantity), 1, item.quantity);
  const takeResp = await showOnMainThread(player, takeForm);
  if (takeResp.canceled) return;
  const quantity = takeResp.formValues[0];

  const result = await fetchMove(deps.postToBackend, persistentId, item.item_id, quantity, container.id, "character");
  sendMsg(player, result.ok ? `§a${result.message}` : `§c${result.message}`);

  // re-render the container so remaining contents are visible
  const fresh = await fetchView(deps.postToBackend, persistentId);
  if (fresh.ok) {
    const freshContainer = fresh.containers.find((c) => Number(c.id) === Number(container.id));
    if (freshContainer) await viewContainer(player, deps, persistentId, freshContainer);
  }
}

/**
 * main.js calls this from its chatSend interceptor: returns true if the
 * message was one of our triggers (and the UI was opened / attempted).
 */
export function tryOpenInventoryUi(message, player, deps) {
  const lower = message.trim().toLowerCase();
  for (const trigger of TRIGGERS) {
    if (lower === trigger) {
      // fire-and-forget: forms keep the conversation going; errors are surfaced in chat
      openInventoryUi(player, deps);
      return true;
    }
  }
  return false;
}