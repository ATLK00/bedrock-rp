import { system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

/**
 * In-game police UI (`!police` / `!mdt`).
 *
 * Everything authoritative lives on the backend (see backend/src/modules/
 * police/) — this file only renders server-confirmed state and sends one
 * chosen action at a time:
 *
 *   officer root (canManage) ->
 *     - MDT ค้นหาประชาชน by name/citizenId (full dossier)
 *     - MDT ค้นหารถ by plate
 *     - citizen action hub: fine / arrest / release / warrant / license / record
 *     - reports (create / close) and evidence logging
 *   citizen root (everyone) ->
 *     - outstanding fines (pay inline — money sink), license status,
 *     - active warrants, jail status (ลบความจำ: เกิดใหม่จะไปคุกอัตโนมัติ)
 *
 * Jail enforcement (v1): on every spawn the pack asks `/bridge/police/me`;
 * if the citizen has an active sentence they are teleported to the prison
 * point below. Server clock is authoritative (`jail_until`) and an expired
 * sentence is auto-marked `served` server-side; there is deliberately no
 * periodic poll — re-spawn/re-join is the enforcement hook (documented
 * limitation in AI_HANDOFF).
 *
 * Authorization: the bridge resolves the actor from the persistentId the
 * server captured at join and re-checks RBAC (police.view/manage/admin).
 * The pack is never trusted to decide who may act; a refusal surfaces as a
 * HIGH security event server-side.
 *
 * `deps` = { postToBackend, getPersistentId, getPersistentIdByName, isConfigured }.
 */

const TRIGGERS = ["!police", "!mdt"];

// ยกพื้นคุก: จุดเกิดใหม่ของผู้ต้องขัง (เปลี่ยนให้ตรงกับคุกของเซิฟเวอร์)
const PRISON_SPAWN = { x: 0, y: 80, z: 0 };
const PRISON_DIMENSION_ID = "overworld";

const THREAT_LABEL = {
  none: "§7none§r",
  low: "§8low§r",
  medium: "§emedium§r",
  high: "§6high§r",
  critical: "§ccritical§r",
};
const CURRENCY_LABEL = { cash: "เงินสด", bank: "ธนาคาร", red_money: "เงินแดง" };
const LICENSE_LABEL = {
  driving: "ใบขับขี่",
  weapon: "ใบปืน",
  business: "ใบประกอบธุรกิจ",
  fishing: "ใบประมง",
  aviation: "ใบการบิน",
};
const WARRANT_LABEL = { arrest: "หมายจับ", search: "หมายค้น" };

function sendMsg(player, text) {
  system.run(() => player.sendMessage(text));
}

function showOnMainThread(player, form) {
  return new Promise((resolve) => {
    system.run(() => {
      form
        .show(player)
        .then(resolve, (err) => {
          console.warn(`[bedrock-rp] police UI form failed: ${err}`);
          resolve({ canceled: true });
        });
    });
  });
}

function money(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function fmtWarrant(w) {
  return `${WARRANT_LABEL[w.warrantType] || w.warrantType}§r §7${w.reason}§r${
    w.expiresAt ? ` §8หมดอายุ ${new Date(w.expiresAt).toLocaleTimeString("th-TH")}§r` : ""
  }`;
}

async function bridgeCall(postToBackend, path, body) {
  let response;
  try {
    response = await postToBackend(path, body);
  } catch (err) {
    console.warn(`[bedrock-rp] police backend unreachable (${path}): ${err}`);
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
  // actorName isn't wired store-side for police (RBAC is by persistentId);
  // it's only used for display/audit, so fill it from the player roster.
  return Object.assign(base, extra || {});
}

export async function tryPoliceSpawnEnforcement(player, deps) {
  if (!deps.isConfigured()) return;
  const persistentId = deps.getPersistentId();
  if (!persistentId) return;
  try {
    const res = await bridgeCall(deps.postToBackend, "/bridge/police/me", { playerId: persistentId });
    if (!res.ok) return;
    const arrest = res.mine && res.mine.arrest;
    if (!arrest) return;
    if (arrest.status !== "active") return;
    const dim = world.getDimension(PRISON_DIMENSION_ID);
    const loc = new Location(PRISON_SPAWN.x, PRISON_SPAWN.y, PRISON_SPAWN.z);
    player.teleport(loc, { dimension: dim });
    sendMsg(player, `§cคุณอยู่ในคุก — เหลือ ${arrest.minutesRemaining} นาที (§7${arrest.reason}§c)`);
  } catch (err) {
    console.warn(`[bedrock-rp] jail enforcement check failed: ${err}`);
  }
}

/** Root: officer menu when the player holds police.manage, citizen menu otherwise. */
export async function openPoliceUi(player, deps) {
  if (!deps.isConfigured()) {
    sendMsg(player, "§cPolice system isn't available right now — the server isn't configured for it. Tell an admin.");
    return;
  }
  const persistentId = deps.getPersistentId();
  if (!persistentId) {
    sendMsg(player, "§cCouldn't determine your account identity — rejoin and try again, or link first with §e!link <code>§c.");
    return;
  }

  const roles = await bridgeCall(deps.postToBackend, "/bridge/police/roles", { playerId: persistentId });
  if (!roles.ok) {
    sendMsg(player, `§c${roles.message || "police status ไม่พร้อมใช้งาน"}`);
    return;
  }
  if (roles.roles && roles.roles.canManage) {
    await renderOfficerRoot(player, deps, persistentId);
  } else {
    await renderCitizenRoot(player, deps, persistentId);
  }
}

async function renderOfficerRoot(player, deps, persistentId) {
  const form = new ActionFormData()
    .title("§dศูนย์ปฏิบัติการตำรวจ (MDT)§r")
    .body("§7เลือกเครื่องมือ§r");
  form.button("§a🔍 ค้นหาประชาชน§r");
  form.button("§a🚗 ค้นหารถ (ป้ายทะเบียน)§r");
  form.button("§b📄 รายงาน / หลักฐาน§r");
  form.button("§7⟲ Reload§r");
  form.button("§7Close§r");

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (resp.selection === 0) {
    await officerLookupCitizen(player, deps, persistentId);
    await renderOfficerRoot(player, deps, persistentId);
  } else if (resp.selection === 1) {
    await officerLookupVehicle(player, deps, persistentId);
    await renderOfficerRoot(player, deps, persistentId);
  } else if (resp.selection === 2) {
    await officerReports(player, deps, persistentId);
    await renderOfficerRoot(player, deps, persistentId);
  }
}

async function officerLookupCitizen(player, deps, persistentId) {
  const form = new ModalFormData()
    .title("ค้นหาประชาชน")
    .textField("ชื่อ หรือ citizenId", "เช่น สมชาย หรือ 123-456");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const query = String((resp.formValues || [])[0] || "").trim();
  if (!query) return;

  const res = await bridgeCall(deps.postToBackend, "/bridge/police/lookup/character", actorBody(deps, persistentId, { query }));
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "ไม่พบข้อมูล"}`);
    return;
  }
  await citizenHub(player, deps, persistentId, res.citizen);
}

async function officerLookupVehicle(player, deps, persistentId) {
  const form = new ModalFormData()
    .title("ค้นหารถ")
    .textField("ป้ายทะเบียน", "เช่น ABC123");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const plate = String((resp.formValues || [])[0] || "").trim().toUpperCase();
  if (!plate) return;

  const res = await bridgeCall(deps.postToBackend, "/bridge/police/lookup/vehicle", actorBody(deps, persistentId, { plate }));
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "ไม่พบรถ"}`);
    return;
  }
  const v = res.vehicle;
  sendMsg(
    player,
    `§a🚗 §f${v.plate}§r §7(${v.entityType})§r\n` +
      `§7เจ้าของ: §f${v.ownerName || "—"}§r §7(ป.ช. §f${v.ownerCitizenId || "—"}§7)§r\n` +
      `§7สถานะ: §f${v.status}§r ${v.locked ? "§6🔒§r" : "§8🔓§r"}\n` +
      `§7น้ำมัน: §f${Number(v.fuelLevel).toFixed(0)}%§r §7ความเสียหาย: §f${Number(v.bodyDamage).toFixed(0)}§r\n` +
      `§7ขาย: §f${v.salePriceCents != null ? money(v.salePriceCents) + " " + v.saleCurrency : "—"}§r`
  );
}

