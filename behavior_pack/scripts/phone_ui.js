import { system } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

/**
 * In-game phone UI (`!phone`) — expandable app framework, MASTER_PROMPT §15.
 *
 * The backend owns every byte (phone number, contacts, messages, calls,
 * waypoints, taxi board, emergency calls, bank balance). This file renders
 * server state into Bedrock forms and sends one action at a time. Mirrors
 * the police/EMS UI conventions (sendMsg / showOnMainThread / bridgeCall /
 * actorBody).
 *
 * Seed apps (v1):
 *   contacts   → address book CRUD (number is a 09x 10-digit string)
 *   messages   → SMS-style inbox/outbox with unread count + mark-read
 *   calls      → server-authoritative ringing/connected/ended/missed; a call
 *                to an offline number is recorded missed immediately, and a
 *                ringing call times out server-side (~60s). No audio in
 *                Bedrock — accepting shows both parties are "in a call";
 *                the callee is nudged in chat to open `!phone` to answer.
 *   bank       → balances + transfer to another number (economy.transfer)
 *   GPS        → waypoints
 *   taxi       → rider requests a ride (pickup coords + fare); drivers
 *                (phone.taxi.manage) take jobs from the board and complete
 *                the trip, which moves the fare via economy.transfer
 *   emergency  → 911-subject call (dispatchers phone.emergency.view/manage)
 *   business   → placeholder app shell (storefronts come later; registering
 *                a business creates a reserved phone contact for it)
 *
 * `deps` = { postToBackend, getPersistentId, getPersistentIdByName, isConfigured }.
 */

const TRIGGERS = ["!phone"];
const CURRENCY_LABEL = { cash: "เงินสด", bank: "ธนาคาร", red_money: "เงินแดง" };

function sendMsg(player, text) {
  system.run(() => player.sendMessage(text));
}

