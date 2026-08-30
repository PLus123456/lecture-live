import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import {
  coerceSummaryModelId,
  resolveRoleQuotas,
  resolveCustomGroupPermissions,
  type GroupPermissions,
} from '@/lib/userRoles';
import { writeSecurityAudit } from '@/lib/securityAudit';

// 支持按组绑定模型的用途（关键词/嵌入全局统一，不按组）
const GROUP_BINDABLE_PURPOSES = [
  'CHAT',
  'REALTIME_SUMMARY',
  'FINAL_SUMMARY',
  'TRANSLATION',
] as const;
type GroupBindablePurpose = (typeof GROUP_BINDABLE_PURPOSES)[number];

/** 用途 → 组配置字段名 */
const PURPOSE_FIELD: Record<GroupBindablePurpose, string> = {
  CHAT: 'chatModelId',
  REALTIME_SUMMARY: 'realtimeSummaryModelId',
  FINAL_SUMMARY: 'finalSummaryModelId',
  TRANSLATION: 'translationModelId',
};

// 可按组绑定的系统角色。ADMIN 恒跟随全局默认（resolveUser* 对 ADMIN 短路），不暴露绑定入口。
const BINDABLE_ROLES = ['FREE', 'PRO'] as const;

interface GroupModelBinding {
  /** 'FREE' | 'PRO' | 'custom:<id>' */
  key: string;
  name: string;
  isCustom: boolean;
  color?: string;
  chatModelId: string;
  realtimeSummaryModelId: string;
  finalSummaryModelId: string;
  translationModelId: string;
  // ── 与用户组编辑弹窗同源的上下文（决定绑定项在按组视图里怎么展示）──
  /** 该组聊天可用模型（'*' 或逗号分隔 token；与运行时 access.ts 同一匹配口径） */
  allowedModels: string;
  /** 组能力开关：关了则对应摘要/翻译绑定是死配置，UI 必须禁用 */
  allowRealtimeSummary: boolean;
  allowFinalSummary: boolean;
  allowTextTranslation: boolean;
  allowDocTranslation: boolean;
}

class GroupModelRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'GroupModelRequestError';
  }
}

/** 从运行时解析器的结果抽出按组视图需要的字段（绑定 + 可用模型 + 能力开关） */
function fromPermissions(perms: GroupPermissions) {
  return {
    chatModelId: coerceSummaryModelId(perms.chatModelId),
    realtimeSummaryModelId: coerceSummaryModelId(perms.realtimeSummaryModelId),
    finalSummaryModelId: coerceSummaryModelId(perms.finalSummaryModelId),
    translationModelId: coerceSummaryModelId(perms.translationModelId),
    allowedModels: perms.allowedModels,
    allowRealtimeSummary: perms.allowRealtimeSummary,
    allowFinalSummary: perms.allowFinalSummary,
    allowTextTranslation: perms.allowTextTranslation,
    allowDocTranslation: perms.allowDocTranslation,
  };
}

/**
 * GET /api/admin/llm-group-models
 * 返回每个用户组（系统 FREE/PRO + 自定义组）的用途模型绑定 + 生效上下文（可用模型/能力开关），
 * 供 LLM 设置页「按会员组」视图用。
 *
 * 组配置一律经 userRoles 的运行时解析器（resolveRoleQuotas / resolveCustomGroupPermissions）取，
 * 与 access.ts / 摘要门禁看到的完全同一份语义 —— 保证这页展示的就是运行时真正生效的值，
 * 不与「用户组」面板产生两套口径。ADMIN 恒跟随全局（解析器对 ADMIN 短路），不出现在列表里。
 */
export async function GET(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-group-models:list',
    limit: 60,
  });
  if (response || !admin) {
    return response ?? NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  try {
    const groups: GroupModelBinding[] = [];

    for (const role of BINDABLE_ROLES) {
      const perms = await resolveRoleQuotas(role);
      groups.push({
        key: role,
        // 与 /api/admin/groups 的系统组命名一致（Free/Pro），两个面板显示同名
        name: role === 'FREE' ? 'Free' : 'Pro',
        isCustom: false,
        ...fromPermissions(perms),
      });
    }

    const customRow = await prisma.siteSetting.findUnique({
      where: { key: 'custom_groups' },
    });
    if (customRow) {
      try {
        const arr = JSON.parse(customRow.value);
        if (Array.isArray(arr)) {
          for (const entry of arr) {
            if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
              continue;
            }
            // 名称/颜色取自条目本身；权限走与运行时相同的解析器（含字段级兜底）。
            // permissions 字段缺失/损坏时解析器返回 null（运行时会回落底层角色），
            // 这里按「无绑定 + 全部允许」展示，组本身仍要出现在列表里。
            const perms = (await resolveCustomGroupPermissions(entry.id)) ?? {
              transcriptionMinutesLimit: 60,
              storageHoursLimit: 10,
              allowedModels: 'local',
              maxThinkingDepth: 'high' as const,
              allowRealtimeSummary: true,
              allowFinalSummary: true,
              allowAudioEnhance: false,
              allowTextTranslation: true,
              allowDocTranslation: false,
            };
            groups.push({
              key: `custom:${entry.id}`,
              name: typeof entry.name === 'string' ? entry.name : entry.id,
              isCustom: true,
              color: typeof entry.color === 'string' ? entry.color : undefined,
              ...fromPermissions(perms),
            });
          }
        }
      } catch {
        // 脏 custom_groups 直接忽略（GET 只影响展示）
      }
    }

    await writeSecurityAudit(req, {
      event: 'llm-group-models.read',
      operator: { id: admin.id, email: admin.email, role: admin.role },
      target: {
        type: 'llm_group_model_collection',
        ids: groups.map((group) => group.key),
      },
      after: {
        groupCount: groups.length,
        customGroupCount: groups.filter((group) => group.isCustom).length,
      },
      reason: 'admin_list',
      outcome: 'SUCCESS',
    });
    return NextResponse.json({ groups });
  } catch (err) {
    console.error('获取用户组模型绑定失败:', err);
    return NextResponse.json({ error: '获取失败' }, { status: 500 });
  }
}

