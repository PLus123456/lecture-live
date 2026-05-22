import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import {
  validateChatFileCleanupParams,
  performChatFileCleanup,
} from '@/lib/chatFileCleanup';

/**
 * POST /api/admin/chat-files/cleanup —— 批量清理（JSON body 形式）。
 *
 * 与 DELETE /api/admin/chat-files?... 等价；DELETE 形式是为了与
 * CleanupModalShell 现有的 "DELETE + querystring" 模板对齐；POST + body 是
 * 给 curl / 后台脚本用的更可读的入口。两者共用 `performCleanup`。
 */
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:chat-files:cleanup',
    limit: 10,
    windowMs: 60_000,
  });
  if (response) return response;

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

  try {
    const result = await performChatFileCleanup({
      olderThanDays: validation.olderThanDays,
      sizeBytesGT: validation.sizeBytesGT,
      userId: validation.userId,
      kinds: validation.kinds,
      conversationId: validation.conversationId,
    });

    logAction(req, 'admin.chat_files.cleanup', {
      user: admin,
      detail: JSON.stringify({
        olderThanDays: validation.olderThanDays,
        sizeBytesGT: validation.sizeBytesGT,
        userId: validation.userId,
        kinds: validation.kinds,
        conversationId: validation.conversationId,
        deletedCount: result.deleted,
        releasedBytes: result.releasedBytes,
        truncated: result.truncated,
      }),
    });

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
