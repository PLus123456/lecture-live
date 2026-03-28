import { prisma } from '@/lib/prisma';
import { resolveRequestClientIp } from '@/lib/clientIp';
import type { UserPayload } from '@/lib/auth';

interface AuditLogEntry {
  action: string;
  detail?: string;
  userId?: string | null;
  userName?: string | null;
  ip?: string | null;
}

/**
 * 写入审计日志（fire-and-forget，不阻塞主流程）
 */
export function writeAuditLog(entry: AuditLogEntry): void {
  prisma.auditLog
    .create({
      data: {
        action: entry.action,
        detail: entry.detail ?? null,
        userId: entry.userId ?? null,
        userName: entry.userName ?? null,
        ip: entry.ip ?? null,
      },
    })
    .catch((err) => {
      console.error('审计日志写入失败:', err);
    });
}

/**
 * 从 Request + UserPayload 中提取信息并写入审计日志
 */
export function logAction(
  req: Request,
  action: string,
  opts?: {
    user?: UserPayload | null;
    userName?: string | null;
    detail?: string;
  }
): void {
  const ip = resolveRequestClientIp(req);
  writeAuditLog({
    action,
    detail: opts?.detail,
    userId: opts?.user?.id ?? null,
    userName: opts?.userName ?? opts?.user?.email ?? null,
    ip: ip === 'unknown' ? null : ip,
  });
}

/**
 * 记录系统事件（无用户上下文）
 */
export function logSystemEvent(action: string, detail?: string): void {
  writeAuditLog({
    action,
    detail,
  });
}
