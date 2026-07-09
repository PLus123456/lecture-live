import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
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

  // 【临时移除限流 — 见 fix/hotfix】录音结束时 syncRemoteDraft 会对本人自己的录音做
  // 增量补传；按请求数硬限流（600/分）在「服务端 chunk 缺失 → 全量补传」时会被打成 429，
  // 与限流卡死 key 叠加造成「疯狂同步、会话结束不了」。此端点是 owner 认证 + assertOwnership
  // 的自有会话批量写，暂时不做按请求数限流。
  // TODO(真正修复)：① 修 syncRemoteDraft 的「GET 失败→全量重传」放大器（不清空已传记录）；
  //   ② 如需防滥用，改为按会话总分片数/字节配额限制，而非按请求速率。

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
