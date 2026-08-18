import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

/**
 * Connect token for the feed websocket (spec 03: browsers cannot set
 * headers on ws://, so the access token rides the query string). The web
 * server stays the token broker (ADR 0002) - the browser only holds it for
 * the lifetime of the socket connection, and it is same-origin fetch only.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
  }
  return NextResponse.json({ token: session.accessToken });
}
