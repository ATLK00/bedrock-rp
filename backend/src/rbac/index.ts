import { pool } from "../db/pool.js";

const OWNER_BYPASS_ROLE = "owner";

/**
 * True if `userId` holds a role granting `permissionKey`, or holds the
 * 'owner' role (which bypasses granular checks per migration 002 comment).
 * Every admin-facing route must call this before mutating state.
 */
export async function hasPermission(
  userId: number,
  permissionKey: string
): Promise<boolean> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT r.name FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1`,
    [userId]
  );
  if (rows.some((r) => r.name === OWNER_BYPASS_ROLE)) return true;

  const { rows: permRows } = await pool.query(
    `SELECT 1 FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1 AND p.key = $2
     LIMIT 1`,
    [userId, permissionKey]
  );
  return permRows.length > 0;
}

/** Express middleware factory. Requires req.userId to already be set by auth middleware. */
export function requirePermission(permissionKey: string) {
  return async (req: any, res: any, next: any) => {
    const userId = req.userId as number | undefined;
    if (!userId) return res.status(401).json({ error: "unauthenticated" });

    const ok = await hasPermission(userId, permissionKey);
    if (!ok) return res.status(403).json({ error: "forbidden", required: permissionKey });
    next();
  };
}
