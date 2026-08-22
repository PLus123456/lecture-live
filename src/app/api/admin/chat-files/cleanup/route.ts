import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import {
  validateChatFileCleanupParams,
  performChatFileCleanup,
} from '@/lib/chatFileCleanup';
import { JOB_STATUS, JOB_TYPE, trackJob } from '@/lib/jobQueue';
import {
  getSecurityAuditRequestId,
  writeSecurityAudit,
} from '@/lib/securityAudit';

function operatorFromAdmin(admin: {
  id: string;
  email?: string | null;
  role?: string | null;
}) {
  return {
    id: admin.id,
    email: admin.email ?? null,
    role: admin.role ?? null,
  };
}

/** POST /api/admin/chat-files/cleanup — JSON-body form of the durable cleanup. */
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:chat-files:cleanup',
    limit: 10,
    windowMs: 60_000,
  });
  if (response) return response;
  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  const validation = validateChatFileCleanupParams({
    olderThanDays: Number(raw.olderThanDays),
    sizeBytesGT:
      raw.sizeBytesGT === undefined ? undefined : Number(raw.sizeBytesGT),
    userId: typeof raw.userId === 'string' ? raw.userId : undefined,
    kinds: Array.isArray(raw.kinds) ? (raw.kinds as string[]) : undefined,
    conversationId:
      typeof raw.conversationId === 'string' ? raw.conversationId : undefined,
  });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const requestId = getSecurityAuditRequestId(req);
  const filters = {
    olderThanDays: validation.olderThanDays,
    sizeBytesGT: validation.sizeBytesGT,
    userId: validation.userId ?? null,
    kinds: validation.kinds,
    conversationId: validation.conversationId ?? null,
  };

  try {
    const result = await trackJob(
      {
        type: JOB_TYPE.CHAT_FILES_CLEANUP,
        userId: admin.id,
        triggeredBy: `admin:${admin.id}`,
        params: { operation: 'admin_chat_files_cleanup', filters, requestId },
        resultSummary: (value) => ({
          deleted: value.deleted,
          releasedBytes: value.releasedBytes,
          truncated: value.truncated,
          physicalDeleteComplete: value.physicalDeleteComplete,
          pendingArtifactCount: value.pendingArtifactCount,
        }),
        errorSummary: () => 'ChatFileCleanupError',
        terminalMutation: async (tx, terminal) => {
          if (terminal.status === JOB_STATUS.SUCCESS) {
            const completed = terminal.result;
            await writeSecurityAudit(
              req,
              {
                event: 'chat_files.cleanup',
                operator: operatorFromAdmin(admin),
                target: { type: 'chat_attachment_collection' },
                before: { filters },
                after: {
                  deletedCount: completed.deleted,
                  releasedBytes: completed.releasedBytes,
                  truncated: completed.truncated,
                  pendingArtifactCount: completed.pendingArtifactCount,
                },
                reason: 'admin_cleanup',
                outcome: 'SUCCESS',
                requestId,
              },
              tx
            );
            return;
          }
          await writeSecurityAudit(
            req,
            {
              event: 'chat_files.cleanup',
              operator: operatorFromAdmin(admin),
              target: { type: 'chat_attachment_collection' },
              before: { filters },
              after: { completed: false },
              reason: 'admin_cleanup',
              outcome: 'PARTIAL',
              metadata: {
                errorClass:
                  terminal.error instanceof Error
                    ? terminal.error.name
                    : 'UnknownError',
              },
              requestId,
            },
            tx
          );
        },
      },
      async () => {
        try {
          const cleanupResult = await performChatFileCleanup(
            {
              olderThanDays: validation.olderThanDays,
              sizeBytesGT: validation.sizeBytesGT,
              userId: validation.userId,
              kinds: validation.kinds,
              conversationId: validation.conversationId,
            },
            {
              onDatabaseMutation: async (tx, summary) => {
                await writeSecurityAudit(
                  req,
                  {
                    event: 'chat_files.cleanup_database',
                    operator: operatorFromAdmin(admin),
                    target: { type: 'chat_attachment_collection' },
                    before: { filters, candidateCount: summary.candidateCount },
                    after: {
                      deletedCount: summary.deleted,
                      releasedBytes: summary.releasedBytes,
                      queuedArtifactCount: summary.queuedArtifactCount,
                    },
                    reason: 'admin_cleanup',
                    outcome: 'SUCCESS',
                    requestId,
                  },
                  tx
                );
              },
              onArtifactReleaseMutation: async (tx, summary) => {
                await writeSecurityAudit(
                  req,
                  {
                    event: 'chat_files.cleanup_artifacts',
                    operator: operatorFromAdmin(admin),
                    target: { type: 'stored_artifact_collection' },
                    before: { artifactCount: summary.artifactCount },
                    after: {
                      releasedArtifactCount: summary.releasedArtifactCount,
                      releasedBytes: summary.releasedBytes,
                    },
                    reason: 'admin_cleanup_remote_delete_confirmed',
                    outcome:
                      summary.releasedArtifactCount === summary.artifactCount
                        ? 'SUCCESS'
                        : 'PARTIAL',
                    requestId,
                  },
                  tx
                );
              },
            }
          );
          if (!cleanupResult.physicalDeleteComplete) {
            throw new Error('chat file physical cleanup incomplete');
          }
          return cleanupResult;
        } catch {
          // Persist only a bounded safe class in JobQueue.error.
          throw new Error('chat file cleanup operation failed');
        }
      }
    );

    return NextResponse.json({
      success: true,
      deleted: result.deleted,
      deletedCount: result.deleted,
      releasedBytes: result.releasedBytes,
      truncated: result.truncated,
    });
  } catch (err) {
    console.error('chat-files cleanup (POST) failed:', err);
    return NextResponse.json({ error: '清理失败' }, { status: 500 });
  }
}
