import {
  ActiveJobReservationWindowExpiredError,
  claimActiveJob,
  type JobType,
} from '@/lib/jobQueue';
import type { LLMCallUsage } from '@/lib/llm/gateway';

/** 报告、关键词和后续翻译代理共享同一个 UTC 日 token 账本。 */
export const LLM_TOKEN_RESOURCE_SCOPE = 'llm_tokens';
export const LLM_PROMPT_PROTOCOL_TOKEN_OVERHEAD = 64;

const DEFAULT_LLM_USER_DAILY_TOKEN_BUDGET = 5_000_000;
const DEFAULT_LLM_GLOBAL_DAILY_TOKEN_BUDGET = 20_000_000;

function positiveEnvLimit(
  names: ReadonlyArray<string>,
  fallback: number,
  hardMax: number
): number {
  const configured = names.find((name) => process.env[name] !== undefined);
  const parsed = Number.parseInt(
    configured ? process.env[configured] ?? '' : '',
    10
  );
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, hardMax);
}

export function getLlmTokenBudgets(now = new Date()): {
  perUser: number;
  global: number;
  windowStart: Date;
  windowEnd: Date;
} {
  const windowStart = new Date(now);
  windowStart.setUTCHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart.getTime() + 24 * 60 * 60_000);
  const global = positiveEnvLimit(
    [
      'LLM_GLOBAL_DAILY_TOKEN_BUDGET',
      // 兼容本批次早期配置名，避免升级时意外恢复默认额度。
      'LLM_REPORT_GLOBAL_DAILY_TOKEN_BUDGET',
    ],
    DEFAULT_LLM_GLOBAL_DAILY_TOKEN_BUDGET,
    100_000_000
  );
  return {
    perUser: Math.min(
      positiveEnvLimit(
        [
          'LLM_USER_DAILY_TOKEN_BUDGET',
          'LLM_REPORT_USER_DAILY_TOKEN_BUDGET',
        ],
        DEFAULT_LLM_USER_DAILY_TOKEN_BUDGET,
        25_000_000
      ),
      global
    ),
    global,
    windowStart,
    windowEnd,
  };
}

export function conservativeLlmCallTokens(
  system: string,
  user: string,
  maxOutputTokens: number
): number {
  const encoder = new TextEncoder();
  return (
    encoder.encode(system).byteLength +
    encoder.encode(user).byteLength +
    LLM_PROMPT_PROTOCOL_TOKEN_OVERHEAD +
    maxOutputTokens
  );
}

/** 只接受不超过本调用预留上界的可信 usage；其余情况由调用方按上界结算。 */
export function trustedLlmUsageTokens(
  usage: LLMCallUsage | undefined,
  callReservation: number
): number | null {
  let candidate: number | null = null;
  if (
    usage &&
    Number.isSafeInteger(usage.totalTokens) &&
    (usage.totalTokens ?? -1) >= 0
  ) {
    candidate = usage.totalTokens as number;
  } else if (
    usage &&
    Number.isSafeInteger(usage.inputTokens) &&
    (usage.inputTokens ?? -1) >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    (usage.outputTokens ?? -1) >= 0
  ) {
    const total = (usage.inputTokens as number) + (usage.outputTokens as number);
    candidate = Number.isSafeInteger(total) ? total : null;
  }
  return candidate !== null && candidate > 0 && candidate <= callReservation
    ? candidate
    : null;
}

interface ClaimLlmTokenBudgetOptions {
  type: JobType;
  activeKey: string;
  units: number;
  userId: string;
  sessionId?: string;
  triggeredBy?: string;
  params?: Record<string, unknown>;
  /** 可选的 (type, sessionId) 任务级终身预算与并发门禁。 */
  owner?: {
    limit: number;
    settledUnitsFloor: number;
    maxActiveJobs: number;
  };
}

/**
 * 在共享 scope 锁内原子预留整次最坏 token；若请求恰好跨 UTC 日界，按锁内
 * 数据库时间重算窗口并只重试一次。
 */
export async function claimLlmTokenBudget(
  options: ClaimLlmTokenBudgetOptions
): Promise<string> {
  const { units, owner, ...jobOptions } = options;
  const claim = (budgets: ReturnType<typeof getLlmTokenBudgets>) =>
    claimActiveJob({
      ...jobOptions,
      resourceReservation: {
        scope: LLM_TOKEN_RESOURCE_SCOPE,
        units,
        perUserLimit: budgets.perUser,
        globalLimit: budgets.global,
        windowStart: budgets.windowStart,
        windowEnd: budgets.windowEnd,
        owner,
      },
    });

  try {
    return await claim(getLlmTokenBudgets());
  } catch (error) {
    if (!(error instanceof ActiveJobReservationWindowExpiredError)) {
      throw error;
    }
    return claim(getLlmTokenBudgets(error.admissionNow));
  }
}
