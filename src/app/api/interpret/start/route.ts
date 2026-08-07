import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
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

  // P6-7：按用户限流（口径对齐 temporary-key 的 12/min）。每次调用都写一行 Redis 锚点 +
  // 一行 InterpretSession，无闸门时脚本可无成本刷库；也是 start→mint→deduct 循环的第一道闸。
  const rateLimited = await enforceRateLimit(req, {
    scope: 'interpret:start:user',
    limit: 12,
    windowMs: 60_000,
    key: `user:${payload.id}`,
  });
  if (rateLimited) {
    return rateLimited;
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
