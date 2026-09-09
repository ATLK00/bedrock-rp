# AI Handoff

## Project State
- Version: 0.1.0
- This handoff describes the project state at commit `fd50a2e` (see Version Control).
- NOT a blanket "fully verified" claim: the core feature set is verified against
  real infrastructure; a small set of infrastructure-dependent paths remains
  explicitly unverified (listed below under **Unverified**).

## 2026-09-09 Round 7 — `!deduct` in-game (mirror of `!give`) + allow self-grant

- User tested `!give` live and hit the pack's self-grant refusal ("can you
  grath money to yourself in-game"). Removed that client-side guard: backend
  RBAC + audit already govern self-grants exactly like `/admin/economy/grant`,
  and staff legitimately fund their own character for setup/testing.
- Added `!deduct <player> <amount> [currency]` — the proven `!give` pattern
  factored into three shared backend helpers (`parseMoneyVerbBody`,
  `authorizeStaffActor`, `resolveTargetCharacter`) so give/deduct share one
  implementation path: same RBAC (`economy.grant`), same HIGH
  `staff_command_forbidden` event on deny, `InsufficientFundsError` → 409
  (no overdraft). Pack side: `handleDeduct` mirrors `handleGive`.
- Suite stays **24/24** (deduct asserts added to the bridge admin give
  subtest: claw-back balance change, over-deduct 409, non-staff 403 + event).

## 2026-09-09 Round 6 — in-game staff command `!give` (authorized on the actor's identity via RBAC)

- User's "จัดมา" led here after the admin web + CI were green. The gap:
  staff had no way to grant money in-game — only the web admin console.
- New bridge endpoint `POST /bridge/admin/give`
  (`backend/src/modules/bridge/index.ts`): body
  `{ actorName, actorPersistentId, targetName, targetPersistentId,
  amountCents, currency? }`. The actor's own character is resolved from
  their persistentId → Discord user → `hasPermission(economy.grant)`.
  **The pack is never trusted for authorization** — a player without the
  permission is refused server-side (403) and the attempt is recorded as a
  HIGH `staff_command_forbidden` security event (Security Center / admin
  web tab). Target is resolved by persistentId too; unlinked target or
  actor → 404. Delegates to `economy.grant` (audited + ledgered, all
  currencies cash/bank/red_money).
- Behavior pack: new `behavior_pack/scripts/admin_commands.js`
  (`tryHandleAdminCommand`, chat triggers `!give <player> <amount>
  [cash|bank|red_money]`), wired into main.js's `chatSend` interceptor
  (cancel + never hits public chat) right before the `!inv` hook. Guarded
  client-side: amount cap, self-grant refusal, online-only targets — but
  these are UX niceties, the real gate is the backend RBAC.
- Suite grew to 24/24 (new "bridge admin give" subtest: owner success on
  cash+bank, wallet assertions, 400 on bad amount/currency/missing
  identity, 403 + security-event assert for a no-role actor, 404 for an
  unlinked target). `node --check` verified on both pack JS files.
  Live deploy still pending on your WSL2 BDS side (copy behavior_pack
  changes to `~/bds/behavior_packs/bedrock-rp-core/` + restart).

## 2026-09-09 Round 5 — admin console is now server-side admin-only + `?next=` login return

- User: "แอดมินนัมนควรเข้าได้แค่แอดมินดิ" (the admin console should only
  be openable by admins). The `/admin` SPA previously served its static
  shell anonymously (JS gated the data). Now **all three `/admin` routes
  (`/`, `/app.css`, `/app.js`) require a valid session holding `auth.manage`**
  at the server (`adminShellGuard` → `hasPermission`). Anonymous and
  logged-in-but-not-admin users get `401`/`403` before any HTML/JS/CSS is
  served; browsers (Accept: text/html) get a readable "ต้องเป็นแอดมิน /
  ไม่มีสิทธิ์ (auth.manage)" screen, API clients get JSON. The player panel
  `/player` is unchanged (200 for anonymous).
