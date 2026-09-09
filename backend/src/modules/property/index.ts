import { pool, withTransaction } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";
import * as inventory from "../inventory/index.js";
import * as economy from "../economy/index.js";

/**
 * Property system — the server-authoritative real-estate domain.
 *
 * A property is NOT a database row with a name on it; it carries the three
 * sub-systems the user's architecture diagram calls out:
 *
 *   Character
 *      |
 *   Property ──┬── Storage  (a storage_type='house' container, reuses the
 *              │             existing weight-capped container machinery, so
 *              │             it already shows up in `!inv`)
 *              ├── Access   (ownership on the character + a physical deed
 *              │             item rp:property_key, metadata {property_id};
 *              │             keyholders can unlock/open storage)
 *              └── Garage   (garage_capacity ADDS to the owner's vehicle
 *                            garage cap — a house genuinely expands what a
 *                            character can own, tying Vehicle into Housing)
 *
 * Trust model is identical to the vehicle module: the pack never decides
 * money/ownership; every transition is audited. Dealships (deed-less lots)
 * are unowned properties with a sale listing; players may list their own
 * property for sale and buy/unlist at any time.
 */

export const KEY_ITEM_ID = "rp:property_key";
export const PROPERTY_STORAGE_CAPACITY_WEIGHT_G = 100000; // ~100 kg of belongings

export class PropertyNotFoundError extends Error {}
export class PropertyAccessDeniedError extends Error {}
export class PropertyInUseError extends Error {}

export interface PropertyView {
  id: number;
  propertyType: string;
  address: string;
  ownerCharacterId: number | null;
  status: string;
  locked: boolean;
  garageCapacity: number;
  storageInventoryId: number | null;
  salePriceCents: number | null;
  saleCurrency: string | null;
  createdAt: string;
}

function toPropertyView(row: any): PropertyView {
  return {
    id: Number(row.id),
    propertyType: row.property_type,
    address: String(row.address ?? ""),
    ownerCharacterId: row.owner_character_id == null ? null : Number(row.owner_character_id),
    status: row.status,
    locked: row.locked,
    garageCapacity: Number(row.garage_capacity),
    storageInventoryId: row.storage_inventory_id == null ? null : Number(row.storage_inventory_id),
    salePriceCents: row.sale_price_cents == null ? null : Number(row.sale_price_cents),
    saleCurrency: row.sale_currency ?? null,
    createdAt: String(row.created_at ?? ""),
  };
}

async function lockPropertyRow(client: any, propertyId: number) {
  const { rows } = await client.query(`SELECT * FROM properties WHERE id = $1 FOR UPDATE`, [propertyId]);
  return rows[0] ?? null;
}

/** Storage container for a property — created in the same tx as the row. */
async function createStorage(client: any, ownerCharacterId: number | null, address: string): Promise<number> {
  const { rows } = await client.query(
    `INSERT INTO inventories (storage_type, owner_character_id, label, capacity_weight_g)
     VALUES ('house', $1, $2, $3) RETURNING id`,
    [ownerCharacterId, `Storage ${address}`, PROPERTY_STORAGE_CAPACITY_WEIGHT_G]
  );
  return Number(rows[0].id);
}

export async function getProperty(propertyId: number): Promise<PropertyView | null> {
  const { rows } = await pool.query(`SELECT * FROM properties WHERE id = $1`, [propertyId]);
  return rows[0] ? toPropertyView(rows[0]) : null;
}

export async function listProperties(params: {
  ownerCharacterId?: number | null;
  status?: string | null;
  forSale?: boolean;
  limit?: number;
  offset?: number;
} = {}): Promise<Array<PropertyView & { ownerName: string | null }>> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
  const offset = Math.max(0, params.offset ?? 0);
  const where: string[] = [];
  const values: unknown[] = [];
  if (params.ownerCharacterId != null) {
    values.push(params.ownerCharacterId);
    where.push(`p.owner_character_id = $${values.length}`);
  }
  if (params.status) {
    values.push(params.status);
    where.push(`p.status = $${values.length}`);
  }
  if (params.forSale) {
    where.push(`p.sale_price_cents IS NOT NULL`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  values.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS owner_name
     FROM properties p
     LEFT JOIN characters c ON c.id = p.owner_character_id
     ${whereSql}
     ORDER BY p.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return rows.map((r: any) => ({ ...toPropertyView(r), ownerName: r.owner_name ?? null }));
}

export async function hasPropertyKey(characterId: number, propertyId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM inventory_slots
     WHERE character_id = $1 AND item_id = $2 AND (item_metadata->>'property_id')::bigint = $3
     LIMIT 1`,
    [characterId, KEY_ITEM_ID, propertyId]
  );
  return rows.length > 0;
}

/** Issue the physical deed into a character's carry slots (their own tx). */
export async function grantPropertyKey(characterId: number, propertyId: number, actorUserId: number): Promise<void> {
  await inventory.giveItem({
    characterId,
    itemId: KEY_ITEM_ID,
    quantity: 1,
    actorUserId,
    meta: { property_id: propertyId },
  });
}

/** Total vehicle garage capacity = character base + summed property garages. */
export async function getCharacterGarageCapacity(characterId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT c.garage_capacity +
              COALESCE((SELECT SUM(p.garage_capacity) FROM properties p WHERE p.owner_character_id = c.id AND p.status = 'owned'), 0)
            AS total
     FROM characters c WHERE c.id = $1`,
    [characterId]
  );
  if (rows.length === 0) return 0;
  return Number(rows[0].total);
}

