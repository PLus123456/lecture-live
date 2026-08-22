import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Public liveness only: no database, Redis, storage, or WS I/O. */
export async function GET() {
  const response = NextResponse.json({ status: 'ok' });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
