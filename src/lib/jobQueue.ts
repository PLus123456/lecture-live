import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

// ─── 任务类型常量 ───
export const JOB_TYPE = {
  KEYWORD_EXTRACTION: 'keyword_extraction',
  REPORT_GENERATION: 'report_generation',
  QUOTA_RESET: 'quota_reset',
  STALE_SESSION_RECLAIM: 'stale_session_reclaim',
  RECONCILIATION: 'reconciliation',
  STORAGE_CLEANUP: 'storage_cleanup',
  STORAGE_MIGRATION: 'storage_migration',
  BILLING_MAINTENANCE: 'billing_maintenance',
  TITLE_GENERATION: 'title_generation',
  CHAT_FILES_CLEANUP: 'chat_files_cleanup',
  AUDIO_ENHANCE: 'audio_enhance',
  DOC_TRANSLATE: 'doc_translate',
  EMBEDDING: 'embedding',
  TRANSLATION_LLM_PROXY: 'translation_llm_proxy',
  // 管理端对外部集成执行的同步操作（OAuth 换 token、连通性探测等）。这些操作
  // 没有异步消费者，但必须先持久化 PROCESSING，再执行外部副作用并 await 终态。
  ADMIN_INTEGRATION: 'admin_integration',
  // 管理端对文件系统等非事务资源的全局修改。JobQueue 先记 PROCESSING，
  // 外部副作用结束后再把终态与结构化审计放进同一数据库事务。
  ADMIN_MUTATION: 'admin_mutation',
} as const;

export type JobType = (typeof JOB_TYPE)[keyof typeof JOB_TYPE];

