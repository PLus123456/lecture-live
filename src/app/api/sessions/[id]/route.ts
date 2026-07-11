import { NextResponse } from 'next/server';
import type { Prisma, SessionStatus as PrismaSessionStatus } from '@prisma/client';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  invalidateFoldersApiCache,
  invalidateSessionsApiCache,
  invalidateShareLinksApiCache,
} from '@/lib/apiResponseCache';
import { jsonWithCache } from '@/lib/httpCache';
import { assertOwnership, assertSessionReadAccess } from '@/lib/security';
import { logAction } from '@/lib/auditLog';
import {
  normalizeOptionalString,
  normalizeSessionAudioSource,
  normalizeSessionRegion,
} from '@/lib/sessionApi';
import {
  loadSessionAudioArtifact,
  loadSessionTranscriptBundle,
  deleteSessionArtifacts,
} from '@/lib/sessionPersistence';
import { deleteRecordingDraft } from '@/lib/recordingDraftPersistence';
import { deleteConversationsCascade } from '@/lib/conversationCascade';
import { settleAsyncReservation } from '@/lib/quota';
import { cancelAsyncUpload } from '@/lib/audio/asyncUploadProcessor';
import { resolveSonioxRuntimeConfigAsync } from '@/lib/soniox/env';
import {
  deleteSonioxFile,
  deleteSonioxTranscription,
} from '@/lib/soniox/asyncFile';

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
    const { isCrossUserAdmin } = assertSessionReadAccess(user, session.userId);
    if (isCrossUserAdmin) {
      logAction(req, 'admin.session.read', {
        user,
        detail: `读取他人会话元数据 (sessionId=${id}, owner=${session.userId})`,
      });
    }
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  return jsonWithCache(req, session, {
    cacheControl: 'private, no-cache, must-revalidate',
    vary: ['Authorization', 'Cookie'],
  });
}

export async function PATCH(
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

  const body = await req.json();
  const nextStatusInput =
    body.status === undefined
      ? undefined
      : typeof body.status === 'string'
        ? body.status
        : null;

  if (nextStatusInput === null) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const nextStatus = nextStatusInput as PrismaSessionStatus | undefined;

  // v2.1: validate status transitions — strict one-way lifecycle
  if (nextStatus) {
    // C4：从 PATCH 状态机移除 FINALIZING→COMPLETED —— COMPLETED 只能经 finalize 端点
    // 到达，那里才有 deductTranscriptionMinutes 的唯一扣费路径。否则客户端可先存 artifact、
    // 再 PATCH 把 FINALIZING 直接推到 COMPLETED 而完全不扣转录分钟（白嫖）。
    const VALID_TRANSITIONS: Record<string, string[]> = {
      CREATED:    ['RECORDING'],
      RECORDING:  ['PAUSED', 'FINALIZING'],
      PAUSED:     ['RECORDING', 'FINALIZING'],
      FINALIZING: [],
      COMPLETED:  ['ARCHIVED'],
      ARCHIVED:   [],
    };
    // Allow idempotent (same-state) transitions
    if (nextStatus !== session.status) {
      const allowed = VALID_TRANSITIONS[session.status] || [];
      if (!allowed.includes(nextStatus)) {
        return NextResponse.json(
          { error: `Invalid status transition: ${session.status} → ${nextStatus}` },
          { status: 400 }
        );
      }
    }
  }

  let title: string | undefined;
  if (body.title !== undefined) {
    const normalizedTitle = normalizeOptionalString(body.title, 160);
    if (!normalizedTitle) {
      return NextResponse.json({ error: 'Invalid title' }, { status: 400 });
    }
    title = normalizedTitle;
  }

  let audioSource: string | undefined;
  if (body.audioSource !== undefined) {
    const normalizedAudioSource = normalizeSessionAudioSource(body.audioSource);
    if (!normalizedAudioSource) {
      return NextResponse.json(
        { error: 'Invalid audioSource' },
        { status: 400 }
      );
    }
    audioSource = normalizedAudioSource;
  }

  let sonioxRegion: string | undefined;
  if (body.sonioxRegion !== undefined) {
    const normalizedRegion = normalizeSessionRegion(body.sonioxRegion);
    if (!normalizedRegion) {
      return NextResponse.json(
        { error: 'Invalid sonioxRegion' },
        { status: 400 }
      );
    }
    sonioxRegion = normalizedRegion;
  }

  const durationMs =
    body.durationMs === undefined ? undefined : Number(body.durationMs);

  if (body.durationMs !== undefined) {
    if (
      durationMs === undefined ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    ) {
      return NextResponse.json(
        { error: 'Invalid durationMs' },
        { status: 400 }
      );
    }

    // C2：durationMs 是存储小时配额（SUM(durationMs)/3600000）的唯一依据，且只应由
    // finalize / audio 保存流写入。终态会话拒绝任何客户端 durationMs（否则用户可对
    // 已 COMPLETED 会话 PATCH durationMs:0 抹掉已消耗的存储配额、循环白嫖）；非终态也
    // 只允许不低于当前已记录值（不走 status 时同样挡，防绕过状态机降 duration）。
    if (session.status === 'COMPLETED' || session.status === 'ARCHIVED') {
      return NextResponse.json(
        { error: 'Cannot modify durationMs of a finalized session' },
        { status: 409 }
      );
    }

    if (durationMs < (session.durationMs ?? 0)) {
      return NextResponse.json(
        { error: 'durationMs cannot be lowered' },
        { status: 409 }
      );
    }
  }

  if (nextStatus === 'COMPLETED') {
    const [audioArtifact, transcriptBundle] = await Promise.all([
      loadSessionAudioArtifact(session),
      loadSessionTranscriptBundle(session),
    ]);

    if (!audioArtifact) {
      return NextResponse.json(
        { error: 'Cannot complete session before audio is saved' },
        { status: 409 }
      );
    }

    if (!transcriptBundle) {
      return NextResponse.json(
        { error: 'Cannot complete session before transcript is saved' },
        { status: 409 }
      );
    }
  }

  const updated = await prisma.session.update({
    where: { id: id },
    data: buildSessionUpdateData({
      session,
      nextStatus,
      durationMs,
      title,
      audioSource,
      sonioxRegion,
    }),
  });

  await invalidateSessionsApiCache(user.id);
  return NextResponse.json(updated);
}

