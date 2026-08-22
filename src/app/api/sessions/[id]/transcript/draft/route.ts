import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import {
  deleteTranscriptDraft,
  loadTranscriptDraft,
  loadTranscriptDraftManifest,
  persistTranscriptDraft,
} from '@/lib/transcriptDraftPersistence';
import { isRecordingDraftSealed } from '@/lib/recordingDraftPersistence';
import { enforceRateLimit } from '@/lib/rateLimit';
import { StoredArtifactQuotaExceededError } from '@/lib/storage/storedArtifactLedger';
import {
  admitTranscriptDraftPayload,
  readBoundedSessionJson,
  SessionTranscriptPayloadError,
} from '@/lib/sessionApi';

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
    const body = await readBoundedSessionJson(req);
    const payload = admitTranscriptDraftPayload(body);

    const manifest = await persistTranscriptDraft(result.session, payload);
    return NextResponse.json({
      success: true,
      segmentCount: manifest.segmentCount,
      updatedAt: manifest.updatedAt,
    });
  } catch (error) {
    if (error instanceof SessionTranscriptPayloadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof StoredArtifactQuotaExceededError) {
      return NextResponse.json(
        {
          error: 'Storage quota exceeded; transcript draft was not saved',
          quota: 'storage_bytes',
        },
        { status: 402 }
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