// ─── 状态常量 ───
export const JOB_STATUS = {
  SUBMITTED: 'SUBMITTED',
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

/**
 * L10：只有这两类任务真的有消费者会去捞 SUBMITTED 行执行
 * （enhanceProcessor.tick / translateProcessor.tick）。其余 10 个 JOB_TYPE 都是
 * trackJob 包在请求内同步跑完的「执行记录」，把行改回 SUBMITTED 之后没有任何调度器
 * 会执行它 —— admin 点「重试」拿到成功提示、任务却永远停在 SUBMITTED，纯误导。
 */
export const RETRYABLE_JOB_TYPES: ReadonlySet<string> = new Set<string>([
  JOB_TYPE.AUDIO_ENHANCE,
  JOB_TYPE.DOC_TRANSLATE,
]);

export function isJobTypeRetryable(type: string): boolean {
  return RETRYABLE_JOB_TYPES.has(type);
}

/**
 * P5-16：「每会话至多一个在途 audio_enhance」的排他键。
 *
 * 原来靠「先 findFirst 有没有 SUBMITTED/PROCESSING，没有再 createJob」这种 check-then-act，
 * 两个并发请求（双击按钮 / finalize 自动入队撞上用户手动触发）会各自查到空、各建一行，
 * 同一份录音被两台 worker 同时增强 + 两次回存互相覆盖。
 *
 * 改用 JobQueue.activeKey 的唯一索引：非终态期间持键，落终态（SUCCESS/FAILED）时置 null。
 * MySQL 允许重复 NULL，所以这个唯一索引等价于部分唯一索引 —— 把 check-then-act 压成
 * 一次插入冲突。
 */
export function audioEnhanceActiveKey(sessionId: string): string {
  return `audio_enhance:${sessionId}`;
}

/** activeKey 已被在途任务占用。让调用方区分「已有在途任务」与「建行失败」。 */
export class ActiveJobConflictError extends Error {
  constructor(readonly activeKey: string) {
    super(`Active job already exists for ${activeKey}`);
    this.name = 'ActiveJobConflictError';
  }
}

export interface ActiveJobResourceReservation {
  /** 同一 scope 的任务共享用户/全局预留+结算池。 */
  scope: string;
  units: number;
  perUserLimit: number;
  globalLimit: number;
  windowStart: Date;
  windowEnd: Date;
  /**
   * 可选的任务所有者终身预算。身份复用 JobQueue 自身的 (type, sessionId)，
   * 不另建账本；典型用途是单个 TranslationTask 的代理 token 上限。
   */
  owner?: {
    limit: number;
    /** 业务表中已持久化的历史结算额下限，用于兼容 JobQueue 上线前的用量。 */
    settledUnitsFloor: number;
    /** 同一 (type, sessionId) 最多允许多少个在途资源任务。 */
    maxActiveJobs: number;
  };
}

export class ActiveJobBudgetExceededError extends Error {
  constructor(
    readonly scope: string,
    readonly dimension: 'user' | 'global' | 'owner',
    readonly requestedUnits: number,
    readonly limit: number,
    readonly resetAt?: Date
  ) {
    super(`${scope} ${dimension} resource budget exceeded`);
    this.name = 'ActiveJobBudgetExceededError';
  }
}

export class ActiveJobConcurrencyExceededError extends Error {
  constructor(
    readonly scope: string,
    readonly maxActiveJobs: number,
    readonly retryAfterSeconds = 1
  ) {
    super(`${scope} owner concurrency exceeded`);
    this.name = 'ActiveJobConcurrencyExceededError';
  }
}

/**
 * 调用方在进入 scope 锁前计算的结算窗口已经过期。
 * 携带数据库时钟，允许上层以同一权威时间重算窗口后安全重试一次。
 */
export class ActiveJobReservationWindowExpiredError extends Error {
  constructor(
    readonly scope: string,
    readonly admissionNow: Date,
    readonly windowStart: Date,
    readonly windowEnd: Date
  ) {
    super(`${scope} resource reservation window expired`);
    this.name = 'ActiveJobReservationWindowExpiredError';
  }
}

const ACTIVE_RESOURCE_JOB_STATES = [
  JOB_STATUS.SUBMITTED,
  JOB_STATUS.PENDING,
  JOB_STATUS.PROCESSING,
] as const;

const ACTIVE_RESOURCE_RETRY_AFTER_MS = 15_000;

function validateResourceReservation(
  reservation: ActiveJobResourceReservation,
  userId: string | undefined,
  sessionId: string | undefined
): void {
  const owner = reservation.owner;
  if (
    !userId ||
    !/^[a-z0-9:_-]{1,64}$/u.test(reservation.scope) ||
    !Number.isSafeInteger(reservation.units) ||
    reservation.units < 0 ||
    !Number.isSafeInteger(reservation.perUserLimit) ||
    reservation.perUserLimit <= 0 ||
    !Number.isSafeInteger(reservation.globalLimit) ||
    reservation.globalLimit <= 0 ||
    reservation.perUserLimit > reservation.globalLimit ||
    !(reservation.windowStart instanceof Date) ||
    Number.isNaN(reservation.windowStart.getTime()) ||
    !(reservation.windowEnd instanceof Date) ||
    Number.isNaN(reservation.windowEnd.getTime()) ||
    reservation.windowEnd <= reservation.windowStart ||
    (owner !== undefined &&
      (!sessionId ||
        !Number.isSafeInteger(owner.limit) ||
        owner.limit <= 0 ||
        !Number.isSafeInteger(owner.settledUnitsFloor) ||
        owner.settledUnitsFloor < 0 ||
        !Number.isSafeInteger(owner.maxActiveJobs) ||
        owner.maxActiveJobs <= 0))
  ) {
    throw new Error('Invalid active-job resource reservation');
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

async function lockActiveJobResourceScope(
  tx: Prisma.TransactionClient,
  scope: string
): Promise<void> {
  const lockKey = `__internal_resource_admission:${scope}`;
  // no-op upsert 直接取得既有 sentinel 的 X lock。不能 INSERT IGNORE 后再
  // SELECT ... FOR UPDATE：并发 duplicate insert 可能各持 S lock 后同时升级死锁。
  await tx.$executeRaw(
    Prisma.sql`INSERT INTO SiteSetting (\`key\`, \`value\`, updatedAt)
               VALUES (${lockKey}, '1', UTC_TIMESTAMP(3))
               ON DUPLICATE KEY UPDATE \`key\` = \`key\``
  );
}

/** P2025：`update`/`delete` 的 where 没命中任何行（条件更新的竞态输家）。 */
function isRecordNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2025'
  );
}

// ─── 创建任务 ───
interface CreateJobOptions {
  type: JobType;
  sessionId?: string;
  userId?: string;
  triggeredBy?: string;
  params?: Record<string, unknown>;
  maxAttempts?: number;
  /** 排他键：同一 key 同时只允许一个非终态任务。冲突时抛 ActiveJobConflictError。 */
  activeKey?: string;
}

/**
 * 需要把 activeKey 当安全边界的同步任务必须使用本接口，而不是 trackJob：
 * - create 时即写 PROCESSING + startedAt，进程崩溃后现有僵尸回收能识别并释放 activeKey；
 * - 非唯一键数据库错误直接抛出，调用方关闭失败，不能在没有排他 claim 的情况下继续付费工作。
 */
export async function claimActiveJob(
  options: CreateJobOptions & {
    activeKey: string;
    resourceReservation?: ActiveJobResourceReservation;
  }
): Promise<string> {
  try {
    const resource = options.resourceReservation;
    if (resource) {
      validateResourceReservation(resource, options.userId, options.sessionId);
    }
    const startedAt = new Date();
    const data = {
      type: options.type,
      status: JOB_STATUS.PROCESSING,
      sessionId: options.sessionId ?? null,
      userId: options.userId ?? null,
      triggeredBy: options.triggeredBy ?? 'system',
      params: options.params ? JSON.stringify(options.params) : null,
      maxAttempts: options.maxAttempts ?? 1,
      activeKey: options.activeKey,
      startedAt,
      ...(resource
        ? {
            resourceScope: resource.scope,
            reservedUnits: BigInt(resource.units),
          }
        : {}),
    };

    if (!resource) {
      const job = await prisma.jobQueue.create({ data });
      return job.id;
    }

    const job = await prisma.$transaction(async (tx) => {
      // 同一 scope 的 claim 先锁一行持久化 mutex，再统计+插入；因此不同进程
      // 不能同时看到相同旧余额并一起越界。
      await lockActiveJobResourceScope(tx, resource.scope);

      // MySQL NOW() 在单条语句开始时固定；上面的 upsert 可能午夜前开始、午夜后
      // 才取得锁。必须在锁已取得后另起语句，
      // 并显式使用 UTC，才能把窗口校验与后续统计/插入放在同一权威时刻之后。
      const clockRows = await tx.$queryRaw<
        Array<{ admissionNow: Date | string }>
      >(Prisma.sql`SELECT UTC_TIMESTAMP(3) AS admissionNow`);
      if (clockRows.length !== 1) {
        throw new Error('Active-job resource admission clock is unavailable');
      }
      const admissionNow =
        clockRows[0].admissionNow instanceof Date
          ? clockRows[0].admissionNow
          : new Date(clockRows[0].admissionNow);
      if (Number.isNaN(admissionNow.getTime())) {
        throw new Error('Active-job resource admission clock is unavailable');
      }
      if (
        admissionNow < resource.windowStart ||
        admissionNow >= resource.windowEnd
      ) {
        throw new ActiveJobReservationWindowExpiredError(
          resource.scope,
          admissionNow,
          resource.windowStart,
          resource.windowEnd
        );
      }

      // 重复 sourceHash 应返回单飞冲突，而不是因为 winner 已占预留池而误报预算不足。
      const existing = await tx.jobQueue.findUnique({
        where: { activeKey: options.activeKey },
        select: { id: true },
      });
      if (existing) {
        throw new ActiveJobConflictError(options.activeKey);
      }

      if (resource.owner) {
        const ownerWhere = {
          type: options.type,
          sessionId: options.sessionId,
          resourceScope: resource.scope,
        };
        const ownerActive = await tx.jobQueue.aggregate({
          where: {
            ...ownerWhere,
            status: { in: [...ACTIVE_RESOURCE_JOB_STATES] },
          },
          _count: { _all: true },
          _sum: { reservedUnits: true },
        });
        const activeCount = ownerActive._count._all;
        if (activeCount >= resource.owner.maxActiveJobs) {
          throw new ActiveJobConcurrencyExceededError(
            resource.scope,
            resource.owner.maxActiveJobs
          );
        }
        const ownerSettled = await tx.jobQueue.aggregate({
          where: {
            ...ownerWhere,
            status: { in: [JOB_STATUS.SUCCESS, JOB_STATUS.FAILED] },
            actualUnits: { not: null },
          },
          _sum: { actualUnits: true },
        });
        const ownerUnknown = await tx.jobQueue.aggregate({
          where: {
            ...ownerWhere,
            status: { in: [JOB_STATUS.SUCCESS, JOB_STATUS.FAILED] },
            actualUnits: null,
          },
          _sum: { reservedUnits: true },
        });
        const ownerKnown = ownerSettled._sum.actualUnits ?? BigInt(0);
        const ownerFloor = BigInt(resource.owner.settledUnitsFloor);
        const ownerCommitted =
          (ownerKnown > ownerFloor ? ownerKnown : ownerFloor) +
          (ownerUnknown._sum.reservedUnits ?? BigInt(0));
        const ownerConsumed =
          ownerCommitted +
          (ownerActive._sum.reservedUnits ?? BigInt(0));
        if (ownerConsumed + BigInt(resource.units) > BigInt(resource.owner.limit)) {
          throw new ActiveJobBudgetExceededError(
            resource.scope,
            'owner',
            resource.units,
            resource.owner.limit
          );
        }
      }

      const global = await tx.jobQueue.aggregate({
        where: {
          resourceScope: resource.scope,
          status: { in: [...ACTIVE_RESOURCE_JOB_STATES] },
        },
        _sum: { reservedUnits: true },
      });
      const user = await tx.jobQueue.aggregate({
        where: {
          resourceScope: resource.scope,
          userId: options.userId,
          status: { in: [...ACTIVE_RESOURCE_JOB_STATES] },
        },
        _sum: { reservedUnits: true },
      });
      const terminalWhere = {
        resourceScope: resource.scope,
        status: { in: [JOB_STATUS.SUCCESS, JOB_STATUS.FAILED] },
        completedAt: {
          gte: resource.windowStart,
          lt: resource.windowEnd,
        },
      };
      const globalSettled = await tx.jobQueue.aggregate({
        where: { ...terminalWhere, actualUnits: { not: null } },
        _sum: { actualUnits: true },
      });
      const userSettled = await tx.jobQueue.aggregate({
        where: {
          ...terminalWhere,
          userId: options.userId,
          actualUnits: { not: null },
        },
        _sum: { actualUnits: true },
      });
      // 进程崩溃/旧代码可能留下 actualUnits=NULL 的终态行；无法证明未计费时
      // 按原预留全额结算，避免僵尸回收后把可能已消耗的预算重新发出。
      const globalUnknown = await tx.jobQueue.aggregate({
        where: { ...terminalWhere, actualUnits: null },
        _sum: { reservedUnits: true },
      });
      const userUnknown = await tx.jobQueue.aggregate({
        where: {
          ...terminalWhere,
          userId: options.userId,
          actualUnits: null,
        },
        _sum: { reservedUnits: true },
      });
      const requested = BigInt(resource.units);
      const globalActive = global._sum.reservedUnits ?? BigInt(0);
      const userActive = user._sum.reservedUnits ?? BigInt(0);
      const globalCommitted =
        (globalSettled._sum.actualUnits ?? BigInt(0)) +
        (globalUnknown._sum.reservedUnits ?? BigInt(0));
      const userCommitted =
        (userSettled._sum.actualUnits ?? BigInt(0)) +
        (userUnknown._sum.reservedUnits ?? BigInt(0));
      const globalConsumed = globalActive + globalCommitted;
      const userConsumed = userActive + userCommitted;
      const retryAt = (committed: bigint, limit: number): Date =>
        committed + requested > BigInt(limit)
          ? resource.windowEnd
          : new Date(
              Math.min(
                resource.windowEnd.getTime(),
                admissionNow.getTime() + ACTIVE_RESOURCE_RETRY_AFTER_MS
              )
            );
      if (globalConsumed + requested > BigInt(resource.globalLimit)) {
        throw new ActiveJobBudgetExceededError(
          resource.scope,
          'global',
          resource.units,
          resource.globalLimit,
          retryAt(globalCommitted, resource.globalLimit)
        );
      }
      if (userConsumed + requested > BigInt(resource.perUserLimit)) {
        throw new ActiveJobBudgetExceededError(
          resource.scope,
          'user',
          resource.units,
          resource.perUserLimit,
          retryAt(userCommitted, resource.perUserLimit)
        );
      }

      const job = await tx.jobQueue.create({
        data: {
          ...data,
          // 资源任务租约与准入窗口共用数据库 UTC 时钟，避免多实例应用机
          // 漂移导致仍在 provider 中的任务被提前回收并重复执行。
          startedAt: admissionNow,
        },
      });
      // 统计与插入也可能恰好跨 UTC 日界。提交前再读一次锁内 DB 时钟；若窗口
      // 已变，抛错会回滚刚建的 job，上层用 finalNow 重算新窗口再试一次。
      const finalClockRows = await tx.$queryRaw<
        Array<{ admissionNow: Date | string }>
      >(Prisma.sql`SELECT UTC_TIMESTAMP(3) AS admissionNow`);
      if (finalClockRows.length !== 1) {
        throw new Error('Active-job resource final admission clock is unavailable');
      }
      const finalNowRaw = finalClockRows[0].admissionNow;
      const finalNow =
        finalNowRaw instanceof Date ? finalNowRaw : new Date(finalNowRaw);
      if (Number.isNaN(finalNow.getTime())) {
        throw new Error('Active-job resource final admission clock is unavailable');
      }
      if (finalNow < resource.windowStart || finalNow >= resource.windowEnd) {
        throw new ActiveJobReservationWindowExpiredError(
          resource.scope,
          finalNow,
          resource.windowStart,
          resource.windowEnd
        );
      }
      return job;
    });
    return job.id;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ActiveJobConflictError(options.activeKey);
    }
    throw error;
  }
}