export async function DELETE(
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

  // 删行前先取消进行中的异步上传转录：否则本地分片/合并/mp3（可达 ~5GB）+ Soniox 上的
  // 文件会随 session 行消失而失去关联、永久泄漏。cancelAsyncUpload 会清本地盘 + 删 Soniox
  // 文件 + 把状态置 canceled。终态语义对齐 async-upload DELETE：completed/failed/canceled/null
  // 视为已收尾、无需取消。
  if (
    session.asyncTranscribeStatus !== 'completed' &&
    session.asyncTranscribeStatus !== 'failed' &&
    session.asyncTranscribeStatus !== 'canceled' &&
    session.asyncTranscribeStatus != null
  ) {
    await cancelAsyncUpload(session).catch(() => undefined);
  }

  // B1：删会话前原子结算该会话遗留的异步上传预留。行一删，cron 兜底扫描便再也找不到这行
  // → 预留永久占着 transcriptionMinutesUsed 泄漏，故必须 inline 释放。用 settleAsyncReservation
  // （FOR UPDATE 读当前列并释放）而非按请求开头快照裸减：与并发 finalize 结算 / cron 兜底 互斥、
  // 恰好释放一次，杜绝审查发现的「快照双释放」（例如收尾已释放后本处按陈旧快照再退一次）。
  await settleAsyncReservation(session.id).catch(() => undefined);

  // 完整版补全转录进行中时删会话：与异步上传同理，Soniox 上的 file + transcription 会随行消失而
  // 永久泄漏（行一删便无 id→owner 关联，reclaim cron 也无从查起）。best-effort 清 Soniox 资源
  // （本地/Cloudreve 转录产物由下方 deleteSessionArtifacts 的 'full-transcripts' 分支清）。
  // 仅进行中态才可能持有未清的 Soniox 资源：finalize 成功会 null 掉这两个字段、失败/回收也会清；
  // 故用「任一字段非空」精确判定，避免对终态多余请求。
  if (session.fullSonioxFileId || session.fullSonioxTranscriptionId) {
    const sonioxConfig = await resolveSonioxRuntimeConfigAsync({}).catch(() => null);
    if (sonioxConfig) {
      if (session.fullSonioxFileId) {
        await deleteSonioxFile(sonioxConfig, session.fullSonioxFileId).catch(
          () => undefined
        );
      }
      if (session.fullSonioxTranscriptionId) {
        await deleteSonioxTranscription(
          sonioxConfig,
          session.fullSonioxTranscriptionId
        ).catch(() => undefined);
      }
    }
  }

  // U8：先把 legacy 单录音对话（Conversation.sessionId = 本 session）经
  // deleteConversationsCascade 删干净 —— 它会 best-effort 删 Cloudreve 附件物理文件
  // （原文件 + 抽取的 .txt）+ 本地内嵌图片 + 释放字节配额 + 删 DB 行。若只靠下面
  // session.delete 的 onDelete: Cascade 裸删 ChatAttachment 行，Cloudreve 物理文件会成
  // 永久孤儿（行一删连 cloudrevePath 都拿不到，cron 也无法回收）。
  // 注：全局多录音对话经 ConversationSession 联表挂载，删 session 只级联联表行、对话与
  // 附件保留，故这里只处理 sessionId 直挂的 legacy 对话。
  const legacyConversations = await prisma.conversation.findMany({
    where: { sessionId: id },
    select: { id: true },
  });
  if (legacyConversations.length > 0) {
    await deleteConversationsCascade(
      legacyConversations.map((c) => c.id)
    ).catch(() => undefined);
  }

  // U4：删行前 best-effort 物理删除会话全部产物（本地 data/ + Cloudreve 录音/转录/
  // 摘要/报告）+ 录音草稿分片目录。行一删便再无 path→owner 关联，无 cron 可回收，
  // 故必须在删行前清理。全部 best-effort，失败不阻塞 DB 删除。
  await deleteSessionArtifacts(session).catch(() => undefined);
  await deleteRecordingDraft(session).catch(() => undefined);

  // 先删除关联表记录（FolderSession / ShareLink），再删除 session
  await prisma.$transaction([
    prisma.folderSession.deleteMany({ where: { sessionId: id } }),
    prisma.shareLink.deleteMany({ where: { sessionId: id } }),
    prisma.session.delete({ where: { id: id } }),
  ]);

  await Promise.all([
    invalidateSessionsApiCache(user.id),
    invalidateFoldersApiCache(user.id),
    invalidateShareLinksApiCache(user.id),
  ]);
  return NextResponse.json({ success: true });
}

