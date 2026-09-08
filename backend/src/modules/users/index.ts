import { pool } from "../../db/pool.js";
import { writeAudit } from "../../audit/index.js";
import { revokeAllSessionsForUser } from "../auth/index.js";

export async function banUser(params: { userId: number; reason: string; actorUserId: number }) {
  const { userId, reason, actorUserId } = params;
  await pool.query(`UPDATE users SET is_banned = true, ban_reason = $1 WHERE id = $2`, [reason, userId]);
  await revokeAllSessionsForUser(userId); // this is the whole point — a ban with no session kill is not a real ban
  await writeAudit({
    actorUserId,
    action: "user.ban",
    targetType: "user",
    targetId: String(userId),
    payload: { reason },
    result: "success",
  });
}

export async function unbanUser(params: { userId: number; actorUserId: number }) {
  const { userId, actorUserId } = params;
  await pool.query(`UPDATE users SET is_banned = false, ban_reason = NULL WHERE id = $1`, [userId]);
  await writeAudit({
    actorUserId,
    action: "user.unban",
    targetType: "user",
    targetId: String(userId),
    result: "success",
  });
}
