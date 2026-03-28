import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isAllowedAudioMimeType, normalizeAudioMimeType } from '@/lib/audio/uploadValidation';
import {
  assertOwnership,
  parsePositiveInteger,
  sanitizeTextInput,
} from '@/lib/security';
import { persistRecordingDraftChunk } from '@/lib/recordingDraftPersistence';

const MAX_CHUNK_BYTES = 2 * 1024 * 1024;

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
    scope: 'sessions:audio-draft-chunks',
    limit: 600,
    windowMs: 60_000,
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
    const file = formData.get('file');
    const seqInput = formData.get('seq');
    const mimeType = sanitizeTextInput(String(formData.get('mimeType') ?? ''), {
      maxLength: 128,
      fallback: 'audio/webm',
    });
    const normalizedMimeType = normalizeAudioMimeType(mimeType);

    if (!(file instanceof File) || typeof seqInput !== 'string') {
      return NextResponse.json(
        { error: 'file and seq are required' },
        { status: 400 }
      );
    }

    if (file.size <= 0 || file.size > MAX_CHUNK_BYTES) {
      return NextResponse.json(
        { error: `Chunk size must be between 1 byte and ${MAX_CHUNK_BYTES} bytes` },
        { status: 400 }
      );
    }

    if (!isAllowedAudioMimeType(normalizedMimeType)) {
      return NextResponse.json(
        { error: 'Invalid audio type' },
        { status: 400 }
      );
    }

    const seq = parsePositiveInteger(seqInput, { min: 0, max: 1_000_000 });
    const buffer = Buffer.from(await file.arrayBuffer());
    const manifest = await persistRecordingDraftChunk(session, {
      seq,
      mimeType: normalizedMimeType,
      data: buffer,
    });

    return NextResponse.json({
      success: true,
      seq,
      chunkCount: manifest.receivedSeqs.length,
    });
  } catch (error) {
    console.error('Save draft chunk error:', error);
    return NextResponse.json(
      { error: 'Failed to save draft chunk' },
      { status: 500 }
    );
  }
}
