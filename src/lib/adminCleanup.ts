/**
 * Admin 清理工具：把前端选择的"类别 / 状态 / 年龄"翻译成可以安全交给
 * Prisma deleteMany 的精确 where 子句。所有"永不删"白名单都集中在这里，
 * 同时被 DELETE / preview handler 共用。
 */

import { JOB_STATUS, JOB_TYPE, type JobStatus } from '@/lib/jobQueue';

// ─── Job Queue ────────────────────────────────────────────

/** 在飞的状态绝不删 — 删了会丢任务。 */
export const NEVER_DELETE_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  JOB_STATUS.SUBMITTED,
  JOB_STATUS.PENDING,
  JOB_STATUS.PROCESSING,
]);

/** 允许清理的 job 状态。 */
export const ALLOWED_CLEANUP_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  JOB_STATUS.SUCCESS,
  JOB_STATUS.FAILED,
]);

/** 已知的 job type 白名单。 */
export const KNOWN_JOB_TYPES: ReadonlySet<string> = new Set(Object.values(JOB_TYPE));

export const JOB_CLEANUP_DAYS_MIN = 1;
export const JOB_CLEANUP_DAYS_MAX = 365;

export interface JobCleanupParams {
  statuses: string[];
  olderThanDays: number;
  type?: string;
}

export interface JobCleanupValidation {
  ok: boolean;
  error?: string;
  statuses: JobStatus[];
  olderThanDays: number;
  type?: string;
}

/**
 * 把入参校验为可安全传给 prisma 的字段。失败会返回带 error 的对象，
 * 让 handler 直接返回 400。
 */
export function validateJobCleanupParams(raw: JobCleanupParams): JobCleanupValidation {
  if (!Array.isArray(raw.statuses) || raw.statuses.length === 0) {
    return {
      ok: false,
      error: '必须至少指定一个状态',
      statuses: [],
      olderThanDays: 0,
    };
  }

  // 状态白名单：含任意 in-flight 状态都拒绝。
  const seen = new Set<string>();
  const normalized: JobStatus[] = [];
  for (const status of raw.statuses) {
    if (typeof status !== 'string') {
      return {
        ok: false,
        error: '状态必须是字符串',
        statuses: [],
        olderThanDays: 0,
      };
    }
    if (NEVER_DELETE_JOB_STATUSES.has(status as JobStatus)) {
      return {
        ok: false,
        error: `不允许清理进行中的任务状态：${status}`,
        statuses: [],
        olderThanDays: 0,
      };
    }
    if (!ALLOWED_CLEANUP_JOB_STATUSES.has(status as JobStatus)) {
      return {
        ok: false,
        error: `未知状态：${status}`,
        statuses: [],
        olderThanDays: 0,
      };
    }
    if (!seen.has(status)) {
      seen.add(status);
      normalized.push(status as JobStatus);
    }
  }

  const days = Number(raw.olderThanDays);
  if (!Number.isInteger(days) || days < JOB_CLEANUP_DAYS_MIN || days > JOB_CLEANUP_DAYS_MAX) {
    return {
      ok: false,
      error: `olderThanDays 必须为 ${JOB_CLEANUP_DAYS_MIN}–${JOB_CLEANUP_DAYS_MAX} 之间的整数`,
      statuses: [],
      olderThanDays: 0,
    };
  }

  let type: string | undefined;
  if (raw.type !== undefined && raw.type !== null && raw.type !== '') {
    if (typeof raw.type !== 'string' || !KNOWN_JOB_TYPES.has(raw.type)) {
      return {
        ok: false,
        error: `未知任务类型：${raw.type}`,
        statuses: [],
        olderThanDays: 0,
      };
    }
    type = raw.type;
  }

  return {
    ok: true,
    statuses: normalized,
    olderThanDays: days,
    type,
  };
}

// ─── Audit Log ─────────────────────────────────────────────

export const AUDIT_LOG_CATEGORIES = ['session', 'share', 'login', 'system'] as const;
export type AuditLogCategory = (typeof AUDIT_LOG_CATEGORIES)[number];

