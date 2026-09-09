import { Router } from "express";
import { config } from "../config/index.js";

/**
 * Player-facing web ("Player Web" in MASTER_PROMPT §6 architecture). A
 * small self-contained SPA served straight from Express — no static files,
 * no build step, so it survives the tsc/dist Docker layout unchanged.
 *
 * Security: the global middleware sets `Content-Security-Policy: default-src
 * 'none'`, which would block everything here. These routes intentionally
 * override that ONE header with a same-origin-only policy (external JS/CSS
 * served by this router, no inline scripts/styles, fetch to same origin
 * only). Nothing else leaks.
 *
 * The page only reads existing session-authenticated JSON routes
 * (/character, /character/link-code, /character/wallet,
 * /character/inventory, /inventories...) — no new data surface is added.
 */

export const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; " +
  "form-action 'self'; frame-ancestors 'none'";

// The Discord OAuth callback only accepts the exact host registered as
// DISCORD_REDIRECT_URI (cookies are host-bound, so `/player` on 127.0.0.1
// would mint a state cookie the callback at localhost never receives). Bake
// that canonical origin into the page and have the app JS auto-jump to it,
// so whatever loopback/alt host the user types, the login cookie matches.
const CANONICAL_ORIGIN = config.DISCORD_REDIRECT_URI
  ? new URL(config.DISCORD_REDIRECT_URI).origin
  : "";

const INDEX_HTML = (origin: string) => `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="rp:origin" content="${origin}">
<title>RP Bedrock — Player Panel</title>
<link rel="stylesheet" href="/player/app.css">
</head>
<body>
<main id="app">
  <div id="boot" class="card center"><p>กำลังโหลด…</p></div>
</main>
<script src="/player/app.js"></script>
</body>
</html>
`;

const APP_CSS = `
* { box-sizing: border-box; }
body {  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background: #101317; color: #e6e6e6; margin: 0; padding: 24px; }
h1 { font-size: 20px; margin: 0 0 16px; }
h2 { font-size: 16px; margin: 0 0 10px; color: #9fd0ff; }
main { max-width: 920px; margin: 0 auto; }
.card { background: #1a1f26; border: 1px solid #2a313a; border-radius: 10px;
  padding: 18px; margin-bottom: 16px; }
.center { text-align: center; }
.btn { display: inline-block; background: #3b82f6; color: #fff; border: 0;
  padding: 9px 16px; border-radius: 8px; cursor: pointer; font-size: 14px; }
.btn.secondary { background: #374151; }
.btn:disabled { opacity: .5; cursor: default; }
input { width: 100%; max-width: 340px; padding: 9px 10px; border-radius: 8px;
  border: 1px solid #3a424d; background: #11151a; color: #eee; margin-bottom: 10px; }
a { color: #7fb3ff; }
.tag { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
.tag.ok { background: #14532d; color: #86efac; }
.tag.warn { background: #7c2d12; color: #fdba74; }
.tag.neutral { background: #374151; color: #cbd5e1; }
.muted { color: #9aa4b0; font-size: 13px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 6px; border-bottom: 1px solid #242b34; }
th { color: #9aa4b0; font-weight: 500; }
.code { font-family: ui-monospace, monospace; font-size: 22px; letter-spacing: 3px;
  background: #0b0f13; border: 1px dashed #3f4a58; border-radius: 8px;
  padding: 12px; margin: 10px 0; text-align: center; }
.err { color: #f87171; }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
`;

