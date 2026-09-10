import { system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

/**
 * In-game EMS UI (`!ems` / `!medic`).
 *
 * Everything authoritative lives on the backend (backend/src/modules/ems/) —
 * this file only renders server-confirmed state and sends one chosen action
 * at a time. Mirrors the police UI conventions (sendMsg / showOnMainThread /
 * bridgeCall / actorBody), see police_ui.js.
 *
 *   citizen root (everyone):
 *     - own health state (downed timer, hospital-respawn flag) + unpaid bills
 *       with inline pay (money sink via economy.debit refType 'medical')
 *   medic root (ems.manage):
 *     - MDT-style search by name/citizenId (ems.view -> full dossier)
 *     - rescue (downed -> treated), treat (treated -> healthy + bill),
 *       declare death (downed/treated -> dead + must respawn at hospital)
 *
 * Hospital respawn enforcement (v1): on every spawn (join / death respawn)
 * the pack asks `/bridge/ems/me`; if the citizen is flagged to respawn at
 * the hospital they are teleported to HOSPITAL_SPAWN and the backend
 * `/bridge/ems/hospitalize` is fired (which returns them to healthy and
 * issues the hospital bill). No periodic poll — spawn/join is the hook
 * (documented limitation, same as jail enforcement).
 *
 * `deps` = { postToBackend, getPersistentId, getPersistentIdByName, isConfigured }.
 */

const TRIGGERS = ["!ems", "!medic"];

// จุดเกิดใหม่ที่ รพ. (hospital spawn) — เปลี่ยนให้ตรงกับ รพ. ของเซิฟเวอร์
const HOSPITAL_SPAWN = { x: 0, y: 80, z: 0 };
const HOSPITAL_DIMENSION_ID = "overworld";

const CURRENCY_LABEL = { cash: "เงินสด", bank: "ธนาคาร", red_money: "เงินแดง" };
const HEALTH_LABEL = {
  healthy: "§aปกติ§r",
  downed: "§cล้มลง (downed)§r",
  treated: "§eพักฟื้น (rescued)§r",
  dead: "§cเสียชีวิต§r",
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
          console.warn(`[bedrock-rp] EMS UI form failed: ${err}`);
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
    console.warn(`[bedrock-rp] EMS backend unreachable (${path}): ${err}`);
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

function actorBody(deps, persistentId, extra) {
  const base = {
    playerId: persistentId,
    actorPersistentId: persistentId,
    actorName: "",
  };
  return Object.assign(base, extra || {});
}

export async function tryEmsSpawnEnforcement(player, deps) {
  if (!deps.isConfigured()) return;
  const persistentId = deps.getPersistentId();
  if (!persistentId) return;
  try {
    const res = await bridgeCall(deps.postToBackend, "/bridge/ems/me", { playerId: persistentId });
    if (!res.ok) return;
    const mine = res.mine;
    if (!mine || !mine.mustRespawnHospital) return;
    const dim = world.getDimension(HOSPITAL_DIMENSION_ID);
    player.teleport(HOSPITAL_SPAWN, { dimension: dim });
    sendMsg(player, `§cคุณได้ไปเกิดที่โรงพยาบาล (เสียชีวิต) — ไปเกิดที่ รพ. ทุกครั้งจนกว่าจะรับการรักษา`);
    const hos = await bridgeCall(deps.postToBackend, "/bridge/ems/hospitalize", { playerId: persistentId });
    if (hos.ok && hos.bill) {
      sendMsg(player, `§aรักษาตัวที่โรงพยาบาลแล้ว — ค่าอนุบาล ${money(hos.bill.amountCents)} ${CURRENCY_LABEL[hos.bill.currency] || hos.bill.currency}§r`);
    } else {
      sendMsg(player, `§7(ไม่มีค่ารักษาใหม่ — รพ. ไม่ได้เรียกเก็บ)`);
    }
  } catch (err) {
    console.warn(`[bedrock-rp] hospital respawn enforcement failed: ${err}`);
  }
}

/** Root: medic menu when the player holds ems.manage, citizen menu otherwise. */
export async function openEmsUi(player, deps) {
  if (!deps.isConfigured()) {
    sendMsg(player, "§cEMS system isn't available right now — the server isn't configured for it. Tell an admin.");
    return;
  }
  const persistentId = deps.getPersistentId();
  if (!persistentId) {
    sendMsg(player, "§cCouldn't determine your account identity — rejoin and try again, or link first with §e!link <code>§c.");
    return;
  }

  const res = await bridgeCall(deps.postToBackend, "/bridge/ems/me", { playerId: persistentId });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "EMS status ไม่พร้อมใช้งาน"}`);
    return;
  }
  if (res.roles && res.roles.canManage) {
    await renderMedicRoot(player, deps, persistentId);
  } else {
    await renderCitizenStatus(player, deps, persistentId);
  }
}

async function renderCitizenStatus(player, deps, persistentId) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/ems/me", { playerId: persistentId });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "สถานะไม่พร้อมใช้งาน"}`);
    return;
  }
  const m = res.mine || {};
  const bills = (m.bills || []).filter((b) => b.status === "unpaid");
  const billLines = bills.length
    ? bills.map((b) => `§e#${b.id} ${money(b.amountCents)} ${CURRENCY_LABEL[b.currency] || b.currency}§r §7(${b.reason})§r`).join("\n")
    : "§7ไม่มีค่ารักษาค้างชำระ§r";

  const form = new ActionFormData()
    .title("§cระบบกู้ชีพ (EMS)§r — สถานะของคุณ")
    .body(
      `สถานะ: §f${HEALTH_LABEL[m.healthState] || m.healthState}§r\n` +
        (m.downedRemainingSeconds != null
          ? `§cล้มลง เหลือเวลาให้ช่วยเหลือ ${m.downedRemainingSeconds}s§r\n`
          : "") +
        (m.mustRespawnHospital ? `§cต้องไปเกิดที่โรงพยาบาล§r\n` : "") +
        `นอนโรงพยาบาลแล้ว: §f${m.hospitalizationCount || 0}§r ครั้ง\n\n` +
        `§fค่ารักษาค้างจ่าย:§r\n${billLines}`
    );
  if (bills.length) form.button("§e💰 จ่ายค่ารักษา§r");
  form.button("§7Close§r");

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (bills.length && resp.selection === 0) {
    await payBillFlow(player, deps, persistentId, bills);
  }
}