function buildSessionUpdateData(options: {
  session: {
    status: PrismaSessionStatus;
    serverStartedAt: Date | null;
    serverPausedAt: Date | null;
  };
  nextStatus?: PrismaSessionStatus;
  durationMs?: number;
  title?: string;
  audioSource?: string;
  sonioxRegion?: string;
}): Prisma.SessionUpdateInput {
  const now = new Date();
  const data: Prisma.SessionUpdateInput = {
    ...(options.title !== undefined && { title: options.title }),
    ...(options.nextStatus !== undefined && { status: options.nextStatus }),
    ...(options.durationMs !== undefined && { durationMs: options.durationMs }),
    ...(options.audioSource !== undefined && { audioSource: options.audioSource }),
    ...(options.sonioxRegion !== undefined && { sonioxRegion: options.sonioxRegion }),
  };

  const pausedAt =
    options.session.status === 'PAUSED' ? options.session.serverPausedAt : null;
  const sessionWasPaused = pausedAt !== null;
  const pendingPausedMs = sessionWasPaused
    ? Math.max(0, now.getTime() - pausedAt.getTime())
    : 0;

  if (options.nextStatus === 'RECORDING') {
    if (!options.session.serverStartedAt) {
      data.serverStartedAt = now;
      data.serverPausedMs = 0;
      data.serverPausedAt = null;
    } else if (sessionWasPaused) {
      data.serverPausedAt = null;
      if (pendingPausedMs > 0) {
        data.serverPausedMs = { increment: pendingPausedMs };
      }
    }
  }

  if (options.nextStatus === 'PAUSED') {
    data.serverPausedAt = options.session.serverPausedAt ?? now;
  }

  if (options.nextStatus === 'FINALIZING') {
    // 从 PAUSED 转入时，先把挂起的暂停时长并入 serverPausedMs
    if (sessionWasPaused && pendingPausedMs > 0) {
      data.serverPausedMs = { increment: pendingPausedMs };
    }
    // 用 serverPausedAt 记录"录音实际结束时间"，这样 resolveServerRecordingDurationMs
    // 的 pendingPausedMs 会把 FINALIZING 之后经过的时间从 duration 中扣除，
    // 避免 finalize 延迟（如请求失败后恢复）时 duration 被严重高估。
    data.serverPausedAt = now;
  }

  return data;
}
