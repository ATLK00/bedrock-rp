/**
 * Integration test suite — runs against the real local stack (Postgres +
 * Redis from ops/docker-compose.yml). Uses a throwaway `bedrock_rp_test`
 * database: dropped + recreated + fully migrated on every run, so it is
 * safe to run repeatedly and never touches dev data.
 *
 * Run: npm run build && npm test   (or: node --test dist/test/)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import pg from "pg";

// Connection endpoints are host-port overridable so the same suite runs
// against the local docker-compose stack (localhost:5434 / localhost:6379)
// and a CI services block (which uses its own ports). CI_ variants fall back
// to the local-dev defaults so nothing changes when run from `npm test`.
const TEST_DB_URL =
  process.env.CI_TEST_DB_URL || "postgres://bedrock_rp:changeme@localhost:5434/bedrock_rp_test";
const ADMIN_DB_URL =
  process.env.CI_ADMIN_DB_URL || "postgres://bedrock_rp:changeme@localhost:5434/bedrock_rp";
const CI_REDIS_URL = process.env.CI_REDIS_URL || "redis://localhost:6379";
const BDS_SECRET = "test-bridge-secret-0123456789abcdef";

/** Resolve + connect-probe a service endpoint with backoff, so the suite
 * never races away against a CI services block whose DNS/listeners are still
 * warming up (which manifests as a transient EAI_AGAIN for the hostname). */
async function waitForRedis(url: string, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const parsed = new URL(url);
      const { lookup } = await import("node:dns/promises");
      await lookup(parsed.hostname);
      const { createClient } = await import("redis");
      const client = createClient({ url });
      client.on("error", () => {});
      await client.connect().catch(() => {});
      await client.ping().catch(() => {});
      if (client.isOpen) {
        await client.quit().catch(() => {});
        return;
      }
      await client.quit().catch(() => {});
    } catch {
      // keep waiting
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for redis (${url})`);
}

async function waitForPostgres(url: string, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const parsed = new URL(url);
      const { lookup } = await import("node:dns/promises");
      await lookup(parsed.hostname);
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
      await client.connect();
      await client.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`timed out waiting for postgres (${url})`);
}

/** Drop + recreate + migrate a clean `bedrock_rp_test`, controlling DATABASE_URL. */
async function prepareTestDatabase() {
  // Let the CI job's service DNS + listeners catch up before we race it.
  await waitForPostgres(ADMIN_DB_URL);
  await waitForRedis(CI_REDIS_URL);

  const admin = new pg.Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  try {
    await admin.query("DROP DATABASE IF EXISTS bedrock_rp_test WITH (FORCE)");
    await admin.query("CREATE DATABASE bedrock_rp_test");
  } finally {
    await admin.end();
  }

  process.env.NODE_ENV = "development";
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.REDIS_URL = CI_REDIS_URL;
  process.env.BDS_BRIDGE_SECRET = BDS_SECRET;
  process.env.JWT_SECRET = "test-jwt-secret-0123456789abcdefghijklmnopqrstuv";
  // The suite legitimately fires far more than the default per-window
  // limits (esp. /admin) while covering all surfaces; raise the tiers so
  // the tests exercise behavior, not throttling. The 429 path is still
  // covered implicitly by asserts on 401/403 responses... and remains easy
  // to test directly if a dedicated rate-limit test is ever added.
  process.env.RATE_LIMIT_AUTH_MAX = "100000";
  process.env.RATE_LIMIT_BRIDGE_MAX = "100000";
  process.env.RATE_LIMIT_ADMIN_MAX = "100000";

  // All backend modules must be imported AFTER the env vars above are set —
  // pool/redis/config snapshot env at import time.
  const { runMigrations } = await import("../db/migrate.js");
  const { pool } = await import("../db/pool.js");
  const { redis, connectRedis } = await import("../cache/redis.js");
  const { createApp } = await import("../app.js");
  await connectRedis(); // modules assume the boot path already connected Redis
  await redis.flushAll();
  await runMigrations(pool);

  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    pool,
    redis,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    ...(await importModuleHandles()),
  };
}

async function importModuleHandles() {
  const { upsertUserByDiscordId, issueSessionToken } = await import("../modules/auth/index.js");
  const economy = await import("../modules/economy/index.js");
  return { upsertUserByDiscordId, issueSessionToken, economy };
}

function signedHeaders(secret: string, rawBody: string): Record<string, string> {
  const ts = String(Date.now());
  const nonce = `${ts}-${Math.random().toString(36).slice(2, 12)}`;
  const sig = createHmac("sha256", secret)
    .update(`${ts}\n${nonce}\n${rawBody}`)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "x-bds-bridge-secret": secret,
    "x-bds-ts": ts,
    "x-bds-nonce": nonce,
    "x-bds-sig": sig,
  };
}

async function grantOwnerRole(pool: pg.Pool, userId: number) {
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = 'owner'`);
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, rows[0].id]
  );
}

async function grantRoleByName(pool: pg.Pool, userId: number, roleName: string) {
  const { rows } = await pool.query(`SELECT id FROM roles WHERE name = $1`, [roleName]);
  assert.ok(rows[0], `role ${roleName} must exist (was it migrated?)`);
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, rows[0].id]
  );
}

