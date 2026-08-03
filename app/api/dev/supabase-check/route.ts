import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { ok: false, message: 'Not available in production' },
      { status: 404 }
    )
  }

  let supabase
  try {
    supabase = await createServerSupabaseClient()
  } catch {
    return NextResponse.json({
      ok: false,
      message: 'Supabase client could not be created — check environment variables',
      tableChecked: 'characters',
    })
  }

  const { data, error } = await supabase
    .from('characters')
    .select('id, name, is_active')
    .limit(1)

  if (error) {
    return NextResponse.json({
      ok: false,
      message: `Query failed: ${error.message}`,
      tableChecked: 'characters',
    })
  }

  return NextResponse.json({
    ok: true,
    message: data.length > 0 ? 'Connected and table has data' : 'Connected but characters table is empty',
    tableChecked: 'characters',
    row: data.length > 0 ? data[0] : null,
  })
}
