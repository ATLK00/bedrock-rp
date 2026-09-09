import { system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

/**
 * In-game vehicle UI (`!car`). The Car AllDay Town addon (megaverse:buggy)
 * is physics-only; EVERY particle of persistent state (ownership, garage,
 * plate, fuel, damage, lock, sale/transfer) lives on the backend and is
 * reached through the signed bridge endpoints. This script is the pack
 * half only:
 *
 *  - `!car` menu: garage list, deploy/store, lock, refuel, repair, sell,
 *    buy from the dealership, transfer.
 *  - world entity handling: sneak-interact on a vehicle opens the menu,
 *    non-sneak on a locked one says so (and the backend refuses anyway).
 *  - state sync: while a player rides a vehicle we report coarse sensors
 *    (driving ticks + observed health/damage) every SYNC_INTERVAL_TICKS and
 *    apply the authoritative snapshot the backend echoes back.
 *  - boot reconcile: every vehicle marked 'deployed' returns to the garage
 *    unless it was acked this boot, and orphan megaverse entities (world
 *    leftovers from before a restart) are cleaned up.
 *
 * Identity for player-scoped calls is the persistentId captured at join
 * (same as inventory_ui.js). `deps` = { postToBackend, getPersistentId,
 * getPersistentIdByName, isConfigured }.
 */

const TRIGGERS = ["!car", "!vehicle"];
const THE_CAR_NS = "megaverse:";
const SYNC_INTERVAL_TICKS = 100; // ~5s
const REFUEL_PRICE_CENTS_PER_UNIT = 10;

const entityVehicle = new Map(); // entity.id -> vehicleId (number)
const vehicleEntity = new Map(); // vehicleId (number) -> entity.id (string)

function sendMsg(player, text) {
  system.run(() => player.sendMessage(text));
}

function showOnMainThread(player, form) {
  return new Promise((resolve) => {
    system.run(() => {
      form
        .show(player)
        .then(resolve, (err) => {
          console.warn(`[bedrock-rp] vehicle UI form failed: ${err}`);
          resolve({ canceled: true });
        });
    });
  });
}

/** Money in cents -> "12.34" (baht). */
function money(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

/** Call a signed bridge endpoint and normalize the JSON response. */
async function bridgeCall(postToBackend, path, body) {
  let response;
  try {
    response = await postToBackend(path, body);
  } catch (err) {
    console.warn(`[bedrock-rp] vehicle backend unreachable (${path}): ${err}`);
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

function carLabel(v) {
  const state = v.status === "garaged" ? "จอดในอู่" : v.status === "deployed" ? "จอดอยู่ข้างนอก" : "ถูกยึด";
  return `§2${v.plate}§r §3${v.entityType.split(":").pop()}§r  §7[${state}]§r น้ำมัน §b${Number(v.fuelLevel).toFixed(0)}%§r ` +
    (v.locked ? "§6🔒§r " : "§8🔓§r ") +
    (v.salePriceCents != null ? `§eขาย ${money(v.salePriceCents)} (§7${v.saleCurrency}§e)§r` : "");
}

function entityFor(vehicleId) {
  const entityId = vehicleEntity.get(vehicleId);
  if (!entityId) return null;
  try {
    const entity = world.getEntity(entityId);
    return entity || null;
  } catch (err) {
    console.warn(`[bedrock-rp] vehicle entity ${entityId} lookup failed: ${err}`);
    return null;
  }
}

function registerEntity(entity, vehicleId) {
  try { entity.setDynamicProperty("rp_vehicle_id", vehicleId); } catch (e) { /* ignore */ }
  entityVehicle.set(entity.id, vehicleId);
  vehicleEntity.set(vehicleId, entity.id);
}

function unregisterEntity(entity, vehicleId) {
  entityVehicle.delete(entity.id);
  vehicleEntity.delete(vehicleId);
}

/** Push the authoritative snapshot onto a live entity (props + rideable toggle). */
function applySnapshot(entity, snap) {
  if (!entity) return;
  try {
    entity.setProperty("megaverse:fuel", Number(snap.fuelLevel));
    entity.setProperty("megaverse:engine_health", Number(snap.engineHealth));
    entity.setProperty("megaverse:suspension_health", Number(snap.suspensionHealth));
    entity.setProperty("megaverse:body_damage", Number(snap.bodyDamage));
  } catch (err) {
    console.warn(`[bedrock-rp] apply snapshot props failed: ${err}`);
  }
  try {
    entity.setComponentEnabled("minecraft:rideable", !snap.locked);
  } catch (err) {
    console.warn(`[bedrock-rp] rideable toggle failed (locked=${snap.locked}): ${err}`);
  }
}

// ---------------------------------------------------------------------------
// World interactions
// ---------------------------------------------------------------------------

function vehicleIdOfEntity(entity) {
  const known = entityVehicle.get(entity.id);
  if (known != null) return known;
  try {
    const prop = entity.getDynamicProperty("rp_vehicle_id");
    if (prop != null) {
      const id = Number(prop);
      if (Number.isInteger(id) && id > 0) {
        entityVehicle.set(entity.id, id);
        vehicleEntity.set(id, entity.id);
        return id;
      }
    }
  } catch (err) {
    console.warn(`[bedrock-rp] dynamic prop read failed: ${err}`);
  }
  return null;
}

/**
 * main.js calls this from playerInteractWithEntity for `megaverse:*` targets:
 * sneak = open the vehicle menu (store/lock etc.), non-sneak + locked = say so.
 * Non-sneak on an unlocked car is left alone so vanilla boarding works.
 */
export function handleVehicleInteract(event, deps) {
  const { target, player } = event;
  const t = target && target.typeId;
  if (!t || !t.startsWith(THE_CAR_NS)) return;
  const vehicleId = vehicleIdOfEntity(target);
  if (vehicleId == null) {
    if (event.isSneaking) sendMsg(player, "§cThis vehicle isn't tied to any garage record — ask an admin to reconcile.");
    return;
  }
  if (event.isSneaking) {
    openVehicleUi(player, deps);
    return;
  }
  let locked = false;
  try {
    const rideable = target.getComponent("minecraft:rideable");
    locked = rideable !== undefined && rideable !== null && typeof rideable.isEnabled === "function" && !rideable.isEnabled();
  } catch (err) {
    console.warn(`[bedrock-rp] rideable state check failed: ${err}`);
  }
  if (locked) {
    sendMsg(player, "§c🔒 รถคันนี้ถูกล็อกอยู่ — ต้องเป็นเจ้าของ/ถือกุญแจแล้วปลดล็อกก่อน");
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

async function fetchGarage(deps, persistentId) {
  return bridgeCall(deps.postToBackend, "/bridge/vehicle/mine", { playerId: persistentId });
}

async function fetchShop(deps) {
  return bridgeCall(deps.postToBackend, "/bridge/vehicle/shop", {});
}

/** Refresh and re-render the garage menu (called after every action). */
async function renderRoot(player, deps, persistentId) {
  const res = await fetchGarage(deps, persistentId);
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "Couldn't load your garage."}`);
    return;
  }
  const vehicles = res.vehicles ?? [];

  const form = new ActionFormData().title("อู่รถของคุณ").body(
    `§fที่จอด §7${res.vehicleCount ?? 0} / ${res.garageCapacity ?? 0}\n` +
    (vehicles.length === 0 ? "§7ยังไม่มีรถ — ไปซื้อที่โชว์รูมได้เลย§r" : "")
  );
  for (const v of vehicles) form.button(carLabel(v));
  form.button("§a🏪 โชว์รูม (ซื้อรถ)§r");
  form.button("§7⟲ Reload§r");
  form.button("§7Close§r");

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const idx = resp.selection;
  const vehicleCount = vehicles.length;
  if (idx >= vehicleCount && idx < vehicleCount + 1) {
    await openShop(player, deps, persistentId);
    return;
  }
  if (idx === vehicleCount + 1) {
    await renderRoot(player, deps, persistentId);
    return;
  }
  if (idx === vehicleCount + 2) return;
  await renderActions(player, deps, persistentId, vehicles[idx]);
  await renderRoot(player, deps, persistentId); // always re-show fresh state
}

/** Per-vehicle action menu. */
async function renderActions(player, deps, persistentId, v) {
  const actions = [];
  if (v.status === "seized") {
    const form = new ActionFormData().title(`รถ ${v.plate}`).body(
      `§7${v.entityType}§r · §cถูกยึด (seized)§r\n§7ติดต่อแอดมินเพื่อคืนรถ`
    ).button("§7Back§r");
    const resp = await showOnMainThread(player, form);
    void resp;
    return;
  }

  if (v.status === "garaged") actions.push({ key: "deploy", label: "§a🚗 จอดรถออก (Deploy)§r" });
  else actions.push({ key: "store", label: "§c🅿️ เก็บเข้าอู่ (Store)§r" });
  actions.push({ key: "lock", label: v.locked ? "§e🔓 ปลดล็อก§r" : "§9🔒 ล็อกรถ§r" });
  actions.push({ key: "refuel", label: "§2⛽ เติมน้ำมัน§r" });
  actions.push({ key: "repair", label: "§2🛠 ซ่อมรถ§r" });
  actions.push({ key: v.salePriceCents != null ? "unlist" : "sell", label: v.salePriceCents != null ? "§e🏷 เอาออกขาย§r" : "§e🏷 ขาย (ตั้งราคา)§r" });
  actions.push({ key: "transfer", label: "§d🎁 โอนให้ผู้เล่น§r" });
  actions.push({ key: "back", label: "§7Back§r" });

  const form = new ActionFormData().title(`รถ ${v.plate}`).body(
    `§7${v.entityType}§r · ${v.status === "garaged" ? "จอดในอู่" : "จอดอยู่ข้างนอก"}\n` +
    `§6น้ำมัน:§f ${Number(v.fuelLevel).toFixed(0)}%   §6ตัวถัง:§f ${Number(v.bodyDamage).toFixed(0)}% dmg\n` +
    `§6เครื่อง:§f ${Number(v.engineHealth).toFixed(0)}%   §6ช่วงล่าง:§f ${Number(v.suspensionHealth).toFixed(0)}%` +
    (v.salePriceCents != null ? `\n§eประกาศขาย ${money(v.salePriceCents)} ${v.saleCurrency}§r` : "")
  );
  for (const a of actions) form.button(a.label);

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const action = actions[resp.selection];
  if (!action || action.key === "back") return;

  if (action.key === "deploy") await deployOrRedeploy(player, deps, persistentId, v.id);
  else if (action.key === "store") await storeCar(player, deps, persistentId, v);
  else if (action.key === "lock") await toggleLock(player, deps, persistentId, v);
  else if (action.key === "refuel") await openRefuel(player, deps, persistentId, v);
  else if (action.key === "repair") await doRepair(player, deps, persistentId, v);
  else if (action.key === "sell") await openSell(player, deps, persistentId, v);
  else if (action.key === "unlist") await unlist(player, deps, persistentId, v);
  else if (action.key === "transfer") await openTransfer(player, deps, persistentId, v);
}

async function deployOrRedeploy(player, deps, persistentId, vehicleId) {
  let res = await bridgeCall(deps.postToBackend, "/bridge/vehicle/deploy", { playerId: persistentId, vehicleId });
  if (res.status === 409) {
    // Entity was lost (chunk unload/restart) while the backend still says
    // deployed — park it first, then deploy again.
    const stored = await bridgeCall(deps.postToBackend, "/bridge/vehicle/store", { playerId: persistentId, vehicleId });
    if (!stored.ok) {
      sendMsg(player, `§c${stored.message || "Couldn't reclaim the vehicle."}`);
      return;
    }
    res = await bridgeCall(deps.postToBackend, "/bridge/vehicle/deploy", { playerId: persistentId, vehicleId });
  }
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "Deploy failed."}`);
    return;
  }
  const snap = res.vehicle;
  let entity;
  try {
    entity = player.dimension.spawnEntity(snap.entityType, player.location);
  } catch (err) {
    console.warn(`[bedrock-rp] spawn ${snap.entityType} failed: ${err}`);
    sendMsg(player, "§cจอดรถไม่สำเร็จ — ชนิดรถนี้ spawn ไม่ได้ในโลกนี้ (error ดู console)");
    return;
  }
  registerEntity(entity, snap.id);
  applySnapshot(entity, snap);
  sendMsg(player, `§aจอด ${snap.plate} ไว้ตรงนี้แล้ว — ย่อตัว+คลิกที่รถเพื่อจัดการ`);
}

async function storeCar(player, deps, persistentId, v) {
  const entity = entityFor(v.id);
  const res = await bridgeCall(deps.postToBackend, "/bridge/vehicle/store", { playerId: persistentId, vehicleId: v.id });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "เก็บรถไม่สำเร็จ"}`);
    return;
  }
  if (entity) {
    try { entity.remove(); } catch (err) { console.warn(`[bedrock-rp] entity remove failed: ${err}`); }
    unregisterEntity(entity, v.id);
  }
  sendMsg(player, `§aเก็บ ${res.vehicle && res.vehicle.plate ? res.vehicle.plate : ""} เข้าอู่แล้ว`);
}

async function toggleLock(player, deps, persistentId, v) {
  const locked = !v.locked;
  const res = await bridgeCall(deps.postToBackend, "/bridge/vehicle/lock", { playerId: persistentId, vehicleId: v.id, locked });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "ล็อก/ปลดล็อกไม่สำเร็จ"}`);
    return;
  }
  const entity = entityFor(v.id);
  if (entity && res.vehicle) applySnapshot(entity, res.vehicle);
  sendMsg(player, locked ? "§e🔒 ล็อกรถแล้ว" : "§a🔓 ปลดล็อกแล้ว");
}

