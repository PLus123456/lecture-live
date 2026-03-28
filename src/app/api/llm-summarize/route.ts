import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: 'Deprecated route. Use /api/llm/summarize instead.' },
    { status: 410 }
  );
}
