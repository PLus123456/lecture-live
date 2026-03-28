import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';

// 管理员统计数据 API
export async function GET(req: Request) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:stats:get',
    limit: 30,
  });
  if (response) {
    return response;
  }

  try {
    // 获取最近30天的每日统计
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // 并行查询
    const [totalUsers, totalSessions, totalShares, totalFolders, users, sessions, shares] =
      await Promise.all([
        prisma.user.count(),
        prisma.session.count(),
        prisma.shareLink.count(),
        prisma.folder.count(),
        // 最近30天的用户（带创建日期）
        prisma.user.findMany({
          where: { createdAt: { gte: thirtyDaysAgo } },
          select: { createdAt: true },
          orderBy: { createdAt: 'asc' },
        }),
        // 最近30天的录音会话
        prisma.session.findMany({
          where: { createdAt: { gte: thirtyDaysAgo } },
          select: { createdAt: true },
          orderBy: { createdAt: 'asc' },
        }),
        // 最近30天的分享
        prisma.shareLink.findMany({
          where: { createdAt: { gte: thirtyDaysAgo } },
          select: { createdAt: true },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

    // 按天聚合
    const dailyStats = buildDailyStats(thirtyDaysAgo, now, users, sessions, shares);

    return NextResponse.json({
      totals: {
        users: totalUsers,
        sessions: totalSessions,
        shares: totalShares,
        folders: totalFolders,
      },
      daily: dailyStats,
    });
  } catch (err) {
    console.error('管理员统计查询失败:', err);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}

// 构建每日统计数据
function buildDailyStats(
  start: Date,
  end: Date,
  users: { createdAt: Date }[],
  sessions: { createdAt: Date }[],
  shares: { createdAt: Date }[],
) {
  const days: { date: string; newUsers: number; recordings: number; shares: number }[] = [];
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);

  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    const nextDay = new Date(current.getTime() + 24 * 60 * 60 * 1000);

    days.push({
      date: dateStr,
      newUsers: users.filter(
        (u) => u.createdAt >= current && u.createdAt < nextDay,
      ).length,
      recordings: sessions.filter(
        (s) => s.createdAt >= current && s.createdAt < nextDay,
      ).length,
      shares: shares.filter(
        (s) => s.createdAt >= current && s.createdAt < nextDay,
      ).length,
    });

    current.setDate(current.getDate() + 1);
  }

  return days;
}