/** Full dossier for one citizen + officer actions (target must be online for actions). */
async function citizenHub(player, deps, persistentId, c) {
  const targetPersistentId = c.persistentId || null;
  const licenses = (c.licenses || []).map((l) => `${LICENSE_LABEL[l.licenseType] || l.licenseType}: §f${l.status}§r`).join(", ") || "—";
  const fines = (c.fines || []).filter((f) => f.status === "outstanding")
    .map((f) => `§e#${f.id} ${money(f.amountCents)}${CURRENCY_LABEL[f.currency] ? " " + CURRENCY_LABEL[f.currency] : ""}§r §7(${f.reason})§r`)
    .join("\n") || "§7ไม่มี§r";
  const warrants = (c.warrants || []).map(fmtWarrant).join("\n") || "§7ไม่มี§r";
  const jail = c.arrest
    ? `§cอยู่ในคุก เหลือ ${c.arrest.minutesRemaining} นาที§r (§7${c.arrest.reason}§r)`
    : "§7ไม่อยู่ในคุก§r";

  const form = new ActionFormData()
    .title(`§d${c.name}§r`)
    .body(
      `§7ป.ช.:§r ${c.citizenId || "—"} §7เพศ:§r ${c.gender || "—"} §7เกิด:§r ${c.dateOfBirth || "—"}\n` +
        `§7ระดับ:§r ${THREAT_LABEL[c.record && c.record.threatLevel] || "§7none§r"}\n\n` +
        `§fบัตร:§r ${licenses}\n\n` +
        `§fค่าปรับค้าง:§r\n${fines}\n\n` +
        `§fหมายศาล:§r\n${warrants}\n\n` +
        `§fคุก:§r ${jail}`
    );
  form.button("§e💰 ออกค่าปรับ§r");
  form.button("§3🛡️ หมายศาล§r");
  form.button("§2🎫 บัตร§r");
  form.button("§4⛓️ จับกุม§r");
  form.button("§6🔓 ปล่อยตัว§r");
  form.button("§5📝 อัปเดต record§r");
  form.button("§7Close§r");

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (resp.selection === 0) {
    await officerFine(player, deps, persistentId, targetPersistentId, c.name);
  } else if (resp.selection === 1) {
    await officerWarrant(player, deps, persistentId, targetPersistentId, c.name);
  } else if (resp.selection === 2) {
    await officerLicense(player, deps, persistentId, targetPersistentId, c.name);
  } else if (resp.selection === 3) {
    await officerArrest(player, deps, persistentId, targetPersistentId, c.name);
  } else if (resp.selection === 4) {
    await officerRelease(player, deps, persistentId, targetPersistentId, c.name);
  } else if (resp.selection === 5) {
    await officerRecord(player, deps, persistentId, targetPersistentId, c.name);
  }
}

