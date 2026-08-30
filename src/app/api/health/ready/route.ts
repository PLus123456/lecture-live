import { NextResponse } from 'next/server';
import {
  getCoalescedHealthReport,
  isHealthReadinessAuthorized,
} from '@/lib/healthReadiness';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!isHealthReadinessAuthorized(req)) {
    const denied = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    denied.headers.set('Cache-Control', 'no-store');
    return denied;
  }

  const report = await getCoalescedHealthReport();
  const status = report.status === 'down' ? 503 : 200;
  const response = NextResponse.json(report, { status });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
