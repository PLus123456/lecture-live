import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import { prisma } from '@/lib/prisma';
import { writeSecurityAudit } from '@/lib/securityAudit';
import {
  validateAuditLogCleanupParams,
  olderThanDaysToCutoff,
} from '@/lib/adminCleanup';

class SecurityAuditUnavailableError extends Error {
  constructor(cause: unknown) {
    super('security audit unavailable', { cause });
    this.name = 'SecurityAuditUnavailableError';
  }
}

function operatorFromAdmin(admin: {
  id: string;
  email: string;
  role: string;
}) {
  return {
    id: admin.id,
    email: admin.email,
    role: admin.role,
  };
}

// 获取审计日志（分页） / 清理预览
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  // ─── 清理预览 ───
  if (searchParams.get('cleanup_preview') === '1') {
    const { user: admin, response } = await requireAdminAccess(req, {
      scope: 'admin:logs:cleanup:preview',
      limit: 30,
      windowMs: 60_000,
    });
    if (response) return response;
    if (!admin) {
      return NextResponse.json({ error: '权限不足' }, { status: 403 });
    }

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

      try {
        await writeSecurityAudit(req, {
          event: 'audit_logs.cleanup_preview',
          operator: operatorFromAdmin(admin),
          target: {
            type: 'audit_log_cleanup',
            categories: validation.categories,
          },
          before: null,
          after: { eligibleCount: count },
          reason: 'admin_cleanup_preview',
          outcome: 'SUCCESS',
          metadata: { olderThanDays: validation.olderThanDays },
        });
      } catch (auditError) {
        console.error('记录审计日志清理预览失败:', auditError);
        return NextResponse.json(
          { error: '安全审计服务不可用' },
          { status: 503 }
        );
      }
      return NextResponse.json({ count });
    } catch (err) {
      console.error('查询审计日志清理预览失败:', err);
      return NextResponse.json({ error: '查询失败' }, { status: 500 });
    }
  }

  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:logs:list',
    limit: 60,
  });
  if (response) {
    return response;
  }
  if (!admin) {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
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

    try {
      await writeSecurityAudit(req, {
        event: 'audit_logs.read',
        operator: operatorFromAdmin(admin),
        target: {
          type: 'audit_log_collection',
          actionPrefix: action || null,
          hasKeywordFilter: Boolean(keyword),
        },
        before: null,
        after: {
          resultCount: logs.length,
          total,
          page,
          pageSize,
        },
        reason: 'admin_list',
        outcome: 'SUCCESS',
      });
    } catch (auditError) {
      console.error('记录审计日志读取失败:', auditError);
      return NextResponse.json(
        { error: '安全审计服务不可用' },
        { status: 503 }
      );
    }

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
  if (!admin) {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

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
    const result = await prisma.$transaction(async (tx) => {
      const deleted = await tx.auditLog.deleteMany({
        where: {
          action: { in: validation.actions },
          createdAt: { lt: cutoff },
        },
      });

      try {
        await writeSecurityAudit(
          req,
          {
            event: 'audit_logs.cleanup',
            operator: operatorFromAdmin(admin),
            target: {
              type: 'audit_log_collection',
              categories: validation.categories,
            },
            before: { eligibleCount: deleted.count },
            after: { deletedCount: deleted.count },
            reason: 'admin_retention_cleanup',
            outcome: 'SUCCESS',
            metadata: { olderThanDays: validation.olderThanDays },
          },
          tx
        );
      } catch (auditError) {
        throw new SecurityAuditUnavailableError(auditError);
      }

      return deleted;
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
    if (err instanceof SecurityAuditUnavailableError) {
      return NextResponse.json(
        { error: '安全审计服务不可用' },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: '清理失败' }, { status: 500 });
  }
}
