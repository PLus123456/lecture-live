import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { invalidateSessionsApiCache } from '@/lib/apiResponseCache';
import { assertOwnership } from '@/lib/security';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  isAllowedAudioMimeType,
  matchesAudioSignature,
  MAX_AUDIO_UPLOAD_BYTES,
  normalizeAudioMimeType,
} from '@/lib/audio/uploadValidation';
import { deleteRecordingDraft } from '@/lib/recordingDraftPersistence';
import { persistSessionAudioArtifact, loadSessionAudioArtifact } from '@/lib/sessionPersistence';
import {
  normalizeRecordedAudioDuration,
  resolveExpectedRecordingDurationMs,
} from '@/lib/audio/recordingDuration';

// Save audio recording
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: 'sessions:audio-upload',
    limit: 20,
    windowMs: 60 * 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
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
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const normalizedMimeType = normalizeAudioMimeType(file.type);
    if (!isAllowedAudioMimeType(normalizedMimeType)) {
      return NextResponse.json(
        { error: 'Invalid audio type' },
        { status: 400 }
      );
    }

    if (file.size <= 0 || file.size > MAX_AUDIO_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: 'File too large' },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length === 0) {
      return NextResponse.json({ error: 'Audio file is empty' }, { status: 400 });
    }

    if (!matchesAudioSignature(buffer, normalizedMimeType)) {
      return NextResponse.json(
        { error: 'Audio file content does not match the declared type' },
        { status: 400 }
      );
    }

    const durationMs = await resolveExpectedRecordingDurationMs(session);
    const normalizedBuffer = await normalizeRecordedAudioDuration({
      buffer,
      mimeType: normalizedMimeType,
      durationMs,
    });

    const stored = await persistSessionAudioArtifact(
      session,
      normalizedBuffer,
      normalizedMimeType
    );

    await prisma.session.update({
      where: { id: id },
      data: {
        recordingPath: stored.path,
        ...(durationMs > 0 ? { durationMs } : {}),
      },
    });
    await invalidateSessionsApiCache(user.id);
    await deleteRecordingDraft(session).catch(() => undefined);

    return NextResponse.json({
      success: true,
      path: stored.path,
      storage: stored.storage,
    });
  } catch (error) {
    console.error('Save audio error:', error);
    return NextResponse.json(
      { error: 'Failed to save audio' },
      { status: 500 }
    );
  }
}

// Stream audio for playback
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: 'sessions:audio-download',
    limit: 60,
    windowMs: 10 * 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
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
    const artifact = await loadSessionAudioArtifact(session);
    if (!artifact) {
      return NextResponse.json(
        { error: 'Audio not found' },
        { status: 404 }
      );
    }

    const data = artifact.data;
    const totalSize = data.length;

    const range = req.headers.get('range');
    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const rawEnd = match[2] ? parseInt(match[2], 10) : totalSize - 1;
        const end = Math.min(rawEnd, totalSize - 1);
        if (
          Number.isNaN(start) ||
          Number.isNaN(end) ||
          start < 0 ||
          end < start ||
          start >= totalSize
        ) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${totalSize}` },
          });
        }

        const chunk = data.subarray(start, end + 1);
        return new Response(new Uint8Array(chunk), {
          status: 206,
          headers: {
            'Content-Type': artifact.contentType,
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Content-Length': String(chunk.length),
            'Accept-Ranges': 'bytes',
          },
        });
      }
    }

    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': artifact.contentType,
        'Content-Length': String(totalSize),
        'Accept-Ranges': 'bytes',
      },
    });
  } catch (error) {
    console.error('Load audio error:', error);
    return NextResponse.json(
      { error: 'Audio not found' },
      { status: 404 }
    );
  }
}
