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
import { enforceRateLimit } from '@/lib/rateLimit';
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
import { deleteTranscriptDraft } from '@/lib/transcriptDraftPersistence';
import {
  completePreparedConversationCascade,
  deletePreparedConversationsInTransaction,
  prepareConversationsCascade,
} from '@/lib/conversationCascade';
import { settleAsyncReservation, settleFullReservation } from '@/lib/quota';
import { resolveUserMaxConcurrentSessions } from '@/lib/userRoles';
import { cancelAsyncUpload } from '@/lib/audio/asyncUploadProcessor';
import { resolveSonioxConfigForSessionRegion } from '@/lib/soniox/env';
import {
  deleteSonioxFile,
  deleteSonioxTranscription,
} from '@/lib/soniox/asyncFile';
import {
  findBillableStoredArtifactsByOwner,
  markStoredArtifactsDeletePendingInTransaction,
} from '@/lib/storage/storedArtifactLedger';

// B4：单用户并发在途录音（RECORDING/PAUSED）上限。实时录音事后扣费，无法在入口精确预留，
// 用并发上限把「多标签并发开录叠加超额」的溢出封在 N×角色上限内（留足余量容忍崩溃残留的僵尸会话，
// 4h 后由 reclaim cron 清）。彻底的按用量实时计费另见 /soniox/temporary-key 计量任务。
//
// 上限值由用户组配置解析（resolveUserMaxConcurrentSessions）：admin 在「用户组」面板配的
// 「最大并发会话数」在此真正生效——此前是写死的 3，组配置形同虚设。

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

  // P5-15 附带：本路由此前全文无限流。PATCH 是纯事件驱动（开始/暂停/继续/收尾/改名/换区），
  // 一场录音个位数次；宽松上限只挡脚本对状态机与并发闸的高频冲击，正常录制碰不到。
  const rateLimited = await enforceRateLimit(req, {
    scope: 'sessions:patch',
    limit: 120,
    windowMs: 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) return rateLimited;

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

  // B4/P5-15：仅「新开录音」(CREATED→RECORDING) 需要并发闸；非 null 即表示要在写库事务内计数。
  let concurrencyLimit: number | null = null;

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

    // B4：限制单用户并发在途录音数。实时录音是事后扣费（finalize 才 deduct，clamp 至角色上限），
    // 入口 checkQuota 只非原子判 used<limit，故并发开多个录音（多标签/脚本）会各自通过准入、各自
    // 录满后叠加扣费，used 静默大幅超 limit（审计 C6/B4）。这里对「新开录音」(CREATED→RECORDING)
    // 计并发在途数（RECORDING/PAUSED），超上限即拒，把并发溢出封在 N×角色上限内。恢复暂停
    // (PAUSED→RECORDING) 不新增在途、不受此限。彻底的按用量实时计费见 /soniox/temporary-key 计量任务。
    if (nextStatus === 'RECORDING' && session.status === 'CREATED') {
      // 按用户组解析并发上限（ADMIN 恒 999，视为不限）。customGroupId 不在 JWT payload 里，
      // 单独取一次；这是「开新录音」的低频路径，一次轻量 select 可接受。
      // 上限解析放在事务外：只读、且不参与并发判定的原子性（真正的闸在下方锁内计数）。
      const owner = await prisma.user.findUnique({
        where: { id: user.id },
        select: { customGroupId: true },
      });
      concurrencyLimit = await resolveUserMaxConcurrentSessions({
        role: user.role,
        customGroupId: owner?.customGroupId ?? null,
      });
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

  // C2 / session-persist#151：durationMs 是存储小时配额（SUM(durationMs)/3600000）与完整版
  // 转录计价（ceil(getBillableMinutes(durationMs)×倍率)）的唯一依据，且**只应由服务端收尾路径**
  // 写入（finalize / audio 直传 / 草稿定稿）。
  //
  // 旧实现只有两道守卫：终态拒改、已有值不可下调。它们堵住了「事后抹掉已消耗额度」，却对
  // **首次写入一个极小正值**毫无限制 —— 新建会话 PATCH {durationMs: 1}（1 ≥ 当前 0、非终态，
  // 两道守卫都放行）即可让 /audio 的 ffprobe 兜底条件 `durationMs <= 0` 永远为假、被整条跳过，
  // 随后直传数小时的低码率录音仍以 1ms 落库：对 storage_hours 几乎零贡献，且 /full-transcribe
  // 的预留与实扣都只算 1 分钟 —— 1 分钟额度换数小时 Soniox 转录。
  //
  // 仓库内没有任何客户端向本端点提交过 durationMs（录音收尾走 POST /finalize 的 body.durationMs，
  // 那条路径有 clamp + grantActualMs 实测下限兜底），因此这里直接整体拒收，而不是再叠一层上界
  // 校验 —— 少一个可被诱导写脏的入口，胜过多一条规则。
  if (body.durationMs !== undefined) {
    return NextResponse.json(
      {
        error:
          'durationMs is server-managed and cannot be set via PATCH; it is written by the finalize/audio-save paths',
      },
      { status: 400 }
    );
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

  // P0-6 契约4：状态迁移用「期望旧 status」做 CAS（updateMany 判 count），杜绝旧代码裸
  // update({where:{id}}) 把终态回退 —— 如 PAUSE/RESUME 请求读到 RECORDING 后 finalize 先完成，
  // 该请求仍把 COMPLETED 覆盖回 PAUSED/RECORDING。0 行更新 → 会话已被并发改动 → 409 + 最新状态。
  const updateData = buildSessionUpdateData({
    session,
    nextStatus,
    title,
    audioSource,
    sonioxRegion,
  });

  // P5-15：并发上限旧实现是 check-then-act —— 先 count 再另一条语句写库，两条之间毫无串行化，
  // N 个标签页同时 CREATED→RECORDING 都读到「未达上限」后各自写成功，上限形同虚设（B4 想封住的
  // 并发扣费溢出照样发生）。现在把计数与状态迁移放进**同一事务**，且计数用 `SELECT ... FOR UPDATE`：
  // 走 @@index([userId]) 扫该用户的会话行并持有行锁到提交，同一用户的并发「开新录音」被真正串行化
  // （后到者阻塞→读到前者已提交的 RECORDING→超限即拒）。裸 count 即使包进事务也无用：非锁定读走
  // MVCC 快照，两个事务互相看不见对方。
  // 锁序 Session → （无 User 写），与 async-upload init / finalize 的 Session→User 同向，不成环。
  // const 快照：闭包内要用到收窄后的类型（let 的收窄在回调里会失效）。
  const gateLimit = concurrencyLimit;
  const casResult =
    gateLimit === null
      ? await prisma.session.updateMany({
          where: { id: id, status: session.status },
          data: updateData,
        })
      : await prisma.$transaction(async (tx) => {
          const inflight = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM Session
            WHERE userId = ${user.id} AND status IN ('RECORDING', 'PAUSED')
            FOR UPDATE
          `;
          // -1 是「并发超限」的哨兵（updateMany 的 count 恒 >=0），避免为一条分支多开一层类型。
          if (inflight.length >= gateLimit) {
            return { count: -1 };
          }
          return tx.session.updateMany({
            where: { id: id, status: session.status },
            data: updateData,
          });
        });

  if (casResult.count === -1) {
    return NextResponse.json(
      {
        error: `Too many concurrent recordings in progress (max ${gateLimit}). Finish or discard an existing recording first.`,
      },
      { status: 409 }
    );
  }

  if (casResult.count === 0) {
    const latest = await prisma.session.findUnique({ where: { id: id } });
    return NextResponse.json(
      {
        error: 'Session was modified concurrently',
        currentStatus: latest?.status ?? null,
      },
      { status: 409 }
    );
  }

  const updated = await prisma.session.findUnique({ where: { id: id } });
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

  // B1/R4：删会话前原子结算该会话遗留的在途预留（异步上传 asyncReservedMinutes + 完整版补全
  // fullReservedMinutes）。行一删，cron 兜底扫描便再也找不到这行 → 预留永久占着
  // transcriptionMinutesUsed 泄漏，故必须 inline 释放。用 settle*（FOR UPDATE 读当前列并释放）而非
  // 按请求开头快照裸减：与并发 finalize 结算 / cron 兜底互斥、恰好释放一次，杜绝「快照双释放」。
  //
  // P5-8：结算失败**必须拒绝删除**，绝不能像旧实现那样 .catch(()=>undefined) 吞掉后照常删行——
  // 预留是 Session 行上的**列**，行一删就没有载体，兜底 cron 只扫存活行、永远扫不到；持池用户更糟：
  // computePoolOwed 的 used 含这笔孤儿预留，而在途聚合已找不到被删的 Session → owed 抬高、多扣池子
  // 且不可自愈。这里改为直接 500 拒删（settle 幂等，用户重试即可）。
  try {
    await settleAsyncReservation(session.id);
    await settleFullReservation(session.id);
  } catch (settleErr) {
    console.error('Settle transcription reservations failed; session not deleted:', settleErr);
    return NextResponse.json(
      { error: 'Failed to settle pending transcription reservations; session was not deleted' },
      { status: 500 }
    );
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
  const preparedLegacyConversations = await prepareConversationsCascade(
    legacyConversations.map((conversation) => conversation.id)
  );

  const sessionLedgerRows = await findBillableStoredArtifactsByOwner(
    'session',
    session.id
  );
  // Owner 删除与 ledger DELETE_PENDING 在同一事务。提交后才碰物理对象；
  // 如果进程在两者之间崩溃，统一 artifact cleanup 仍持有 reference 可重试。
  await prisma.$transaction(async (tx) => {
    await markStoredArtifactsDeletePendingInTransaction(
      tx,
      sessionLedgerRows.map((row) => row.id)
    );
    await deletePreparedConversationsInTransaction(
      tx,
      preparedLegacyConversations
    );
    await tx.folderSession.deleteMany({ where: { sessionId: id } });
    await tx.shareLink.deleteMany({ where: { sessionId: id } });
    await tx.session.delete({ where: { id } });
  });

  await completePreparedConversationCascade(preparedLegacyConversations).catch(
    () => false
  );
  await deleteSessionArtifacts(session, sessionLedgerRows).catch(() => undefined);
  await deleteRecordingDraft(session).catch(() => undefined);
  await deleteTranscriptDraft(session).catch(() => undefined);

  if (
    session.asyncTranscribeStatus !== 'completed' &&
    session.asyncTranscribeStatus !== 'failed' &&
    session.asyncTranscribeStatus !== 'canceled' &&
    session.asyncTranscribeStatus != null
  ) {
    await cancelAsyncUpload(session).catch(() => undefined);
  }

  if (session.fullSonioxFileId || session.fullSonioxTranscriptionId) {
    const sonioxConfig = await resolveSonioxConfigForSessionRegion(
      session.sonioxRegion
    ).catch(() => null);
    if (sonioxConfig) {
      if (session.fullSonioxTranscriptionId) {
        await deleteSonioxTranscription(
          sonioxConfig,
          session.fullSonioxTranscriptionId
        ).catch(() => undefined);
      }
      if (session.fullSonioxFileId) {
        await deleteSonioxFile(sonioxConfig, session.fullSonioxFileId).catch(
          () => undefined
        );
      }
    }
  }

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
  title?: string;
  audioSource?: string;
  sonioxRegion?: string;
}): Prisma.SessionUpdateInput {
  const now = new Date();
  const data: Prisma.SessionUpdateInput = {
    // 手动改名 → 标题不再是自动占位（清标记，收尾后台不会再覆盖用户起的名字）
    ...(options.title !== undefined && {
      title: options.title,
      titleAutoGenerated: false,
    }),
    ...(options.nextStatus !== undefined && { status: options.nextStatus }),
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
