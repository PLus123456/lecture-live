import type { UserRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSiteSettings } from '@/lib/siteSettings';

export function normalizeUserRole(
  value: unknown,
  fallback: UserRole = 'FREE'
): UserRole {
  if (value === 'ADMIN' || value === 'PRO' || value === 'FREE') {
    return value;
  }
  return fallback;
}

export function resolvePublicRegistrationRole(value: unknown): UserRole {
  return value === 'PRO' ? 'PRO' : 'FREE';
}

/**
 * 用户组"最大思考深度"上限。
 *  'off'    - 该组禁止使用思考（DEPTH 模型的思考档位全部隐藏；服务端强制 thinkingPreference='off'）
 *  'low'/'medium'/'high' - 允许思考，但深度不超过此档
 * 说明：FORCED 模式的模型（模型自带思考、无法关闭）不受深度上限约束，只能通过 allowedModels
 *       不授权该模型来阻止；深度上限仅作用于 DEPTH 模型的可选档位。
 */
export type ThinkingDepthCap = 'off' | 'low' | 'medium' | 'high';

export const THINKING_DEPTH_CAPS: readonly ThinkingDepthCap[] = [
  'off',
  'low',
  'medium',
  'high',
];

/** 各思考深度档的排序权重，用于「不超过上限」的比较 */
const THINKING_DEPTH_RANK: Record<ThinkingDepthCap, number> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export interface GroupPermissions {
  transcriptionMinutesLimit: number;
  storageHoursLimit: number;
  allowedModels: string;
  maxConcurrentSessions?: number;
  // ── 能力开关（与用户组绑定）──
  /** 最大思考深度上限，'off' 表示该组禁止思考 */
  maxThinkingDepth: ThinkingDepthCap;
  /** 是否允许使用实时摘要 */
  allowRealtimeSummary: boolean;
  /** 是否允许使用总摘要（结束时的结构化报告） */
  allowFinalSummary: boolean;
  /** 是否允许录音音频增强（外部 worker 后处理）。与其它开关不同：新重资源功能，缺省禁止 */
  allowAudioEnhance: boolean;
  // ── 用途专用模型（与用户组绑定）──
  // 存的是 LlmModel 的 DB id（路由行）；空串/缺省 = 「跟随全局默认」（该用途 isDefault 的模型）。
  // 与 allowedModels 不同：allowedModels 只作用于聊天选择器，这几个才决定各用途实际用哪个模型。
  /** 该组实时摘要使用的模型 id（空 = 跟随全局 REALTIME_SUMMARY 默认） */
  realtimeSummaryModelId?: string;
  /** 该组总摘要使用的模型 id（空 = 跟随全局 FINAL_SUMMARY 默认） */
  finalSummaryModelId?: string;
  /** 该组聊天的默认模型 id（用户未显式选模型时用；空 = 跟随全局 CHAT 默认） */
  chatModelId?: string;
}

/** 某用户在运行时生效的能力开关（由所属组解析而来，组配置为唯一真源） */
export interface EffectiveFeatureFlags {
  maxThinkingDepth: ThinkingDepthCap;
  allowRealtimeSummary: boolean;
  allowFinalSummary: boolean;
  allowAudioEnhance: boolean;
}

/** 某用户在运行时生效的摘要模型（由所属组解析而来）；null = 跟随全局该用途默认 */
export interface EffectiveSummaryModels {
  realtimeSummaryModelId: string | null;
  finalSummaryModelId: string | null;
}

/**
 * 清洗「摘要模型 id」。存的是 LlmModel 的 DB 主键（cuid/uuid 形态，字符集
 * `[A-Za-z0-9_-]`）。空串或非法值一律回落 '' —— 表示「跟随全局默认」。
 */
export function coerceSummaryModelId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : '';
}

/** 把任意值强制成合法的 ThinkingDepthCap，非法时回落 fallback */
export function coerceThinkingDepthCap(
  value: unknown,
  fallback: ThinkingDepthCap
): ThinkingDepthCap {
  return typeof value === 'string' &&
    (THINKING_DEPTH_CAPS as readonly string[]).includes(value)
    ? (value as ThinkingDepthCap)
    : fallback;
}