/** Citizen picks a bill and pays it (money sink). */
async function payBillFlow(player, deps, persistentId, bills) {
  const pay = new ActionFormData()
    .title("เลือกค่ารักษาที่จะจ่าย")
    .body("§7เงินจะหักจากกระเป๋าและหายจากระบบ (คืนไม่ได้)§r");
  bills.forEach((b) => {
    pay.button(`§e#${b.id} ${money(b.amountCents)} ${CURRENCY_LABEL[b.currency] || b.currency}§r §7(${b.reason})§r`);
  });
  pay.button("§7Close§r");
  const resp = await showOnMainThread(player, pay);
  if (resp.canceled || resp.selection >= bills.length) return;
  const bill = bills[resp.selection];
  const res = await bridgeCall(deps.postToBackend, "/bridge/ems/bill/pay", actorBody(deps, persistentId, { billId: bill.id }));
  if (res.ok) {
    sendMsg(player, `§aจ่ายค่ารักษา #${bill.id} แล้ว (${money(bill.amountCents)} ${CURRENCY_LABEL[bill.currency] || bill.currency})`);
  } else {
    sendMsg(player, `§c${res.message || "จ่ายไม่สำเร็จ"}`);
  }
  await renderCitizenStatus(player, deps, persistentId);
}

async function renderMedicRoot(player, deps, persistentId) {
  const form = new ActionFormData()
    .title("§cศูนย์กู้ชีพ (EMS)§r")
    .body("§7เลือกเครื่องมือ§r");
  form.button("§a🔍 ค้นหาประชาชน (เวชระเบียน)§r");
  form.button("§b💊 สถานะของฉัน§r");
  form.button("§7⟲ Reload§r");
  form.button("§7Close§r");

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (resp.selection === 0) {
    await medicLookup(player, deps, persistentId);
    await renderMedicRoot(player, deps, persistentId);
  } else if (resp.selection === 1) {
    await renderCitizenStatus(player, deps, persistentId);
  }
}