/** By storage container id — used by the inventory bridge to grant keyholder access. */
export async function findPropertyByStorageInventory(inventoryId: number): Promise<number | null> {
  const { rows } = await pool.query(`SELECT id FROM properties WHERE storage_inventory_id = $1 LIMIT 1`, [inventoryId]);
  return rows[0] ? Number(rows[0].id) : null;
}

/** True if the character owns the property OR holds its deed key. */
export async function canAccessProperty(characterId: number, propertyId: number): Promise<boolean> {
  const property = await getProperty(propertyId);
  if (!property) return false;
  if (property.ownerCharacterId === characterId) return true;
  return hasPropertyKey(characterId, propertyId);
}

/** Can the character touch a given storage container? owner, or keyholder of the linked property. */
export async function canAccessContainer(characterId: number, inventoryId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT owner_character_id FROM inventories WHERE id = $1`,
    [inventoryId]
  );
  if (rows.length === 0) return false;
  if (rows[0].owner_character_id != null && Number(rows[0].owner_character_id) === characterId) return true;
  const propertyId = await findPropertyByStorageInventory(inventoryId);
  if (propertyId == null) return false;
  return hasPropertyKey(characterId, propertyId);
}

/** Full-access list of storage containers for the character (owned + key-held). */
export async function listAccessibleContainerInventoryIds(characterId: number): Promise<number[]> {
  const { rows } = await pool.query(
    `SELECT id FROM inventories WHERE owner_character_id = $1
     UNION
     SELECT p.storage_inventory_id
     FROM inventory_slots s
     JOIN properties p ON p.id = (s.item_metadata->>'property_id')::bigint
     WHERE s.character_id = $1 AND s.item_id = $2 AND p.storage_inventory_id IS NOT NULL`,
    [characterId, KEY_ITEM_ID]
  );
  return rows.map((r: any) => Number(r.id));
}

// ---------------------------------------------------------------------------
// Creation / admin ownership
// ---------------------------------------------------------------------------

export async function createProperty(params: {
  propertyType?: string;
  address: string;
  ownerCharacterId?: number | null;
  garageCapacity?: number;
  locked?: boolean;
  salePriceCents?: number | null;
  saleCurrency?: string | null;
  actorUserId: number;
  requestId?: string | null;
}): Promise<PropertyView> {
  const propertyType = (params.propertyType ?? "house").trim().slice(0, 32) || "house";
  const address = String(params.address ?? "").trim().slice(0, 128);
  if (!address) throw new Error("address is required");
  const garageCapacity = Number.isInteger(params.garageCapacity) && params.garageCapacity! >= 0 ? params.garageCapacity! : 2;
  const saleCurrency = params.saleCurrency ?? "cash";
  if (params.salePriceCents != null && params.salePriceCents <= 0) {
    throw new Error("salePriceCents must be positive when set");
  }

  const view = await withTransaction(async (client) => {
    const storageId = await createStorage(client, params.ownerCharacterId ?? null, address);
    const { rows } = await client.query(
      `INSERT INTO properties (property_type, address, owner_character_id, locked, garage_capacity, storage_inventory_id, sale_price_cents, sale_currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        propertyType,
        address,
        params.ownerCharacterId ?? null,
        params.locked ?? true,
        garageCapacity,
        storageId,
        params.salePriceCents ?? null,
        params.salePriceCents != null ? saleCurrency : null,
      ]
    );
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "property.create",
        targetType: "property",
        targetId: String(rows[0].id),
        payload: { propertyType, address, ownerCharacterId: params.ownerCharacterId ?? null, garageCapacity, isForSale: params.salePriceCents != null, salePriceCents: params.salePriceCents ?? null },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toPropertyView(rows[0]);
  });

  if (params.ownerCharacterId != null) {
    try {
      await grantPropertyKey(params.ownerCharacterId, view.id, params.actorUserId);
    } catch (err) {
      console.warn("[property] create ok but deed key delivery failed (inventory full?)", err);
    }
  }
  return view;
}