/**
 * 严格 claim 的成功终态：必须由调用方 await，确保结果和 activeKey 释放已经持久化。
 */
export async function completeActiveJob(
  jobId: string,
  result?: Record<string, unknown>,
  actualUnits?: number,
  settlement?: ActiveJobSettlementOptions
): Promise<void> {
  await settleActiveJob(jobId, JOB_STATUS.SUCCESS, {
    result,
    actualUnits,
    ...settlement,
  });
}

/**
 * 严格 claim 的失败终态。更新失败时 activeKey 会继续占用，安全地关闭失败；
 * reclaimStaleProcessingJobs 会在阈值后把僵尸任务标为 FAILED 并释放键。
 */
export async function failActiveJob(
  jobId: string,
  error: unknown,
  result?: Record<string, unknown>,
  actualUnits?: number,
  settlement?: ActiveJobSettlementOptions
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  await settleActiveJob(jobId, JOB_STATUS.FAILED, {
    error: message,
    result,
    actualUnits,
    ...settlement,
  });
}

export interface ActiveJobSettlementOptions {
  /** 成功结果需要充当短期幂等缓存时保留唯一 activeKey；失败/僵尸始终释放。 */
  retainActiveKeyOnSuccess?: boolean;
  /** 与 JobQueue 终态 CAS 同事务提交的业务侧计量写入。 */
  mutation?: (tx: Prisma.TransactionClient) => Promise<void>;
}

