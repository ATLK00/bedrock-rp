import { system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { openInventoryUi } from "./inventory_ui.js";

/**
 * In-game property UI (`!house` / `!property`).
 *
 * Everything authoritative lives on the backend (see backend/src/modules/
 * property/) — this file only renders server-confirmed state and sends one
 * chosen action at a time:
 *
 *   root    -> your properties (owned) + deed-held keys + total garage slots
 *   per own property menu ->
 *     - lock / unlock
 *     - list for sale (modal: price + currency) / unlist
 *     - transfer to an online player (deed key moves automatically)
 *     - open storage  (reuses openInventoryUi — the bridge already lists
 *                      owned + key-held containers)
 *   shop    -> for-sale / government lots, confirm buy (non-refundable)
 *
 * Authorization: the bridge resolves the actor from the persistentId the
 * server captured at join; the pack is never trusted to decide who may act.
 * `deps` = { postToBackend, getPersistentId, getPersistentIdByName, isConfigured }.
 */

const TRIGGERS = ["!house", "!property"];

const TYPE_LABEL = {
  house: "บ้าน",
  apartment: "คอนโด",
  warehouse: "โกดัง",
  business: "ร้านค้า",
  office: "ออฟฟิศ",
};

function sendMsg(player, text) {
  system.run(() => player.sendMessage(text));
}

function showOnMainThread(player, form) {
  return new Promise((resolve) => {
    system.run(() => {
      form
        .show(player)
        .then(resolve, (err) => {
          console.warn(`[bedrock-rp] property UI form failed: ${err}`);
          resolve({ canceled: true });
        });
    });
  });
}

function money(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

async function bridgeCall(postToBackend, path, body) {
  let response;
  try {
    response = await postToBackend(path, body);
  } catch (err) {
    console.warn(`[bedrock-rp] property backend unreachable (${path}): ${err}`);
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

async function fetchMine(deps, persistentId) {
  return bridgeCall(deps.postToBackend, "/bridge/property/mine", { playerId: persistentId });
}

async function fetchShop(deps) {
  return bridgeCall(deps.postToBackend, "/bridge/property/shop", {});
}

function propertyLabel(p) {
  const type = TYPE_LABEL[p.propertyType] || p.propertyType;
  return `§2${type}§r §f${p.address}§r §7[${
    p.status === "owned" ? "เป็นของเรา" : "ถูกยึด"
  }]§r ${p.locked ? "§6🔒§r" : "§8🔓§r"} ` +
    (p.salePriceCents != null ? `§eขาย ${money(p.salePriceCents)} (§7${p.saleCurrency}§e)§r` : "");
}

/** Root menu: owned properties + held deed keys, then shop / reload / close. */
async function renderRoot(player, deps, persistentId) {
  const res = await fetchMine(deps, persistentId);
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "Couldn't load your properties."}`);
    return;
  }
  const owned = (res.properties ?? []).filter((p) => p.status !== "seized");
  const keys = res.keys ?? [];

  const form = new ActionFormData().title("อสังหาริมทรัพย์ของคุณ").body(
    `§fที่จอดรถรวม: §7${res.garageCapacity ?? 0}\n` +
    (owned.length === 0 && keys.length === 0 ? "§7ยังไม่มีอสังหาริมทรัพย์ — ไปตลาดซื้อได้เลย§r" : "")
  );
  for (const p of owned) form.button(`§a${propertyLabel(p)}§r`);
  form.button("§d🔑 กุญแจที่ถือ" + (keys.length ? ` (${keys.length})` : "") + "§r");
  form.button("§a🏪 ตลาดอสังหาริมทรัพย์§r");
  form.button("§7⟲ Reload§r");
  form.button("§7Close§r");

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const ownedCount = owned.length;
  const idx = resp.selection;
  if (idx >= 0 && idx < ownedCount) {
    await renderActions(player, deps, persistentId, owned[idx]);
    await renderRoot(player, deps, persistentId); // always re-show fresh state
    return;
  }
  if (idx === ownedCount) {
    await openKeys(player, deps, persistentId, keys);
    await renderRoot(player, deps, persistentId);
    return;
  }
  if (idx === ownedCount + 1) {
    await openShop(player, deps, persistentId);
    await renderRoot(player, deps, persistentId);
    return;
  }
  if (idx === ownedCount + 2) {
    await renderRoot(player, deps, persistentId);
    return;
  }
  // idx === ownedCount + 3 -> close
}

/** Deed-held (non-owner) access list — storage only. */
async function openKeys(player, deps, persistentId, keys) {
  if (keys.length === 0) {
    sendMsg(player, "§7คุณไม่ได้ถือกุญแจบ้านของใคร");
    return;
  }
  const form = new ActionFormData().title("🔑 กุญแจที่ถือ").body(
    keys.map((p) => `§f${TYPE_LABEL[p.propertyType] || p.propertyType}§r §f${p.address}§r ${p.locked ? "§6🔒§r" : "§8🔓§r"}`).join("\n")
  );
  for (const p of keys) form.button(`${propertyLabel(p)}`);
  form.button("§7Back§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const p = keys[resp.selection];
  if (!p) return;
  sendMsg(player, `§7กุญแจ ${p.address} — เปิดครอบครองพื้นที่:`);
  await openStorage(player, deps, persistentId);
}

/** Per-property action menu (owned only — seized/sale state shown read-only). */
async function renderActions(player, deps, persistentId, p) {
  const actions = [];
  if (p.status === "seized") {
    const form = new ActionFormData().title(`${TYPE_LABEL[p.propertyType] || "ที่ดิน"} ${p.address}`).body(
      `§7${p.propertyType}§r · §cถูกยึด (seized)§r\n§7ติดต่อแอดมินเพื่อยื่นเรื่องคืน`
    ).button("§7Back§r");
    const resp = await showOnMainThread(player, form);
    void resp;
    return;
  }

  actions.push({ key: "storage", label: "§2📦 เปิดห้องเก็บของ§r" });
  actions.push({ key: "lock", label: p.locked ? "§e🔓 ปิดประตูแบบปลดล็อก§r" : "§9🔒 ล็อกที่ดิน§r" });
  actions.push({ key: p.salePriceCents != null ? "unlist" : "sell", label: p.salePriceCents != null ? "§e🏷 เอาออกขาย§r" : "§e🏷 ขาย (ตั้งราคา)§r" });
  actions.push({ key: "transfer", label: "§d🎁 โอนให้ผู้เล่น§r" });
  actions.push({ key: "back", label: "§7Back§r" });

  const form = new ActionFormData().title(`${TYPE_LABEL[p.propertyType] || "ที่ดิน"} ${p.address}`).body(
    `§7${p.propertyType}§r · ${p.status === "owned" ? "เป็นของเรา" : "ถูกยึด"}\n` +
    `§6ที่จอดเพิ่ม:§f ${p.garageCapacity}` +
    (p.salePriceCents != null ? `\n§eประกาศขาย ${money(p.salePriceCents)} ${p.saleCurrency}§r` : "")
  );
  for (const a of actions) form.button(a.label);

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const action = actions[resp.selection];
  if (!action || action.key === "back") return;

  if (action.key === "storage") await openStorage(player, deps, persistentId);
  else if (action.key === "lock") await toggleLock(player, deps, persistentId, p);
  else if (action.key === "sell") await openSell(player, deps, persistentId, p);
  else if (action.key === "unlist") await unlist(player, deps, persistentId, p);
  else if (action.key === "transfer") await openTransfer(player, deps, persistentId, p);
}

async function openStorage(player, deps, persistentId) {
  // The shared inventory UI already lists every container the character can
  // reach (owned + key-held property storage after the bridge change).
  await openInventoryUi(player, deps);
}

async function toggleLock(player, deps, persistentId, p) {
  const locked = !p.locked;
  const res = await bridgeCall(deps.postToBackend, "/bridge/property/lock", {
    playerId: persistentId, propertyId: p.id, locked,
  });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "เปลี่ยนสถานะล็อกไม่สำเร็จ"}`);
    return;
  }
  sendMsg(player, locked ? `§9ล็อก ${p.address} แล้ว` : `§eปลดล็อก ${p.address} แล้ว`);
}

async function openSell(player, deps, persistentId, p) {
  const form = new ModalFormData()
    .title(`ขาย ${p.address}`)
    .textField("ราคา (บาท, มีจุดทศนิยม 2 ตำแหน่ง)", "เช่น 1000000")
    .dropdown("สกุลเงิน", ["cash", "bank", "red_money"], { defaultValueIndex: 0 });
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const [priceRaw, curIdx] = resp.formValues;
  const priceCents = Math.round(Number(String(priceRaw ?? "").trim()) * 100);
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    sendMsg(player, "§cต้องใส่ราคาเป็นตัวเลขมากกว่า 0");
    return;
  }
  const currency = ["cash", "bank", "red_money"][curIdx];
  const res = await bridgeCall(deps.postToBackend, "/bridge/property/sell", {
    playerId: persistentId, propertyId: p.id, priceCents, currency,
  });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "ประกาศขายไม่สำเร็จ"}`);
    return;
  }
  sendMsg(player, `§aประกาศขาย ${p.address} ที่ ${money(priceCents)} ${currency} แล้ว`);
}

async function unlist(player, deps, persistentId, p) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/property/sell", {
    playerId: persistentId, propertyId: p.id, priceCents: null, currency: "cash",
  });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "เอาออกขายไม่สำเร็จ"}`);
    return;
  }
  sendMsg(player, `§aเอาออกขายแล้ว`);
}