/** Admin-only: assign a property to a character (old keys revoked, listing cleared). */
export async function grantProperty(params: {
  propertyId: number;
  ownerCharacterId: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<PropertyView> {
  const view = await withTransaction(async (client) => {
    const row = await lockPropertyRow(client, params.propertyId);
    if (!row) throw new PropertyNotFoundError();
    if (row.status === "seized") throw new PropertyInUseError("property is seized");
    await client.query(
      `DELETE FROM inventory_slots
       WHERE item_id = $1 AND (item_metadata->>'property_id')::bigint = $2
         AND character_id <> $3`,
      [KEY_ITEM_ID, params.propertyId, params.ownerCharacterId]
    );
    await client.query(
      `UPDATE properties
        SET owner_character_id = $1, status = 'owned', sale_price_cents = NULL, sale_currency = NULL, updated_at = now()
        WHERE id = $2`,
      [params.ownerCharacterId, params.propertyId]
    );
    await client.query(`UPDATE inventories SET owner_character_id = $1 WHERE id = $2`, [params.ownerCharacterId, row.storage_inventory_id]);
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "property.grant",
        targetType: "property",
        targetId: String(params.propertyId),
        payload: { ownerCharacterId: params.ownerCharacterId },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toPropertyView({ ...row, owner_character_id: params.ownerCharacterId, status: "owned", sale_price_cents: null, sale_currency: null });
  });
  try {
    await grantPropertyKey(params.ownerCharacterId, params.propertyId, params.actorUserId);
  } catch (err) {
    console.warn("[property] grant ok but deed key delivery failed", err);
  }
  return view;
}

// ---------------------------------------------------------------------------
// Access / state
// ---------------------------------------------------------------------------

export async function setPropertyLocked(params: {
  propertyId: number;
  characterId: number;
  locked: boolean;
  isStaff?: boolean;
  actorUserId: number;
  requestId?: string | null;
}): Promise<PropertyView> {
  return withTransaction(async (client) => {
    const row = await lockPropertyRow(client, params.propertyId);
    if (!row) throw new PropertyNotFoundError();
    if (row.status === "seized") throw new PropertyInUseError("property is seized");
    const own = Number(row.owner_character_id ?? 0) === params.characterId;
    const hasKey = await hasPropertyKey(params.characterId, params.propertyId);
    if (!own && !hasKey && !params.isStaff) throw new PropertyAccessDeniedError();
    await client.query(`UPDATE properties SET locked = $1, updated_at = now() WHERE id = $2`, [params.locked, params.propertyId]);
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: params.locked ? "property.lock" : "property.unlock",
        targetType: "property",
        targetId: String(params.propertyId),
        payload: { characterId: params.characterId, hasKey: !own && hasKey },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toPropertyView({ ...row, locked: params.locked });
  });
}

// ---------------------------------------------------------------------------
// Commerce — sale listing, purchase, free transfer
// ---------------------------------------------------------------------------

export async function setSaleListing(params: {
  propertyId: number;
  characterId: number;
  priceCents: number | null;
  currency?: economy.Currency;
  isStaff?: boolean;
  actorUserId: number;
  requestId?: string | null;
}): Promise<PropertyView> {
  return withTransaction(async (client) => {
    const row = await lockPropertyRow(client, params.propertyId);
    if (!row) throw new PropertyNotFoundError();
    if (row.status === "seized") throw new PropertyInUseError("property is seized");
    const own = Number(row.owner_character_id ?? 0) === params.characterId;
    if (!own && !params.isStaff) throw new PropertyAccessDeniedError();
    let listedPrice: number | null = null;
    let listedCurrency: economy.Currency | null = null;
    if (params.priceCents != null) {
      if (params.priceCents <= 0) throw new Error("priceCents must be positive");
      await client.query(
        `UPDATE properties SET sale_price_cents = $1, sale_currency = $2, updated_at = now() WHERE id = $3`,
        [params.priceCents, params.currency ?? "cash", params.propertyId]
      );
      listedPrice = params.priceCents;
      listedCurrency = params.currency ?? "cash";
    } else {
      await client.query(`UPDATE properties SET sale_price_cents = NULL, sale_currency = NULL, updated_at = now() WHERE id = $1`, [
        params.propertyId,
      ]);
    }
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: params.priceCents != null ? "property.sell" : "property.listing_remove",
        targetType: "property",
        targetId: String(params.propertyId),
        payload: { characterId: params.characterId, priceCents: params.priceCents ?? null, currency: params.currency ?? null },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toPropertyView({ ...row, sale_price_cents: listedPrice, sale_currency: listedCurrency });
  });
}

export async function buyProperty(params: {
  propertyId: number;
  buyerCharacterId: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<PropertyView> {
  // 1. Snapshot the deal under a short lock.
  const deal = await withTransaction(async (client) => {
    const row = await lockPropertyRow(client, params.propertyId);
    if (!row) throw new PropertyNotFoundError();
    if (row.status === "seized") throw new PropertyInUseError("property is seized");
    if (row.sale_price_cents == null) throw new PropertyInUseError("property is not for sale");
    if (Number(row.owner_character_id ?? 0) === params.buyerCharacterId) throw new PropertyInUseError("you already own that property");
    return {
      priceCents: Number(row.sale_price_cents),
      currency: (row.sale_currency as economy.Currency) ?? "cash",
      sellerCharacterId: row.owner_character_id == null ? null : Number(row.owner_character_id),
    };
  });

  // 2. Move the money. Government/empty lot = debit; player sale = transfer.
  if (deal.sellerCharacterId != null) {
    await economy.transfer({
      fromCharacterId: params.buyerCharacterId,
      toCharacterId: deal.sellerCharacterId,
      amountCents: deal.priceCents,
      reason: `property purchase #${params.propertyId}`,
      actorUserId: params.actorUserId,
      currency: deal.currency,
      requestId: params.requestId,
    });
  } else {
    await economy.debit({
      characterId: params.buyerCharacterId,
      amountCents: deal.priceCents,
      reason: `government property purchase #${params.propertyId}`,
      actorUserId: params.actorUserId,
      currency: deal.currency,
      refType: "property_purchase",
      requestId: params.requestId,
    });
  }

  // 3. Ownership + revoke old deeds + clear the listing + move storage owner.
  const view = await withTransaction(async (client) => {
    const row = await lockPropertyRow(client, params.propertyId);
    if (!row) throw new PropertyNotFoundError();
    if (row.sale_price_cents == null) {
      // Lost a race — someone else bought it between our lock and now.
      throw new PropertyInUseError("someone else snagged it — your payment was refunded");
    }
    if (row.owner_character_id != null) {
      await client.query(
        `DELETE FROM inventory_slots
         WHERE item_id = $1 AND (item_metadata->>'property_id')::bigint = $2`,
        [KEY_ITEM_ID, params.propertyId]
      );
    }
    await client.query(
      `UPDATE properties
        SET owner_character_id = $1, status = 'owned', sale_price_cents = NULL, sale_currency = NULL, updated_at = now()
        WHERE id = $2`,
      [params.buyerCharacterId, params.propertyId]
    );
    await client.query(`UPDATE inventories SET owner_character_id = $1 WHERE id = $2`, [params.buyerCharacterId, row.storage_inventory_id]);
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "property.buy",
        targetType: "property",
        targetId: String(params.propertyId),
        payload: { buyerCharacterId: params.buyerCharacterId, sellerCharacterId: deal.sellerCharacterId, priceCents: deal.priceCents, currency: deal.currency },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toPropertyView({ ...row, owner_character_id: params.buyerCharacterId, status: "owned", sale_price_cents: null, sale_currency: null });
  });

  try {
    await grantPropertyKey(params.buyerCharacterId, params.propertyId, params.actorUserId);
  } catch (err) {
    console.warn("[property] purchase ok but deed key delivery failed (inventory full?)", err);
  }
  return view;
}

export async function transferProperty(params: {
  propertyId: number;
  fromCharacterId: number;
  toCharacterId: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<PropertyView> {
  const view = await withTransaction(async (client) => {
    const row = await lockPropertyRow(client, params.propertyId);
    if (!row) throw new PropertyNotFoundError();
    if (row.status === "seized") throw new PropertyInUseError("property is seized");
    if (Number(row.owner_character_id ?? 0) !== params.fromCharacterId) throw new PropertyAccessDeniedError();
    if (row.sale_price_cents != null) throw new PropertyInUseError("unlist the property before transferring it");
    await client.query(
      `DELETE FROM inventory_slots
       WHERE item_id = $1 AND (item_metadata->>'property_id')::bigint = $2`,
      [KEY_ITEM_ID, params.propertyId]
    );
    await client.query(
      `UPDATE properties SET owner_character_id = $1, updated_at = now() WHERE id = $2`,
      [params.toCharacterId, params.propertyId]
    );
    await client.query(`UPDATE inventories SET owner_character_id = $1 WHERE id = $2`, [params.toCharacterId, row.storage_inventory_id]);
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "property.transfer",
        targetType: "property",
        targetId: String(params.propertyId),
        payload: { fromCharacterId: params.fromCharacterId, toCharacterId: params.toCharacterId },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toPropertyView({ ...row, owner_character_id: params.toCharacterId, sale_price_cents: null, sale_currency: null });
  });

  try {
    await grantPropertyKey(params.toCharacterId, params.propertyId, params.actorUserId);
  } catch (err) {
    console.warn("[property] transfer ok but deed key delivery failed (inventory full?)", err);
  }
  return view;
}

// ---------------------------------------------------------------------------
// Admin controls — seize / delete
// ---------------------------------------------------------------------------

export async function seizeProperty(params: {
  propertyId: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<PropertyView> {
  return withTransaction(async (client) => {
    const row = await lockPropertyRow(client, params.propertyId);
    if (!row) throw new PropertyNotFoundError();
    await client.query(
      `DELETE FROM inventory_slots
       WHERE item_id = $1 AND (item_metadata->>'property_id')::bigint = $2`,
      [KEY_ITEM_ID, params.propertyId]
    );
    await client.query(
      `UPDATE properties SET status = 'seized', owner_character_id = NULL, sale_price_cents = NULL, sale_currency = NULL, updated_at = now() WHERE id = $1`,
      [params.propertyId]
    );
    await client.query(`UPDATE inventories SET owner_character_id = NULL WHERE id = $1`, [row.storage_inventory_id]);
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "property.seize",
        targetType: "property",
        targetId: String(params.propertyId),
        payload: { address: row.address },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
    return toPropertyView({ ...row, status: "seized", owner_character_id: null, sale_price_cents: null, sale_currency: null });
  });
}

export async function deleteProperty(params: {
  propertyId: number;
  actorUserId: number;
  requestId?: string | null;
}): Promise<void> {
  await withTransaction(async (client) => {
    const row = await lockPropertyRow(client, params.propertyId);
    if (!row) throw new PropertyNotFoundError();
    await client.query(
      `DELETE FROM inventory_slots
       WHERE item_id = $1 AND (item_metadata->>'property_id')::bigint = $2`,
      [KEY_ITEM_ID, params.propertyId]
    );
    await client.query(`DELETE FROM properties WHERE id = $1`, [params.propertyId]);
    if (row.storage_inventory_id != null) {
      try {
        await client.query(`DELETE FROM inventory_items WHERE inventory_id = $1`, [row.storage_inventory_id]);
        await client.query(`DELETE FROM inventories WHERE id = $1`, [row.storage_inventory_id]);
      } catch (err) {
        console.warn("[property] failed to clear storage on delete", err);
      }
    }
    await writeAudit(
      {
        actorUserId: params.actorUserId,
        action: "property.delete",
        targetType: "property",
        targetId: String(params.propertyId),
        payload: { address: row.address },
        result: "success",
        requestId: params.requestId,
      },
      client
    );
  });
}

// ---------------------------------------------------------------------------
// Read models for the web + bridge
// ---------------------------------------------------------------------------

/** The character's property portfolio + their total garage capacity. */
export async function getPropertySummary(characterId: number) {
  const accessible = await listAccessibleContainerInventoryIds(characterId);
  const owned = await listProperties({ ownerCharacterId: characterId });
  const keys = await listDeedHeld(characterId, owned.map((p) => p.id));
  return {
    garageCapacity: await getCharacterGarageCapacity(characterId),
    propertyCount: owned.filter((p) => p.status !== "seized").length,
    storageCount: accessible.length,
    properties: owned,
    keys,
  };
}

/** Properties the character holds a deed key for but does NOT own. */
async function listDeedHeld(characterId: number, ownedIds: number[]): Promise<PropertyView[]> {
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS owner_name
     FROM inventory_slots s
     JOIN properties p ON p.id = (s.item_metadata->>'property_id')::bigint
     LEFT JOIN characters c ON c.id = p.owner_character_id
     WHERE s.character_id = $1 AND s.item_id = $2`,
    [characterId, KEY_ITEM_ID]
  );
  const owned = new Set(ownedIds.map((n) => Number(n)));
  return rows
    .filter((r: any) => !owned.has(Number(r.id)))
    .map((r: any) => ({ ...toPropertyView(r), ownerName: r.owner_name ?? null }));
}