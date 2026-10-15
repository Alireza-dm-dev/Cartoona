import { runQuery } from "@/lib/db/query";
import type { Queryable } from "@/lib/db/types";
import { requireUuid } from "./actor";

export type UserRole = "parent" | "admin" | "super_admin";

export interface UserRecord {
  id: string;
  role: UserRole;
  /** Soft-deleted accounts keep their row; callers decide what that means. */
  deleted: boolean;
}

const SELECT_USER = `
  SELECT u.id, u.role, (u.deleted_at IS NOT NULL) AS deleted
  FROM public.users u
  WHERE u.id = $1`;

/**
 * One user's role, by explicit id. Replaces the Supabase read
 * `users.select("role").eq("id", user.id)` (RLS: own row). Null when no row.
 */
export async function getUserById(db: Queryable, input: { userId: string }): Promise<UserRecord | null> {
  const userId = requireUuid(input.userId, "userId");
  const rows = await runQuery<{ id: string; role: UserRole; deleted: boolean }>(db, SELECT_USER, [userId]);
  const row = rows[0];
  return row ? { id: row.id, role: row.role, deleted: row.deleted } : null;
}
