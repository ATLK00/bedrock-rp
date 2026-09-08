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

const TEST_DB_URL = "postgres://bedrock_rp:changeme@localhost:5434/bedrock_rp_test";
const ADMIN_DB_URL = "postgres://bedrock_rp:changeme@localhost:5434/bedrock_rp";
const BDS_SECRET = "test-bridge-secret-0123456789abcdef";

/** Drop + recreate + migrate a clean `bedrock_rp_test`, controlling DATABASE_URL. */
async function prepareTestDatabase() {
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
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.BDS_BRIDGE_SECRET = BDS_SECRET;
  process.env.JWT_SECRET = "test-jwt-secret-0123456789abcdefghijklmnopqrstuv";

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

  // cleanup
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  await pool.end();
  await ctx.redis.quit();
});