async function settleActiveJob(
  jobId: string,
  status: typeof JOB_STATUS.SUCCESS | typeof JOB_STATUS.FAILED,
  options: {
    error?: string;
    result?: Record<string, unknown>;
    actualUnits?: number;
    retainActiveKeyOnSuccess?: boolean;
    mutation?: (tx: Prisma.TransactionClient) => Promise<void>;
  }
): Promise<void> {
  if (
    options.actualUnits !== undefined &&
    (!Number.isSafeInteger(options.actualUnits) || options.actualUnits < 0)
  ) {
    throw new Error('Invalid active-job actual resource usage');
  }
  const result = options.result ? JSON.stringify(options.result) : null;
  const actualUnits =
    options.actualUnits !== undefined ? BigInt(options.actualUnits) : null;
  const activeKeyAssignment =
    status === JOB_STATUS.SUCCESS && options.retainActiveKeyOnSuccess
      ? Prisma.sql`activeKey = activeKey`
      : Prisma.sql`activeKey = NULL`;
  const statement = Prisma.sql`UPDATE JobQueue
                               SET status = ${status},
                                   error = ${options.error ?? null},
                                   result = ${result},
                                   completedAt = UTC_TIMESTAMP(3),
                                   ${activeKeyAssignment},
                                   actualUnits = ${actualUnits}
                               WHERE id = ${jobId}
                                 AND status = ${JOB_STATUS.PROCESSING}`;

  let updateError: unknown;
  try {
    // 日账准入使用数据库 UTC 时钟，终态也必须由同一时钟原子盖章；若用应用机
    // new Date()，主机漂移或午夜边界会把 actualUnits 放进错误的日窗口。
    const resource = await prisma.jobQueue.findUnique({
      where: { id: jobId },
      select: { resourceScope: true },
    });
    const needsTransaction = Boolean(resource?.resourceScope || options.mutation);
    const settled = needsTransaction
      ? await prisma.$transaction(async (tx) => {
          if (resource?.resourceScope) {
            // 与 claim 共用同一 scope X lock：claim 统计期间资源任务不能从 active
            // 迁移到 terminal，因而跨 UTC 日界也不会同时漏出两个集合。
            await lockActiveJobResourceScope(tx, resource.resourceScope);
          }
          const count = await tx.$executeRaw(statement);
          if (count === 1 && options.mutation) {
            await options.mutation(tx);
          }
          return count;
        })
      : await prisma.$executeRaw(statement);
    if (settled === 1) return;
  } catch (error) {
    updateError = error;
  }

  // CAS 可能已提交但客户端收到网络错误。回读同一终态即视为结算成功；
  // 无法确认时保留原错误，PROCESSING 行会继续占用预留直到僵尸回收。
  try {
    const readback = await prisma.jobQueue.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (readback?.status === status) return;
  } catch (readbackError) {
    if (updateError) throw updateError;
    throw readbackError;
  }

  if (updateError) throw updateError;
  throw new Error(`Active job ${jobId} was not in PROCESSING state`);
}

