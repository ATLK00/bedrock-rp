# BEDROCK-RP

Minecraft Bedrock roleplay server. Modular, server-authoritative,
audit-logged. Built per `docs/MASTER_PROMPT.md`.

## Stack (locked this iteration)

| Layer | Choice |
|---|---|
| Game server | Bedrock Dedicated Server (BDS) + Scripting API (`@minecraft/server`, `@minecraft/server-net`) |
| Backend | Node.js + TypeScript |
| Database | PostgreSQL (source of truth) |
| Cache / pub-sub | Redis |
| Bridge (BDS ↔ backend) | HTTP over `@minecraft/server-net` (script side) ↔ Express (backend side) |
| Auth | Discord OAuth2, 1 Discord account = 1 character |

## Backend systems (2026-09-09)

- **Character profile**: RP details (name, DOB, gender, nationality, citizen ID, bio, …),
  confirm/lock after review, staff-approved edits via the case flow. `GET/PATCH /character/details`,
  `POST /character/confirm`, `POST /character/change-request`.
- **Multi-currency economy**: `cash` (legacy `wallets` path — unchanged wire shape),
  `bank` and `red_money` (`wallet_balances`). Every move is ledgered in `transactions`
  with a currency tag; admin grant/deduct accept `currency` + `idempotencyKey`.
- **Weight-aware inventory + containers**: character carry limit (`carry_weight_g`),
  weight-capped containers (vehicle/house/business/locker/warehouse), atomic
  character ↔ container transfers. Player routes under `/inventories`, staff under `/admin/inventory/…`.
- **Idempotency**: `idempotency_keys` — replay-safe admin economy/writes via
  `Idempotency-Key` header or `idempotencyKey` body field (mismatched replay → 409).
- **Security center**: append-only `security_events` feed (bad bridge secret/signature,
  replays, OAuth failures, rate-limit trips, economy anomalies, server errors).
  `GET /admin/security/events`, `POST /admin/security/events/:id/acknowledge`.
- **Support cases**: bug/lost-item/character-issue/etc. tickets with timeline, staff
  state machine (open → in_progress → resolved/closed/rejected). `POST/GET /cases`,
  staff routes under `/admin/cases`.
- **Ops hardening**: CORS allowlist + security headers middleware, `/health/live` +
  `/health/ready`, fail-fast server timeouts, OAuth `state` (login-CSRF) protection,
  structured bridge logs, global error handler with error codes.
- **Vehicles**: server-authoritative ownership (keys are `rp:vehicle_key` items),
  garage capacity per character, deploy/store around the server, fuel (burned per
  driving tick, refuel 10¢/unit), engine/suspension/body state (sensors only ever
  make it worse; repair restores at shop prices), lock, free transfer, player
  sale listings + dealership purchases, seized/delete for staff. Bridge
  `/bridge/vehicle/*` and admin `/admin/vehicles/*` routes; the Car AllDay Town
  addon is vendored at `vehicle_pack/` (pack only reports ticks/sensors — the
  server is the single authority).
- **Properties**: server-authoritative real estate (address/type, owner on the
  character, deed key `rp:property_key` item), each property carries a house
  storage container (reusable with `!inv`) AND a garage capacity that ADDS to the
  owner's vehicle slots — buying a house genuinely expands what a character can
  own, wiring the garage into the vehicle system. Key-holders (deed handed over)
  can unlock/open storage without owning. Government lots bought from the market,
  player-to-player listing/sale/unlist, free transfer, staff grant/seize/delete.
  Bridge `/bridge/property/*` and admin `/admin/properties/*` routes; in-game
  menu is `!house` / `!property`.
- **Police / MDT**: player-operated police department (`backend/src/modules/police/`)
  — citizen + vehicle records (known alias, threat level), licenses
  (driving/weapon/business/fishing/aviation, one valid per citizen+type), fines as
  a deliberate money sink (paid via economy debit — money leaves circulation),
  arrest/search warrants (revoke is senior-only), reports with evidence
  attachments, and arrest → jail (1–1440 min, `jailed_until`, one active per
  citizen). Officer actions go through the signed bridge `/bridge/police/*`; the
  backend checks the actor's police role server-side (denied attempts land as HIGH
  `staff_command_forbidden` security events) and audits every write. Admin
  `/admin/police/*` routes + a web MDT tab; citizens see their own state
  (`GET /character/police`) and pay fines in the player panel or in-game
  (`!police`/`!mdt`).
