import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { performChatFileDelete } from '@/lib/chatFileCleanup';
import { JOB_STATUS, JOB_TYPE, trackJob } from '@/lib/jobQueue';
import {
  getSecurityAuditRequestId,
  writeSecurityAudit,
} from '@/lib/securityAudit';

/** DELETE /api/admin/chat-files/[id] — durable single-item deletion. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:chat-files:delete',
    limit: 30,
    windowMs: 60_000,
  });
  if (response) return response;
  if (!admin) return NextResponse.json({ error: '权限不足' }, { status: 403 });

  const { id } = await params;
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: '缺少附件 ID' }, { status: 400 });
  }

  const requestId = getSecurityAuditRequestId(req);
  try {
    const result = await trackJob(
      {
        type: JOB_TYPE.CHAT_FILES_CLEANUP,
        userId: admin.id,
        triggeredBy: `admin:${admin.id}`,
        params: {
          operation: 'admin_chat_file_delete',
          attachmentId: id,
          requestId,
        },
        resultSummary: (value) => ({
          found: value.found,
          deleted: value.deleted,
          releasedBytes: value.releasedBytes,
          physicalDeleteComplete: value.physicalDeleteComplete,
          pendingArtifactCount: value.pendingArtifactCount,
        }),
        errorSummary: () => 'ChatFileDeleteError',
        terminalMutation: async (tx, terminal) => {
          if (terminal.status === JOB_STATUS.SUCCESS) {
            const completed = terminal.result;
            const deleted = completed.found && completed.deleted > 0;
            await writeSecurityAudit(
              req,
              {
                event: 'chat_files.delete',
                operator: {
                  id: admin.id,
                  email: admin.email,
                  role: admin.role,
                },
                target: {
                  type: 'chat_attachment',
                  id,
                  ownerId: completed.ownerId,
                },
                before: { found: completed.found },
                after: {
                  deletedCount: completed.deleted,
                  releasedBytes: completed.releasedBytes,
                  pendingArtifactCount: completed.pendingArtifactCount,
                },
                reason: deleted ? 'admin_delete' : 'attachment_not_found',
                outcome: deleted ? 'SUCCESS' : 'DENIED',
                requestId,
              },
              tx
            );
            return;
          }
          await writeSecurityAudit(
            req,
            {
              event: 'chat_files.delete',
              operator: { id: admin.id, email: admin.email, role: admin.role },
              target: { type: 'chat_attachment', id },
              before: null,
              after: { completed: false },
              reason: 'admin_delete',
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
          const deleteResult = await performChatFileDelete(id, {
            onDatabaseMutation: async (tx, summary) => {
              await writeSecurityAudit(
                req,
                {
                  event: 'chat_files.delete_database',
                  operator: {
                    id: admin.id,
                    email: admin.email,
                    role: admin.role,
                  },
                  target: { type: 'chat_attachment', id },
                  before: {
                    candidateCount: summary.candidateCount,
                    ownerId: summary.ownerIds[0] ?? null,
                  },
                  after: {
                    deletedCount: summary.deleted,
                    releasedBytes: summary.releasedBytes,
                    queuedArtifactCount: summary.queuedArtifactCount,
                  },
                  reason: 'admin_delete',
                  outcome: summary.deleted > 0 ? 'SUCCESS' : 'DENIED',
                  requestId,
                },
                tx
              );
            },
            onArtifactReleaseMutation: async (tx, summary) => {
              await writeSecurityAudit(
                req,
                {
                  event: 'chat_files.delete_artifact',
                  operator: {
                    id: admin.id,
                    email: admin.email,
                    role: admin.role,
                  },
                  target: { type: 'chat_attachment', id },
                  before: { artifactCount: summary.artifactCount },
                  after: {
                    releasedArtifactCount: summary.releasedArtifactCount,
                    releasedBytes: summary.releasedBytes,
                  },
                  reason: 'admin_delete_remote_delete_confirmed',
                  outcome:
                    summary.releasedArtifactCount === summary.artifactCount
                      ? 'SUCCESS'
                      : 'PARTIAL',
                  requestId,
                },
                tx
              );
            },
          });
          if (!deleteResult.physicalDeleteComplete) {
            throw new Error('chat file physical cleanup incomplete');
          }
          return deleteResult;
        } catch {
          throw new Error('chat file delete operation failed');
        }
      }
    );

    if (!result.found || result.deleted === 0) {
      return NextResponse.json({ error: '附件不存在' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      deleted: result.deleted,
      releasedBytes: result.releasedBytes,
    });
  } catch (err) {
    console.error('chat-files single delete failed:', err);
    return NextResponse.json({ error: '删除失败' }, { status: 500 });
  }
}