async function openRefuel(player, deps, persistentId, v) {
  const maxUnits = Math.max(1, 100 - Math.round(Number(v.fuelLevel)));
  if (maxUnits < 1) {
    sendMsg(player, "§cถังน้ำมันเต็มแล้ว");
    return;
  }
  const form = new ModalFormData()
    .title(`เติมน้ำมัน ${v.plate}`)
    .slider("จำนวนหน่วย", 1, maxUnits, { valueStep: 1, defaultValue: Math.min(maxUnits, 50) })
    .dropdown("ชำระด้วย", ["เงินสด (cash)", "แบงก์ (bank)", "เงินแดง (red_money)"], { defaultValueIndex: 0 });
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const [units, currencyIdx] = resp.formValues;
  const currency = ["cash", "bank", "red_money"][currencyIdx];
  const costCents = units * REFUEL_PRICE_CENTS_PER_UNIT;
  sendMsg(player, `§7เติม ${units} หน่วย (~${money(costCents)} ${currency})…`);

  const res = await bridgeCall(deps.postToBackend, "/bridge/vehicle/refuel", { playerId: persistentId, vehicleId: v.id, units, currency });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "เติมน้ำมันไม่สำเร็จ"}`);
    return;
  }
  const entity = entityFor(v.id);
  if (entity && res.vehicle) applySnapshot(entity, res.vehicle);
  sendMsg(player, `§aเติมน้ำมันแล้ว +${res.refilledUnits} หน่วย (${money(res.costCents)} ${currency}) — เหลือในถัง ${Number(res.vehicle.fuelLevel).toFixed(0)}%`);
}

async function doRepair(player, deps, persistentId, v) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/vehicle/repair", { playerId: persistentId, vehicleId: v.id, currency: "cash" });
  if (!res.ok) {
    if (res.status === 409 && /nothing to repair/i.test(res.message || "")) {
      sendMsg(player, "§aรถไม่เสียอะไรเลย ยังไม่ต้องซ่อม");
    } else {
      sendMsg(player, `§c${res.message || "ซ่อมไม่สำเร็จ"}`);
    }
    return;
  }
  const entity = entityFor(v.id);
  if (entity && res.vehicle) applySnapshot(entity, res.vehicle);
  sendMsg(player, `§aซ่อมเสร็จเรียบร้อย (${money(res.costCents)} cash)`);
}

async function openSell(player, deps, persistentId, v) {
  if (v.status !== "garaged") {
    sendMsg(player, "§cต้องเก็บรถเข้าอู่ก่อนถึงจะประกาศขายได้");
    return;
  }
  const form = new ModalFormData()
    .title(`ขาย ${v.plate}`)
    .textField("ราคา (สตางค์ เช่น 100000 = 1,000 ฿)", "ใส่ตัวเลขเท่านั้น")
    .dropdown("รับเงิน", ["เงินสด (cash)", "แบงก์ (bank)", "เงินแดง (red_money)"], { defaultValueIndex: 0 });
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const [rawPrice, currencyIdx] = resp.formValues;
  const priceCents = Number(String(rawPrice ?? "").trim());
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
    sendMsg(player, "§cราคาต้องเป็นตัวเลขเต็มมากกว่า 0 (หน่วยเป็นสตางค์)");
    return;
  }
  const currency = ["cash", "bank", "red_money"][currencyIdx];
  const res = await bridgeCall(deps.postToBackend, "/bridge/vehicle/sell", { playerId: persistentId, vehicleId: v.id, priceCents, currency });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "ประกาศขายไม่สำเร็จ"}`);
    return;
  }
  sendMsg(player, `§eประกาศขาย ${v.plate} ที่ ${money(priceCents)} ${currency} แล้ว — คนอื่นหาเจอได้ในโชว์รูม`);
}

