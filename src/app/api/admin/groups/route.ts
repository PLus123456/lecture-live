import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { logAction } from '@/lib/auditLog';

// 系统内置角色
const SYSTEM_ROLES = ['FREE', 'PRO', 'ADMIN'] as const;

// 默认组权限配置
const DEFAULT_GROUP_PERMISSIONS: Record<string, GroupPermissions> = {
  FREE: {
    transcriptionMinutesLimit: 60,
    storageHoursLimit: 10,
    allowedModels: 'local',
    maxConcurrentSessions: 1,
  },
  PRO: {
    transcriptionMinutesLimit: 600,
    storageHoursLimit: 100,
    allowedModels: 'local,gpt,deepseek',
    maxConcurrentSessions: 3,
  },
  ADMIN: {
    transcriptionMinutesLimit: 999999,
    storageHoursLimit: 999999,
    allowedModels: '*',
    maxConcurrentSessions: 999,
  },
};

interface GroupPermissions {
  transcriptionMinutesLimit: number;
  storageHoursLimit: number;
  allowedModels: string;
  maxConcurrentSessions: number;
}

/**
 * GET /api/admin/groups
 * 获取所有用户组（含真实用户数量和持久化配置）
 */
export async function GET(req: Request) {
  const { response } = await requireAdminAccess(req, {
    scope: 'admin:groups:list',
    limit: 60,
  });
  if (response) return response;

  try {
    // 并行查询：各角色用户数 + 已保存的组配置
    const [userCounts, savedConfigs] = await Promise.all([
      prisma.user.groupBy({
        by: ['role'],
        _count: { id: true },
      }),
      prisma.siteSetting.findMany({
        where: { key: { startsWith: 'group_config_' } },
      }),
    ]);

    // 构建用户数映射
    const countMap: Record<string, number> = {};
    for (const item of userCounts) {
      countMap[item.role] = item._count.id;
    }

    // 构建已保存配置映射
    const configMap: Record<string, GroupPermissions> = {};
    for (const row of savedConfigs) {
      const role = row.key.replace('group_config_', '');
      try {
        configMap[role] = JSON.parse(row.value);
      } catch {
        // 跳过无效 JSON
      }
    }

    // 合并系统组数据
    const groups = SYSTEM_ROLES.map((role) => ({
      id: role,
      name: role === 'FREE' ? 'Free' : role === 'PRO' ? 'Pro' : 'Admin',
      permissions: configMap[role] ?? DEFAULT_GROUP_PERMISSIONS[role],
      userCount: countMap[role] ?? 0,
      isSystem: true,
    }));

    return NextResponse.json({ groups });
  } catch (err) {
    console.error('获取用户组失败:', err);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}

/**
 * PUT /api/admin/groups
 * 更新用户组权限配置
 */
export async function PUT(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:groups:update',
    limit: 20,
    windowMs: 60_000,
  });
  if (response) return response;

  try {
    const body = await req.json();
    const { groupId, permissions } = body as {
      groupId: string;
      permissions: GroupPermissions;
    };

    if (!groupId || !permissions) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
    }

    // 仅允许更新已知角色
    if (!SYSTEM_ROLES.includes(groupId as typeof SYSTEM_ROLES[number])) {
      return NextResponse.json({ error: '无效的用户组 ID' }, { status: 400 });
    }

    // 验证权限字段
    const sanitized: GroupPermissions = {
      transcriptionMinutesLimit: Math.max(0, Math.floor(Number(permissions.transcriptionMinutesLimit) || 0)),
      storageHoursLimit: Math.max(0, Math.floor(Number(permissions.storageHoursLimit) || 0)),
      allowedModels: String(permissions.allowedModels || 'local').trim(),
      maxConcurrentSessions: Math.max(1, Math.floor(Number(permissions.maxConcurrentSessions) || 1)),
    };

    const settingKey = `group_config_${groupId}`;
    await prisma.siteSetting.upsert({
      where: { key: settingKey },
      update: { value: JSON.stringify(sanitized) },
      create: { key: settingKey, value: JSON.stringify(sanitized) },
    });

    logAction(req, 'admin.group.update', {
      user: admin,
      detail: `更新用户组配置: ${groupId}`,
    });

    return NextResponse.json({ success: true, groupId, permissions: sanitized });
  } catch (err) {
    console.error('更新用户组失败:', err);
    return NextResponse.json({ error: '更新失败' }, { status: 500 });
  }
}
