import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import {
  deleteTranscriptDraft,
  loadTranscriptDraft,
  loadTranscriptDraftManifest,
  persistTranscriptDraft,
  type TranscriptDraftPayload,
} from '@/lib/transcriptDraftPersistence';

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

  try {
    const body = await req.json();

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

    const manifest = await persistTranscriptDraft(result.session, payload);
    return NextResponse.json({
      success: true,
      segmentCount: manifest.segmentCount,
      updatedAt: manifest.updatedAt,
    });
  } catch (error) {
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