export async function createJob(options: CreateJobOptions): Promise<string> {
  try {
    const job = await prisma.jobQueue.create({
      data: {
        type: options.type,
        status: JOB_STATUS.SUBMITTED,
        sessionId: options.sessionId ?? null,
        userId: options.userId ?? null,
        triggeredBy: options.triggeredBy ?? 'system',
        params: options.params ? JSON.stringify(options.params) : null,
        maxAttempts: options.maxAttempts ?? 1,
        activeKey: options.activeKey ?? null,
      },
    });
    return job.id;
  } catch (error) {
    // P5-16：排他键冲突不是"建行失败"，而是"已有在途任务"，必须让调用方能分辨。
    if (options.activeKey && isUniqueConstraintError(error)) {
      throw new ActiveJobConflictError(options.activeKey);
    }
    console.error('[jobQueue] createJob failed:', error);
    return '';
  }
}

// ─── 状态更新（fire-and-forget） ───
export function markJobProcessing(jobId: string): void {
  if (!jobId) return;
  prisma.jobQueue
    .update({
      where: { id: jobId },
      data: { status: JOB_STATUS.PROCESSING, startedAt: new Date() },
    })
    .catch((err) => console.error('[jobQueue] markProcessing failed:', err));
}

export function markJobSuccess(
  jobId: string,
  result?: Record<string, unknown>
): void {
  if (!jobId) return;
  prisma.jobQueue
    .update({
      where: { id: jobId },
      data: {
        status: JOB_STATUS.SUCCESS,
        result: result ? JSON.stringify(result) : null,
        completedAt: new Date(),
        // P5-16：落终态即释放排他键（重复 NULL 不受唯一索引约束）。
        activeKey: null,
      },
    })
    .catch((err) => console.error('[jobQueue] markSuccess failed:', err));
}

export function markJobFailed(jobId: string, error: unknown): void {
  if (!jobId) return;
  const message =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');
  prisma.jobQueue
    .update({
      where: { id: jobId },
      data: {
        status: JOB_STATUS.FAILED,
        error: message,
        completedAt: new Date(),
        activeKey: null,
      },
    })
    .catch((err) => console.error('[jobQueue] markFailed failed:', err));
}