function showOnMainThread(player, form) {
  return new Promise((resolve) => {
    system.run(() => {
      form
        .show(player)
        .then(resolve, (err) => {
          console.warn(`[bedrock-rp] phone UI form failed: ${err}`);
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
    console.warn(`[bedrock-rp] phone backend unreachable (${path}): ${err}`);
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

export async function tryPhoneCallAlert(player, deps, mine) {
  // The phone "ring": if there is a ringing call addressed to this player,
  // `/bridge/phone/calls/list` marks timeouts lazily — just surface the
  // newest ringing call so they open `!phone` to answer.
  const res = await bridgeCall(deps.postToBackend, "/bridge/phone/calls/list", { playerId: deps.getPersistentId() });
  if (!res.ok) return;
  const ringing = (res.calls || []).filter((c) => c.status === "ringing" && c.calleeCharacterId === mine.characterId);
  if (ringing.length) {
    const c = ringing[0];
    sendMsg(player, `§6📞 สายเรียกเข้าจาก §f${c.callerName || ""}§6 — พิมพ์ §e!phone§6 เพื่อรับสาย§r`);
  }
}

export async function openPhoneUi(player, deps) {
  if (!deps.isConfigured()) {
    sendMsg(player, "§cPhone system isn't available right now — the server isn't configured for it. Tell an admin.");
    return;
  }
  const persistentId = deps.getPersistentId();
  if (!persistentId) {
    sendMsg(player, "§cCouldn't determine your account identity — rejoin and try again, or link first with §e!link <code>§c.");
    return;
  }

  const res = await bridgeCall(deps.postToBackend, "/bridge/phone/me", { playerId: persistentId });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "โปรดลองใหม่"}`);
    return;
  }
  const mine = res.mine || {};
  const roles = res.roles || {};
  await renderRoot(player, deps, persistentId, mine, roles);
}

async function renderRoot(player, deps, persistentId, mine, roles) {
  const form = new ActionFormData()
    .title("§2โทรศัพท์§r")
    .body(
      `§7เบอร์:§r ${mine.number || "—"} §7ใช่:§r §f§r\n` +
        (mine.unreadCount > 0 ? `§cข้อความไม่ถูกอ่าน: ${mine.unreadCount}§r\n` : "") +
        (mine.healthState ? `§7สถานะสุขภาพ:§r ${mine.healthState}\n` : "")
    );
  form.button("§3📇 รายชื่อ (contacts)§r");
  form.button("§e💬 ข้อความ (messages)§r");
  form.button("§6📞 โทรศัพท์ (calls)§r");
  form.button("§b🏦 ธนาคาร (bank)§r");
  form.button("§a🧭 GPS§r");
  form.button("§5🚕 แท็กซี่ (taxi)§r");
  if (roles.canEmergencyView || roles.canEmergencyManage) form.button("§4🆘 เหตุฉุกเฉิน§r");
  form.button("§8🏢 ธุรกิจ (apps)§r");
  form.button("§7⟲ Reload§r");
  form.button("§7Close§r");

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const base = renderRoot.bind(null, player, deps, persistentId, mine, roles);
  const items = [
    "contacts", "messages", "calls", "bank", "gps", "taxi",
    ...(roles.canEmergencyView || roles.canEmergencyManage ? ["emergency"] : []),
    "business",
  ];
  const pick = items[resp.selection];
  if (!pick) return;
  if (pick === "contacts") await renderContacts(player, deps, persistentId);
  else if (pick === "messages") await renderMessagesMenu(player, deps, persistentId);
  else if (pick === "calls") await renderCalls(player, deps, persistentId);
  else if (pick === "bank") await renderBank(player, deps, persistentId);
  else if (pick === "gps") await renderGps(player, deps, persistentId);
  else if (pick === "taxi") await renderTaxi(player, deps, persistentId, roles);
  else if (pick === "emergency") await renderEmergency(player, deps, persistentId, roles);
  else if (pick === "business") await renderBusiness(player);
  await base();
}

// -------------------------------------------------------------- contacts

async function renderContacts(player, deps, persistentId) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/phone/contacts", { playerId: persistentId });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "โหลดรายชื่อไม่สำเร็จ"}`);
    return;
  }
  const list = res.contacts || [];
  const form = new ActionFormData()
    .title("§3รายชื่อ§r")
    .body(list.length ? list.map((c) => `§f${c.name}§r §7${c.number}§r`).join("\n") : "§7ยังไม่มีรายชื่อ§r");
  form.button("§a➕ เพิ่มรายชื่อ§r");
  if (list.length) form.button("§e✏️ แก้ไข / ลบ§r");
  form.button("§7Back§r");

  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (resp.selection === 0) {
    await addContact(player, deps, persistentId);
  } else if (list.length && resp.selection === 1) {
    await editContact(player, deps, persistentId, list);
  }
}

async function addContact(player, deps, persistentId) {
  const form = new ModalFormData()
    .title("เพิ่มรายชื่อ")
    .textField("ชื่อ", "เช่น แม่")
    .textField("เบอร์ (09xxxxxxxx)", "0987654321")
    .textField("หมายเหตุ (ว่างได้)", "");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const name = String((resp.formValues || [])[0] || "").trim();
  const number = String((resp.formValues || [])[1] || "").trim();
  const note = String((resp.formValues || [])[2] || "").trim();
  if (!name || !number) {
    sendMsg(player, "§cต้องกรอกชื่อและเบอร์");
    return;
  }
  const r = await bridgeCall(deps.postToBackend, "/bridge/phone/contacts/add", actorBody(deps, persistentId, { name, number, note: note || null }));
  sendMsg(player, r.ok ? `§aเพิ่ม ${name} แล้ว§r` : `§c${r.message || "ไม่สำเร็จ"}`);
}

async function editContact(player, deps, persistentId, list) {
  const form = new ActionFormData().title("เลือกรายชื่อ");
  list.forEach((c) => form.button(`${c.name} §7${c.number}§r`));
  const resp = await showOnMainThread(player, form);
  if (resp.canceled || resp.selection >= list.length) return;
  const c = list[resp.selection];
  const edit = new ActionFormData()
    .title(`§e${c.name}§r`)
    .body(`เบอร์: §f${c.number}§r ${c.note ? `§7(${c.note})§r` : ""}`);
  edit.button("§e✏️ แก้ไข§r");
  edit.button("§4🗑️ ลบ§r");
  edit.button("§7Back§r");
  const r2 = await showOnMainThread(player, edit);
  if (r2.canceled) return;
  if (r2.selection === 0) {
    const m = new ModalFormData().title("แก้ไขรายชื่อ")
      .textField("ชื่อ", "เดิม: " + c.name, c.name)
      .textField("เบอร์", "เดิม: " + c.number, c.number)
      .textField("หมายเหตุ", "", c.note || "");
    const mr = await showOnMainThread(player, m);
    if (mr.canceled) return;
    const r3 = await bridgeCall(deps.postToBackend, "/bridge/phone/contacts/update", actorBody(deps, persistentId, {
      contactId: c.id,
      name: String((mr.formValues || [])[0] || "").trim() || c.name,
      number: String((mr.formValues || [])[1] || "").trim() || c.number,
      note: String((mr.formValues || [])[2] || "").trim() || null,
    }));
    sendMsg(player, r3.ok ? "§aแก้ไขแล้ว§r" : `§c${r3.message || "ไม่สำเร็จ"}`);
  } else if (r2.selection === 1) {
    const d = await bridgeCall(deps.postToBackend, "/bridge/phone/contacts/delete", actorBody(deps, persistentId, { contactId: c.id }));
    sendMsg(player, d.ok ? `§aลบ ${c.name} แล้ว§r` : `§c${d.message || "ไม่สำเร็จ"}`);
  }
}

// -------------------------------------------------------------- messages

async function renderMessagesMenu(player, deps, persistentId) {
  const form = new ActionFormData().title("§eข้อความ§r");
  form.button("§f📥 กล่องข้อความ (inbox)§r");
  form.button("§f📤 ส่งข้อความ§r");
  form.button("§f🕘 ที่ส่งออก (outbox)§r");
  form.button("§7Back§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (resp.selection === 0) await showInbox(player, deps, persistentId);
  else if (resp.selection === 1) await sendMessage(player, deps, persistentId);
  else if (resp.selection === 2) await showOutbox(player, deps, persistentId);
}

async function showInbox(player, deps, persistentId) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/phone/messages/inbox", actorBody(deps, persistentId, {}));
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "โหลดข้อความไม่สำเร็จ"}`);
    return;
  }
  const msgs = res.messages || [];
  if (msgs.length === 0) {
    sendMsg(player, "§7กล่องข้อความว่าง§r");
    return;
  }
  const lines = msgs.slice(0, 15).map((m) => `§f${m.fromName || "?"}§r §7${m.readAt ? "" : "●"}: ${m.body}`).join("\n");
  sendMsg(player, `§eกล่องข้อความ§r\n${lines}`);
}

async function showOutbox(player, deps, persistentId) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/phone/messages/outbox", actorBody(deps, persistentId, {}));
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "โหลดข้อความไม่สำเร็จ"}`);
    return;
  }
  const msgs = res.messages || [];
  if (msgs.length === 0) {
    sendMsg(player, "§7ยังไม่มีข้อความที่ส่งออก§r");
    return;
  }
  const lines = msgs.slice(0, 15).map((m) => `§7ถึง §f${m.toName || "?"}§r: ${m.body}`).join("\n");
  sendMsg(player, `§eที่ส่งออก§r\n${lines}`);
}

async function sendMessage(player, deps, persistentId) {
  const form = new ModalFormData()
    .title("ส่งข้อความ")
    .textField("เบอร์ปลายทาง", "0987654321")
    .textField("ข้อความ", "สวัสดี!");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const toNumber = String((resp.formValues || [])[0] || "").trim();
  const body = String((resp.formValues || [])[1] || "").trim();
  if (!toNumber || !body) {
    sendMsg(player, "§cต้องกรอกเบอร์และข้อความ");
    return;
  }
  const r = await bridgeCall(deps.postToBackend, "/bridge/phone/messages/send", actorBody(deps, persistentId, { toNumber, body }));
  sendMsg(player, r.ok ? "§aส่งแล้ว§r" : `§c${r.message || "ส่งไม่สำเร็จ"}`);
}

// -------------------------------------------------------------- calls

async function renderCalls(player, deps, persistentId) {
  const form = new ActionFormData().title("§6โทรศัพท์§r");
  form.button("§6📞 โทรออก§r");
  form.button("§f☎️ ประวัติสาย§r");
  form.button("§7Back§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (resp.selection === 0) await makeCall(player, deps, persistentId);
  else if (resp.selection === 1) await callHistory(player, deps, persistentId);
}

async function makeCall(player, deps, persistentId) {
  const form = new ModalFormData().title("โทรออก").textField("เบอร์ปลายทาง", "0987654321");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const toNumber = String((resp.formValues || [])[0] || "").trim();
  if (!toNumber) return;
  const r = await bridgeCall(deps.postToBackend, "/bridge/phone/calls/initiate", actorBody(deps, persistentId, { toNumber }));
  if (!r.ok) {
    sendMsg(player, `§c${r.message || "โทรไม่สำเร็จ"}`);
    return;
  }
  const c = r.call || {};
  if (c.status === "ringing") {
    sendMsg(player, `§6📞 กำลังเรียก... (รอรับสาย)§r`);
  } else if (c.status === "missed") {
    sendMsg(player, `§7คนปลายทางออฟไลน์ — บันทึกเป็นสสายพลาด (${c.missedReason || "offline"})§r`);
  } else {
    sendMsg(player, `§6สายสถานะ: ${c.status}§r`);
  }
}

async function callHistory(player, deps, persistentId) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/phone/calls/list", actorBody(deps, persistentId, {}));
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "โหลดประวัติไม่สำเร็จ"}`);
    return;
  }
  const calls = res.calls || [];
  if (calls.length === 0) {
    sendMsg(player, "§7ยังไม่มีประวัติสาย§r");
    return;
  }
  const lines = calls.slice(0, 12).map((c) => {
    const other = c.callerCharacterId === player.id ? (c.calleeName || "#" + c.calleeCharacterId) : (c.callerName || "#" + c.callerCharacterId);
    const dir = c.callerCharacterId === player.id ? "§7→" : "§e←";
    const st = c.status === "ringing" ? "§6ringing§r" : c.status === "connected" ? "§aconnected§r" : c.status === "ended" ? "§7ended§r" : "§cmissed§r";
    return `${dir} §f${other}§r ${st}`;
  }).join("\n");
  sendMsg(player, `§6ประวัติสาย§r\n${lines}`);
}

// -------------------------------------------------------------- bank

async function renderBank(player, deps, persistentId) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/phone/bank/state", { playerId: persistentId });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "โหลดบัญชีไม่สำเร็จ"}`);
    return;
  }
  const form = new ActionFormData()
    .title("§bธนาคาร§r")
    .body(
      `§7เงินสด:§r §f${money(res.data && res.data.balanceCents)}§r\n` +
        `§7ธนาคาร:§r §f${money(res.data && res.data.bankBalanceCents)}§r\n` +
        `§7เงินแดง:§r §f${money(res.data && res.data.redMoneyCents)}§r`
    );
  form.button("§e🔄 โอนเงิน (โทรศัพท์)§r");
  form.button("§7Back§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (resp.selection === 0) await bankTransfer(player, deps, persistentId);
}