async function requireOnlineTarget(player, deps, targetPersistentId, targetName) {
  if (targetPersistentId) return { ok: true, targetPersistentId, targetName };
  sendMsg(player, `§c${targetName} ยังไม่เคยออนไลน์บนเซิฟเวอร์ — ไม่สามารถสั่งการให้ได้ (ต้องเป็นผู้เล่นที่ออนไลน์)`);
  return { ok: false };
}

async function officerFine(player, deps, persistentId, targetPersistentId, targetName) {
  const t = await requireOnlineTarget(player, deps, targetPersistentId, targetName);
  if (!t.ok) return;
  const form = new ModalFormData()
    .title(`ค่าปรับ ${targetName}`)
    .textField("จำนวนเงิน (สตางค์)", "เช่น 50000 = 500 บาท", "50000")
    .dropdown("สกุลเงิน", ["cash", "bank", "red_money"], { defaultValueIndex: 0 })
    .textField("เหตุผล", "เช่น ฝ่าไฟแดง");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const amountCents = Number((resp.formValues || [])[0]);
  const currency = (resp.formValues || [])[1];
  const reason = String((resp.formValues || [])[2] || "").trim();
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || !reason) {
    sendMsg(player, "§cต้องใส่จำนวนเงินและเหตุผลให้ครบ");
    return;
  }
  const res = await bridgeCall(deps.postToBackend, "/bridge/police/fine", actorBody(deps, persistentId, {
    targetPersistentId: t.targetPersistentId, targetName,
    amountCents, currency, reason,
  }));
  sendMsg(player, res.ok
    ? `§aออกค่าปรับ #${res.fine && res.fine.id} แล้ว — ${targetName} ต้องจ่าย ${money(amountCents)} ${currency}`
    : `§c${res.message || "ออกค่าปรับไม่สำเร็จ"}`);
}