// ─── trackJob: 自动包装异步函数 ───
interface TrackJobOptions<T = unknown> {
  type: JobType;
  sessionId?: string;
  userId?: string;
  triggeredBy?: string;
  params?: Record<string, unknown>;
  maxAttempts?: number;
  /** 返回值含凭据/大对象时，只把显式安全摘要写进 durable journal。 */
  resultSummary?: (result: T) => Record<string, unknown>;
  /** 错误可能含上游响应、凭据或路径时，只持久化显式安全摘要。 */
  errorSummary?: (error: unknown) => string;
  /**
   * 与 JobQueue 终态同事务提交的业务写入（通常是结构化安全审计）。
   * 外部副作用完成但该事务失败时，PROCESSING 会保留为 durable unknown，不能被
   * 误报成 SUCCESS/FAILED 后安全重放。
   */
  terminalMutation?: (
    tx: Prisma.TransactionClient,
    terminal:
      | { status: typeof JOB_STATUS.SUCCESS; result: T }
      | { status: typeof JOB_STATUS.FAILED; error: unknown }
  ) => Promise<void>;
}

export async function trackJob<T>(
  options: TrackJobOptions<T>,
  fn: () => Promise<T>
): Promise<T> {
  // 同步任务把 JobQueue 当作 durable operation journal，而不是 best-effort 指标：
  // 建档失败时绝不能继续执行外部副作用；成功/失败终态也必须在返回前落库。
  const job = await prisma.jobQueue.create({
    data: {
      type: options.type,
      status: JOB_STATUS.PROCESSING,
      sessionId: options.sessionId ?? null,
      userId: options.userId ?? null,
      triggeredBy: options.triggeredBy ?? 'system',
      params: options.params ? JSON.stringify(options.params) : null,
      maxAttempts: options.maxAttempts ?? 1,
      startedAt: new Date(),
    },
    select: { id: true },
  });

  let result: T;
  try {
    result = await fn();
  } catch (operationError) {
    const message = options.errorSummary
      ? options.errorSummary(operationError)
      : operationError instanceof Error
        ? operationError.message
        : String(operationError ?? 'Unknown error');
    try {
      const persistFailure = async (
        db: Pick<Prisma.TransactionClient, 'jobQueue'>
      ) => {
        await db.jobQueue.update({
          where: { id: job.id },
          data: {
            status: JOB_STATUS.FAILED,
            error: message,
            completedAt: new Date(),
            activeKey: null,
          },
        });
      };
      if (options.terminalMutation) {
        await prisma.$transaction(async (tx) => {
          await persistFailure(tx);
          await options.terminalMutation!(tx, {
            status: JOB_STATUS.FAILED,
            error: operationError,
          });
        });
      } else {
        await persistFailure(prisma);
      }
    } catch (journalError) {
      // 外部操作已经失败但连失败终态也无法确认；保留 PROCESSING 供僵尸回收，
      // 并同时暴露两个错误，不能用日志吞掉 operation journal 故障。
      throw new AggregateError(
        [operationError, journalError],
        `Tracked job ${job.id} failed and its terminal state could not be persisted`
      );
    }
    throw operationError;
  }

  const serializable = options.resultSummary
    ? options.resultSummary(result)
    : result && typeof result === 'object'
      ? (result as Record<string, unknown>)
      : { value: result };
  // 若外部操作成功但终态更新失败，保持 PROCESSING（unknown），由僵尸回收/人工
  // 对账处理；绝不能误写 FAILED 后诱导管理员安全重放非幂等副作用。
  const persistSuccess = async (
    db: Pick<Prisma.TransactionClient, 'jobQueue'>
  ) => {
    await db.jobQueue.update({
      where: { id: job.id },
      data: {
        status: JOB_STATUS.SUCCESS,
        result: JSON.stringify(serializable),
        completedAt: new Date(),
        activeKey: null,
      },
    });
  };
  if (options.terminalMutation) {
    await prisma.$transaction(async (tx) => {
      await persistSuccess(tx);
      await options.terminalMutation!(tx, {
        status: JOB_STATUS.SUCCESS,
        result,
      });
    });
  } else {
    await persistSuccess(prisma);
  }
  return result;
}

