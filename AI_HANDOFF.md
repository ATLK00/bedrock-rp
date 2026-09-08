# AI Handoff

## Project State
- Every subsystem verified end-to-end on real infrastructure, including the session cleanup job (fully tested — confirmed to remove only dead rows, never disturbs live sessions).
- Version: 0.1.0
- Status: Core feature set is fully verified. The only unverified items are infrastructure-dependent paths that require setup unavailable in a plain dev environment — most notably `trust proxy` config, which needs a real reverse proxy to test `req.ip` behavior (see In Progress).

## Completed
- Backend: auth (revocation + rate limiting + jti/user_id cross-check), RBAC (permissions + boundaries + hierarchy all verified), audit log, economy, character whitelist, character linking, inventory, trading (+ expiry), shop (buy/sell + catalog management + single-listing read + stock-limit rollback) — all verified via real requests
- BDS + Script API + HTTP bridge — verified with real client joins
- **Session/jti security fix** (found and fixed by the user's own testing pass): `verifySessionToken()` now cross-checks `session.user_id === payload.sub`, closing an impersonation path that existed if `JWT_SECRET` ever leaked
- **Session cleanup job — fully verified**: manual trigger cleaned up 5 stale session rows accumulated from earlier testing; the calling (still-valid) session continued working immediately after; DB confirmed `sessions` count dropped from 5 to exactly 1 (the remaining valid one).

- **`characters.xuid` renamed to `characters.persistent_id`** (migration `015_persistent_id_rename.sql`): unique constraint renamed to `characters_persistent_id_key`, no `xuid` column remains. Character and bridge modules updated to use `persistent_id` internally; external wire fields (`xuid` on `/bridge/character/link`, `playerId` on `/bridge/player/join`) deliberately left unchanged for compatibility with the deployed behavior pack. Also fixed: admin routes now require an authenticated `req.userId`. Verified: TypeScript build passes, JWT/session verification and the authenticated `/character/link-code` endpoint both work, DB schema confirmed via `\d characters`. Temporary test sessions/characters/trades/transactions created during verification were cleaned up.

## In Progress
- **Role ranks in DB** — implemented and **verified** against real infra (see `CHANGELOG_AI.md` [2026-09-08 09:35]). **Trust proxy config** (same bundled change, `config/index.ts`, `index.ts`) still **unverified** — needs a real reverse proxy to test `req.ip` behavior.

## Pending
- Consider automating the `level.dat` NBT patch for Beta-APIs worlds
- Decide inventory size/UI approach before player-facing
- Integration tests, CI/deploy/backup tooling

## Version Control
- Git repo initialized 2026-09-08. Latest commit: `3af1ccc` (Fix persistent_id references in docs, reorder changelog, clarify handoff status).
- The 015 `persistent_id` rename work is committed as `744f82b` (Complete persistent id rename).
- `JWT_SECRET` confirmed never leaked — no git history existed before the repo was initialized; `.env` is in `.gitignore`.
- As of this handoff, there are **no uncommitted changes** (working tree clean).

## Architecture Decisions
(unchanged, plus:) Session cleanup is decoupled from what makes a
session actually stop working — `verifySessionToken`'s expiry/revocation
checks are the real security boundary; the cleanup job only ever
deletes rows that are already unusable, purely for table hygiene.
Mirrors the trade-expiry job's exact pattern (idempotent periodic
job, manual-trigger admin route, started once at boot).

## Known Issues
- Cleanup interval hardcoded (hourly), same style as trade expiry's hardcoded threshold.
- `JWT_SECRET` storage: confirmed safe — repo initialized after all secrets were env-only, `.env` in `.gitignore` (see Version Control section).
- Everything else unchanged from previous entries (NBT patch manual, rate limits in-memory/`trust proxy` unconfigured, no CI/deploy/backup tooling).

## Next Recommended Task
Every built feature and hardening item so far is fully verified except
`trust proxy` config (needs a real reverse proxy to test). Ask the
user what to prioritize next: more RP features (NPCs, world content,
more admin tooling) or remaining lower-priority polish (`trust proxy`
config, NBT patch automation, CI/deploy/backup).

## Do Not Change
- One Discord account = one character
- Server-authoritative economy/inventory/identity
- Audit requirements
- Modular resource architecture
- Backup/rollback requirements
- AI changelog/handoff process

