import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { checkQuota } from '@/lib/quota';
import { createInterpretAnchor } from '@/lib/interpret/anchor';

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
  return NextResponse.json({ anchorId });
}
