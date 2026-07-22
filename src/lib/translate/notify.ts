import 'server-only';

import { prisma } from '@/lib/prisma';
import { sendDocTranslateEmail } from '@/lib/email';
import { logger, serializeError } from '@/lib/logger';

const notifyLogger = logger.child({ component: 'doc-translate-notify' });

/**
 * 文档翻译完成/失败通知（best-effort，fire-and-forget 由调度器调用）。
 * 受用户「文档翻译」邮件偏好约束（sendDocTranslateEmail 内部过滤）；封禁账号不发。
 */
export async function sendDocTranslateNotification(
  taskId: string,
  outcome: 'completed' | 'failed'
): Promise<void> {
  try {
    const task = await prisma.translationTask.findUnique({
      where: { id: taskId },
      select: {
        fileName: true,
        errorMessage: true,
        refundedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            emailPreferences: true,
            status: true,
          },
        },
      },
    });
    if (!task || task.user.status !== 1) return;
    const result = await sendDocTranslateEmail(task.user, {
      fileName: task.fileName,
      outcome,
      errorMessage: task.errorMessage,
      refunded: Boolean(task.refundedAt),
    });
    if (!result.ok) {
      notifyLogger.warn({ taskId, error: result.error }, '文档翻译通知发送失败');
    }
  } catch (err) {
    notifyLogger.warn({ taskId, err: serializeError(err) }, '文档翻译通知异常');
  }
}
