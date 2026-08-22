import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { getSiteSettings, SETTING_SECRET_MASK } from '@/lib/siteSettings';
import { validateCloudreveBaseUrl } from '@/lib/storage/cloudreve';
import { pingEnhanceWorker, parseWorkerUrls } from '@/lib/audio/enhanceWorkerClient';
import { JOB_STATUS, JOB_TYPE, trackJob } from '@/lib/jobQueue';
import { writeSecurityAudit } from '@/lib/securityAudit';

/**
 * POST /api/admin/audio-enhance/verify — 音频增强 worker 连通性测试（支持多台）。
 * body 可带 { workerUrl, workerToken }（表单里未保存的值优先）；workerUrl 支持逗号/换行
 * 分隔多台，逐台并行探测。token 为空或脱敏占位时回落已保存的值，与设置 PUT 的
 * 「掩码=保持原值」语义一致。返回 { ok（全部可达）, workers: [逐台结果] }。
 */
export async function POST(req: Request) {
  const { user, response } = await requireAdminAccess(req, {
    scope: 'admin:audio-enhance:verify',
    limit: 10,
    windowMs: 60_000,
  });
  if (response || !user) return response!;

  let body: { workerUrl?: unknown; workerToken?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // body 可选：全部回落已保存配置
  }

  const settings = await getSiteSettings({ fresh: true });
  const rawUrls =
    typeof body.workerUrl === 'string' && body.workerUrl.trim()
      ? body.workerUrl
      : settings.audio_enhance_worker_url;
  const rawToken =
    typeof body.workerToken === 'string' &&
    body.workerToken.trim() &&
    body.workerToken.trim() !== SETTING_SECRET_MASK
      ? body.workerToken.trim()
      : settings.audio_enhance_worker_token;

  const urls = parseWorkerUrls(rawUrls);
  if (urls.length === 0) {
    return NextResponse.json({ ok: false, error: 'worker 地址未配置' }, { status: 400 });
  }
  if (!rawToken) {
    return NextResponse.json({ ok: false, error: 'worker token 未配置' }, { status: 400 });
  }

  // 注：这里**刻意不做**「探测未保存地址必须显式给 token」的换靶闸（P2-2 已收窄为只保 SMTP）。
  // 这是「填好地址先点一下测试连接」的常规动作，逼着重填 token 会把它变得很难用。
  // 残余风险与收口方向见 admin/settings/route.ts 里的说明。

  for (const url of urls) {
    try {
      validateCloudreveBaseUrl(url);
    } catch (error) {
      return NextResponse.json(
        {
          ok: false,
          error: `worker 地址不合法 (${url}): ${
            error instanceof Error ? error.message : 'invalid URL'
          }`,
        },
        { status: 400 }
      );
    }
  }

  const workers = await trackJob(
    {
      type: JOB_TYPE.ADMIN_INTEGRATION,
      userId: user.id,
      triggeredBy: `admin:${user.id}`,
      // Durable journal only records the operation shape, never worker URLs/tokens.
      params: { operation: 'audio_enhance_verify', workerCount: urls.length },
      resultSummary: (result) => ({
        workerCount: result.length,
        reachableCount: result.filter((worker) => worker.ok).length,
      }),
      terminalMutation: async (tx, terminal) => {
        const success =
          terminal.status === JOB_STATUS.SUCCESS
            ? terminal.result.filter((worker) => worker.ok).length
            : 0;
        await writeSecurityAudit(
          req,
          {
            event: 'audio_enhance.verify',
            operator: user,
            target: { type: 'audio_enhance_worker_pool' },
            before: null,
            after: {
              workerCount: urls.length,
              reachableCount: success,
            },
            reason: 'admin-requested-worker-connectivity-check',
            outcome:
              terminal.status === JOB_STATUS.FAILED
                ? 'FAILED'
                : success === urls.length
                  ? 'SUCCESS'
                  : 'PARTIAL',
            metadata: { journaled: true },
          },
          tx
        );
      },
    },
    () =>
      Promise.all(
        urls.map(async (url) => {
          try {
            const health = await pingEnhanceWorker({ baseUrl: url, token: rawToken });
            // 未带鉴权详情（token 错也会拿到 {ok:true} 裸响应）：engines 缺失即视为鉴权失败
            if (!health.engines) {
              return { url, ok: false as const, error: 'worker 可达但 token 鉴权失败' };
            }
            return {
              url,
              ok: true as const,
              version: health.version,
              engines: health.engines,
              queue: health.queue,
            };
          } catch (error) {
            return {
              url,
              ok: false as const,
              error: `无法连接: ${error instanceof Error ? error.message : 'unknown error'}`,
            };
          }
        })
      )
  );

  return NextResponse.json({ ok: workers.every((w) => w.ok), workers });
}
