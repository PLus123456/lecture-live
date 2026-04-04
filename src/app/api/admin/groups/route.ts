import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/adminApi';
import { prisma } from '@/lib/prisma';
import { logAction } from '@/lib/auditLog';
import { getDefaultQuotasForRole } from '@/lib/userRoles';

// 系统内置角色
const SYSTEM_ROLES = ['FREE', 'PRO', 'ADMIN'] as const;

interface GroupPermissions {
  transcriptionMinutesLimit: number;
  storageHoursLimit: number;
  allowedModels: string;
  maxConcurrentSessions: number;
}

interface CustomGroupEntry {
  id: string;
  name: string;
  description: string;
  color: string;
  permissions: GroupPermissions;
}

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

// Prisma 事务客户端类型
type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** 从 SiteSetting 读取自定义组列表 */
async function loadCustomGroups(tx?: TxClient): Promise<CustomGroupEntry[]> {
  const db = tx ?? prisma;
  const row = await db.siteSetting.findUnique({ where: { key: 'custom_groups' } });
  if (!row) return [];
  try {
    const arr = JSON.parse(row.value);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 保存自定义组列表到 SiteSetting */
async function saveCustomGroups(groups: CustomGroupEntry[], tx?: TxClient) {
  const db = tx ?? prisma;
  await db.siteSetting.upsert({
    where: { key: 'custom_groups' },
    update: { value: JSON.stringify(groups) },
    create: { key: 'custom_groups', value: JSON.stringify(groups) },
  });
}

/** 校验 allowedModels 格式 */
function validateAllowedModels(raw: string): boolean {
  if (raw === '*') return true;
  return /^[a-zA-Z0-9_.\-]+(,[a-zA-Z0-9_.\-]+)*$/.test(raw);
}

/** 系统保留组名（小写） */
const RESERVED_GROUP_NAMES = ['free', 'pro', 'admin'];

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
    // 并行查询
    const [userCounts, savedConfigs, customGroups, customGroupCounts] = await Promise.all([
      prisma.user.groupBy({
        by: ['role'],
        _count: { id: true },
      }),
      prisma.siteSetting.findMany({
        where: { key: { startsWith: 'group_config_' } },
      }),
      loadCustomGroups(),
      prisma.user.groupBy({
        by: ['customGroupId'],
        where: { customGroupId: { not: null } },
        _count: { id: true },
      }),
    ]);

    // 构建用户数映射（按角色）
    const countMap: Record<string, number> = {};
    for (const item of userCounts) {
      countMap[item.role] = item._count.id;
    }

    // 构建已保存配置映射（系统组）
    const configMap: Record<string, GroupPermissions> = {};
    for (const row of savedConfigs) {
      const role = row.key.replace('group_config_', '');
      try {
        configMap[role] = JSON.parse(row.value);
      } catch {
        // 跳过无效 JSON
      }
    }

    // 构建自定义组用户数映射
    const customCountMap: Record<string, number> = {};
    for (const item of customGroupCounts) {
      if (item.customGroupId) {
        customCountMap[item.customGroupId] = item._count.id;
      }
    }

    // 合并系统组数据
    const systemGroups = SYSTEM_ROLES.map((role) => ({
      id: role,
      name: role === 'FREE' ? 'Free' : role === 'PRO' ? 'Pro' : 'Admin',
      permissions: configMap[role] ?? DEFAULT_GROUP_PERMISSIONS[role],
      userCount: countMap[role] ?? 0,
      isSystem: true,
    }));

    // 自定义组数据
    const customGroupsOut = customGroups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      color: g.color,
      permissions: g.permissions,
      userCount: customCountMap[g.id] ?? 0,
      isSystem: false,
    }));

    return NextResponse.json({ groups: [...systemGroups, ...customGroupsOut] });
  } catch (err) {
    console.error('获取用户组失败:', err);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}