async function bankTransfer(player, deps, persistentId) {
  const form = new ModalFormData()
    .title("โอนเงินผ่านโทรศัพท์")
    .textField("เบอร์ปลายทาง", "0987654321")
    .textField("จำนวน (สตางค์)", "50000")
    .dropdown("สกุลเงิน", ["cash", "bank", "red_money"], 0)
    .textField("หมายเหตุ (ว่างได้)", "โอนหนี้");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const toNumber = String((resp.formValues || [])[0] || "").trim();
  const amountCents = Number((resp.formValues || [])[1] || 0);
  const currency = ["cash", "bank", "red_money"][Number((resp.formValues || [])[2]) || 0];
  const reason = String((resp.formValues || [])[3] || "").trim();
  if (!toNumber || !Number.isFinite(amountCents) || amountCents <= 0) {
    sendMsg(player, "§cต้องกรอกเบอร์และจำนวนเงินที่ถูกต้อง");
    return;
  }
  const r = await bridgeCall(deps.postToBackend, "/bridge/phone/bank/transfer", actorBody(deps, persistentId, {
    toNumber, amountCents, currency, reason: reason || null,
  }));
  sendMsg(player, r.ok ? `§aโอน ${money(amountCents)} ${currency} ให้ ${r.transfer && r.transfer.toName} แล้ว§r` : `§c${r.message || "โอนไม่สำเร็จ"}`);
}

