export type AppUserRole = 'ADMIN' | 'PRO' | 'FREE';

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_AUDIO_ACTIVITY_LEVEL_THRESHOLD = 0.015;
export const QUOTA_WARNING_LEAD_MS = 2 * 60_000;

const MAX_SESSION_DURATION_BY_ROLE_MS: Record<Exclude<AppUserRole, 'ADMIN'>, number> = {
  FREE: 2 * 60 * 60_000,
  PRO: 4 * 60 * 60_000,
};

export function getMaxSessionDurationMs(role: AppUserRole): number | null {
  if (role === 'ADMIN') {
    return null;
  }

  return MAX_SESSION_DURATION_BY_ROLE_MS[role];
}

export function clampSessionDurationMs(
  durationMs: number,
  role: AppUserRole
): number {
  const normalizedDurationMs = Number.isFinite(durationMs)
    ? Math.max(0, Math.trunc(durationMs))
    : 0;
  const limitMs = getMaxSessionDurationMs(role);

  if (limitMs == null) {
    return normalizedDurationMs;
  }

  return Math.min(normalizedDurationMs, limitMs);
}

/**
 * 单场串流时长上限之上的宽限（mint 时长闸与结算共用同一个值）。
 *
 * 吸收诚实客户端「Soniox 串流量 > 录音计时」的正常差额：key 轮换 / 断线重连的交接、暂停后
 * 连接要过约 20s 才被 Soniox 断开，以及 mint 闸对尚未回填实测量的 grant 的保守估计。客户端在
 * 录音计时到达上限时自行收尾，正常录音碰不到「上限 + 宽限」。
 */
export const STREAM_DURATION_CAP_GRACE_MS = 15 * 60_000;

/**
 * 在「按单场上限封顶后的计费时长」之上，补收 Soniox 实测串流超出「上限 + 宽限」的部分。
 *
 * 单场上限（角色 2h/4h、同传 6h）保护诚实用户不被按超长的墙钟/内容时长计费；但 mint 闸只能按
 * 已回填的实测量与保守估计放行，并行多开的流要等 usage-logs 回填后才看得见。结算若把实测量也
 * 一并封顶，超出部分就成了白嫖。以「实测 − 宽限」作计费下限：实测不超过上限 + 宽限的诚实用户
 * 结果不变，多开或绕过客户端上限串流的，为超出部分付费。
 */
/**
 * 一组 SonioxStreamGrant 的实测串流毫秒合计，每条先封顶到自己的连接硬上限（Soniox 到点硬断，
 * 单条流不可能更长）。实测量参与计费下限（withMeasuredStreamFloorMs）之后，对账侧偶发的异常
 * 大值只能多算到「签出去的 key 合计可串的时长」为止。
 */
export function sumCappedStreamActualMs(
  rows: ReadonlyArray<{ actualMs: number | null; maxSessionSeconds: number }>
): number {
  return rows.reduce((totalMs, row) => {
    const actualMs = Math.max(0, Number(row.actualMs) || 0);
    const connectionCapMs = Math.max(0, Number(row.maxSessionSeconds) || 0) * 1000;
    return totalMs + Math.min(actualMs, connectionCapMs);
  }, 0);
}

export function withMeasuredStreamFloorMs(
  cappedDurationMs: number,
  measuredStreamMs: number
): number {
  const measuredMs = Number.isFinite(measuredStreamMs)
    ? Math.max(0, Math.trunc(measuredStreamMs))
    : 0;
  return Math.max(cappedDurationMs, measuredMs - STREAM_DURATION_CAP_GRACE_MS);
}

export function getBillableMinutes(durationMs: number): number {
  const normalizedDurationMs = Number.isFinite(durationMs)
    ? Math.max(0, durationMs)
    : 0;

  if (normalizedDurationMs <= 0) {
    return 0;
  }

  return Math.ceil(normalizedDurationMs / 60_000);
}

export function getRemainingTranscriptionMinutes(
  usedMinutes: number,
  limitMinutes: number
): number {
  if (!Number.isFinite(limitMinutes) || limitMinutes <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(limitMinutes - Math.max(0, usedMinutes)));
}

export function getRemainingTranscriptionMs(
  usedMinutes: number,
  limitMinutes: number
): number {
  return getRemainingTranscriptionMinutes(usedMinutes, limitMinutes) * 60_000;
}

export function getNextQuotaResetAt(baseDate = new Date()): Date {
  return new Date(
    Date.UTC(
      baseDate.getUTCFullYear(),
      baseDate.getUTCMonth() + 1,
      1,
      0,
      0,
      0,
      0
    )
  );
}

export function getQuotaCycleStartAt(quotaResetAt: Date | null): Date {
  if (!quotaResetAt) {
    return new Date(0);
  }

  return new Date(
    Date.UTC(
      quotaResetAt.getUTCFullYear(),
      quotaResetAt.getUTCMonth() - 1,
      1,
      0,
      0,
      0,
      0
    )
  );
}

/**
 * 管理员计费豁免：站内一切按量计费（钱包扣分 / 每日免费次数额度）对 ADMIN 一律不生效。
 *
 * 与既有口径一致：quota.ts 的配额哨兵（ADMIN 恒判有额度、扣减直接跳过）、
 * userRoles.ts 的「ADMIN 视为无限」能力开关、wallet.ts 的「管理员无需购买会员」。
 * 翻译模块此前漏了这一条，成了唯一会向管理员收费的功能。
 *
 * 调用约定：role 必须取自数据库。JWT 里的 role 在降级后最长可陈旧 7 天
 * （改角色不 bump tokenVersion），拿它判豁免等于给刚被降级的账号继续免单。
 */
export function isBillingExempt(role: AppUserRole): boolean {
  return role === 'ADMIN';
}
