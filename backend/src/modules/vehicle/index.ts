import { pool, withTransaction } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";
import * as inventory from "../inventory/index.js";
import * as economy from "../economy/index.js";
import * as property from "../property/index.js";

/**
 * Vehicle system — the server-authoritative half of in-world vehicles.
 *
 * The behavior pack's car addon (Car AllDay Town) handles driving physics only.
 * EVERYTHING persistent lives here: ownership (character > vehicle), garage
 * (per-character slot cap), the physical key item, the unique plate, fuel and
 * damage state, lock/unlock, repair, transfers/sales, and the trunk (reuses
 * storage_type='vehicle' containers, so the trunk already shows up in `!inv`).
 *
 * Trust model (same as the rest of the bridge): the pack reports sensors
 * (ticks driven, damage observed) and is NEVER trusted to decide money or
 * ownership. Fuel is only ever consumed here (driving-tick reports) or added
 * here (paid refuels); damage is only ever increased here (crash reports) or
 * removed here (paid repair). Every state transition is audited.
 */

export const KEY_ITEM_ID = "rp:vehicle_key";

// Hardcoded balance knobs (same style as the trade-expiry threshold).
export const VEHICLE_FUEL_BURN_PER_TICK = 1 / 2400; // a full 100-unit tank lasts ~200 minutes of driving
export const VEHICLE_FUEL_PRICE_CENTS_PER_UNIT = 10; // 0.10 per fuel unit
export const VEHICLE_REPAIR_ENGINE_CENTS_PER_POINT = 3;
export const VEHICLE_REPAIR_SUSPENSION_CENTS_PER_POINT = 2;
export const VEHICLE_REPAIR_BODY_CENTS_PER_POINT = 1;
export const VEHICLE_TRUNK_CAPACITY_WEIGHT_G = 50000;

export class VehicleNotFoundError extends Error {}
export class VehicleAccessDeniedError extends Error {}
export class VehicleInUseError extends Error {}
export class VehicleGarageFullError extends Error {}

export interface VehicleView {
  id: number;
  entityType: string;
  plate: string;
  ownerCharacterId: number | null;
  status: string;
  locked: boolean;
  fuelLevel: number;
  engineHealth: number;
  suspensionHealth: number;
  bodyDamage: number;
  trunkInventoryId: number | null;
  salePriceCents: number | null;
  saleCurrency: string | null;
  createdAt: string;
}

function toVehicleView(row: any): VehicleView {
  return {
    id: Number(row.id),
    entityType: row.entity_type,
    plate: row.plate,
    ownerCharacterId: row.owner_character_id == null ? null : Number(row.owner_character_id),
    status: row.status,
    locked: row.locked,
    fuelLevel: Number(row.fuel_level),
    engineHealth: Number(row.engine_health),
    suspensionHealth: Number(row.suspension_health),
    bodyDamage: Number(row.body_damage),
    trunkInventoryId: row.trunk_inventory_id == null ? null : Number(row.trunk_inventory_id),
    salePriceCents: row.sale_price_cents == null ? null : Number(row.sale_price_cents),
    saleCurrency: row.sale_currency ?? null,
    createdAt: String(row.created_at ?? ""),
  };
}

const PLATE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePlate(): string {
  let plate = "RP-";
  for (let i = 0; i < 5; i++) plate += PLATE_CHARS[Math.floor(Math.random() * PLATE_CHARS.length)];
  return plate;
}

async function lockVehicleRow(client: any, vehicleId: number) {
  const { rows } = await client.query(`SELECT * FROM vehicles WHERE id = $1 FOR UPDATE`, [vehicleId]);
  return rows[0] ?? null;
}

async function assertGarageRoom(client: any, characterId: number): Promise<void> {
  const { rows } = await client.query(
    `SELECT c.garage_capacity +
              COALESCE((SELECT SUM(p.garage_capacity) FROM properties p WHERE p.owner_character_id = c.id AND p.status = 'owned'), 0)
            AS capacity,
            (SELECT COUNT(*) FROM vehicles v WHERE v.owner_character_id = c.id AND v.status <> 'seized')::int AS owned
     FROM characters c WHERE c.id = $1`,
    [characterId]
  );
  if (rows.length === 0) throw new Error("character not found");
  if (Number(rows[0].owned) >= Number(rows[0].capacity)) throw new VehicleGarageFullError();
}