/**
 * POST /api/admin/groups
 * 新建自定义用户组
 */
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:groups:create',
    limit: 20,
    windowMs: 60_000,
  });
  if (response) return response;

  try {
    const body = await req.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const color = typeof body.color === 'string' ? body.color.trim() : 'bg-purple-50 text-purple-600';
    const permissions = body.permissions as GroupPermissions | undefined;

    if (!name) {
      return NextResponse.json({ error: '用户组名称不能为空' }, { status: 400 });
    }

    // Bug 3: 校验组名不与系统保留名冲突
    if (RESERVED_GROUP_NAMES.includes(name.toLowerCase())) {
      return NextResponse.json({ error: '不能使用系统保留名称' }, { status: 400 });
    }

    // Bug 6: 校验 allowedModels 格式
    const rawModels = String(permissions?.allowedModels || 'local').trim();
    if (!validateAllowedModels(rawModels)) {
      return NextResponse.json({ error: 'allowedModels 格式无效' }, { status: 400 });
    }

    // 生成唯一 ID
    const id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    const sanitizedPermissions: GroupPermissions = {
      transcriptionMinutesLimit: Math.max(0, Math.floor(Number(permissions?.transcriptionMinutesLimit) || 60)),
      storageHoursLimit: Math.max(0, Number(permissions?.storageHoursLimit) || 10),
      allowedModels: rawModels,
      maxConcurrentSessions: Math.max(1, Math.floor(Number(permissions?.maxConcurrentSessions) || 1)),
    };

    const newGroup: CustomGroupEntry = {
      id,
      name,
      description,
      color,
      permissions: sanitizedPermissions,
    };

    // Bug 4: 事务内读写，避免竞态
    await prisma.$transaction(async (tx) => {
      const existing = await loadCustomGroups(tx);

      // Bug 3: 校验组名不与已有自定义组重名
      if (existing.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('DUPLICATE_NAME');
      }

      existing.push(newGroup);
      await saveCustomGroups(existing, tx);
    });

    logAction(req, 'admin.group.create', {
      user: admin,
      detail: `创建自定义用户组: ${name} (${id})`,
    });

    return NextResponse.json({ success: true, group: { ...newGroup, userCount: 0, isSystem: false } }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message === 'DUPLICATE_NAME') {
      return NextResponse.json({ error: '用户组名称已存在' }, { status: 409 });
    }
    console.error('创建自定义用户组失败:', err);
    return NextResponse.json({ error: '创建失败' }, { status: 500 });
  }
}

/**
 * PUT /api/admin/groups
 * 更新用户组权限配置（系统组或自定义组）
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
    const { groupId, permissions, name, description, color } = body as {
      groupId: string;
      permissions: GroupPermissions;
      name?: string;
      description?: string;
      color?: string;
    };

    if (!groupId || !permissions) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
    }

    // Bug 6: 校验 allowedModels 格式
    const rawModels = String(permissions.allowedModels || 'local').trim();
    if (!validateAllowedModels(rawModels)) {
      return NextResponse.json({ error: 'allowedModels 格式无效' }, { status: 400 });
    }

    // 验证权限字段（Bug 1: storageHoursLimit 保留浮点精度）
    const sanitized: GroupPermissions = {
      transcriptionMinutesLimit: Math.max(0, Math.floor(Number(permissions.transcriptionMinutesLimit) || 0)),
      storageHoursLimit: Math.max(0, Number(permissions.storageHoursLimit) || 0),
      allowedModels: rawModels,
      maxConcurrentSessions: Math.max(1, Math.floor(Number(permissions.maxConcurrentSessions) || 1)),
    };

    const isSystemRole = (SYSTEM_ROLES as readonly string[]).includes(groupId);

    if (isSystemRole) {
      // 系统角色：存储到 SiteSetting
      const settingKey = `group_config_${groupId}`;
      await prisma.siteSetting.upsert({
        where: { key: settingKey },
        update: { value: JSON.stringify(sanitized) },
        create: { key: settingKey, value: JSON.stringify(sanitized) },
      });
      // Bug 2: 同步该角色下所有非自定义组用户的配额
      await prisma.user.updateMany({
        where: { role: groupId as 'ADMIN' | 'PRO' | 'FREE', customGroupId: null },
        data: {
          allowedModels: sanitized.allowedModels,
          transcriptionMinutesLimit: sanitized.transcriptionMinutesLimit,
          storageHoursLimit: sanitized.storageHoursLimit,
        },
      });
    } else {
      // Bug 3: 更新名称时校验重名
      if (name !== undefined && name.trim()) {
        if (RESERVED_GROUP_NAMES.includes(name.trim().toLowerCase())) {
          return NextResponse.json({ error: '不能使用系统保留名称' }, { status: 400 });
        }
      }

      // Bug 4: 事务内读写，避免竞态
      await prisma.$transaction(async (tx) => {
        const groups = await loadCustomGroups(tx);
        const idx = groups.findIndex((g) => g.id === groupId);
        if (idx === -1) {
          throw new Error('GROUP_NOT_FOUND');
        }

        // Bug 3: 校验组名不与其他自定义组重名
        if (name !== undefined && name.trim()) {
          const others = groups.filter((_, i) => i !== idx);
          if (others.some((g) => g.name.toLowerCase() === name.trim().toLowerCase())) {
            throw new Error('DUPLICATE_NAME');
          }
        }

        groups[idx].permissions = sanitized;
        if (name !== undefined) groups[idx].name = name.trim();
        if (description !== undefined) groups[idx].description = description.trim();
        if (color !== undefined) groups[idx].color = color.trim();
        await saveCustomGroups(groups, tx);

        // 同步该自定义组内所有用户的配额（在事务内）
        await tx.user.updateMany({
          where: { customGroupId: groupId },
          data: {
            allowedModels: sanitized.allowedModels,
            transcriptionMinutesLimit: sanitized.transcriptionMinutesLimit,
            storageHoursLimit: sanitized.storageHoursLimit,
          },
        });
      });
    }

    logAction(req, 'admin.group.update', {
      user: admin,
      detail: `更新用户组配置: ${groupId}`,
    });

    return NextResponse.json({ success: true, groupId, permissions: sanitized });
  } catch (err) {
    if (err instanceof Error && err.message === 'GROUP_NOT_FOUND') {
      return NextResponse.json({ error: '无效的用户组 ID' }, { status: 400 });
    }
    if (err instanceof Error && err.message === 'DUPLICATE_NAME') {
      return NextResponse.json({ error: '用户组名称已存在' }, { status: 409 });
    }
    console.error('更新用户组失败:', err);
    return NextResponse.json({ error: '更新失败' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/groups
 * 删除自定义用户组
 */
