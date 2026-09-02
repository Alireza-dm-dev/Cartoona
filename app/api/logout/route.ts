import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    await supabase.auth.signOut()
  } catch {
    // Fail closed: still redirect to login without exposing errors or session data.
  }

  return NextResponse.redirect(new URL('/login', request.url))
}
