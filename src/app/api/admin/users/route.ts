import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import bcrypt from 'bcryptjs';
import { requireAdminAccess } from '@/lib/adminApi';
import { validatePassword } from '@/lib/auth';
import { logAction } from '@/lib/auditLog';
import { getSiteSettings } from '@/lib/siteSettings';
import {
  normalizeUserRole,
  resolveRoleQuotas,
  resolveRoleStorageBytesLimit,
} from '@/lib/userRoles';
import { releaseStorageBytes, settlePoolOnLimitChange } from '@/lib/quota';
import { deleteCloudreveAttachmentFiles } from '@/lib/storage/cloudreveFileDelete';
import { invalidateUserEmailTokens } from '@/lib/email/tokens';

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
  // 邮箱验证状态：门禁开启时它为空就登不上。此前 admin 侧完全查不到这个字段，
  // 用户报「登不上」时后台无从诊断，故纳入列表。
  emailVerifiedAt: true,
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

    // storageHoursUsed 列是死维度（从不 increment），真实占用由 SUM(session.durationMs)/3600000
    // 实时聚合（与 quota.ts:getStorageHoursUsed 同口径）。一次 groupBy 覆盖全部列出的用户，
    // 避免逐用户 N 次查询；否则 admin 面板的「存储空间」进度条恒显示 0。
    const userIds = users.map((u) => u.id);
    const durationByUser = userIds.length
      ? await prisma.session.groupBy({
          by: ['userId'],
          where: { userId: { in: userIds } },
          _sum: { durationMs: true },
        })
      : [];
    const storageHoursByUser = new Map<string, number>();
    for (const row of durationByUser) {
      const ms = row._sum.durationMs ?? 0;
      storageHoursByUser.set(
        row.userId,
        ms > 0 ? Math.round((ms / 3_600_000) * 100) / 100 : 0
      );
    }

    const usersWithUsage = users.map((u) => ({
      ...u,
      storageHoursUsed: storageHoursByUser.get(u.id) ?? 0,
    }));

    const sortedUsers = usersWithUsage.sort((a, b) => {
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

    // 根据角色设置默认配额。U46：转录/存储/模型配额从 SiteSetting.group_config_<role>
    // 解析（缺失回落硬编码默认），字节上限同样从 SiteSetting 解析，让 admin 用户组配置真正生效。
    const [quotas, storageBytesLimit] = await Promise.all([
      resolveRoleQuotas(normalizedRole),
      resolveRoleStorageBytesLimit(normalizedRole),
    ]);

    const user = await prisma.user.create({
      data: {
        email,
        displayName,
        passwordHash,
        role: normalizedRole,
        // 管理员手工建号即视为已验证：邮箱和初始密码都是管理员亲自填的，等于线下背书。
        // 此前这里不写该字段 → email_verification 开启时，管理员建的账号一律 403 登不上，
        // 而后台也看不到这个字段，谁都诊断不出来。
        // 让用户去验证一个管理员替他填的地址也没有意义：地址填错了，验证信照样收不到。
        emailVerifiedAt: new Date(),
        ...quotas,
        storageBytesLimit,
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

    if (safeIds.length === 0) {
      return NextResponse.json({
        deleted: 0,
        skipped: {
          self: userIds.includes(admin.id),
          admins: protectedAdmins.map((entry) => entry.id),
        },
      });
    }

    const deleted = await cascadeDeleteUsers(safeIds);

    logAction(req, 'admin.user.delete', {
      user: admin,
      detail: `删除 ${deleted} 个用户`,
    });

    return NextResponse.json({
      deleted,
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

/**
 * 级联删除一批用户及其所有子数据。
 *
 * 背景：schema 里指向 User / Session / Folder 的外键多数为默认 RESTRICT（无 onDelete），
 * 直接 `user.deleteMany` 在有录音/文件夹/分享/对话的用户上会 FK 500。这里在单事务内
 * 按依赖顺序预删子数据再删 User，并在事务外尽力清掉 Cloudreve 物理文件 + 释放被删数据
 * 占用的字节配额（仅对未被删除的 owner 有意义，如跨用户挂载场景）。
 *
 * 删除顺序（叶子 → 根）：
 *   ShareLink（FK→User.createdBy & Session）
 *   → ChatAttachment（按 owner 或所属 Conversation；其 Cloudreve 文件先删）
 *   → ConversationMessage（Conversation 级联，显式删更稳）
 *   → Conversation（owner 或 legacy 绑定到待删 session）
 *   → FolderSession / FolderKeyword（Folder/Session 的联表）
 *   → Folder（FK userId 无 relation，按 userId 删）
 *   → Session（FK→User）
 *   → JobQueue（冗余 userId，无 FK，清理留痕外的运行态）
 *   → User
 *
 * 注：AuditLog.userId / ReconciliationMismatch.userId 为无 FK 的留痕列，故意保留以便审计。
 *
 * @returns 实际删除的用户数
 */
async function cascadeDeleteUsers(userIds: string[]): Promise<number> {
  // 收集待删用户的 session / folder / conversation id 集合
  const [sessions, folders, ownedConversations] = await Promise.all([
    prisma.session.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    }),
    prisma.folder.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    }),
    prisma.conversation.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    }),
  ]);
  const sessionIds = sessions.map((s) => s.id);
  const folderIds = folders.map((f) => f.id);

  // legacy 单录音对话（Conversation.sessionId 直接指向待删 session）也要删；
  // 与 owner 拥有的对话合并去重。多录音对话经 ConversationSession 联表挂载，删 session
  // 只级联联表行、对话本体（可能属他人）保留 —— 故不在此并入。
  const legacyConversations = sessionIds.length
    ? await prisma.conversation.findMany({
        where: { sessionId: { in: sessionIds } },
        select: { id: true },
      })
    : [];
  const conversationIds = [
    ...new Set([
      ...ownedConversations.map((c) => c.id),
      ...legacyConversations.map((c) => c.id),
    ]),
  ];

  // 待删的 chat 附件：按 owner（userId）或所属对话聚合，物理文件先删、字节配额后释放。
  const attachments = await prisma.chatAttachment.findMany({
    where: {
      OR: [
        { userId: { in: userIds } },
        ...(conversationIds.length
          ? [{ conversationId: { in: conversationIds } }]
          : []),
      ],
    },
    select: {
      id: true,
      userId: true,
      bytes: true,
      cloudrevePath: true,
      extractedTextPath: true,
    },
  });

  // 物理删除 Cloudreve 文件（best-effort，事务外，失败不阻塞）
  await deleteCloudreveAttachmentFiles(attachments);

  const attachmentIds = attachments.map((a) => a.id);
  const deletedUserSet = new Set(userIds);

  // 单事务内按 FK 依赖顺序删除子数据 + User（数组式 $transaction，与仓库其它删除路径一致，
  // 数组顺序即执行顺序）。空 `in: []` 的 deleteMany 是安全 no-op，故无需逐项判空。
  // ConversationMessage / ConversationSession 对 Conversation 虽是 onDelete: Cascade，
  // 仍显式先删，不依赖级联在同一事务内的触发时序。
  const txResults = await prisma.$transaction([
    // ShareLink：既指向 User(createdBy) 又指向 Session，最先清
    prisma.shareLink.deleteMany({
      where: {
        OR: [
          { createdBy: { in: userIds } },
          { sessionId: { in: sessionIds } },
        ],
      },
    }),
    prisma.chatAttachment.deleteMany({ where: { id: { in: attachmentIds } } }),
    prisma.conversationMessage.deleteMany({
      where: { conversationId: { in: conversationIds } },
    }),
    prisma.conversationSession.deleteMany({
      where: {
        OR: [
          { conversationId: { in: conversationIds } },
          { sessionId: { in: sessionIds } },
        ],
      },
    }),
    prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } }),
    // Folder/Session 联表 + Folder 关键词池，再删 Folder 本体
    prisma.folderSession.deleteMany({
      where: {
        OR: [
          { sessionId: { in: sessionIds } },
          { folderId: { in: folderIds } },
        ],
      },
    }),
    prisma.folderKeyword.deleteMany({ where: { folderId: { in: folderIds } } }),
    prisma.folder.deleteMany({ where: { id: { in: folderIds } } }),
    prisma.session.deleteMany({ where: { id: { in: sessionIds } } }),
    // 冗余 userId 列（无 FK，不阻塞删除，但清掉运行态任务避免悬挂引用）
    prisma.jobQueue.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.user.deleteMany({ where: { id: { in: userIds } } }),
  ]);
  const userResult = txResults[txResults.length - 1];

  // 释放被删数据占用的字节配额（仅对仍存在的 owner 有意义：被删用户自身的行已随删除消失）。
  // 复用 releaseStorageBytes，best-effort；失败留给字节对账兜底。
  const bytesByOwner = new Map<string, bigint>();
  for (const att of attachments) {
    if (deletedUserSet.has(att.userId)) continue;
    bytesByOwner.set(
      att.userId,
      (bytesByOwner.get(att.userId) ?? BigInt(0)) + att.bytes
    );
  }
  for (const [ownerId, bytes] of bytesByOwner) {
    if (bytes > BigInt(0)) {
      await releaseStorageBytes(ownerId, Number(bytes)).catch(() => undefined);
    }
  }

  return userResult.count;
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
      // 单用户配额直接覆盖（独立于用户组）。用于「给某个用户单独加/减使用时长」。
      transcriptionMinutesLimit?: number;
      storageHoursLimit?: number;
      // 一键重置该用户本月已用转录时长（transcriptionMinutesUsed → 0）。
      resetTranscriptionUsage?: boolean;
      // 人工标记邮箱已验证。存量用户卡在「未验证」时的唯一后台补救入口
      // （例如注册时填了收不到信的地址、或 SMTP 坏掉期间注册的账号）。
      markEmailVerified?: boolean;
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

    // 人工标记/撤销邮箱验证。true 时只在尚未验证的情况下写入，避免每次保存都刷新时间戳
    // （那会把「什么时候验证的」这条审计线索抹掉）。
    if (fields.markEmailVerified !== undefined) {
      if (fields.markEmailVerified) {
        if (!existing.emailVerifiedAt) data.emailVerifiedAt = new Date();
      } else {
        data.emailVerifiedAt = null;
      }
    }

    if (fields.role !== undefined) {
      data.role = normalizeUserRole(fields.role, existing.role);
    }

    if (fields.status !== undefined) {
      const nextStatus = fields.status === 1 ? 1 : 0;
      data.status = nextStatus;
      // 封禁（1→0）时即时吊销旧 token：自增 tokenVersion 让所有在用 JWT 立即失效，
      // 否则被禁用者仍能凭旧 cookie 访问（verifyToken 虽已拦 status，但 tokenVersion
      // 自增可叠加触发 token 不匹配，双保险且兼容缓存读路径）。
      if (nextStatus === 0 && existing.status === 1) {
        data.tokenVersion = { increment: 1 };
      }
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
        // U85：设置非空到期时间时必须有 originalRole，否则到期降级永不触发
        // （expireRoleDowngrades 候选查询要求 originalRole:{not:null}）。校验最终生效值
        // （本次请求写入的 originalRole 优先，否则用库里现有值）。
        const finalOriginalRole =
          data.originalRole !== undefined
            ? (data.originalRole as string | null)
            : existing.originalRole;
        if (!finalOriginalRole) {
          return NextResponse.json(
            { error: '设置到期时间前必须先指定原始用户组（到期回退目标）' },
            { status: 400 }
          );
        }
        data.roleExpiresAt = d;
      }
    }

    // 自定义用户组分配
    if (fields.customGroupId !== undefined) {
      if (fields.customGroupId === null || fields.customGroupId === '') {
        // 清除自定义组，恢复角色默认配额（U46：从 SiteSetting.group_config_<role> 解析）
        data.customGroupId = null;
        const role = (data.role as string) || existing.role;
        const defaults = await resolveRoleQuotas(role as 'ADMIN' | 'PRO' | 'FREE');
        data.allowedModels = defaults.allowedModels;
        data.transcriptionMinutesLimit = defaults.transcriptionMinutesLimit;
        data.storageHoursLimit = defaults.storageHoursLimit;
        // 字节上限也回到角色默认（从 SiteSetting 解析）
        data.storageBytesLimit = await resolveRoleStorageBytesLimit(
          role as 'ADMIN' | 'PRO' | 'FREE'
        );
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
        // 字节上限按用户角色解析（自定义组沿用其底层角色的字节配额）
        data.storageBytesLimit = await resolveRoleStorageBytesLimit(
          ((data.role as string) || existing.role) as 'ADMIN' | 'PRO' | 'FREE'
        );
      }
    }

    // C1：仅改内置角色、且本次未设置/未处于自定义组时，同步回填角色默认配额。
    // 否则用户 role 变了但 transcription/storage/models/bytes 上限仍停留在旧角色值，
    // 配额执行读的是这些列，导致升级不放宽、降级不收紧且无任何路径自愈。
    // 放在 customGroupId 分支之后：若本次分配了自定义组，则组配额已写入 data，此处不覆盖
    // （data.transcriptionMinutesLimit 已存在即跳过）；清除自定义组分支同样已回填，亦跳过。
    if (
      fields.role !== undefined &&
      data.transcriptionMinutesLimit === undefined &&
      data.customGroupId === undefined &&
      existing.customGroupId === null
    ) {
      const newRole = data.role as 'ADMIN' | 'PRO' | 'FREE';
      // U46：角色默认配额从 SiteSetting.group_config_<role> 解析（缺失回落硬编码默认）
      const defaults = await resolveRoleQuotas(newRole);
      data.allowedModels = defaults.allowedModels;
      data.transcriptionMinutesLimit = defaults.transcriptionMinutesLimit;
      data.storageHoursLimit = defaults.storageHoursLimit;
      data.storageBytesLimit = await resolveRoleStorageBytesLimit(newRole);
    }

    // 单用户配额直接覆盖（放在 group/role 分支之后，故显式传入的上限恒覆盖组/角色派生的默认值）。
    // 注意：这是「脱离用户组」的个体覆盖——之后若再编辑该用户所属的系统组/自定义组，updateMany
    // 会把此覆盖一并刷回组配置值（前端已就此提示 admin）。转录分钟取整、存储小时保留浮点。
    if (fields.transcriptionMinutesLimit !== undefined) {
      const raw = Number(fields.transcriptionMinutesLimit);
      if (!Number.isFinite(raw) || raw < 0) {
        return NextResponse.json(
          { error: '转录时长上限必须为非负数值' },
          { status: 400 }
        );
      }
      data.transcriptionMinutesLimit = Math.floor(raw);
    }

    if (fields.storageHoursLimit !== undefined) {
      const raw = Number(fields.storageHoursLimit);
      if (!Number.isFinite(raw) || raw < 0) {
        return NextResponse.json(
          { error: '存储时长上限必须为非负数值' },
          { status: 400 }
        );
      }
      data.storageHoursLimit = raw;
    }

    // 一键重置本月已用转录时长。仅清零已用量列，不动 quotaResetAt（下次月度重置点不变）。
    // 存储用量不可在此重置（它是 SUM(session.durationMs) 的实时占用，只随删录音回落）。
    if (fields.resetTranscriptionUsage === true) {
      data.transcriptionMinutesUsed = 0;
    }

    // 充值系统（Model A）：若本次下调了转录分钟上限（角色/组/显式覆盖任一路径已写入 data），
    // 先按旧上限结算持池用户的时长池并整周期重置，避免下次月度重置误扣/清零池子、或对账虚报 drift。
    if (
      typeof data.transcriptionMinutesLimit === 'number' &&
      existing.purchasedMinutesBalance > 0 &&
      data.transcriptionMinutesLimit < existing.transcriptionMinutesLimit
    ) {
      await settlePoolOnLimitChange(
        userId,
        existing.transcriptionMinutesLimit,
        data.transcriptionMinutesLimit
      );
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: '没有需要更新的字段' }, { status: 400 });
    }

    const user = await prisma.$transaction(async (tx) => {
      // 管理员代改密码与自助改密同源：不作废未消费的邮件令牌，一封没用过的重置链接
      // 就能在 1h 内把管理员刚设的密码改掉（tokenVersion++ 踢掉的会话拦不住它）。
      if (data.passwordHash !== undefined) {
        await invalidateUserEmailTokens(userId, { db: tx });
      }
      return tx.user.update({
        where: { id: userId },
        data,
        select: USER_SELECT,
      });
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
