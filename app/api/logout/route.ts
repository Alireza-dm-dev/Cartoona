import { NextResponse } from 'next/server'
import { withObservability } from "@/lib/observability/request-context"
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const POST = withObservability("POST /api/logout", handlePost)

async function handlePost(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    await supabase.auth.signOut()
  } catch {
    // Fail closed: still redirect to login without exposing errors or session data.
  }

  return NextResponse.redirect(new URL('/login', request.url))
}
