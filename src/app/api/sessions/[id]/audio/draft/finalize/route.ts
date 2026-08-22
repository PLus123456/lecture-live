import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { invalidateSessionsApiCache } from '@/lib/apiResponseCache';
import { assertOwnership } from '@/lib/security';
import {
  deleteRecordingDraft,
  mergeRecordingDraftChunks,
  sealRecordingDraft,
  unsealRecordingDraft,
  MAX_DRAFT_TOTAL_BYTES,
  RecordingDraftTooLargeError,
} from '@/lib/recordingDraftPersistence';
import {
  stageSessionAudioArtifact,
  settleStagedArtifactsInTransaction,
  completeStagedArtifactPublishes,
  readbackStagedArtifactPublication,
  rollbackStagedArtifact,
} from '@/lib/sessionPersistence';
import {
  MAX_DURATION_FIX_BYTES,
  measureAuthoritativeRecordingDurationMsFromBuffer,
  normalizeRecordedAudioDuration,
  RECORDING_DURATION_LIMIT_GRACE_MS,
  RecordingDurationMeasurementError,
} from '@/lib/audio/recordingDuration';
import { getMaxSessionDurationMs } from '@/lib/billing';
import { StoredArtifactQuotaExceededError } from '@/lib/storage/storedArtifactLedger';

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

  // P1-7 契约3 阶段①（SEAL）：先封存草稿，阻断收尾期间迟到的分片/转录写入
  // （seal 后 chunks / transcript-draft 一律 409），杜绝 merge 读取快照与删草稿之间丢尾块。
  // ?phase=seal 供客户端在完整性判断前显式预封存；不带该参数的正式收尾也先 seal（幂等），
  // 即便客户端未走两阶段也不留写入窗口。本次收尾若未提交（空/缺片/CAS 落空/出错），
  // 末尾会 unseal 释放封存，让客户端补传缺片后重试，避免死锁。
  const summary = await sealRecordingDraft(session);

  const url = new URL(req.url);
  if (url.searchParams.get('phase') === 'seal') {
    return NextResponse.json({ success: true, ...summary });
  }

  try {
    const merged = await mergeRecordingDraftChunks(session);
    if (!merged) {
      await unsealRecordingDraft(session).catch(() => undefined);
      return NextResponse.json(
        { error: 'Recording draft is empty' },
        { status: 404 }
      );
    }

    // P0-5 契约2：完整性按「从 seq 0 起的连续集合」判定，任何缺口（含 leading gap —— 首块非
    // seq 0）都不得定稿：返回 409、保留草稿、绝不置终态，客户端据此重试补传而非清 IndexedDB。
    if (merged.hasGap) {
      // 释放封存，让客户端补传缺失分片后重试收尾（否则 sealed 会永久 409 挡住补传）。
      await unsealRecordingDraft(session).catch(() => undefined);
      return NextResponse.json(
        {
          error: 'Recording draft has missing chunks; cannot finalize',
          hasGap: true,
          receivedCount: merged.manifest.receivedSeqs.length,
        },
        { status: 409 }
      );
    }

    // SEC-018：无论 session/墙钟/转录已有 0、1ms 还是任意正值，发布草稿前都必须测量合并后
    // 的真实媒体。测量失败会进入 catch：unseal 草稿并保持全部分片，绝不 stage/写库/删除。
    const durationMs = await measureAuthoritativeRecordingDurationMsFromBuffer(
      merged.buffer,
      merged.manifest.mimeType
    );
    const maxDurationMs = getMaxSessionDurationMs(user.role);
    if (
      maxDurationMs !== null &&
      durationMs > maxDurationMs + RECORDING_DURATION_LIMIT_GRACE_MS
    ) {
      await unsealRecordingDraft(session).catch(() => undefined);
      return NextResponse.json(
        { error: 'Recording exceeds the maximum session duration' },
        { status: 422 }
      );
    }
    // P4-1：normalizeRecordedAudioDuration 会在合并结果之上再做 3-4 份整份拷贝（切段 → Blob →
    // arrayBuffer → concat），几百 MB 的录音就足以把 2GB 容器的主进程 OOM 掉。超过阈值时跳过
    // 时长修正：webm 时长头缺失只影响进度条/拖动的精度，浏览器照样能播；进程被打死则全站受害。
    const normalizedBuffer =
      merged.buffer.length > MAX_DURATION_FIX_BYTES
        ? merged.buffer
        : await normalizeRecordedAudioDuration({
            buffer: merged.buffer,
            mimeType: merged.manifest.mimeType,
            durationMs,
          });
    if (merged.buffer.length > MAX_DURATION_FIX_BYTES) {
      console.warn(
        `[draftFinalize] 合并结果 ${merged.buffer.length} 字节超过 ${MAX_DURATION_FIX_BYTES}，` +
          `跳过 webm 时长修正以避免整份拷贝打爆内存，session=${id}`
      );
    }

    // P0-6：先写版本化临时对象；DB CAS 成功后才发布（删旧 recordingPath）；CAS 失败回滚删临时对象、
    // 绝不触碰已定稿录音。换容器格式定稿时旧物理文件由 finalizeStagedArtifactPublish 删除，避免孤儿。
    const staged = await stageSessionAudioArtifact(
      session,
      normalizedBuffer,
      merged.manifest.mimeType
    );
    // G3：原子条件更新，仅在会话仍非终态时写入。
    let publication: Awaited<
      ReturnType<typeof settleStagedArtifactsInTransaction>
    > | null;
    try {
      publication = await prisma.$transaction(async (tx) => {
        const persisted = await tx.session.updateMany({
          where: {
            id: id,
            status: { notIn: ['COMPLETED', 'ARCHIVED'] },
          },
          data: {
            recordingPath: staged.reference,
            ...(durationMs > 0 ? { durationMs } : {}),
          },
        });
        if (persisted.count === 0) return null;
        return settleStagedArtifactsInTransaction(tx, [staged]);
      });
    } catch (error) {
      try {
        const owner = await prisma.session.findUnique({
          where: { id },
          select: { recordingPath: true },
        });
        const readback = await readbackStagedArtifactPublication(
          [staged],
          [owner?.recordingPath]
        );
        if (readback.outcome === 'committed') {
          publication = readback.publications;
        } else {
          if (readback.outcome === 'not_committed') {
            await rollbackStagedArtifact(session, staged).catch(() => undefined);
          }
          throw error;
        }
      } catch (readbackError) {
        if (readbackError === error) throw error;
        throw error;
      }
    }
    if (!publication) {
      await rollbackStagedArtifact(session, staged);
      // 会话已被并发推到终态：本次未提交，释放封存（草稿保留，终态录音由对方定稿，不被本次触碰）。
      await unsealRecordingDraft(session).catch(() => undefined);
      return NextResponse.json(
        { error: 'Cannot overwrite recording of a finalized session' },
        { status: 409 }
      );
    }
    const [stored] = await completeStagedArtifactPublishes(session, publication);
    if (!stored) throw new Error('recording artifact publication was incomplete');
    await invalidateSessionsApiCache(user.id);
    await deleteRecordingDraft(session);

    return NextResponse.json({
      success: true,
      path: stored.path,
      storage: stored.storage,
      chunkCount: merged.manifest.receivedSeqs.length,
    });
  } catch (error) {
    // 出错未提交：释放封存，避免草稿被永久 seal 挡住后续补传/重试。
    await unsealRecordingDraft(session).catch(() => undefined);
    // P4-1：草稿超总量上限 —— 明确 413 而非 500，草稿原样留盘（可人工取回），绝不 OOM 主进程。
    if (error instanceof RecordingDraftTooLargeError) {
      return NextResponse.json(
        {
          error: `Recording draft too large to finalize (max ${MAX_DRAFT_TOTAL_BYTES} bytes)`,
          limitExceeded: true,
          maxTotalBytes: MAX_DRAFT_TOTAL_BYTES,
        },
        { status: 413 }
      );
    }
    if (error instanceof StoredArtifactQuotaExceededError) {
      return NextResponse.json(
        {
          error: 'Storage quota exceeded; draft was retained',
          quota: 'storage_bytes',
        },
        { status: 402 }
      );
    }
    if (error instanceof RecordingDurationMeasurementError) {
      return NextResponse.json(
        {
          error: 'Could not verify recording duration; draft was retained',
          retryable: true,
        },
        { status: 422 }
      );
    }
    console.error('Finalize draft audio error:', error);
    return NextResponse.json(
      { error: 'Failed to finalize recording draft' },
      { status: 500 }
    );
  }
}