/** 把请求的思考深度按组上限收紧（返回不超过 cap 的档位）。cap='off' 恒返回 'off' */
export function clampDepthToCap(
  requested: ThinkingDepthCap,
  cap: ThinkingDepthCap
): ThinkingDepthCap {
  return THINKING_DEPTH_RANK[requested] <= THINKING_DEPTH_RANK[cap]
    ? requested
    : cap;
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 各角色 chat 字节配额的静态兜底（MB）——与 siteSettings 的 chat_files_quota_*_mb 默认一致。
 *  真实生效值由 admin 在 SiteSetting 配置，通过 resolveRoleStorageBytesLimit 读取。 */
const DEFAULT_ROLE_STORAGE_BYTES_MB: Record<UserRole, number> = {
  ADMIN: 10240,
  PRO: 1024,
  FREE: 100,
};

const MB = 1024 * 1024;

export function getDefaultQuotasForRole(role: UserRole): GroupPermissions {
  switch (role) {
    case 'ADMIN':
      return {
        transcriptionMinutesLimit: 999999,
        storageHoursLimit: 999999,
        allowedModels: '*',
        maxConcurrentSessions: 999,
        maxThinkingDepth: 'high',
        allowRealtimeSummary: true,
        allowFinalSummary: true,
        allowAudioEnhance: true,
      };
    case 'PRO':
      return {
        transcriptionMinutesLimit: 600,
        storageHoursLimit: 100,
        allowedModels: 'local,gpt,deepseek',
        maxConcurrentSessions: 3,
        maxThinkingDepth: 'high',
        allowRealtimeSummary: true,
        allowFinalSummary: true,
        // 音频增强吃独立 worker 的算力，默认不放开，由管理员按组显式开启
        allowAudioEnhance: false,
      };
    default:
      return {
        transcriptionMinutesLimit: 60,
        storageHoursLimit: 10,
        allowedModels: 'local',
        maxConcurrentSessions: 1,
        // 保留 FREE 历史行为：思考深度封顶 medium（原 access.ts/models 里的硬编码 FREE 限制）。
        // 实时/总摘要默认允许，符合「未配置组默认全部允许、上线不改变现状」。
        maxThinkingDepth: 'medium',
        allowRealtimeSummary: true,
        allowFinalSummary: true,
        allowAudioEnhance: false,
      };
  }
}

/** 并发录音上限的合理下限/兜底（任何组至少允许 1 个在途录音） */
const MIN_CONCURRENT_SESSIONS = 1;

/** 把任意值收敛成合法的并发上限（≥1 的整数），非法回落 fallback */
function coerceConcurrentSessions(value: unknown, fallback: number): number {
  const n = Number(value);
  if (Number.isFinite(n) && n >= MIN_CONCURRENT_SESSIONS) {
    return Math.floor(n);
  }
  return fallback;
}

/**
 * U46：从 SiteSetting.group_config_<role> 解析某系统角色的配额（转录分钟/存储小时/模型），
 * 缺失或字段非法时逐项回落 getDefaultQuotasForRole 的硬编码默认值。
 *
 * 背景：admin 在用户组面板改系统组配额时（PUT /api/admin/groups），只对现有用户做一次性
 * updateMany，并把配置写进 group_config_<role>。但注册/到期降级/删组恢复/建用户等所有
 * 后续配额赋值路径此前都直接调 getDefaultQuotasForRole 读硬编码默认值，导致 admin 配置对
 * 新用户及任何配额重置形同虚设。此 resolver 让 group_config_<role> 成为真正生效来源，
 * 与已正确读 SiteSetting 的 resolveRoleStorageBytesLimit 对齐。
 *
 * 只覆盖系统角色（FREE/PRO/ADMIN）。自定义组配额另经 custom_groups 存储，不走此路径。
 */
export async function resolveRoleQuotas(role: UserRole): Promise<GroupPermissions> {
  const defaults = getDefaultQuotasForRole(role);
  const row = await prisma.siteSetting.findUnique({
    where: { key: `group_config_${role}` },
  });
  if (!row) {
    return defaults;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return defaults;
  }
  if (!parsed || typeof parsed !== 'object') {
    return defaults;
  }
  const cfg = parsed as Record<string, unknown>;

  // 逐项校验：仅当为有限非负数值/合法字符串时才覆盖，否则回落默认（防御性，避免脏配置污染配额）
  const transcriptionMinutesLimit =
    typeof cfg.transcriptionMinutesLimit === 'number' &&
    Number.isFinite(cfg.transcriptionMinutesLimit) &&
    cfg.transcriptionMinutesLimit >= 0
      ? Math.floor(cfg.transcriptionMinutesLimit)
      : defaults.transcriptionMinutesLimit;
  const storageHoursLimit =
    typeof cfg.storageHoursLimit === 'number' &&
    Number.isFinite(cfg.storageHoursLimit) &&
    cfg.storageHoursLimit >= 0
      ? cfg.storageHoursLimit
      : defaults.storageHoursLimit;
  const allowedModels =
    typeof cfg.allowedModels === 'string' && cfg.allowedModels.trim()
      ? cfg.allowedModels.trim()
      : defaults.allowedModels;

  return {
    transcriptionMinutesLimit,
    storageHoursLimit,
    allowedModels,
    maxConcurrentSessions: coerceConcurrentSessions(
      cfg.maxConcurrentSessions,
      defaults.maxConcurrentSessions ?? MIN_CONCURRENT_SESSIONS
    ),
    maxThinkingDepth: coerceThinkingDepthCap(
      cfg.maxThinkingDepth,
      defaults.maxThinkingDepth
    ),
    allowRealtimeSummary: coerceBool(
      cfg.allowRealtimeSummary,
      defaults.allowRealtimeSummary
    ),
    allowFinalSummary: coerceBool(
      cfg.allowFinalSummary,
      defaults.allowFinalSummary
    ),
    allowAudioEnhance: coerceBool(
      cfg.allowAudioEnhance,
      defaults.allowAudioEnhance
    ),
    realtimeSummaryModelId: coerceSummaryModelId(cfg.realtimeSummaryModelId),
    finalSummaryModelId: coerceSummaryModelId(cfg.finalSummaryModelId),
    chatModelId: coerceSummaryModelId(cfg.chatModelId),
  };
}

/**
 * 读取某自定义用户组的权限配置（从 SiteSetting.custom_groups 数组按 id 查找）。
 * 未找到（组不存在/已删除）返回 null，由调用方回落底层角色。
 *
 * 能力开关缺失时默认「全部允许」（maxThinkingDepth='high'、两摘要=true），符合
 * 「未配置的组默认全部允许，上线不改变现状」。配额字段沿用与 groups 路由一致的兜底。
 */
export async function resolveCustomGroupPermissions(
  groupId: string
): Promise<GroupPermissions | null> {
  const row = await prisma.siteSetting.findUnique({
    where: { key: 'custom_groups' },
  });
  if (!row) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const entry = arr.find(
    (g): g is { id: string; permissions?: unknown } =>
      Boolean(g) &&
      typeof g === 'object' &&
      (g as { id?: unknown }).id === groupId
  );
  if (!entry || !entry.permissions || typeof entry.permissions !== 'object') {
    return null;
  }
  const cfg = entry.permissions as Record<string, unknown>;

  const rawMinutes = Number(cfg.transcriptionMinutesLimit);
  const rawStorageHours = Number(cfg.storageHoursLimit);
  const rawConcurrent = Number(cfg.maxConcurrentSessions);
  return {
    transcriptionMinutesLimit: Math.max(
      0,
      Math.floor(Number.isFinite(rawMinutes) ? rawMinutes : 60)
    ),
    storageHoursLimit: Math.max(
      0,
      Number.isFinite(rawStorageHours) ? rawStorageHours : 10
    ),
    allowedModels:
      typeof cfg.allowedModels === 'string' && cfg.allowedModels.trim()
        ? cfg.allowedModels.trim()
        : 'local',
    maxConcurrentSessions: Math.max(
      1,
      Math.floor(Number.isFinite(rawConcurrent) ? rawConcurrent : 1)
    ),
    maxThinkingDepth: coerceThinkingDepthCap(cfg.maxThinkingDepth, 'high'),
    allowRealtimeSummary: coerceBool(cfg.allowRealtimeSummary, true),
    allowFinalSummary: coerceBool(cfg.allowFinalSummary, true),
    // 与其它开关的「缺省全开」相反：音频增强为新重资源功能，缺省禁止
    allowAudioEnhance: coerceBool(cfg.allowAudioEnhance, false),
    realtimeSummaryModelId: coerceSummaryModelId(cfg.realtimeSummaryModelId),
    finalSummaryModelId: coerceSummaryModelId(cfg.finalSummaryModelId),
    chatModelId: coerceSummaryModelId(cfg.chatModelId),
  };
}

/**
 * 解析某用户运行时生效的能力开关（思考深度上限 / 实时摘要 / 总摘要）。
 *
 * 解析顺序：ADMIN 恒全开 → 有自定义组则读 custom_groups → 否则读系统角色 group_config_<role>
 * （其默认见 getDefaultQuotasForRole）。组配置是唯一真源，不落 User 行，避免"改组后用户行
 * 仍是旧值"的漂移。SiteSetting 有 60s 内存缓存，此处开销很低。
 */
export async function resolveUserFeatureFlags(user: {
  role: UserRole;
  customGroupId?: string | null;
}): Promise<EffectiveFeatureFlags> {
  // ADMIN 视为无限（与配额哨兵、allowedModels='*' 同口径）
  if (user.role === 'ADMIN') {
    return {
      maxThinkingDepth: 'high',
      allowRealtimeSummary: true,
      allowFinalSummary: true,
      allowAudioEnhance: true,
    };
  }

  if (user.customGroupId) {
    const custom = await resolveCustomGroupPermissions(user.customGroupId);
    if (custom) {
      return {
        maxThinkingDepth: custom.maxThinkingDepth,
        allowRealtimeSummary: custom.allowRealtimeSummary,
        allowFinalSummary: custom.allowFinalSummary,
        allowAudioEnhance: custom.allowAudioEnhance,
      };
    }
    // 自定义组不存在 → 回落底层角色配置
  }

  const roleQuotas = await resolveRoleQuotas(user.role);
  return {
    maxThinkingDepth: roleQuotas.maxThinkingDepth,
    allowRealtimeSummary: roleQuotas.allowRealtimeSummary,
    allowFinalSummary: roleQuotas.allowFinalSummary,
    allowAudioEnhance: roleQuotas.allowAudioEnhance,
  };
}

/**
 * 解析某用户运行时生效的「摘要专用模型」（实时摘要 / 总摘要各一个 DB model id）。
 *
 * 与 resolveUserFeatureFlags 同解析链：ADMIN 不绑定（跟随全局默认）→ 有自定义组读
 * custom_groups → 否则读系统角色 group_config_<role>。组配置为唯一真源，不落 User 行。
 * 返回 null 表示该用途「跟随全局默认」（gateway 按 purpose 取 isDefault 模型）。
 *
 * 注意：这里只解析出组配置的模型 id，不校验其是否仍存在；调用方经 resolveSummaryModel
 * 做存在性校验并在失效时回落全局默认，避免残留 id 拖垮摘要。
 */
export async function resolveUserSummaryModels(user: {
  role: UserRole;
  customGroupId?: string | null;
}): Promise<EffectiveSummaryModels> {
  // ADMIN 不绑定组摘要模型，一律跟随全局默认
  if (user.role === 'ADMIN') {
    return { realtimeSummaryModelId: null, finalSummaryModelId: null };
  }

  let perms: GroupPermissions | null = null;
  if (user.customGroupId) {
    perms = await resolveCustomGroupPermissions(user.customGroupId);
    // 自定义组不存在 → 回落底层角色配置
  }
  if (!perms) {
    perms = await resolveRoleQuotas(user.role);
  }

  return {
    realtimeSummaryModelId: perms.realtimeSummaryModelId?.trim() || null,
    finalSummaryModelId: perms.finalSummaryModelId?.trim() || null,
  };
}

/**
 * 解析某用户运行时生效的「组默认聊天模型」id（用户未显式选模型时用）。
 *
 * 与 resolveUserSummaryModels 同解析链：ADMIN 不绑定（跟随全局 CHAT 默认）→ 有自定义组读
 * custom_groups → 否则读系统角色 group_config_<role>。返回 null = 跟随全局默认。
 * 同样只解析 id、不校验存在性；调用方（access.ts）经 getModelById 校验，失效即回落全局默认。
 * 组绑定属于管理员决策，生效时绕过该用户 allowedModels 的门禁（与摘要模型同哲学）。
 */
export async function resolveUserDefaultChatModelId(user: {
  role: UserRole;
  customGroupId?: string | null;
}): Promise<string | null> {
  if (user.role === 'ADMIN') {
    return null;
  }

  let perms: GroupPermissions | null = null;
  if (user.customGroupId) {
    perms = await resolveCustomGroupPermissions(user.customGroupId);
    // 自定义组不存在 → 回落底层角色配置
  }
  if (!perms) {
    perms = await resolveRoleQuotas(user.role);
  }

  return perms.chatModelId?.trim() || null;
}

/**
 * 解析某用户运行时生效的「最大并发在途录音数」。
 *
 * 与 resolveUserFeatureFlags 同口径：ADMIN 恒无限 → 有自定义组读 custom_groups →
 * 否则读系统角色 group_config_<role>（默认见 getDefaultQuotasForRole）。组配置为唯一真源，
 * 让 admin 在用户组面板配的「最大并发会话数」在录制启动准入处真正生效（此前是死设置）。
 *
 * 返回值恒 ≥1。ADMIN 返回一个足够大的哨兵（与配额哨兵、maxConcurrentSessions=999 同口径），
 * 调用方对 ADMIN 也可直接跳过并发校验。
 */
export async function resolveUserMaxConcurrentSessions(user: {
  role: UserRole;
  customGroupId?: string | null;
}): Promise<number> {
  if (user.role === 'ADMIN') {
    return 999;
  }

  if (user.customGroupId) {
    const custom = await resolveCustomGroupPermissions(user.customGroupId);
    if (custom) {
      return coerceConcurrentSessions(
        custom.maxConcurrentSessions,
        MIN_CONCURRENT_SESSIONS
      );
    }
    // 自定义组不存在 → 回落底层角色配置
  }

  const roleQuotas = await resolveRoleQuotas(user.role);
  return coerceConcurrentSessions(
    roleQuotas.maxConcurrentSessions,
    MIN_CONCURRENT_SESSIONS
  );
}

/**
 * 从 SiteSetting 读取某角色的 chat 字节配额上限（字节，BigInt）。
 *
 * 这是把 admin 在「Chat 文件」面板配的 chat_files_quota_{free,pro,admin}_mb 真正
 * 落到 User.storageBytesLimit 的唯一来源。此前这三个值只存进 SiteSetting、从未
 * 推给任何用户，导致所有人被钉死在 schema 默认 100MB。
 */
export async function resolveRoleStorageBytesLimit(role: UserRole): Promise<bigint> {
  const settings = await getSiteSettings();
  const mb =
    role === 'ADMIN'
      ? settings.chat_files_quota_admin_mb
      : role === 'PRO'
        ? settings.chat_files_quota_pro_mb
        : settings.chat_files_quota_free_mb;
  const safeMb = Number.isFinite(mb) && mb >= 0 ? mb : DEFAULT_ROLE_STORAGE_BYTES_MB[role];
  return BigInt(Math.floor(safeMb)) * BigInt(MB);
}

/**
 * 将自定义用户组的配额同步到指定用户。
 * 字节配额按用户角色从 SiteSetting 解析（自定义组沿用其底层角色的字节上限）。
 */
export async function syncUserQuotas(userId: string, permissions: GroupPermissions) {
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  const storageBytesLimit = target
    ? await resolveRoleStorageBytesLimit(target.role)
    : undefined;
  await prisma.user.update({
    where: { id: userId },
    data: {
      allowedModels: permissions.allowedModels,
      transcriptionMinutesLimit: permissions.transcriptionMinutesLimit,
      storageHoursLimit: permissions.storageHoursLimit,
      ...(storageBytesLimit !== undefined && { storageBytesLimit }),
    },
  });
}

/**
 * 批量同步自定义组内所有用户的配额。
 * 字节配额按角色解析后逐角色 updateMany（自定义组成员可能跨角色）。
 */
export async function syncUsersOfCustomGroup(groupId: string, permissions: GroupPermissions) {
  await prisma.user.updateMany({
    where: { customGroupId: groupId },
    data: {
      allowedModels: permissions.allowedModels,
      transcriptionMinutesLimit: permissions.transcriptionMinutesLimit,
      storageHoursLimit: permissions.storageHoursLimit,
    },
  });
  // 字节上限按角色（FREE/PRO/ADMIN）分别回填
  for (const role of ['FREE', 'PRO', 'ADMIN'] as const) {
    const storageBytesLimit = await resolveRoleStorageBytesLimit(role);
    await prisma.user.updateMany({
      where: { customGroupId: groupId, role },
      data: { storageBytesLimit },
    });
  }
}
