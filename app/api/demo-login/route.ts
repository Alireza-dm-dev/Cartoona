import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const response = NextResponse.json({ success: true });

  response.cookies.set('cartoona_demo_parent_session', 'true', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });

  return response;
}