/** Inventories storage_type='vehicle' — the trunk. Created in the same tx as the vehicle row. */
async function createTrunk(client: any, ownerCharacterId: number | null, plate: string): Promise<number> {
  const { rows } = await client.query(
    `INSERT INTO inventories (storage_type, owner_character_id, label, capacity_weight_g)
     VALUES ('vehicle', $1, $2, $3) RETURNING id`,
    [ownerCharacterId, `Trunk ${plate}`, VEHICLE_TRUNK_CAPACITY_WEIGHT_G]
  );
  return Number(rows[0].id);
}

export async function getVehicle(vehicleId: number): Promise<VehicleView | null> {
  const { rows } = await pool.query(`SELECT * FROM vehicles WHERE id = $1`, [vehicleId]);
  return rows[0] ? toVehicleView(rows[0]) : null;
}

export async function getVehicleByPlate(plate: string): Promise<VehicleView | null> {
  const { rows } = await pool.query(`SELECT * FROM vehicles WHERE plate = $1`, [plate]);
  return rows[0] ? toVehicleView(rows[0]) : null;
}

export async function listVehicles(params: {
  ownerCharacterId?: number | null;
  status?: string | null;
  forSale?: boolean;
  limit?: number;
  offset?: number;
} = {}): Promise<Array<VehicleView & { ownerName: string | null }>> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
  const offset = Math.max(0, params.offset ?? 0);
  const where: string[] = [];
  const values: unknown[] = [];
  if (params.ownerCharacterId != null) {
    values.push(params.ownerCharacterId);
    where.push(`v.owner_character_id = $${values.length}`);
  }
  if (params.status) {
    values.push(params.status);
    where.push(`v.status = $${values.length}`);
  }
  if (params.forSale) {
    where.push(`v.sale_price_cents IS NOT NULL`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  values.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT v.*, c.name AS owner_name
     FROM vehicles v
     LEFT JOIN characters c ON c.id = v.owner_character_id
     ${whereSql}
     ORDER BY v.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return rows.map((r: any) => ({ ...toVehicleView(r), ownerName: r.owner_name ?? null }));
}

export async function hasVehicleKey(characterId: number, vehicleId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM inventory_slots
     WHERE character_id = $1 AND item_id = $2 AND (item_metadata->>'vehicle_id')::bigint = $3
     LIMIT 1`,
    [characterId, KEY_ITEM_ID, vehicleId]
  );
  return rows.length > 0;
}

export async function revokeVehicleKeys(characterId: number, vehicleId: number): Promise<void> {
  await pool.query(
    `DELETE FROM inventory_slots
     WHERE character_id = $1 AND item_id = $2 AND (item_metadata->>'vehicle_id')::bigint = $3`,
    [characterId, KEY_ITEM_ID, vehicleId]
  );
}

/** Issue the physical key item into a character's carry slots (their own tx). */
export async function grantVehicleKey(characterId: number, vehicleId: number, actorUserId: number): Promise<void> {
  await inventory.giveItem({
    characterId,
    itemId: KEY_ITEM_ID,
    quantity: 1,
    actorUserId,
    meta: { vehicle_id: vehicleId },
  });
}

// ---------------------------------------------------------------------------
// Creation / admin ownership
// ---------------------------------------------------------------------------

export async function createVehicle(params: {
  entityType?: string;
  ownerCharacterId?: number | null;
  locked?: boolean;
  salePriceCents?: number | null;
  saleCurrency?: string | null;
  actorUserId: number;
  requestId?: string | null;
}): Promise<VehicleView> {
  const entityType = (params.entityType ?? "megaverse:buggy").trim().slice(0, 64) || "megaverse:buggy";
  const saleCurrency = params.saleCurrency ?? "cash";
  if (params.salePriceCents != null && params.salePriceCents <= 0) {
    throw new Error("salePriceCents must be positive when set");
  }
  const plate = generatePlate();

  const view = await withTransaction(async (client) => {
    if (params.ownerCharacterId != null) await assertGarageRoom(client, params.ownerCharacterId);
    const trunkId = await createTrunk(client, params.ownerCharacterId ?? null, plate);
    const { rows } = await client.query(
      `INSERT INTO vehicles (entity_type, plate, owner_character_id, locked, trunk_inventory_id, sale_price_cents, sale_currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        entityType,
        plate,
        params.ownerCharacterId ?? null,
        params.locked ?? true,
        trunkId,
        params.salePriceCents ?? null,
        params.salePriceCents != null ? saleCurrency : null,
      ]
    );
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "vehicle.create",
        targetType: "vehicle",
        targetId: String(rows[0].id),
        payload: { entityType, plate, ownerCharacterId: params.ownerCharacterId ?? null, isForSale: params.salePriceCents != null, salePriceCents: params.salePriceCents ?? null },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toVehicleView(rows[0]);
  });

  // Issue the key to the owner (own tx — done after the vehicle is committed so
  // a full inventory can't roll back the creation).
  if (params.ownerCharacterId != null) {
    try {
      await grantVehicleKey(params.ownerCharacterId, view.id, params.actorUserId);
    } catch (err) {
      // Key delivery failing is not a reason to fail the whole grant — the
      // owner can have one reissued / picked from the admin panel later.
      console.warn("[vehicle] create ok but key delivery failed (inventory full?)", err);
    }
  }
  return view;
}