- OAuth `?next=` return path: login now accepts `?next=/admin` and the
  callback redirects the browser back there after a successful login
  (`AUTH_NEXT_COOKIE`, sanitized to a same-origin path only — no open
  redirect; cleared on consume/state-error). Admin boot screen uses it so a
  staff user who lands logged-out ends up back at `/admin`.
- Suite stays **23/23** (admin-web test tightened to assert 401 anon / 403
  non-owner / 200 owner on the shell + 401 assets for anon). Live-verified:
  `curl /admin` → 401 (both html and api accept), assets 401, `/player` 200.

## 2026-09-09 Round 4 — OAuth state host-mismatch fix + friendly error (HEAD; committed as the next commit)

- **The first real-browser login attempt hit `{"error":"invalid state"}`**
  (3 × `oauth_state_missing` in security_events, 16:26–16:27 local).
  Cause confirmed from the events + `.env`: `DISCORD_REDIRECT_URI` is
  `http://localhost:8080/...` but the panel was opened on
  `127.0.0.1:8080` — the state cookie is host-bound, so Discord's callback
  on `localhost` never received it. Neither branch is a bug on its own; the
  two hosts just must match.
- **Fix (prevents recurrence):** both panels now bake the canonical origin
  (`DISCORD_REDIRECT_URI`'s origin) into the page via
  `<meta name="rp:origin">`, and the panel app JS redirects there
  immediately when `location.origin` differs — so opening `127.0.0.1`
  bounces to `localhost` before any login attempt. Verified live: meta
  present on both panels, both `app.js` still pass `node --check`.
- **Friendly callback error:** `stateErrorResponse()` in `auth/routes.ts` —
  a state-missing/mismatch callback now returns a readable Thai HTML page
  (with the canonical `localhost` link) for `Accept: text/html` browsers,
  and keeps the JSON `{"error":"invalid state"}` for API clients. The
  security events (MEDIUM/HIGH, ip, requestId) still fire as before.
- Suite stays **23/23**, build clean.

## 2026-09-09 Round 3 — admin web panel + web-JS escape fix (HEAD; committed as the next admin-web commit)

- **Admin Web built** (MASTER_PROMPT §22, top Pending item):
  `backend/src/web/adminWeb.ts` serves `GET /admin`, `/admin/app.css`,
  `/admin/app.js` (embed-free, same pattern as the player panel, shared
  `WEB_CSP`). Tabs: overview (presence + cleanup-check/expire-check), users
  (search/ban/unban/roles), characters (whitelist, details, wallet
  grant/deduct, inventory give/remove), shop listing, cases thread/reply/
  status, audit filter, security feed+ack, roles matrix.
- Page shell is **served anonymously** (static, no data, CSP-locked, app JS
  boots to a Discord-login screen on the first 401) — consistent with the
  player panel; every data call still hits RBAC + rate-limit through the
  existing admin router. Mounted in `app.ts` BEFORE the rate-limited
  `adminRouter` so assets bypass the 60/min limiter while the JSON routes it
  calls keep sharing it.
- Two new read-only admin list endpoints the UI consumes:
  `GET /admin/users` (`auth.manage`) and `GET /admin/characters`
  (`character.view`), both with `?query=`, `?limit=`, `?offset=`.
- **Bug found via `node --check` on the live-served JS** (HTTP tests can't
  catch it): `\"` inside the TS template literals emitted a bare `"` to the
  browser, breaking the injected JS in BOTH panels (player and admin) at
  runtime. Fixed by emitting `\\"` so the served output keeps the escaped
  quotes. The player web shipped this bug in `ee21dd4`; this round fixes it.
  Now `node --check` passes on `/admin/app.js` AND `/player/app.js` exactly as
  served by the live server, and UTF-8 Thai strings in both panels were
  verified intact in the served bytes.
- Suite 21 → **23/23 PASS** (new test: `admin web: page + assets + list
  endpoints` — anonymous shell 200, assets serve correct MIME, list endpoints
  return data + narrow on `?query=`, wrong-permission user gets 403). The
  prior "anonymous /admin → 401" assertion was changed to 200: the shell is
  static/gated nowhere, only the data behind it is.
- Verification: `npm run build` clean; live on port 8080 — `/admin` 200
  text/html + WEB_CSP header, `/admin/app.js` 200 application/javascript
  (`node --check` clean), anonymous `/admin/users` → 401 JSON.

## 2026-09-09 Round — backend foundation batch (big-pickle/opencode)
- Applied migrations **001–024** (new: `018_character_details`, `019_audit_columns`,
  `020_inventory_weight`, `021_economy_currencies`, `022_idempotency`, `023_security_events`,
  `024_cases`), all cleanly applied on the dev DB (`npm run migrate` skips all).
- **Automated integration suite is now 20/20 PASS** against the real docker stack
  (fresh `bedrock_rp_test` DB, migrations 001–024). New coverage: character
  details/confirm/lock + case-approval path, bank/red_money economy + anomaly +
  idempotency replay/mismatch, weight-aware inventory + container lifecycle,
  cases lifecycle, security-center feed/ack, health/readiness + security headers,
  stale-heartbeat does not resurrect presence, parallel-debit row-lock safety
  (no overspend), container exact-fill boundary, case permission matrix (privacy
  + staff scope).
- New modules: **Security Center** (`security_events` feed), **idempotency**
  (`idempotency_keys`, mis-match → 409), **cases/tickets** (player + staff routes).
  Extended: character (profile confirm/lock + change-request case flow), economy
  (currency-aware, anomalies), inventory (weight + containers), player_session
  (concurrent-join idempotency, stale-heartbeat guard), admin (audit viewer,
  security center, cases, container CRUD, character update/view), auth routes
  (OAuth `state` login-CSRF + failure events), middleware/app (CORS allowlist,
  security headers, `/health/live|ready`, fail-fast timeouts, bridge secret/sig
  failures → security events).
- Fixed by the new tests: (1) `$1` parameter collision in character details
  UPDATE statements (details PATCH 500); (2) container-ownership strict compare of
  `Number` vs pg-string (players got 403 on their own containers); (3) admin
  `economy/grant` now maps idempotency mismatch → 409 like `deduct`; (4)
  `getWalletSummary` coerces BIGINT bank/red_money to numbers.
- Version-control note: this round is committed as `62f1ee8` (sits on top of
  the frozen anchor `fd50a2e`).
- Full details in `CHANGELOG_AI.md` (2026-09-09 03:00 entry).

## 2026-09-09 Round 2 — retention jobs, edge tests, rate-limit bugfix (`f70984d`)
- New jobs (daily, started at boot, env-tunable): `sweepAcknowledgedSecurityEvents`
  (acknowledged-only: unresolved threats never dropped) and
  `sweepExpiredIdempotencyKeys` (keys only need to outlive the retry window).
  Config: `SECURITY_EVENT_RETENTION_DAYS=90`, `IDEMPOTENCY_KEY_RETENTION_DAYS=7`.
- Edge-case tests added (suite 17 → 20): (17) 10 parallel bank debits against a
  5000 balance settle exactly 5/5 with the ledger ending at 0 — proves the
  per-account row-lock anti-double-spend under concurrency; (18) container
  capacity exact-fill boundary (950→1000 exact fits, 1050 rejects, remove 4
  then re-add exactly the freed space); (19) case permission matrix — user A
  cannot view/message user B's case, roleless B gets 403 on every `/admin/cases`
  route, staff access + per-user scoping holds.
- Real bug found & fixed by test 18's hang: the custom rate-limit `handler`
  (`tripHandler`) never sent a response when throttled — a client past the
  limit hung forever with no reply (suite's own admin traffic tripped the
  60/min `adminLimiter` mid-run). Throttled requests now get `429`. Limits are
  env-tunable (`RATE_LIMIT_AUTH_MAX`/`BRIDGE`/`ADMIN`) and the test env raises
  them sky-high so the suite exercises behavior, not throttling.
- Suite is 20/20 in ~5s on the docker stack.

## Verified (tested on real infrastructure)
- Backend HTTP surface exercised against a live Express instance on the real
  docker Postgres/Redis stack: auth session issue/verify/revoke,
  per-session logout, revocation on ban, rate limiting, jti/user_id
  cross-check; RBAC (permissions, boundaries, hierarchy, rank); audit log;
  economy (transfer/grant); character whitelist; inventory; trading
  (+ anti-scam rollback, + expiry job); shop (buy/sell + catalog management +
  single-listing read + stock-limit rollback) — all "real requests" here means
  HTTP requests to the running backend. The live Discord OAuth code-exchange
  (browser → Discord → callback) was NOT exercised (no real app) — see
  Unverified.
- Character lifecycle: `GET/POST/DELETE /character`, soft-delete keeps
  wallet/ledger history and clears the link; CSPRNG link codes. Verified at
  the HTTP layer; the in-game `!link` flow on a real Minecraft client is NOT
  verified — see Unverified.
- Player presence/session history: `POST /bridge/player/join|leave|heartbeat`
  (Redis presence TTL + Postgres `player_sessions` with a partial-unique "one
  open window" backstop; reconnect dedup verified at the HTTP layer, not with a
  live client).
- Automated integration test suite (`backend/src/test/integration.test.ts`) —
  fresh `bedrock_rp_test` DB each run, migrations 001–024 applied, HTTP-level
  coverage of auth/session, character, link, presence, RBAC, economy,
  inventory(meta+weight+containers), bridge auth, cases, security events.
  Last recorded run: 20/20 PASS on 2026-09-09 (docker stack up). NOT
  reproducible in an empty environment:
  IMPORTANT: this suite REQUIRES the docker Postgres/Redis stack to be up; in
  an environment with no stack running it exits with `ECONNREFUSED` and proves
  nothing. Treat any 20/20 result as tied to the stack it ran against, not as a
  property of the repo alone.
- Bridge hardening: HMAC-SHA256 request signing (drift window + Redis nonce
  replay rejection); legacy shared-secret-only clients still accepted. The
  pure-JS `crypto_hmac.js` is verified offline (RFC 4231 ASCII vectors +
  node:crypto multi-block/emoji cross-checks) and the *middleware/client* sides
  are covered by HTTP-layer tests; the full BDS pack → backend signed round
  trip on a live server is NOT verified — see Unverified.
- DB integrity pass (migration 017): hot-path indexes + slot consistency CHECK.
- Bugs found by the new suite and fixed: (1) `issueSessionToken` signed BIGINT
  ids as strings → every DB-derived session failed verification; (2) admin
  `/inventory/give` dropped `meta`; (3) `BridgeSignatureError.name` defaulted to
  "Error" → signature failures returned 500 instead of 401. Admin `/economy/
  deduct`, `/roles`, `/users/:id/roles`, `/presence/online` routes live.
- Session/jti security fix: `verifySessionToken()` cross-checks
  `session.user_id === payload.sub`, closing an impersonation path that existed
  if `JWT_SECRET` ever leaked.
- Session cleanup job: manual trigger cleaned up 5 stale rows; the calling
  (still-valid) session kept working; DB confirmed count went 5 → 1.
- `characters.xuid` → `characters.persistent_id` rename (migration
  `015_persistent_id_rename.sql`): constraint renamed to
  `characters_persistent_id_key`, no `xuid` column remains. Character/bridge
  modules use `persistent_id` internally; external wire fields (`xuid` on
  `/bridge/character/link`, `playerId` on `/bridge/player/join`) deliberately
  unchanged for behavior-pack compatibility. Admin routes now require an
  authenticated `req.userId`. TypeScript build passes.
- Working tree verified clean; no secrets in git history; `.env` ignored.
- `trust proxy` config verified end-to-end (2026-09-08) with a live Express
  instance + docker `nginx:alpine` reverse proxy in front:
  - With `TRUST_PROXY=1`, hammering `/auth/logout` (authLimiter, 10/15min)
    with `X-Forwarded-For: 1.2.3.4` gives 10×204 then 429 on the 11th, while a
    different value (`5.5.5.5`) still gets 204 — buckets are keyed per real
    client IP, i.e. `req.ip` resolves through the trusted proxy correctly.
  - With `TRUST_PROXY=false` (default) and XFF present, express-rate-limit v7
    does NOT key on the spoofed header; it logs its
    `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` validation warning once and falls back
    to the socket address (client still gets 200/204 — no 500, no silent
    mis-keying). So a wrong/no proxy setting fails loudly, not silently.
  - Caveat: hop count must match the real topology. `TRUST_PROXY=1` with a
    chain of two proxies (client-facing proxy → nginx → backend) resolves the
    client to the last untrusted hop (the first proxy's IP), by design. Test
    that value against the actual deployment shape before relying on it.

- Live BDS → backend chain for character session resolution + reconnect
  (raw `player_sessions` evidence, dated 2026-09-08, before the 2026-09-09
  foundation round): character `K2SirLao` (persistent_id `AC626455D87C6AD4`).
  Session 5 = join after `!link` → `character_id` auto-filled to 3, then closed
  (`left_at` set). Session 6 = **rejoin WITHOUT `!link`** → opened with
  `character_id = 3` again and `left_at = NULL`, heartbeat advanced
  `last_seen_at` (~19:30) until leave, then closed (`left_at` set). Later in the
  same window: session 7 (joined 19:31:11 right after session 6 left at 19:30:24,
  heartbeat trail to 19:39:47, closed 19:41:26) and session 8 (joined 19:41:26 —
  the exact ms session 7 closed — closed 19:41:47). Across all cycles: no
  overlapping open window (each opens only after the previous `left_at`),
  `character_id` auto-bound to 3 throughout, `left_at` always set — consecutive
  leave→rejoin persistence confirmed repeatedly. This closes
  join/presence/heartbeat/session-rotation/leave, `!link` consume, persistent-id
  binding, character-session-resolve, and leave→rejoin persistence.
- **Live re-smoke on CURRENT HEAD — DONE** (2026-09-09 03:00–03:04 UTC, rows
  dated 09-09): session 9 (opened 09-08 19:46:53, `last_seen_at` frozen at
  19:52:53, i.e. ~7h stalled with no heartbeat) was closed by the current
  join path at exactly 09-09 03:00:03 — the "close any still-open window
  first" reconnect semantics (`registerPlayerJoin`,
  `UPDATE ... SET left_at = now() WHERE left_at IS NULL`). Sessions 10
  (03:00:03→03:02:11) and 11 (03:02:47→03:04:06) chain cleanly: no `!link`
  needed, `character_id` auto-bound to 3, `left_at` set on every closed row,
  exactly one open window at all times (partial-unique backstop never
  triggered a visible conflict). The stale-window close + concurrent-join
  idempotency changes from the 09-09 round are now exercised live. (The
  strict "heartbeat-after-leave must not revive presence" drop is still only
  covered by the HTTP suite, not a live observation — optional deterministic
  curl check documented in session notes.)
- Discord OAuth: user-confirmed real sign-in completed on 2026-09-09 (browser →
  Discord authorize → callback → session issued). Recorded from user report;
  not independently observed in this environment.

## Unverified (needs infrastructure we don't have in a plain dev env)
- Live Minecraft round-trip — **VERIFIED end-to-end**, including a re-smoke on
  current HEAD (2026-09-09 rows, sessions 9/10/11 in Verified — the 09-09-round
  stale-window close + concurrent-join idempotency now exercised live). Covers
  join/presence/heartbeat/session-rotation/leave, `!link` code consume,
  persistent-id binding, character-session-resolve, leave→rejoin persistence
  (rejoin without `!link` kept `character_id = 3`), and no overlapping open
  windows. Residual only: the strict "heartbeat-after-leave drops presence" drop
  is HTTP-suite-covered but not yet observed live (deterministic curl check is
  documented/simple to run on the server).
- Real Discord OAuth — **VERIFIED**: user-confirmed live sign-in (2026-09-09) —
  browser → `oauth2/authorize` → callback → code exchange → session issued.
  Details recorded in the Verified block above.
- `trust proxy` upstream shapes: verified against a single-hop docker nginx
  (see Verified); multi-hop/load-balanced shapes still depend on the real
  deployment and the documented caveat applies.

## Pending (features/tooling not built yet — not blocked items)
- Inventory UI decision: RESOLVED 2026-09-09 — in-game via `@minecraft/server-ui`
  (RP inventory is a separate system from the vanilla backpack), with the
  player-web viewer now BUILT on top of the existing `/character/inventory` +
  `/inventories/*` routes (`backend/src/web/playerWeb.ts`: `GET /player` panel
  with Discord login, character creation, link-code generation, wallet,
  carried items + containers; served with a relaxed same-origin CSP from the
  same process). In-game UI **VERIFIED LIVE** on BDS 1.26.45.1 with a real
  client (2026-09-09): `world.beforeEvents.chatSend` confirmed as the real
  chat hook, `!inv`/compass open the form, the link-code form auto-pops on
  first spawn for unlinked accounts, linked accounts get a one-time
  "เชื่อมต่อแล้ว" message. RESOLVED during live verification:
  `@minecraft/server-chat` does **NOT** exist as a module on this build
  ("depends on unknown module" for both 1.0.0 and 1.0.0-beta) — previous
  handlers were correct to use `world.beforeEvents.chatSend`; do not try to
  migrate. Unresolved sub-item: vanilla `DEFAULT_INVENTORY_SIZE = 36` vs final
  RP slot model still to confirm against how the world presents inventory.
- Complete a real Discord OAuth sign-in with a real app — the live sign-in
  (2026-09-09) is user-confirmed but was not independently observed in this env.

> CI gate (build + `npm test` + level.dat self-check), the `level.dat` NBT
> patch automation (`tools/leveldat_patch.py`), deploy/backup tooling
> (`ops/docker-compose.prod.yml`, `ops/backup.sh`, `ops/README.md`), the
> in-game inventory UI (`!inv` + bridge inventory endpoints), the player web
> panel (`GET /player`, 22-test suite), and the admin web panel
> (`GET /admin`, 23-test suite) are now DONE.

> Note: the `characters.xuid` rename is DONE (migration 015) — do not treat it
> as pending. Historical CHANGELOG entries that mention it as pending are
> snapshots of earlier status, not current state.

## Version Control
- Git repo initialized 2026-09-08.
- Commit this handoff is based on: `fd50a2e` (roadmap implementation: character
  lifecycle, player session/presence, economy wallet/deduct, inventory meta,
  admin routes, bridge HMAC signing, automated integration tests).
- The 015 `persistent_id` rename work is committed as `744f82b` (Complete
  persistent id rename).
- This reference is a **frozen anchor**: it is the project-state commit this
  handoff documents. Purely administrative commits (hash/ref touch-ups) may
  legitimately sit on top of it — check `git log` / `git rev-parse --short HEAD`
  when starting work, don't treat a top-of-tree admin commit as a drift to fix.
  A commit's hash depends on its content, and the handoff (part of the content)
  cites the hash, so `HEAD` and the cited hash can never literally be the same
  commit; treating the anchor as frozen is by design.
- `JWT_SECRET` never leaked: no git history predates the repo; `.env` is in
  `.gitignore` (verified via `git check-ignore`).

## Architecture Decisions
(unchanged, plus:) Session cleanup is decoupled from what makes a session
actually stop working — `verifySessionToken`'s expiry/revocation checks are the
real security boundary; the cleanup job only ever deletes rows that are already
unusable, purely for table hygiene. Mirrors the trade-expiry job's exact pattern
(idempotent periodic job, manual-trigger admin route, started once at boot).

## Known Issues
- `@minecraft/server-chat` is NOT bundled on BDS 1.26.45.1 ("depends on unknown
  module" for both 1.0.0 and 1.0.0-beta, even after adding it to
  `config/default/permissions.json` allowed_modules) — chat interception stays
  on `world.beforeEvents.chatSend`, which empirically still fires and still
  honors `event.cancel` on this build. Verified live 2026-09-09.
- Compass "use" is the placeholder trigger; vanilla Bedrock `itemUse` may not
  fire for non-usable items — if it proves dead on a real client, switch the
  trigger item to a usable one (e.g. carrot_on_a_stick). `!inv` chat remains
  the reliable fallback.
- `@minecraft/server-ui` must be `2.2.0-beta` on this BDS build — `1.0.0-beta`
  is not an available version (mismatch rejected at pack load).
- Cleanup interval hardcoded (hourly), same style as trade expiry's hardcoded threshold.
- Node 24's `node --test <directory>` reports `Cannot find module` for a bare
  directory on this setup — use the `dist/**/*.test.js` glob form
  (self-expanded by Node), which is what `npm test` already does.
- `PRESENCE_TTL_SECONDS` (90s default) must stay a few seconds above the BDS
  pack's heartbeat interval (~30s) or healthy players get dropped from
  "online" prematurely; both are config, keep them in sync.
- `JWT_SECRET` storage: confirmed safe — repo initialized after all secrets were
  env-only, `.env` in `.gitignore` (see Version Control).
- Committed source files carry cosmetic UTF-8 encoding artifacts (BOM on some
  first lines, em-dashes stored as `â€”`) from an early editing pass — comments
  only, harmless, left as-is to avoid churn.
- Everything else unchanged from previous entries (rate limits in-memory/
  `trust proxy` unconfigured for prod). The `level.dat` NBT patch is now
  automated (`tools/leveldat_patch.py` with `--self-test`) and deploy/backup
  tooling exists (`ops/docker-compose.prod.yml` + `ops/backup.sh`, verified
  end-to-end on the local host: build → migrate → healthy → backup →
  pg_restore round-trip → down -v). The in-game inventory UI ships in the
  behavior pack (`!inv` via `@minecraft/server-ui`) over two new signed
  bridge endpoints (`/bridge/inventory/view`, `/bridge/inventory/move`) —
  identity is the persistentId, containers are ownership-checked (403 on
  someone else's), all covered by the integration suite (now 23 tests).

## Next Recommended Task
Automated integration tests (23/23 on the real docker stack), the signed+BDS
pack, `trust proxy` (verified behind a real docker nginx), the backend
foundation batch (character confirm/lock, multi-currency economy, containers,
idempotency, cases, security center, OAuth state), the retention/rate-limit
hardening round, the live BDS re-smoke on current HEAD (2026-09-09 rows), the
CI gate (`.github/workflows/ci.yml`), the `level.dat` NBT patch automation
(`tools/leveldat_patch.py`), deploy/backup tooling
(`ops/docker-compose.prod.yml` + `ops/backup.sh`), the in-game inventory UI
(verified live on BDS 1.26.45.1: `!inv` + compass trigger + spawn link form +
`@minecraft/server-chat` finding), the player web panel
(`GET /player` ..., 22-test suite), and the **admin web panel** (`GET /admin`,
23-test suite, MASTER_PROMPT §22) are all done.
Remaining verified-gaps: real-browser passes of `/admin` and `/player` (open
`http://<host>:8080/` in a browser — both serve valid now, incl. a local
`node --check` syntax pass on the served JS); live Discord OAuth was
user-confirmed (2026-09-09) but not independently observed; the
"heartbeat-after-leave drops presence" drop is HTTP-suite covered and can be
observed live with a documented curl check; the compass `itemUse` trigger caveat
and the vanilla-36-slot-size confirmation both still need a real client. Push/C
I is blocked on a git remote — none is configured and no `gh` CLI is installed;
run `git remote add origin <url>` / user-creates the repo to unblock CI.

## Do Not Change
- One Discord account = one character
- Server-authoritative economy/inventory/identity
- Audit requirements
- Modular resource architecture
- Backup/rollback requirements
- AI changelog/handoff process
- Wire-level API field names (`xuid` on `/bridge/character/link`, `playerId` on
  `/bridge/player/join`) — renaming those is a coordinated behavior-pack +
  backend change, do not do it as a DB-only rename.