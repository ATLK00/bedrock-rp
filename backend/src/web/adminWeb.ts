import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "../config/index.js";
import { hasPermission } from "../rbac/index.js";
import { WEB_CSP } from "./playerWeb.js";

/**
 * Admin console (MASTER_PROMPT §22) — self-contained SPA served from the
 * backend, same pattern as the player panel (no static files, no build
 * step). Covers what the existing /admin/* JSON surface actually exposes:
 *
 *   - overview      online players + one-click retention/expiry sweep
 *   - users         searchable directory, view roles, ban / unban
 *   - characters    searchable directory, character profile, whitelist,
 *                   wallet summary + grant/deduct, inventory give/remove
 *   - shop          listing read / upsert / remove
 *   - cases         staff ticket list, detail, reply, status
 *   - audit         filterable audit log
 *   - security      security events + acknowledge
 *   - roles         role → permission matrix, grant / revoke for a user
 *
 * Auth: the page shell is served anonymously (static, no data, CSP-locked);
 * the app JS boots into a Discord-login screen when the first API call 401s.
 * Every data call re-runs the existing per-permission RBAC checks on the API
 * side, so the page never adds an authorization bypass. CSP override is
 * scoped to these routes only (same same-origin policy as the player panel).
 */

// Same-disk canonical-origin trick as the player panel: the Discord OAuth
// callback only accepts the exact host DISCORD_REDIRECT_URI registers
// (cookies are host-bound), so the panel auto-jumps to that origin if the
// user opened it via a different host (e.g. 127.0.0.1 vs localhost).
const CANONICAL_ORIGIN = config.DISCORD_REDIRECT_URI
  ? new URL(config.DISCORD_REDIRECT_URI).origin
  : "";

const INDEX_HTML = (origin: string) => `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="rp:origin" content="${origin}">
<title>RP Bedrock — Admin</title>
<link rel="stylesheet" href="/admin/app.css">
</head>
<body>
<main id="app">
  <div id="boot" class="card center"><p>กำลังโหลด…</p></div>
</main>
<script src="/admin/app.js"></script>
</body>
</html>
`;

const APP_CSS = `
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background: #0d1117; color: #e6edf3; margin: 0; padding: 20px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 15px; margin: 0 0 10px; color: #9fd0ff; }
main { max-width: 1080px; margin: 0 auto; }
.card { background: #161b22; border: 1px solid #262d36; border-radius: 10px;
  padding: 16px; margin-bottom: 14px; }
.center { text-align: center; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 14px 0; }
.tab { background: #21262d; color:#c9d1d9; border: 1px solid #30363d; border-radius: 8px;
  padding: 7px 13px; cursor: pointer; font-size: 13px; }
.tab.active { background: #1f6feb; color: #fff; border-color: #1f6feb; }
.btn { display: inline-block; background: #238636; color: #fff; border: 0;
  padding: 7px 13px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.btn.secondary { background: #30363d; }
.btn.danger { background: #da3633; }
.btn.primary { background: #1f6feb; }
.btn:disabled { opacity: .5; cursor: default; }
input, select, textarea { padding: 7px 9px; border-radius: 8px; border: 1px solid #30363d;
  background: #0d1117; color: #eee; font-size: 13px; }
textarea { width: 100%; min-height: 70px; }
input { max-width: 320px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 6px; border-bottom: 1px solid #21262d; vertical-align: top; }
th { color: #8b949e; font-weight: 500; }
tr.clickable { cursor: pointer; }
tr.clickable:hover td { background: #161d25; }
.tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; }
.tag.ok { background: #14532d; color: #86efac; }
.tag.warn { background: #7c2d12; color: #fdba74; }
.tag.neutral { background: #30363d; color: #c9d1d9; }
.muted { color: #8b949e; font-size: 13px; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
.err { color: #f85149; }
.ok { color: #3fb950; }
.toast { position: fixed; right: 16px; bottom: 16px; background: #161b22;
  border: 1px solid #30363d; border-radius: 8px; padding: 10px 14px; font-size: 13px;
  box-shadow: 0 4px 14px rgba(0,0,0,.4); z-index: 50; }
pre { background: #0d1117; border: 1px solid #262d36; border-radius: 8px;
  padding: 10px; font-size: 12px; overflow-x: auto; }
`;

