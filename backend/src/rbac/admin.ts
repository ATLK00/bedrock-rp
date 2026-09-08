import { pool } from "../db/pool.js";
import { writeAudit } from "../audit/index.js";

export class RoleNotFoundError extends Error {
  constructor(roleName: string) {
    super(`role not found: ${roleName}`);
  }
}
export class InsufficientRankError extends Error {
  constructor(roleName: string) {
    super(`you cannot grant or revoke the '${roleName}' role — it is not ranked below your own`);
  }
}

/**
 * Rank hierarchy for role management (NOT the same as feature
 * permissions like economy.grant — this only governs who can hand out
 * which roles) now lives in roles.rank (see migration
 * 014_role_rank.sql) instead of a hardcoded object, so ranks can be
 * adjusted via the roles table without a code deploy.
 *
 * Owner is still not stored as a finite rank; it's handled as an
 * always-highest special case below, consistent with its RBAC-bypass
 * behavior elsewhere (see rbac/index.ts's hasPermission()).
 *
 * A user can only grant/revoke roles ranked STRICTLY BELOW their own
 * highest rank — an admin (rank 50) can hand out moderator (rank 10)
 * but not admin or owner. This prevents a compromised or malicious
 * admin account from self-escalating or minting peer admins.
 */
const OWNER_RANK = Infinity;

async function getActorRank(actorUserId: number): Promise<number> {
  const { rows } = await pool.query<{ name: string; rank: number }>(
    `SELECT r.name, r.rank FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [actorUserId]
  );
  if (rows.some((r) => r.name === "owner")) return OWNER_RANK;
  return Math.max(0, ...rows.map((r) => r.rank));
}

function assertCanManageRole(actorRank: number, roleName: string, targetRank: number) {
  if (roleName === "owner") throw new InsufficientRankError(roleName); // owner is never grantable/revocable via this path, by anyone
  if (targetRank >= actorRank) throw new InsufficientRankError(roleName);
}

export async function grantRole(params: { userId: number; roleName: string; actorUserId: number }) {
  const { userId, roleName, actorUserId } = params;
  const { rows: roleRows } = await pool.query<{ id: number; rank: number }>(
    `SELECT id, rank FROM roles WHERE name = $1`,
    [roleName]
  );
  if (roleRows.length === 0) throw new RoleNotFoundError(roleName);

  const actorRank = await getActorRank(actorUserId);
  assertCanManageRole(actorRank, roleName, roleRows[0].rank);

  await pool.query(
    `INSERT INTO user_roles (user_id, role_id, granted_by) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [userId, roleRows[0].id, actorUserId]
  );
  await writeAudit({
    actorUserId,
    action: "rbac.grant_role",
    targetType: "user",
    targetId: String(userId),
    payload: { roleName },
    result: "success",
  });
}

export async function revokeRole(params: { userId: number; roleName: string; actorUserId: number }) {
  const { userId, roleName, actorUserId } = params;
  const { rows: roleRows } = await pool.query<{ id: number; rank: number }>(
    `SELECT id, rank FROM roles WHERE name = $1`,
    [roleName]
  );
  if (roleRows.length === 0) throw new RoleNotFoundError(roleName);

  const actorRank = await getActorRank(actorUserId);
  assertCanManageRole(actorRank, roleName, roleRows[0].rank);

  await pool.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`, [userId, roleRows[0].id]);
  await writeAudit({
    actorUserId,
    action: "rbac.revoke_role",
    targetType: "user",
    targetId: String(userId),
    payload: { roleName },
    result: "success",
  });
}

export async function listRoles(userId: number): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [userId]
  );
  return rows.map((r) => r.name);
}

export interface RoleWithPermissions {
  name: string;
  rank: number;
  permissions: string[];
}

/** Every role with its rank and effective permission keys — read-only admin view. */
export async function listRolesWithPermissions(): Promise<RoleWithPermissions[]> {
  const { rows } = await pool.query<{ name: string; rank: number; permissions: string[] }>(
    `SELECT r.name, r.rank,
            COALESCE(array_agg(p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS permissions
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     GROUP BY r.id, r.name, r.rank
     ORDER BY r.rank DESC, r.name`
  );
  return rows.map((r) => ({
    name: r.name,
    rank: r.rank,
    permissions: r.permissions,
  }));
}