- **EMS / emergency services** (`backend/src/modules/ems/`): a server-authoritative
  health state machine per citizen — `healthy → downed (with expiry) → treated → healthy`, plus `dead`, moves **money out of circulation** with a `MEDICAL_BILL_CENTS`
  hospital charged on treatment. Citizens self-report down (`/bridge/ems/down`, the
  pack death hook), medics (role `ems`, perms `ems.view`/`ems.manage`) rescue + treat
  + declare death, and anyone dead must respawn at the hospital (`/bridge/ems/
  hospitalize`) which bills them. Medic lookup/dossier is `searchMedical` (by name
  or citizen id). Admin `/admin/ems/*` (records/bills/waive/reset, `ems.admin`),
  player web medical card, `!ems`/`!medic` in-game.
- **Phone / mobile** (`backend/src/modules/phone/`): every linked citizen is
  auto-issued a phone number on first use, then a server-authoritative app stack
  — contacts, SMS (`inbox` marks read), a call state machine (ringing/connected/
  ended/missed, online-aware via presence, no audio in Bedrock), bank transfer by
  number (`economy.transfer`), GPS waypoints, a **taxi job board** (fare-backed,
  requester→driver paid on completion; drivers need `phone.taxi.manage`), and a
  **911-style emergency call** board (dispatch = `phone.emergency.view/manage`,
  granted to police + ems; admin can close). Bridge `/bridge/phone/*`, admin
  `/admin/phone/*` (numbers/emergency/taxi), player web phone card, `!phone`
  in-game. All writes audited (`phone.*` actions).
- **Admin surface**: audit-log viewer (`GET /admin/audit`, incl. `before/after/reason`),
  multi-currency economy reads (`GET /admin/economy/character/:id`), container CRUD,
  character update/view (locked-field approval path).
- **Control API**: `/control` — external machine API (key-auth `x-control-api-key`,
  constant-time) for the admin EXE / AI-automation: `ping`, `status`, `players`,
  `audit`, `security/events`, `health`, `monitoring`, `resources/*`, `backups/*`,
  `wipe/*`. An optional `x-control-actor-user-id` header attributes calls to a
  staff user in the audit log. A zero-dependency CLI (`tools/control-cli.mjs`)
  wraps it for scripts/EXE use. See "Control API" below.

Integration suite (`backend/src/test/integration.test.ts`) runs against a throwaway
`bedrock_rp_test` DB (33 tests: auth, character create/link/delete/details-lock-case,
bridge secret/signature/replay, presence + stale-heartbeat, RBAC, economy
cash/bank/red-money/anomaly/idempotency, inventory weight + containers, cases,
security events, vehicles full lifecycle, properties full lifecycle, police
lifecycle, ems lifecycle, phone lifecycle, control API key-auth/status/audit,
control resources, control backup/wipe/restore).
Spec: `npm run migrate`, `npm run build`, `npm test` (needs `ops` docker stack up).

