# AI Handoff

## Project State
- Every subsystem verified end-to-end on real infrastructure, including the session cleanup job (fully tested — confirmed to remove only dead rows, never disturbs live sessions).
- Version: 0.1.0
- Status: No known untested paths anywhere in the core feature set built so far.

## Completed
- Backend: auth (revocation + rate limiting + jti/user_id cross-check), RBAC (permissions + boundaries + hierarchy all verified), audit log, economy, character whitelist, character linking, inventory, trading (+ expiry), shop (buy/sell + catalog management + single-listing read + stock-limit rollback) — all verified via real requests
- BDS + Script API + HTTP bridge — verified with real client joins
- **Session/jti security fix** (found and fixed by the user's own testing pass): `verifySessionToken()` now cross-checks `session.user_id === payload.sub`, closing an impersonation path that existed if `JWT_SECRET` ever leaked
- **Session cleanup job — fully verified**: manual trigger cleaned up 5 stale session rows accumulated from earlier testing; the calling (still-valid) session continued working immediately after; DB confirmed `sessions` count dropped from 5 to exactly 1 (the remaining valid one).

## In Progress
- **Role ranks in DB** — implemented and **verified** against real infra (see `CHANGELOG_AI.md` [2026-09-08 09:35]). **Trust proxy config** (same bundled change, `config/index.ts`, `index.ts`) still **unverified** — needs a real reverse proxy to test `req.ip` behavior.

## Pending
- Consider renaming `characters.xuid` → `characters.persistent_id`
- Consider automating the `level.dat` NBT patch for Beta-APIs worlds
- Decide inventory size/UI approach before player-facing
- Project has **no git repo yet** — verified 2026-09-08 (no `git` install found on the dev machine, `where.exe git` empty, no Git for Windows dir). `JWT_SECRET` therefore cannot have leaked via git history; `.gitignore` already lists `.env` for whenever git is initialized. Before the first `git init`/commit, double-check `.gitignore` covers `.env` and any other secrets file so nothing sensitive lands in commit 1.
- Integration tests, CI/deploy/backup tooling

## Architecture Decisions
(unchanged, plus:) Session cleanup is decoupled from what makes a
session actually stop working — `verifySessionToken`'s expiry/revocation
checks are the real security boundary; the cleanup job only ever
deletes rows that are already unusable, purely for table hygiene.
Mirrors the trade-expiry job's exact pattern (idempotent periodic
job, manual-trigger admin route, started once at boot).

## Known Issues
- Cleanup interval hardcoded (hourly), same style as trade expiry's hardcoded threshold.
- `JWT_SECRET` storage: confirmed no git history exists to have leaked it (see Pending — no git repo on the dev machine yet).
- Everything else unchanged from previous entries (`characters.xuid` naming, NBT patch manual, rate limits in-memory/`trust proxy` unconfigured, no CI/deploy/backup tooling).

## Next Recommended Task
Every built feature and hardening item so far is fully verified except
`trust proxy` config (needs a real reverse proxy to test). Ask the
user what to prioritize next: more RP features (NPCs, world content,
more admin tooling) or remaining lower-priority polish (`trust proxy`
config, `characters.xuid` rename, NBT patch automation, CI/deploy/backup).

## Do Not Change
- One Discord account = one character
- Server-authoritative economy/inventory/identity
- Audit requirements
- Modular resource architecture
- Backup/rollback requirements
- AI changelog/handoff process