async function officerWarrant(player, deps, persistentId, targetPersistentId, targetName) {
  const t = await requireOnlineTarget(player, deps, targetPersistentId, targetName);
  if (!t.ok) return;
  const form = new ModalFormData()
    .title(`หมายศาล ${targetName}`)
    .dropdown("ประเภท", ["arrest", "search"], { defaultValueIndex: 0 })
    .textField("เหตุผล", "เช่น ต้องสงสัย", "")
    .textField("หมดอายุภายใน (นาที, ว่าง = ไม่จำกัด)", "เช่น 180", "");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const warrantType = (resp.formValues || [])[0];
  const reason = String((resp.formValues || [])[1] || "").trim();
  const minutesRaw = String((resp.formValues || [])[2] || "").trim();
  if (!reason) {
    sendMsg(player, "§cต้องใส่เหตุผล");
    return;
  }
  const body = { targetPersistentId: t.targetPersistentId, targetName, warrantType, reason };
  if (minutesRaw !== "") {
    const m = Number(minutesRaw);
    if (!Number.isSafeInteger(m) || m <= 0) {
      sendMsg(player, "§cนาทีต้องเป็นเลขจำนวนเต็มบวก");
      return;
    }
    body.minutes = m;
  }
  const res = await bridgeCall(deps.postToBackend, "/bridge/police/warrant", actorBody(deps, persistentId, body));
  sendMsg(player, res.ok
    ? `§aออก${WARRANT_LABEL[warrantType]}แล้ว (#${res.warrant && res.warrant.id})`
    : `§c${res.message || "ออกหมายไม่สำเร็จ"}`);
}

async function officerLicense(player, deps, persistentId, targetPersistentId, targetName) {
  const t = await requireOnlineTarget(player, deps, targetPersistentId, targetName);
  if (!t.ok) return;
  const form = new ModalFormData()
    .title(`บัตร ${targetName}`)
    .dropdown("ประเภท", ["driving", "weapon", "business", "fishing", "aviation"], { defaultValueIndex: 0 })
    .dropdown("การกระทำ", ["issue", "suspend", "revoke"], { defaultValueIndex: 0 })
    .textField("หมายเหตุ (ว่างได้)", "", "");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const [licenseType, action, notes] = resp.formValues || [];
  const res = await bridgeCall(deps.postToBackend, "/bridge/police/license", actorBody(deps, persistentId, {
    targetPersistentId: t.targetPersistentId, targetName, action, licenseType, notes,
  }));
  sendMsg(player, res.ok
    ? `§aบัตร ${LICENSE_LABEL[licenseType]} → ${action} แล้ว`
    : `§c${res.message || "จัดการบัตรไม่สำเร็จ"}`);
}

