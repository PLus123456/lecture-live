import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { prisma } from '@/lib/prisma';
import {
  validateAuditLogCleanupParams,
  olderThanDaysToCutoff,
} from '@/lib/adminCleanup';

// 获取审计日志（分页） / 清理预览
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  // ─── 清理预览 ───
  if (searchParams.get('cleanup_preview') === '1') {
    const { response } = await requireAdminAccess(req, {
      scope: 'admin:logs:cleanup:preview',
      limit: 30,
      windowMs: 60_000,
    });
    if (response) return response;

    const validation = validateAuditLogCleanupParams({
      actionCategories: searchParams.getAll('actionCategories'),
      olderThanDays: Number(searchParams.get('olderThanDays')),
    });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    try {
      const cutoff = olderThanDaysToCutoff(validation.olderThanDays);
      const count = await prisma.auditLog.count({
        where: {
          action: { in: validation.actions },
          createdAt: { lt: cutoff },
        },
      });
      return NextResponse.json({ count });
    } catch (err) {
      console.error('查询审计日志清理预览失败:', err);
      return NextResponse.json({ error: '查询失败' }, { status: 500 });
    }
  }

  const { response } = await requireAdminAccess(req, {
    scope: 'admin:logs:list',
    limit: 60,
  });
  if (response) {
    return response;
  }

  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '50', 10)));
  const action = searchParams.get('action') || '';
  const keyword = searchParams.get('keyword') || '';

  try {
    const where: Record<string, unknown> = {};

    // 按操作类型筛选
    if (action) {
      where.action = { startsWith: action };
    }

    // 关键词搜索（用户名、IP、详情）
    if (keyword) {
      where.OR = [
        { userName: { contains: keyword } },
        { ip: { contains: keyword } },
        { detail: { contains: keyword } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return NextResponse.json({
      logs,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    console.error('查询审计日志失败:', err);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}

// 批量清理审计日志（按类别 + 年龄；管理操作/注册/密码变更永不删）
export async function DELETE(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:logs:cleanup',
    limit: 10,
    windowMs: 60_000,
  });
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const validation = validateAuditLogCleanupParams({
    actionCategories: searchParams.getAll('actionCategories'),
    olderThanDays: Number(searchParams.get('olderThanDays')),
  });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const cutoff = olderThanDaysToCutoff(validation.olderThanDays);
    const result = await prisma.auditLog.deleteMany({
      where: {
        action: { in: validation.actions },
        createdAt: { lt: cutoff },
      },
    });

    logAction(req, 'admin.auditlog.cleanup', {
      user: admin,
      detail: JSON.stringify({
        actionCategories: validation.categories,
        olderThanDays: validation.olderThanDays,
        deletedCount: result.count,
      }),
    });

    return NextResponse.json({ success: true, deletedCount: result.count });
  } catch (err) {
    console.error('清理审计日志失败:', err);
    return NextResponse.json({ error: '清理失败' }, { status: 500 });
  }
}