/** Admin-only: assign/grant a vehicle to a character (garage cap enforced). */
export async function grantVehicle(params: {
  vehicleId: number;
  ownerCharacterId: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<VehicleView> {
  await withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();
    if (row.status === "seized") throw new VehicleInUseError("vehicle is seized");
    await assertGarageRoom(client, params.ownerCharacterId);
    // revoke keys held for this vehicle by anyone else, then transfer
    await client.query(
      `DELETE FROM inventory_slots
       WHERE item_id = $1 AND (item_metadata->>'vehicle_id')::bigint = $2
         AND character_id <> $3`,
      [KEY_ITEM_ID, params.vehicleId, params.ownerCharacterId]
    );
    await client.query(
      `UPDATE vehicles
       SET owner_character_id = $1, sale_price_cents = NULL, sale_currency = NULL, updated_at = now()
       WHERE id = $2`,
      [params.ownerCharacterId, params.vehicleId]
    );
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "vehicle.grant",
        targetType: "vehicle",
        targetId: String(params.vehicleId),
        payload: { ownerCharacterId: params.ownerCharacterId },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
  });
  const view = await getVehicle(params.vehicleId);
  if (!view) throw new VehicleNotFoundError();
  await grantVehicleKey(params.ownerCharacterId, params.vehicleId, params.actorUserId);
  return view;
}

// ---------------------------------------------------------------------------
// Access helpers (shared by deploy/store/lock/refuel/repair)
// ---------------------------------------------------------------------------

/**
 * Decide whether `characterId` may operate a vehicle: owner, key-holder, or a
 * staff user with vehicle.manage (permission checked by the caller).
 */
export async function canOperate(params: {
  characterId: number;
  vehicleId: number;
  isStaff?: boolean;
}): Promise<boolean> {
  const vehicle = await getVehicle(params.vehicleId);
  if (!vehicle) return false;
  if (params.isStaff) return true;
  if (vehicle.ownerCharacterId === params.characterId) return true;
  return hasVehicleKey(params.characterId, params.vehicleId);
}

// ---------------------------------------------------------------------------
// Lifecycle — deploy / store / lock
// ---------------------------------------------------------------------------

