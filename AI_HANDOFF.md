# AI Handoff

## Project State
- Version: 0.1.0
- This handoff describes the project state at commit `9adec4f` (see Version Control).
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

## Unverified (needs infrastructure we don't have in a plain dev env)
- `trust proxy` config (implemented, `TRUST_PROXY` env in `config/index.ts` +
  `index.ts`) — cannot be tested without a real reverse proxy to confirm `req.ip`
  reflects the client, not the proxy. Do NOT mark this verified until tested that way.
- Nothing else in the built feature set is currently known-unverified.

## Pending (features/tooling not built yet — not blocked items)
- Automate the `level.dat` NBT patch for Beta-APIs worlds (currently manual, see README).
- Decide inventory size/UI approach before player-facing.
- Integration tests (automated), CI/deploy/backup tooling.

> Note: the `characters.xuid` rename is DONE (migration 015) — do not treat it
> as pending. Historical CHANGELOG entries that mention it as pending are
> snapshots of earlier status, not current state.

## Version Control
- Git repo initialized 2026-09-08.
- Commit this handoff is based on: `9adec4f`. The 015 `persistent_id` rename
  work is committed as `744f82b` (Complete persistent id rename).
- Confirm with `git rev-parse --short HEAD` / `git status --short` when
  starting work — a handoff is a snapshot, so later bookkeeping commits may
  sit on top of it.
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
- `JWT_SECRET` storage: confirmed safe — repo initialized after all secrets were
  env-only, `.env` in `.gitignore` (see Version Control).
- Committed source files carry cosmetic UTF-8 encoding artifacts (BOM on some
  first lines, em-dashes stored as `â€”`) from an early editing pass — comments
  only, harmless, left as-is to avoid churn.
- Everything else unchanged from previous entries (NBT patch manual, rate limits
  in-memory/`trust proxy` unconfigured, no CI/deploy/backup tooling).

## Next Recommended Task
Core feature set is verified; the one explicitly-unverified item is `trust proxy`
(needs a real reverse proxy). Recommended next order: Trust proxy verification →
automated integration tests → NBT patch automation → inventory UI → RP
gameplay/features → CI/deploy/backup. Ask the user which to prioritize.

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