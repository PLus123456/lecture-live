import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import {
  invalidateFoldersApiCache,
  invalidateSessionsApiCache,
  invalidateShareLinksApiCache,
} from '@/lib/apiResponseCache';
import {
  settleAsyncReservation,
  settleFullReservation,
} from '@/lib/quota';
import { JOB_STATUS, JOB_TYPE, trackJob } from '@/lib/jobQueue';
import { cancelAsyncUpload } from '@/lib/audio/asyncUploadProcessor';
import { deleteSessionArtifacts } from '@/lib/sessionPersistence';
import { deleteRecordingDraft } from '@/lib/recordingDraftPersistence';
import { deleteTranscriptDraft } from '@/lib/transcriptDraftPersistence';
import {
  completePreparedConversationCascade,
  deletePreparedConversationsInTransaction,
  prepareConversationsCascade,
} from '@/lib/conversationCascade';
import {
  findBillableStoredArtifactsByOwners,
  markStoredArtifactsDeletePendingInTransaction,
} from '@/lib/storage/storedArtifactLedger';
import {
  getSecurityAuditRequestId,
  writeSecurityAudit,
} from '@/lib/securityAudit';

type StatusFilter = '' | 'has-recording' | 'no-recording' | 'completed' | 'archived' | 'recording';

class RequiredSecurityAuditError extends Error {
  constructor(readonly auditCause: unknown) {
    super('required security audit write failed', { cause: auditCause });
    this.name = 'RequiredSecurityAuditError';
  }
}

/**
 * 管理员：列出全站录音/会话文件（分页 + 过滤 + 搜索）
 *
 * 每条记录暴露：
 * - sessionId / 录音标题 / 状态 / 时长
 * - 拥有者（id / email / displayName）
 * - 存储位置（recordingPath / transcriptPath / summaryPath / reportPath）
 * - 是否存在录音、是否可回放
 */