// ─── 查询任务列表（Admin API 用） ───
interface QueryJobsFilters {
  type?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export async function queryJobs(filters: QueryJobsFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 20));
  const skip = (page - 1) * pageSize;

  const where: Record<string, unknown> = {};
  if (filters.type) where.type = filters.type;
  if (filters.status) where.status = filters.status;

  const [jobs, total] = await Promise.all([
    prisma.jobQueue.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.jobQueue.count({ where }),
  ]);

  return {
    // NextResponse.json/JSON.stringify 不支持 bigint。资源账本用十进制字符串
    // 出口，避免一个新列让整个管理员任务列表变成 500。
    jobs: jobs.map((job) => ({
      ...job,
      reservedUnits: job.reservedUnits.toString(),
      actualUnits: job.actualUnits?.toString() ?? null,
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

// ─── 重试失败任务 ───
type RetryJobDb = Pick<Prisma.TransactionClient, 'jobQueue'>;

export async function retryJob(
  jobId: string,
  db: RetryJobDb = prisma
): Promise<boolean> {
  const job = await db.jobQueue.findUnique({ where: { id: jobId } });
  if (!job) return false;
  // L10：无消费者的类型不能假装重试成功（见 RETRYABLE_JOB_TYPES）。
  if (!isJobTypeRetryable(job.type)) return false;
  if (job.status !== JOB_STATUS.FAILED) return false;
  if (job.attempt >= job.maxAttempts && job.maxAttempts > 1) return false;

  // P5-16：回炉即重新进入非终态，必须把 activeKey 拿回来（落终态时已被释放为 null），
  // 否则回炉后的 SUBMITTED 行不持键，并发入队会给同一会话再建一行。
  // 若此时该会话已有另一个在途任务持键 → P2002 → 本次重试直接判失败（语义正确：
  // 同会话已在处理中，不该再复活一个旧任务）。
  const reacquire =
    job.activeKey === null &&
    job.type === JOB_TYPE.AUDIO_ENHANCE &&
    job.sessionId
      ? { activeKey: audioEnhanceActiveKey(job.sessionId) }
      : {};

  try {
    const updated = await db.jobQueue.updateMany({
      where: {
        id: jobId,
        status: JOB_STATUS.FAILED,
        // 两个 tick 可同时读到同一个 FAILED 快照。只有一个能递增该 attempt；
        // 迟到更新也不能把已被 claim 的 PROCESSING 新代重新打回 SUBMITTED。
        attempt: job.attempt,
      },
      data: {
        status: JOB_STATUS.SUBMITTED,
        attempt: { increment: 1 },
        error: null,
        result: null,
        startedAt: null,
        completedAt: null,
        ...reacquire,
      },
    });
    if (updated.count !== 1) return false;
  } catch (error) {
    if (isUniqueConstraintError(error)) return false;
    // P2025 = 条件没命中（别的进程同一轮已经回炉过了）：不是错误，是竞态输家。
    if (isRecordNotFoundError(error)) return false;
    throw error;
  }

  return true;
}

// ─── 僵尸任务回收：PROCESSING 卡死超时标失败 ───
// trackJob 在请求内执行、markJob* 是 fire-and-forget；进程被部署 / OOM kill 时，
// 任务会永久卡在 PROCESSING（startedAt 已设、completedAt 始终为空），前端指示器一直转圈，
// 且 retryJob 只能重试 FAILED。这里把超时的 PROCESSING 任务原子标为 FAILED，
// 让状态机解锁、前端停转、并可被 retryJob 重试。
// 阈值取足够大的值（默认 2 小时）：远大于任何单个任务的正常耗时（报告生成 / 对账 / 清理
// 等最重的任务也在分钟级），避免误杀正在执行的任务（含 billing maintenance 自身）。
export const STALE_PROCESSING_JOB_THRESHOLD_MS = 2 * 60 * 60_000;

/**
 * H5：按 job type 覆盖的更长阈值。
 *
 * 上面那句"最重的任务也在分钟级"是 doc_translate（PR#227）上线**之前**写的，属于注释漂移：
 * `translateProcessor.MAX_WORKER_RUNTIME_MS` 白纸黑字给大文档 3 小时，2h 的通用阈值必然
 * 在合法运行途中把它误杀 —— 而且是 `updateMany` 直改、绕过 `failJob`，于是 TranslationTask
 * 停在 TRANSLATING、chargedCents 不退、不写 params.nextRetryAt（自动重试要求该字段存在），
 * 行也不再是 PROCESSING 从而永远不被对账捞到 = 用户永久"翻译中"+ 钱滞留。
 *
 * 这里的值必须**严格大于**该类型的合法最大运行时，并留出至少一个维护周期（15min）的余量。
 * 真正的终态化仍由 translateProcessor 的对账（3h 入口超时 → failJob）负责；本表只是
 * "连 tick 都卡死了"时的最后一道网，且网住之后 executeTick 的自愈扫描会补做结算。
 */
export const STALE_PROCESSING_THRESHOLD_BY_TYPE: Readonly<Record<string, number>> = {
  [JOB_TYPE.DOC_TRANSLATE]: 4 * 60 * 60_000,
};

/** 有自定义阈值的类型（通用扫描必须把它们排除，否则 2h 照杀不误）。 */
export const LONG_RUNNING_JOB_TYPES: readonly string[] = Object.keys(
  STALE_PROCESSING_THRESHOLD_BY_TYPE
);

interface ReclaimScopeOptions {
  /** 只回收这些 type（按类型分档扫描时用） */
  onlyTypes?: readonly string[];
  /** 排除这些 type（通用扫描把长跑类型让给它们各自的档位） */
  excludeTypes?: readonly string[];
}

/**
 * 注意：`options` 缺省是**不分类型**的全表扫描（保持历史语义，供单测与临时脚本直接调用）。
 * 生产入口是 billingMaintenance，它必须按 `reclaimAllStaleProcessingJobs` 的分档方式调用 ——
 * 直接裸调 `reclaimStaleProcessingJobs(now)` 会把长跑类型按 2h 误杀。
 */
export async function reclaimStaleProcessingJobs(
  thresholdMs: number = STALE_PROCESSING_JOB_THRESHOLD_MS,
  options: ReclaimScopeOptions = {}
): Promise<number> {
  if (!Number.isSafeInteger(thresholdMs) || thresholdMs <= 0) {
    throw new Error('Invalid stale processing job threshold');
  }
  const thresholdHours = Math.round(thresholdMs / 3_600_000);
  const thresholdMicros = thresholdMs * 1000;
  const error = `自动回收：任务卡在 PROCESSING 超过 ${thresholdHours} 小时（疑似进程中断）`;
  // H5：按 type 分档。通用扫描（2h）必须把长跑类型让出去，否则文档翻译的合法 3h 运行
  // 必然在跑到一半时被打成 FAILED —— 且是直改 status、绕过 failJob：任务停在 TRANSLATING、
  // 钱不退、不排重试、也不再被对账捞到。过滤条件拼进**每一条** SQL 的 WHERE。
  const typeFilter =
    options.onlyTypes && options.onlyTypes.length > 0
      ? Prisma.sql` AND type IN (${Prisma.join([...options.onlyTypes])})`
      : options.excludeTypes && options.excludeTypes.length > 0
        ? Prisma.sql` AND type NOT IN (${Prisma.join([...options.excludeTypes])})`
        : Prisma.empty;
  const staleScopes = await prisma.$queryRaw<Array<{ resourceScope: string }>>(
    Prisma.sql`SELECT DISTINCT resourceScope
               FROM JobQueue
               WHERE status = ${JOB_STATUS.PROCESSING}
                 AND resourceScope IS NOT NULL
                 AND startedAt <= DATE_SUB(
                   UTC_TIMESTAMP(3), INTERVAL ${thresholdMicros} MICROSECOND
                 )${typeFilter}`
  );
  let reclaimed = 0;

  // PROCESSING 必然已由 markJobProcessing 写过 startedAt（status 与 startedAt 同一次 update 落库），
  // 故以 startedAt 为超时判据；比较与 completedAt 都使用同一条 SQL 的数据库 UTC 时钟，
  // 避免应用主机漂移提前释放 activeKey，或把 unknown usage 记进错误日窗。
  for (const { resourceScope } of staleScopes) {
    reclaimed += await prisma.$transaction(async (tx) => {
      await lockActiveJobResourceScope(tx, resourceScope);
      return tx.$executeRaw(
        Prisma.sql`UPDATE JobQueue
                   SET status = ${JOB_STATUS.FAILED},
                       error = ${error},
                       completedAt = UTC_TIMESTAMP(3),
                       activeKey = NULL
                   WHERE status = ${JOB_STATUS.PROCESSING}
                     AND resourceScope = ${resourceScope}
                     AND startedAt <= DATE_SUB(
                       UTC_TIMESTAMP(3), INTERVAL ${thresholdMicros} MICROSECOND
                     )${typeFilter}`
      );
    });
  }

  // 非资源任务不参与日账，无需 scope mutex，但仍使用 DB UTC 原子判定/盖章。
  reclaimed += await prisma.$executeRaw(
    Prisma.sql`UPDATE JobQueue
               SET status = ${JOB_STATUS.FAILED},
                   error = ${error},
                   completedAt = UTC_TIMESTAMP(3),
                   activeKey = NULL
               WHERE status = ${JOB_STATUS.PROCESSING}
                 AND resourceScope IS NULL
                 AND startedAt <= DATE_SUB(
                   UTC_TIMESTAMP(3), INTERVAL ${thresholdMicros} MICROSECOND
                 )${typeFilter}`
  );
  return reclaimed;
}

/**
 * H5：生产用的分档回收入口 —— 通用类型走 2h，长跑类型各走自己的阈值。
 * billingMaintenance 只该调这一个。
 */
export async function reclaimAllStaleProcessingJobs(): Promise<number> {
  // 注意：不接受 `now`。超时判定与盖章统一用**数据库** UTC 时钟（见 reclaimStaleProcessingJobs
  // 的 SQL），应用主机时钟漂移不得提前释放 activeKey 或把用量记进错误的日窗。
  let count = await reclaimStaleProcessingJobs(STALE_PROCESSING_JOB_THRESHOLD_MS, {
    excludeTypes: LONG_RUNNING_JOB_TYPES,
  });
  for (const [type, ms] of Object.entries(STALE_PROCESSING_THRESHOLD_BY_TYPE)) {
    count += await reclaimStaleProcessingJobs(ms, { onlyTypes: [type] });
  }
  return count;
}