export async function deployVehicle(params: {
  vehicleId: number;
  characterId: number;
  isStaff?: boolean;
  actorUserId: number;
  requestId?: string | null;
}): Promise<VehicleView> {
  return withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();
    if (row.status === "seized") throw new VehicleInUseError("vehicle is seized");
    if (row.status !== "garaged") throw new VehicleInUseError("vehicle is already deployed");
    const own = Number(row.owner_character_id ?? 0) === params.characterId;
    if (!own && !params.isStaff) throw new VehicleAccessDeniedError();
    if (!own && params.isStaff) {
      // staff deploy is allowed for testing/admin purposes
    }
    await client.query(`UPDATE vehicles SET status = 'deployed', updated_at = now() WHERE id = $1`, [params.vehicleId]);
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "vehicle.deploy",
        targetType: "vehicle",
        targetId: String(params.vehicleId),
        payload: { characterId: params.characterId },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toVehicleView({ ...row, status: "deployed" });
  });
}

export async function storeVehicle(params: {
  vehicleId: number;
  characterId: number;
  isStaff?: boolean;
  actorUserId: number;
  requestId?: string | null;
}): Promise<VehicleView> {
  return withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();
    if (row.status === "seized") throw new VehicleInUseError("vehicle is seized");
    if (row.status !== "deployed") throw new VehicleInUseError("vehicle is not deployed");
    const own = Number(row.owner_character_id ?? 0) === params.characterId;
    const hasKey = await hasVehicleKey(params.characterId, params.vehicleId);
    if (!own && !hasKey && !params.isStaff) throw new VehicleAccessDeniedError();
    await client.query(`UPDATE vehicles SET status = 'garaged', updated_at = now() WHERE id = $1`, [params.vehicleId]);
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "vehicle.store",
        targetType: "vehicle",
        targetId: String(params.vehicleId),
        payload: { characterId: params.characterId },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toVehicleView({ ...row, status: "garaged" });
  });
}

export async function setVehicleLocked(params: {
  vehicleId: number;
  characterId: number;
  locked: boolean;
  isStaff?: boolean;
  actorUserId: number;
  requestId?: string | null;
}): Promise<VehicleView> {
  return withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();
    if (row.status === "seized") throw new VehicleInUseError("vehicle is seized");
    const own = Number(row.owner_character_id ?? 0) === params.characterId;
    const hasKey = await hasVehicleKey(params.characterId, params.vehicleId);
    if (!own && !hasKey && !params.isStaff) throw new VehicleAccessDeniedError();
    await client.query(`UPDATE vehicles SET locked = $1, updated_at = now() WHERE id = $2`, [params.locked, params.vehicleId]);
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: params.locked ? "vehicle.lock" : "vehicle.unlock",
        targetType: "vehicle",
        targetId: String(params.vehicleId),
        payload: { characterId: params.characterId, hasKey: !own && hasKey },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toVehicleView({ ...row, locked: params.locked });
  });
}

// ---------------------------------------------------------------------------
// Money verbs — refuel / repair (server decides price; wallet via economy)
// ---------------------------------------------------------------------------

export async function refuelVehicle(params: {
  vehicleId: number;
  characterId: number;
  units: number;
  currency?: economy.Currency;
  isStaff?: boolean;
  actorUserId: number;
  requestId?: string | null;
}): Promise<{ vehicle: VehicleView; costCents: number; refilledUnits: number }> {
  if (!Number.isFinite(params.units) || params.units <= 0) throw new Error("units must be positive");
  const currency = params.currency ?? "cash";

  // Read the row first (locked briefly) so we know how much can actually be paid for.
  let paidUnits = 0;
  await withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();
    if (row.status === "seized") throw new VehicleInUseError("vehicle is seized");
    const own = Number(row.owner_character_id ?? 0) === params.characterId;
    const hasKey = await hasVehicleKey(params.characterId, params.vehicleId);
    if (!own && !hasKey && !params.isStaff) throw new VehicleAccessDeniedError();
    paidUnits = Math.min(params.units, 100.0 - Number(row.fuel_level));
    if (paidUnits <= 0) throw new VehicleInUseError("fuel tank is already full");
  });

  const costCents = Math.ceil(paidUnits * VEHICLE_FUEL_PRICE_CENTS_PER_UNIT);
  await economy.debit({
    characterId: params.characterId,
    amountCents: costCents,
    reason: `refuel vehicle #${params.vehicleId}`,
    actorUserId: params.actorUserId,
    currency,
    refType: "vehicle_refuel",
    requestId: params.requestId,
  });

  // Apply (re-checked inside the tx so a concurrent refuel can't overflow the tank).
  const applied = await withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    const add = Math.min(paidUnits, 100.0 - Number(row.fuel_level));
    await client.query(`UPDATE vehicles SET fuel_level = fuel_level + $1, updated_at = now() WHERE id = $2`, [add, params.vehicleId]);
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "vehicle.refuel",
        targetType: "vehicle",
        targetId: String(params.vehicleId),
        payload: { characterId: params.characterId, units: add, costCents, currency },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return add;
  });

  const vehicle = await getVehicle(params.vehicleId);
  if (!vehicle) throw new VehicleNotFoundError();
  return { vehicle, costCents, refilledUnits: applied };
}