async function unlist(player, deps, persistentId, v) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/vehicle/sell", { playerId: persistentId, vehicleId: v.id, priceCents: null, currency: "cash" });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "เอาออกขายไม่สำเร็จ"}`);
    return;
  }
  sendMsg(player, `§aเอาออกขายแล้ว`);
}

async function openTransfer(player, deps, persistentId, v) {
  if (v.status !== "garaged") {
    sendMsg(player, "§cต้องเก็บรถเข้าอู่ก่อนถึงจะโอนได้");
    return;
  }
  const others = world.getAllPlayers()
    .filter((p) => p.name !== player.name)
    .map((p) => p.name);
  if (others.length === 0) {
    sendMsg(player, "§cไม่มีผู้เล่นคนอื่นออนไลน์ให้โอนตอนนี้");
    return;
  }
  const form = new ModalFormData()
    .title(`โอน ${v.plate}`)
    .dropdown("ผู้เล่นที่จะรับ (ต้องออนไลน์อยู่)", others, { defaultValueIndex: 0 });
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const targetName = others[resp.formValues[0]];
  const getPid = deps.getPersistentIdByName;
  if (typeof getPid !== "function") {
    sendMsg(player, "§cเซิร์ฟเวอร์ config ยังไม่รองรับการโอนรถ — บอก admin ด้วย");
    return;
  }
  const targetPersistentId = getPid(targetName);
  if (!targetPersistentId) {
    sendMsg(player, `§cหา identity ของ ${targetName} ไม่เจอ — ให้เค้าออกจากระบบแล้วกลับเข้ามาใหม่`);
    return;
  }
  const res = await bridgeCall(deps.postToBackend, "/bridge/vehicle/transfer", { playerId: persistentId, vehicleId: v.id, targetPersistentId });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "โอนไม่สำเร็จ"}`);
    return;
  }
  sendMsg(player, `§aโอน ${v.plate} ให้ ${targetName} แล้ว — กุญแจถูกส่งให้เค้าโดยอัตโนมัติ`);
  const targetPlayer = world.getAllPlayers().find((p) => p.name === targetName);
  if (targetPlayer) {
    sendMsg(targetPlayer, `§e🎁 ${player.name} โอนรถ ${v.plate} ให้คุณ — เปิด §f!car §eเพื่อดูที่อู่`);
  }
}

async function openShop(player, deps, persistentId) {
  const res = await fetchShop(deps);
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "โชว์รูมไม่พร้อมใช้งาน"}`);
    return;
  }
  const listing = res.vehicles ?? [];
  if (listing.length === 0) {
    sendMsg(player, "§7ตอนนี้ไม่มีรถวางขายในโชว์รูม");
    return;
  }
  const form = new ActionFormData().title("โชว์รูมรถยนต์").body(listing.length + " คันวางขาย");
  for (const v of listing) {
    form.button(`${carLabel(v)}${v.salePriceCents != null ? `  §e${money(v.salePriceCents)} ${v.saleCurrency}§r` : ""}`);
  }
  form.button("§7Close§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled || resp.selection === listing.length) return;
  const v = listing[resp.selection];
  const confirm = new ModalFormData()
    .title(`ซื้อ ${v.plate}`)
    .toggle(`จ่าย ${money(v.salePriceCents)} ${v.saleCurrency} จากกระเป๋า (wallet)`, { defaultValue: false });
  const confirmResp = await showOnMainThread(player, confirm);
  if (confirmResp.canceled || !confirmResp.formValues[0]) return;

  const bought = await bridgeCall(deps.postToBackend, "/bridge/vehicle/buy", { playerId: persistentId, vehicleId: v.id });
  if (!bought.ok) {
    sendMsg(player, `§c${bought.message || "ซื้อไม่สำเร็จ"}`);
    return;
  }
  sendMsg(player, `§aซื้อ ${bought.vehicle && bought.vehicle.plate} เรียบร้อย — กุญแจอยู่ในกระเป๋า RP (เปิด !inv) แล้วจอดรถได้จาก !car`);
}

