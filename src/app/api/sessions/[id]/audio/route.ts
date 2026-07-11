import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { invalidateSessionsApiCache } from '@/lib/apiResponseCache';
import { assertOwnership, assertSessionReadAccess } from '@/lib/security';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logAction } from '@/lib/auditLog';
import {
  isAllowedAudioMimeType,
  matchesAudioSignature,
  MAX_AUDIO_UPLOAD_BYTES,
  normalizeAudioMimeType,
} from '@/lib/audio/uploadValidation';
import { deleteRecordingDraft } from '@/lib/recordingDraftPersistence';
import {
  stageSessionAudioArtifact,
  finalizeStagedArtifactPublish,
  rollbackStagedArtifact,
  loadSessionAudioArtifact,
  resolveSessionAudioLocation,
  openLocalAudioRangeStream,
} from '@/lib/sessionPersistence';
import { CloudreveStorage } from '@/lib/storage/cloudreve';
import {
  normalizeRecordedAudioDuration,
  resolveExpectedRecordingDurationMs,
} from '@/lib/audio/recordingDuration';
import { clampSessionDurationMs } from '@/lib/billing';
import { checkQuota } from '@/lib/quota';

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

  // G3：终态会话不得再被覆写录音。已 COMPLETED/ARCHIVED 的会话录音被
  // playback/export/Soniox 引用，禁止 re-POST 静默替换。
  if (session.status === 'COMPLETED' || session.status === 'ARCHIVED') {
    return NextResponse.json(
      { error: 'Cannot overwrite recording of a finalized session' },
      { status: 409 }
    );
  }

  // P1-13 契约6（录音入口存储配额准入）：整段录音直传入口按 storageHoursLimit 准入
  //（SUM(durationMs)/3600000 < limit 的读时校验，契约6允许的非原子降级闸门），杜绝旧代码
  // 生产录音入口从不校验存储配额。原子化 reserve/settle/release 待 quota.ts 导出后由集成层替换。
  const withinStorageQuota = await checkQuota(user.id, 'storage_hours');
  if (!withinStorageQuota) {
    return NextResponse.json(
      { error: 'Storage quota exceeded; cannot save recording', quota: 'storage_hours' },
      { status: 402 }
    );
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

    // G2/G3：durationMs 派生自可被伪造的 transcript globalEndMs（resolveTranscriptDurationMs
    // 会 Math.max 进来），必须按角色上界 clamp 后再落库，否则 SUM(durationMs)/3600000 存储
    // 小时用量可被撑到 Int 上界。
    const durationMs = clampSessionDurationMs(
      await resolveExpectedRecordingDurationMs(session),
      user.role
    );
    const normalizedBuffer = await normalizeRecordedAudioDuration({
      buffer,
      mimeType: normalizedMimeType,
      durationMs,
    });

    // P0-6：先写版本化临时对象（绝不覆盖旧固定 key），DB CAS 成功后才发布（删旧）；
    // CAS 失败则回滚删掉临时对象、绝不触碰已定稿的旧录音。
    const staged = await stageSessionAudioArtifact(
      session,
      normalizedBuffer,
      normalizedMimeType
    );

    // G3：原子条件更新，仅在会话仍处于非终态时写入 recordingPath，杜绝并发下
    // finalize 已把会话推到 COMPLETED 后本请求再覆写录音。
    const persisted = await prisma.session.updateMany({
      where: {
        id: id,
        status: { notIn: ['COMPLETED', 'ARCHIVED'] },
      },
      data: {
        recordingPath: staged.reference,
        ...(durationMs > 0 ? { durationMs } : {}),
      },
    });

    if (persisted.count === 0) {
      await rollbackStagedArtifact(session, staged);
      return NextResponse.json(
        { error: 'Cannot overwrite recording of a finalized session' },
        { status: 409 }
      );
    }
    const stored = await finalizeStagedArtifactPublish(session, staged);
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
    const { isCrossUserAdmin } = assertSessionReadAccess(user, session.userId);
    if (isCrossUserAdmin) {
      logAction(req, 'admin.session.audio.read', {
        user,
        detail: `读取他人录音音频 (sessionId=${id}, owner=${session.userId})`,
      });
    }
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const range = req.headers.get('range');

  try {
    // P2-2：先解析录音物理位置，按 Cloudreve/本地分别流式读取，不再一次性 loadSessionAudioArtifact
    // 把整段录音读进内存再 subarray（长录音 + 并发 Range 会放大进程内存直至 OOM）。
    const location = await resolveSessionAudioLocation(session);

    // Cloudreve 远程：透传上游 range/stream，失败落到下方本地/缓冲回退。
    if (location?.kind === 'cloudreve') {
      try {
        const storage = await CloudreveStorage.create();
        const upstream = await storage.openDownloadStream(location.remotePath, {
          expectedUserId: location.userId,
          range,
        });
        const headers = new Headers({
          'Content-Type': location.contentType,
          'Accept-Ranges': 'bytes',
        });
        for (const name of ['content-length', 'content-range']) {
          const value = upstream.headers.get(name);
          if (value) {
            headers.set(name, value);
          }
        }
        return new Response(upstream.body, {
          status: upstream.status === 206 ? 206 : 200,
          headers,
        });
      } catch (streamError) {
        console.error(
          'Audio stream error, falling back to buffered load:',
          streamError
        );
      }
    }

    // 本地文件：按 [start,end] 用 createReadStream 流式读，不整包入内存。
    if (location?.kind === 'local') {
      const totalSize = location.size;
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

          return new Response(
            openLocalAudioRangeStream(location.filePath, { start, end }),
            {
              status: 206,
              headers: {
                'Content-Type': location.contentType,
                'Content-Range': `bytes ${start}-${end}/${totalSize}`,
                'Content-Length': String(end - start + 1),
                'Accept-Ranges': 'bytes',
              },
            }
          );
        }
      }

      return new Response(openLocalAudioRangeStream(location.filePath), {
        headers: {
          'Content-Type': location.contentType,
          'Content-Length': String(totalSize),
          'Accept-Ranges': 'bytes',
        },
      });
    }

    // 回退：Cloudreve 流式失败或无法定位物理文件时，退回缓冲读取（含旧候选文件回退语义）。
    const artifact = await loadSessionAudioArtifact(session);
    if (!artifact) {
      return NextResponse.json({ error: 'Audio not found' }, { status: 404 });
    }

    const data = artifact.data;
    const totalSize = data.length;

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