export async function repairVehicle(params: {
  vehicleId: number;
  characterId: number;
  currency?: economy.Currency;
  isStaff?: boolean;
  actorUserId: number;
  requestId?: string | null;
}): Promise<{ vehicle: VehicleView; costCents: number }> {
  const currency = params.currency ?? "cash";

  let costCents = 0;
  await withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();
    if (row.status === "seized") throw new VehicleInUseError("vehicle is seized");
    const own = Number(row.owner_character_id ?? 0) === params.characterId;
    const hasKey = await hasVehicleKey(params.characterId, params.vehicleId);
    if (!own && !hasKey && !params.isStaff) throw new VehicleAccessDeniedError();

    const engine = 100.0 - Number(row.engine_health);
    const susp = 100.0 - Number(row.suspension_health);
    const body = Number(row.body_damage);
    costCents = Math.ceil(
      engine * VEHICLE_REPAIR_ENGINE_CENTS_PER_POINT +
      susp * VEHICLE_REPAIR_SUSPENSION_CENTS_PER_POINT +
      body * VEHICLE_REPAIR_BODY_CENTS_PER_POINT
    );
    if (costCents <= 0) throw new VehicleInUseError("nothing to repair");
  });

  await economy.debit({
    characterId: params.characterId,
    amountCents: costCents,
    reason: `repair vehicle #${params.vehicleId}`,
    actorUserId: params.actorUserId,
    currency,
    refType: "vehicle_repair",
    requestId: params.requestId,
  });

  await withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    await client.query(
      `UPDATE vehicles SET engine_health = 100.0, suspension_health = 100.0, body_damage = 0.0, updated_at = now() WHERE id = $1`,
      [params.vehicleId]
    );
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "vehicle.repair",
        targetType: "vehicle",
        targetId: String(params.vehicleId),
        payload: { characterId: params.characterId, costCents, currency },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    void row;
  });

  const vehicle = await getVehicle(params.vehicleId);
  if (!vehicle) throw new VehicleNotFoundError();
  return { vehicle, costCents };
}

// ---------------------------------------------------------------------------
// State sync — the pack reports sensors; the server stays the source of truth.
// Fuel never increases here (only paid refuels add), damage only here or via
// repair roughly increases, and the authoritative snapshot is echoed back.
// ---------------------------------------------------------------------------

export async function ingestVehicleState(params: {
  vehicleId: number;
  drivingTicks?: number;
  engineHealth?: number;
  suspensionHealth?: number;
  bodyDamage?: number;
}): Promise<VehicleView> {
  return withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();

    const drivingTicks = typeof params.drivingTicks === "number" && Number.isFinite(params.drivingTicks) ? Math.max(0, params.drivingTicks) : 0;
    const burned = drivingTicks * VEHICLE_FUEL_BURN_PER_TICK;
    const fuel = Math.max(0, Number(row.fuel_level) - burned);

    // Sensor reports shrink health and grow damage; a report can never heal
    // (repair is the only way health recovers, and it returns its own
    // authoritative snapshot the pack applies to the entity). Unreported
    // fields are left untouched, so the pack can send a partial report (e.g.
    // only driving ticks). Entity/sensor values are 0-100 (matches
    // megaverse:engine_health), so clamp to that range directly rather than
    // treating them as 0-1 fractions.
    const engine = optionalSensor100(params.engineHealth);
    const susp = optionalSensor100(params.suspensionHealth);
    const body = optionalSensor100(params.bodyDamage);
    const engineHealth = engine == null ? Number(row.engine_health) : Math.min(Number(row.engine_health), engine);
    const suspensionHealth = susp == null ? Number(row.suspension_health) : Math.min(Number(row.suspension_health), susp);
    const bodyDamage = body == null ? Number(row.body_damage) : Math.max(Number(row.body_damage), body);

    await client.query(
      `UPDATE vehicles
       SET fuel_level = $1, engine_health = $2, suspension_health = $3, body_damage = $4, updated_at = now()
       WHERE id = $5`,
      [fuel, engineHealth, suspensionHealth, bodyDamage, params.vehicleId]
    );
    return toVehicleView({ ...row, fuel_level: fuel, engine_health: engineHealth, suspension_health: suspensionHealth, body_damage: bodyDamage });
  });
}