// -------------------------------------------------------------- GPS

async function renderGps(player, deps, persistentId) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/phone/gps/list", { playerId: persistentId });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "โหลด waypoint ไม่สำเร็จ"}`);
    return;
  }
  const list = res.waypoints || [];
  const form = new ActionFormData()
    .title("§a🧭 GPS§r")
    .body(list.length ? list.map((w) => `§f${w.name}§r §7(${w.x}, ${w.y}, ${w.z})§r`).join("\n") : "§7ยังไม่มี waypoint§r");
  form.button("§a➕ เพิ่ม waypoint (ตำแหน่งปัจจุบัน)§r");
  if (list.length) form.button("§4🗑️ ลบ waypoint§r");
  form.button("§7Back§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (resp.selection === 0) {
    const m = new ModalFormData().title("เพิ่ม waypoint").textField("ชื่อ", "เช่น บ้าน");
    const mr = await showOnMainThread(player, m);
    if (mr.canceled) return;
    const name = String((mr.formValues || [])[0] || "").trim();
    if (!name) return;
    const pos = player.location;
    const dim = player.dimension && player.dimension.id ? player.dimension.id : "overworld";
    const r = await bridgeCall(deps.postToBackend, "/bridge/phone/gps/add", actorBody(deps, persistentId, {
      name, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dimensionId: dim,
    }));
    sendMsg(player, r.ok ? `§aบันทึก ${name} แล้ว§r` : `§c${r.message || "ไม่สำเร็จ"}`);
  } else if (list.length && resp.selection === 1) {
    const pick = new ActionFormData().title("เลือกลบ waypoint");
    list.forEach((w) => pick.button(w.name));
    const pr = await showOnMainThread(player, pick);
    if (pr.canceled || pr.selection >= list.length) return;
    const d = await bridgeCall(deps.postToBackend, "/bridge/phone/gps/delete", actorBody(deps, persistentId, { waypointId: list[pr.selection].id }));
    sendMsg(player, d.ok ? "§aลบแล้ว§r" : `§c${d.message || "ไม่สำเร็จ"}`);
  }
}

