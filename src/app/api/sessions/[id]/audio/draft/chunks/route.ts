import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isAllowedAudioMimeType, normalizeAudioMimeType } from '@/lib/audio/uploadValidation';
import {
  assertOwnership,
  parsePositiveInteger,
  sanitizeTextInput,
} from '@/lib/security';
import {
  getRecordingDraftManifestSummary,
  persistRecordingDraftChunk,
  RecordingDraftChunkConflictError,
  RecordingDraftSealedError,
} from '@/lib/recordingDraftPersistence';
import { checkQuota } from '@/lib/quota';

const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
// 单会话草稿分片 seq 上界。分片按 seq append-only 命名，seq 上界即文件数上界，故此值同时
// 兜住单用户写盘上限（配合 owner 认证 + 终态守卫，取代 #156 移除的按请求速率限流 —— 后者会
// 误伤「服务端缺片→增量补传」）。
// P1-6：归档 recorder 的分片粒度为 3s（ARCHIVE_TIMESLICE_MS），PRO 上限 4h ⇒ 14400/3 = 4800 片，
// 远低于此上界（>10× 余量），合法录音绝不会触顶；旧代码 250ms 粒度（50000×0.25s≈3h28m<4h）才会。
// 超限时下方显式返回 413（明确错误），不再让 parsePositiveInteger 抛通用 Error 被 catch 成 500 —
// 后者会让客户端把「不可能成功」的补传当瞬时故障无限重试。
const MAX_DRAFT_CHUNKS_PER_SESSION = 50_000;

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

  // 终态守卫：已 COMPLETED/ARCHIVED 的会话不再接受草稿分片写入，防止被回收/收尾后的会话
  // 继续被写盘（审计）。仍允许 CREATED/RECORDING/PAUSED/FINALIZING —— 收尾中(FINALIZING)
  // 的增量补传必须放行，否则尾部音频传不上去。
  if (session.status === 'COMPLETED' || session.status === 'ARCHIVED') {
    return NextResponse.json(
      { error: 'Session already finalized; draft chunks no longer accepted' },
      { status: 409 }
    );
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

    // P1-6：先按非负整数解析（拒负数/非数），再显式做上限判定 —— 超限返回明确的 413 而非让
    // parsePositiveInteger 的 max 抛通用 Error 掉进下方 catch 变成 500（触发客户端无限重试）。
    const seq = parsePositiveInteger(seqInput, { min: 0 });
    if (seq >= MAX_DRAFT_CHUNKS_PER_SESSION) {
      return NextResponse.json(
        {
          error: `Recording draft chunk limit reached (max ${MAX_DRAFT_CHUNKS_PER_SESSION}); session too long to persist as draft`,
          limitExceeded: true,
          maxChunks: MAX_DRAFT_CHUNKS_PER_SESSION,
        },
        { status: 413 }
      );
    }
    // P1-13 契约6（录音入口存储配额准入）：录音开始（首片 seq 0）时按 storageHoursLimit 准入，
    // 杜绝旧代码「生产录音入口从不校验存储配额、用户可无限累积录音时长/占用磁盘+Cloudreve」。
    // 这里用 checkQuota 的读时校验（SUM(durationMs)/3600000 < limit）作为契约6允许的非原子降级
    // 闸门；跨任务持久预留（reserveStorageMinutes/settle/release）待 quota.ts 导出后由集成层替换
    // 为原子版本（见 handoffs）。仅在 seq 0 校验，避免每片都做 SUM 聚合。
    if (seq === 0) {
      const withinStorageQuota = await checkQuota(user.id, 'storage_hours');
      if (!withinStorageQuota) {
        return NextResponse.json(
          {
            error: 'Storage quota exceeded; cannot start a new recording',
            quota: 'storage_hours',
          },
          { status: 402 }
        );
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const { idempotent, chunkCount } = await persistRecordingDraftChunk(session, {
      seq,
      mimeType: normalizedMimeType,
      data: buffer,
    });

    return NextResponse.json({
      success: true,
      seq,
      idempotent,
      chunkCount,
    });
  } catch (error) {
    // P1-7：草稿已 seal（收尾封存），拒绝迟到分片写入。
    if (error instanceof RecordingDraftSealedError) {
      return NextResponse.json(
        { error: 'Recording draft is sealed; no further chunks accepted', sealed: true },
        { status: 409 }
      );
    }
    // P0-4：同一 seq 内容不同 —— append-only 绝不覆盖已上传分片。
    if (error instanceof RecordingDraftChunkConflictError) {
      return NextResponse.json(
        { error: 'Chunk seq already exists with different content', seq: error.seq, conflict: true },
        { status: 409 }
      );
    }
    console.error('Save draft chunk error:', error);
    return NextResponse.json(
      { error: 'Failed to save draft chunk' },
      { status: 500 }
    );
  }
}

// P0-4：读草稿清单，供客户端冷启动/续录 recorder.start() 前协商起始 seq（nextSeq = 服务端 maxSeq+1）。
export async function GET(
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

  const summary = await getRecordingDraftManifestSummary(session);
  return NextResponse.json(summary);
}
