import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: 'Deprecated route. Use /api/soniox/temporary-key instead.' },
    { status: 410 }
  );
}