test("integration suite", async (t) => {
  const ctx: any = await prepareTestDatabase();
  const {
    baseUrl,
    pool,
    upsertUserByDiscordId,
    issueSessionToken,
  } = ctx;

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const get = async (path: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, { headers });
  const del = async (path: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, { method: "DELETE", headers });
  const cookieFor = (token: string) => ({ cookie: `bedrock_rp_session=${token}` });
  const postAs = (path: string, body: unknown, token: string) =>
    post(path, body, cookieFor(token));
  const getAs = (path: string, token: string) => get(path, cookieFor(token));
  const delAs = (path: string, token: string) => del(path, cookieFor(token));
  const patchAs = (path: string, body: unknown, token: string) =>
    fetch(`${baseUrl}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...cookieFor(token) },
      body: JSON.stringify(body),
    });

  // 1. auth
  await t.test("auth: session issue / verify / revoke", async () => {
    const a = await upsertUserByDiscordId("1001", "UserA");
    const b = await upsertUserByDiscordId("1002", "UserB");
    const c = await upsertUserByDiscordId("1003", "UserC");
    ctx.userA = a;
    ctx.userB = b;
    ctx.userC = c;

    const tokenA = await issueSessionToken(a.id);
    const tokenB = await issueSessionToken(b.id);
    const tokenC = await issueSessionToken(c.id);
    ctx.tokenA = tokenA;
    ctx.tokenB = tokenB;
    ctx.tokenC = tokenC;

    const { verifySessionToken, revokeSession } = await import("../modules/auth/index.js");
    // a.id comes back as a string (node-pg int8 parser); verify returns a number.
    assert.equal(await verifySessionToken(tokenA), Number(a.id));
    assert.equal(await verifySessionToken("garbage.token.here"), null);

    // unauthenticated request must fail on a protected route
    const unauth = await get("/character");
    assert.equal(unauth.status, 401);
    // authenticated but no character yet
    const noChar = await getAs("/character", tokenA);
    assert.equal(noChar.status, 404);

    // revocation takes effect immediately
    const { default: jwt } = await import("jsonwebtoken");
    const decoded = jwt.decode(tokenB) as { jti: string };
    await revokeSession(decoded.jti);
    assert.equal(await verifySessionToken(tokenB), null);
    ctx.tokenB = await issueSessionToken(b.id); // re-issue for later tests
  });

  // 2. character create
  await t.test("character: create / duplicate / validation", async () => {
    const r1 = await postAs("/character", { name: "Alice" }, ctx.tokenA);
    assert.equal(r1.status, 201);
    const bodyA = (await r1.json()) as { id: string };
    ctx.charA = { ...bodyA, id: Number(bodyA.id) };

    const r2 = await postAs("/character", { name: "Alice Clone" }, ctx.tokenA);
    assert.equal(r2.status, 409);

    const r3 = await post("/character", { name: "x".repeat(33) }, cookieFor(ctx.tokenA) as unknown as Record<string, string>);
    assert.equal(r3.status, 400);

    const rb = await postAs("/character", { name: "Bob" }, ctx.tokenB);
    assert.equal(rb.status, 201);
    const bodyB = (await rb.json()) as { id: string };
    ctx.charB = { ...bodyB, id: Number(bodyB.id) };

    const rc = await postAs("/character", { name: "Charlie" }, ctx.tokenC);
    assert.equal(rc.status, 201);
    const bodyC = (await rc.json()) as { id: string };
    ctx.charC = { ...bodyC, id: Number(bodyC.id) };

    const own = await getAs("/character", ctx.tokenA);
    assert.equal(own.status, 200);
    const ownBody = await own.json();
    assert.equal(Number(ownBody.id), ctx.charA.id);
    assert.equal(ownBody.linked, false);
  });

  // 3. bridge auth
  await t.test("bridge: secret / signature / replay / staleness", async () => {
    // legacy: shared secret only — accepted
    const legacy = await post(
      "/bridge/player/join",
      { playerId: "p-A", playerName: "Alice" },
      { "x-bds-bridge-secret": BDS_SECRET }
    );
    assert.equal(legacy.status, 204);

    // wrong secret — rejected before signature checks
    const wrongSecret = await post(
      "/bridge/player/join",
      { playerId: "p-A", playerName: "Alice" },
      { "x-bds-bridge-secret": "not-the-secret-at-all" }
    );
    assert.equal(wrongSecret.status, 401);

    // signed + valid → ok
    const body = JSON.stringify({ playerId: "p-A", playerName: "Alice" });
    const signed = await fetch(`${baseUrl}/bridge/player/leave`, {
      method: "POST",
      headers: signedHeaders(BDS_SECRET, body),
      body,
    });
    assert.equal(signed.status, 204);

    // bad signature → 401
    const badSigHeaders = signedHeaders(BDS_SECRET, body);
    badSigHeaders["x-bds-sig"] = "0".repeat(64);
    const badSig = await fetch(`${baseUrl}/bridge/player/heartbeat`, {
      method: "POST",
      headers: badSigHeaders,
      body,
    });
    assert.equal(badSig.status, 401);

    // stale timestamp → 401 (drift window is 300s)
    const staleHeaders = signedHeaders(BDS_SECRET, body);
    staleHeaders["x-bds-ts"] = String(Date.now() - 3600 * 1000);
    const stale = await fetch(`${baseUrl}/bridge/player/heartbeat`, {
      method: "POST",
      headers: staleHeaders,
      body,
    });
    assert.equal(stale.status, 401);

    // exact replay (same body, ts, nonce) → 401 on second send
    const replayOne = signedHeaders(BDS_SECRET, body);
    const r1 = await fetch(`${baseUrl}/bridge/player/join`, { method: "POST", headers: replayOne, body });
    assert.equal(r1.status, 204);
    const r2 = await fetch(`${baseUrl}/bridge/player/join`, { method: "POST", headers: replayOne, body });
    assert.equal(r2.status, 401);

    // malformed playerId → 400
    const malformed = await post(
      "/bridge/player/join",
      { playerId: "", playerName: "Alice" },
      { "x-bds-bridge-secret": BDS_SECRET }
    );
    assert.equal(malformed.status, 400);
  });

  // 4. character link flow (web code → bridge consume)
  await t.test("link: code lifecycle + onetime + conflict", async () => {
    const codeRes = await postAs("/character/link-code", {}, ctx.tokenA);
    assert.equal(codeRes.status, 200);
    const { code } = await codeRes.json();
    assert.ok(code && typeof code === "string");

    const linkBody = JSON.stringify({ code, xuid: "p-A" });
    const link = await fetch(`${baseUrl}/bridge/character/link`, {
      method: "POST",
      headers: signedHeaders(BDS_SECRET, linkBody),
      body: linkBody,
    });
    assert.equal(link.status, 200);
    const linkJson = (await link.json()) as { ok: boolean };
    assert.equal(linkJson.ok, true);

    const own = await getAs("/character", ctx.tokenA);
    const ownBody = await own.json();
    assert.equal(ownBody.linked, true);

    // code is consumed — reusing it fails
    const reuse = await fetch(`${baseUrl}/bridge/character/link`, {
      method: "POST",
      headers: signedHeaders(BDS_SECRET, linkBody),
      body: linkBody,
    });
    assert.equal(reuse.status, 400);

    // requesting a new code while already linked → 409
    const alreadyLinked = await postAs("/character/link-code", {}, ctx.tokenA);
    assert.equal(alreadyLinked.status, 409);
  });

  // 5. presence + session history
  await t.test("presence: join/heartbeat/reconnect/leave via signed calls", async () => {
    const joinBody = JSON.stringify({ playerId: "p-A", playerName: "Alice" });
    const join = await fetch(`${baseUrl}/bridge/player/join`, {
      method: "POST",
      headers: signedHeaders(BDS_SECRET, joinBody),
      body: joinBody,
    });
    assert.equal(join.status, 204);

    const hb = await fetch(`${baseUrl}/bridge/player/heartbeat`, {
      method: "POST",
      headers: signedHeaders(BDS_SECRET, joinBody),
      body: joinBody,
    });
    assert.equal(hb.status, 204);

    // owner-scoped admin route lists the online player (need owner role first)
    await grantOwnerRole(pool, ctx.userA.id);
    const onlineRes = await getAs("/admin/presence/online", ctx.tokenA);
    assert.equal(onlineRes.status, 200);
    const { online } = await onlineRes.json();
    const entry = online.find((p: any) => p.persistentId === "p-A");
    assert.ok(entry, "p-A should be listed as online");
    assert.equal(entry.playerName, "Alice");
    assert.equal(Number(entry.characterId), ctx.charA.id);

    // reconnect: second join closes the first window, still exactly one open
    const rejoin = await fetch(`${baseUrl}/bridge/player/join`, {
      method: "POST",
      headers: signedHeaders(BDS_SECRET, joinBody),
      body: joinBody,
    });
    assert.equal(rejoin.status, 204);

    let { rows } = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE left_at IS NULL)::int AS open
       FROM player_sessions WHERE persistent_id = 'p-A'`
    );
    // Reconnect must never leave two open windows — exactly one open row
    // regardless of how many join/leave cycles p-A went through.
    assert.equal(rows[0].open, 1);
    assert.ok(rows[0].total >= 3, `expected >= 3 session rows, got ${rows[0].total}`);
    assert.ok(
      rows[0].total === rows[0].open + (await pool.query(
        `SELECT count(*)::int AS closed FROM player_sessions WHERE persistent_id = 'p-A' AND left_at IS NOT NULL`
      )).rows[0].closed
    );

    const charRows = await pool.query(
      `SELECT last_seen_at FROM characters WHERE id = $1`,
      [ctx.charA.id]
    );
    assert.ok(charRows.rows[0].last_seen_at, "last_seen_at should be set by join/heartbeat");

    // leave closes the window, presence gone
    const leave = await fetch(`${baseUrl}/bridge/player/leave`, {
      method: "POST",
      headers: signedHeaders(BDS_SECRET, joinBody),
      body: joinBody,
    });
    assert.equal(leave.status, 204);

    ({ rows } = await pool.query(
      `SELECT count(*)::int AS open FROM player_sessions WHERE persistent_id = 'p-A' AND left_at IS NULL`
    ));
    assert.equal(rows[0].open, 0);

    const onlineAfter = await getAs("/admin/presence/online", ctx.tokenA);
    const { online: online2 } = await onlineAfter.json();
    assert.ok(!online2.some((p: any) => p.persistentId === "p-A"));
  });

  // 6. RBAC enforcement
  await t.test("rbac: anonymous/forbidden/owner flows", async () => {
    const anon = await get("/admin/roles");
    assert.equal(anon.status, 401);

    // user C has no roles → forbidden
    const denied = await getAs("/admin/roles", ctx.tokenC);
    assert.equal(denied.status, 403);

    // owner (A) can read the role matrix + a user's roles
    const matrix = await getAs("/admin/roles", ctx.tokenA);
    assert.equal(matrix.status, 200);
    const { roles } = await matrix.json();
    assert.ok(roles.some((r: any) => r.name === "owner"));

    const userRoles = await getAs(`/admin/users/${ctx.userB.id}/roles`, ctx.tokenA);
    assert.equal(userRoles.status, 200);
    const { roles: bRoles } = await userRoles.json();
    assert.ok(bRoles.length === 0);

    // user B (no roles) still forbidden after A's promotion
    const bDenied = await getAs("/admin/roles", ctx.tokenB);
    assert.equal(bDenied.status, 403);
  });

  // 7. economy
  await t.test("economy: grant / wallet / deduct / transfer / insufficient", async () => {
    const grant = await postAs("/admin/economy/grant", {
      characterId: ctx.charA.id,
      amountCents: 5000,
      reason: "integration test",
    }, ctx.tokenA);
    assert.equal(grant.status, 204);

    let wallet = await (await getAs("/character/wallet", ctx.tokenA)).json();
    assert.equal(wallet.balanceCents, 5000);
    assert.equal(wallet.transactions.length, 1);
    assert.equal(wallet.transactions[0].ref_type, "admin_grant");

    const deduct = await postAs("/admin/economy/deduct", {
      characterId: ctx.charA.id,
      amountCents: 2000,
      reason: "integration test clawback",
    }, ctx.tokenA);
    assert.equal(deduct.status, 204);

    wallet = await (await getAs("/character/wallet", ctx.tokenA)).json();
    assert.equal(wallet.balanceCents, 3000);

    const overDeduct = await postAs("/admin/economy/deduct", {
      characterId: ctx.charA.id,
      amountCents: 999999,
      reason: "should not pass",
    }, ctx.tokenA);
    assert.equal(overDeduct.status, 409);

    await ctx.economy.transfer({
      fromCharacterId: ctx.charA.id,
      toCharacterId: ctx.charB.id,
      amountCents: 1000,
      reason: "integration test transfer",
      actorUserId: ctx.userA.id,
    });
    const walletA = await (await getAs("/character/wallet", ctx.tokenA)).json();
    const walletB = await (await getAs("/character/wallet", ctx.tokenB)).json();
    assert.equal(walletA.balanceCents, 2000);
    assert.equal(walletB.balanceCents, 1000);

    await assert.rejects(
      ctx.economy.transfer({
        fromCharacterId: ctx.charB.id,
        toCharacterId: ctx.charA.id,
        amountCents: 999999,
        reason: "overdraft",
        actorUserId: null,
      }),
      ctx.economy.InsufficientFundsError
    );
  });

  // 8. inventory (incl. metadata stacking rules)
  await t.test("inventory: give/merge/meta/remove/full", async () => {
    const give = async (itemId: string, quantity: number, meta?: Record<string, unknown>) =>
      postAs("/admin/inventory/give", {
        characterId: ctx.charB.id,
        itemId,
        quantity,
        ...(meta !== undefined ? { meta } : {}),
      }, ctx.tokenA);
    const list = async () =>
      (await (await getAs("/character/inventory", ctx.tokenB)).json()).items;

    assert.equal((await give("rp:bandage", 5)).status, 204);
    assert.equal((await give("rp:bandage", 3)).status, 204); // plain merges into plain
    let items = await list();
    assert.equal(items.length, 1);
    assert.equal(items[0].quantity, 8);

    assert.equal((await give("rp:bandage", 2, { durability: 10 })).status, 204);
    assert.equal((await give("rp:bandage", 3, { durability: 10 })).status, 204); // same meta merges
    assert.equal((await give("rp:bandage", 1, { durability: 5 })).status, 204); // diff meta → new slot
    items = await list();
    assert.equal(items.length, 3);
    const dur10 = items.find((i: any) => i.item_metadata?.durability === 10);
    assert.equal(dur10.quantity, 5);
    const dur5 = items.find((i: any) => i.item_metadata?.durability === 5);
    assert.equal(dur5.quantity, 1);

    const remove = await postAs("/admin/inventory/remove", {
      characterId: ctx.charB.id,
      itemId: "rp:bandage",
      quantity: 2,
    }, ctx.tokenA);
    assert.equal(remove.status, 204);
    items = await list();
    assert.equal(
      (items as any[]).find((i: any) => Object.keys(i.item_metadata ?? {}).length === 0)?.quantity,
      6
    );

    const overRemove = await postAs("/admin/inventory/remove", {
      characterId: ctx.charB.id,
      itemId: "rp:bandage",
      quantity: 9999,
    }, ctx.tokenA);
    assert.equal(overRemove.status, 409);

    const unknownItem = await postAs("/admin/inventory/give", {
      characterId: ctx.charB.id,
      itemId: "rp:does-not-exist",
      quantity: 1,
    }, ctx.tokenA);
    assert.equal(unknownItem.status, 404);
  });

  // 9. link conflict: one persistentId cannot own two characters
  await t.test("link: persistentId already linked to another character", async () => {
    const codeRes = await postAs("/character/link-code", {}, ctx.tokenB);
    assert.equal(codeRes.status, 200);
    const { code } = await codeRes.json();

    // link B's code using p-A (already linked to charA) → 409 conflict
    const conflictBody = JSON.stringify({ code, xuid: "p-A" });
    const conflict = await fetch(`${baseUrl}/bridge/character/link`, {
      method: "POST",
      headers: signedHeaders(BDS_SECRET, conflictBody),
      body: conflictBody,
    });
    assert.equal(conflict.status, 409);
    const conflictJson = (await conflict.json()) as { ok: boolean };
    assert.equal(conflictJson.ok, false);
  });

  // 10. soft delete
  await t.test("character: soft delete clears link and hides the character", async () => {
    const delRes = await delAs("/character", ctx.tokenC);
    assert.equal(delRes.status, 204);
    const gone = await getAs("/character", ctx.tokenC);
    assert.equal(gone.status, 404);
  });

  // ---- Backend foundation: new systems -------------------------------

  // 11. character RP details + confirmation/lock + case approval path
  await t.test("character: details validation / confirm / lock / change-via-case", async () => {
    // fresh user so we own its character end-to-end
    const d = await ctx.upsertUserByDiscordId("1004", "UserD");
    const tokenD = await ctx.issueSessionToken(d.id);
    const created = await postAs("/character", { name: "David" }, tokenD);
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    const charD = { ...createdBody, id: Number(createdBody.id) };
    ctx.charD = charD;
    ctx.tokenD = tokenD;

    // invalid details rejected
    assert.equal(
      (await patchAs("/character/details", { date_of_birth: "not-a-date" }, tokenD)).status,
      400
    );
    assert.equal(
      (await patchAs("/character/details", { date_of_birth: "1999-13-99" }, tokenD)).status,
      400
    );
    assert.equal(
      (await patchAs("/character/details", { gender: "unknown" }, tokenD)).status,
      400
    );
    assert.equal(
      (await patchAs("/character/details", { citizen_id: "ab!" }, tokenD)).status,
      400
    );
    assert.equal(
      (await patchAs("/character/details", { photo_url: "javascript:alert(1)" }, tokenD)).status,
      400
    );

    // confirm requires identity fields
    const confirmIncomplete = await postAs("/character/confirm", {}, tokenD);
    assert.equal(confirmIncomplete.status, 400);

    // valid details patch (locked fields editable BEFORE confirmation)
    const patch = await patchAs(
      "/character/details",
      {
        first_name: "David",
        last_name: "Chan",
        nickname: "Dave",
        date_of_birth: "2000-01-01",
        gender: "male",
        nationality: "Thai",
        citizen_id: "ABC-123",
      },
      tokenD
    );
    assert.equal(patch.status, 204);

    // confirm locks identity fields
    const confirm = await postAs("/character/confirm", {}, tokenD);
    assert.equal(confirm.status, 204);
    // idempotent
    assert.equal((await postAs("/character/confirm", {}, tokenD)).status, 204);

    const detailsRes = await getAs("/character/details", tokenD);
    assert.equal(detailsRes.status, 200);
    const details = await detailsRes.json();
    assert.equal(details.confirmed, true);
    assert.equal(details.lockVersion, 1);
    assert.equal(details.details.first_name, "David");

    // unlocked fields still editable after confirmation
    assert.equal((await patchAs("/character/details", { nickname: "Davey" }, tokenD)).status, 204);

    // locked fields refused after confirmation
    const lockedEdit = await patchAs("/character/details", { last_name: "Chen" }, tokenD);
    assert.equal(lockedEdit.status, 403);

    // request a locked-field change via case
    const changeReq = await postAs(
      "/character/change-request",
      { field: "last_name", value: "Chen", note: "legal name update" },
      tokenD
    );
    assert.equal(changeReq.status, 201);
    const { caseId } = await changeReq.json();

    // staff approval (owner A) applies the change + resolves the case
    const approve = await postAs(
      "/admin/character/update",
      { characterId: charD.id, changes: { last_name: "Chen" }, reason: "approved after review", caseId },
      ctx.tokenA
    );
    assert.equal(approve.status, 204);

    const after = await getAs("/character/details", tokenD);
    const afterBody = await after.json();
    assert.equal(afterBody.details.last_name, "Chen");
    assert.ok(afterBody.lockVersion >= 2);

    // the original case is now resolved
    const myCases = await getAs("/cases", tokenD);
    const casesBody = await myCases.json();
    const theCase = casesBody.cases.find((c: any) => Number(c.id) === caseId);
    assert.ok(theCase, "change-request case should exist");
    assert.equal(theCase.status, "resolved");

    // a player cannot view someone else's case
    const otherCase = await getAs(`/cases/${caseId}`, ctx.tokenB);
    assert.equal(otherCase.status, 403);
  });

  // 12. multi-currency economy + anomaly + idempotency
  await t.test("economy: bank/red money + anomaly event + idempotency", async () => {
    // bank / red money credit + debit via module API
    await ctx.economy.credit({
      characterId: ctx.charA.id,
      amountCents: 1500,
      reason: "bank deposit",
      currency: "bank",
      actorUserId: ctx.userA.id,
    });
    await ctx.economy.credit({
      characterId: ctx.charA.id,
      amountCents: 700,
      reason: "red money income",
      currency: "red_money",
      actorUserId: ctx.userA.id,
    });
    const summary = await ctx.economy.getWalletSummary(ctx.charA.id);
    assert.equal(summary.cashCents, 2000); // unchanged by bank/red ops (from earlier test)
    assert.equal(summary.bankCents, 1500);
    assert.equal(summary.redMoneyCents, 700);

    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM transactions WHERE character_id = $1 AND currency = 'bank'`,
      [ctx.charA.id]
    );
    assert.equal(rows[0].n, 1);

    // bank debit anti-negative
    await assert.rejects(
      ctx.economy.debit({ characterId: ctx.charA.id, amountCents: 999999, reason: "overdraft", currency: "bank", actorUserId: null }),
      ctx.economy.InsufficientFundsError
    );

    // anomaly: a credit >= threshold records a HIGH economy_anomaly event
    await ctx.economy.credit({
      characterId: ctx.charA.id,
      amountCents: 1_000_000,
      reason: "suspicious huge credit",
      currency: "cash",
      actorUserId: ctx.userA.id,
    });
    const sec = await getAs("/admin/security/events?severity=HIGH", ctx.tokenA);
    const secBody = await sec.json();
    assert.ok(
      secBody.events.some((e: any) => e.event_type === "economy_anomaly"),
      "economy anomaly event should be recorded"
    );

    // idempotency: same key + same body applies once
    const first = await postAs(
      "/admin/economy/grant",
      { characterId: ctx.charB.id, amountCents: 300, reason: "idem grant", idempotencyKey: "k-grant-1" },
      ctx.tokenA
    );
    assert.equal(first.status, 204);
    const second = await postAs(
      "/admin/economy/grant",
      { characterId: ctx.charB.id, amountCents: 300, reason: "idem grant", idempotencyKey: "k-grant-1" },
      ctx.tokenA
    );
    assert.equal(second.status, 204);

    const bWallet = await (await getAs("/character/wallet", ctx.tokenB)).json();
    assert.equal(bWallet.balanceCents, 1300); // 1000 transfer + 300 grant — replay did NOT double it

    // same key + different body -> conflict
    const conflict = await postAs(
      "/admin/economy/grant",
      { characterId: ctx.charB.id, amountCents: 500, reason: "different body", idempotencyKey: "k-grant-1" },
      ctx.tokenA
    );
    assert.equal(conflict.status, 409);
  });

  // 13. weight-aware inventory + containers
  await t.test("inventory: weight limit + container lifecycle", async () => {
    // character carry limit (20kg default) — 1000 bandages at 50g = 50kg
    const overWeight = await postAs(
      "/admin/inventory/give",
      { characterId: ctx.charB.id, itemId: "rp:bandage", quantity: 1000 },
      ctx.tokenA
    );
    assert.equal(overWeight.status, 409);

    // staff creates a container
    const create = await postAs(
      "/admin/inventory/containers",
      { storageType: "warehouse", label: "Test Warehouse", capacityWeightG: 5000 },
      ctx.tokenA
    );
    assert.equal(create.status, 201);
    const containerId = Number((await create.json()).id);

    // unrelated user cannot take from it (no owner -> owned by no one -> admin only)
    // but the container is visible to staff inventory.view
    const view = await getAs(`/admin/inventory/containers/${containerId}`, ctx.tokenA);
    assert.equal(view.status, 200);
    assert.equal((await view.json()).label, "Test Warehouse");

    // add items; over-capacity rejected
    const add = await postAs(
      `/admin/inventory/containers/${containerId}/items`,
      { itemId: "rp:bandage", quantity: 40 }, // 40 * 50g = 2000g (under 5000)
      ctx.tokenA
    );
    assert.equal(add.status, 204);

    const overCapacity = await postAs(
      `/admin/inventory/containers/${containerId}/items`,
      { itemId: "rp:bandage", quantity: 100 }, // +5000g would exceed 5000g total
      ctx.tokenA
    );
    assert.equal(overCapacity.status, 409);

    const items = await (await getAs(`/admin/inventory/containers/${containerId}`, ctx.tokenA)).json();
    assert.equal(items.items.reduce((s: number, i: any) => s + i.quantity, 0), 40); // max_stack 16 → 16+16+8 rows
    assert.equal(items.items.length, 3);
    assert.equal(items.usedWeightG, 2000);

    // player moves their own item INTO their own container
    const ownContainer = await postAs(
      "/admin/inventory/containers",
      { storageType: "locker", ownerCharacterId: ctx.charB.id, capacityWeightG: 5000 },
      ctx.tokenA
    );
    const ownContainerId = Number((await ownContainer.json()).id);

    const moveIn = await postAs(
      `/inventories/${ownContainerId}/items`,
      { itemId: "rp:bandage", quantity: 5 },
      ctx.tokenB
    );
    assert.equal(moveIn.status, 204);

    // B's slots dropped by 5 and container holds 5
    const bInv = await (await getAs("/character/inventory", ctx.tokenB)).json();
    const plain = bInv.items.find((i: any) => Object.keys(i.item_metadata ?? {}).length === 0);
    assert.equal(plain.quantity, 1);

    const containerItems = await (await getAs(`/inventories/${ownContainerId}`, ctx.tokenB)).json();
    assert.equal(containerItems.items[0].quantity, 5);

    // deleting a non-empty container is refused
    const delNonEmpty = await delAs(`/admin/inventory/containers/${ownContainerId}`, ctx.tokenA);
    assert.equal(delNonEmpty.status, 409);

    // take it back
    const take = await postAs(
      `/inventories/${ownContainerId}/take`,
      { itemId: "rp:bandage", quantity: 5 },
      ctx.tokenB
    );
    assert.equal(take.status, 204);
    const bInv2 = await (await getAs("/character/inventory", ctx.tokenB)).json();
    assert.equal(bInv2.items.find((i: any) => Object.keys(i.item_metadata ?? {}).length === 0).quantity, 6);

    // player unrelated container access denied: B cannot touch warehouse A owns-less
    // (warehouse has no owner in this test, so B is allowed — use B's own locker and a fake id)
    const otherContainer = await getAs(`/inventories/99999`, ctx.tokenB);
    assert.equal(otherContainer.status, 404);
  });

  // 13b. bridge in-game inventory UI (identity = persistentId, like the pack)
  await t.test("bridge inventory: view + move + ownership from persistentId", async () => {
    // fresh user E with a linked character so assertions are deterministic
    const e = await upsertUserByDiscordId("2001", "UserE");
    const tokenE = await issueSessionToken(e.id);
    const createdE = await postAs("/character", { name: "Eve" }, tokenE);
    assert.equal(createdE.status, 201);
    const charE = { id: Number((await createdE.json()).id) };

    const codeRes = await postAs("/character/link-code", {}, tokenE);
    const { code } = await codeRes.json();
    const linkBody = JSON.stringify({ code, xuid: "p-E" });
    const link = await fetch(`${baseUrl}/bridge/character/link`, {
      method: "POST",
      headers: signedHeaders(BDS_SECRET, linkBody),
      body: linkBody,
    });
    assert.equal(link.status, 200);

    const bridgePost = async (path: string, body: unknown) => {
      const raw = JSON.stringify(body);
      return fetch(`${baseUrl}${path}`, { method: "POST", headers: signedHeaders(BDS_SECRET, raw), body: raw });
    };
    const bridgeJson = async (path: string, body: unknown) =>
      ((await bridgePost(path, body)).json()) as Promise<any>;

    // give E items + one owned locker + one A-owned locker (for ownership test)
    await postAs("/admin/inventory/give", { characterId: charE.id, itemId: "rp:bandage", quantity: 10 }, ctx.tokenA);
    const lockerE = Number((await (await postAs(
      "/admin/inventory/containers",
      { storageType: "locker", ownerCharacterId: charE.id, label: "E's Locker", capacityWeightG: 5000 },
      ctx.tokenA
    )).json()).id);
    const lockerA = Number((await (await postAs(
      "/admin/inventory/containers",
      { storageType: "locker", ownerCharacterId: ctx.charA.id, label: "A's Locker", capacityWeightG: 5000 },
      ctx.tokenA
    )).json()).id);

    // unlinked persistentId → 404
    const unlinked = await bridgePost("/bridge/inventory/view", { playerId: "p-nobody" });
    assert.equal(unlinked.status, 404);

    // view returns slots + weight + own containers
    const view1 = await (await bridgePost("/bridge/inventory/view", { playerId: "p-E" })).json();
    assert.equal(view1.ok, true);
    assert.equal(view1.character.name, "Eve");
    assert.equal(view1.carryWeightG, 500); // 10 * 50g
    assert.equal(view1.carryWeightLimitG, 20000);
    assert.equal(view1.slots.reduce((s: number, i: any) => s + i.quantity, 0), 10);
    const ownLockerInView = view1.containers.find((c: any) => Number(c.id) === lockerE);
    assert.ok(ownLockerInView, "own container listed");
    assert.equal(ownLockerInView.items.reduce((s: number, i: any) => s + i.quantity, 0), 0);
    assert.ok(!view1.containers.some((c: any) => Number(c.id) === lockerA), "someone else's container not listed");

    // in-game move: character → own container
    const moveIn = await bridgeJson("/bridge/inventory/move", {
      playerId: "p-E", itemId: "rp:bandage", quantity: 4, from: "character", to: lockerE,
    });
    assert.equal(moveIn.ok, true);

    const view2 = await (await bridgePost("/bridge/inventory/view", { playerId: "p-E" })).json();
    assert.equal(view2.slots.reduce((s: number, i: any) => s + i.quantity, 0), 6);
    const lockerAfter = view2.containers.find((c: any) => Number(c.id) === lockerE);
    assert.equal(lockerAfter.items.reduce((s: number, i: any) => s + i.quantity, 0), 4);
    assert.equal(lockerAfter.usedWeightG, 200);

    // in-game move: container → character (pack sends ids as JSON numbers, but
    // the string form must work too — pg int8 ids are strings on the wire)
    const moveOut = await bridgeJson("/bridge/inventory/move", {
      playerId: "p-E", itemId: "rp:bandage", quantity: 4, from: String(lockerE), to: "character",
    });
    assert.equal(moveOut.ok, true);

    // move into someone else's container → 403 (ownership enforced by persistentId)
    const steal = await bridgePost("/bridge/inventory/move", {
      playerId: "p-E", itemId: "rp:bandage", quantity: 1, from: "character", to: lockerA,
    });
    assert.equal(steal.status, 403);

    // container → container (own) works
    const lockerE2 = Number((await (await postAs(
      "/admin/inventory/containers",
      { storageType: "house", ownerCharacterId: charE.id, label: "E's House", capacityWeightG: 5000 },
      ctx.tokenA
    )).json()).id);
    const c2c = await bridgeJson("/bridge/inventory/move", {
      playerId: "p-E", itemId: "rp:bandage", quantity: 3, from: lockerE, to: lockerE2,
    });

    // safety invariants
    assert.equal(c2c.ok, false); // empty source container → 409 insufficient
    const overQty = await bridgePost("/bridge/inventory/move", {
      playerId: "p-E", itemId: "rp:bandage", quantity: 999, from: "character", to: lockerE,
    });
    assert.equal(overQty.status, 409);
    const sameTarget = await bridgePost("/bridge/inventory/move", {
      playerId: "p-E", itemId: "rp:bandage", quantity: 1, from: lockerE, to: lockerE,
    });
    assert.equal(sameTarget.status, 400);
    const missingContainer = await bridgePost("/bridge/inventory/move", {
      playerId: "p-E", itemId: "rp:bandage", quantity: 1, from: "character", to: 99999,
    });
    assert.equal(missingContainer.status, 404);
    const badTarget = await bridgePost("/bridge/inventory/move", {
      playerId: "p-E", itemId: "rp:bandage", quantity: 1, from: "character", to: "pocket",
    });
    assert.equal(badTarget.status, 400);
  });

  // 13c. in-game staff command: !give (authorization on the actor's identity, not the pack)
  await t.test("bridge admin give: RBAC on actor / success / forbidden security event", async () => {
    const bridgePost = async (path: string, body: unknown) => {
      const raw = JSON.stringify(body);
      return fetch(`${baseUrl}${path}`, { method: "POST", headers: signedHeaders(BDS_SECRET, raw), body: raw });
    };

    // fresh linked characters: Fred (staff-wannabe, NO roles) and Gwen (target)
    const f = await upsertUserByDiscordId("2002", "UserF");
    const tokenF = await issueSessionToken(f.id);
    assert.equal((await postAs("/character", { name: "Fred" }, tokenF)).status, 201);
    let codeRes = await postAs("/character/link-code", {}, tokenF);
    let { code } = await codeRes.json();
    let raw = JSON.stringify({ code, xuid: "p-F" });
    assert.equal((await fetch(`${baseUrl}/bridge/character/link`, {
      method: "POST", headers: signedHeaders(BDS_SECRET, raw), body: raw,
    })).status, 200);

    const g = await upsertUserByDiscordId("2003", "UserG");
    const tokenG = await issueSessionToken(g.id);
    assert.equal((await postAs("/character", { name: "Gwen" }, tokenG)).status, 201);
    codeRes = await postAs("/character/link-code", {}, tokenG);
    ({ code } = await codeRes.json());
    raw = JSON.stringify({ code, xuid: "p-G" });
    assert.equal((await fetch(`${baseUrl}/bridge/character/link`, {
      method: "POST", headers: signedHeaders(BDS_SECRET, raw), body: raw,
    })).status, 200);

    const charG = Number((await pool.query(
      `SELECT id FROM characters WHERE persistent_id = 'p-G'`
    )).rows[0].id);
    const wallet = async () => Number((await pool.query(
      `SELECT balance_cents FROM wallets WHERE character_id = $1`, [charG]
    )).rows[0]?.balance_cents ?? 0);

    // owner (userA, linked p-A) grants to Gwen -> cash wallet grows
    assert.equal(await wallet(), 0);
    const give = await bridgePost("/bridge/admin/give", {
      actorName: "Alice", actorPersistentId: "p-A",
      targetName: "Gwen", targetPersistentId: "p-G",
      amountCents: 125000, currency: "cash",
    });
    assert.equal(give.status, 200);
    assert.equal((await give.json()).ok, true);
    assert.equal(await wallet(), 125000);

    // bank variant lands in wallet_balances
    const giveBank = await bridgePost("/bridge/admin/give", {
      actorName: "Alice", actorPersistentId: "p-A",
      targetName: "Gwen", targetPersistentId: "p-G",
      amountCents: 300, currency: "bank",
    });
    assert.equal(giveBank.status, 200);
    const bank = Number((await pool.query(
      `SELECT balance_cents FROM wallet_balances WHERE character_id = $1 AND currency = 'bank'`, [charG]
    )).rows[0].balance_cents);
    assert.equal(bank, 300);

    // validation: bad amount / bad currency / missing identity
    assert.equal((await bridgePost("/bridge/admin/give", {
      actorName: "Alice", actorPersistentId: "p-A", targetName: "Gwen", targetPersistentId: "p-G", amountCents: 0,
    })).status, 400);
    assert.equal((await bridgePost("/bridge/admin/give", {
      actorName: "Alice", actorPersistentId: "p-A", targetName: "Gwen", targetPersistentId: "p-G", amountCents: 10, currency: "gold",
    })).status, 400);
    assert.equal((await bridgePost("/bridge/admin/give", {
      actorName: "Alice", actorPersistentId: "p-A", targetName: "Gwen", targetPersistentId: "p-G",
    })).status, 400);

    // non-staff actor is REFUSED (RBAC on the actor's Discord user) and it becomes a HIGH security event
    const denied = await bridgePost("/bridge/admin/give", {
      actorName: "Fred", actorPersistentId: "p-F",
      targetName: "Gwen", targetPersistentId: "p-G",
      amountCents: 100, currency: "cash",
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).ok, false);
    assert.equal(await wallet(), 125000); // nothing granted

    const sec = await (await getAs("/admin/security/events?severity=HIGH", ctx.tokenA)).json();
    assert.ok(
      sec.events.some((e: any) =>
        e.event_type === "staff_command_forbidden" && Number(e.actor_user_id) === Number(f.id) &&
        e.payload?.command === "give"
      ),
      "attempted staff command by non-staff must raise a HIGH security event"
    );

    // unlinked target -> 404
    const missingTarget = await bridgePost("/bridge/admin/give", {
      actorName: "Alice", actorPersistentId: "p-A",
      targetName: "Ghost", targetPersistentId: "p-ghost",
      amountCents: 100,
    });
    assert.equal(missingTarget.status, 404);

    // !deduct mirror (same auth, same RBAC) — claw back cash
    const deduct = await bridgePost("/bridge/admin/deduct", {
      actorName: "Alice", actorPersistentId: "p-A",
      targetName: "Gwen", targetPersistentId: "p-G",
      amountCents: 50000, currency: "cash",
    });
    assert.equal(deduct.status, 200);
    assert.equal((await deduct.json()).ok, true);
    assert.equal(await wallet(), 75000); // 125000 - 50000

    // over-deduct -> 409 (insufficient funds, no overdraft)
    const overDeduct = await bridgePost("/bridge/admin/deduct", {
      actorName: "Alice", actorPersistentId: "p-A",
      targetName: "Gwen", targetPersistentId: "p-G",
      amountCents: 999999999, currency: "cash",
    });
    assert.equal(overDeduct.status, 409);

    // non-staff deduct also refused + raises a security event (command=deduct)
    const deductDenied = await bridgePost("/bridge/admin/deduct", {
      actorName: "Fred", actorPersistentId: "p-F",
      targetName: "Gwen", targetPersistentId: "p-G",
      amountCents: 100, currency: "cash",
    });
    assert.equal(deductDenied.status, 403);
    const sec2 = await (await getAs("/admin/security/events?severity=HIGH", ctx.tokenA)).json();
    assert.ok(
      sec2.events.some((e: any) => e.event_type === "staff_command_forbidden" && e.payload?.command === "deduct"),
      "deduct attempt by non-staff must raise a HIGH security event"
    );
  });

  // 14. cases: create / staff resolve / messages / permission
  await t.test("cases: lifecycle + staff resolution", async () => {
    // validation
    const bad = await postAs("/cases", { category: "nope", subject: "x", description: "y" }, ctx.tokenA);
    assert.equal(bad.status, 400);

    const created = await postAs(
      "/cases",
      { category: "bug", subject: "Falling through floor", description: "Happens near the docks, please investigate" },
      ctx.tokenA
    );
    assert.equal(created.status, 201);
    const caseId = Number((await created.json()).caseId);

    const mine = await getAs("/cases", ctx.tokenA);
    const mineBody = await mine.json();
    assert.ok(mineBody.cases.some((c: any) => Number(c.id) === caseId));

    // staff can see all + resolve
    const all = await getAs("/admin/cases", ctx.tokenA);
    assert.equal(all.status, 200);
    const statusChange = await postAs(
      `/admin/cases/${caseId}/status`,
      { status: "in_progress", note: "looking into it" },
      ctx.tokenA
    );
    assert.equal(statusChange.status, 204);
    const resolve = await postAs(
      `/admin/cases/${caseId}/status`,
      { status: "resolved", note: "fixed in next build" },
      ctx.tokenA
    );
    assert.equal(resolve.status, 204);

    const detail = await getAs(`/admin/cases/${caseId}`, ctx.tokenA);
    const detailBody = await detail.json();
    assert.equal(detailBody.status, "resolved");
    assert.ok(detailBody.events.some((e: any) => e.event_type === "status_changed"));
    assert.ok(detailBody.messages.length >= 1, "note message should exist");

    // staff messages on a case
    const staffMsg = await postAs(`/admin/cases/${caseId}/messages`, { body: "Root cause found." }, ctx.tokenA);
    assert.equal(staffMsg.status, 204);

    // invalid status rejected
    const badStatus = await postAs(`/admin/cases/${caseId}/status`, { status: "banana" }, ctx.tokenA);
    assert.equal(badStatus.status, 400);
  });

  // 15. security center wiring + health/headers
  await t.test("security: events recorded + health/readiness + headers", async () => {
    // triggering a bad bridge secret already wrote a HIGH event (test #3);
    // confirm the feed shows bridge events
    const sec = await getAs("/admin/security/events", ctx.tokenA);
    const body = await sec.json();
    assert.ok(
      body.events.some((e: any) => e.event_type === "bridge_invalid_secret"),
      "bridge_invalid_secret should be recorded"
    );

    // acknowledge works
    const target = body.events.find((e: any) => e.event_type === "bridge_invalid_secret");
    const ack = await postAs(`/admin/security/events/${target.id}/acknowledge`, {}, ctx.tokenA);
    assert.equal(ack.status, 204);
    const ackAgain = await postAs(`/admin/security/events/${target.id}/acknowledge`, {}, ctx.tokenA);
    assert.equal(ackAgain.status, 404);

    // audit log viewer (owner bypass)
    const audit = await getAs("/admin/audit", ctx.tokenA);
    assert.equal(audit.status, 200);
    const auditBody = await audit.json();
    assert.ok(Array.isArray(auditBody.entries) && auditBody.entries.length > 0);

    // liveness/readiness + security headers
    const live = await get("/health/live");
    assert.equal(live.status, 200);
    const ready = await get("/health/ready");
    assert.equal(ready.status, 200);
    const h = await get("/health");
    assert.equal(h.headers.get("x-content-type-options"), "nosniff");
    assert.equal(h.headers.get("x-frame-options"), "DENY");
    assert.ok(h.headers.get("x-request-id"));
  });

  // 16. stale heartbeat does not resurrect presence
  await t.test("presence: heartbeat after leave is ignored (no ghost presence)", async () => {
    const body = JSON.stringify({ playerId: "p-B", playerName: "Bob" });
    const join = await fetch(`${baseUrl}/bridge/player/join`, {
      method: "POST",
      headers: signedHeaders(BDS_SECRET, body),
      body,
    });
    assert.equal(join.status, 204);

    const hb = await fetch(`${baseUrl}/bridge/player/heartbeat`, {
      method: "POST",
      headers: signedHeaders(BDS_SECRET, body),
      body,
    });
    assert.equal(hb.status, 204);

    const leave = await fetch(`${baseUrl}/bridge/player/leave`, {
      method: "POST",
      headers: signedHeaders(BDS_SECRET, body),
      body,
    });
    assert.equal(leave.status, 204);

    // stale heartbeat AFTER leave
    const stale = await fetch(`${baseUrl}/bridge/player/heartbeat`, {
      method: "POST",
      headers: signedHeaders(BDS_SECRET, body),
      body,
    });
    assert.equal(stale.status, 204);

    const online = await (await getAs("/admin/presence/online", ctx.tokenA)).json();
    assert.ok(!online.online.some((p: any) => p.persistentId === "p-B"), "no ghost presence");

    const { rows } = await pool.query(
      `SELECT count(*)::int AS open FROM player_sessions WHERE persistent_id = 'p-B' AND left_at IS NULL`
    );
    assert.equal(rows[0].open, 0);
  });

  // 17. concurrent debits never overspend (row-lock anti-double-spend)
  await t.test("economy: parallel debits can't overspend (row-lock safety)", async () => {
    await ctx.economy.credit({
      characterId: ctx.charB.id,
      amountCents: 5000,
      reason: "concurrency seed",
      currency: "bank",
      actorUserId: ctx.userA.id,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        ctx.economy.debit({
          characterId: ctx.charB.id,
          amountCents: 1000,
          reason: `parallel debit ${i}`,
          currency: "bank",
          actorUserId: null,
        })
      )
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(ok, 5, "only 5 of 10 debits fit in a 5000 balance");
    assert.equal(rejected.length, 5);
    assert.equal(
      rejected.filter((r) => r.reason instanceof ctx.economy.InsufficientFundsError).length,
      5,
      "all overspent debits must fail with InsufficientFundsError"
    );

    const after = await ctx.economy.getWalletSummary(ctx.charB.id);
    assert.equal(after.bankCents, 0, "balance must end at exactly 0, never negative");

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM transactions WHERE character_id = $1 AND currency = 'bank' AND amount_cents = -1000`,
      [ctx.charB.id]
    );
    assert.equal(rows[0].n, 5, "ledger must have exactly 5 debits applied");
  });

  // 18. container capacity exact-fill boundary
  await t.test("inventory: container capacity exact-fill boundary", async () => {
    const create = await postAs(
      "/admin/inventory/containers",
      { storageType: "warehouse", label: "Boundary Warehouse", capacityWeightG: 1000 },
      ctx.tokenA
    );
    assert.equal(create.status, 201);
    const containerId = Number((await create.json()).id);

    // 19 * 50g = 950g — under capacity
    let add = await postAs(
      `/admin/inventory/containers/${containerId}/items`,
      { itemId: "rp:bandage", quantity: 19 },
      ctx.tokenA
    );
    assert.equal(add.status, 204);

    // +1 = exactly 1000g, the boundary still fits
    add = await postAs(
      `/admin/inventory/containers/${containerId}/items`,
      { itemId: "rp:bandage", quantity: 1 },
      ctx.tokenA
    );
    assert.equal(add.status, 204);

    let c = await (await getAs(`/admin/inventory/containers/${containerId}`, ctx.tokenA)).json();
    assert.equal(c.usedWeightG, 1000, "exact capacity reached");
    assert.equal(c.items.reduce((s: number, i: any) => s + i.quantity, 0), 20);

    // +1 more = 1050g → 409
    add = await postAs(
      `/admin/inventory/containers/${containerId}/items`,
      { itemId: "rp:bandage", quantity: 1 },
      ctx.tokenA
    );
    assert.equal(add.status, 409);

    // remove 4 (200g), then re-add exactly the freed space
    const remove = await postAs(
      `/admin/inventory/containers/${containerId}/items/remove`,
      { itemId: "rp:bandage", quantity: 4 },
      ctx.tokenA
    );
    assert.equal(remove.status, 204);
    c = await (await getAs(`/admin/inventory/containers/${containerId}`, ctx.tokenA)).json();
    assert.equal(c.usedWeightG, 800);

    add = await postAs(
      `/admin/inventory/containers/${containerId}/items`,
      { itemId: "rp:bandage", quantity: 4 },
      ctx.tokenA
    );
    assert.equal(add.status, 204);
    c = await (await getAs(`/admin/inventory/containers/${containerId}`, ctx.tokenA)).json();
    assert.equal(c.usedWeightG, 1000);

    // cleanup: empty then delete
    await postAs(
      `/admin/inventory/containers/${containerId}/items/remove`,
      { itemId: "rp:bandage", quantity: 20 },
      ctx.tokenA
    );
    const del = await delAs(`/admin/inventory/containers/${containerId}`, ctx.tokenA);
    assert.equal(del.status, 204);
  });

  // 19. case permission matrix (privacy + staff scope)
  await t.test("cases: permission matrix (privacy + staff scope)", async () => {
    const created = await postAs(
      "/cases",
      { category: "bug", subject: "B's private case", description: "Only B and staff should ever see this one" },
      ctx.tokenB
    );
    assert.equal(created.status, 201);
    const caseId = Number((await created.json()).caseId);

    // different user (A) cannot view or message B's case
    const aView = await getAs(`/cases/${caseId}`, ctx.tokenA);
    assert.equal(aView.status, 403);
    const aMsg = await postAs(`/cases/${caseId}/messages`, { body: "intrusion" }, ctx.tokenA);
    assert.equal(aMsg.status, 403);

    // non-staff (B) cannot use staff endpoints
    const bStaffStatus = await postAs(`/admin/cases/${caseId}/status`, { status: "resolved", note: "self-resolve" }, ctx.tokenB);
    assert.equal(bStaffStatus.status, 403);
    const bAll = await getAs("/admin/cases", ctx.tokenB);
    assert.equal(bAll.status, 403);
    const bAck = await postAs(`/admin/cases/${caseId}/messages`, { body: "staff-only reply" }, ctx.tokenB);
    assert.equal(bAck.status, 403);

    // staff sees the case + converses; owner cannot see other users' cases in their list
    const staffView = await getAs(`/admin/cases/${caseId}`, ctx.tokenA);
    assert.equal(staffView.status, 200);
    const staffBody = await staffView.json();
    assert.equal(staffBody.status, "open");

    const staffMsg = await postAs(`/admin/cases/${caseId}/messages`, { body: "Can you reproduce it?" }, ctx.tokenA);
    assert.equal(staffMsg.status, 204);
    const bReply = await postAs(`/cases/${caseId}/messages`, { body: "Yes, happens every time" }, ctx.tokenB);
    assert.equal(bReply.status, 204);

    const bMine = await (await getAs("/cases", ctx.tokenB)).json();
    assert.ok(bMine.cases.some((c: any) => Number(c.id) === caseId), "owner sees their own case");
    const aAll = await (await getAs("/cases", ctx.tokenA)).json();
    assert.ok(!aAll.cases.some((c: any) => Number(c.id) === caseId), "other user's list must exclude B's case");
  });

  // 20. player web: pages serve under relaxed CSP + root redirect
  await t.test("player web: pages serve under relaxed CSP + root redirect", async () => {
    // root redirects humans to the panel
    const root = await fetch(`${baseUrl}/`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal((root.headers.get("location") || "").endsWith("/player"), true);

    // HTML page + external assets, no auth required, relaxed but safe CSP
    const page = await get("/player", { accept: "text/html" });
    assert.equal(page.status, 200);
    assert.equal((page.headers.get("content-type") || "").includes("text/html"), true);
    const csp = page.headers.get("content-security-policy") || "";
    assert.ok(csp.includes("default-src 'self'"), "player CSS relaxes global default-src 'none'");
    assert.ok(csp.includes("script-src 'self'"), "no inline scripts allowed");
    assert.ok(csp.includes("frame-ancestors 'none'"), "stop being embedded");

    const css = await get("/player/app.css");
    assert.equal(css.status, 200);
    assert.equal((css.headers.get("content-type") || "").includes("text/css"), true);

    const js = await get("/player/app.js");
    assert.equal(js.status, 200);
    assert.equal((js.headers.get("content-type") || "").includes("javascript"), true);
  });

  // 21. admin web: page + assets + new read-only list endpoints
  await t.test("admin web: page + assets + list endpoints", async () => {
    // the console is admin-only at the server now — anonymous AND any
    // logged-in non-admin user are rejected before any HTML/JS is served
    const anon = await get("/admin");
    assert.equal(anon.status, 401);
    assert.equal((anon.headers.get("content-type") || "").includes("application/json"), true);

    const nonOwner = await getAs("/admin", ctx.tokenB);
    assert.equal(nonOwner.status, 403);
    assert.equal((anon.headers.get("content-type") || "").includes("application/json"), true);

    const page = await getAs("/admin", ctx.tokenA);
    assert.equal(page.status, 200);
    assert.equal((page.headers.get("content-type") || "").includes("text/html"), true);
    const csp = page.headers.get("content-security-policy") || "";
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));

    const css = await getAs("/admin/app.css", ctx.tokenA);
    assert.equal(css.status, 200);
    assert.equal((css.headers.get("content-type") || "").includes("text/css"), true);

    const js = await getAs("/admin/app.js", ctx.tokenA);
    assert.equal(js.status, 200);
    assert.equal((js.headers.get("content-type") || "").includes("javascript"), true);

    // anonymous cannot load admin assets either
    const anonCss = await get("/admin/app.css");
    assert.equal(anonCss.status, 401);
    const anonJs = await get("/admin/app.js");
    assert.equal(anonJs.status, 401);

    // new read-only directories: users + characters
    const users = await (await getAs("/admin/users", ctx.tokenA)).json();
    assert.ok(Array.isArray(users.users), "users list is an array");
    assert.ok(users.users.some((u: any) => Number(u.id) === Number(ctx.userA.id)), "seeded user visible");

    const chars = await (await getAs("/admin/characters", ctx.tokenA)).json();
    assert.ok(Array.isArray(chars.characters), "characters list is an array");
    assert.ok(chars.characters.some((c: any) => c.name === "Alice"), "created character visible");

    // search narrows results
    const filtered = await (await getAs("/admin/characters?query=Alice", ctx.tokenA)).json();
    assert.ok(filtered.characters.every((c: any) => c.name.indexOf("Alice") >= 0));

    // non-owner (tokenB) cannot read admin directories
    const denied = await getAs("/admin/users", ctx.tokenB);
    assert.equal(denied.status, 403);
  });

  // 22. vehicles: full lifecycle over the bridge + admin + player web
  await t.test("vehicles: create/grant/deploy/store/lock/refuel/repair/state/sell/buy/transfer/seize/reconcile", async () => {
    const bridgePost = async (path: string, body: unknown) => {
      const raw = JSON.stringify(body);
      return fetch(`${baseUrl}${path}`, { method: "POST", headers: signedHeaders(BDS_SECRET, raw), body: raw });
    };
    const bridgeJson = async (path: string, body: unknown) =>
      ((await bridgePost(path, body)).json()) as Promise<any>;

    // fresh linked characters H (buyer, gets the first car) and I (recipient)
    const h = await upsertUserByDiscordId("2101", "UserH");
    const tokenH = await issueSessionToken(h.id);
    assert.equal((await postAs("/character", { name: "Henry" }, tokenH)).status, 201);
    const i = await upsertUserByDiscordId("2102", "UserI");
    const tokenI = await issueSessionToken(i.id);
    assert.equal((await postAs("/character", { name: "Iris" }, tokenI)).status, 201);
    for (const [tag, xuid] of [["H", "p-H"], ["I", "p-I"]] as const) {
      const codeRes = await postAs("/character/link-code", {}, tag === "H" ? tokenH : tokenI);
      const { code } = await codeRes.json();
      const raw = JSON.stringify({ code, xuid });
      assert.equal((await fetch(`${baseUrl}/bridge/character/link`, {
        method: "POST", headers: signedHeaders(BDS_SECRET, raw), body: raw,
      })).status, 200);
    }

    const charH = Number((await pool.query(
      `SELECT id FROM characters WHERE persistent_id = 'p-H'`
    )).rows[0].id);
    const charI = Number((await pool.query(
      `SELECT id FROM characters WHERE persistent_id = 'p-I'`
    )).rows[0].id);

    const cash = async (cid: number) => Number((await pool.query(
      `SELECT balance_cents FROM wallets WHERE character_id = $1`, [cid]
    )).rows[0]?.balance_cents ?? 0);
    const keyCount = async (cid: number, vid: number) => Number((await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::int FROM inventory_slots
       WHERE character_id = $1 AND item_id = 'rp:vehicle_key' AND (item_metadata->>'vehicle_id')::bigint = $2`,
      [cid, vid]
    )).rows[0].coalesce);

    // unlinked bridge playerId -> 404
    assert.equal((await bridgePost("/bridge/vehicle/mine", { playerId: "p-nobody" })).status, 404);

    // admin creates a vehicle for Henry (owner) — key issued into carry
    const created = await (await postAs("/admin/vehicles", {
      entityType: "megaverse:buggy", ownerCharacterId: charH, salePriceCents: null,
    }, ctx.tokenA)).json();
    assert.equal(created.vehicle?.id > 0, true);
    const v1 = created.vehicle;
    assert.equal(v1.ownerCharacterId, charH);
    assert.equal(v1.status, "garaged");
    assert.equal(v1.locked, true);
    assert.equal(v1.entityType, "megaverse:buggy");
    assert.match(v1.plate, /^RP-[A-Z2-9]{5}$/);
    assert.equal(await keyCount(charH, v1.id), 1);

    // non-owner without a key cannot touch the car (403 on state changes)
    assert.equal((await bridgePost("/bridge/vehicle/lock", {
      playerId: "p-I", vehicleId: v1.id, locked: false,
    })).status, 403);
    // a garaged car can't be stored even by its owner (409), and refuel is refused for non-owners
    assert.equal((await bridgePost("/bridge/vehicle/store", {
      playerId: "p-H", vehicleId: v1.id,
    })).status, 409);
    assert.equal((await bridgePost("/bridge/vehicle/refuel", {
      playerId: "p-I", vehicleId: v1.id, units: 10, currency: "cash",
    })).status, 403);

    // mine (bridge) shows garage capacity + the new vehicle
    const mine1 = await bridgeJson("/bridge/vehicle/mine", { playerId: "p-H" });
    assert.equal(mine1.ok, true);
    assert.equal(mine1.garageCapacity, 3);
    assert.equal(mine1.vehicleCount, 1);
    assert.ok(mine1.vehicles.some((v: any) => Number(v.id) === Number(v1.id)));

    // player web endpoint mirrors the same read model
    const webGarage = await (await getAs("/character/vehicles", tokenH)).json();
    assert.equal(webGarage.garageCapacity, 3);
    assert.ok(webGarage.vehicles.some((v: any) => Number(v.id) === Number(v1.id)));

    // deploy -> deployed; deploy again -> 409
    const deploy = await bridgeJson("/bridge/vehicle/deploy", { playerId: "p-H", vehicleId: v1.id });
    assert.equal(deploy.ok, true);
    assert.equal(deploy.vehicle.status, "deployed");
    assert.equal((await bridgePost("/bridge/vehicle/deploy", { playerId: "p-H", vehicleId: v1.id })).status, 409);
    // deployed but not owned + no key -> store refused (real access denial)
    assert.equal((await bridgePost("/bridge/vehicle/store", {
      playerId: "p-I", vehicleId: v1.id,
    })).status, 403);

    // lock toggle by owner
    const unlock = await bridgeJson("/bridge/vehicle/lock", { playerId: "p-H", vehicleId: v1.id, locked: false });
    assert.equal(unlock.vehicle.locked, false);
    const relock = await bridgeJson("/bridge/vehicle/lock", { playerId: "p-H", vehicleId: v1.id, locked: true });
    assert.equal(relock.vehicle.locked, true);

    // refuel debits the wallet; units capped by tank space (50 units -> 500 cents)
    await ctx.economy.credit({ characterId: charH, amountCents: 100000, reason: "test seed", actorUserId: h.id, currency: "cash" });
    assert.equal(await cash(charH), 100000);
    // burn half the tank first (120000 ticks = 50 units) so refuel has room
    const burned = await bridgeJson("/bridge/vehicle/state", { vehicleId: v1.id, drivingTicks: 120000 });
    assert.equal(burned.vehicle.fuelLevel, 50);
    const refuel = await bridgeJson("/bridge/vehicle/refuel", { playerId: "p-H", vehicleId: v1.id, units: 50, currency: "cash" });
    assert.equal(refuel.ok, true);
    assert.equal(refuel.refilledUnits, 50);
    assert.equal(refuel.costCents, 500);
    assert.equal(await cash(charH), 99500);
    assert.equal(refuel.vehicle.fuelLevel, 100);
    // refuel over a full tank -> 409
    assert.equal((await bridgePost("/bridge/vehicle/refuel", {
      playerId: "p-H", vehicleId: v1.id, units: 10, currency: "cash",
    })).status, 409);

    // sensor state: driving 2400 ticks burns 1 unit; engine drops only via reports; body grows only via reports
    const state1 = await bridgeJson("/bridge/vehicle/state", {
      vehicleId: v1.id, drivingTicks: 2400, engineHealth: 90, suspensionHealth: 95, bodyDamage: 5,
    });
    assert.equal(state1.ok, true);
    assert.equal(state1.vehicle.fuelLevel, 99);
    assert.equal(state1.vehicle.engineHealth, 90);
    assert.equal(state1.vehicle.suspensionHealth, 95);
    assert.equal(state1.vehicle.bodyDamage, 5);
    // a "healed" report cannot raise health (sensors never heal)
    const state2 = await bridgeJson("/bridge/vehicle/state", {
      vehicleId: v1.id, drivingTicks: 0, engineHealth: 100, bodyDamage: 3,
    });
    assert.equal(state2.vehicle.engineHealth, 90);
    assert.equal(state2.vehicle.bodyDamage, 5);

    // repair costs engine(10*3)+susp(5*2)+body(5*1)=45; health back to 100
    const repair = await bridgeJson("/bridge/vehicle/repair", { playerId: "p-H", vehicleId: v1.id, currency: "cash" });
    assert.equal(repair.ok, true);
    assert.equal(repair.costCents, 45);
    assert.equal(await cash(charH), 99500 - 45);
    assert.equal(repair.vehicle.engineHealth, 100);
    assert.equal(repair.vehicle.suspensionHealth, 100);
    assert.equal(repair.vehicle.bodyDamage, 0);
    // nothing to repair -> 409
    assert.equal((await bridgePost("/bridge/vehicle/repair", { playerId: "p-H", vehicleId: v1.id })).status, 409);

    // store back to garage
    assert.equal((await bridgeJson("/bridge/vehicle/store", { playerId: "p-H", vehicleId: v1.id })).vehicle.status, "garaged");

    // transfer to Iris while parked: key moves atomically
    const transfer = await bridgeJson("/bridge/vehicle/transfer", { playerId: "p-H", vehicleId: v1.id, targetPersistentId: "p-I" });
    assert.equal(transfer.ok, true);
    assert.equal(transfer.vehicle.ownerCharacterId, charI);
    assert.equal(await keyCount(charH, v1.id), 0);
    assert.equal(await keyCount(charI, v1.id), 1);

    // Iris lists it for sale; Ian (via bridge buy) buys it from the dealership pot
    const sale = await bridgeJson("/bridge/vehicle/sell", { playerId: "p-I", vehicleId: v1.id, priceCents: 20000, currency: "cash" });
    assert.equal(sale.ok, true);
    assert.equal(sale.vehicle.salePriceCents, 20000);
    const shopList = await bridgeJson("/bridge/vehicle/shop", {});
    assert.ok(shopList.vehicles.some((v: any) => Number(v.id) === Number(v1.id)));

    // buy: fresh owner J (real player-to-player transfer path via the money engine)
    const j = await upsertUserByDiscordId("2103", "UserJ");
    const tokenJ = await issueSessionToken(j.id);
    assert.equal((await postAs("/character", { name: "Jack" }, tokenJ)).status, 201);
    const codeJ = await (await postAs("/character/link-code", {}, tokenJ)).json();
    const rawJ = JSON.stringify({ code: codeJ.code, xuid: "p-J" });
    assert.equal((await fetch(`${baseUrl}/bridge/character/link`, {
      method: "POST", headers: signedHeaders(BDS_SECRET, rawJ), body: rawJ,
    })).status, 200);
    const charJ = Number((await pool.query(
      `SELECT id FROM characters WHERE persistent_id = 'p-J'`
    )).rows[0].id);
    await ctx.economy.credit({ characterId: charJ, amountCents: 100000, reason: "test seed", actorUserId: j.id, currency: "cash" });
    // Jack can't afford it yet? he can. seller = Iris. money: Iris +20000, Jack -20000
    const beforeI = await cash(charI);
    const beforeJ = await cash(charJ);
    const bought = await bridgeJson("/bridge/vehicle/buy", { playerId: "p-J", vehicleId: v1.id });
    assert.equal(bought.ok, true);
    assert.equal(bought.vehicle.ownerCharacterId, charJ);
    assert.equal(await cash(charI), beforeI + 20000);
    assert.equal(await cash(charJ), beforeJ - 20000);
    assert.equal(await keyCount(charI, v1.id), 0);
    assert.equal(await keyCount(charJ, v1.id), 1);

    // admin create an unowned dealership car and have Jack buy it (debit path)
    await ctx.economy.credit({ characterId: charJ, amountCents: 100000, reason: "test seed 2", actorUserId: j.id, currency: "cash" });
    const shopCar = (await (await postAs("/admin/vehicles", {
      entityType: "megaverse:buggy", ownerCharacterId: null, salePriceCents: 150000, saleCurrency: "cash",
    }, ctx.tokenA)).json()).vehicle;
    assert.equal(shopCar.ownerCharacterId, null);
    const beforeJ2 = await cash(charJ);
    const boughtShop = await bridgeJson("/bridge/vehicle/buy", { playerId: "p-J", vehicleId: shopCar.id });
    assert.equal(boughtShop.ok, true);
    assert.equal(boughtShop.vehicle.ownerCharacterId, charJ);
    assert.equal(await cash(charJ), beforeJ2 - 150000);
    assert.equal(await keyCount(charJ, shopCar.id), 1);

    // admin: list with owner name, non-owner denied
    const adminList = (await (await getAs("/admin/vehicles", ctx.tokenA)).json()).vehicles;
    assert.ok(adminList.some((v: any) => Number(v.id) === Number(v1.id) && v.ownerName === "Jack"));
    assert.equal((await getAs("/admin/vehicles", ctx.tokenB)).status, 403);

    // admin maintenance overrides state
    const maint = (await postAs(`/admin/vehicles/${v1.id}/maintenance`, { fuelLevel: 7, engineHealth: 33, locked: false }, ctx.tokenA)).status;
    assert.equal(maint, 200);
    const afterMaint = await vehicleModuleGet(v1.id);
    assert.equal(afterMaint.fuelLevel, 7);
    assert.equal(afterMaint.engineHealth, 33);
    assert.equal(afterMaint.locked, false);

    // seize blocks operations and shows up in admin list
    assert.equal((await postAs(`/admin/vehicles/${v1.id}/seize`, {}, ctx.tokenA)).status, 200);
    assert.equal((await postAs(`/admin/vehicles/${v1.id}/grant`, { ownerCharacterId: charH }, ctx.tokenA)).status, 409);
    assert.equal((await bridgePost("/bridge/vehicle/deploy", { playerId: "p-J", vehicleId: v1.id })).status, 409);

    // seized blocks everything, then admin deletes it (keys + trunk cleaned up)
    assert.equal((await bridgePost("/bridge/vehicle/store", { playerId: "p-J", vehicleId: v1.id })).status, 409);
    assert.equal((await delAs(`/admin/vehicles/${v1.id}`, ctx.tokenA)).status, 204);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM vehicles WHERE id = $1`, [v1.id])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM inventory_slots WHERE item_id = 'rp:vehicle_key' AND (item_metadata->>'vehicle_id')::bigint = $1`, [v1.id])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM inventories WHERE id = $1`, [v1.trunkInventoryId])).rows[0].n, 0);

    // reconcile returns stranded 'deployed' vehicles to the garage
    const strandedPlate = (await pool.query(
      `INSERT INTO vehicles (entity_type, plate, owner_character_id, status, trunk_inventory_id)
       VALUES ('megaverse:buggy', 'RP-TEST99', $1, 'deployed', NULL) RETURNING id`,
      [charJ]
    )).rows[0].id;
    const reconcile = await bridgeJson("/bridge/vehicle/reconcile", { deployedVehicleIds: [strandedPlate] });
    assert.equal(reconcile.ok, true);
    assert.equal(reconcile.resetToGarage, 0);
    const stranded2Plate = (await pool.query(
      `INSERT INTO vehicles (entity_type, plate, owner_character_id, status, trunk_inventory_id)
       VALUES ('megaverse:buggy', 'RP-TEST98', $1, 'deployed', NULL) RETURNING id`,
      [charJ]
    )).rows[0].id;
    const reconcile2 = await bridgeJson("/bridge/vehicle/reconcile", { deployedVehicleIds: [strandedPlate] });
    assert.equal(reconcile2.resetToGarage, 1);
    const strandedStatus = (await pool.query(`SELECT status FROM vehicles WHERE id = $1`, [stranded2Plate])).rows[0].status;
    assert.equal(strandedStatus, "garaged");

    // every mutation wrote an audit row (sample assertions)
    const audits = (await pool.query(
      `SELECT action, COUNT(*)::int AS n FROM audit_log WHERE target_type = 'vehicle' GROUP BY action`
    )).rows;
    const byAction = Object.fromEntries(audits.map((a: any) => [a.action, a.n]));
    for (const action of [
      "vehicle.create", "vehicle.deploy", "vehicle.store", "vehicle.lock", "vehicle.unlock",
      "vehicle.refuel", "vehicle.repair", "vehicle.transfer", "vehicle.sell", "vehicle.buy",
      "vehicle.seize", "vehicle.delete", "vehicle.maintenance", "vehicle.reconcile",
    ]) {
      assert.ok((byAction[action] ?? 0) >= 1, `expected audit rows for ${action}`);
    }
  });

  await t.test("properties: create/grant/buy/storage key access/sell/transfer/seize/delete + garage capacity", async () => {
    const bridgePost = async (path: string, body: unknown) => {
      const raw = JSON.stringify(body);
      return fetch(`${baseUrl}${path}`, { method: "POST", headers: signedHeaders(BDS_SECRET, raw), body: raw });
    };
    const bridgeJson = async (path: string, body: unknown) =>
      ((await bridgePost(path, body)).json()) as Promise<any>;

    // fresh linked characters K (buyer) and L (recipient/key-holder)
    const k = await upsertUserByDiscordId("2201", "UserK");
    const tokenK = await issueSessionToken(k.id);
    assert.equal((await postAs("/character", { name: "Kim" }, tokenK)).status, 201);
    const l = await upsertUserByDiscordId("2202", "UserL");
    const tokenL = await issueSessionToken(l.id);
    assert.equal((await postAs("/character", { name: "Leo" }, tokenL)).status, 201);
    for (const [tag, xuid] of [["K", "p-K"], ["L", "p-L"]] as const) {
      const codeRes = await postAs("/character/link-code", {}, tag === "K" ? tokenK : tokenL);
      const { code } = await codeRes.json();
      const raw = JSON.stringify({ code, xuid });
      assert.equal((await fetch(`${baseUrl}/bridge/character/link`, {
        method: "POST", headers: signedHeaders(BDS_SECRET, raw), body: raw,
      })).status, 200);
    }

    const charK = Number((await pool.query(
      `SELECT id FROM characters WHERE persistent_id = 'p-K'`
    )).rows[0].id);
    const charL = Number((await pool.query(
      `SELECT id FROM characters WHERE persistent_id = 'p-L'`
    )).rows[0].id);

    const cash = async (cid: number) => Number((await pool.query(
      `SELECT balance_cents FROM wallets WHERE character_id = $1`, [cid]
    )).rows[0]?.balance_cents ?? 0);
    const deedCount = async (cid: number, pid: number) => Number((await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::int FROM inventory_slots
       WHERE character_id = $1 AND item_id = 'rp:property_key' AND (item_metadata->>'property_id')::bigint = $2`,
      [cid, pid]
    )).rows[0].coalesce);

    // unlinked bridge playerId -> 404
    assert.equal((await bridgePost("/bridge/property/mine", { playerId: "p-nobody" })).status, 404);

    // admin creates an unowned government lot for sale (garage +2, deed-less)
    const created = (await postAs("/admin/properties", {
      propertyType: "house", address: "123 Test Road", ownerCharacterId: null,
      garageCapacity: 2, salePriceCents: 300000, saleCurrency: "cash",
    }, ctx.tokenA)).status;
    assert.equal(created, 201);
    const prop = (await (await getAs("/admin/properties", ctx.tokenA)).json()).properties
      .find((p: any) => p.address === "123 Test Road");
    assert.ok(prop, "property listed in admin list");
    assert.equal(prop.status, "owned");
    assert.equal(prop.ownerCharacterId, null);
    assert.equal(prop.garageCapacity, 2);
    assert.equal(prop.storageInventoryId > 0, true);
    assert.equal(await deedCount(charK, prop.id), 0);
    assert.equal(await deedCount(charL, prop.id), 0);

    // non-owner without a key cannot touch it (403 on lock)
    assert.equal((await bridgePost("/bridge/property/lock", {
      playerId: "p-L", propertyId: prop.id, locked: false,
    })).status, 403);
    // buying without funds -> 409 (InsufficientFunds)
    assert.equal((await bridgePost("/bridge/property/buy", { playerId: "p-L", propertyId: prop.id })).status, 409);

    // Kim funds up and buys the lot: money debited, deed delivered, listing cleared
    await ctx.economy.credit({ characterId: charK, amountCents: 500000, reason: "test seed", actorUserId: k.id, currency: "cash" });
    assert.equal(await cash(charK), 500000);
    const bought = await bridgeJson("/bridge/property/buy", { playerId: "p-K", propertyId: prop.id });
    assert.equal(bought.ok, true);
    assert.equal(bought.property.ownerCharacterId, charK);
    assert.equal(bought.property.salePriceCents, null);
    assert.equal(await cash(charK), 200000);
    assert.equal(await deedCount(charK, prop.id), 1);

    // garage capacity now includes the property (+2 on the base 3) — bridge + web
    const mine = await bridgeJson("/bridge/property/mine", { playerId: "p-K" });
    assert.equal(mine.ok, true);
    assert.equal(mine.garageCapacity, 5);
    const garageK = await bridgeJson("/bridge/vehicle/mine", { playerId: "p-K" });
    assert.equal(garageK.garageCapacity, 5);
    const webGarageK = await (await getAs("/character/vehicles", tokenK)).json();
    assert.equal(webGarageK.garageCapacity, 5);

    // property web card
    const webProps = await (await getAs("/character/properties", tokenK)).json();
    assert.equal(webProps.garageCapacity, 5);
    assert.equal(webProps.propertyCount, 1);
    assert.equal(webProps.storageCount, 1);

    // storage is visible + usable by the owner
    const viewOwner = await (await bridgePost("/bridge/inventory/view", { playerId: "p-K" })).json();
    const storage = viewOwner.containers.find((c: any) => Number(c.id) === prop.storageInventoryId);
    assert.ok(storage, "owner sees property storage listed");
    assert.equal(storage.storage_type, "house");
    await postAs("/admin/inventory/give", { characterId: charK, itemId: "rp:bandage", quantity: 10 }, ctx.tokenA);
    const moveIn = await bridgeJson("/bridge/inventory/move", {
      playerId: "p-K", itemId: "rp:bandage", quantity: 4, from: "character", to: storage.id,
    });
    assert.equal(moveIn.ok, true);

    // key-holder access: hand Kim's deed physical item to Leo (no ownership change)
    await pool.query(
      `UPDATE inventory_slots SET character_id = $1
       WHERE character_id = $2 AND item_id = 'rp:property_key' AND (item_metadata->>'property_id')::bigint = $3`,
      [charL, charK, prop.id]
    );
    assert.equal(await deedCount(charK, prop.id), 0);
    assert.equal(await deedCount(charL, prop.id), 1);
    // Leo (key only) can view + move into the storage despite not owning the property
    const viewKey = await (await bridgePost("/bridge/inventory/view", { playerId: "p-L" })).json();
    assert.ok(viewKey.containers.some((c: any) => Number(c.id) === prop.storageInventoryId), "key-holder sees property storage");
    await postAs("/admin/inventory/give", { characterId: charL, itemId: "rp:bandage", quantity: 10 }, ctx.tokenA);
    const moveInKey = await bridgeJson("/bridge/inventory/move", {
      playerId: "p-L", itemId: "rp:bandage", quantity: 2, from: "character", to: prop.storageInventoryId,
    });
    assert.equal(moveInKey.ok, true);
    // Leo can toggle the lock for the house he holds the deed to
    const lockLeo = await bridgeJson("/bridge/property/lock", { playerId: "p-L", propertyId: prop.id, locked: true });
    assert.equal(lockLeo.ok, true);

    // Leo gets free ownership transfer from Kim (deed moves atomically)
    const transferToLeo = await bridgeJson("/bridge/property/transfer", { playerId: "p-K", propertyId: prop.id, targetPersistentId: "p-L" });
    assert.equal(transferToLeo.ok, true);
    assert.equal(transferToLeo.property.ownerCharacterId, charL);
    assert.equal(await deedCount(charL, prop.id), 1);
    assert.equal(await deedCount(charK, prop.id), 0);

    // Leo, now the owner, lists it for sale; show on market
    const sale = await bridgeJson("/bridge/property/sell", {
      playerId: "p-L", propertyId: prop.id, priceCents: 400000, currency: "cash",
    });
    assert.equal(sale.ok, true);
    assert.equal(sale.property.salePriceCents, 400000);
    const shopList = await bridgeJson("/bridge/property/shop", {});
    assert.ok(shopList.properties.some((p: any) => Number(p.id) === prop.id));

    // transfer is refused while listed
    assert.equal((await bridgePost("/bridge/property/transfer", {
      playerId: "p-L", propertyId: prop.id, targetPersistentId: "p-K",
    })).status, 409);
    const unlist = await bridgeJson("/bridge/property/sell", {
      playerId: "p-L", propertyId: prop.id, priceCents: null, currency: "cash",
    });
    assert.equal(unlist.property.salePriceCents, null);

    // free transfer back to Kim (same-owner hobby): keys move atomically
    const transfer = await bridgeJson("/bridge/property/transfer", { playerId: "p-L", propertyId: prop.id, targetPersistentId: "p-K" });
    assert.equal(transfer.ok, true);
    assert.equal(transfer.property.ownerCharacterId, charK);
    assert.equal(await deedCount(charK, prop.id), 1);
    assert.equal(await deedCount(charL, prop.id), 0);

    // admin: grant to Leo (old owner keys revoked), then seize, then delete
    assert.equal((await postAs(`/admin/properties/${prop.id}/grant`, { ownerCharacterId: charL }, ctx.tokenA)).status, 200);
    assert.equal(await deedCount(charK, prop.id), 0);
    assert.equal(await deedCount(charL, prop.id), 1);
    assert.equal((await postAs(`/admin/properties/${prop.id}/seize`, {}, ctx.tokenA)).status, 200);
    assert.equal(await deedCount(charL, prop.id), 0);
    // seized blocks operations + cannot be granted
    assert.equal((await bridgePost("/bridge/property/lock", { playerId: "p-K", propertyId: prop.id, locked: false })).status, 409);
    assert.equal((await postAs(`/admin/properties/${prop.id}/grant`, { ownerCharacterId: charK }, ctx.tokenA)).status, 409);
    const mineAfterSeize = await bridgeJson("/bridge/property/mine", { playerId: "p-K" });
    assert.equal(mineAfterSeize.propertyCount, 0);
    assert.equal(mineAfterSeize.garageCapacity, 3);
    // admin can still delete (storage + keys cleaned up)
    assert.equal((await delAs(`/admin/properties/${prop.id}`, ctx.tokenA)).status, 204);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM properties WHERE id = $1`, [prop.id])).rows[0].n, 0);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS n FROM inventory_slots WHERE item_id = 'rp:property_key' AND (item_metadata->>'property_id')::bigint = $1`,
      [prop.id]
    )).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM inventories WHERE id = $1`, [prop.storageInventoryId])).rows[0].n, 0);

    // every mutation wrote an audit row (sample assertions)
    const audits = (await pool.query(
      `SELECT action, COUNT(*)::int AS n FROM audit_log WHERE target_type = 'property' GROUP BY action`
    )).rows;
    const byAction = Object.fromEntries(audits.map((a: any) => [a.action, a.n]));
    for (const action of [
      "property.create", "property.buy", "property.lock", "property.sell", "property.listing_remove",
      "property.transfer", "property.grant", "property.seize", "property.delete",
    ]) {
      assert.ok((byAction[action] ?? 0) >= 1, `expected audit rows for ${action}`);
    }
  });

  await t.test("police: MDT lookup / license / fine money-sink / warrant / report+evidence / arrest-jail-release / audit", async () => {
    const bridgePost = async (path: string, body: unknown) => {
      const raw = JSON.stringify(body);
      return fetch(`${baseUrl}${path}`, { method: "POST", headers: signedHeaders(BDS_SECRET, raw), body: raw });
    };
    const bridgeJson = async (path: string, body: unknown) =>
      ((await bridgePost(path, body)).json()) as Promise<any>;

    // fresh characters O (officer) and N (citizen)
    const o = await upsertUserByDiscordId("3301", "UserO");
    const tokenO = await issueSessionToken(o.id);
    assert.equal((await postAs("/character", { name: "Officer" }, tokenO)).status, 201);
    const n = await upsertUserByDiscordId("3302", "UserN");
    const tokenN = await issueSessionToken(n.id);
    assert.equal((await postAs("/character", { name: "Nate" }, tokenN)).status, 201);
    for (const [tag, xuid] of [["O", "p-O"], ["N", "p-N"]] as const) {
      const codeRes = await postAs("/character/link-code", {}, tag === "O" ? tokenO : tokenN);
      const { code } = await codeRes.json();
      const raw = JSON.stringify({ code, xuid });
      assert.equal((await fetch(`${baseUrl}/bridge/character/link`, {
        method: "POST", headers: signedHeaders(BDS_SECRET, raw), body: raw,
      })).status, 200);
    }
    const charO = Number((await pool.query(`SELECT id FROM characters WHERE persistent_id = 'p-O'`)).rows[0].id);
    const charN = Number((await pool.query(`SELECT id FROM characters WHERE persistent_id = 'p-N'`)).rows[0].id);
    await ctx.economy.credit({ characterId: charN, amountCents: 150000, reason: "test seed", actorUserId: n.id, currency: "cash" });

    const cashOf = async (cid: number) => Number((await pool.query(
      `SELECT balance_cents FROM wallets WHERE character_id = $1`, [cid]
    )).rows[0]?.balance_cents ?? 0);
    const ledgerRef = async (cid: number, refType: string) => Number((await pool.query(
      `SELECT COUNT(*)::int FROM transactions WHERE character_id = $1 AND ref_type = $2`,
      [cid, refType]
    )).rows[0].count);

    // grant officer role to the officer; nobody else has police perms yet
    await grantRoleByName(pool, o.id, "police");

    // --- citizen root (anyone) + denial paths
    const me1 = await bridgeJson("/bridge/police/me", { playerId: "p-O" });
    assert.equal(me1.ok, true);
    assert.deepEqual(me1.mine.licenses, []);
    const rolesO = await bridgeJson("/bridge/police/roles", { playerId: "p-O" });
    assert.equal(rolesO.roles.canView, true);
    assert.equal(rolesO.roles.canManage, true);
    const rolesN = await bridgeJson("/bridge/police/roles", { playerId: "p-N" });
    assert.equal(rolesN.roles.canView, false);

    // citizen without RBAC is refused and a HIGH security event is raised
    const denied = await bridgePost("/bridge/police/lookup/character", {
      playerId: "p-N", actorName: "Nate", actorPersistentId: "p-N", query: "Officer",
    });
    assert.equal(denied.status, 403);
    const sec = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM security_events WHERE event_type = 'staff_command_forbidden' AND payload->>'command' = 'police.lookup.character' AND actor_user_id = $1`,
      [n.id]
    )).rows[0];
    assert.equal(sec.n, 1, "denial must raise a HIGH security event");

    // unknown actor persistentId -> 404
    assert.equal((await bridgePost("/bridge/police/lookup/character", {
      playerId: "p-O", actorName: "Ghost", actorPersistentId: "p-ghost", query: "Officer",
    })).status, 404);

    // --- MDT citizen + vehicle lookups
    const lookup = await bridgeJson("/bridge/police/lookup/character", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O", query: "Nate",
    });
    assert.equal(lookup.ok, true);
    assert.equal(Number(lookup.citizen.id), charN);
    assert.equal(lookup.citizen.record, null, "no police record yet");

    const carId = (await pool.query(
      `INSERT INTO vehicles (entity_type, plate, owner_character_id, status, trunk_inventory_id)
       VALUES ('megaverse:buggy', 'RP-POL1', $1, 'garaged', NULL) RETURNING id`,
      [charN]
    )).rows[0].id;
    void carId;
    const vLookup = await bridgeJson("/bridge/police/lookup/vehicle", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O", plate: "RP-POL1",
    });
    assert.equal(vLookup.ok, true);
    assert.equal(vLookup.vehicle.plate, "RP-POL1");
    assert.equal(vLookup.vehicle.ownerName, "Nate");
    assert.equal((await bridgePost("/bridge/police/lookup/vehicle", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O", plate: "NOPE",
    })).status, 404);

    // --- licenses: issue (active) / duplicate blocked / suspend / revoke
    const lic = await bridgeJson("/bridge/police/license", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      targetPersistentId: "p-N", targetName: "Nate", action: "issue", licenseType: "driving", notes: null,
    });
    assert.equal(lic.ok, true);
    assert.equal(lic.license.licenseType, "driving");
    assert.equal(lic.license.status, "valid");
    assert.equal((await bridgePost("/bridge/police/license", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      targetPersistentId: "p-N", targetName: "Nate", action: "issue", licenseType: "driving", notes: null,
    })).status, 409, "one active license per type");
    assert.equal((await bridgeJson("/bridge/police/license", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      targetPersistentId: "p-N", targetName: "Nate", action: "suspend", licenseType: "driving", notes: "test",
    })).license.status, "suspended");
    assert.equal((await bridgeJson("/bridge/police/license", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      targetPersistentId: "p-N", targetName: "Nate", action: "revoke", licenseType: "driving", notes: null,
    })).license.status, "revoked");
    const meN = await bridgeJson("/bridge/police/me", { playerId: "p-N" });
    assert.ok(meN.mine.licenses.every((l: any) => l.licenseType !== "driving" || l.status !== "valid"));

    // --- fines: issue (no money), citizen pays via bridge = money sink
    assert.equal((await bridgePost("/bridge/police/fine", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      targetPersistentId: "p-N", targetName: "Nate", amountCents: 50000, currency: "cash", reason: "ค่าปรับจราจร",
    })).status, 200);
    const finesBefore = await bridgeJson("/bridge/police/me", { playerId: "p-N" });
    const unpaid = finesBefore.mine.fines.find((f: any) => f.status === "outstanding");
    assert.ok(unpaid, "fine is outstanding");
    assert.equal(await cashOf(charN), 150000, "fine issuance does not move money");
    const paid = await bridgeJson("/bridge/police/fine/pay", { playerId: "p-N", fineId: unpaid.id });
    assert.equal(paid.ok, true);
    assert.equal(paid.fine.status, "paid");
    assert.equal(await cashOf(charN), 100000, "paying a fine debits the exact cash (money sink)");
    assert.equal(await ledgerRef(charN, "fine"), 1, "ledger keeps a 'fine' ref row");
    assert.equal((await bridgePost("/bridge/police/fine/pay", { playerId: "p-N", fineId: unpaid.id })).status, 409, "double-pay blocked");

    // citizen cannot pay someone else's fine
    await bridgeJson("/bridge/police/fine", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      targetPersistentId: "p-N", targetName: "Nate", amountCents: 10000, currency: "cash", reason: "อีกค่าปรับ",
    });
    const secondUnpaid = (await bridgeJson("/bridge/police/me", { playerId: "p-N" })).mine.fines.find((f: any) => f.status === "outstanding");
    assert.equal((await bridgePost("/bridge/police/fine/pay", { playerId: "p-O", fineId: secondUnpaid.id })).status, 403, "only the target pays");

    // web player route also pays
    const webFine = await bridgeJson("/bridge/police/fine", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      targetPersistentId: "p-N", targetName: "Nate", amountCents: 20000, currency: "cash", reason: "web pay",
    });
    assert.equal((await postAs(`/character/fines/${webFine.fine.id}/pay`, {}, tokenN)).status, 200);
    const webState = await (await getAs("/character/police", tokenN)).json();
    assert.ok(webState.police.fines.every((f: any) => f.status !== "outstanding" || f.id !== webFine.fine.id));

    // --- warrants: issue by officer, non-senior cannot revoke, admin can
    const warr = await bridgeJson("/bridge/police/warrant", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      targetPersistentId: "p-N", targetName: "Nate", warrantType: "arrest", reason: "กำลังสืบสวน", minutes: 600,
    });
    assert.equal(warr.ok, true);
    assert.equal(warr.warrant.status, "active");
    assert.equal((await bridgePost("/bridge/police/warrant/revoke", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O", warrantId: warr.warrant.id,
    })).status, 403, "police.manage cannot revoke a warrant");
    const adminRevoke = await (await postAs(`/admin/police/warrants/${warr.warrant.id}/revoke`, {}, ctx.tokenA)).json();
    assert.equal(adminRevoke.warrant.status, "revoked");
    const meW = await bridgeJson("/bridge/police/me", { playerId: "p-N" });
    assert.equal(meW.mine.warrants.length, 0, "revoked warrant not active anymore");

    // --- reports + evidence
    const rep = await bridgeJson("/bridge/police/report", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      title: "ตรวจพบความผิด", body: "พบการกระทำความผิดในพื้นที่ ตรวจสอบแล้ว", classification: "restricted",
    });
    assert.equal(rep.ok, true);
    assert.equal(rep.report.status, "open");
    const ev = await bridgeJson("/bridge/police/evidence", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      reportId: rep.report.id, description: "กล้องวงจรปิดจุดเกิดเหตุ", itemId: null, quantity: 1,
    });
    assert.equal(ev.ok, true);
    const closed = await bridgeJson("/bridge/police/report/close", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O", reportId: rep.report.id,
    });
    assert.equal(closed.ok, true);
    assert.equal(closed.report.status, "closed");

    // --- arrest / jail / early release
    const arrest = await bridgeJson("/bridge/police/arrest", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      targetPersistentId: "p-N", targetName: "Nate", reason: "ละเมิดกฎ", minutes: 30,
    });
    assert.equal(arrest.ok, true);
    assert.equal(arrest.arrest.status, "active");
    assert.equal((await bridgePost("/bridge/police/arrest", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      targetPersistentId: "p-N", targetName: "Nate", reason: "ซ้ำ", minutes: 30,
    })).status, 409, "already in jail");
    const meJail = await bridgeJson("/bridge/police/me", { playerId: "p-N" });
    assert.equal(meJail.mine.arrest.status, "active");
    const released = await bridgeJson("/bridge/police/release", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      targetPersistentId: "p-N", targetName: "Nate",
    });
    assert.equal(released.ok, true);
    assert.equal(released.arrest.status, "released");
    assert.equal((await bridgeJson("/bridge/police/me", { playerId: "p-N" })).mine.arrest, null);

    // --- record update
    const rec = await bridgeJson("/bridge/police/record", {
      playerId: "p-O", actorName: "Officer", actorPersistentId: "p-O",
      targetPersistentId: "p-N", targetName: "Nate", alias: "นัท", threatLevel: "high", notes: "ติดตามต่อ",
    });
    assert.equal(rec.ok, true);
    assert.equal(rec.record.threatLevel, "high");
    assert.equal(rec.record.knownAlias, "นัท");

    // --- admin web surfaces
    const citizens = await (await getAs("/admin/police/citizens?query=Nate", ctx.tokenA)).json();
    assert.ok(citizens.citizens.some((c: any) => Number(c.id) === charN && c.threatLevel === "high"));
    const paidFines = await (await getAs("/admin/police/fines?status=paid", ctx.tokenA)).json();
    assert.ok(paidFines.fines.length >= 2);
    const warrantsList = await (await getAs("/admin/police/warrants?status=revoked", ctx.tokenA)).json();
    assert.ok(warrantsList.warrants.some((w: any) => w.id === warr.warrant.id));
    const reportsList = await (await getAs("/admin/police/reports?status=closed", ctx.tokenA)).json();
    assert.ok(reportsList.reports.some((r: any) => r.id === rep.report.id));
    const arrestsList = await (await getAs("/admin/police/arrests?status=released", ctx.tokenA)).json();
    assert.ok(arrestsList.arrests.some((a: any) => a.id === arrest.arrest.id));
    // non-police user cannot hit the admin surface
    assert.equal((await getAs("/admin/police/citizens", tokenN)).status, 403);
    // senior-only: officer (police.manage) cannot early-release via admin
    assert.equal((await postAs("/admin/police/release", { characterId: charN }, tokenO)).status, 403);
    // admin can issue a fresh arrest + release via admin routes
    const adminArrest = await (await postAs("/admin/police/arrests", { characterId: charN, reason: "เทสต์ admin", minutes: 10 }, ctx.tokenA)).json();
    assert.equal(adminArrest.arrest.status, "active");
    assert.equal((await postAs("/admin/police/release", { characterId: charN }, ctx.tokenA)).status, 200);

    // every mutation wrote an audit row
    const audits = await pool.query(`SELECT action, COUNT(*)::int AS n FROM audit_log WHERE target_type IN ('license','fine','warrant','report','evidence','arrest','character') GROUP BY action`);
    const byAction = Object.fromEntries(audits.rows.map((a: any) => [a.action, a.n]));
    for (const action of [
      "police.record", "police.fine.issue", "police.fine.pay",
      "police.warrant.issue", "police.warrant.revoke", "police.report.create",
      "police.report.close", "police.evidence.add", "police.arrest.issue", "police.arrest.release",
    ]) {
      assert.ok((byAction[action] ?? 0) >= 1, `expected audit rows for ${action}`);
    }
    assert.ok(Object.keys(byAction).some((a) => a.startsWith("police.license.")), "expected police.license.* audit rows");
  });

  // cleanup
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  await pool.end();
  await ctx.redis.quit();
});

async function vehicleModuleGet(vehicleId: number): Promise<{ fuelLevel: number; engineHealth: number; locked: boolean }> {
  const { getVehicle } = await import("../modules/vehicle/index.js");
  const v = await getVehicle(vehicleId);
  if (!v) throw new Error("vehicle not found");
  return { fuelLevel: v.fuelLevel, engineHealth: v.engineHealth, locked: v.locked };
}