// -------------------------------------------------------------- taxi

async function renderTaxi(player, deps, persistentId, roles) {
  const form = new ActionFormData().title("§5🚕 แท็กซี่§r");
  form.button("§a📞 เรียกแท็กซี่ (my trip)§r");
  if (roles.canTaxiManage) form.button("§b📋 งานว่าง (driver board)§r");
  form.button("§7Back§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (resp.selection === 0) await taxiRider(player, deps, persistentId);
  else if (roles.canTaxiManage && resp.selection === 1) await taxiBoard(player, deps, persistentId, roles);
}

async function taxiRider(player, deps, persistentId) {
  const mine = await bridgeCall(deps.postToBackend, "/bridge/phone/taxi/mine", { playerId: persistentId });
  const mineList = (mine.ok ? mine.requests || [] : []).filter((t) => t.status === "pending" || t.status === "accepted");
  const form = new ActionFormData().title("เรียกแท็กซี่").body(mineList.length
    ? mineList.map((t) => `§e#${t.id} ${money(t.fareCents)} §7→ §r${t.destination} §7(${t.status})§r`).join("\n")
    : "§7ไม่มีทริปที่ยังใช้งาน§r");
  form.button("§a🆕 เรียกใหม่§r");
  if (mineList.length) form.button("§4🚫 ยกเลิกทริป§r");
  form.button("§7Back§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (resp.selection === 0) {
    const m = new ModalFormData().title("เรียกแท็กซี่")
      .textField("จุดหมายปลายทาง", "เช่น สนามบิน")
      .textField("ค่าโดยสาร (สตางค์)", "50000")
      .dropdown("สกุลเงิน", ["cash", "bank", "red_money"], 0);
    const mr = await showOnMainThread(player, m);
    if (mr.canceled) return;
    const destination = String((mr.formValues || [])[0] || "").trim();
    const fareCents = Number((mr.formValues || [])[1] || 0);
    const currency = ["cash", "bank", "red_money"][Number((mr.formValues || [])[2]) || 0];
    if (!destination || !Number.isFinite(fareCents) || fareCents <= 0) {
      sendMsg(player, "§cต้องกรอกปลายทางและค่าโดยสารที่ถูกต้อง");
      return;
    }
    const pos = player.location;
    const dim = player.dimension && player.dimension.id ? player.dimension.id : "overworld";
    const r = await bridgeCall(deps.postToBackend, "/bridge/phone/taxi/request", actorBody(deps, persistentId, {
      x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dimensionId: dim,
      destination, fareCents, currency,
    }));
    sendMsg(player, r.ok ? `§aประกาศทริป #${r.taxiRequest && r.taxiRequest.id} แล้ว ($ ${money(fareCents)} ${currency})` : `§c${r.message || "ไม่สำเร็จ"}`);
  } else if (mineList.length && resp.selection === 1) {
    const pick = new ActionFormData().title("เลือกทริปที่จะยกเลิก");
    mineList.forEach((t) => pick.button(`#${t.id} → ${t.destination}`));
    const pr = await showOnMainThread(player, pick);
    if (pr.canceled || pr.selection >= mineList.length) return;
    const d = await bridgeCall(deps.postToBackend, "/bridge/phone/taxi/cancel", actorBody(deps, persistentId, { taxiRequestId: mineList[pr.selection].id }));
    sendMsg(player, d.ok ? "§aยกเลิกแล้ว§r" : `§c${d.message || "ยกเลิกไม่ได้"}`);
  }
}

async function taxiBoard(player, deps, persistentId) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/phone/taxi/list", { playerId: persistentId });
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "โหลดบอร์ดไม่สำเร็จ"}`);
    return;
  }
  const pending = (res.requests || []).filter((t) => t.status === "pending");
  const mine = (res.requests || []).filter((t) => t.status === "accepted" && t.driverCharacterId === player.id);
  const form = new ActionFormData().title("§bงานแท็กซี่ว่าง§r").body(pending.length
    ? pending.map((t) => `§e#${t.id} ${money(t.fareCents)} → §r${t.destination} §7(${t.requesterName || ""})§r`).join("\n")
    : "§7ไม่มีงานว่าง§r");
  if (pending.length) form.button("§a✅ รับงาน§r");
  if (mine.length) form.button("§e🏁 ทำงานเสร็จ (รับเงิน)§r");
  form.button("§7Back§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (pending.length && resp.selection === 0) {
    const pick = new ActionFormData().title("เลือกงาน");
    pending.forEach((t) => pick.button(`#${t.id} → ${t.destination}`));
    const pr = await showOnMainThread(player, pick);
    if (pr.canceled || pr.selection >= pending.length) return;
    const a = await bridgeCall(deps.postToBackend, "/bridge/phone/taxi/accept", actorBody(deps, persistentId, { taxiRequestId: pending[pr.selection].id }));
    sendMsg(player, a.ok ? `§aรับงาน #${pending[pr.selection].id} แล้ว` : `§c${a.message || "รับไม่ได้"}`);
  } else if (mine.length && resp.selection === (pending.length ? 1 : 0)) {
    const pick = new ActionFormData().title("ทำงานเสร็จ");
    mine.forEach((t) => pick.button(`#${t.id} → ${t.destination} (§e${money(t.fareCents)} ${t.currency}§r)`));
    const pr = await showOnMainThread(player, pick);
    if (pr.canceled || pr.selection >= mine.length) return;
    const c = await bridgeCall(deps.postToBackend, "/bridge/phone/taxi/complete", actorBody(deps, persistentId, { taxiRequestId: mine[pr.selection].id }));
    sendMsg(player, c.ok ? `§aทริป #${mine[pr.selection].id} เสร็จ — รับเงิน ${money(mine[pr.selection].fareCents)} ${mine[pr.selection].currency}§r` : `§c${c.message || "ไม่สำเร็จ"}`);
  }
}

