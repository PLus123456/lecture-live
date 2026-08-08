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
  getRecordingDraftUsage,
  persistRecordingDraftChunk,
  MAX_DRAFT_TOTAL_BYTES,
  RecordingDraftChunkConflictError,
  RecordingDraftSealedError,
  RecordingDraftTooLargeError,
} from '@/lib/recordingDraftPersistence';
import { enforceRateLimit } from '@/lib/rateLimit';
import { checkQuota } from '@/lib/quota';

const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
// 单会话草稿分片 seq 上界。分片按 seq append-only 命名，seq 上界即文件数上界。
// P4-1：它**不是**写盘总量闸 —— 50000 × 2MiB ≈ 97.65GiB/会话，真正兜底的是
// MAX_DRAFT_TOTAL_BYTES（字节总量）与下方按用户的限流。
// P1-6：归档 recorder 的分片粒度为 3s（ARCHIVE_TIMESLICE_MS），PRO 上限 4h ⇒ 14400/3 = 4800 片，
// 远低于此上界（>10× 余量），合法录音绝不会触顶；旧代码 250ms 粒度（50000×0.25s≈3h28m<4h）才会。
// 超限时下方显式返回 413（明确错误），不再让 parsePositiveInteger 抛通用 Error 被 catch 成 500 —
// 后者会让客户端把「不可能成功」的补传当瞬时故障无限重试。
const MAX_DRAFT_CHUNKS_PER_SESSION = 50_000;

// P4-1：按用户限流。历史上这里的 600/分被整条摘掉（补传全量重传会被打成 429 → 会话结束不了），
// 但「完全不限流」等于给了一条无认证成本的写盘管道。改用宽到不可能误伤补传的额度：
// 3s 分片粒度下正常录音 20 次/分；4800 片的极端全量补传按此额度 ≈1.6 分钟跑完，仍不触顶。
// 真正的滥用闸是字节总量（MAX_DRAFT_TOTAL_BYTES）与存储配额，此处只挡「一秒几千次」的打法。
const DRAFT_CHUNK_RATE_LIMIT_PER_MIN = 3000;

// P4-1：存储配额的周期复查间隔（片）。3s 粒度下 ≈10 分钟一次，聚合开销可忽略；
// 只在 seq===0 查配额的旧写法既能被 seq=1 绕过，也放任「开录时刚好没超额」的会话一路写到天荒地老。
const QUOTA_RECHECK_EVERY_CHUNKS = 200;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 按 user+session 分桶：同一用户的不同会话互不干扰（多标签页/并发补传不会互相打死），
  // 且不用 IP —— TRUSTED_PROXY 缺省时 resolveRequestClientIp 恒返回 'unknown'（全站一个桶）。
  const rateLimited = await enforceRateLimit(req, {
    scope: 'sessions:draft-chunks',
    limit: DRAFT_CHUNK_RATE_LIMIT_PER_MIN,
    windowMs: 60_000,
    key: `user:${user.id}:session:${id}`,
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
    // P1-13 契约6（录音入口存储配额准入）：按 storageHoursLimit 准入，杜绝旧代码「生产录音入口
    // 从不校验存储配额、用户可无限累积录音时长/占用磁盘+Cloudreve」。checkQuota 是读时校验
    // （SUM(durationMs)/3600000 < limit），作为契约6允许的非原子降级闸门。
    // P4-1：闸门触发条件从「seq === 0」改为「本会话第一片（不论 seq） + 每 N 片复查一次」——
    // seq 不要求连续，旧写法从 seq=1 起传就完全跳过了唯一的配额闸（对已攒满存储的用户这道闸
    // 是真的会 402 的，绕过是实的）；周期复查同时挡住「开录时不超额、录着录着超额」。
    const usage = await getRecordingDraftUsage(session);
    const needsQuotaCheck =
      seq === 0 ||
      !usage.exists ||
      usage.chunkCount % QUOTA_RECHECK_EVERY_CHUNKS === 0;
    if (needsQuotaCheck) {
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
    // P4-1：草稿字节总量触顶 —— 明确 413（同片数超限），让客户端停止重试而非当瞬时故障死磕。
    if (error instanceof RecordingDraftTooLargeError) {
      return NextResponse.json(
        {
          error: `Recording draft size limit reached (max ${MAX_DRAFT_TOTAL_BYTES} bytes)`,
          limitExceeded: true,
          maxTotalBytes: MAX_DRAFT_TOTAL_BYTES,
        },
        { status: 413 }
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
