import { NextResponse } from 'next/server';
import {
  getCachedHealthReport,
  isHealthDetailAuthorized,
  redactHealthReport,
} from '@/lib/health';
import { withRequestLogging } from '@/lib/requestLogger';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health
 *
 * M23：探测本身走 {@link getCachedHealthReport} 的短 TTL + singleflight 去抖 ——
 * 匿名高频调用不再逐次触发 DB / Redis / **出站 Cloudreve HEAD** / WS TCP 四项探测。
 *
 * 响应体默认只回 `{ status, checkedAt }`；依赖拓扑与各依赖延迟属于内部信息，
 * 仅在请求带正确的 `x-health-token`（对应 HEALTH_DETAIL_TOKEN）时返回。
 *
 * HTTP 状态码口径保持不变（down → 503），Dockerfile 的 HEALTHCHECK 依赖它。
 * 这里刻意不挂 enforceRateLimit，理由见 health.ts 里 getCachedHealthReport 的注释。
 */
export const GET = withRequestLogging('health:check', async (req: Request) => {
  const report = await getCachedHealthReport();
  const status = report.status === 'down' ? 503 : 200;
  const body = isHealthDetailAuthorized(req) ? report : redactHealthReport(report);
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'no-store');
  return response;
});
