import { createServerSupabaseClient } from "@/lib/supabase/server"
import { isAdminRole } from "@/lib/auth/admin-role"
import type { SupabaseClient } from "@supabase/supabase-js"

export class AdminAuthError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message)
    this.name = "AdminAuthError"
  }
}

export interface AdminAuthResult {
  user: { id: string }
}

export async function requireExamplesAdmin(): Promise<AdminAuthResult & { supabase: SupabaseClient }> {
  const supabase = await createServerSupabaseClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    throw new AdminAuthError("Unauthorized", 401)
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  if (roleError || !roleRow) {
    throw new AdminAuthError("Forbidden", 403)
  }

  if (!isAdminRole(roleRow.role)) {
    throw new AdminAuthError("Forbidden", 403)
  }

  return { user: { id: user.id }, supabase }
}
