import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { checkQuota } from '@/lib/quota';
import { createInterpretAnchor } from '@/lib/interpret/anchor';
import { createInterpretSession } from '@/lib/interpret/session';

/**
 * POST /api/interpret/start
 * 开始一次同声传译会话：校验转录配额并建立服务端时长锚点。
 * 返回 anchorId（Redis 不可用时为 null，前端据此降级且不阻塞 interpret 启动）。
 */
export async function POST(req: Request) {
  const payload = await verifyAuth(req);
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const quotaOk = await checkQuota(payload.id, 'transcription_minutes');
  if (!quotaOk) {
    return NextResponse.json({ error: 'Quota exceeded' }, { status: 403 });
  }

  const anchorId = await createInterpretAnchor(payload.id, Date.now());
  // B3：落一行服务端持久化会话（settledAt=null）。若客户端始终不调 /deduct，cron 会按服务端墙钟
  // 兜底扣费；deduct 正常结算时会原子认领它。best-effort：建行失败退化到旧行为（纯靠 deduct）。
  await createInterpretSession(payload.id, anchorId);
  return NextResponse.json({ anchorId });
}