**Not locked yet** — do not assume:
- Exact BDS + Script API version (`@minecraft/server` is stable/2.0.0, but `@minecraft/server-net` is still Beta and its manifest version string is tied to your exact BDS build — see the note in `behavior_pack/manifest.json`)
- Discord bot library (this iteration talks to Discord's REST API directly with `fetch`, no `discord.js` — revisit if bot-side features are needed later)
- Deployment target (bare metal / Docker host / cloud)
- Voice provider (out of scope this iteration)

## Layout

```
behavior_pack/     BDS behavior pack — scripts run in-game, talk to backend over HTTP
resource_pack/     stub, empty until content work starts
backend/           Node/TS service — owns DB, RBAC, economy ledger, audit log
backend/migrations/ raw SQL, run in order, no ORM auto-migrate
ops/               docker + deploy tooling: dev compose (postgres + redis), prod
                   compose, backup script, .env.prod.example, runbook
docs/              MASTER_PROMPT.md (source of truth for rules), original prompt pack
CHANGELOG_AI.md    every AI iteration appends an entry — never edit history
AI_HANDOFF.md      current state for the next AI/session
```

## Local dev

```bash
cd ops && docker compose up -d        # postgres + redis
cd ../backend
cp .env.example .env                  # fill in real values
npm install
npm run migrate                       # applies backend/migrations/*.sql in order
npm run dev
```

**BDS on WSL2 (Windows dev machines):** if the Windows Minecraft client
gets "Multiplayer Connection Failed" / NetherNet trying to join a BDS
instance running inside WSL2, WSL2's default NAT networking is not
forwarding Bedrock's UDP traffic (port 19132). Fix: add
```
[wsl2]
networkingMode=mirrored
```
to `%USERPROFILE%\.wslconfig`, then `wsl --shutdown` and restart WSL.

Behavior pack: symlink or copy `behavior_pack/` into your BDS
`development_behavior_packs/` folder, enable it in `world_behavior_packs.json`,
and turn on the Beta APIs experimental toggle for the world (required for
`@minecraft/server-net`). BDS's default `config/default/permissions.json`
already allows `@minecraft/server-admin` but does NOT include
`@minecraft/server-net` — add it manually to `allowed_modules` or the
pack will fail to load. Then set `bedrock-rp:backendUrl` and
`bedrock-rp:bridgeSecret` in your BDS `variables.json` (same secret as
`BDS_BRIDGE_SECRET` in the backend's `.env`) — see `behavior_pack/scripts/bridgeConfig.js`.

**Getting the Beta APIs experimental toggle onto a BDS world**: BDS has
no UI for this. The reliable approach found during development: create
a new world in the Minecraft client with the "Beta APIs" experiment
enabled, then copy that world's `level.dat` into your BDS world folder
(the `db/` chunk data can stay BDS-native — only `level.dat` carries the
experiment flag). **Important**: a client-created world defaults to
`MultiplayerGame=0`, `XBLBroadcastIntent=2`, `PlatformBroadcastIntent=2`
— these force the client to attempt Xbox Live/NetherNet signaling
validation that a locally-run BDS instance can't satisfy, causing every
join attempt to fail with a generic "Multiplayer Connection Failed" /
NetherNet error before the connection even reaches the server. Patch
these three NBT fields in `level.dat` to `1`, `0`, `0` respectively
(matching a BDS-native world) before players can join. `level.dat` is
binary NBT (little-endian, 8-byte header before the NBT payload) —
use `tools/leveldat_patch.py` (pure Python stdlib, no dependencies):

```powershell
python tools\leveldat_patch.py "path\to\world\level.dat"   # patches in place (writes a .bak)
python tools\leveldat_patch.py "path\to\level.dat" --check # just report current values
python tools\leveldat_patch.py "path\to\level.dat" --dry-run
```

The patcher rewrites only those three top-level values (leaving every other
byte, including nested compounds and your custom world data, untouched), is
idempotent (re-running on an already-patched file reports "ok" and does nothing),
and refuses to write if any of the three fields is missing or of the wrong type
(exit 3) or if the file isn't parseable NBT (exit 2). It auto-detects
little/big endian. Exit 0 = patched or already correct.

## Auth flow

1. Player/admin visits `GET /auth/discord/login` → redirected to Discord
2. Discord redirects back to `GET /auth/discord/callback?code=...`
3. Backend exchanges the code, upserts `users`, sets an httpOnly JWT
   session cookie. Browsers (Accept: text/html) are then redirected to
   `GET /player` — API clients still get the `{ok, discordTag}` JSON.
4. `/admin/*` routes read `req.userId` from that cookie (via
   `sessionMiddleware`) and then check RBAC permissions per-route

Needs `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`,
and `JWT_SECRET` set in `.env` — see `.env.example`.

Sessions are tracked server-side in a `sessions` table (one row per
issued JWT, keyed by its `jti` claim), not pure stateless JWT. This
means:
- `POST /auth/logout` actually revokes the session server-side, not just clearing the cookie
- Banning a user (`POST /admin/users/ban`) immediately revokes every one of their active sessions — no more waiting out a 7-day JWT expiry
- Every request with a session cookie does one extra DB lookup to check revocation — acceptable at this project's scale
- The JWT's `sub` claim is cross-checked against the `sessions` row its `jti` belongs to (`session.user_id === payload.sub`) — a signature-valid token with the right `sub` but an unrelated `jti` is rejected. Closes an impersonation path that would otherwise exist if `JWT_SECRET` were ever leaked.
- A periodic job (`startSessionCleanupJob()`, hourly) deletes `sessions` rows that are expired or revoked — pure table hygiene, doesn't affect any currently-valid session. `POST /admin/sessions/cleanup-check` (gated behind `auth.manage`, `013_auth_permission.sql`) triggers it immediately for ops/testing.

## Player web

`GET /player` serves a small embed-free panel (HTML/CSS/JS all served
from the backend itself — no static dir, no build step, everything lives
in `backend/src/web/playerWeb.ts`):

- logged out → "Login with Discord" button (`/auth/discord/login`)
- logged in but no character → one-field "create character" form
- logged in → character card (linked/whitelist status), a **generate
  link code** button (the web-side half of the `!link <code>` flow
  below), wallet with recent transactions, carried inventory with
  weights, and owned containers with their contents + capacity

It speaks nothing new — plain session cookies + same-origin `fetch`
against the existing `/character`, `/character/link-code`,
`/character/wallet`, `/character/inventory`, and `/inventories` routes.
`GET /` redirects here, and the Discord OAuth callback does too for
browser clients. The player router overrides the global
`Content-Security-Policy` on its three routes only (relaxed to
`default-src 'self'; script-src 'self'; ...`, still `frame-ancestors
'none'`, no inline scripts/styles) so the panel is actually usable while
the rest of the API stays locked down.

> **OAuth host rule:** the Discord callback only accepts the exact host
> registered as `DISCORD_REDIRECT_URI` (state cookies are host-bound), so
> the canonical origin is baked into the page (`<meta name="rp:origin">`)
> and the panel app JS auto-redirects there. Open the panel on
> `http://localhost:8080/` (or whatever matches that env var) — typing
> `127.0.0.1` still works, it just bounces you to `localhost` first.
> The OAuth callback also supports `?next=` (a same-origin path) to land
> a user somewhere specific after login — the admin console uses it to
> return staff to `/admin`.

## Admin web

`GET /admin` serves a staff console (same embed-free pattern —
`backend/src/web/adminWeb.ts`, no static dir, no build step). **It is
admin-only at the server:** `/admin`, `/admin/app.css` and `/admin/app.js`
all require a valid session holding the `auth.manage` permission (the
`owner` role and any role granting `auth.manage` pass; anonymous and other
logged-in users get `401`/`403` before any HTML is served — browsers see a
readable screen, API clients get JSON). The OAuth login link carries
`?next=/admin`, and the callback returns the user there after a successful
login. Every data read/write underneath still passes `sessionMiddleware` +
its own per-route RBAC check + the admin rate-limiter.

Tabs:

- **Overview** — online players (`GET /admin/presence/online`), one-click
  session-cleanup and trade-expiry job triggers (`sessions/cleanup-check`,
  `trades/expire-check`)
- **Users** — search (`?query=`), ban/unban, role matrix
- **Characters** — search, whitelist toggle, fallback details edit, wallet
  summary + `economy/grant`/`deduct`, inventory give/remove
- **Shop** — listing load / upsert (`POST /admin/shop/listing`) / remove
- **Cases** — list by status, detail thread, staff replies, status changes
- **Audit** — action-filtered audit log
- **Security** — severity/unacknowledged filter, ack on double-click
- **Roles** — role list with permissions, grant/revoke by user id
- **ตำรวจ** — MDT: citizen search (threat level / licenses / warrants /
  fines), per-citizen actions (license issue/suspend/revoke, fine issue+pay,
  warrant issue/revoke, arrest/release, record update), and
  fines/warrants/reports/arrests lists
- **หมอ** — EMS: medical record list (state / downed countdown / unpaid bills),
  bill waive, state reset
- **โทรศัพท์** — phone: assigned numbers, taxi ride log, emergency-call board
  (open/closed)

It's mounted *before* the rate-limited admin router in `app.ts`
(`/admin` assets bypass the 60/min limiter; the data calls underneath still
share it), and it only uses the relaxed WEB_CSP on its three asset routes.

Two read-only list endpoints were added for it:
`GET /admin/users` (`auth.manage`) and `GET /admin/characters`
(`character.view`), both with `?query=`, `?limit=`, `?offset=`.
The same canonical-origin auto-redirect as the player panel applies
(OAuth state cookies only survive on the host registered as
`DISCORD_REDIRECT_URI`).

## Control API

`/control` is the single external machine-to-machine surface for the future
admin EXE / admin web / AI-automation (roadmap: EXE/Web/AI → Control API →
backend → DB/Redis/BDS). Nothing but the backend ever touches the database —
control clients never connect to PostgreSQL/Redis directly.

- **Auth**: `CONTROL_API_KEY` (required config, min 16 chars) sent as the
  `x-control-api-key` header; compared constant-time. Wrong/missing key → `401`
  plus a HIGH `control_invalid_key` security event. Independent credential from
  the bridge secret (pack) and `JWT_SECRET` (browser).
- **Attribution**: optional `x-control-actor-user-id` header names the staff
  user behind a call (validated, audit-only — it never authorizes). Calls with
  an actor write a `control.call` audit row; bare read GETs are not audited per
  request so status polling doesn't flood the log.
- **Endpoints**:
  - `GET /control/ping` — app identity, version, server time (config check)
  - `GET /control/status` — process (uptime/pid/node/memory) + DB/Redis health
    with latency + online players (presence)
  - `GET /control/players` — characters with live `isOnline` overlay
    (`?query=`, `?limit=`, `?offset=`)
  - `GET /control/audit` — recent admin-action tail (`?action=`, `?actorUserId=`)
  - `GET /control/security/events` — Security Center tail
    (`?severity=`, `?acknowledged=`)
  - `GET /control/health` — key-authenticated readiness probe
  - `GET /control/monitoring` — one-call dashboard: system load/mem/disk,
    db+redis latency, online players, 1h error rate, open security events +
    economy anomalies
  - **Resources** (`/control/resources`, kind `http|docker|process`, per-kind probe):
    `GET` list (with live per-resource status), `GET /resources/:name`,
    `POST /resources` `{name, kind, target, version?, dependencies?[], commands?{verb→cmd},
    notes?}`, `PATCH /resources/:name` (update fields / `enabled`), `DELETE`, enable/disable,
    `GET /resources/:name/version`, and command verbs `POST /resources/:name/{install|update|restart|status}`
    (any verbs registered in `commands`). Audited `control.resource.*`.
  - **Backups** (`/control/backups`, dumps land in `BACKUP_DIR`):
    `GET` list, `POST` create (SQL dump of the schema + COPY data, sha256
    checksummed), `GET /backups/:id`, `POST /backups/:id/verify` (size + checksum +
    SQL-syntax replay check), `POST /backups/:id/restore` — **full replace**: each
    table `TRUNCATE ... RESTART IDENTITY CASCADE`, COPY replayed in FK-dependency
    order, serial sequences reseeded, status marked `restored`. Audited `control.backup.*`.
  - **Wipe** (`/control/wipe`): `POST /wipe/dry-run` — previews counts (users,
    characters, tables) + a short-lived confirmation token (10 min); `POST /wipe/confirm`
    `{confirmationToken, mode: schema|data, autoBackup?, passphrase?}` — backs up
    first when `autoBackup`, then wipes (`DROP SCHEMA public CASCADE` + re-migrate for
    `schema`) or truncates all tables (`data`), and fires a CRITICAL `control_wipe_confirm`
    event. Optional second factor via config `WIPE_PASSPHRASE`. Audited `control.wipe.*`.
- Rate-limited (`controlLimiter`, default 120/min/IP) and every unexpected
  handler failure raises a MEDIUM `control_handler_error` event.

### Control CLI

`tools/control-cli.mjs` is the zero-dependency control client (Node ≥ 18, `fetch`
only — no npm packages, no DB access). It wraps the whole Control API for the
admin EXE / scripts / AI-automation:

```
CTL_BASE_URL=http://127.0.0.1:8080 CTL_API_KEY=... node tools/control-cli.mjs <verb> [args] [--flags]
```

Subcommands: `ping`, `status`, `health`, `players`, `audit`, `security`,
`monitoring`, `resources` (`list`/`show`/`register`/`update`/`unregister`/
`enable`/`disable`/`version`/`install`/`update`/`restart`/`status`), `backups`
(`list`/`create`/`show`/`verify`/`restore`), `wipe` (`dry-run`/`confirm`).
Env: `CTL_BASE_URL` (default `http://127.0.0.1:4000`), `CTL_API_KEY` (required),
`CTL_ACTOR` (optional user-id for audit attribution). Exit 0 on a business answer
(including `ok:false`), 1 on network/usage errors. Full usage in the file header.

A standalone EXE of the same CLI is built with `vercel/pkg` (no Node install
needed on the target box):

```
# from tools/ — builds Windows + Linux binaries into tools/dist-exe/
npx pkg .
```

Emits `tools/dist-exe/bedrock-rp-control-cli-win.exe` and
`tools/dist-exe/bedrock-rp-control-cli-linux`.
`tools/control-cli.cjs` is the CommonJS entry pkg bundles; the build config lives
in `tools/package.json` (`pkg.targets`: `node18-win-x64`, `node18-linux-x64`).
The EXE reads the same `CTL_*` env vars and exits with the same codes as the
`.mjs` form. `tools/dist-exe/` is git-ignored — but you don't need to build by
hand: CI does it for you.

Automated builds:
- Every push runs the `build-exe` CI job (`ci.yml`) and uploads
  `tools/dist-exe/*` as a **workflow artifact** (Actions → run → Artifacts) —
  always fresh, no local toolchain needed.
- Pushing a tag `v*` (e.g. `git tag v1.0 && git push origin v1.0`) triggers
  `.github/workflows/release.yml`, which attaches `bedrock-rp-control-cli-win.exe`
  and `bedrock-rp-control-cli-linux` to a **GitHub Release** with generated
  release notes — the downloadable binaries for the ops box.

## Inventory

- `POST /admin/inventory/give` `{characterId, itemId, quantity}` — admin-only, audited, stacks onto existing slots up to `max_stack` then fills empty slots, throws `409` if there's no room left
- `POST /admin/inventory/remove` `{characterId, itemId, quantity}` — admin-only, audited, removes from lowest slot index first, throws `409` if the character doesn't have enough
- `GET /character/inventory` — session-authenticated, returns the caller's own character's inventory (no RBAC — everyone can see their own items)

A few sample items (`rp:bandage`, `rp:id_card`, `rp:cash_stack`) are
seeded by `004_seed_items.sql` for testing; real item catalog design is
future work.

In-game UI (behavior pack, `@minecraft/server-ui`): players open the RP
inventory — a separate system from the vanilla backpack — by right-clicking
("use") a **compass** (placeholder trigger item; `!inv` / `!inventory` /
`!bag` in chat work as a fallback). It lists the character's carried slots +
owned containers with weights, and moves items between them. All
reads/writes go through the signed bridge endpoints below; identity is the
player's persistentId (no client-supplied character id), and containers
belonging to someone else return `403`.

On first spawn each entry, the pack checks the backend: an account that
isn't linked pops the link-code form automatically; a linked one gets a
single "เชื่อมต่อแล้ว" confirmation (won't nag again until they leave and
rejoin). Verified live on BDS 1.26.45.1 with a real client (chat interception
still works via `world.beforeEvents.chatSend` — the `@minecraft/server-chat`
module is NOT bundled on this build, do not migrate to it).

- `POST /bridge/inventory/view` `{playerId}` — character slots + carry
  weight/limit + owned containers (with contents + used weight). `404`
  if that persistentId isn't linked to a character.
- `POST /bridge/inventory/move` `{playerId, itemId, quantity, from, to}` —
  `from`/`to` are `"character"` or a container id; moves character↔container
  or container↔container (same owner). Atomic, weight/capacity-enforced,
  all the same 409/403/404 protections as the player routes (see
  `backend/src/modules/bridge/index.ts`).

In-game staff commands run through the same signed bridge channel
(`behavior_pack/scripts/admin_commands.js`). The pack forwards the *actor's*
own persistentId and the backend re-checks RBAC server-side — the pack is
never trusted to decide who may run something. A denied attempt returns `403`
and is recorded as a HIGH `staff_command_forbidden` security event.

- `!give <player> <amount> [cash|bank|red_money]` (permission `economy.grant`)
  → `POST /bridge/admin/give` `{actorName, actorPersistentId, targetName,
  targetPersistentId, amountCents, currency}` — grants money from the staff
  player to an online player's wallet (mirrors `POST /admin/economy.grant`;
  audited + ledgered). Unlinked actor/target → `404`.
- `!deduct <player> <amount> [cash|bank|red_money]` (permission
  `economy.grant`) → `POST /bridge/admin/deduct` — claw money back,
  anti-negative (insufficient funds → `409`). Same auth/RBAC/audit path as
  `!give`.

Self-grants are allowed: the same RBAC + audit rules that govern
`/admin/economy/grant` apply, so staff can fund their own character.

## Police / MDT

Officers use `!police` / `!mdt` in-game. All commands run through the signed
bridge channel under `/bridge/police/*` and the backend re-checks the *actor's*
police permission (`police.view`/`police.manage`/`police.admin`) server-side —
the pack is never trusted. Denied attempts → `403` + a HIGH
`staff_command_forbidden` security event.

- Officer: lookup a citizen (record / licenses / fines / warrants / arrest),
  lookup a vehicle by plate, then from the citizen hub issue/suspend/revoke a
  license, issue a fine, issue (manage) / revoke (admin-only) a warrant,
  arrest (auto-executes an open arrest warrant) / release, and update the
  threat-level record.
- Citizen: `!police` shows your own licenses / fines (with pay) / warrants /
  arrest status; the player web ("ตำรวจ" card, `POST /character/fines/:id/pay`)
  works too.
- Fines are a money sink: `payFine` debits the citizen (economy debit,
  `refType='fine'`), the cash leaves circulation, and the fine row is locked so
  a double-pay can't race (409).
- Arrest/jail is server-authoritative (`jailed_until`); v1 enforcement
  teleports a still-jailed player to jail on spawn/join — a player already in
  the world keeps playing until the next spawn (documented limitation).
  `PRISON_SPAWN` in `behavior_pack/scripts/police_ui.js` is a placeholder.

Admin MDT: `/admin/police/*` routes + the "ตำรวจ" web tab (reads `police.view`,
writes `police.manage`, warrant revoke + early release `police.admin`).

## EMS / emergency

Medics use `!ems` / `!medic` (mirrors the police UI conventions). Health state is
server-authoritative on `medical_records`:

- Every citizen has a dossier (`ensureMedicalRow`, created on first read).
- `healthy → downed`: the citizen (or medic, via `!medic` dossier) reports them
  downed — `/bridge/ems/down`; also fired by the pack death hook
  (`/bridge/ems/death`). A downed player has an expiry window
  (`EMS_DOWNED_EXPIRY_SECONDS`, 900s) — reading a past-due downed state lazily
  rolls it to `dead` (spawn enforcement kicks in).
- `downed → treated`: medic `rescue`; `treated → healthy`: medic `treat` (issues a
  `MEDICAL_BILL_CENTS` bill, a deliberate money sink — pays via `/bridge/ems/bill/
  pay` or the player web card).
- `dead`: must respawn at the hospital. On spawn the pack calls
  `/bridge/ems/hospitalize` (returned to `healthy`, `hospitalization_count + 1`,
  hospital bill issued). `HOSPITAL_SPAWN` in `behavior_pack/scripts/ems_ui.js` is
  a placeholder — set the real hospital point.
- Medic lookup `!medic → ค้นหา` uses `searchMedical(query)` (name or citizen id),
  returning the dossier + unpaid bills. Non-medics are refused server-side (HIGH
  `staff_command_forbidden` event).

Admin EMS: `/admin/ems/*` (`records`, `bills`, `waive`, `reset`; reads
`ems.view`, writes `ems.manage`/`ems.admin`); player web "หมอ" medical card
(`GET /character/medical`, inline bill pay).

## Phone / mobile

Every linked citizen is issued a phone number on first use (`/bridge/phone/me`).
`!phone` opens the app menu — contacts, SMS, calls, bank, GPS, taxi, emergency.

- **Calls** are a server-authoritative state machine (ringing → connected → ended |
  missed). Calling an offline number records a missed(offline) call immediately;
  an online callee gets a ringing call they accept/decline from their own phone.
  `PHONE_CALL_CHANGED` / `PHONE_MEDICAL_CHANGED` eventbus events are the hook for
  future voice/realtime providers — there is no audio in Bedrock.
- **Taxi**: anyone requests a ride (pickup coords + destination + fare); drivers
  (`phone.taxi.manage`) see the job board (`!phone → แท็กซี่`) and accept; on
  completion the fare moves requester→driver via `economy.transfer`. Cancellable
  while pending.
- **Emergency 911**: anyone files an open call (category/coords); dispatch sees
  the board (`phone.emergency.view`, granted to police + ems + admin) and closes
  with a note. Admins can close from `/admin/phone/*`.
- All phone writes are audited (`phone.contact.*`, `phone.message.send`,
  `phone.call.*`, `phone.gps.*`, `phone.taxi.*`, `phone.emergency.*`).

Admin phone: `/admin/phone/*` (`numbers` directory, `emergency` board + close,
`taxi` board; reads `phone.view`/`phone.emergency.view`, writes
`phone.emergency.manage`/`phone.taxi.manage`). Player web "โทรศัพท์" card
(`GET /character/phone`).

## Roles & permissions

`005_seed_permissions.sql` seeds four permission keys
(`economy.grant`, `character.whitelist`, `inventory.give`,
`inventory.remove`) and grants all of them to the `admin` role,
`character.whitelist` only to `moderator`. `027_police.sql` adds
`police.view` / `police.manage` / `police.admin` (granted to the `admin`
role, and `police.view`+`police.manage` to a new rank-5 `police` role for
field officers). `028_ems.sql` adds `ems.view` / `ems.manage` / `ems.admin`
(granted to `admin`, and `ems.view`+`ems.manage` to a new `ems` role for
medics). `029_phone.sql` adds `phone.view` / `phone.manage` /
`phone.taxi.manage` / `phone.emergency.view` / `phone.emergency.manage`
(granted to `admin`; police + ems share the two emergency-dispatch perms).
`owner` bypasses RBAC checks entirely regardless of grants
(see `rbac/index.ts`).

- `POST /admin/roles/grant` `{userId, roleName}` — assign a role to a user
- `POST /admin/roles/revoke` `{userId, roleName}` — remove a role from a user

Both are gated behind `rbac.manage_roles`. As of `012_role_hierarchy.sql`,
`admin` is granted this permission too, but a rank hierarchy is enforced
in code (`rbac/admin.ts`): an `admin` can only grant/revoke roles ranked
strictly below their own (`moderator`), never `admin` or `owner` — this
closes the self-escalation risk that would otherwise come with handing
out role-management to a non-owner role. `owner`'s RBAC bypass is
unaffected and can still manage any role.

## Rate limiting

Three tiers (`src/middleware/rateLimit.ts`), all IP-keyed via
`express-rate-limit`:
- `/auth/*` — 10 requests / 15 min (brute-force/credential-stuffing surface)
- `/bridge/*` — 120 requests / min (generous — a busy server with many players is legitimate traffic)
- `/admin/*` and `/character/link-code` — 60 requests / min

If deploying behind a reverse proxy/load balancer, configure Express's
`trust proxy` setting correctly or every request will appear to come
from the proxy's IP, making the limiters useless.

## Trading

Player-to-player trading (`src/modules/trade/`), session-authenticated,
always resolves "my character" from the session — never trusts a
client-supplied character id as the caller's own.

- `POST /trade/propose` `{counterpartyCharacterId, give: {cents?, itemId?, itemQty?}, want: {cents?, itemId?, itemQty?}}` — proposes a full trade (what I give, what I want back); nothing moves yet
- `POST /trade/:id/accept` — counterparty only; moves both sides atomically in one transaction. If either side can't afford their part (insufficient funds/items/no inventory room), the whole trade rolls back and neither side loses anything — this is the core anti-scam guarantee
- `POST /trade/:id/decline` — counterparty only
- `POST /trade/:id/cancel` — initiator only
- `GET /trade/pending` — my pending trades (either side)

There is deliberately no counter-offer/negotiation flow in this
version — the initiator proposes complete terms, the counterparty can
only accept or decline. A rejected offer needs a fresh `propose` call
with new terms.

**Expiry**: a periodic in-process job (`startExpiryJob()` in
`src/modules/trade/index.ts`, started at backend boot) marks any
`pending` trade older than 24 hours as `expired` — checked every hour.
Since nothing ever moves for a pending trade, expiring one is just a
status flip, no rollback needed. `POST /admin/trades/expire-check`
(gated behind `trade.manage`, `011_trade_permission.sql`) triggers the
same sweep immediately, mainly for ops/testing rather than waiting for
the next hourly tick.

## Shop

NPC shop (`src/modules/shop/`), session-authenticated, buy/sell against
a shared catalog. `009_shop.sql` seeds `rp:bandage` (buy 50¢, sell 20¢,
unlimited stock).

- `GET /shop/catalog` — list what's buyable/sellable and at what price (no auth required — public catalog)
- `POST /shop/buy` `{itemId, quantity}` — pays `buy_price_cents * quantity`, decrements stock if the listing has a finite stock, adds the item to the caller's inventory. Rolls back entirely on insufficient funds, out of stock, or no inventory room.
- `POST /shop/sell` `{itemId, quantity}` — removes the item from the caller's inventory, pays `sell_price_cents * quantity`, increments stock if finite. Rolls back entirely on insufficient items.

A `shop_listings` row with `buy_price_cents = NULL` isn't purchasable
from the shop (display-only or sell-only item); `sell_price_cents = NULL`
means the shop won't buy it back. `stock = NULL` means unlimited.

Admin catalog management (`shop.manage` permission, `010_shop_permission.sql`):
- `GET /admin/shop/listing/:itemId` — see a listing's current values before overwriting them with the upsert route below. 404 if not listed.
- `POST /admin/shop/listing` `{itemId, buyPriceCents, sellPriceCents, stock}` — create or update a listing. Fields are explicitly nullable (send `null` to mean "not purchasable"/"not sellable"/"unlimited") — omitting a field is NOT the same as sending `null`.
- `POST /admin/shop/listing/remove` `{itemId}` — delete a listing entirely

## Linking a Discord character to a Bedrock account

A character is created via Discord OAuth2 (one Discord account = one
character), but the in-game persistentId isn't known until the player
actually joins with Minecraft. To connect the two:

1. Logged-in user calls `POST /character/link-code` (session cookie
   required) → gets back a short code like `A3F9K2`, valid 15 minutes
2. Player joins the Bedrock server and types `!link A3F9K2` in chat
   (NOT `/link` — Minecraft treats a leading `/` as a game command and
   intercepts it client-side with "Cheats aren't enabled in this world"
   before it ever reaches the behavior pack, unless the world has
   cheats/commands on. `!link` is a plain chat message, so it reaches
   our `chatSend` handler regardless of the world's cheat settings.)
3. The behavior pack intercepts that chat message (never broadcasts it),
   calls `POST /bridge/character/link` with the code + the player's
   persistentId
4. Backend validates the code hasn't expired/been used, checks the
   persistentId isn't already linked to a different character, then sets
   `characters.persistent_id` and clears the code — one-time use

**Caveat, RESOLVED**: earlier versions of this doc warned that
`event.playerId`/`player.id` might not be the real xuid — confirmed
true. The correct identifier is `@minecraft/server-admin`'s
`beforeEvents.asyncPlayerJoin` event's `persistentId` field, which is
what `behavior_pack/scripts/main.js` actually uses now. It is an opaque
"stable across sessions" identifier per Mojang's docs — not necessarily
the literal Xbox Live xuid string, but stable and unique per player,
which is all the linking scheme needs. The backend stores this
persistentId value in the `characters.persistent_id` column (renamed
from the old `characters.xuid`, which was a holdover name from before
this was understood). The external wire fields (`xuid` on
`/bridge/character/link`, `playerId` on `/bridge/player/join`) are kept
unchanged for compatibility with the deployed behavior pack.

## Rules

See `docs/MASTER_PROMPT.md`. In short: client is never source of truth,
every admin action and money/item transaction is audited, no mock code
pretends to be production-ready, every task ends with a `CHANGELOG_AI.md`
entry and an updated `AI_HANDOFF.md`.