async function medicLookup(player, deps, persistentId) {
  const form = new ModalFormData()
    .title("ค้นหาประชาชน")
    .textField("ชื่อ หรือ citizenId", "เช่น สมชาย หรือ 123-456");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const query = String((resp.formValues || [])[0] || "").trim();
  if (!query) return;

  const res = await bridgeCall(deps.postToBackend, "/bridge/ems/lookup", actorBody(deps, persistentId, { query }));
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "ไม่พบข้อมูล"}`);
    return;
  }
  await medicCitizenHub(player, deps, persistentId, res.citizen);
}

async function medicCitizenHub(player, deps, persistentId, c) {
  const rec = c.record || {};
  const bills = (c.bills || []).filter((b) => b.status === "unpaid");
  const billLines = bills.length
    ? bills.map((b) => `§e#${b.id} ${money(b.amountCents)}§r §7(${b.reason})§r`).join("\n")
    : "§7ไม่มีค้าง§r";

  const form = new ActionFormData()
    .title(`§c${c.name}§r`)
    .body(
      `§7ป.ช.:§r ${c.citizenId || "—"}\n` +
        `§7สถานะ:§r ${HEALTH_LABEL[rec.healthState] || rec.healthState}\n` +
        (rec.downedRemainingSeconds != null ? `§cเหลือเวลา: ${rec.downedRemainingSeconds}s§r\n` : "") +
        (rec.mustRespawnHospital ? `§cต้องไปเกิดที่ รพ.§r\n` : "") +
        `§7นอน รพ.:§r ${rec.hospitalizationCount || 0} ครั้ง\n\n` +
        `§fค่ารักษาค้าง:§r\n${billLines}`
    );
  const canRescue = rec.healthState === "downed";
  const canTreat = rec.healthState === "treated";
  const canDeclare = rec.healthState === "downed" || rec.healthState === "treated";
  if (canRescue) form.button("§b🩹 ช่วยเหลือ (rescue)§r");
  if (canTreat) form.button("§a💉 รักษาจนหาย (treat)§r");
  if (canDeclare) form.button("§4☠️ ยืนยันการเสียชีวิต§r");
  form.button("§7Close§r");

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const idx = resp.selection;
  const buttons = [];
  if (canRescue) buttons.push("rescue");
  if (canTreat) buttons.push("treat");
  if (canDeclare) buttons.push("death");
  const action = buttons[idx];
  if (!action) return;

  const targetPersistentId = c.persistentId;
  if (!targetPersistentId) {
    sendMsg(player, `§c${c.name} ยังไม่ได้ connect (ไม่มี persistentId) — ให้ไปลิงก์ก่อน`);
    return;
  }
  const body = actorBody(deps, persistentId, { targetPersistentId, targetName: c.name });
  if (action === "rescue") {
    const r = await bridgeCall(deps.postToBackend, "/bridge/ems/rescue", body);
    r.ok
      ? sendMsg(player, `§aช่วย ${c.name} แล้ว — ตอนนี้พักฟื้น (treated) รอรักษา`)
      : sendMsg(player, `§c${r.message || "ช่วยเหลือไม่สำเร็จ"}`);
  } else if (action === "treat") {
    const r = await bridgeCall(deps.postToBackend, "/bridge/ems/treat", body);
    r.ok
      ? sendMsg(player, `§aรักษา ${c.name} จนหายแล้ว — เรียกเก็บค่ารักษา ${r.bill ? money(r.bill.amountCents) + " " + (CURRENCY_LABEL[r.bill.currency] || r.bill.currency) : ""}§r`)
      : sendMsg(player, `§c${r.message || "รักษาไม่สำเร็จ"}`);
  } else if (action === "death") {
    const ok = await confirmDeath(player, c.name);
    if (!ok) return;
    const r = await bridgeCall(deps.postToBackend, "/bridge/ems/declare-death", body);
    r.ok
      ? sendMsg(player, `§4ยืนยันการเสียชีวิตของ ${c.name} แล้ว — ไปเกิดที่ รพ. เมื่อ respawn`)
      : sendMsg(player, `§c${r.message || "ไม่สำเร็จ"}`);
  }
}

function confirmDeath(player, name) {
  // No confirm() exists in the Bedrock script API — require typing the
  // target's exact character name so a mis-tap can still bail out.
  return new Promise((resolve) => {
    const form = new ModalFormData()
      .title("ยืนยันการเสียชีวิต")
      .textField(`พิมพ์ชื่อของ ${name} เพื่อยืนยันการเสียชีวิต`, name);
    showOnMainThread(player, form).then((r) => {
      const typed = String((r.formValues || [])[0] || "").trim();
      resolve(r.canceled ? false : typed === name);
    });
  });
}

export function tryOpenEmsUi(message, player, deps) {
  if (!deps.isConfigured()) return false;
  const lower = message.trim().toLowerCase();
  for (const trigger of TRIGGERS) {
    if (lower === trigger) {
      openEmsUi(player, deps);
      return true;
    }
  }
  return false;
}