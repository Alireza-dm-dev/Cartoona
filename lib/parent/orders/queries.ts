import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParentOrderListResult, ParentOrderSummary } from "./types";
import { PARENT_VISIBLE_INTERNAL_STATUSES, toParentOrderStatus } from "./status-mapping";
import { isKnownOrderType } from "./type-mapping";

/**
 * Columns the parent list reads. Listed explicitly rather than with `*` so a
 * future column on `orders` cannot widen what the parent sees by accident.
 * Notably absent: assigned_admin_id, moderation_status, description.
 */
const PARENT_ORDER_COLUMNS = "id, type, status, title, candy_cost, created_at, updated_at";

/** Untrusted shape of one row as it arrives from PostgREST. */
interface RawOrderRow {
  id: unknown;
  type: unknown;
  status: unknown;
  title: unknown;
  candy_cost: unknown;
  created_at: unknown;
  updated_at: unknown;
}

const FALLBACK_TITLE = "درخواست بدون عنوان";

/**
 * Narrow one database row to the parent read model.
 *
 * Exported for unit testing, which is why it takes a plain object rather than
 * a query builder. Returns null when the row cannot be safely presented: an
 * unknown type or a status with no parent-facing meaning is dropped rather
 * than guessed at, so a newer database than this build degrades by hiding a
 * row instead of leaking an internal string into the UI.
 */
export function toParentOrderSummary(row: RawOrderRow): ParentOrderSummary | null {
  if (typeof row.id !== "string" || row.id.length === 0) return null;

  const requestType = typeof row.type === "string" ? row.type : null;
  if (!isKnownOrderType(requestType)) return null;

  const status = toParentOrderStatus(typeof row.status === "string" ? row.status : null);
  if (status === null) return null;

  if (typeof row.created_at !== "string") return null;

  const candyCostRaw = typeof row.candy_cost === "number" ? row.candy_cost : 0;
  const candyCost = Number.isFinite(candyCostRaw) && candyCostRaw > 0 ? Math.trunc(candyCostRaw) : 0;

  const title = typeof row.title === "string" && row.title.trim().length > 0
    ? row.title.trim()
    : FALLBACK_TITLE;

  // `updated_at` doubles as the completion timestamp, but only once the
  // request actually reached the delivered state. Exposing it otherwise would
  // leak the timing of internal admin activity on an in-flight request.
  const completedAt =
    status === "ready" && typeof row.updated_at === "string" ? row.updated_at : null;

  return {
    id: row.id,
    requestType,
    createdAt: row.created_at,
    displayTitle: title,
    status,
    candyCost,
    completedAt,
  };
}

/**
 * Every submitted request belonging to the signed-in parent, newest first.
 *
 * Ownership is enforced in the query itself. The parent profile id is resolved
 * from the authenticated user and applied as an `eq("parent_id", ...)` filter,
 * so the database never returns another parent's row to this process. Row
 * level security (`orders_select_own_parent`) independently enforces the same
 * rule on the anon key, which means an ownership mistake here would have to
 * defeat two layers rather than one. Nothing is filtered in React.
 */
export async function getParentOrders(
  supabase: SupabaseClient,
): Promise<ParentOrderListResult> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) return { ok: false, reason: "unauthenticated" };

  const { data: profile, error: profileError } = await supabase
    .from("parent_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError) return { ok: false, reason: "read_failed" };
  if (!profile?.id) return { ok: false, reason: "no_parent_profile" };

  const { data, error } = await supabase
    .from("orders")
    .select(PARENT_ORDER_COLUMNS)
    .eq("parent_id", profile.id)
    .in("status", PARENT_VISIBLE_INTERNAL_STATUSES as string[])
    .order("created_at", { ascending: false });

  if (error) return { ok: false, reason: "read_failed" };

  const rows = Array.isArray(data) ? (data as unknown as RawOrderRow[]) : [];
  const orders = rows
    .map(toParentOrderSummary)
    .filter((o): o is ParentOrderSummary => o !== null);

  return { ok: true, orders };
}
