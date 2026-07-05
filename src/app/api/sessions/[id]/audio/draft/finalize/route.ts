import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { invalidateSessionsApiCache } from '@/lib/apiResponseCache';
import { assertOwnership } from '@/lib/security';
import {
  deleteRecordingDraft,
  mergeRecordingDraftChunks,
} from '@/lib/recordingDraftPersistence';
import { persistSessionAudioArtifact } from '@/lib/sessionPersistence';
import {
  normalizeRecordedAudioDuration,
  resolveExpectedRecordingDurationMs,
} from '@/lib/audio/recordingDuration';
import { clampSessionDurationMs } from '@/lib/billing';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await prisma.session.findUnique({
    where: { id: id },
  });
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  try {
    assertOwnership(user.id, session.userId);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  // G3：终态会话不得再被草稿定稿覆写录音。
  if (session.status === 'COMPLETED' || session.status === 'ARCHIVED') {
    return NextResponse.json(
      { error: 'Cannot overwrite recording of a finalized session' },
      { status: 409 }
    );
  }

  try {
    const merged = await mergeRecordingDraftChunks(session);
    if (!merged) {
      return NextResponse.json(
        { error: 'Recording draft is empty' },
        { status: 404 }
      );
    }

    // G2：按角色上界 clamp durationMs 后再落库（同 /audio 路由），防伪造 transcript
    // globalEndMs 撑高 SUM(durationMs) 存储小时用量。
    const durationMs = clampSessionDurationMs(
      await resolveExpectedRecordingDurationMs(session),
      user.role
    );
    const normalizedBuffer = await normalizeRecordedAudioDuration({
      buffer: merged.buffer,
      mimeType: merged.manifest.mimeType,
      durationMs,
    });

    // G5/G6：persistSessionAudioArtifact 传入 session（含旧 recordingPath），换容器格式
    // 定稿时会 best-effort 删旧物理文件，避免孤儿。
    const stored = await persistSessionAudioArtifact(
      session,
      normalizedBuffer,
      merged.manifest.mimeType
    );
    // G3：原子条件更新，仅在会话仍非终态时写入。
    const persisted = await prisma.session.updateMany({
      where: {
        id: id,
        status: { notIn: ['COMPLETED', 'ARCHIVED'] },
      },
      data: {
        recordingPath: stored.path,
        ...(durationMs > 0 ? { durationMs } : {}),
      },
    });
    if (persisted.count === 0) {
      return NextResponse.json(
        { error: 'Cannot overwrite recording of a finalized session' },
        { status: 409 }
      );
    }
    await invalidateSessionsApiCache(user.id);
    await deleteRecordingDraft(session);

    return NextResponse.json({
      success: true,
      path: stored.path,
      storage: stored.storage,
      chunkCount: merged.manifest.receivedSeqs.length,
    });
  } catch (error) {
    console.error('Finalize draft audio error:', error);
    return NextResponse.json(
      { error: 'Failed to finalize recording draft' },
      { status: 500 }
    );
  }
}