// NOTE: written without template literals on purpose (this whole blob is one
// backtick string in TS) — string concatenation only.
const APP_JS = `
(function () {
  "use strict";
  var app = document.getElementById("app");

  var canonical = document.querySelector("meta[name=\\"rp:origin\\"]");
  if (canonical && canonical.content && location.origin !== canonical.content) {
    location.replace(canonical.content + location.pathname + location.search);
    return;
  }

  function el(html) {
    var d = document.createElement("div");
    d.innerHTML = html;
    return d.firstElementChild;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function money(c) { return "฿" + (Number(c || 0) / 100).toFixed(2); }
  function weight(g) {
    g = Number(g || 0);
    return g >= 1000 ? (g / 1000).toFixed(1) + " kg" : g + " g";
  }
  function fmtDate(s) {
    if (!s) return "-";
    var d = new Date(s);
    return isNaN(d) ? "-" : d.toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
  }
  function setApp(node) { app.innerHTML = ""; app.appendChild(node); }
  function showErr(el, msg) { el.textContent = msg || ""; }

  async function api(path, opts) {
    var res = await fetch(path, Object.assign({ credentials: "same-origin" }, opts || {}));
    var ct = res.headers.get("content-type") || "";
    var data = ct.indexOf("json") >= 0 ? await res.json() : null;
    return { ok: res.ok, status: res.status, data: data };
  }

  function loginScreen() {
    setApp(el(
      '<div class="card center"><h1>🧭 RP Bedrock</h1>' +
      '<p class="muted">ล็อกอินด้วย Discord เพื่อจัดการตัวละครของคุณ</p>' +
      '<a class="btn" href="/auth/discord/login">Login with Discord</a></div>'
    ));
  }

  function createScreen() {
    var box = el(
      '<div class="card"><h1>สร้างตัวละคร</h1>' +
      '<p class="muted">คุณยังไม่มีตัวละคร — ตั้งชื่อได้เลย (1 Discord = 1 ตัวละคร)</p>' +
      '<form id="create-form"><input id="name" maxlength="32" required placeholder="ชื่อตัวละคร">' +
      '<div><button class="btn" type="submit">สร้างตัวละคร</button></div></form>' +
      '<p id="cerr" class="err"></p></div>'
    );
    box.querySelector("#create-form").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var name = box.querySelector("#name").value.trim();
      var r = await api("/character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name }),
      });
      if (r.ok) { location.reload(); } else { showErr(box.querySelector("#cerr"), (r.data && r.data.error) || "สร้างไม่สำเร็จ"); }
    });
    setApp(box);
  }

  function renderDashboard(character) {
    var linkedTag = character.linked
      ? '<span class="tag ok">เชื่อมต่อแล้ว</span>'
      : '<span class="tag warn">ยังไม่เชื่อมต่อ</span>';
    var whitelistedTag = character.whitelisted
      ? '<span class="tag ok">whitelisted</span>'
      : '<span class="tag neutral">still pending</span>';
    var header = el(
      '<div class="row"><h1>ตัวละคร: ' + esc(character.name) + '</h1>' +
      '<span class="spacer"></span>' +
      '<button id="logout" class="btn secondary">ออกจากระบบ</button></div>'
    );
    header.querySelector("#logout").addEventListener("click", async function () {
      await api("/auth/logout", { method: "POST" });
      location.reload();
    });

    var characterCard = (
      '<div class="card"><h2>ตัวละคร</h2>' +
      '<div class="row"><strong>' + esc(character.name) + '</strong>' + linkedTag + whitelistedTag + '</div>' +
      '<p class="muted">สร้าง: ' + fmtDate(character.createdAt) +
      ' · เข้าครั้งล่าสุด: ' + fmtDate(character.lastSeenAt) + '</p>' +
      '<div id="link-area"></div></div>'
    );

    var page = el('<div></div>');
    page.appendChild(header);
    page.appendChild(el(characterCard));
    page.appendChild(el('<div id="wallet-card" class="card"><h2>กระเป๋าเงิน</h2><p class="muted">กำลังโหลด…</p></div>'));
    page.appendChild(el('<div id="carry-card" class="card"><h2>ของที่ถือ</h2><p class="muted">กำลังโหลด…</p></div>'));
    page.appendChild(el('<div id="container-card" class="card"><h2>ตู้เก็บของ</h2><p class="muted">กำลังโหลด…</p></div>'));
    page.appendChild(el('<div id="garage-card" class="card"><h2>อู่ของคุณ</h2><p class="muted">กำลังโหลด…</p></div>'));
    page.appendChild(el('<div id="property-card" class="card"><h2>อสังหาริมทรัพย์</h2><p class="muted">กำลังโหลด…</p></div>'));
    setApp(page);

    // link-code area
    var linkArea = page.querySelector("#link-area");
    if (character.linked) {
      linkArea.innerHTML = '<p class="tag ok">บัญชีเชื่อมต่อกับเกมแล้ว — เปิดกระเป๋าในเกมได้เลย</p>';
    } else {
      linkArea.innerHTML =
        '<button id="gencode" class="btn">สร้าง Link Code</button>' +
        '<p class="muted">โค้ดไว้พิมพ์ในเกม: <code>!link &lt;code&gt;</code> หรือใช้ฟอร์มที่เด้งตอนเข้าเซิฟ</p>' +
        '<div id="codebox"></div><p id="lckerr" class="err"></p>';
      linkArea.querySelector("#gencode").addEventListener("click", async function () {
        var b = linkArea.querySelector("#gencode");
        b.disabled = true;
        var r = await api("/character/link-code", { method: "POST" });
        b.disabled = false;
        if (r.ok && r.data && r.data.code) {
          var expires = new Date(r.data.expiresAt);
          linkArea.querySelector("#codebox").innerHTML =
            '<div class="code">' + esc(r.data.code) + '</div>' +
            '<p class="muted">หมดอายุ: ' + fmtDate(r.data.expiresAt) +
            ' · พิมพ์ ' + esc("!link " + r.data.code) + ' ในเกม</p>';
        } else {
          showErr(linkArea.querySelector("#lckerr"), (r.data && r.data.error) || "สร้างโค้ดไม่สำเร็จ");
          if (r.status === 409) { location.reload(); }
        }
      });
    }

    // wallet + carry + containers + garage + properties (parallel)
    Promise.all([
      api("/character/wallet"),
      api("/character/inventory"),
      api("/inventories"),
      api("/character/vehicles"),
      api("/character/properties"),
    ]).then(function (results) {
      var wallet = results[0], inv = results[1], containers = results[2], garage = results[3], properties = results[4];
      renderWallet(page.querySelector("#wallet-card"), wallet);
      renderCarry(page.querySelector("#carry-card"), inv);
      renderContainers(page.querySelector("#container-card"), containers, page);
      renderGarage(page.querySelector("#garage-card"), garage);
      renderProperties(page.querySelector("#property-card"), properties);
    });
  }

  function renderWallet(card, wallet) {
    if (!wallet.ok) { card.innerHTML = '<h2>กระเป๋าเงิน</h2><p class="muted">' + esc((wallet.data && wallet.data.error) || "ไม่พร้อมใช้งาน") + '</p>'; return; }
    var d = wallet.data;
    var rows = (d.transactions || []).map(function (t) {
      var sign = Number(t.amount_cents) >= 0 ? "+" : "";
      return "<tr><td>" + esc(t.reason || "-") + "</td><td>" +
        esc(t.ref_type || "-") + "</td><td class=\\"muted\\">" + fmtDate(t.created_at) +
        "</td><td>" + sign + money(t.amount_cents) + "</td></tr>";
    }).join("");
    card.innerHTML =
      '<h2>กระเป๋าเงิน</h2>' +
      '<p>ยอดเงินสด: <strong>' + money(d.balanceCents) + '</strong></p>' +
      (rows ? "<table><tr><th>เหตุผล</th><th>แหล่ง</th><th>เวลา</th><th>ยอด</th></tr>" + rows + "</table>"
        : '<p class="muted">ยังไม่มีรายการ</p>');
  }

  function renderCarry(card, inv) {
    if (!inv.ok) { card.innerHTML = '<h2>ของที่ถือ</h2><p class="muted">' + esc((inv.data && inv.data.error) || "ไม่พร้อมใช้งาน") + '</p>'; return; }
    var items = inv.data.items || [];
    var total = items.reduce(function (s, it) { return s + Number(it.quantity) * Number(it.weight_g); }, 0);
    var rows = items.map(function (it) {
      var meta = it.item_metadata && Object.keys(it.item_metadata).length ? " (meta)" : "";
      return "<tr><td>" + esc(it.display_name) + meta + "</td><td>x" + esc(it.quantity) +
        "</td><td>" + esc(String(it.item_id)) + "</td><td>" + weight(it.quantity * it.weight_g) + "</td></tr>";
    }).join("");
    card.innerHTML =
      '<h2>ของที่ถือ</h2><p class="muted">รวมน้ำหนัก: ' + weight(total) + '</p>' +
      (rows ? "<table><tr><th>รายการ</th><th>จำนวน</th><th>ID</th><th>น้ำหนัก</th></tr>" + rows + "</table>"
        : '<p class="muted">ยังไม่มีของ</p>');
  }

  function renderContainers(card, containers) {
    if (!containers.ok) { card.innerHTML = '<h2>ตู้เก็บของ</h2><p class="muted">' + esc((containers.data && containers.data.error) || "ไม่พร้อมใช้งาน") + '</p>'; return; }
    var list = containers.data.inventories || [];
    if (list.length === 0) {
      card.innerHTML = '<h2>ตู้เก็บของ</h2><p class="muted">ยังไม่มีตู้เก็บของ</p>';
      return;
    }
    card.innerHTML = '<h2>ตู้เก็บของ</h2>';
    list.forEach(function (c) {
      card.appendChild(el(
        '<div class="card"><div class="row"><strong>' + esc(c.label || c.storage_type) + '</strong>' +
        '<span class="tag neutral">' + esc(c.storage_type) + '</span></div>' +
        '<p id="cont-' + c.id + '" class="muted">กำลังโหลด…</p></div>'
      ));
      api("/inventories/" + c.id).then(function (det) {
        var box = card.querySelector("#cont-" + c.id);
        if (!det.ok || !det.data) { box.textContent = (det.data && det.data.error) || "ไม่สามารถโหลดได้"; return; }
        var d = det.data;
        var rows = (d.items || []).map(function (it) {
          return "<tr><td>" + esc(it.display_name) + "</td><td>x" + esc(it.quantity) +
            "</td><td>" + weight(it.quantity * it.weight_g) + "</td></tr>";
        }).join("");
        box.innerHTML = '<span class="muted">' + weight(d.usedWeightG) + " / " + weight(d.capacity_weight_g) + "</span>" +
          (rows ? "<table><tr><th>รายการ</th><th>จำนวน</th><th>น้ำหนัก</th></tr>" + rows + "</table>"
            : '<div class="muted">ว่างเปล่า</div>');
      });
    });
  }

  function renderGarage(card, garage) {
    if (!garage.ok) { card.innerHTML = '<h2>อู่ของคุณ</h2><p class="muted">' + esc((garage.data && garage.data.error) || "ไม่พร้อมใช้งาน") + '</p>'; return; }
    var d = garage.data;
    var rows = (d.vehicles || []).map(function (v) {
      return "<tr><td><strong>" + esc(v.plate) + "</strong></td>" +
        "<td>" + esc(v.entityType) + "</td>" +
        "<td>" + esc(v.status) + (v.locked ? " · 🔒" : "") + "</td>" +
        "<td>" + Number(v.fuelLevel).toFixed(0) + "%</td>" +
        "<td>" + Number(v.bodyDamage).toFixed(0) + "</td>" +
        "<td>" + (v.salePriceCents != null ? money(v.salePriceCents) + " " + esc(v.saleCurrency) : "—") + "</td></tr>";
    }).join("");
    card.innerHTML =
      '<h2>อู่ของคุณ</h2><p class="muted">ที่จอด: ' + esc(String(d.vehicleCount)) + " / " + esc(String(d.garageCapacity)) + "</p>" +
      (rows ? "<table><tr><th>ป้าย</th><th>ชนิด</th><th>สถานะ</th><th>น้ำมัน</th><th>ความเสียหาย</th><th>ราคาขาย</th></tr>" + rows + "</table>"
        : '<p class="muted">ยังไม่มีรถ — ไปซื้อที่โชว์รูมในเกมได้เลย</p>');
  }

  function renderProperties(card, props) {
    if (!props.ok) { card.innerHTML = '<h2>อสังหาริมทรัพย์</h2><p class="muted">' + esc((props.data && props.data.error) || "ไม่พร้อมใช้งาน") + '</p>'; return; }
    var d = props.data;
    var owned = (d.properties || []).filter(function (p) { return p.status !== "seized"; });
    var rows = owned.map(function (p) {
      return "<tr><td><strong>" + esc(p.address) + "</strong></td>" +
        "<td>" + esc(p.propertyType) + "</td>" +
        "<td class=\\"muted\\">🏠 " + esc(String(p.garageCapacity)) + " ที่จอด</td>" +
        "<td>" + (p.salePriceCents != null ? money(p.salePriceCents) + " " + esc(p.saleCurrency) : "—") + "</td></tr>";
    }).join("");
    var keys = (d.keys || []).map(function (p) {
      return "<tr><td><strong>" + esc(p.address) + "</strong></td><td>🔑 ถือกุญแจ</td>" +
        "<td class=\\"muted\\">" + esc(p.propertyType) + "</td><td>—</td></tr>";
    }).join("");
    card.innerHTML =
      '<h2>อสังหาริมทรัพย์</h2>' +
      '<p class="muted">ที่จอดรวม: ' + esc(String(d.garageCapacity)) + " ][ จำนวน: " + esc(String(d.propertyCount || 0)) + '</p>' +
      (rows ? "<table><tr><th>ที่อยู่</th><th>ประเภท</th><th>อู่</th><th>ราคาขาย</th></tr>" + rows + "</table>"
        : '<p class="muted">ยังไม่มีอสังหาริมทรัพย์ — เปิด ' + esc("!house") + ' ในเกมเพื่อซื้อ</p>');
    if (keys) {
      card.appendChild(el('<h3>🔑 กุญแจที่ถือ</h3>' + "<table><tr><th>ที่อยู่</th><th>สถานะ</th><th>ประเภท</th><th>ราคาขาย</th></tr>" + keys + "</table>"));
    }
  }

  async function boot() {
    var me = await api("/character");
    if (me.status === 401) { loginScreen(); return; }
    if (me.status === 404) { createScreen(); return; }
    if (!me.ok) { setApp(el("<div class=\\"card center\\"><h1>Error</h1><p class=\\"err\\">" + esc((me.data && me.data.error) || "failure") + "</p></div>")); return; }
    renderDashboard(me.data);
  }

  boot();
})();
`;

export const playerWebRouter = Router();

playerWebRouter.get("/", (_req, res) => {
  res.setHeader("Content-Security-Policy", WEB_CSP);
  res.type("html").send(INDEX_HTML(CANONICAL_ORIGIN));
});

playerWebRouter.get("/app.css", (_req, res) => {
  res.setHeader("Content-Security-Policy", WEB_CSP);
  res.type("css").send(APP_CSS);
});

playerWebRouter.get("/app.js", (_req, res) => {
  res.setHeader("Content-Security-Policy", WEB_CSP);
  res.type("js").send(APP_JS);
});