async function openTransfer(player, deps, persistentId, p) {
  const others = world.getAllPlayers()
    .filter((pl) => pl.name !== player.name)
    .map((pl) => pl.name);
  if (others.length === 0) {
    sendMsg(player, "§cไม่มีผู้เล่นคนอื่นออนไลน์ให้โอนตอนนี้");
    return;
  }
  const form = new ModalFormData()
    .title(`โอน ${p.address}`)
    .dropdown("ผู้เล่นที่จะรับ (ต้องออนไลน์อยู่)", others, { defaultValueIndex: 0 });
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const targetName = others[resp.formValues[0]];
  const getPid = deps.getPersistentIdByName;
  if (typeof getPid !== "function") {
    sendMsg(player, "§cเซิร์ฟเวอร์ config ยังไม่รองรับการโอนที่ดิน — บอก admin ด้วย");
    return;
  }
  const targetPersistentId = getPid(targetName);
  if (!targetPersistentId) {
    sendMsg(player, `§cหา identity ของ ${targetName} ไม่เจอ — ให้เค้าออกจากระบบแล้วกลับเข้ามาใหม่`);
    return;
  }
  const res = await bridgeCall(deps.postToBackend, "/bridge/property/transfer", {
    playerId: persistentId, propertyId: p.id, targetPersistentId,
  });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "โอนไม่สำเร็จ"}`);
    return;
  }
  sendMsg(player, `§aโอน ${p.address} ให้ ${targetName} แล้ว — กุญแจถูกส่งให้เค้าโดยอัตโนมัติ`);
  const targetPlayer = world.getAllPlayers().find((pl) => pl.name === targetName);
  if (targetPlayer) {
    sendMsg(targetPlayer, `§e🎁 ${player.name} โอนที่ดิน ${p.address} ให้คุณ — เปิด §f!house §eเพื่อดู`);
  }
}

/** Market browsing: for-sale lots, confirm payable purchase. */
async function openShop(player, deps, persistentId) {
  const res = await fetchShop(deps);
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "ตลาดอสังหาริมทรัพย์ไม่พร้อมใช้งาน"}`);
    return;
  }
  const listing = res.properties ?? [];
  if (listing.length === 0) {
    sendMsg(player, "§7ตอนนี้ไม่มีที่ดินวางขายในตลาด");
    return;
  }
  const form = new ActionFormData().title("ตลาดอสังหาริมทรัพย์").body(listing.length + " หลังวางขาย");
  for (const p of listing) {
    form.button(`${TYPE_LABEL[p.propertyType] || p.propertyType} §f${p.address}§r §e${money(p.salePriceCents)} ${p.saleCurrency}§r`);
  }
  form.button("§7Close§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled || resp.selection === listing.length) return;
  const p = listing[resp.selection];

  const confirm = new ModalFormData()
    .title(`ซื้อ ${p.address}`)
    .toggle(`จ่าย ${money(p.salePriceCents)} ${p.saleCurrency} จากกระเป๋า (wallet)`, { defaultValue: false });
  const confirmResp = await showOnMainThread(player, confirm);
  if (confirmResp.canceled || !confirmResp.formValues[0]) return;

  const bought = await bridgeCall(deps.postToBackend, "/bridge/property/buy", {
    playerId: persistentId, propertyId: p.id,
  });
  if (!bought.ok) {
    sendMsg(player, `§c${bought.message || "ซื้อไม่สำเร็จ"}`);
    return;
  }
  sendMsg(player, `§aซื้อ ${p.address} เรียบร้อย — เปิด §f!house §aเพื่อล็อก/เช็คห้องเก็บของ (ที่จอดอู่ +${bought.property && bought.property.garageCapacity || 0})`);
}

export function tryOpenPropertyUi(message, player, deps) {
  if (!deps.isConfigured()) return false;
  const lower = message.trim().toLowerCase();
  for (const trigger of TRIGGERS) {
    if (lower === trigger) {
      openPropertyUi(player, deps);
      return true;
    }
  }
  return false;
}

export async function openPropertyUi(player, deps) {
  if (!deps.isConfigured()) {
    sendMsg(player, "§cProperty system isn't available right now — the server isn't configured for it. Tell an admin.");
    return;
  }
  const persistentId = deps.getPersistentId();
  if (!persistentId) {
    sendMsg(player, "§cCouldn't determine your account identity — rejoin and try again, or link first with §e!link <code>§c.");
    return;
  }
  const res = await fetchMine(deps, persistentId);
  if (!res.ok) {
    if (res.status === 404) {
      sendMsg(player, "§cยังไม่ได้ลิงก์บัญชี — เปิด §e!inv §cแล้วกรอกโค้ดจากเว็บก่อน หรือพิมพ์ §e!link <code>§c");
      return;
    }
    sendMsg(player, `§c${res.message}`);
    return;
  }
  await renderRoot(player, deps, persistentId);
}