// -------------------------------------------------------------- emergency

async function renderEmergency(player, deps, persistentId, roles) {
  const form = new ActionFormData().title("§4🆘 เหตุฉุกเฉิน§r");
  form.button("§4☎️ แจ้งเหตุฉุกเฉิน§r");
  form.button("§f📋 สายที่แจ้ง (ของฉัน)§r");
  if (roles.canEmergencyView || roles.canEmergencyManage) form.button("§b🚨 บอร์ดสาย (dispatch)§r");
  form.button("§7Back§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (resp.selection === 0) await emergencyCreate(player, deps, persistentId);
  else if (resp.selection === 1) await emergencyOwn(player, deps, persistentId);
  else if ((roles.canEmergencyView || roles.canEmergencyManage) && resp.selection === 2) await emergencyDispatch(player, deps, persistentId, roles);
}

async function emergencyCreate(player, deps, persistentId) {
  const form = new ModalFormData()
    .title("แจ้งเหตุฉุกเฉิน")
    .dropdown("ประเภท", ["police", "ems", "fire", "general"], 0)
    .textField("เรื่อง", "เช่น รถชนหน้าเซเว่น");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  const category = ["police", "ems", "fire", "general"][Number((resp.formValues || [])[0]) || 0];
  const subject = String((resp.formValues || [])[1] || "").trim();
  if (!subject) {
    sendMsg(player, "§cต้องกรอกเรื่อง");
    return;
  }
  const pos = player.location;
  const dim = player.dimension && player.dimension.id ? player.dimension.id : "overworld";
  const r = await bridgeCall(deps.postToBackend, "/bridge/phone/emergency/create", actorBody(deps, persistentId, {
    category, subject, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dimensionId: dim,
  }));
  sendMsg(player, r.ok ? `§aแจ้งเหตุแล้ว (#${r.call && r.call.id}) — เจ้าหน้าที่จะติดต่อกลับ§r` : `§c${r.message || "ไม่สำเร็จ"}`);
}

async function emergencyOwn(player, deps, persistentId) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/phone/emergency/list", actorBody(deps, persistentId, {}));
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "โหลดไม่สำเร็จ"}`);
    return;
  }
  const calls = res.calls || [];
  if (calls.length === 0) {
    sendMsg(player, "§7ยังไม่เคยแจ้งเหตุ§r");
    return;
  }
  const lines = calls.slice(0, 10).map((c) => `#${c.id} ${c.category} §7${c.subject}§r §8(${c.status})§r`).join("\n");
  sendMsg(player, `§4สายของคุณ§r\n${lines}`);
}

