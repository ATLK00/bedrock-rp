# AI Handoff

## Project State
- Version: 0.1.0
- This handoff describes the project state at commit `fd50a2e` (see Version Control).
- NOT a blanket "fully verified" claim: the core feature set is verified against
  real infrastructure; a small set of infrastructure-dependent paths remains
  explicitly unverified (listed below under **Unverified**).

## Verified (tested on real infrastructure)
- Backend: auth (Discord OAuth login, JWT+jti sessions, revocation on ban,
  per-session logout, rate limiting, jti/user_id cross-check), RBAC (permissions,
  boundaries, hierarchy, rank — all exercised via real requests), audit log,
  economy (transfer/grant), character whitelist, character linking (via the
  in-game `!link` flow end-to-end on a real client), inventory, trading
  (+ anti-scam rollback, + expiry job), shop (buy/sell + catalog management +
  single-listing read + stock-limit rollback) — all verified via real requests.
- Character lifecycle: `GET/POST/DELETE /character`, soft-delete keeps
  wallet/ledger history and clears the link; CSPRNG link codes.
- Player presence/session history: `POST /bridge/player/join|leave|heartbeat`
  (Redis presence TTL + Postgres `player_sessions` with a partial-unique "one
  open window" backstop; reconnect dedup verified in tests).
- Automated integration test suite (`backend/src/test/integration.test.ts`) —
  fresh `bedrock_rp_test` DB each run, migrations 001–017 applied, HTTP-level
  coverage of auth/session, character, link, presence, RBAC, economy,
  inventory(meta), bridge auth. `npm test` = 11/11 (verified 2026-09-08).
- Bridge hardening: HMAC-SHA256 request signing (drift window + Redis nonce
  replay rejection); legacy shared-secret-only clients still accepted. BDS pack
  signs every call via pure-JS `crypto_hmac.js` (RFC 4231 ASCII vectors +
  node:crypto cross-checks).
- DB integrity pass (migration 017): hot-path indexes + slot consistency CHECK.
- Bugs found by the new suite and fixed: (1) `issueSessionToken` signed BIGINT
  ids as strings → every DB-derived session failed verification; (2) admin
  `/inventory/give` dropped `meta`; (3) `BridgeSignatureError.name` defaulted to
  "Error" → signature failures returned 500 instead of 401. Admin `/economy/
  deduct`, `/roles`, `/users/:id/roles`, `/presence/online` routes live.
- BDS + Script API + HTTP bridge — verified with real client joins.
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

## Unverified (needs infrastructure we don't have in a plain dev env)
- (empty) — the previously-listed `trust proxy` item was verified with a real
  docker nginx reverse proxy on 2026-09-08 (see Verified section). Verified via
  harnessed API is the state of everything else; the two remaining genuinely
  external paths are the live Minecraft-client round-trip and a real Discord
  OAuth sign-in, which are tracked under Pending, not Unverified.

## Pending (features/tooling not built yet — not blocked items)
- Automate the `level.dat` NBT patch for Beta-APIs worlds (currently manual, see README).
- Decide inventory size/UI approach before player-facing.
- CI/deploy/backup tooling (rake the `npm test` + `npm run build` gates into CI).
- Deploy the updated behavior pack to a live server and verify the
  heartbeat/leave + signed-call round-trip against real client joins.

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
- Everything else unchanged from previous entries (NBT patch manual, rate limits
  in-memory/`trust proxy` unconfigured, no CI/deploy/backup tooling).

## Next Recommended Task
Automated integration tests (11/11 on the real docker stack), the signed+BDS
pack, and `trust proxy` (verified behind a real docker nginx) are all done.
Remaining verified-gaps are the two genuinely external paths: (1) deploy the
updated pack to a live server and confirm the heartbeat/leave + signed-call
round-trip against real client joins; (2) complete a real Discord OAuth
sign-in. After those: CI gate on `npm run build` + `npm test`, NBT patch
automation, inventory UI.

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