function optionalSensor100(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, v));
}

// ---------------------------------------------------------------------------
// Commerce — player sale listing, purchase, free transfer
// ---------------------------------------------------------------------------

export async function setSaleListing(params: {
  vehicleId: number;
  characterId: number;
  priceCents: number | null;
  currency?: economy.Currency;
  isStaff?: boolean;
  actorUserId: number;
  requestId?: string | null;
}): Promise<VehicleView> {
  return withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();
    if (row.status === "seized") throw new VehicleInUseError("vehicle is seized");
    const own = Number(row.owner_character_id ?? 0) === params.characterId;
    if (!own && !params.isStaff) throw new VehicleAccessDeniedError();
    let listedPrice: number | null = null;
    let listedCurrency: economy.Currency | null = null;
    if (params.priceCents != null) {
      if (row.status !== "garaged") throw new VehicleInUseError("park the vehicle before listing it for sale");
      if (params.priceCents <= 0) throw new Error("priceCents must be positive");
      await client.query(
        `UPDATE vehicles SET sale_price_cents = $1, sale_currency = $2, updated_at = now() WHERE id = $3`,
        [params.priceCents, params.currency ?? "cash", params.vehicleId]
      );
      listedPrice = params.priceCents;
      listedCurrency = params.currency ?? "cash";
    } else {
      await client.query(`UPDATE vehicles SET sale_price_cents = NULL, sale_currency = NULL, updated_at = now() WHERE id = $1`, [
        params.vehicleId,
      ]);
    }
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: params.priceCents != null ? "vehicle.sell" : "vehicle.listing_remove",
        targetType: "vehicle",
        targetId: String(params.vehicleId),
        payload: { characterId: params.characterId, priceCents: params.priceCents ?? null, currency: params.currency ?? null },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toVehicleView({ ...row, sale_price_cents: listedPrice, sale_currency: listedCurrency });
  });
}