async function emergencyDispatch(player, deps, persistentId, roles) {
  const res = await bridgeCall(deps.postToBackend, "/bridge/phone/emergency/list", actorBody(deps, persistentId, {}));
  if (!res.ok) {
    sendMsg(player, `§c${res.message || "โหลดบอร์ดไม่สำเร็จ"}`);
    return;
  }
  const open = (res.calls || []).filter((c) => c.status !== "closed");
  const form = new ActionFormData().title("§b🚨 บอร์ดสายเหตุฉุกเฉิน§r").body(open.length
    ? open.map((c) => `#${c.id} §f${c.callerName || ""}§r §7${c.category}§r — ${c.subject} §8(${c.status})§r`).join("\n")
    : "§7ไม่มีสายที่ยังค้างอยู่§r");
  form.button("§7⟲ Reload§r");
  if (roles.canEmergencyManage && open.length) form.button("§4📝 ปิดสาย (respond)§r");
  form.button("§7Back§r");
  const resp = await showOnMainThread(player, form);
  if (resp.canceled) return;
  if (!open.length && resp.selection === 1) return; // only close behaves
  if (roles.canEmergencyManage && open.length && resp.selection === (1)) {
    const pick = new ActionFormData().title("เลือกสายที่จะปิด");
    open.forEach((c) => pick.button(`#${c.id} ${c.callerName || ""} — ${c.subject}`));
    const pr = await showOnMainThread(player, pick);
    if (pr.canceled || pr.selection >= open.length) return;
    const r = await bridgeCall(deps.postToBackend, "/bridge/phone/emergency/close", actorBody(deps, persistentId, { callId: open[pr.selection].id }));
    sendMsg(player, r.ok ? `§aปิดสาย #${open[pr.selection].id} แล้ว§r` : `§c${r.message || "ไม่สำเร็จ"}`);
  }
}

// -------------------------------------------------------------- business (placeholder)

async function renderBusiness(player) {
  sendMsg(player, "§8🏢 แอปธุรกิจ: ยังอยู่ในช่วงพัฒนา — ใน v1 ใช้ร้านค้า /property ในเกม (เปิดด้วย !house)§r");
}

export function tryOpenPhoneUi(message, player, deps) {
  if (!deps.isConfigured()) return false;
  const lower = message.trim().toLowerCase();
  for (const trigger of TRIGGERS) {
    if (lower === trigger) {
      openPhoneUi(player, deps);
      return true;
    }
  }
  return false;
}