async function officerArrest(player, deps, persistentId, targetPersistentId, targetName) {
  const t = await requireOnlineTarget(player, deps, targetPersistentId, targetName);
  if (!t.ok) return;
  const form = new ModalFormData()
    .title(`จับกุม ${targetName}`)
    .textField("เหตุผล", "เช่น ทำร้ายร่างกาย", "")
    .textField("จำคุก (นาที, 1-1440)", "", "120");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const reason = String((resp.formValues || [])[0] || "").trim();
  const minutes = Number((resp.formValues || [])[1]);
  if (!reason || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) {
    sendMsg(player, "§cต้องใส่เหตุผล และนาที 1-1440");
    return;
  }
  const res = await bridgeCall(deps.postToBackend, "/bridge/police/arrest", actorBody(deps, persistentId, {
    targetPersistentId: t.targetPersistentId, targetName, reason, minutes,
  }));
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "จับกุมไม่สำเร็จ"}`);
    return;
  }
  sendMsg(player, `§cจับ ${targetName} เรียบร้อย — จำคุก ${minutes} นาที`);
  const dread = world.getAllPlayers().find((p) => p.name === targetName);
  if (dread) sendMsg(dread, `§cถูกจับกุม — เหตุผล: ${reason} จำคุก ${minutes} นาที (เกิดใหม่จะอยู่ในคุก)`);
}

async function officerRelease(player, deps, persistentId, targetPersistentId, targetName) {
  const t = await requireOnlineTarget(player, deps, targetPersistentId, targetName);
  if (!t.ok) return;
  const form = new ActionFormData()
    .title(`ปล่อยตัว ${targetName}`)
    .body("§7ปล่อยก่อนครบกำหนด จริง ๆ เหรอ?")
    .button("§aปล่อยตัว§r")
    .button("§7ยกเลิก§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled || resp.selection !== 0) return;
  const res = await bridgeCall(deps.postToBackend, "/bridge/police/release", actorBody(deps, persistentId, {
    targetPersistentId: t.targetPersistentId, targetName,
  }));
  sendMsg(player, res.ok
    ? `§aปล่อยตัว ${targetName} แล้ว`
    : `§c${res.message || "ปล่อยตัวไม่สำเร็จ"}`);
  if (res.ok) {
    const freed = world.getAllPlayers().find((p) => p.name === targetName);
    if (freed) sendMsg(freed, `§aคุณถูกปล่อยตัวแล้ว — มีเสรีภาพแล้ว`);
  }
}

async function officerRecord(player, deps, persistentId, targetPersistentId, targetName) {
  const t = await requireOnlineTarget(player, deps, targetPersistentId, targetName);
  if (!t.ok) return;
  const form = new ModalFormData()
    .title(`อัปเดต record ${targetName}`)
    .dropdown("threat level", ["none", "low", "medium", "high", "critical"], { defaultValueIndex: 0 })
    .textField("alias (ว่าง = คงเดิม)", "", "")
    .textField("notes (ว่าง = คงเดิม)", "", "");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const [threatLevel, alias, notes] = resp.formValues || [];
  await bridgeCall(deps.postToBackend, "/bridge/police/record", actorBody(deps, persistentId, {
    targetPersistentId: t.targetPersistentId, targetName, threatLevel, alias, notes,
  }));
  sendMsg(player, "§aอัปเดต record แล้ว");
}

async function officerReports(player, deps, persistentId) {
  const form = new ActionFormData()
    .title("รายงาน / หลักฐาน")
    .body("§7เขียนรายงานปิดเคส หรือลงหลักฐาน§r");
  form.button("§bเขียนรายงาน§r");
  form.button("§bปิดรายงาน (ต้องทราบเลขรายงาน)§r");
  form.button("§bลงหลักฐาน§r");
  form.button("§7Close§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;

  if (resp.selection === 0) {
    const create = new ModalFormData()
      .title("รายงานใหม่")
      .textField("หัวเรื่อง", "เช่น จับกุมตามหมาย", "")
      .textField("รายละเอียด", "", "")
      .dropdown("ชั้นความลับ", ["general", "restricted", "classified"], { defaultValueIndex: 0 });
    const cResp = await showOnMainThread(player, create);
    if (cResp.canceled) return;
    const title = String((cResp.formValues || [])[0] || "").trim();
    const body = String((cResp.formValues || [])[1] || "").trim();
    const classification = (cResp.formValues || [])[2];
    if (!title || !body) {
      sendMsg(player, "§cต้องใส่หัวเรื่องและรายละเอียด");
      return;
    }
    const res = await bridgeCall(deps.postToBackend, "/bridge/police/report", actorBody(deps, persistentId, { title, body, classification }));
    sendMsg(player, res.ok ? `§aรายงาน #${res.report && res.report.id} บันทึกแล้ว` : `§c${res.message || "บันทึกรายงานไม่สำเร็จ"}`);
    return;
  }
  if (resp.selection === 1) {
    const close = new ModalFormData().title("ปิดรายงาน").textField("เลขรายงาน (reportId)", "เช่น 7", "");
    const clResp = await showOnMainThread(player, close);
    if (clResp.canceled) return;
    const reportIdRaw = String((clResp.formValues || [])[0] || "").trim();
    const reportId = Number(reportIdRaw);
    if (!Number.isSafeInteger(reportId) || reportId <= 0) {
      sendMsg(player, "§cเลขรายงานไม่ถูกต้อง");
      return;
    }
    const res = await bridgeCall(deps.postToBackend, "/bridge/police/report/close", actorBody(deps, persistentId, { reportId }));
    sendMsg(player, res.ok ? `§aปิดรายงาน #${reportId} แล้ว` : `§c${res.message || "ปิดรายงานไม่สำเร็จ"}`);
    return;
  }
  if (resp.selection === 2) {
    const ev = new ModalFormData()
      .title("หลักฐาน")
      .textField("รายละเอียด", "เช่น กล้องวงจรปิด A-07", "")
      .textField("เลขรายงาน (ว่าง = กลาง)", "", "")
      .textField("itemId (ว่างได้)", "", "")
      .textField("จำนวน (default 1)", "", "1");
    const evResp = await showOnMainThread(player, ev);
    if (evResp.canceled) return;
    const description = String((evResp.formValues || [])[0] || "").trim();
    if (!description) {
      sendMsg(player, "§cต้องใส่รายละเอียดหลักฐาน");
      return;
    }
    const reportIdRaw = String((evResp.formValues || [])[1] || "").trim();
    const body = { description };
    if (reportIdRaw !== "") {
      const rid = Number(reportIdRaw);
      if (!Number.isSafeInteger(rid) || rid <= 0) {
        sendMsg(player, "§cเลขรายงานไม่ถูกต้อง");
        return;
      }
      body.reportId = rid;
    }
    const itemId = String((evResp.formValues || [])[2] || "").trim();
    const quantity = Number((evResp.formValues || [])[3] || "1");
    if (itemId) body.itemId = itemId;
    if (Number.isSafeInteger(quantity) && quantity > 0) body.quantity = quantity;
    const res = await bridgeCall(deps.postToBackend, "/bridge/police/evidence", actorBody(deps, persistentId, body));
    sendMsg(player, res.ok ? `§aบันทึกหลักฐานแล้ว (#${res.evidence && res.evidence.id})` : `§c${res.message || "บันทึกหลักฐานไม่สำเร็จ"}`);
  }
}

