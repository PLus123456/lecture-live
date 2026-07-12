import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { getSiteSettings, SETTING_SECRET_MASK } from '@/lib/siteSettings';
import { validateCloudreveBaseUrl } from '@/lib/storage/cloudreve';
import { pingEnhanceWorker } from '@/lib/audio/enhanceWorkerClient';

/**
 * POST /api/admin/audio-enhance/verify — 音频增强 worker 连通性测试。
 * body 可带 { workerUrl, workerToken }（表单里未保存的值优先）；token 为空或脱敏占位
 * 时回落已保存的值，与设置 PUT 的「掩码=保持原值」语义一致。
 * 返回 worker 的引擎可用性（ffmpeg / deep-filter）与队列状态，供管理后台展示。
 */
export async function POST(req: Request) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:audio-enhance:verify',
    limit: 10,
    windowMs: 60_000,
  });
  if (response) return response;

  let body: { workerUrl?: unknown; workerToken?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // body 可选：全部回落已保存配置
  }

  const settings = await getSiteSettings({ fresh: true });
  const rawUrl =
    typeof body.workerUrl === 'string' && body.workerUrl.trim()
      ? body.workerUrl.trim()
      : settings.audio_enhance_worker_url;
  const rawToken =
    typeof body.workerToken === 'string' &&
    body.workerToken.trim() &&
    body.workerToken.trim() !== SETTING_SECRET_MASK
      ? body.workerToken.trim()
      : settings.audio_enhance_worker_token;

  if (!rawUrl) {
    return NextResponse.json({ ok: false, error: 'worker 地址未配置' }, { status: 400 });
  }
  if (!rawToken) {
    return NextResponse.json({ ok: false, error: 'worker token 未配置' }, { status: 400 });
  }
  try {
    validateCloudreveBaseUrl(rawUrl);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: `worker 地址不合法: ${error instanceof Error ? error.message : 'invalid URL'}`,
      },
      { status: 400 }
    );
  }

  try {
    const health = await pingEnhanceWorker({
      baseUrl: rawUrl.replace(/\/+$/, ''),
      token: rawToken,
    });
    // 未带鉴权详情（token 错也会拿到 {ok:true} 裸响应）：engines 缺失即视为鉴权失败
    if (!health.engines) {
      return NextResponse.json(
        { ok: false, error: 'worker 可达但 token 鉴权失败' },
        { status: 200 }
      );
    }
    return NextResponse.json({
      ok: true,
      version: health.version,
      engines: health.engines,
      queue: health.queue,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: `无法连接 worker: ${error instanceof Error ? error.message : 'unknown error'}`,
      },
      { status: 200 }
    );
  }
}
