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
  probeAudioDurationMsFromBuffer,
  resolveExpectedRecordingDurationMs,
} from '@/lib/audio/recordingDuration';
import { clampSessionDurationMs } from '@/lib/billing';
import { checkQuota, releaseStorageBytes, reserveStorageBytes } from '@/lib/quota';

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
    // P5-14：三个来源（session.durationMs / transcript / serverStartedAt）都建立在
    // 「走过实时链路」的前提上。直传口可以往一个从没连过 WS 的会话灌音频，那时三者同时为 0，
    // 这段录音对 storage_hours 的贡献恒为 0 —— 等于绕开存储小时额度。用 ffprobe 读真时长兜底。
    //
    // session-persist#151：兜底条件此前是「三源皆 0 才 probe」，于是只要**先**往库里塞一个极小
    // 正值就能把整条 ffprobe 分支跳过 —— PATCH /api/sessions/[id] 允许会话所有者首次写入任意
    // durationMs（1ms ≥ 当前 0、非终态，两道守卫都不拦），随后直传数小时的低码率录音：
    // resolveExpectedRecordingDurationMs 返回 1，probe 不跑，1ms 落库。该录音对 storage_hours
    // 几乎零贡献，且 /full-transcribe 的预留与实扣都按 ceil(getBillableMinutes(1)×倍率)=1 分钟
    // 计价 —— 1 分钟额度换数小时 Soniox 转录。PATCH 侧已彻底不再接受客户端 durationMs，这里再
    // 把口径从「为 0 才探测」改成「与探测值取最大值」：任何来源的低报都被真实音频长度顶上去。
    const probedDurationMs = await probeAudioDurationMsFromBuffer(
      buffer,
      normalizedMimeType
    );
    const durationMs = clampSessionDurationMs(
      Math.max(await resolveExpectedRecordingDurationMs(session), probedDurationMs),
      user.role
    );

    const normalizedBuffer = await normalizeRecordedAudioDuration({
      buffer,
      mimeType: normalizedMimeType,
      durationMs,
    });

    // P5-14：直传录音此前**完全不入 storage_bytes**（只过了 storage_hours 那道读时闸），
    // 于是 32MB × 20 次/小时/用户 的字节量对字节配额完全隐形。这里补上净增量预留。
    //
    // 「净增量」而不是「全额」：同一会话在非终态期间可以反复 re-POST，全额累加会把用户额度
    // 吃空且没有释放路径。旧录音大小只有本地存储能低成本拿到（stat）；Cloudreve 拿不到，
    // 那种情况下跳过预留 —— 宁可漏计一次覆盖，也不能凭空永久吃掉用户额度。
    const previousLocation = await resolveSessionAudioLocation(session).catch(
      () => null
    );
    let reservedBytes = 0;
    if (!previousLocation) {
      reservedBytes = normalizedBuffer.length;
    } else if (previousLocation.kind === 'local') {
      reservedBytes = Math.max(0, normalizedBuffer.length - previousLocation.size);
    }
    if (reservedBytes > 0) {
      const gotBytes = await reserveStorageBytes(user.id, reservedBytes);
      if (!gotBytes) {
        return NextResponse.json(
          {
            error: 'Storage quota exceeded; cannot save recording',
            quota: 'storage_bytes',
          },
          { status: 402 }
        );
      }
    }
    /** 任何失败路径都要把刚预留的字节还回去。 */
    const releaseReservedBytes = async () => {
      if (reservedBytes > 0) {
        await releaseStorageBytes(user.id, reservedBytes).catch(() => undefined);
      }
    };

    // P0-6：先写版本化临时对象（绝不覆盖旧固定 key），DB CAS 成功后才发布（删旧）；
    // CAS 失败则回滚删掉临时对象、绝不触碰已定稿的旧录音。
    const staged = await stageSessionAudioArtifact(
      session,
      normalizedBuffer,
      normalizedMimeType
    ).catch(async (error) => {
      await releaseReservedBytes();
      throw error;
    });

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
      await releaseReservedBytes();
      return NextResponse.json(
        { error: 'Cannot overwrite recording of a finalized session' },
        { status: 409 }
      );
    }
    // 本地覆盖且新录音更小：把腾出来的字节还给用户（预留只算了正向增量）。
    if (previousLocation?.kind === 'local') {
      const freed = previousLocation.size - normalizedBuffer.length;
      if (freed > 0) {
        await releaseStorageBytes(user.id, freed).catch(() => undefined);
      }
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

  // 音频增强：?variant=enhanced 且增强版已就绪时，把读取引用换成 enhancedAudioPath，
  // 复用下方全部 Range/流式/回退逻辑；未就绪回落原始录音（前端先查 enhance-status 再切）。
  const variant = new URL(req.url).searchParams.get('variant');
  const audioSession =
    variant === 'enhanced' && session.enhancedAudioPath
      ? { ...session, recordingPath: session.enhancedAudioPath }
      : session;

  try {
    // P2-2：先解析录音物理位置，按 Cloudreve/本地分别流式读取，不再一次性 loadSessionAudioArtifact
    // 把整段录音读进内存再 subarray（长录音 + 并发 Range 会放大进程内存直至 OOM）。
    const location = await resolveSessionAudioLocation(audioSession);

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
    const artifact = await loadSessionAudioArtifact(audioSession);
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
