import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';

// 获取审计日志（分页）
export async function GET(req: Request) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:logs:list',
    limit: 60,
  });
  if (response) {
    return response;
  }

  const { searchParams } = new URL(req.url);
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
