import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import bcrypt from 'bcryptjs';
import { requireAdminAccess } from '@/lib/adminApi';
import { validatePassword } from '@/lib/auth';
import { logAction } from '@/lib/auditLog';
import { getSiteSettings } from '@/lib/siteSettings';
import { getDefaultQuotasForRole, normalizeUserRole } from '@/lib/userRoles';

// 共享的用户查询 select 字段
const USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  status: true,
  points: true,
  originalRole: true,
  roleExpiresAt: true,
  avatarPath: true,
  createdAt: true,
  transcriptionMinutesUsed: true,
  transcriptionMinutesLimit: true,
  storageHoursUsed: true,
  storageHoursLimit: true,
  allowedModels: true,
  customGroupId: true,
} as const;

// 管理员用户列表 API
export async function GET(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:users:list',
    limit: 60,
  });
  if (response) {
    return response;
  }
  if (!admin) {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const filter = searchParams.get('filter') || '';
  const groupFilter = searchParams.get('group') || '';

  try {
    const where: Record<string, unknown> = {};

    // 关键词过滤（匹配昵称或邮箱）
    if (filter) {
      where.OR = [
        { displayName: { contains: filter } },
        { email: { contains: filter } },
      ];
    }

    // 用户组过滤（系统角色或自定义组）
    if (groupFilter) {
      if (['ADMIN', 'PRO', 'FREE'].includes(groupFilter)) {
        where.role = groupFilter;
      } else {
        where.customGroupId = groupFilter;
      }
    }

    const users = await prisma.user.findMany({
      where,
      select: USER_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    const sortedUsers = [...users].sort((a, b) => {
      if (a.id === admin.id) return -1;
      if (b.id === admin.id) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return NextResponse.json({ users: sortedUsers });
  } catch (err) {
    console.error('用户列表查询失败:', err);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}

// 新建用户
export async function POST(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:users:create',
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (response || !admin) {
    return response!;
  }

  try {
    const siteSettings = await getSiteSettings();
    const body = await req.json();
    const { email, displayName, password, role } = body;
    const normalizedRole = normalizeUserRole(role, 'FREE');

    if (!email || !displayName || !password) {
      return NextResponse.json({ error: '缺少必要字段' }, { status: 400 });
    }

    // 安全：admin 创建用户也需要密码强度校验
    const passwordError = validatePassword(password, {
      minLength: siteSettings.password_min_length,
    });
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    // 检查邮箱是否已存在
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json({ error: '邮箱已被注册' }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(password, siteSettings.bcrypt_rounds);

    // 根据角色设置默认配额
    const quotas = getDefaultQuotasForRole(normalizedRole);

    const user = await prisma.user.create({
      data: {
        email,
        displayName,
        passwordHash,
        role: normalizedRole,
        ...quotas,
      },
      select: USER_SELECT,
    });

    logAction(req, 'admin.user.create', {
      user: admin,
      detail: `创建用户: ${email} (${normalizedRole})`,
    });

    return NextResponse.json({ user }, { status: 201 });
  } catch (err) {
    console.error('创建用户失败:', err);
    return NextResponse.json({ error: '创建失败' }, { status: 500 });
  }
}

// 批量删除用户
export async function DELETE(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:users:delete',
    limit: 10,
    windowMs: 10 * 60_000,
  });
  if (response || !admin) {
    return response!;
  }

  try {
    const body = await req.json();
    const { userIds } = body as { userIds: string[] };

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return NextResponse.json({ error: '请提供要删除的用户 ID' }, { status: 400 });
    }

    const protectedAdmins = await prisma.user.findMany({
      where: {
        id: { in: userIds },
        role: 'ADMIN',
      },
      select: { id: true },
    });
    const protectedAdminIds = new Set(protectedAdmins.map((entry) => entry.id));
    const safeIds = userIds.filter(
      (id) => id !== admin.id && !protectedAdminIds.has(id)
    );

    const result = await prisma.user.deleteMany({
      where: { id: { in: safeIds } },
    });

    logAction(req, 'admin.user.delete', {
      user: admin,
      detail: `删除 ${result.count} 个用户`,
    });

    return NextResponse.json({
      deleted: result.count,
      skipped: {
        self: userIds.includes(admin.id),
        admins: protectedAdmins.map((entry) => entry.id),
      },
    });
  } catch (err) {
    console.error('删除用户失败:', err);
    return NextResponse.json({ error: '删除失败' }, { status: 500 });
  }
}

// 编辑用户
export async function PATCH(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:users:update',
    limit: 30,
    windowMs: 60_000,
  });
  if (response || !admin) {
    return response!;
  }

  try {
    const siteSettings = await getSiteSettings();
    const body = await req.json();
    const { userId, ...fields } = body as {
      userId: string;
      email?: string;
      displayName?: string;
      password?: string;
      role?: string;
      status?: number;
      points?: number;
      originalRole?: string | null;
      roleExpiresAt?: string | null;
      customGroupId?: string | null;
    };

    if (!userId) {
      return NextResponse.json({ error: '缺少用户 ID' }, { status: 400 });
    }

    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    }

    // 构建更新数据
    const data: Record<string, unknown> = {};

    if (fields.email !== undefined && fields.email !== existing.email) {
      // 检查邮箱唯一性
      const dup = await prisma.user.findUnique({ where: { email: fields.email } });
      if (dup && dup.id !== userId) {
        return NextResponse.json({ error: '邮箱已被其他用户使用' }, { status: 409 });
      }
      data.email = fields.email;
    }

    if (fields.displayName !== undefined) {
      data.displayName = fields.displayName;
    }

    if (fields.password && fields.password.length > 0) {
      const passwordError = validatePassword(fields.password, {
        minLength: siteSettings.password_min_length,
      });
      if (passwordError) {
        return NextResponse.json({ error: passwordError }, { status: 400 });
      }
      data.passwordHash = await bcrypt.hash(fields.password, siteSettings.bcrypt_rounds);
      // 修改密码后令旧 token 失效
      data.tokenVersion = { increment: 1 };
    }

    if (fields.role !== undefined) {
      data.role = normalizeUserRole(fields.role, existing.role);
    }

    if (fields.status !== undefined) {
      data.status = fields.status === 1 ? 1 : 0;
    }

    if (fields.points !== undefined) {
      data.points = Math.max(0, Math.floor(Number(fields.points) || 0));
    }

    if (fields.originalRole !== undefined) {
      if (fields.originalRole === null || fields.originalRole === '') {
        data.originalRole = null;
      } else {
        data.originalRole = normalizeUserRole(fields.originalRole, null as unknown as 'FREE');
        // 如果 normalizeUserRole 返回 fallback 且传的是无效值，设为 null
        if (!['ADMIN', 'PRO', 'FREE'].includes(fields.originalRole)) {
          data.originalRole = null;
        }
      }
    }

    if (fields.roleExpiresAt !== undefined) {
      if (fields.roleExpiresAt === null || fields.roleExpiresAt === '') {
        data.roleExpiresAt = null;
      } else {
        const d = new Date(fields.roleExpiresAt);
        if (isNaN(d.getTime())) {
          return NextResponse.json({ error: '无效的日期格式' }, { status: 400 });
        }
        data.roleExpiresAt = d;
      }
    }

    // 自定义用户组分配
    if (fields.customGroupId !== undefined) {
      if (fields.customGroupId === null || fields.customGroupId === '') {
        // 清除自定义组，恢复角色默认配额
        data.customGroupId = null;
        const role = (data.role as string) || existing.role;
        const defaults = getDefaultQuotasForRole(role as 'ADMIN' | 'PRO' | 'FREE');
        data.allowedModels = defaults.allowedModels;
        data.transcriptionMinutesLimit = defaults.transcriptionMinutesLimit;
        data.storageHoursLimit = defaults.storageHoursLimit;
      } else {
        // Bug 5: 先验证自定义组是否存在，再分配
        const groupRow = await prisma.siteSetting.findUnique({ where: { key: 'custom_groups' } });
        let group: { permissions: { allowedModels: string; transcriptionMinutesLimit: number; storageHoursLimit: number } } | null = null;
        if (groupRow) {
          try {
            const groups = JSON.parse(groupRow.value);
            group = Array.isArray(groups) ? groups.find((g: { id: string }) => g.id === fields.customGroupId) : null;
          } catch {
            // 解析失败
          }
        }
        if (!group) {
          return NextResponse.json({ error: '指定的用户组不存在' }, { status: 400 });
        }
        data.customGroupId = fields.customGroupId;
        data.allowedModels = group.permissions.allowedModels;
        data.transcriptionMinutesLimit = group.permissions.transcriptionMinutesLimit;
        data.storageHoursLimit = group.permissions.storageHoursLimit;
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: '没有需要更新的字段' }, { status: 400 });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: USER_SELECT,
    });

    logAction(req, 'admin.user.update', {
      user: admin,
      detail: `编辑用户: ${user.email} (${Object.keys(data).join(', ')})`,
    });

    return NextResponse.json({ user });
  } catch (err) {
    console.error('编辑用户失败:', err);
    return NextResponse.json({ error: '编辑失败' }, { status: 500 });
  }
}
