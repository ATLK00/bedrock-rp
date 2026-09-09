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
- **Admin surface**: audit-log viewer (`GET /admin/audit`, incl. `before/after/reason`),
  multi-currency economy reads (`GET /admin/economy/character/:id`), container CRUD,
  character update/view (locked-field approval path).

Integration suite (`backend/src/test/integration.test.ts`) runs against a throwaway
`bedrock_rp_test` DB (17 tests: auth, character create/link/delete/details-lock-case,
bridge secret/signature/replay, presence + stale-heartbeat, RBAC, economy
cash/bank/red-money/anomaly/idempotency, inventory weight + containers, cases, security events).
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
   session cookie
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

## Inventory

- `POST /admin/inventory/give` `{characterId, itemId, quantity}` — admin-only, audited, stacks onto existing slots up to `max_stack` then fills empty slots, throws `409` if there's no room left
- `POST /admin/inventory/remove` `{characterId, itemId, quantity}` — admin-only, audited, removes from lowest slot index first, throws `409` if the character doesn't have enough
- `GET /character/inventory` — session-authenticated, returns the caller's own character's inventory (no RBAC — everyone can see their own items)

A few sample items (`rp:bandage`, `rp:id_card`, `rp:cash_stack`) are
seeded by `004_seed_items.sql` for testing; real item catalog design is
future work.

## Roles & permissions

`005_seed_permissions.sql` seeds four permission keys
(`economy.grant`, `character.whitelist`, `inventory.give`,
`inventory.remove`) and grants all of them to the `admin` role,
`character.whitelist` only to `moderator`. `owner` bypasses RBAC checks
entirely regardless of grants (see `rbac/index.ts`).

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