export async function GET(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:files:list',
    limit: 60,
  });
  if (response) return response;
  if (!admin) {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
  }
  const auditRequestId = getSecurityAuditRequestId(req);

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10)),
  );
  const keyword = (searchParams.get('keyword') || '').trim();
  const statusFilter = (searchParams.get('status') || '') as StatusFilter;
  const userIdFilter = searchParams.get('userId') || '';

  try {
    const where: Prisma.SessionWhereInput = {};

    if (statusFilter === 'has-recording') {
      where.recordingPath = { not: null };
    } else if (statusFilter === 'no-recording') {
      where.recordingPath = null;
    } else if (statusFilter === 'completed') {
      where.status = 'COMPLETED';
    } else if (statusFilter === 'archived') {
      where.status = 'ARCHIVED';
    } else if (statusFilter === 'recording') {
      where.status = 'RECORDING';
    }

    if (userIdFilter) {
      where.userId = userIdFilter;
    }

    if (keyword) {
      where.OR = [
        { title: { contains: keyword } },
        { titleEn: { contains: keyword } },
        { courseName: { contains: keyword } },
        { user: { email: { contains: keyword } } },
        { user: { displayName: { contains: keyword } } },
        { id: { contains: keyword } },
      ];
    }

    const [sessions, total] = await Promise.all([
      prisma.session.findMany({
        where,
        select: {
          id: true,
          title: true,
          titleEn: true,
          courseName: true,
          createdAt: true,
          updatedAt: true,
          durationMs: true,
          status: true,
          recordingPath: true,
          transcriptPath: true,
          summaryPath: true,
          reportPath: true,
          sourceLang: true,
          targetLang: true,
          audioSource: true,
          user: {
            select: {
              id: true,
              email: true,
              displayName: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.session.count({ where }),
    ]);

    const payload = sessions.map((s) => ({
      id: s.id,
      title: s.title,
      titleEn: s.titleEn,
      courseName: s.courseName,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      durationMs: s.durationMs,
      status: s.status,
      audioSource: s.audioSource,
      sourceLang: s.sourceLang,
      targetLang: s.targetLang,
      recordingPath: s.recordingPath,
      transcriptPath: s.transcriptPath,
      summaryPath: s.summaryPath,
      reportPath: s.reportPath,
      hasRecording: Boolean(s.recordingPath),
      canPlayback: s.status === 'COMPLETED' || s.status === 'ARCHIVED',
      playbackPath:
        s.status === 'COMPLETED' || s.status === 'ARCHIVED'
          ? `/session/${s.id}/playback`
          : `/session/${s.id}`,
      owner: s.user,
    }));

    // SEC-033：文件列表包含物理存储引用，响应只能在安全审计成功
    // 持久化后返回。审计只记录分页/过滤摘要，不复制任何存储路径。
    try {
      await writeSecurityAudit(req, {
        event: 'files.read',
        operator: {
          id: admin.id,
          email: admin.email,
          role: admin.role,
        },
        target: {
          type: 'session_file_collection',
          id: 'all',
        },
        reason: 'admin_list',
        outcome: 'SUCCESS',
        metadata: {
          filters: {
            keywordApplied: keyword.length > 0,
            status: statusFilter || null,
            userIdApplied: userIdFilter.length > 0,
          },
          page,
          pageSize,
          count: payload.length,
          total,
        },
        requestId: auditRequestId,
      });
    } catch (auditErr) {
      console.error('文件列表读取审计写入失败:', auditErr);
      return NextResponse.json({ error: '审计服务不可用' }, { status: 503 });
    }

    return NextResponse.json({
      files: payload,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize) || 1,
      },
    });
  } catch (err) {
    console.error('查询文件列表失败:', err);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}

/**
 * 管理员：删除录音/会话（单个或批量）
 * 删除数据库中的 Session 记录 + 关联表（FolderSession / ShareLink）。
 *
 * L4：删行前**物理删除**会话产物（本地 data/ + Cloudreve 录音/转录/摘要/报告/完整版转录）
 * 与录音草稿分片目录，与用户侧 DELETE 口径一致。旧注释「不会主动删除 Cloudreve 远程文件」是
 * 用户侧修好前的旧结论——行一删便再无 path→owner 关联，没有任何 cron 能回收这些文件。
 *
 * P5-8：在途预留结算失败则**跳过该会话不删**（预留是 Session 行上的列，行一删就没有载体）。
 */
export async function DELETE(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:files:delete',
    limit: 30,
    windowMs: 60_000,
  });
  if (response) return response;
  if (!admin) {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  const auditRequestId = getSecurityAuditRequestId(req);
  let requestedIds: string[] = [];
  let safeTargets: Array<{
    id: string;
    ownerId: string;
    asyncTranscribeStatus: string | null;
  }> = [];
  let sideEffectStarted = false;
  let deletedCount = 0;
  let skippedIds: string[] = [];
  let failureStage = 'load_targets';
  let trackedTerminalAuditWritten = false;
  const cleanupFailures = {
    asyncCancel: 0,
    artifacts: 0,
    recordingDrafts: 0,
    transcriptDrafts: 0,
    storageRelease: 0,
  };

  const writeDeleteAudit = async (
    outcome: 'ATTEMPTED' | 'SUCCESS' | 'FAILED' | 'PARTIAL',
    after?: Record<string, unknown>,
    metadata?: Record<string, unknown>,
    db?: Pick<Prisma.TransactionClient, 'auditLog'>,
  ) => {
    const event = {
      event: 'files.delete',
      operator: {
        id: admin.id,
        email: admin.email,
        role: admin.role,
      },
      target: {
        type: 'session_file',
        // 原始 ids 是用户输入，可被填入物理路径；审计只保留 DB 已确认 ID。
        ids: safeTargets.map((target) => target.id),
        ownerId:
          new Set(safeTargets.map((target) => target.ownerId)).size === 1
            ? safeTargets[0]?.ownerId
            : undefined,
      },
      before: {
        count: safeTargets.length,
        items: safeTargets,
      },
      ...(after ? { after } : {}),
      reason: 'admin_delete',
      outcome,
      metadata: {
        requestedCount: requestedIds.length,
        matchedCount: safeTargets.length,
        ...metadata,
      },
      requestId: auditRequestId,
    } as const;
    try {
      return db
        ? await writeSecurityAudit(req, event, db)
        : await writeSecurityAudit(req, event);
    } catch (auditCause) {
      if (db) throw new RequiredSecurityAuditError(auditCause);
      throw auditCause;
    }
  };

  try {
    const body = await req.json().catch(() => ({}));
    const rawIds: unknown[] = Array.isArray(body.ids) ? body.ids : [];
    requestedIds = [
      ...new Set(
        rawIds.filter((x: unknown): x is string => typeof x === 'string'),
      ),
    ];

    if (requestedIds.length === 0) {
      return NextResponse.json({ error: '请提供要删除的会话 ID' }, { status: 400 });
    }

    const targets = await prisma.session.findMany({
      where: { id: { in: requestedIds } },
      select: {
        id: true,
        userId: true,
        title: true,
        asyncTranscribeStatus: true,
        sonioxFileId: true,
        // P1-16：补齐 region + transcriptionId，cancelAsyncUpload 才能按任务固定 region 解析配置、
        // 且先删 transcription 再删 file。缺 sonioxRegion 会落回可变默认 region → 跨 region 任务向错误
        // 区 API 删不存在的资源、真资源永久孤儿；缺 sonioxTranscriptionId 则整段跳过删 transcription。
        // 与用户侧 sessions/[id] DELETE 的区域感知 + transcription-before-file 清理口径对齐。
        sonioxRegion: true,
        sonioxTranscriptionId: true,
        // L4：物理删产物需要各引用列（deleteSessionArtifacts 按引用逐个删本地/Cloudreve 对象）。
        recordingPath: true,
        enhancedAudioPath: true,
        transcriptPath: true,
        summaryPath: true,
        reportPath: true,
        fullTranscriptPath: true,
      },
    });

    // 物理路径只留在业务 targets 中供清理使用，不得进入审计快照。
    safeTargets = targets.map((target) => ({
      id: target.id,
      ownerId: target.userId,
      asyncTranscribeStatus: target.asyncTranscribeStatus ?? null,
    }));

    // 外部 Soniox/物理文件/配额与 DB 删除都是不可原子回滚的多阶段副作用；
    // 任一副作用启动前必须有耐久 ATTEMPTED 记录。
    try {
      await writeDeleteAudit('ATTEMPTED');
    } catch (auditErr) {
      console.error('文件删除尝试审计写入失败:', auditErr);
      return NextResponse.json({ error: '审计服务不可用' }, { status: 503 });
    }

    if (targets.length === 0) {
      try {
        await writeDeleteAudit(
          'FAILED',
          { deleted: 0, missing: requestedIds.length },
          { stage: 'target_not_found' },
        );
      } catch (auditErr) {
        console.error('文件删除结果审计写入失败:', auditErr);
        return NextResponse.json({ error: '审计服务不可用' }, { status: 503 });
      }
      return NextResponse.json({ error: '未找到目标会话' }, { status: 404 });
    }

    type FileDeleteResult = {
      kind: 'completed' | 'no_deletable_targets';
      deleted: number;
      skipped: number;
      missing: number;
      databaseRaceMissing: number;
      cleanupFailures: typeof cleanupFailures;
    };

    const result = await trackJob<FileDeleteResult>(
      {
        type: JOB_TYPE.ADMIN_MUTATION,
        userId: admin.id,
        triggeredBy: `admin:${admin.id}`,
        params: {
          operation: 'admin_files_delete',
          requestedCount: requestedIds.length,
          requestId: auditRequestId,
        },
        resultSummary: (value) => ({
          kind: value.kind,
          deleted: value.deleted,
          skipped: value.skipped,
          missing: value.missing,
          databaseRaceMissing: value.databaseRaceMissing,
          cleanupFailureCount: Object.values(value.cleanupFailures).reduce(
            (sum, count) => sum + count,
            0,
          ),
        }),
        errorSummary: (error) =>
          error instanceof RequiredSecurityAuditError
            ? 'RequiredSecurityAuditError'
            : error instanceof Error
              ? error.name
              : 'AdminFilesDeleteError',
        terminalMutation: async (tx, terminal) => {
          if (terminal.status === JOB_STATUS.SUCCESS) {
            const completed = terminal.result;
            const hasCleanupFailure = Object.values(
              completed.cleanupFailures,
            ).some((count) => count > 0);
            const outcome =
              completed.kind === 'no_deletable_targets' ||
              completed.skipped > 0 ||
              completed.missing > 0 ||
              completed.databaseRaceMissing > 0 ||
              hasCleanupFailure
                ? 'PARTIAL'
                : 'SUCCESS';
            await writeDeleteAudit(
              outcome,
              {
                deleted: completed.deleted,
                skipped: completed.skipped,
                missing: completed.missing,
                databaseRaceMissing: completed.databaseRaceMissing,
                cleanupFailures: completed.cleanupFailures,
              },
              {
                stage:
                  completed.kind === 'no_deletable_targets'
                    ? 'settle_reservations'
                    : 'completed',
                journaled: true,
              },
              tx,
            );
          } else {
            await writeDeleteAudit(
              sideEffectStarted ? 'PARTIAL' : 'FAILED',
              {
                deleted: deletedCount,
                skipped: skippedIds.length,
                cleanupFailures,
              },
              {
                stage: failureStage,
                journaled: true,
                errorClass:
                  terminal.error instanceof Error
                    ? terminal.error.name
                    : 'UnknownError',
              },
              tx,
            );
          }
          trackedTerminalAuditWritten = true;
        },
      },
      async () => {
        // 每个会话的两类在途预留与该阶段审计同一事务提交。结算
        // 失败时整个会话的释放回滚，保留 Session 供管理员幂等重试。
        const deletableIds: string[] = [];
        skippedIds = [];
        for (const session of targets) {
          try {
            sideEffectStarted = true;
            failureStage = 'settle_reservations';
            await prisma.$transaction(async (tx) => {
              await settleAsyncReservation(session.id, tx);
              await settleFullReservation(session.id, tx);
              await writeDeleteAudit(
                'SUCCESS',
                { settledReservations: 1 },
                {
                  stage: 'settle_reservations',
                  phase: 'database',
                  sessionId: session.id,
                },
                tx,
              );
            });
            deletableIds.push(session.id);
          } catch (settleErr) {
            console.error(
              '结算在途预留失败，跳过删除该会话:',
              session.id,
              settleErr,
            );
            skippedIds.push(session.id);
          }
        }

        const missing = Math.max(0, requestedIds.length - targets.length);
        if (deletableIds.length === 0) {
          return {
            kind: 'no_deletable_targets',
            deleted: 0,
            skipped: skippedIds.length,
            missing,
            databaseRaceMissing: 0,
            cleanupFailures,
          };
        }

        const deletable = targets.filter((target) =>
          deletableIds.includes(target.id),
        );
        const legacyConversations = await prisma.conversation.findMany({
          where: { sessionId: { in: deletableIds } },
          select: { id: true },
        });
        const preparedLegacyConversations = await prepareConversationsCascade(
          legacyConversations.map((conversation) => conversation.id),
        );
        const sessionLedgerRows = await findBillableStoredArtifactsByOwners(
          'session',
          deletableIds,
        );

        failureStage = 'delete_database';
        deletedCount = await prisma.$transaction(async (tx) => {
          await markStoredArtifactsDeletePendingInTransaction(
            tx,
            sessionLedgerRows.map((row) => row.id),
          );
          await deletePreparedConversationsInTransaction(
            tx,
            preparedLegacyConversations,
          );
          await tx.folderSession.deleteMany({
            where: { sessionId: { in: deletableIds } },
          });
          await tx.shareLink.deleteMany({
            where: { sessionId: { in: deletableIds } },
          });
          const deleted = await tx.session.deleteMany({
            where: { id: { in: deletableIds } },
          });
          await writeDeleteAudit(
            'SUCCESS',
            { deleted: deleted.count },
            { stage: 'delete_database', phase: 'database' },
            tx,
          );
          return deleted.count;
        });

        failureStage = 'complete_conversation_cleanup';
        if (
          !(await completePreparedConversationCascade(
            preparedLegacyConversations,
          ))
        ) {
          cleanupFailures.artifacts += 1;
        }

        for (const session of deletable) {
          if (
            session.asyncTranscribeStatus !== 'completed' &&
            session.asyncTranscribeStatus !== 'failed' &&
            session.asyncTranscribeStatus !== 'canceled' &&
            session.asyncTranscribeStatus != null
          ) {
            failureStage = 'cancel_async_upload';
            try {
              await cancelAsyncUpload(session);
            } catch {
              cleanupFailures.asyncCancel += 1;
            }
          }
          failureStage = 'delete_artifacts';
          const rows = sessionLedgerRows.filter(
            (row) => row.ownerId === session.id,
          );
          try {
            await deleteSessionArtifacts(session, rows);
          } catch {
            cleanupFailures.artifacts += 1;
          }
          try {
            await deleteRecordingDraft(session);
          } catch {
            cleanupFailures.recordingDrafts += 1;
          }
          try {
            await deleteTranscriptDraft(session);
          } catch {
            cleanupFailures.transcriptDrafts += 1;
          }
        }

        failureStage = 'invalidate_cache';
        const ownerIds = [...new Set(deletable.map((target) => target.userId))];
        await Promise.all(
          ownerIds.flatMap((id) => [
            invalidateSessionsApiCache(id),
            invalidateFoldersApiCache(id),
            invalidateShareLinksApiCache(id),
          ]),
        );

        return {
          kind: 'completed',
          deleted: deletedCount,
          skipped: skippedIds.length,
          missing,
          databaseRaceMissing: Math.max(
            0,
            deletableIds.length - deletedCount,
          ),
          cleanupFailures,
        };
      },
    );

    if (result.kind === 'no_deletable_targets') {
      return NextResponse.json(
        {
          error: '结算在途转录预留失败，未删除任何会话',
          skipped: result.skipped,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      deleted: result.deleted,
      ...(result.skipped > 0 ? { skipped: result.skipped } : {}),
    });
  } catch (err) {
    console.error('删除会话失败:', err);
    const containsRequiredAuditFailure = (value: unknown): boolean => {
      if (value instanceof RequiredSecurityAuditError) return true;
      if (value instanceof AggregateError) {
        return value.errors.some(containsRequiredAuditFailure);
      }
      return (
        value instanceof Error &&
        value.cause !== undefined &&
        containsRequiredAuditFailure(value.cause)
      );
    };
    const requiredAuditUnavailable = containsRequiredAuditFailure(err);
    if (requestedIds.length > 0 && !trackedTerminalAuditWritten) {
      try {
        await writeDeleteAudit(
          sideEffectStarted ? 'PARTIAL' : 'FAILED',
          {
            deleted: deletedCount,
            skipped: skippedIds.length,
            cleanupFailures,
          },
          {
            stage: failureStage,
            journalState: sideEffectStarted ? 'unknown' : 'not_started',
          },
        );
      } catch (auditErr) {
        console.error('文件删除失败审计写入失败:', auditErr);
        return NextResponse.json({ error: '审计服务不可用' }, { status: 503 });
      }
    }
    if (requiredAuditUnavailable) {
      return NextResponse.json({ error: '审计服务不可用' }, { status: 503 });
    }
    return NextResponse.json({ error: '删除失败' }, { status: 500 });
  }
}