// Written WITHOUT template literals on purpose (the whole blob is a single
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

  var TABS = ["overview", "users", "characters", "shop", "cases", "audit", "security", "roles", "vehicles", "properties", "police", "medical", "phone"];
  var LABELS = { overview: "ภาพรวม", users: "ผู้เล่น", characters: "ตัวละคร",
    shop: "ร้านค้า", cases: "เคส", audit: "Audit", security: "Security", roles: "Roles", vehicles: "รถยนต์",
    properties: "อสังหาริมทรัพย์", police: "ตำรวจ", medical: "EMS/การแพทย์", phone: "โทรศัพท์" };

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
  function money(c) { return (Number(c || 0) / 100).toFixed(2); }
  function fmtDate(s) {
    if (!s) return "-";
    var d = new Date(s);
    return isNaN(d) ? "-" : d.toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
  }
  function yesNo(v) { return v ? '<span class="tag ok">yes</span>' : '<span class="tag neutral">no</span>'; }
  function toast(msg) {
    var t = el("<div class=\\"toast\\">" + esc(msg) + "</div>");
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }
  function errBox(msg) { return "<p class=\\"err\\">" + esc(msg) + "</p>"; }

  async function api(path, opts) {
    var res = await fetch(path, Object.assign({ credentials: "same-origin" }, opts || {}));
    var ct = res.headers.get("content-type") || "";
    var data = ct.indexOf("json") >= 0 ? await res.json() : null;
    return { ok: res.ok, status: res.status, data: data };
  }
  async function postJSON(path, body) {
    return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }

  function logout() {
    api("/auth/logout", { method: "POST" }).then(function () { location.reload(); });
  }

  function renderShell() {
    var nav = TABS.map(function (t) {
      return "<button class=\\"tab\\" data-tab=\\"" + t + "\\">" + LABELS[t] + "</button>";
    }).join("");
    app.innerHTML =
      "<div class=\\"row\\"><h1>RP Bedrock — Admin</h1><span class=\\"spacer\\"></span>" +
      "<a class=\\"btn secondary\\" href=\\"/player\\">Player panel</a>" +
      "<button id=\\"logout\\" class=\\"btn secondary\\">ออกจากระบบ</button></div>" +
      "<nav class=\\"tabs\\">" + nav + "</nav>" +
      "<div id=\\"page\\"></div>";
    app.querySelector("#logout").addEventListener("click", logout);
    app.querySelectorAll(".tab").forEach(function (b) {
      b.addEventListener("click", function () { switchTab(b.getAttribute("data-tab")); });
    });
    switchTab("overview");
  }

  function switchTab(name) {
    app.querySelectorAll(".tab").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === name);
    });
    var page = app.querySelector("#page");
    page.innerHTML = "<div class=\\"card center\\"><p class=\\"muted\\">กำลังโหลด…</p></div>";
    var renderers = {
      overview: renderOverview, users: renderUsers, characters: renderCharacters,
      shop: renderShop, cases: renderCases, audit: renderAudit,
      security: renderSecurity, roles: renderRoles, vehicles: renderVehicles,
      properties: renderProperties, police: renderPolice,
      medical: renderMedical, phone: renderPhone,
    };
    renderers[name](page);
  }

  // ------------------------------------------------ overview
  function renderOverview(page) {
    page.innerHTML = "";
    api("/admin/presence/online").then(function (r) {
      var card = el("<div class=\\"card\\"><h2>ผู้เล่นออนไลน์</h2>" +
        (r.ok ? "<div id=\\"prows\\">" : errBox((r.data && r.data.error) || "failed")));
      var box = card.querySelector("#prows");
      if (box) {
        var rows = (r.data && r.data.online || []).map(function (p) {
          return "<tr><td>" + esc(p.characterName || p.characterId || p.persistentId) +
            "</td><td>" + esc(p.persistentId || "") + "</td><td>" + fmtDate(p.joinedAt) + "</td></tr>";
        }).join("");
        box.innerHTML = rows ? "<table><tr><th>ตัวละคร</th><th>persistentId</th><th>เข้าเมื่อ</th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่มีใครออนไลน์</p>";
      }
      page.appendChild(card);
    }).catch(function () { page.appendChild(el("<div class=\\"card\\">" + errBox("ล่ม") + "</div>")); });

    var ops = el(
      "<div class=\\"card\\"><h2>งานอัตโนมัติ (กดทริกเกอร์ทันที)</h2>" +
      "<div class=\\"row\\"><button id=\\"op-sess\\" class=\\"btn primary\\">ล้าง session ที่หมดอายุ</button>" +
      "<button id=\\"op-trade\\" class=\\"btn primary\\">บังคับ expire trade เก่า</button></div></div>"
    );
    ops.querySelector("#op-sess").addEventListener("click", function (b) {
      var btn = b.currentTarget; btn.disabled = true;
      postJSON("/admin/sessions/cleanup-check").then(function (r) {
        btn.disabled = false;
        toast("cleanedUpCount = " + (r.data && r.data.cleanedUpCount));
      });
    });
    ops.querySelector("#op-trade").addEventListener("click", function (b) {
      var btn = b.currentTarget; btn.disabled = true;
      postJSON("/admin/trades/expire-check").then(function (r) {
        btn.disabled = false;
        toast("expiredCount = " + (r.data && r.data.expiredCount));
      });
    });
    page.appendChild(ops);
  }

  // ------------------------------------------------ users
  function renderUsers(page) {
    page.innerHTML = "";
    var box = el(
      "<div class=\\"card\\"><h2>ผู้เล่น (Discord)</h2>" +
      "<div class=\\"row\\"><input id=\\"u-q\\" placeholder=\\"ค้นหา tag / discord_id / ชื่อตัวละคร\\">" +
      "<button id=\\"u-go\\" class=\\"btn primary\\">ค้นหา</button></div>" +
      "<div id=\\"u-res\\"></div></div>"
    );
    page.appendChild(box);
    function load() {
      var v = box.querySelector("#u-q").value.trim();
      var out = box.querySelector("#u-res");
      out.innerHTML = "<p class=\\"muted\\">กำลังโหลด…</p>";
      api("/admin/users" + (v ? "?query=" + encodeURIComponent(v) : "")).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && r.data.error) || "failed"); return; }
        var rows = (r.data.users || []).map(function (u) {
          return "<tr class=\\"clickable\\" data-id=\\"" + u.id + "\\">" +
            "<td>" + esc(u.id) + "</td>" +
            "<td>" + esc(u.discord_tag) + "</td>" +
            "<td>" + (u.roles || []).map(function (x) { return esc(x); }).join(", ") + "</td>" +
            "<td>" + esc(u.character_name || "-") + " " + (u.character_deleted ? '<span class="tag warn">DEL</span>' : "") + "</td>" +
            "<td>" + yesNo(u.is_banned) + "</td></tr>";
        }).join("");
        out.innerHTML = rows ? "<table><tr><th>id</th><th>Discord</th><th>Roles</th><th>ตัวละคร</th><th>Banned</th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่พบผู้เล่น</p>";
        out.querySelectorAll("tr.clickable").forEach(function (tr) {
          tr.addEventListener("click", function () { userDialog(Number(tr.getAttribute("data-id"))); });
        });
      });
    }
    box.querySelector("#u-go").addEventListener("click", load);
    box.querySelector("#u-q").addEventListener("keydown", function (e) { if (e.key === "Enter") load(); });
    load();
  }

  function userDialog(userId) {
    api("/admin/users/" + userId + "/roles").then(function (r) {
      var roles = r.ok ? (r.data.roles || []).join(", ") : "-";
      var msg = "User #" + userId + " roles: " + roles + "\\n\\n[1] grant   [2] revoke   [3] ban   [4] unban   [esc] ยกเลิก";
      var pick = window.prompt(msg, "1");
      if (pick === null) return;
      if (pick === "1" || pick === "2") {
        var roleName = window.prompt("role name:", "moderator");
        if (!roleName) return;
        postJSON("/admin/roles/" + (pick === "1" ? "grant" : "revoke"), { userId: userId, roleName: roleName }).then(function (resp) {
          resp.ok ? toast("ok: " + roleName) : toast((resp.data && resp.data.error) || "fail");
          renderUsers(app.querySelector("#page"));
        });
      } else if (pick === "3" || pick === "4") {
        if (pick === "3") {
          var reason = window.prompt("เหตุผลแบน:", "violation");
          if (!reason) return;
          postJSON("/admin/users/ban", { userId: userId, reason: reason }).then(function (resp) {
            resp.ok ? toast("แบนแล้ว") : toast((resp.data && resp.data.error) || "fail");
            renderUsers(app.querySelector("#page"));
          });
        } else {
          postJSON("/admin/users/unban", { userId: userId }).then(function (resp) {
            resp.ok ? toast("ยกเลิกแบนแล้ว") : toast((resp.data && resp.data.error) || "fail");
            renderUsers(app.querySelector("#page"));
          });
        }
      }
    });
  }

  // ------------------------------------------------ characters
  function renderCharacters(page) {
    page.innerHTML = "";
    var box = el(
      "<div class=\\"card\\"><h2>ตัวละคร</h2>" +
      "<div class=\\"row\\"><input id=\\"c-q\\" placeholder=\\"ค้นหา ชื่อ / tag / persistentId\\">" +
      "<button id=\\"c-go\\" class=\\"btn primary\\">ค้นหา</button></div>" +
      "<div id=\\"c-res\\"></div></div>"
    );
    page.appendChild(box);
    function load() {
      var v = box.querySelector("#c-q").value.trim();
      var out = box.querySelector("#c-res");
      out.innerHTML = "<p class=\\"muted\\">กำลังโหลด…</p>";
      api("/admin/characters" + (v ? "?query=" + encodeURIComponent(v) : "")).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && r.data.error) || "failed"); return; }
        var rows = (r.data.characters || []).map(function (c) {
          return "<tr class=\\"clickable\\" data-id=\\"" + c.id + "\\">" +
            "<td>" + esc(c.id) + "</td>" +
            "<td>" + esc(c.name) + "</td>" +
            "<td>" + esc(c.discord_tag || "-") + "</td>" +
            "<td>" + yesNo(c.whitelisted) + "</td>" +
            "<td>" + yesNo(!!c.persistent_id) + "</td>" +
            "<td>" + fmtDate(c.last_seen_at) + "</td></tr>";
        }).join("");
        out.innerHTML = rows ? "<table><tr><th>id</th><th>ชื่อ</th><th>Discord</th><th>Whitelist</th><th>เชื่อม</th><th>เข้าเมื่อ</th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่พบตัวละคร</p>";
        out.querySelectorAll("tr.clickable").forEach(function (tr) {
          tr.addEventListener("click", function () { characterDetail(app.querySelector("#page"), Number(tr.getAttribute("data-id"))); });
        });
      });
    }
    box.querySelector("#c-go").addEventListener("click", load);
    box.querySelector("#c-q").addEventListener("keydown", function (e) { if (e.key === "Enter") load(); });
    load();
  }

  function characterDetail(page, id) {
    var host = el("<div class=\\"card\\"><h2>ตัวละคร #" + id + "</h2><p class=\\"muted\\">กำลังโหลด…</p></div>");
    page.insertBefore(host, page.firstChild);
    Promise.all([api("/admin/character/" + id), api("/admin/economy/character/" + id)]).then(function (rs) {
      var c = rs[0], w = rs[1];
      if (!c.ok) { host.innerHTML = "<h2>ตัวละคร #" + id + "</h2>" + errBox((c.data && c.data.error) || "not found"); return; }
      var d = c.data;
      var wsum = "<span class=\\"muted\\">ไม่โหลดได้</span>";
      if (w.ok) {
        wsum = "<tr><th>เงินสด</th><th>ธนาคาร</th><th>Red Money</th></tr>" +
          "<tr><td>" + money(w.data.cashCents) + " ฿</td><td>" + money(w.data.bankCents) + " ฿</td><td>" + money(w.data.redMoneyCents) + " ฿</td></tr>";
      }
      var hist = "";
      if (w.ok && w.data.history && w.data.history.length) {
        hist = (w.data.history || []).map(function (t) {
          return "<tr><td>" + esc(t.currency || "-") + "</td><td>" + (Number(t.amount_cents) >= 0 ? "+" : "") + money(t.amount_cents) + "</td>" +
            "<td>" + esc(t.reason) + "</td><td>" + esc(t.ref_type || "-") + "</td><td>" + fmtDate(t.created_at) + "</td></tr>";
        }).join("");
      }
      host.innerHTML =
        "<h2>ตัวละคร #" + id + " — " + esc(d.name) + "</h2>" +
        "<div class=\\"row\\">" + yesNo(d.whitelisted) + " whitelisted · " +
        (d.persistent_id ? '<span class="tag ok">เชื่อมแล้ว</span>' : '<span class="tag warn">ยังไม่เชื่อม</span>') + " · " +
        (d.is_deleted ? '<span class="tag warn">ลบแล้ว</span>' : "") + "</div>" +
        "<p class=\\"muted\\">สร้าง: " + fmtDate(d.created_at) + " · เข้าล่าสุด: " + fmtDate(d.last_seen_at) +
        (d.nickname ? " · ชื่อเล่น: " + esc(d.nickname) : "") + "</p>" +
        "<div class=\\"row\\"><button id=\\"cd-wl\\" class=\\"btn primary\\">" + (d.whitelisted ? "ถอด whitelist" : "ให้ whitelist") + "</button></div>" +
        "<h3 class=\\"muted\\">กระเป๋า (summary)</h3><table>" + wsum + "</table>" +
        (hist ? "<h3 class=\\"muted\\">ประวัติล่าสุด</h3><table><tr><th>สกุล</th><th>ยอด</th><th>เหตุผล</th><th>แหล่ง</th><th>เวลา</th></tr>" + hist + "</table>" : "");
      host.querySelector("#cd-wl").addEventListener("click", function (btn) {
        var b = btn.currentTarget; b.disabled = true;
        postJSON("/admin/character/whitelist", { characterId: id, whitelisted: !d.whitelisted }).then(function (r) {
          r.ok ? toast("whitelist = " + !d.whitelisted) : toast((r.data && r.data.error) || "fail");
          characterDetail(page, id);
        });
      });

      // economy + inventory forms appended into same hosting card area
      var forms = el(
        "<div class=\\"card\\"><h2>จัดการเงิน / ของ</h2>" +
        "<div class=\\"row\\"><input id=\\"cc-amt\\" type=\\"number\\" placeholder=\\"จำนวน (สตางค์)\\">" +
        "<select id=\\"cc-cur\\"><option value=\\"cash\\">cash</option><option value=\\"bank\\">bank</option><option value=\\"red_money\\">red_money</option></select>" +
        "<input id=\\"cc-reason\\" placeholder=\\"เหตุผล\\">" +
        "<button id=\\"cc-grant\\" class=\\"btn\\" data-amt=\\"1\\">เติมเงิน</button>" +
        "<button id=\\"cc-deduct\\" class=\\"btn danger\\">หักเงิน</button></div>" +
        "<hr>" +
        "<div class=\\"row\\"><input id=\\"ci-id\\" placeholder=\\"itemId (rp:bandage)\\">" +
        "<input id=\\"ci-q\\" type=\\"number\\" value=\\"1\\">" +
        "<button id=\\"ci-give\\" class=\\"btn\\">ให้ของ</button>" +
        "<button id=\\"ci-rm\\" class=\\"btn danger\\">เอาของออก</button></div>" +
        "<p class=\\"err\\" id=\\"ce-msg\\"></p></div>"
      );
      function read(form) {
        return { characterId: id, currency: form.querySelector("#cc-cur").value };
      }
      forms.querySelector("#cc-grant").addEventListener("click", function () {
        var f = forms; var amt = Number(f.querySelector("#cc-amt").value); var rs = read(f);
        if (!amt || amt <= 0) { f.querySelector("#ce-msg").textContent = "จำนวนต้อง > 0"; return; }
        postJSON("/admin/economy/grant", { characterId: id, amountCents: amt, reason: f.querySelector("#cc-reason").value || "admin", currency: rs.currency }).then(function (r) {
          f.querySelector("#ce-msg").textContent = r.ok ? "" : ((r.data && r.data.error) || "fail");
          if (r.ok) toast("เติมแล้ว"); characterDetail(page, id);
        });
      });
      forms.querySelector("#cc-deduct").addEventListener("click", function () {
        var f = forms; var amt = Number(f.querySelector("#cc-amt").value); var rs = read(f);
        if (!amt || amt <= 0) { f.querySelector("#ce-msg").textContent = "จำนวนต้อง > 0"; return; }
        postJSON("/admin/economy/deduct", { characterId: id, amountCents: amt, reason: f.querySelector("#cc-reason").value || "admin", currency: rs.currency }).then(function (r) {
          f.querySelector("#ce-msg").textContent = r.ok ? "" : ((r.data && r.data.error) || "fail");
          if (r.ok) toast("หักแล้ว"); characterDetail(page, id);
        });
      });
      function itemCall(endpoint, btn) {
        var f = forms; var it = f.querySelector("#ci-id").value.trim(); var q = Number(f.querySelector("#ci-q").value);
        if (!it) { f.querySelector("#ce-msg").textContent = "ต้องระบุ itemId"; return; }
        btn.disabled = true;
        postJSON(endpoint, { characterId: id, itemId: it, quantity: q }).then(function (r) {
          btn.disabled = false;
          f.querySelector("#ce-msg").textContent = r.ok ? "" : ((r.data && r.data.error) || "fail");
          if (r.ok) toast("done");
        });
      }
      var gBtn = forms.querySelector("#ci-give"), rBtn = forms.querySelector("#ci-rm");
      forms.querySelector("#ci-give").addEventListener("click", function (e) { itemCall("/admin/inventory/give", e.currentTarget); });
      forms.querySelector("#ci-rm").addEventListener("click", function (e) { itemCall("/admin/inventory/remove", e.currentTarget); });
      page.insertBefore(forms, page.firstChild);
    });
  }

  // ------------------------------------------------ shop
  function renderShop(page) {
    var box = el(
      "<div class=\\"card\\"><h2>ร้านค้า (shop_listings)</h2>" +
      "<div class=\\"row\\"><input id=\\"s-id\\" placeholder=\\"itemId (rp:bandage)\\">" +
      "<button id=\\"s-load\\" class=\\"btn primary\\">โหลด listing</button></div>" +
      "<form id=\\"s-form\\" class=\\"row\\"><input id=\\"s-buy\\" placeholder=\\"buyPriceCents (v่าง = null)\\">" +
      "<input id=\\"s-sell\\" placeholder=\\"sellPriceCents\\">" +
      "<input id=\\"s-stock\\" placeholder=\\"stock (null = ∞)\\">" +
      "<button id=\\"s-save\\" class=\\"btn\\" type=\\"submit\\">บันทึก (upsert)</button>" +
      "<button id=\\"s-rm\\" class=\\"btn danger\\" type=\\"button\\">ลบ listing</button></form>" +
      "<p class=\\"err\\" id=\\"s-msg\\"></p></div>"
    );
    page.appendChild(box);
    function numOrNull(v) {
      if (v == null || String(v).trim() === "") return null;
      var n = Number(v); return isNaN(n) ? null : n;
    }
    box.querySelector("#s-load").addEventListener("click", function () {
      var it = box.querySelector("#s-id").value.trim();
      if (!it) { box.querySelector("#s-msg").textContent = "ต้องระบุ itemId"; return; }
      api("/admin/shop/listing/" + encodeURIComponent(it)).then(function (r) {
        var msg = box.querySelector("#s-msg");
        if (!r.ok) { msg.textContent = (r.data && r.data.error) || "no listing"; return; }
        msg.textContent = "";
        box.querySelector("#s-buy").value = r.data.buy_price_cents == null ? "" : r.data.buy_price_cents;
        box.querySelector("#s-sell").value = r.data.sell_price_cents == null ? "" : r.data.sell_price_cents;
        box.querySelector("#s-stock").value = r.data.stock == null ? "" : r.data.stock;
        toast("loaded " + it);
      });
    });
    box.querySelector("#s-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var it = box.querySelector("#s-id").value.trim();
      if (!it) { box.querySelector("#s-msg").textContent = "ต้องระบุ itemId"; return; }
      postJSON("/admin/shop/listing", {
        itemId: it,
        buyPriceCents: numOrNull(box.querySelector("#s-buy").value),
        sellPriceCents: numOrNull(box.querySelector("#s-sell").value),
        stock: numOrNull(box.querySelector("#s-stock").value),
      }).then(function (r) {
        var msg = box.querySelector("#s-msg");
        msg.textContent = r.ok ? "บันทึกแล้ว" : ((r.data && r.data.error) || "fail");
      });
    });
    box.querySelector("#s-rm").addEventListener("click", function () {
      var it = box.querySelector("#s-id").value.trim();
      if (!it) { box.querySelector("#s-msg").textContent = "ต้องระบุ itemId"; return; }
      if (!window.confirm("ลบ listing ของ " + it + " จริงไหม?")) return;
      postJSON("/admin/shop/listing/remove", { itemId: it }).then(function (r) {
        box.querySelector("#s-msg").textContent = r.ok ? "ลบแล้ว" : ((r.data && r.data.error) || "fail");
      });
    });
  }

  // ------------------------------------------------ cases
  function renderCases(page) {
    var box = el(
      "<div class=\\"card\\"><h2>เคส (tickets)</h2>" +
      "<div class=\\"row\\"><select id=\\"k-s\\"><option value=\\"\\">ทุกสถานะ</option>" +
      "<option>open</option><option>pending</option><option>resolved</option><option>closed</option></select>" +
      "<button id=\\"k-go\\" class=\\"btn primary\\">โหลด</button></div>" +
      "<div id=\\"k-res\\"></div></div>"
    );
    page.appendChild(box);
    function load() {
      var s = box.querySelector("#k-s").value;
      var out = box.querySelector("#k-res");
      out.innerHTML = "<p class=\\"muted\\">กำลังโหลด…</p>";
      api("/admin/cases" + (s ? "?status=" + encodeURIComponent(s) : "")).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && r.data.error) || "failed"); return; }
        var rows = (r.data.cases || []).map(function (c) {
          return "<tr class=\\"clickable\\" data-id=\\"" + c.id + "\\">" +
            "<td>" + esc(c.id) + "</td><td>" + esc(c.category || "-") + "</td>" +
            "<td>" + esc(c.subject) + "</td><td>" + esc(c.status) + "</td>" +
            "<td>" + esc(c.owner_discord_tag || "") + "</td><td>" + fmtDate(c.created_at) + "</td></tr>";
        }).join("");
        out.innerHTML = rows ? "<table><tr><th>id</th><th>ประเภท</th><th>เรื่อง</th><th>สถานะ</th><th>ผู้เปิด</th><th>เปิดเมื่อ</th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่มีเคส</p>";
        out.querySelectorAll("tr.clickable").forEach(function (tr) {
          tr.addEventListener("click", function () { caseDetail(page, Number(tr.getAttribute("data-id"))); });
        });
      });
    }
    box.querySelector("#k-go").addEventListener("click", load);
    load();
  }

  function caseDetail(page, id) {
    var host = el("<div class=\\"card\\" data-k=\\"" + id + "\\"><h2>เคส #" + id + "</h2><p class=\\"muted\\">กำลังโหลด…</p></div>");
    page.insertBefore(host, page.firstChild);
    api("/admin/cases/" + id).then(function (r) {
      if (!r.ok) { host.innerHTML = "<h2>เคส #" + id + "</h2>" + errBox((r.data && r.data.error) || "not found"); return; }
      var d = r.data;
      var msgs = (d.messages || []).map(function (m) {
        return "<div class=\\"row\\"><strong>" + esc(m.author || "staff") + "</strong><span class=\\"muted\\">" + fmtDate(m.created_at) + "</span></div>" +
          "<p>" + esc(m.body) + "</p><hr>";
      }).join("");
      var evts = (d.events || []).map(function (e) {
        return e.note || e.status || esc(JSON.stringify(e));
      }).join(" · ");
      host.innerHTML =
        "<h2>เคส #" + id + " — " + esc(d.subject) + "</h2>" +
        "<div class=\\"row\\"><span class=\\"tag neutral\\">" + esc(d.category) + "</span>" +
        "<span class=\\"tag\\">" + esc(d.status) + "</span>" +
        (d.severity ? "<span class=\\"tag warn\\">" + esc(d.severity) + "</span>" : "") +
        "<span class=\\"spacer\\"></span><button id=\\"kd-reload\\" class=\\"btn secondary\\">โหลดใหม่</button></div>" +
        "<p>" + esc(d.description || "") + "</p>" +
        (msgs ? "<h3 class=\\"muted\\">ข้อความ</h3>" + msgs : "<p class=\\"muted\\">ยังไม่มีข้อความ</p>") +
        (evts ? "<p class=\\"muted\\">เหตุการณ์: " + evts + "</p>" : "") +
        "<h3 class=\\"muted\\">ตอบกลับ</h3><textarea id=\\"kd-body\\" placeholder=\\"ข้อความ…\\"></textarea>" +
        "<div class=\\"row\\"><button id=\\"kd-send\\" class=\\"btn\\">ส่ง</button>" +
        "<span class=\\"spacer\\"></span><select id=\\"kd-st\\"><option>open</option><option>pending</option><option>resolved</option><option>closed</option></select>" +
        "<input id=\\"kd-note\\" placeholder=\\"note\\"><button id=\\"kd-stbtn\\" class=\\"btn secondary\\">เปลี่ยนสถานะ</button></div>" +
        "<p class=\\"err\\" id=\\"kd-msg\\"></p>";
      var msg = host.querySelector("#kd-msg");
      host.querySelector("#kd-reload").addEventListener("click", function () { caseDetail(page, id); });
      host.querySelector("#kd-send").addEventListener("click", function () {
        var b = host.querySelector("#kd-body").value.trim();
        if (!b) { msg.textContent = "กรอกข้อความ"; return; }
        postJSON("/admin/cases/" + id + "/messages", { body: b }).then(function (res) {
          msg.textContent = res.ok ? "" : ((res.data && res.data.error) || "fail");
          if (res.ok) caseDetail(page, id);
        });
      });
      host.querySelector("#kd-stbtn").addEventListener("click", function () {
        postJSON("/admin/cases/" + id + "/status", {
          status: host.querySelector("#kd-st").value,
          note: host.querySelector("#kd-note").value.trim() || null,
        }).then(function (res) {
          msg.textContent = res.ok ? "" : ((res.data && res.data.error) || "fail");
          if (res.ok) caseDetail(page, id);
        });
      });
    });
  }

  // ------------------------------------------------ audit
  function renderAudit(page) {
    var box = el(
      "<div class=\\"card\\"><h2>Audit log</h2>" +
      "<div class=\\"row\\"><input id=\\"a-act\\" placeholder=\\"filter: action (f.e. economy.grant)\\">" +
      "<button id=\\"a-go\\" class=\\"btn primary\\">โหลด</button></div>" +
      "<div id=\\"a-res\\"></div></div>"
    );
    page.appendChild(box);
    function load() {
      var act = box.querySelector("#a-act").value.trim();
      var out = box.querySelector("#a-res");
      out.innerHTML = "<p class=\\"muted\\">กำลังโหลด…</p>";
      api("/admin/audit" + (act ? "?action=" + encodeURIComponent(act) : "")).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && r.data.error) || "failed"); return; }
        var rows = (r.data.entries || []).map(function (e) {
          return "<tr><td>" + esc(e.id) + "</td><td>" + esc(e.action) + "</td>" +
            "<td><span class=\\"mono\\">" + esc((e.payload ? JSON.stringify(e.payload) : "").slice(0, 90)) + "</span></td>" +
            "<td>" + esc(e.result) + "</td><td>" + fmtDate(e.created_at) + "</td></tr>";
        }).join("");
        out.innerHTML = rows ? "<table><tr><th>id</th><th>action</th><th>payload</th><th>ไป</th><th>เวลา</th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่มี log</p>";
      });
    }
    box.querySelector("#a-go").addEventListener("click", load);
    box.querySelector("#a-act").addEventListener("keydown", function (e) { if (e.key === "Enter") load(); });
    load();
  }

  // ------------------------------------------------ security
  function renderSecurity(page) {
    var box = el(
      "<div class=\\"card\\"><h2>Security Center</h2>" +
      "<div class=\\"row\\"><select id=\\"sc-sev\\"><option value=\\"\\">ทุกseverity</option>" +
      "<option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>CRITICAL</option></select>" +
      "<select id=\\"sc-ack\\"><option value=\\"\\">ทั้งหมด</option><option value=\\"false\\">ยังไม่ack</option><option value=\\"true\\">ackแล้ว</option></select>" +
      "<button id=\\"sc-go\\" class=\\"btn primary\\">โหลด</button></div>" +
      "<div id=\\"sc-res\\"></div></div>"
    );
    page.appendChild(box);
    function load() {
      var qs = [];
      if (box.querySelector("#sc-sev").value) qs.push("severity=" + encodeURIComponent(box.querySelector("#sc-sev").value));
      if (box.querySelector("#sc-ack").value) qs.push("acknowledged=" + box.querySelector("#sc-ack").value);
      var out = box.querySelector("#sc-res");
      out.innerHTML = "<p class=\\"muted\\">กำลังโหลด…</p>";
      api("/admin/security/events" + (qs.length ? "?" + qs.join("&") : "")).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && r.data.error) || "failed"); return; }
        var rows = (r.data.events || []).map(function (e) {
          return "<tr data-id=\\"" + e.id + "\\"><td>" + esc(e.id) + "</td>" +
            "<td><span class=\\"tag warn\\">" + esc(e.severity) + "</span></td>" +
            "<td>" + esc(e.event_type) + "</td><td>" + esc(e.message || "") + "</td>" +
            "<td>" + yesNo(!!e.acknowledged_at) + "</td>" +
            "<td>" + fmtDate(e.created_at) + "</td></tr>";
        }).join("");
        out.innerHTML = rows ? "<table><tr><th>id</th><th>severity</th><th>type</th><th>message</th><th>ack</th><th>เวลา</th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่มีเหตุการณ์</p>";
        out.querySelectorAll("tr[data-id]").forEach(function (tr) {
          tr.addEventListener("dblclick", function () {
            var id = tr.getAttribute("data-id");
            if (!window.confirm("acknowledge event #" + id + "?")) return;
            postJSON("/admin/security/events/" + id + "/acknowledge", {}).then(function (resp) {
              resp.ok ? toast("ack แล้ว") : toast((resp.data && resp.data.error) || "fail");
            });
          });
        });
        out.appendChild(el("<p class=\\"muted\\">ดับเบิลคลิกแถว = acknowledge</p>"));
      });
    }
    box.querySelector("#sc-go").addEventListener("click", load);
    load();
  }

  // ------------------------------------------------ roles
  function renderRoles(page) {
    var mat = el("<div class=\\"card\\"><h2>Roles & permissions</h2><div id=\\"rm-res\\"><p class=\\"muted\\">กำลังโหลด…</p></div></div>");
    page.appendChild(mat);
    api("/admin/roles").then(function (r) {
      var out = mat.querySelector("#rm-res");
      if (!r.ok) { out.innerHTML = errBox((r.data && r.data.error) || "failed"); return; }
      var perms = [];
      (r.data.roles || []).forEach(function (role) {
        (role.permissions || []).forEach(function (p) { if (perms.indexOf(p) < 0) perms.push(p); });
      });
      var head = "<tr><th>Role</th>" + perms.map(function (p) { return "<th>" + esc(p) + "</th>"; }).join("") + "</tr>";
      var body = (r.data.roles || []).map(function (role) {
        return "<tr><td><strong>" + esc(role.name) + "</strong> <span class=\\"muted\\">(" + esc(role.rank) + ")</span></td>" +
          perms.map(function (p) { return "<td>" + ((role.permissions || []).indexOf(p) >= 0 ? "✓" : "") + "</td>"; }).join("") + "</tr>";
      }).join("");
      out.innerHTML = "<table>" + head + body + "</table>";
    });

    var mgr = el(
      "<div class=\\"card\\"><h2>จัดการ roles ให้ user</h2>" +
      "<div class=\\"row\\"><input id=\\"r-uid\\" type=\\"number\\" placeholder=\\"userId\\">" +
      "<button id=\\"r-view\\" class=\\"btn primary\\">ดู roles</button></div>" +
      "<div id=\\"r-res\\" class=\\"muted\\"></div>" +
      "<div class=\\"row\\"><input id=\\"r-name\\" placeholder=\\"roleName (moderator)\\">" +
      "<button id=\\"r-grant\\" class=\\"btn\\">grant</button>" +
      "<button id=\\"r-revoke\\" class=\\"btn danger\\">revoke</button></div></div>"
    );
    page.appendChild(mgr);
    mgr.querySelector("#r-view").addEventListener("click", function () {
      var uid = Number(mgr.querySelector("#r-uid").value);
      if (!uid) return;
      api("/admin/users/" + uid + "/roles").then(function (r) {
        var out = mgr.querySelector("#r-res");
        out.innerHTML = r.ok ? "roles: " + esc((r.data.roles || []).join(", ") || "(none)") : errBox((r.data && r.data.error) || "fail");
      });
    });
    function roleCall(endpoint) {
      var uid = Number(mgr.querySelector("#r-uid").value);
      var name = mgr.querySelector("#r-name").value.trim();
      if (!uid || !name) return;
      postJSON(endpoint, { userId: uid, roleName: name }).then(function (r) {
        toast(r.ok ? "ok" : ((r.data && r.data.error) || "fail"));
        mgr.querySelector("#r-view").click();
      });
    }
    mgr.querySelector("#r-grant").addEventListener("click", function () { roleCall("/admin/roles/grant"); });
    mgr.querySelector("#r-revoke").addEventListener("click", function () { roleCall("/admin/roles/revoke"); });
  }

  // ------------------------------------------------ vehicles
  function renderVehicles(page) {
    page.innerHTML = "";
    page.appendChild(el(
      "<div class=\\"card\\"><h2>สร้างรถ</h2>" +
      "<div class=\\"row\\"><input id=\\"v-type\\" placeholder=\\"entityType (megaverse:buggy)\\">" +
      "<input id=\\"v-owner\\" type=\\"number\\" placeholder=\\"ownerCharacterId (ว่าง = ยังไม่มีคนซื้อ)\\">" +
      "<input id=\\"v-price\\" type=\\"number\\" placeholder=\\"priceCents (ว่าง = ไม่ขาย)\\">" +
      "<button id=\\"v-create\\" class=\\"btn primary\\">สร้าง</button>" +
      "<span id=\\"v-create-msg\\" class=\\"muted\\"></span></div></div>"
    ));
    page.appendChild(el(
      "<div class=\\"card\\"><h2>รถทั้งหมด</h2>" +
      "<div class=\\"row\\"><button id=\\"v-refresh\\" class=\\"btn\\">Refresh</button><span id=\\"v-msg\\" class=\\"muted\\"></span></div>" +
      "<div id=\\"vlist\\"><p class=\\"muted\\">กำลังโหลด…</p></div></div>"
    ));

    function loadList() {
      api("/admin/vehicles?limit=100").then(function (r) {
        var out = page.querySelector("#vlist");
        if (!r.ok) { out.innerHTML = errBox((r.data && r.data.error) || "failed"); return; }
        var rows = (r.data && r.data.vehicles || []).map(function (v) {
          return "<tr><td><strong>" + esc(v.plate) + "</strong></td>" +
            "<td>" + esc(v.entityType) + "</td>" +
            "<td>" + esc(v.ownerName || (v.ownerCharacterId ? "#" + v.ownerCharacterId : "—")) + "</td>" +
            "<td>" + esc(v.status) + "</td>" +
            "<td>" + esc(v.locked ? "ล็อก" : "ปลด") + "</td>" +
            "<td>" + Number(v.fuelLevel).toFixed(0) + "</td>" +
            "<td>" + Number(v.engineHealth).toFixed(0) + "/" + Number(v.suspensionHealth).toFixed(0) + " hp</td>" +
            "<td>" + Number(v.bodyDamage).toFixed(0) + "</td>" +
            "<td>" + (v.salePriceCents != null ? money(v.salePriceCents) + " " + esc(v.saleCurrency) : "—") + "</td>" +
            "<td>" +
            "<button class=\\"btn small\\" data-vgrant=\\"" + v.id + "\\">ให้รถ</button> " +
            "<button class=\\"btn small\\" data-vrepair=\\"" + v.id + "\\">ซ่อม</button> " +
            "<button class=\\"btn small danger\\" data-vseize=\\"" + v.id + "\\">ยึด</button> " +
            "<button class=\\"btn small danger\\" data-vdel=\\"" + v.id + "\\">ลบ</button>" +
            "</td></tr>";
        }).join("");
        out.innerHTML = rows
          ? "<table><tr><th>ป้าย</th><th>ชนิด</th><th>เจ้าของ</th><th>สถานะ</th><th>ล็อก</th><th>น้ำมัน</th><th>ความเสียหาย</th><th>ตัวถัง</th><th>ราคาขาย</th><th>จัดการ</th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ยังไม่มีรถในระบบ</p>";
      });
    }
    page.querySelector("#v-refresh").addEventListener("click", loadList);

    page.querySelector("#v-create").addEventListener("click", function () {
      var body = {
        entityType: page.querySelector("#v-type").value.trim() || "megaverse:buggy",
      };
      var owner = Number(page.querySelector("#v-owner").value);
      var price = page.querySelector("#v-price").value;
      if (page.querySelector("#v-owner").value.trim() !== "") body.ownerCharacterId = owner;
      if (price.trim() !== "") { body.salePriceCents = Number(price); body.saleCurrency = "cash"; }
      postJSON("/admin/vehicles", body).then(function (r) {
        var msg = page.querySelector("#v-create-msg");
        if (!r.ok) { msg.textContent = (r.data && r.data.error) || "fail"; return; }
        msg.textContent = "สร้างแล้ว " + ((r.data && r.data.vehicle && r.data.vehicle.plate) || "");
        page.querySelector("#v-refresh").click();
      });
    });

    page.addEventListener("click", function (e) {
      var t = e.target;
      var id = t.getAttribute && (t.getAttribute("data-vgrant") || t.getAttribute("data-vrepair") || t.getAttribute("data-vseize") || t.getAttribute("data-vdel"));
      if (!id) return;
      function act(method, endpoint, body) {
        api(endpoint, method === "GET" ? {} : {
          method: method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {}),
        }).then(function (r) {
          toast(r.ok ? "ok" : ((r.data && r.data.error) || "fail"));
          loadList();
        });
      }
      if (t.getAttribute("data-vgrant")) {
        var owner = prompt("ownerCharacterId?");
        if (!owner) return;
        act("POST", "/admin/vehicles/" + id + "/grant", { ownerCharacterId: Number(owner) });
      } else if (t.getAttribute("data-vrepair")) {
        act("POST", "/admin/vehicles/" + id + "/repair", {});
      } else if (t.getAttribute("data-vseize")) {
        act("POST", "/admin/vehicles/" + id + "/seize", {});
      } else if (t.getAttribute("data-vdel")) {
        if (!confirm("ลบรถคันนี้จริง ๆ เหรอ? (รวมของในท้ายรถ)")) return;
        act("DELETE", "/admin/vehicles/" + id, {});
      }
    });
    loadList();
  }

  // ------------------------------------------------ properties
  function renderProperties(page) {
    var PROPERTY_TYPES = ["house", "apartment", "warehouse", "business", "office"];
    page.innerHTML = "";
    page.appendChild(el(
      "<div class=\\"card\\"><h2>สร้างอสังหาริมทรัพย์</h2>" +
      "<div class=\\"row\\">" +
      "<select id=\\"p-type\\">" + PROPERTY_TYPES.map(function (t) { return "<option>" + t + "</option>"; }).join("") + "</select>" +
      "<input id=\\"p-addr\\" placeholder=\\"ที่อยู่ (เช่น 123 ถ.พระราม 1)\\">" +
      "<input id=\\"p-owner\\" type=\\"number\\" placeholder=\\"ownerCharacterId (ว่าง = ที่ดินรัฐ)\\">" +
      "<input id=\\"p-garage\\" type=\\"number\\" placeholder=\\"garageCapacity (default 2)\\">" +
      "<input id=\\"p-price\\" type=\\"number\\" placeholder=\\"priceCents (ว่าง = ไม่ขาย)\\">" +
      "<button id=\\"p-create\\" class=\\"btn primary\\">สร้าง</button>" +
      "<span id=\\"p-create-msg\\" class=\\"muted\\"></span></div></div>"
    ));
    page.appendChild(el(
      "<div class=\\"card\\"><h2>อสังหาริมทรัพย์ทั้งหมด</h2>" +
      "<div class=\\"row\\"><button id=\\"p-refresh\\" class=\\"btn\\">Refresh</button><span id=\\"p-msg\\" class=\\"muted\\"></span></div>" +
      "<div id=\\"plist\\"><p class=\\"muted\\">กำลังโหลด…</p></div></div>"
    ));

    function loadList() {
      api("/admin/properties?limit=100").then(function (r) {
        var out = page.querySelector("#plist");
        if (!r.ok) { out.innerHTML = errBox((r.data && r.data.error) || "failed"); return; }
        var rows = (r.data && r.data.properties || []).map(function (p) {
          return "<tr><td><strong>" + esc(p.address) + "</strong></td>" +
            "<td>" + esc(p.propertyType) + "</td>" +
            "<td>" + esc(p.ownerName || (p.ownerCharacterId ? "#" + p.ownerCharacterId : "—")) + "</td>" +
            "<td>" + esc(p.status) + "</td>" +
            "<td>" + esc(p.locked ? "ล็อก" : "ปลด") + "</td>" +
            "<td>" + esc(String(p.garageCapacity)) + "</td>" +
            "<td>" + (p.salePriceCents != null ? money(p.salePriceCents) + " " + esc(p.saleCurrency) : "—") + "</td>" +
            "<td>" +
            "<button class=\\"btn small\\" data-pgrant=\\"" + p.id + "\\">มอบให้</button> " +
            "<button class=\\"btn small\\" data-psell=\\"" + p.id + "\\">วางขาย</button> " +
            "<button class=\\"btn small danger\\" data-pseize=\\"" + p.id + "\\">ยึด</button> " +
            "<button class=\\"btn small danger\\" data-pdel=\\"" + p.id + "\\">ลบ</button>" +
            "</td></tr>";
        }).join("");
        out.innerHTML = rows
          ? "<table><tr><th>ที่อยู่</th><th>ประเภท</th><th>เจ้าของ</th><th>สถานะ</th><th>ล็อก</th><th>อู่</th><th>ราคาขาย</th><th>จัดการ</th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ยังไม่มีอสังหาริมทรัพย์ในระบบ</p>";
      });
    }
    page.querySelector("#p-refresh").addEventListener("click", loadList);

    page.querySelector("#p-create").addEventListener("click", function () {
      var body = { propertyType: page.querySelector("#p-type").value, address: page.querySelector("#p-addr").value.trim() };
      if (!body.address) { page.querySelector("#p-create-msg").textContent = "ต้องใส่ที่อยู่"; return; }
      var owner = Number(page.querySelector("#p-owner").value);
      var garage = Number(page.querySelector("#p-garage").value);
      var price = page.querySelector("#p-price").value;
      if (page.querySelector("#p-owner").value.trim() !== "") body.ownerCharacterId = owner;
      if (page.querySelector("#p-garage").value.trim() !== "") body.garageCapacity = garage;
      if (price.trim() !== "") { body.salePriceCents = Number(price); body.saleCurrency = "cash"; }
      postJSON("/admin/properties", body).then(function (r) {
        var msg = page.querySelector("#p-create-msg");
        if (!r.ok) { msg.textContent = (r.data && r.data.error) || "fail"; return; }
        msg.textContent = "สร้างแล้ว " + (r.data && r.data.property && r.data.property.address || "");
        page.querySelector("#p-refresh").click();
      });
    });

    page.addEventListener("click", function (e) {
      var t = e.target;
      var id = t.getAttribute && (t.getAttribute("data-pgrant") || t.getAttribute("data-psell") || t.getAttribute("data-pseize") || t.getAttribute("data-pdel"));
      if (!id) return;
      function act(method, endpoint, body) {
        api(endpoint, method === "GET" ? {} : {
          method: method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {}),
        }).then(function (r) {
          toast(r.ok ? "ok" : ((r.data && r.data.error) || "fail"));
          loadList();
        });
      }
      if (t.getAttribute("data-pgrant")) {
        var owner = prompt("ownerCharacterId?");
        if (!owner) return;
        act("POST", "/admin/properties/" + id + "/grant", { ownerCharacterId: Number(owner) });
      } else if (t.getAttribute("data-psell")) {
        var price = prompt("priceCents (ว่าง = เอาออกขาย/unlist):");
        if (price === null) return;
        act("POST", "/admin/properties/" + id + "/sell", price.trim() === "" ? {} : { priceCents: Number(price), saleCurrency: "cash" });
      } else if (t.getAttribute("data-pseize")) {
        if (!confirm("ยึดอสังหาริมทรัพย์นี้จริง ๆ เหรอ?")) return;
        act("POST", "/admin/properties/" + id + "/seize", {});
      } else if (t.getAttribute("data-pdel")) {
        if (!confirm("ลบอสังหาริมทรัพย์นี้จริง ๆ เหรอ? (รวมห้องเก็บของในตัว)")) return;
        act("DELETE", "/admin/properties/" + id, {});
      }
    });
    loadList();
  }

  // ------------------------------------------------ police (MDT)
  function renderPolice(page) {
    page.innerHTML = "";
    page.appendChild(el(
      "<div class=\\"card\\"><h2>MDT — ประชาชน</h2>" +
      "<div class=\\"row\\"><input id=\\"pdx-q\\" placeholder=\\"ค้นหา ชื่อ / citizenId\\">" +
      "<button id=\\"pdx-go\\" class=\\"btn primary\\">ค้นหา</button></div>" +
      "<div id=\\"pdx-res\\"><p class=\\"muted\\">พิมพ์แล้วกดค้นหา</p></div></div>"
    ));
    page.appendChild(el(
      "<div class=\\"card\\"><h2>ค่าปรับ (Fines)</h2>" +
      "<div class=\\"row\\"><select id=\\"f-status\\"><option value=\\"outstanding\\">outstanding</option><option value=\\"paid\\">paid</option><option value=\\"\\">ทั้งหมด</option></select>" +
      "<button id=\\"f-refresh\\" class=\\"btn\\">Refresh</button><span class=\\"muted\\">เงินที่จ่ายจะหายจากระบบ (money sink)</span></div>" +
      "<div id=\\"fres\\"><p class=\\"muted\\">กำลังโหลด…</p></div></div>"
    ));
    page.appendChild(el(
      "<div class=\\"card\\"><h2>หมายศาล (Warrants)</h2>" +
      "<div class=\\"row\\"><select id=\\"w-status\\"><option value=\\"active\\">active</option><option value=\\"\\">ทั้งหมด</option></select>" +
      "<button id=\\"w-refresh\\" class=\\"btn\\">Refresh</button></div>" +
      "<div id=\\"wres\\"><p class=\\"muted\\">กำลังโหลด…</p></div></div>"
    ));
    page.appendChild(el(
      "<div class=\\"card\\"><h2>ผู้ต้องขัง (Arrests)</h2>" +
      "<div class=\\"row\\"><button id=\\"a-refresh\\" class=\\"btn\\">Refresh</button></div>" +
      "<div id=\\"ares\\"><p class=\\"muted\\">กำลังโหลด…</p></div></div>"
    ));
    page.appendChild(el(
      "<div class=\\"card\\"><h2>รายงาน (Reports)</h2>" +
      "<div class=\\"row\\"><select id=\\"r-status\\"><option value=\\"open\\">open</option><option value=\\"closed\\">closed</option><option value=\\"\\">ทั้งหมด</option></select>" +
      "<button id=\\"r-refresh\\" class=\\"btn\\">Refresh</button></div>" +
      "<div id=\\"rres\\"><p class=\\"muted\\">กำลังโหลด…</p></div></div>"
    ));

    function mdAction(endpoint, body) {
      return api(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(function (r) {
        toast(r.ok ? "ok" : ((r.data && (r.data.error || r.data.message)) || "fail"));
        return r;
      });
    }

    function loadCitizens() {
      var v = page.querySelector("#pdx-q").value.trim();
      var out = page.querySelector("#pdx-res");
      out.innerHTML = "<p class=\\"muted\\">กำลังโหลด…</p>";
      api("/admin/police/citizens" + (v ? "?query=" + encodeURIComponent(v) : "")).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && (r.data.error || r.data.message)) || "failed"); return; }
        var rows = (r.data.citizens || []).map(function (c) {
          return "<tr class=\\"clickable\\" data-cid=\\"" + c.id + "\\">" +
            "<td>" + esc(c.name) + "</td><td>" + esc(c.citizenId || "-") + "</td>" +
            "<td>" + esc(c.persistentId || "-") + "</td>" +
            "<td>" + esc(c.threatLevel) + "</td><td>" + c.licenseCount + "</td>" +
            "<td>" + c.warrantCount + "</td><td>" + c.outstandingFineCount + "</td></tr>";
        }).join("");
        out.innerHTML = rows
          ? "<table><tr><th>ชื่อ</th><th>citizenId</th><th>persistentId</th><th>ระดับ</th><th>บัตร</th><th>หมาย</th><th>ค่าปรับ</th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่พบ</p>";
        out.querySelectorAll("tr.clickable").forEach(function (tr) {
          tr.addEventListener("click", function () { policeCitizenDialog(Number(tr.getAttribute("data-cid"))); });
        });
      });
    }

    function policeCitizenDialog(cid) {
      api("/admin/police/citizens/" + cid).then(function (r) {
        if (!r.ok) { toast((r.data && (r.data.error || r.data.message)) || "fail"); return; }
        var c = r.data.citizen;
        var lic = (c.licenses || []).map(function (l) { return l.licenseType + ":" + l.status; }).join(", ") || "-";
        var fin = (c.fines || []).filter(function (x) { return x.status === "outstanding"; })
          .map(function (x) { return "#" + x.id + " " + money(x.amountCents) + " " + x.currency; }).join(", ") || "-";
        var war = (c.warrants || []).map(function (w) { return w.warrantType + ":" + w.status; }).join(", ") || "-";
        var jail = c.arrest ? "อยู่ในคุก เหลือ " + c.arrest.minutesRemaining + " นาที" : "-";
        var rec = c.record ? (c.record.alias ? "alias: " + c.record.alias + " " : "") + "ระดับ " + c.record.threatLevel : "ไม่มี record";
        var pick = window.prompt(
          "MDT: " + c.name + " (" + (c.citizenId || "ไม่มี id") + ")\\n" +
          "เพศ " + esc(c.gender || "-") + " เกิด " + esc(c.dateOfBirth || "-") + "\\n" +
          "บัตร: " + lic + "\\nค่าปรับ: " + fin + "\\nหมาย: " + war + "\\nคุก: " + jail + "\\n" + rec +
          "\\n\\n[1] บัตร   [2] ค่าปรับ   [3] หมายจับ   [4] จับกุม   [5] ปล่อยตัว   [6] อัปเดต record   [esc] ยกเลิก", "6"
        );
        if (pick === null) return;
        if (pick === "1") {
          var lt = prompt("licenseType (driving/weapon/business/fishing/aviation):", "driving");
          if (!lt) return;
          var lo = prompt("action (issue/suspend/revoke):", "issue");
          if (!lo) return;
          var ln = prompt("หมายเหตุ (ว่างได้):", "");
          mdAction("/admin/police/licenses", { characterId: cid, licenseType: lt, action: lo, notes: ln });
        } else if (pick === "2") {
          var fc = prompt("amountCents:", "50000");
          if (!fc) return;
          var cur = prompt("currency (cash/bank/red_money):", "cash");
          if (!cur) return;
          var fr = prompt("เหตุผล:", "ละเมิดกฎจราจร");
          if (!fr) return;
          mdAction("/admin/police/fines", { characterId: cid, amountCents: Number(fc), currency: cur, reason: fr }).then(function (resp) {
            if (resp.ok && resp.data && resp.data.fine) {
              mdAction("/admin/police/fines/" + resp.data.fine.id + "/pay", {});
            }
          });
        } else if (pick === "3") {
          var wt = prompt("warrantType (arrest/search):", "arrest");
          if (!wt) return;
          var wr = prompt("เหตุผล:", "");
          if (!wr) return;
          var wm = prompt("หมดอายุภายในกี่นาที (ว่าง = ไม่จำกัด):", "");
          var wbody = { characterId: cid, warrantType: wt, reason: wr };
          if (wm && wm.trim() !== "") wbody.minutes = Number(wm);
          mdAction("/admin/police/warrants", wbody);
        } else if (pick === "4") {
          var ar = prompt("เหตุผลจับกุม:", "");
          if (!ar) return;
          var am = prompt("จำคุกกี่นาที (1-1440):", "120");
          if (!am) return;
          mdAction("/admin/police/arrests", { characterId: cid, reason: ar, minutes: Number(am) });
        } else if (pick === "5") {
          if (!confirm("ปล่อยตัว " + c.name + " ก่อนครบกำหนด จริง ๆ เหรอ?")) return;
          mdAction("/admin/police/release", { characterId: cid });
        } else if (pick === "6") {
          var al = prompt("alias (ว่าง = คงเดิม):", "");
          var th = prompt("threatLevel (none/low/medium/high/critical):", "none");
          var nt = prompt("notes (ว่าง = คงเดิม):", "");
          var rbody = { characterId: cid };
          if (al && al.trim() !== "") rbody.alias = al;
          if (th) rbody.threatLevel = th;
          if (nt && nt.trim() !== "") rbody.notes = nt;
          mdAction("/admin/police/records", rbody);
        }
      });
    }

    function statTag(s) {
      if (s === "paid" || s === "closed" || s === "served" || s === "released") return '<span class="tag ok">' + esc(s) + "</span>";
      if (s === "outstanding" || s === "active" || s === "open") return '<span class="tag warn">' + esc(s) + "</span>";
      return '<span class="tag neutral">' + esc(s) + "</span>";
    }

    function loadFines() {
      var out = page.querySelector("#fres");
      var st = page.querySelector("#f-status").value;
      api("/admin/police/fines?status=" + encodeURIComponent(st)).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && (r.data.error || r.data.message)) || "failed"); return; }
        var rows = (r.data.fines || []).map(function (f) {
          return "<tr><td>#" + f.id + "</td><td>" + esc(f.officerName || "—") + "</td>" +
            "<td>" + money(f.amountCents) + " " + esc(f.currency) + "</td>" +
            "<td>" + esc(f.reason) + "</td><td>" + statTag(f.status) + "</td>" +
            "<td>" + fmtDate(f.issuedAt) + "</td>" +
            (f.status === "outstanding"
              ? "<td><button class=\\"btn small primary\\" data-fpay=\\"" + f.id + "\\">จ่ายแทน</button></td>"
              : "<td>-</td>") + "</tr>";
        }).join("");
        out.innerHTML = rows
          ? "<table><tr><th>#</th><th>เจ้าหน้าที่</th><th>มูลค่า</th><th>เหตุผล</th><th>สถานะ</th><th>ออกเมื่อ</th><th></th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่มีค่าปรับ</p>";
      });
    }
    page.querySelector("#f-refresh").addEventListener("click", loadFines);
    page.querySelector("#f-status").addEventListener("change", loadFines);
    page.querySelector("#fres").addEventListener("click", function (e) {
      var t = e.target;
      var id = t.getAttribute && t.getAttribute("data-fpay");
      if (!id) return;
      if (!confirm("จ่ายค่าปรับ #" + id + " แทนผู้ต้องขัง (เงินหายจากระบบ)? ")) return;
      mdAction("/admin/police/fines/" + id + "/pay", {}).then(loadFines);
    });

    function loadWarrants() {
      var out = page.querySelector("#wres");
      var st = page.querySelector("#w-status").value;
      api("/admin/police/warrants?status=" + encodeURIComponent(st)).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && (r.data.error || r.data.message)) || "failed"); return; }
        var rows = (r.data.warrants || []).map(function (w) {
          return "<tr><td>#" + w.id + "</td><td>" + esc(w.targetName || "#" + w.targetCharacterId) + "</td>" +
            "<td>" + esc(w.warrantType) + "</td><td>" + esc(w.reason) + "</td>" +
            "<td>" + statTag(w.status) + "</td>" + "<td>" + fmtDate(w.expiresAt) + "</td>" +
            (w.status === "active"
              ? "<td><button class=\\"btn small danger\\" data-wrev=\\"" + w.id + "\\">เพิกถอน</button></td>"
              : "<td>-</td>") + "</tr>";
        }).join("");
        out.innerHTML = rows
          ? "<table><tr><th>#</th><th>เป้าหมาย</th><th>ประเภท</th><th>เหตุผล</th><th>สถานะ</th><th>หมดอายุ</th><th></th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่มีหมายศาล</p>";
      });
    }
    page.querySelector("#w-refresh").addEventListener("click", loadWarrants);
    page.querySelector("#w-status").addEventListener("change", loadWarrants);
    page.querySelector("#wres").addEventListener("click", function (e) {
      var t = e.target;
      var id = t.getAttribute && t.getAttribute("data-wrev");
      if (!id) return;
      if (!confirm("เพิกถอนหมาย #" + id + " จริง ๆ เหรอ? (ต้องเป็น senior) ")) return;
      mdAction("/admin/police/warrants/" + id + "/revoke", {}).then(loadWarrants);
    });

    function loadArrests() {
      var out = page.querySelector("#ares");
      api("/admin/police/arrests?status=active").then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && (r.data.error || r.data.message)) || "failed"); return; }
        var rows = (r.data.arrests || []).map(function (a) {
          return "<tr><td>#" + a.id + "</td><td>" + esc(a.characterName || "#" + a.characterId) + "</td>" +
            "<td>" + esc(a.reason) + "</td><td>" + (a.minutesRemaining != null ? a.minutesRemaining : "-") + " นาที</td>" +
            "<td>" + fmtDate(a.jailUntil) + "</td>" + "<td>" + statTag(a.status) + "</td>" +
            "<td><button class=\\"btn small primary\\" data-arel=\\"" + a.characterId + "\\">ปล่อยตัว</button></td></tr>";
        }).join("");
        out.innerHTML = rows
          ? "<table><tr><th>#</th><th>ตัวละคร</th><th>เหตุผล</th><th>เหลือ</th><th>ครบกำหนด</th><th>สถานะ</th><th></th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่มีผู้ต้องขัง</p>";
      });
    }
    page.querySelector("#a-refresh").addEventListener("click", loadArrests);
    page.querySelector("#ares").addEventListener("click", function (e) {
      var t = e.target;
      var cid = t.getAttribute && t.getAttribute("data-arel");
      if (!cid) return;
      if (!confirm("ปล่อยตัวรุกก่อนครบกำหนด จริง ๆ เหรอ?")) return;
      mdAction("/admin/police/release", { characterId: Number(cid) }).then(loadArrests);
    });

    function loadReports() {
      var out = page.querySelector("#rres");
      var st = page.querySelector("#r-status").value;
      api("/admin/police/reports?status=" + encodeURIComponent(st)).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && (r.data.error || r.data.message)) || "failed"); return; }
        var rows = (r.data.reports || []).map(function (re) {
          return "<tr><td>#" + re.id + "</td><td>" + esc(re.title) + "</td>" +
            "<td>" + esc(re.classification) + "</td><td>" + statTag(re.status) + "</td>" +
            "<td>" + fmtDate(re.createdAt) + "</td></tr>";
        }).join("");
        out.innerHTML = rows
          ? "<table><tr><th>#</th><th>หัวเรื่อง</th><th>ชั้นความลับ</th><th>สถานะ</th><th>เขียนเมื่อ</th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่มีรายงาน</p>";
      });
    }
    page.querySelector("#r-refresh").addEventListener("click", loadReports);
    page.querySelector("#r-status").addEventListener("change", loadReports);

    page.querySelector("#pdx-go").addEventListener("click", loadCitizens);
    page.querySelector("#pdx-q").addEventListener("keydown", function (e) { if (e.key === "Enter") loadCitizens(); });
    loadFines();
    loadWarrants();
    loadArrests();
    loadReports();
  }

  // ------------------------------------------------ medical (EMS)
  function renderMedical(page) {
    page.innerHTML = "";
    page.appendChild(el(
      "<div class=\\"card\\"><h2>เวชระเบียน (records)</h2>" +
      "<div class=\\"row\\"><input id=\\"m-q\\" placeholder=\\"ค้นหา ชื่อ / citizenId / persistentId\\">" +
      "<button id=\\"m-go\\" class=\\"btn primary\\">ค้นหา</button></div>" +
      "<div id=\\"mres\\"><p class=\\"muted\\">กำลังโหลด…</p></div></div>"
    ));
    page.appendChild(el(
      "<div class=\\"card\\"><h2>ค่ารักษา (bills)</h2>" +
      "<div class=\\"row\\"><select id=\\"mb-status\\"><option value=\\"unpaid\\">unpaid</option>" +
      "<option>paid</option><option>waived</option><option value=\\"\\">ทั้งหมด</option></select>" +
      "<button id=\\"mb-refresh\\" class=\\"btn\\">Refresh</button>" +
      "<span class=\\"muted\\">จ่าย = เงินหายจากระบบ (money sink)</span></div>" +
      "<div id=\\"mbres\\"><p class=\\"muted\\">กำลังโหลด…</p></div></div>"
    ));

    function healthTag(s) {
      if (s === "healthy") return '<span class="tag ok">' + esc(s) + "</span>";
      if (s === "dead") return '<span class="tag warn">' + esc(s) + "</span>";
      return '<span class="tag neutral">' + esc(s) + "</span>";
    }
    function statusTag(s) {
      if (s === "paid" || s === "closed" || s === "completed") return '<span class="tag ok">' + esc(s) + "</span>";
      if (s === "unpaid" || s === "open" || s === "pending") return '<span class="tag warn">' + esc(s) + "</span>";
      return '<span class="tag neutral">' + esc(s) + "</span>";
    }

    function medAction(endpoint, body) {
      return api(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(function (r) {
        toast(r.ok ? "ok" : ((r.data && (r.data.error || r.data.message)) || "fail"));
        return r;
      });
    }

    function loadRecords() {
      var v = page.querySelector("#m-q").value.trim();
      var out = page.querySelector("#mres");
      out.innerHTML = "<p class=\\"muted\\">กำลังโหลด…</p>";
      api("/admin/ems/records" + (v ? "?query=" + encodeURIComponent(v) : "")).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && (r.data.error || r.data.message)) || "failed"); return; }
        var rows = (r.data.records || []).map(function (c) {
          return "<tr><td><strong>" + esc(c.name) + "</strong></td><td>" + esc(c.citizenId || "-") + "</td>" +
            "<td>" + healthTag(c.healthState) + "</td>" +
            "<td>" + (c.downedRemainingSeconds != null ? c.downedRemainingSeconds + "s" : "-") + "</td>" +
            "<td>" + c.unpaidBillCount + "</td>" +
            "<td>" + (c.mustRespawnHospital ? '<span class="tag warn">รพ.</span>' : "-") + "</td>" +
            "<td>" + c.hospitalizationCount + "</td>" +
            "<td><button class=\\"btn small\\" data-mreset=\\"" + c.id + "\\">รีเซ็ต</button></td></tr>";
        }).join("");
        out.innerHTML = rows
          ? "<table><tr><th>ชื่อ</th><th>citizenId</th><th>สถานะ</th><th>เหลือ</th><th>ค้างจ่าย</th><th>รพ.</th><th>ครั้ง</th><th></th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่พบ</p>";
        out.querySelectorAll("[data-mreset]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var id = Number(btn.getAttribute("data-mreset"));
            if (!confirm("รีเซ็ตสถานะสุขภาพของตัวละคร #" + id + " เป็น healthy จริง ๆ เหรอ?")) return;
            medAction("/admin/ems/reset", { characterId: id }).then(loadRecords);
          });
        });
      });
    }
    page.querySelector("#m-go").addEventListener("click", loadRecords);
    page.querySelector("#m-q").addEventListener("keydown", function (e) { if (e.key === "Enter") loadRecords(); });

    function loadBills() {
      var out = page.querySelector("#mbres");
      var st = page.querySelector("#mb-status").value;
      api("/admin/ems/bills" + (st ? "?status=" + encodeURIComponent(st) : "")).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && (r.data.error || r.data.message)) || "failed"); return; }
        var rows = (r.data.bills || []).map(function (b) {
          return "<tr><td>#" + b.id + "</td><td>ch#" + b.patientId + "</td>" +
            "<td>" + money(b.amountCents) + " " + esc(b.currency) + "</td>" +
            "<td>" + esc(b.reason) + "</td><td>" + statusTag(b.status) + "</td>" +
            "<td>" + fmtDate(b.issuedAt) + "</td>" +
            (b.status === "unpaid"
              ? "<td><button class=\\"btn small primary\\" data-bpay=\\"" + b.id + "\\">จ่ายแทน</button> " +
                "<button class=\\"btn small danger\\" data-bwaive=\\"" + b.id + "\\">ยกเว้น</button></td>"
              : "<td>-</td>") + "</tr>";
        }).join("");
        out.innerHTML = rows
          ? "<table><tr><th>#</th><th>คนไข้</th><th>มูลค่า</th><th>เหตุผล</th><th>สถานะ</th><th>ออกเมื่อ</th><th></th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่มีบิล</p>";
      });
    }
    page.querySelector("#mb-refresh").addEventListener("click", loadBills);
    page.querySelector("#mb-status").addEventListener("change", loadBills);
    page.querySelector("#mbres").addEventListener("click", function (e) {
      var t = e.target;
      var id = t.getAttribute && (t.getAttribute("data-bpay") || t.getAttribute("data-bwaive"));
      if (!id) return;
      if (t.getAttribute("data-bpay")) {
        if (!confirm("จ่ายค่ารักษา #" + id + " แทนคนไข้ (เงินหายจากระบบ)? ")) return;
        medAction("/admin/ems/bills/" + id + "/pay", {}).then(loadBills);
      } else {
        if (!confirm("ยกเว้นค่ารักษา #" + id + " (เงินไม่เสีย)? ")) return;
        medAction("/admin/ems/bills/" + id + "/waive", {}).then(loadBills);
      }
    });

    loadRecords();
    loadBills();
  }

  // ------------------------------------------------ phone
  function renderPhone(page) {
    page.innerHTML = "";
    page.appendChild(el(
      "<div class=\\"card\\"><h2>หมายเลขโทรศัพท์</h2>" +
      "<div class=\\"row\\"><input id=\\"pn-q\\" placeholder=\\"ค้นหา ชื่อ / เบอร์\\">" +
      "<button id=\\"pn-go\\" class=\\"btn primary\\">ค้นหา</button></div>" +
      "<div id=\\"pnres\\"><p class=\\"muted\\">กำลังโหลด…</p></div></div>"
    ));
    page.appendChild(el(
      "<div class=\\"card\\"><h2>เหตุฉุกเฉิน (911)</h2>" +
      "<div class=\\"row\\"><select id=\\"ec-status\\"><option value=\\"\\">ทั้งหมด</option>" +
      "<option>open</option><option>dispatched</option><option>closed</option></select>" +
      "<button id=\\"ec-refresh\\" class=\\"btn\\">Refresh</button></div>" +
      "<div id=\\"ecres\\"><p class=\\"muted\\">กำลังโหลด…</p></div></div>"
    ));
    page.appendChild(el(
      "<div class=\\"card\\"><h2>แท็กซี่ (taxi board)</h2>" +
      "<div class=\\"row\\"><select id=\\"tx-status\\"><option value=\\"\\">ทั้งหมด</option>" +
      "<option>pending</option><option>accepted</option><option>completed</option><option>cancelled</option></select>" +
      "<button id=\\"tx-refresh\\" class=\\"btn\\">Refresh</button></div>" +
      "<div id=\\"txres\\"><p class=\\"muted\\">กำลังโหลด…</p></div></div>"
    ));

    function statusTag(s) {
      if (s === "paid" || s === "closed" || s === "completed") return '<span class="tag ok">' + esc(s) + "</span>";
      if (s === "unpaid" || s === "open" || s === "pending" || s === "active") return '<span class="tag warn">' + esc(s) + "</span>";
      return '<span class="tag neutral">' + esc(s) + "</span>";
    }
    function medAction(endpoint, body) {
      return api(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(function (r) {
        toast(r.ok ? "ok" : ((r.data && (r.data.error || r.data.message)) || "fail"));
        return r;
      });
    }

    function loadNumbers() {
      var v = page.querySelector("#pn-q").value.trim();
      var out = page.querySelector("#pnres");
      out.innerHTML = "<p class=\\"muted\\">กำลังโหลด…</p>";
      api("/admin/phone/numbers" + (v ? "?query=" + encodeURIComponent(v) : "")).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && (r.data.error || r.data.message)) || "failed"); return; }
        var rows = (r.data.numbers || []).map(function (n) {
          return "<tr><td>ch#" + n.characterId + "</td><td>" + esc(n.characterName || "-") + "</td>" +
            "<td><span class=\\"mono\\">" + esc(n.number) + "</span></td>" +
            "<td>" + fmtDate(n.createdAt) + "</td></tr>";
        }).join("");
        out.innerHTML = rows
          ? "<table><tr><th>ตัวละคร</th><th>ชื่อ</th><th>เบอร์</th><th>ออกเมื่อ</th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่พบ</p>";
      });
    }
    page.querySelector("#pn-go").addEventListener("click", loadNumbers);
    page.querySelector("#pn-q").addEventListener("keydown", function (e) { if (e.key === "Enter") loadNumbers(); });

    function loadEmergency() {
      var out = page.querySelector("#ecres");
      var st = page.querySelector("#ec-status").value;
      api("/admin/phone/emergency" + (st ? "?status=" + encodeURIComponent(st) : "")).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && (r.data.error || r.data.message)) || "failed"); return; }
        var rows = (r.data.calls || []).map(function (c) {
          return "<tr><td>#" + c.id + "</td><td>" + esc(c.callerName || "#" + c.callerCharacterId) + "</td>" +
            "<td>" + esc(c.category) + "</td><td>" + esc(c.subject) + "</td>" +
            "<td>" + statusTag(c.status) + "</td><td>" + fmtDate(c.createdAt) + "</td>" +
            (c.status !== "closed"
              ? "<td><button class=\\"btn small primary\\" data-ecclose=\\"" + c.id + "\\">ปิด</button></td>"
              : "<td>-</td>") + "</tr>";
        }).join("");
        out.innerHTML = rows
          ? "<table><tr><th>#</th><th>ผู้แจ้ง</th><th>ประเภท</th><th>เรื่อง</th><th>สถานะ</th><th>แจ้งเมื่อ</th><th></th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่มีเหตุฉุกเฉิน</p>";
      });
    }
    page.querySelector("#ec-refresh").addEventListener("click", loadEmergency);
    page.querySelector("#ec-status").addEventListener("change", loadEmergency);
    page.querySelector("#ecres").addEventListener("click", function (e) {
      var t = e.target;
      var id = t.getAttribute && t.getAttribute("data-ecclose");
      if (!id) return;
      if (!confirm("ปิดเหตุฉุกเฉิน #" + id + " (responder = admin)? ")) return;
      medAction("/admin/phone/emergency/" + id + "/close", {}).then(loadEmergency);
    });

    function loadTaxi() {
      var out = page.querySelector("#txres");
      var st = page.querySelector("#tx-status").value;
      api("/admin/phone/taxi" + (st ? "?status=" + encodeURIComponent(st) : "")).then(function (r) {
        if (!r.ok) { out.innerHTML = errBox((r.data && (r.data.error || r.data.message)) || "failed"); return; }
        var rows = (r.data.requests || []).map(function (t) {
          return "<tr><td>#" + t.id + "</td><td>" + esc(t.requesterName || "#" + t.requesterCharacterId) + "</td>" +
            "<td>" + esc(t.destination) + "</td>" +
            "<td>" + money(t.fareCents) + " " + esc(t.currency) + "</td>" +
            "<td>" + statusTag(t.status) + "</td>" +
            "<td>" + (esc(t.driverName || (t.driverCharacterId ? "#" + t.driverCharacterId : "—"))) + "</td></tr>";
        }).join("");
        out.innerHTML = rows
          ? "<table><tr><th>#</th><th>ผู้เรียก</th><th>ปลายทาง</th><th>ค่าโดยสาร</th><th>สถานะ</th><th>คนขับ</th></tr>" + rows + "</table>"
          : "<p class=\\"muted\\">ไม่มีงานแท็กซี่</p>";
      });
    }
    page.querySelector("#tx-refresh").addEventListener("click", loadTaxi);
    page.querySelector("#tx-status").addEventListener("change", loadTaxi);

    loadNumbers();
    loadEmergency();
    loadTaxi();
  }

  // ------------------------------------------------ boot
  async function boot() {
    var me = await api("/admin/presence/online");
    if (me.status === 401) {
      app.innerHTML = "<div class=\\"card center\\"><h1>ต้องเป็นแอดมินก่อน</h1><p class=\\"muted\\">แผงนี้ใช้ได้สำหรับผู้ดูแลระบบเท่านั้น — ล็อกอินด้วย Discord ที่เป็นแอดมินแล้วกลับมาที่นี่</p>" +
        "<a class=\\"btn primary\\" href=\\"/auth/discord/login?next=" + encodeURIComponent(location.pathname + location.search) + "\\">Login with Discord</a></div>";
      return;
    }
    if (me.status === 403) {
      app.innerHTML = "<div class=\\"card center\\"><h1>ไม่มีสิทธิ์เข้าถึง</h1>" +
        "<p class=\\"err\\">บัญชีนี้ล็อกอินแล้วแต่ยังไม่มีสิทธิ์ดูแลระบบ (auth.manage)</p></div>";
      return;
    }
    renderShell();
  }
  boot();
})();
`;

export const adminWebRouter = Router();

// The admin console is admin-only at the server: /admin, /admin/app.css and
// /admin/app.js each require a valid session HOLDING auth.manage (the owner
// role and any role granting auth.manage pass). The app JS also draws a
// "login as admin" screen on the first 401, but it can never gate a
// non-owner — the real boundary is this guard below + the RBAC-guarded
// /admin JSON routes.

// Browser navigation (Accept: text/html) gets a human-facing screen; API
// clients (irregular fetches / asset loads) get plain JSON. Both carry the
// same status codes (401/403) by auth state, so the JS is still aware.
async function adminShellGuard(req: Request, res: Response, next: NextFunction) {
  const userId = (req as any).userId as number | undefined;
  if (typeof userId !== "number") {
    if ((req.headers.accept ?? "").includes("text/html")) {
      return res
        .status(401)
        .setHeader("Content-Security-Policy", WEB_CSP)
        .type("html")
        .send(
          `<!doctype html><html lang="th"><head><meta charset="utf-8">` +
            `<title>ต้องเป็นแอดมิน</title></head>` +
            `<body style="font-family:system-ui;background:#101317;color:#e6e6e6;padding:24px">` +
            `<h1>ต้องเป็นแอดมินก่อน</h1>` +
            `<p>แผงนี้ใช้ได้สำหรับผู้ดูแลระบบเท่านั้น. <a href="/auth/discord/login?next=/admin">ล็อกอินด้วย Discord</a></p>` +
            `</body></html>`
        );
    }
    return res.status(401).json({ error: "unauthenticated" });
  }
  const ok = await hasPermission(userId, "auth.manage");
  if (!ok) {
    if ((req.headers.accept ?? "").includes("text/html")) {
      return res
        .status(403)
        .setHeader("Content-Security-Policy", WEB_CSP)
        .type("html")
        .send(
          `<!doctype html><html lang="th"><head><meta charset="utf-8">` +
            `<title>ไม่มีสิทธิ์</title></head>` +
            `<body style="font-family:system-ui;background:#101317;color:#e6e6e6;padding:24px">` +
            `<h1>ไม่มีสิทธิ์ (auth.manage)</h1>` +
            `<p>บัญชีนี้ไม่ใช่ผู้ดูแลระบบ</p></body></html>`
        );
    }
    return res.status(403).json({ error: "forbidden", required: "auth.manage" });
  }
  next();
}

adminWebRouter.get("/", adminShellGuard, (_req, res) => {
  res.setHeader("Content-Security-Policy", WEB_CSP);
  res.type("html").send(INDEX_HTML(CANONICAL_ORIGIN));
});

adminWebRouter.get("/app.css", adminShellGuard, (_req, res) => {
  res.setHeader("Content-Security-Policy", WEB_CSP);
  res.type("css").send(APP_CSS);
});

adminWebRouter.get("/app.js", adminShellGuard, (_req, res) => {
  res.setHeader("Content-Security-Policy", WEB_CSP);
  res.type("js").send(APP_JS);
});