/**
 * PUT /api/admin/llm-group-models
 * 更新某个组某个用途的模型绑定。body: { groupKey, purpose, modelId }
 * modelId 空串 = 跟随全局默认；非空时校验该路由行存在且用途匹配。
 * 只读改写组配置里的绑定字段，不动配额（配额走 /api/admin/groups）。
 */
export async function PUT(req: Request) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-group-models:update',
    limit: 60,
    windowMs: 10 * 60_000,
  });
  if (response || !admin) {
    return response ?? NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const groupKey = typeof body.groupKey === 'string' ? body.groupKey : '';
    const purpose = body.purpose as GroupBindablePurpose;
    const modelId = coerceSummaryModelId(body.modelId);

    if (!GROUP_BINDABLE_PURPOSES.includes(purpose)) {
      return NextResponse.json(
        { error: `purpose 非法（允许值: ${GROUP_BINDABLE_PURPOSES.join(', ')}）` },
        { status: 400 }
      );
    }

    const field = PURPOSE_FIELD[purpose];
    const isSystemGroup = (BINDABLE_ROLES as readonly string[]).includes(groupKey);
    const isCustomGroup = groupKey.startsWith('custom:');
    if (!isSystemGroup && !isCustomGroup) {
      return NextResponse.json({ error: 'groupKey 非法' }, { status: 400 });
    }

    await prisma.$transaction(async (tx) => {
      // 非空绑定必须在同一事务内确认用途，避免校验后被并发删除仍写入悬空绑定。
      if (modelId) {
        const route = await tx.llmModel.findUnique({ where: { id: modelId } });
        if (!route || route.purpose !== purpose) {
          throw new GroupModelRequestError('模型不存在或未挂载到该用途', 400);
        }
      }

      let previousModelId = '';
      if (isSystemGroup) {
        const key = `group_config_${groupKey}`;
        const row = await tx.siteSetting.findUnique({ where: { key } });
        let cfg: Record<string, unknown> = {};
        if (row) {
          try {
            const parsed = JSON.parse(row.value);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              cfg = parsed as Record<string, unknown>;
            }
          } catch {
            // 脏配置：重建为仅含绑定字段的对象，其余字段回落默认。
          }
        }
        previousModelId = coerceSummaryModelId(cfg[field]);
        cfg[field] = modelId;
        await tx.siteSetting.upsert({
          where: { key },
          update: { value: JSON.stringify(cfg) },
          create: { key, value: JSON.stringify(cfg) },
        });
      } else {
        const groupId = groupKey.slice('custom:'.length);
        const row = await tx.siteSetting.findUnique({
          where: { key: 'custom_groups' },
        });
        if (!row) throw new GroupModelRequestError('用户组不存在', 404);
        let arr: unknown;
        try {
          arr = JSON.parse(row.value);
        } catch {
          throw new GroupModelRequestError('用户组配置损坏', 500);
        }
        if (!Array.isArray(arr)) {
          throw new GroupModelRequestError('用户组不存在', 404);
        }
        const entry = arr.find(
          (group): group is { id: string; permissions?: Record<string, unknown> } =>
            Boolean(group) &&
            typeof group === 'object' &&
            (group as { id?: unknown }).id === groupId
        );
        if (!entry) throw new GroupModelRequestError('用户组不存在', 404);
        if (!entry.permissions || typeof entry.permissions !== 'object') {
          entry.permissions = {};
        }
        previousModelId = coerceSummaryModelId(entry.permissions[field]);
        entry.permissions[field] = modelId;
        await tx.siteSetting.update({
          where: { key: 'custom_groups' },
          data: { value: JSON.stringify(arr) },
        });
      }

      await writeSecurityAudit(
        req,
        {
          event: 'llm-group-models.update',
          operator: { id: admin.id, email: admin.email, role: admin.role },
          target: { type: 'llm_group_model_binding', id: groupKey },
          before: { purpose, modelId: previousModelId || null },
          after: { purpose, modelId: modelId || null },
          reason: 'admin_update_binding',
          outcome: 'SUCCESS',
        },
        tx
      );
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof GroupModelRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('更新用户组模型绑定失败:', err);
    return NextResponse.json({ error: '更新失败' }, { status: 500 });
  }
}
