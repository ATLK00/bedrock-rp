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

  // cleanup
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  await pool.end();
  await ctx.redis.quit();
});