async function renderCitizenRoot(player, deps, persistentId) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/police/me", { playerId: persistentId });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "สถานะทางกฎหมายไม่พร้อมใช้งาน"}`);
    return;
  }
  const mine = res.mine || {};
  const fines = (mine.fines || []).filter((f) => f.status === "outstanding");
  const lic = (mine.licenses || []).map((l) => `${LICENSE_LABEL[l.licenseType] || l.licenseType}: §f${l.status}§r`).join(", ") || "§7ไม่มีบัตร§r";
  const warrants = (mine.warrants || []).map(fmtWarrant).join("\n") || "§7ไม่มีหมาย§r";
  const jail = mine.arrest
    ? `§cอยู่ในคุก เหลือ ${mine.arrest.minutesRemaining} นาที§r (§7${mine.arrest.reason}§r)`
    : "§7ไม่อยู่ในคุก§r";

  const form = new ActionFormData()
    .title("§dสถานะทางกฎหมายของคุณ§r")
    .body(
      `§fบัตร:§r ${lic}\n\n` +
        `§fค่าปรับค้าง:§r ${fines.length === 0 ? "§7ไม่มี§r" : ""}\n` +
        fines.map((f) => `§e#${f.id} §7${money(f.amountCents)} ${CURRENCY_LABEL[f.currency] || f.currency} — ${f.reason}§r`).join("\n") +
        `\n\n§fหมายศาล:§r\n${warrants}\n\n§fคุก:§r ${jail}`
    );
  if (fines.length > 0) form.button("§e💰 จ่ายค่าปรับทั้งหมด§r");
  form.button("§7⟲ Reload§r");
  form.button("§7Close§r");

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (resp.selection === 0 && fines.length > 0) {
    for (const f of fines) {
      const paid = await bridgeCall(deps.postToBackend, "/bridge/police/fine/pay", {
        playerId: persistentId, fineId: f.id,
      });
      sendMsg(player, paid.ok
        ? `§aจ่ายค่าปรับ #${f.id} แล้ว (§7${money(f.amountCents)} ${f.currency}§a)`
        : `§cค่าปรับ #${f.id}: ${paid.message || "จ่ายไม่สำเร็จ"}`);
    }
    await renderCitizenRoot(player, deps, persistentId);
  }
}

export function tryOpenPoliceUi(message, player, deps) {
  if (!deps.isConfigured()) return false;
  const lower = message.trim().toLowerCase();
  for (const trigger of TRIGGERS) {
    if (lower === trigger) {
      openPoliceUi(player, deps);
      return true;
    }
  }
  return false;
}