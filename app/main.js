'use strict';

// Bedrock RP Control — main process.
//
// The app is a thin shell around the backend's web admin. Login happens
// HERE, in the main process (never in the renderer): we POST
// /auth/login with the user's username + password, take the Set-Cookie
// session cookie the backend issues, store it in the Electron cookie jar
// for the configured server origin, then load /admin into the window. The
// web admin then works unchanged (same cookie, same session, same RBAC).
//
// Security posture:
//   - contextIsolation + sandbox, nodeIntegration off
//   - renderer only talks to the main process over exposeInMainWorld IPC
//   - navigation restricted to the configured server origin (or file: for
//     the built-in login page)
//   - window.open is always denied

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_COOKIE = 'bedrock_rp_session';
const APP_NAME = 'Bedrock RP Control';
const DEFAULT_SERVER = 'http://127.0.0.1:8080';
const SERVER_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9._-]+)(:\d{1,5})?$/i;

let win = null;
let serverUrl = DEFAULT_SERVER;
const loginPageFile = path.join(__dirname, 'login.html');

function loadLoginPage(target) {
  const w = target || win;
  if (w && !w.isDestroyed()) w.loadFile(loginPageFile);
}

function loadAdmin(target) {
  const w = target || win;
  if (w && !w.isDestroyed()) w.loadURL(`${serverUrl}/admin`);
}

// ---------------- settings (persisted in userData) ----------------
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const s = JSON.parse(raw);
    if (typeof s.serverUrl === 'string') return s.serverUrl;
  } catch {}
  return null;
}
function saveSettings(url) {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify({ serverUrl: url }, null, 2));
  } catch (err) {
    console.error('[control] could not persist settings', err);
  }
}

// ---------------- cookie helpers ----------------
// set-cookie header(s) from a fetch Response (Node >= 19.7 has getSetCookie).
function parseSetCookie(getHeaders) {
  try {
    const list = typeof getHeaders.getSetCookie === 'function'
      ? getHeaders.getSetCookie()
      : (getHeaders.get('set-cookie') ? [getHeaders.get('set-cookie')] : []);
    return list.map((header) => {
      const parts = header.split(';');
      const eq = parts[0].indexOf('=');
      if (eq <= 0) return null;
      const cookie = {
        name: parts[0].slice(0, eq).trim(),
        value: parts[0].slice(eq + 1).trim(),
        path: '/',
        secure: false,
        httpOnly: false,
      };
      for (let i = 1; i < parts.length; i++) {
        const kv = parts[i].trim().split('=');
        const key = kv[0].trim().toLowerCase();
        if (key === 'path') cookie.path = (kv[1] || '/').trim();
        else if (key === 'secure') cookie.secure = true;
        else if (key === 'httponly') cookie.httpOnly = true;
        else if (key === 'domain') cookie.domain = (kv[1] || '').trim();
        else if (key === 'max-age') {
          const s = Number(kv[1]);
          if (!Number.isNaN(s)) cookie.expirationDate = Math.floor(Date.now() / 1000) + s;
        } else if (key === 'expires') {
          const t = Date.parse(kv[1]);
          if (!Number.isNaN(t)) cookie.expirationDate = Math.floor(t / 1000);
        } else if (key === 'samesite') {
          const v = (kv[1] || '').trim().toLowerCase();
          if (v === 'lax' || v === 'strict') cookie.sameSite = v;
        }
      }
      return cookie;
    }).filter(Boolean);
  } catch (err) {
    console.error('[control] parseSetCookie failed', err);
    return [];
  }
}

async function setCookiesFromResponse(origin, res) {
  const cookies = parseSetCookie(res.headers);
  for (const cookie of cookies) {
    try {
      await session.defaultSession.cookies.set({ url: origin, ...cookie });
    } catch (err) {
      console.error('[control] cookie set failed', cookie.name, err);
    }
  }
}

// ---------------- backend interaction (main-process only) ----------------
async function login(username, password) {
  const res = await fetch(`${serverUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    let msg = `login failed (HTTP ${res.status})`;
    try {
      const data = await res.json();
      if (data && data.error) msg = data.error;
    } catch {}
    return { ok: false, error: msg };
  }
  await setCookiesFromResponse(serverUrl, res);
  return { ok: true };
}

// Is the current session cookie valid for ops access? (probe is read-only)
// NOTE: bare fetch() in the main process does NOT send cookies, so we read
// the stored session cookie from Electron's jar and attach it explicitly.
async function sessionWorks() {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: serverUrl });
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (!cookieHeader) return false;
    const res = await fetch(`${serverUrl}/admin/ops/status`, {
      headers: { Accept: 'application/json', Cookie: cookieHeader },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------- window + navigation ----------------
function createWindow() {
  win = new BrowserWindow({
    width: 1160,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: APP_NAME,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const okOrigin = url.startsWith(serverUrl + '/');
    const okFile = url.startsWith('file://');
    if (!okOrigin && !okFile) {
      event.preventDefault();
    }
  });

  // If the backend ever answers 401 on an /admin page load (server restart,
  // session revoked, or the in-app logout button), bounce back to login.
  // NOTE: onResponseStarted is an observe-phase event — its listener takes
  // (details) only, no callback() call at the end (unlike onBeforeRequest).
  session.defaultSession.webRequest.onResponseStarted((details) => {
    if (details.statusCode === 401 && details.url.indexOf('/admin') !== -1) {
      setTimeout(() => {
        if (win && !win.isDestroyed()) loadLoginPage(win);
      }, 250);
    }
  });

  win.on('closed', () => { win = null; });
}

// ---------------- IPC (renderer -> main) ----------------
ipcMain.handle('control:settings', () => ({ serverUrl }));

ipcMain.handle('control:set-server', (_event, url) => {
  if (typeof url !== 'string' || !SERVER_RE.test(url.trim())) {
    return { ok: false, error: 'server URL must be http(s)://host[:port]' };
  }
  serverUrl = url.trim().replace(/\/+$/, '');
  saveSettings(serverUrl);
  return { ok: true, serverUrl };
});

ipcMain.handle('control:login', async (_event, { username, password }) => {
  if (typeof username !== 'string' || typeof password !== 'string') {
    return { ok: false, error: 'missing username or password' };
  }
  try {
    const result = await login(username, password);
    if (result.ok) await loadAdmin(win);
    return result;
  } catch (err) {
    return { ok: false, error: `cannot reach server: ${String(err && err.message ? err.message : err)}` };
  }
});

ipcMain.handle('control:logout', async () => {
  try {
    await fetch(`${serverUrl}/auth/logout`, { method: 'POST' });
  } catch {}
  try {
    await session.defaultSession.cookies.remove(serverUrl, SESSION_COOKIE);
  } catch {}
  if (win && !win.isDestroyed()) loadLoginPage(win);
  return { ok: true };
});

// ---------------- boot ----------------
app.whenReady().then(async () => {
  const saved = loadSettings();
  if (saved && SERVER_RE.test(saved)) serverUrl = saved.replace(/\/+$/, '');
  app.setName(APP_NAME);
  createWindow();

  const ok = await sessionWorks().catch(() => false);
  if (ok) await loadAdmin(win);
  else await loadLoginPage(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});