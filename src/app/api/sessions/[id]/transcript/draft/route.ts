import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import {
  TranscriptDraftRejectedError,
  deleteTranscriptDraft,
  loadTranscriptDraft,
  loadTranscriptDraftManifest,
  persistTranscriptDraft,
  type TranscriptDraftPayload,
} from '@/lib/transcriptDraftPersistence';
import { isRecordingDraftSealed } from '@/lib/recordingDraftPersistence';
import { enforceRateLimit } from '@/lib/rateLimit';

// P4-5：草稿载荷字节上限。旧代码只有元素**个数**上限（MAX_SEGMENTS 等），对单个 segment 的
// 体积零校验 —— 10000 个巨型 segment 完全合法，落盘还 pretty-print 撑得更大。
// 8MiB 对「10000 段 + 翻译」的真实草稿有数倍余量。
const MAX_DRAFT_BODY_BYTES = 8 * 1024 * 1024;

// P4-5：PUT 限流。客户端每数秒冲刷一次快照，120 次/分钟远高于正常节奏（含 unload keepalive 冲刷）。
const DRAFT_PUT_RATE_LIMIT_PER_MIN = 120;

async function loadOwnedSession(req: Request, sessionId: string) {
  const user = await verifyAuth(req);
  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
  });
  if (!session) {
    return { error: NextResponse.json({ error: 'Session not found' }, { status: 404 }) };
  }

  try {
    assertOwnership(user.id, session.userId);
  } catch {
    return { error: NextResponse.json({ error: 'Access denied' }, { status: 403 }) };
  }

  return { session };
}

