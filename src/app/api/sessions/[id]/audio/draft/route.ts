import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { assertOwnership } from '@/lib/security';
import {
  deleteRecordingDraft,
  loadRecordingDraftManifest,
} from '@/lib/recordingDraftPersistence';

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

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await loadOwnedSession(req, id);
  if (result.error) {
    return result.error;
  }

  const manifest = await loadRecordingDraftManifest(result.session);
  return NextResponse.json({
    exists: Boolean(manifest),
    seqs: manifest?.receivedSeqs ?? [],
    chunkCount: manifest?.receivedSeqs.length ?? 0,
    mimeType: manifest?.mimeType ?? null,
    updatedAt: manifest?.updatedAt ?? null,
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await loadOwnedSession(req, id);
  if (result.error) {
    return result.error;
  }

  await deleteRecordingDraft(result.session);
  return NextResponse.json({ success: true });
}
