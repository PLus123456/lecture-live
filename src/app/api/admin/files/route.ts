import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import {
  invalidateFoldersApiCache,
  invalidateSessionsApiCache,
  invalidateShareLinksApiCache,
} from '@/lib/apiResponseCache';
import { logAction } from '@/lib/auditLog';
import { releaseStorageBytes } from '@/lib/quota';

type StatusFilter = '' | 'has-recording' | 'no-recording' | 'completed' | 'archived' | 'recording';

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
 * 不会主动删除 Cloudreve 远程文件——上传后 Cloudreve 会按其配置回收，
 * 单独删除远端文件需要 OAuth 上下文，避免在 admin 删除路径里引入。
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

  try {
    const body = await req.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body.ids)
      ? body.ids.filter((x: unknown): x is string => typeof x === 'string')
      : [];

    if (ids.length === 0) {
      return NextResponse.json({ error: '请提供要删除的会话 ID' }, { status: 400 });
    }

    const targets = await prisma.session.findMany({
      where: { id: { in: ids } },
      select: { id: true, userId: true, title: true },
    });

    if (targets.length === 0) {
      return NextResponse.json({ error: '未找到目标会话' }, { status: 404 });
    }

    const targetIds = targets.map((t) => t.id);

    // 删 session 会级联删 legacy 单录音对话(Conversation.sessionId 命中)及其 ChatAttachment
    // (schema onDelete: Cascade)。这些字节必须释放，否则永久"鬼占"用户配额、只增不减。
    // 全局多录音对话经 ConversationSession 联表挂载，删 session 只级联联表行、对话与附件保留，
    // 故仅聚合 legacy 对话的附件字节，按 owner 分组（删后逐用户 release）。
    // 对照用户侧实现：src/app/api/sessions/[id]/route.ts。
    const releasableBytes = await prisma.chatAttachment.groupBy({
      by: ['userId'],
      where: { conversation: { sessionId: { in: targetIds } } },
      _sum: { bytes: true },
    });

    // 事务：删除外键关联，再删 session 本体
    await prisma.$transaction([
      prisma.folderSession.deleteMany({ where: { sessionId: { in: targetIds } } }),
      prisma.shareLink.deleteMany({ where: { sessionId: { in: targetIds } } }),
      prisma.session.deleteMany({ where: { id: { in: targetIds } } }),
    ]);

    // session 删除成功后释放字节配额（best-effort；失败留给字节对账兜底）
    for (const row of releasableBytes) {
      const bytes = row._sum.bytes;
      if (bytes && bytes > BigInt(0)) {
        await releaseStorageBytes(row.userId, Number(bytes)).catch(() => undefined);
      }
    }

    // 失效所有受影响用户的缓存
    const ownerIds = [...new Set(targets.map((t) => t.userId))];
    await Promise.all(
      ownerIds.flatMap((id) => [
        invalidateSessionsApiCache(id),
        invalidateFoldersApiCache(id),
        invalidateShareLinksApiCache(id),
      ]),
    );

    logAction(req, 'admin.files.delete', {
      user: admin,
      detail: `删除 ${targets.length} 个会话/录音 (ids: ${targets.map((t) => t.id.slice(0, 8)).join(', ')})`,
    });

    return NextResponse.json({ deleted: targets.length });
  } catch (err) {
    console.error('删除会话失败:', err);
    return NextResponse.json({ error: '删除失败' }, { status: 500 });
  }
}