// 录制期间实时保存转录稿快照
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await loadOwnedSession(req, id);
  if (result.error) {
    return result.error;
  }

  // P4-5：按 user+session 分桶限流（认证之后，故拿得到 userId；IP 在 TRUSTED_PROXY 缺省时是
  // 全站一个桶）。这是「冲突分支每次都写一份全量备份」放大器的第一道闸。
  const rateLimited = await enforceRateLimit(req, {
    scope: 'sessions:transcript-draft',
    limit: DRAFT_PUT_RATE_LIMIT_PER_MIN,
    windowMs: 60_000,
    key: `user:${result.session.userId}:session:${id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  // 终态守卫：会话已 COMPLETED/ARCHIVED 后拒绝草稿写入，否则 finalize 删草稿之后迟到的
  // keepalive PUT（unload 冲刷）会重新创建草稿目录、永不再被清理（磁盘泄漏 + 冷恢复误读）。
  // 放行 FINALIZING —— 收尾流程在 finalize 前的最后一次 draft PUT 仍需落盘（审计 low）。
  if (result.session.status === 'COMPLETED' || result.session.status === 'ARCHIVED') {
    return NextResponse.json(
      { error: 'Session already finalized; draft writes no longer accepted' },
      { status: 409 }
    );
  }

  // P1-7 契约3：收尾 seal 阶段之后到达的迟到转录草稿写入一律 409（与 audio 分片同栅栏），
  // 否则 finalize 读取快照后写入的段会在删草稿时丢失。sealed 标记落在录音草稿 manifest 上。
  if (await isRecordingDraftSealed(result.session)) {
    return NextResponse.json(
      { error: 'Recording draft is sealed; transcript draft writes no longer accepted', sealed: true },
      { status: 409 }
    );
  }

  try {
    // P4-5：先按字节量闸，再 JSON.parse —— 数量闸挡不住「10000 个巨型 segment」，
    // 而 parse 本身也是同步 CPU，先量后解能一起挡住。
    const raw = await req.text();
    if (raw.length > MAX_DRAFT_BODY_BYTES) {
      return NextResponse.json(
        {
          error: `Draft payload too large (max ${MAX_DRAFT_BODY_BYTES} bytes)`,
          maxBytes: MAX_DRAFT_BODY_BYTES,
        },
        { status: 413 }
      );
    }
    const body = JSON.parse(raw);

    const segments = Array.isArray(body.segments) ? body.segments : [];
    const summaries = Array.isArray(body.summaries) ? body.summaries : [];
    const translations =
      body.translations && typeof body.translations === 'object' && !Array.isArray(body.translations)
        ? body.translations
        : {};

    // 安全：限制数组/对象大小，防止深度嵌套或巨型载荷
    const MAX_SEGMENTS = 10000;
    const MAX_SUMMARIES = 500;
    const MAX_TRANSLATIONS = 10000;
    if (segments.length > MAX_SEGMENTS) {
      return NextResponse.json({ error: `segments 数量不能超过 ${MAX_SEGMENTS}` }, { status: 400 });
    }
    if (summaries.length > MAX_SUMMARIES) {
      return NextResponse.json({ error: `summaries 数量不能超过 ${MAX_SUMMARIES}` }, { status: 400 });
    }
    if (Object.keys(translations).length > MAX_TRANSLATIONS) {
      return NextResponse.json({ error: `translations 数量不能超过 ${MAX_TRANSLATIONS}` }, { status: 400 });
    }

    const payload: TranscriptDraftPayload = {
      segments,
      summaries,
      translations,
      clientTs: typeof body.clientTs === 'number' ? body.clientTs : Date.now(),
      recordingStartTime: typeof body.recordingStartTime === 'number' ? body.recordingStartTime : undefined,
      pausedAt: typeof body.pausedAt === 'number' ? body.pausedAt : undefined,
      totalPausedMs: typeof body.totalPausedMs === 'number' ? body.totalPausedMs : undefined,
      totalDurationMs: typeof body.totalDurationMs === 'number' ? body.totalDurationMs : undefined,
      summaryRunningContext: typeof body.summaryRunningContext === 'string' ? body.summaryRunningContext : undefined,
      currentSessionIndex: typeof body.currentSessionIndex === 'number' ? body.currentSessionIndex : undefined,
    };

    // L17②：上面那两道终态守卫查完之后，还要 req.text() + JSON.parse 一份最大 8MiB 的载荷；
    // 这段时间足够 finalize 跑完（seal → 读快照 → 删草稿目录）。把守卫做成回调传下去，由
    // persistTranscriptDraft 在临界区内紧贴写盘前后各求值一次：写前拒 = 一个字节都不落，
    // 写后拒 = 补偿删除刚被重建出来的孤儿草稿目录。
    const stillWritable = async () => {
      if (await isRecordingDraftSealed(result.session)) {
        return false;
      }
      // finalize 收尾会连录音草稿一起删掉（sealedAt 随之消失），所以不能只看 seal —— 再按
      // **当前** DB 状态复核一次终态（入口读到的 session 快照此刻已经陈旧）。
      const fresh = await prisma.session.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!fresh) return false;
      return fresh.status !== 'COMPLETED' && fresh.status !== 'ARCHIVED';
    };

    const manifest = await persistTranscriptDraft(result.session, payload, {
      guard: stillWritable,
    });
    return NextResponse.json({
      success: true,
      segmentCount: manifest.segmentCount,
      updatedAt: manifest.updatedAt,
    });
  } catch (error) {
    if (error instanceof TranscriptDraftRejectedError) {
      return NextResponse.json(
        {
          error:
            'Recording draft is sealed; transcript draft writes no longer accepted',
          sealed: true,
        },
        { status: 409 }
      );
    }
    console.error('保存转录稿草稿失败:', error);
    return NextResponse.json(
      { error: 'Failed to save transcript draft' },
      { status: 500 }
    );
  }
}

// 查询草稿状态；?full=true 时返回完整草稿数据（用于浏览器关闭后冷恢复）
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await loadOwnedSession(req, id);
  if (result.error) {
    return result.error;
  }

  const url = new URL(req.url);
  const wantFull = url.searchParams.get('full') === 'true';

  if (wantFull) {
    const payload = await loadTranscriptDraft(result.session);
    if (!payload) {
      return NextResponse.json({ exists: false, payload: null });
    }
    return NextResponse.json({ exists: true, payload });
  }

  const manifest = await loadTranscriptDraftManifest(result.session);
  return NextResponse.json({
    exists: Boolean(manifest),
    segmentCount: manifest?.segmentCount ?? 0,
    updatedAt: manifest?.updatedAt ?? null,
  });
}

// 删除草稿
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await loadOwnedSession(req, id);
  if (result.error) {
    return result.error;
  }

  await deleteTranscriptDraft(result.session);
  return NextResponse.json({ success: true });
}