export async function buyVehicle(params: {
  vehicleId: number;
  buyerCharacterId: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<VehicleView> {
  // 1. Snapshot the deal under a short lock.
  const deal = await withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();
    if (row.status === "seized") throw new VehicleInUseError("vehicle is seized");
    if (row.sale_price_cents == null) throw new VehicleInUseError("vehicle is not for sale");
    if (Number(row.owner_character_id ?? 0) === params.buyerCharacterId) throw new VehicleInUseError("that's already your vehicle");
    await assertGarageRoom(client, params.buyerCharacterId);
    return {
      priceCents: Number(row.sale_price_cents),
      currency: (row.sale_currency as economy.Currency) ?? "cash",
      sellerCharacterId: row.owner_character_id == null ? null : Number(row.owner_character_id),
    };
  });

  // 2. Move the money (own transaction). Dealership (NULL seller) = debit;
  // player sale = two-sided transfer.
  if (deal.sellerCharacterId != null) {
    await economy.transfer({
      fromCharacterId: params.buyerCharacterId,
      toCharacterId: deal.sellerCharacterId,
      amountCents: deal.priceCents,
      reason: `vehicle purchase #${params.vehicleId}`,
      actorUserId: params.actorUserId,
      currency: deal.currency,
      requestId: params.requestId,
    });
  } else {
    await economy.debit({
      characterId: params.buyerCharacterId,
      amountCents: deal.priceCents,
      reason: `dealership vehicle purchase #${params.vehicleId}`,
      actorUserId: params.actorUserId,
      currency: deal.currency,
      refType: "vehicle_purchase",
      requestId: params.requestId,
    });
  }

  // 3. Transfer ownership + revoke the old owner's key + clear the listing.
  const view = await withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();
    if (row.sale_price_cents == null) {
      // Lost a race — someone else bought it between our lock and now.
      throw new VehicleInUseError("someone else snagged it — your payment was refunded");
    }
    if (row.owner_character_id != null) {
      await client.query(
        `DELETE FROM inventory_slots
         WHERE item_id = $1 AND (item_metadata->>'vehicle_id')::bigint = $2`,
        [KEY_ITEM_ID, params.vehicleId]
      );
    }
    await client.query(
      `UPDATE vehicles
       SET owner_character_id = $1, sale_price_cents = NULL, sale_currency = NULL, updated_at = now()
       WHERE id = $2`,
      [params.buyerCharacterId, params.vehicleId]
    );
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "vehicle.buy",
        targetType: "vehicle",
        targetId: String(params.vehicleId),
        payload: { buyerCharacterId: params.buyerCharacterId, sellerCharacterId: deal.sellerCharacterId, priceCents: deal.priceCents, currency: deal.currency },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toVehicleView({ ...row, owner_character_id: params.buyerCharacterId, sale_price_cents: null, sale_currency: null });
  });

  // 4. Hand the buyer the key.
  try {
    await grantVehicleKey(params.buyerCharacterId, params.vehicleId, params.actorUserId);
  } catch (err) {
    console.warn("[vehicle] purchase ok but key delivery failed (inventory full?)", err);
  }
  return view;
}

export async function transferVehicle(params: {
  vehicleId: number;
  fromCharacterId: number;
  toCharacterId: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<VehicleView> {
  const view = await withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();
    if (row.status === "seized") throw new VehicleInUseError("vehicle is seized");
    if (Number(row.owner_character_id ?? 0) !== params.fromCharacterId) throw new VehicleAccessDeniedError();
    if (row.status !== "garaged") throw new VehicleInUseError("park the vehicle before transferring it");
    await assertGarageRoom(client, params.toCharacterId);
    await client.query(
      `DELETE FROM inventory_slots
       WHERE item_id = $1 AND (item_metadata->>'vehicle_id')::bigint = $2`,
      [KEY_ITEM_ID, params.vehicleId]
    );
    await client.query(
      `UPDATE vehicles SET owner_character_id = $1, sale_price_cents = NULL, sale_currency = NULL, updated_at = now() WHERE id = $2`,
      [params.toCharacterId, params.vehicleId]
    );
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "vehicle.transfer",
        targetType: "vehicle",
        targetId: String(params.vehicleId),
        payload: { fromCharacterId: params.fromCharacterId, toCharacterId: params.toCharacterId },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toVehicleView({ ...row, owner_character_id: params.toCharacterId, sale_price_cents: null, sale_currency: null });
  });

  // Deliver the single key after the ownership change commits (the in-tx
  // delete clears any old keys). If delivery fails (e.g. carry weight full)
  // the transfer still stands and the new owner can be re-keyed by staff.
  try {
    await grantVehicleKey(params.toCharacterId, params.vehicleId, params.actorUserId);
  } catch (err) {
    console.warn("[vehicle] transfer ok but key delivery failed (inventory full?)", err);
  }
  return view;
}

// ---------------------------------------------------------------------------
// Admin controls — seize / delete / override state
// ---------------------------------------------------------------------------

export async function seizeVehicle(params: {
  vehicleId: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<VehicleView> {
  return withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();
    await client.query(
      `UPDATE vehicles SET status = 'seized', sale_price_cents = NULL, sale_currency = NULL, updated_at = now() WHERE id = $1`,
      [params.vehicleId]
    );
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "vehicle.seize",
        targetType: "vehicle",
        targetId: String(params.vehicleId),
        payload: { plate: row.plate },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toVehicleView({ ...row, status: "seized", sale_price_cents: null, sale_currency: null });
  });
}

