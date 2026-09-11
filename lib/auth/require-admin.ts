import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isAdminRole } from "@/lib/auth/admin-role";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Generic admin gate for server routes and actions.
 *
 * This is the same check `requireExamplesAdmin` performs, lifted to a
 * feature-neutral home so the homepage CMS does not need its own copy. It
 * reuses the existing `users.role` model - no second role system is introduced.
 * `lib/examples/example-auth.ts` keeps its own wrapper for now; adopting this
 * one there is a separate, unrelated change.
 */
export class AdminAuthorizationError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = "AdminAuthorizationError";
  }
}

export interface AdminContext {
  user: { id: string };
  supabase: SupabaseClient;
}

/**
 * Resolves the caller and asserts they hold `admin` or `super_admin`.
 * Throws {@link AdminAuthorizationError} with 401 (unauthenticated) or
 * 403 (authenticated but not an admin). Never leaks the underlying error.
 */
export async function requireAdmin(): Promise<AdminContext> {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new AdminAuthorizationError("Unauthorized", 401);
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (roleError || !roleRow || !isAdminRole(roleRow.role)) {
    throw new AdminAuthorizationError("Forbidden", 403);
  }

  return { user: { id: user.id }, supabase };
}
