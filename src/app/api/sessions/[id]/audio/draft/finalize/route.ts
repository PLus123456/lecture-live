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

  try {
    const merged = await mergeRecordingDraftChunks(session);
    if (!merged) {
      return NextResponse.json(
        { error: 'Recording draft is empty' },
        { status: 404 }
      );
    }

    const durationMs = await resolveExpectedRecordingDurationMs(session);
    const normalizedBuffer = await normalizeRecordedAudioDuration({
      buffer: merged.buffer,
      mimeType: merged.manifest.mimeType,
      durationMs,
    });

    const stored = await persistSessionAudioArtifact(
      session,
      normalizedBuffer,
      merged.manifest.mimeType
    );
    await prisma.session.update({
      where: { id: id },
      data: {
        recordingPath: stored.path,
        ...(durationMs > 0 ? { durationMs } : {}),
      },
    });
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