/**
 * main.js calls this from its chatSend interceptor: returns true if the
 * message was one of our triggers (and the UI was opened / attempted).
 */
export function tryOpenVehicleUi(message, player, deps) {
  if (!deps.isConfigured()) return false;
  const lower = message.trim().toLowerCase();
  for (const trigger of TRIGGERS) {
    if (lower === trigger) {
      openVehicleUi(player, deps);
      return true;
    }
  }
  return false;
}

export async function openVehicleUi(player, deps) {
  if (!deps.isConfigured()) {
    sendMsg(player, "§cVehicle system isn't available right now — the server isn't configured for it. Tell an admin.");
    return;
  }
  const persistentId = deps.getPersistentId();
  if (!persistentId) {
    sendMsg(player, "§cCouldn't determine your account identity — rejoin and try again, or link first with §e!link <code>§c.");
    return;
  }
  const res = await fetchGarage(deps, persistentId);
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

// ---------------------------------------------------------------------------
// Sync loop + boot reconcile (exported for main.js)
// ---------------------------------------------------------------------------

/** main.js system.runInterval: report sensors & apply authoritative snapshots. */
export async function runVehicleSync(deps) {
  for (const [vehicleId, entityId] of Array.from(vehicleEntity.entries())) {
    let entity = null;
    try {
      entity = world.getEntity(entityId);
    } catch (err) {
      console.warn(`[bedrock-rp] sync lookup failed for ${entityId}: ${err}`);
    }
    if (!entity) {
      // Entity fell out of the world (chunk unload / despawn). The backend
      // still thinks it's deployed; the next deploy attempt auto-stores it.
      entityVehicle.delete(entityId);
      vehicleEntity.delete(vehicleId);
      continue;
    }
    let riders = 0;
    try {
      const ride = entity.getComponent("minecraft:rideable");
      riders = ride && typeof ride.getRiders === "function" ? ride.getRiders().length : 0;
    } catch (err) {
      console.warn(`[bedrock-rp] rider check failed: ${err}`);
    }
    if (riders === 0) continue; // only report while someone is actually driving

    let engineHealth, suspensionHealth, bodyDamage;
    try {
      engineHealth = entity.getProperty("megaverse:engine_health");
      suspensionHealth = entity.getProperty("megaverse:suspension_health");
      bodyDamage = entity.getProperty("megaverse:body_damage");
    } catch (err) {
      console.warn(`[bedrock-rp] sensor read failed: ${err}`);
    }

    const res = await bridgeCall(deps.postToBackend, "/bridge/vehicle/state", {
      vehicleId,
      drivingTicks: SYNC_INTERVAL_TICKS,
      engineHealth: typeof engineHealth === "number" ? engineHealth : undefined,
      suspensionHealth: typeof suspensionHealth === "number" ? suspensionHealth : undefined,
      bodyDamage: typeof bodyDamage === "number" ? bodyDamage : undefined,
    });
    if (!res.ok) continue; // transient bridge blip; next tick retries
    const snap = res.vehicle;
    if (!snap) continue;
    if (snap.status !== "deployed") {
      // Seized/deleted/vaulted from another surface while this car was out.
      try { entity.remove(); } catch (err) { console.warn(`[bedrock-rp] despawn on state mismatch failed: ${err}`); }
      entityVehicle.delete(entityId);
      vehicleEntity.delete(vehicleId);
      continue;
    }
    applySnapshot(entity, snap);
  }
}

/**
 * main.js boot (once): vault every vehicle the DB still marks 'deployed'
 * back into the garage, then sweep orphan megaverse entities from previous
 * sessions so they can't linger as untracked physics clutter.
 */
export async function reconcileVehicleBoot(deps) {
  try {
    await bridgeCall(deps.postToBackend, "/bridge/vehicle/reconcile", { deployedVehicleIds: [] });
  } catch (err) {
    console.warn(`[bedrock-rp] boot reconcile failed: ${err}`);
  }
  for (const dimId of ["overworld", "nether", "the_end"]) {
    let dim;
    try {
      dim = world.getDimension(dimId);
    } catch (err) {
      continue;
    }
    let entities = [];
    try {
      entities = dim.getEntities();
    } catch (err) {
      continue;
    }
    for (const entity of entities) {
      const t = entity.typeId;
      if (!t || !t.startsWith(THE_CAR_NS)) continue;
      const tracked = entityVehicle.get(entity.id);
      if (tracked != null) continue;
      let prop = null;
      try { prop = entity.getDynamicProperty("rp_vehicle_id"); } catch (err) { /* ignore */ }
      if (prop != null) {
        const id = Number(prop);
        if (Number.isInteger(id) && id > 0 && vehicleEntity.has(id)) continue;
      }
      // Orphan — no acked deploy record for it this boot.
      try { entity.remove(); } catch (err) { /* ignore */ }
    }
  }
  console.warn("[bedrock-rp] vehicle boot reconcile complete — all deployed vehicles returned to garage");
}