/**
 * 类别 → 具体 action 名（精确匹配，绝不使用 startsWith — 避免误伤
 * `admin.session.read` 之类的敏感日志）。
 */
const CATEGORY_TO_ACTIONS: Record<AuditLogCategory, readonly string[]> = {
  session: ['session.create', 'session.finalize'],
  share: ['share.create', 'share.revoke', 'share.view', 'share.transition_playback'],
  login: ['user.login', 'user.logout'],
  system: ['system.start'],
};

/**
 * 后端硬白名单：永不删除的 action 前缀 / 完整名。
 * 注意：login.failed 也会单独保留（安全审计需要），所以 login 类只展开为
 * login + logout 两个具体值。register / password.change 完全不在任何类别里。
 */
export const NEVER_DELETE_ACTION_PREFIXES = [
  'admin.',
  'user.register',
  'user.password.change',
  'user.login.failed',
] as const;

export const AUDIT_LOG_DAYS_MIN = 30;
export const AUDIT_LOG_DAYS_MAX = 730;

export interface AuditLogCleanupParams {
  actionCategories: string[];
  olderThanDays: number;
}

export interface AuditLogCleanupValidation {
  ok: boolean;
  error?: string;
  actions: string[];
  olderThanDays: number;
  categories: AuditLogCategory[];
}

/**
 * 把类别列表展开为具体可删的 action 名数组。已去重。
 */
export function expandCategoriesToActions(categories: AuditLogCategory[]): string[] {
  const out = new Set<string>();
  for (const cat of categories) {
    for (const action of CATEGORY_TO_ACTIONS[cat]) {
      // 双重保险：任何不小心混进类别表的"永不删"项都会被这里挡掉。
      if (!isNeverDeleteAction(action)) {
        out.add(action);
      }
    }
  }
  return Array.from(out).sort();
}

/**
 * 判定一个 action 是否在"永不删"白名单内。用前缀匹配，因为 admin.* 是
 * 整个家族禁删。
 */
export function isNeverDeleteAction(action: string): boolean {
  return NEVER_DELETE_ACTION_PREFIXES.some((prefix) =>
    prefix.endsWith('.') ? action.startsWith(prefix) : action === prefix
  );
}

export function validateAuditLogCleanupParams(
  raw: AuditLogCleanupParams
): AuditLogCleanupValidation {
  if (!Array.isArray(raw.actionCategories) || raw.actionCategories.length === 0) {
    return {
      ok: false,
      error: '必须至少指定一个操作类别',
      actions: [],
      olderThanDays: 0,
      categories: [],
    };
  }

  const seen = new Set<string>();
  const categories: AuditLogCategory[] = [];
  for (const cat of raw.actionCategories) {
    if (typeof cat !== 'string' || !AUDIT_LOG_CATEGORIES.includes(cat as AuditLogCategory)) {
      return {
        ok: false,
        error: `未知操作类别：${cat}`,
        actions: [],
        olderThanDays: 0,
        categories: [],
      };
    }
    if (!seen.has(cat)) {
      seen.add(cat);
      categories.push(cat as AuditLogCategory);
    }
  }

  const days = Number(raw.olderThanDays);
  if (!Number.isInteger(days) || days < AUDIT_LOG_DAYS_MIN || days > AUDIT_LOG_DAYS_MAX) {
    return {
      ok: false,
      error: `olderThanDays 必须为 ${AUDIT_LOG_DAYS_MIN}–${AUDIT_LOG_DAYS_MAX} 之间的整数`,
      actions: [],
      olderThanDays: 0,
      categories: [],
    };
  }

  const actions = expandCategoriesToActions(categories);
  if (actions.length === 0) {
    return {
      ok: false,
      error: '类别展开后没有可删除的 action',
      actions: [],
      olderThanDays: 0,
      categories: [],
    };
  }

  return {
    ok: true,
    actions,
    olderThanDays: days,
    categories,
  };
}

// ─── 共用：把天数变成 cutoff Date ───────────────────────────

export function olderThanDaysToCutoff(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}
