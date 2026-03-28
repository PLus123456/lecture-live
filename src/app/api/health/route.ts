import { NextResponse } from 'next/server';
import { getHealthReport } from '@/lib/health';
import { withRequestLogging } from '@/lib/requestLogger';

export const dynamic = 'force-dynamic';

export const GET = withRequestLogging('health:check', async () => {
  const report = await getHealthReport();
  const status = report.status === 'down' ? 503 : 200;
  const response = NextResponse.json(report, { status });
  response.headers.set('Cache-Control', 'no-store');
  return response;
});