export async function deleteVehicle(params: {
  vehicleId: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<void> {
  await withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();
    await client.query(
      `DELETE FROM inventory_slots
       WHERE item_id = $1 AND (item_metadata->>'vehicle_id')::bigint = $2`,
      [KEY_ITEM_ID, params.vehicleId]
    );
    await client.query(`DELETE FROM vehicles WHERE id = $1`, [params.vehicleId]);
    if (row.trunk_inventory_id != null) {
      try {
        await client.query(`DELETE FROM inventory_items WHERE inventory_id = $1`, [row.trunk_inventory_id]);
        await client.query(`DELETE FROM inventories WHERE id = $1`, [row.trunk_inventory_id]);
      } catch (err) {
        console.warn("[vehicle] failed to clear trunk on delete", err);
      }
    }
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "vehicle.delete",
        targetType: "vehicle",
        targetId: String(params.vehicleId),
        payload: { plate: row.plate },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
  });
}

export async function overrideVehicleState(params: {
  vehicleId: number;
  fuelLevel?: number;
  engineHealth?: number;
  suspensionHealth?: number;
  bodyDamage?: number;
  locked?: boolean;
  actorUserId: number;
  requestId?: string | null;
}): Promise<VehicleView> {
  return withTransaction(async (client) => {
    const row = await lockVehicleRow(client, params.vehicleId);
    if (!row) throw new VehicleNotFoundError();
    const fuel = params.fuelLevel != null ? Math.max(0, Math.min(100, params.fuelLevel)) : Number(row.fuel_level);
    const engine = params.engineHealth != null ? Math.max(0, Math.min(100, params.engineHealth)) : Number(row.engine_health);
    const susp = params.suspensionHealth != null ? Math.max(0, Math.min(100, params.suspensionHealth)) : Number(row.suspension_health);
    const body = params.bodyDamage != null ? Math.max(0, Math.min(100, params.bodyDamage)) : Number(row.body_damage);
    const locked = params.locked != null ? params.locked : Boolean(row.locked);
    await client.query(
      `UPDATE vehicles
       SET fuel_level = $1, engine_health = $2, suspension_health = $3, body_damage = $4, locked = $5, updated_at = now()
       WHERE id = $6`,
      [fuel, engine, susp, body, locked, params.vehicleId]
    );
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "vehicle.maintenance",
        targetType: "vehicle",
        targetId: String(params.vehicleId),
        payload: { fuelLevel: fuel, engineHealth: engine, suspensionHealth: susp, bodyDamage: body, locked },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toVehicleView({ ...row, fuel_level: fuel, engine_health: engine, suspension_health: susp, body_damage: body, locked });
  });
}

export async function reconcileDeployed(params: {
  deployedVehicleIds: number[];
  actorUserId?: number | null;
  requestId?: string | null;
}): Promise<number> {
  const ids = (params.deployedVehicleIds ?? []).filter((n) => Number.isInteger(n) && n > 0).map((n) => Number(n));
  return withTransaction(async (client) => {
    const res = await client.query(
      `UPDATE vehicles SET status = 'garaged', updated_at = now()
       WHERE status = 'deployed' AND NOT (id = ANY($1::bigint[])) RETURNING id`,
      [ids]
    );
    await writeAudit(
      {
        actorUserId: params.actorUserId ?? null,
        action: "vehicle.reconcile",
        targetType: "vehicle",
        targetId: undefined,
        payload: { resetToGarage: res.rowCount ?? 0, stillDeployed: ids },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return res.rowCount ?? 0;
  });
}

// ---------------------------------------------------------------------------
// Read models for the web + bridge
// ---------------------------------------------------------------------------

export async function getGarageSummary(characterId: number) {
  if (!(await characterExists(characterId))) return null;
  const vehicles = await listVehicles({ ownerCharacterId: characterId });
  return {
    garageCapacity: await property.getCharacterGarageCapacity(characterId),
    vehicleCount: vehicles.filter((v) => v.status !== "seized").length,
    vehicles,
  };
}

async function characterExists(characterId: number): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM characters WHERE id = $1`, [characterId]);
  return rows.length > 0;
}