export async function DELETE(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:groups:delete',
    limit: 20,
    windowMs: 60_000,
  });
  if (response) return response;

  try {
    const { searchParams } = new URL(req.url);
    const groupId = searchParams.get('groupId');

    if (!groupId) {
      return NextResponse.json({ error: '缺少 groupId' }, { status: 400 });
    }

    // 不允许删除系统组
    if ((SYSTEM_ROLES as readonly string[]).includes(groupId)) {
      return NextResponse.json({ error: '不能删除系统内置用户组' }, { status: 400 });
    }

    // Bug 4 & 7: 事务内完成组删除和用户配额恢复
    const result = await prisma.$transaction(async (tx) => {
      const groups = await loadCustomGroups(tx);
      const idx = groups.findIndex((g) => g.id === groupId);
      if (idx === -1) {
        throw new Error('GROUP_NOT_FOUND');
      }

      const removedGroup = groups[idx];
      groups.splice(idx, 1);
      await saveCustomGroups(groups, tx);

      // 查询受影响用户的角色分布
      const affectedUsers = await tx.user.findMany({
        where: { customGroupId: groupId },
        select: { id: true, role: true },
      });

      // Bug 7: 按 role 分组批量更新，替代逐条 update
      if (affectedUsers.length > 0) {
        const roleSet = new Set(affectedUsers.map((u) => u.role));
        for (const role of roleSet) {
          const defaults = getDefaultQuotasForRole(role);
          await tx.user.updateMany({
            where: { customGroupId: groupId, role },
            data: {
              customGroupId: null,
              allowedModels: defaults.allowedModels,
              transcriptionMinutesLimit: defaults.transcriptionMinutesLimit,
              storageHoursLimit: defaults.storageHoursLimit,
            },
          });
        }
      }

      return { removedGroup, affectedCount: affectedUsers.length };
    });

    logAction(req, 'admin.group.delete', {
      user: admin,
      detail: `删除自定义用户组: ${result.removedGroup.name} (${groupId}), 影响 ${result.affectedCount} 个用户`,
    });

    return NextResponse.json({ success: true, affectedUsers: result.affectedCount });
  } catch (err) {
    if (err instanceof Error && err.message === 'GROUP_NOT_FOUND') {
      return NextResponse.json({ error: '用户组不存在' }, { status: 404 });
    }
    console.error('删除自定义用户组失败:', err);
    return NextResponse.json({ error: '删除失败' }, { status: 500 });
  }
}
