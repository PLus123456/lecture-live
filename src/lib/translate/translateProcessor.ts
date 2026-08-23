import 'server-only';

import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { JOB_TYPE, JOB_STATUS, createJob, retryJob } from '@/lib/jobQueue';
import { getSiteSettings } from '@/lib/siteSettings';
import { refundWalletCents } from '@/lib/wallet';
import { resolveUserTranslationModelId } from '@/lib/userRoles';
import { resolveGroupBoundModel } from '@/lib/llm/summaryModel';
import {
  getTranslateFleetConfig,
  pingTranslateWorker,
  uploadTranslateInput,
  startTranslateJob,
  getTranslateJob,
  downloadTranslateOutput,
  deleteTranslateJob,
  buildWorkerModelLabel,
  TranslateWorkerError,
  type TranslateFleetConfig,
  type TranslateWorkerConfig,
  type TranslateJobStatus,
} from '@/lib/translate/workerClient';
import {
  readSourceFile,
  saveOutputFile,
  deleteTaskFiles,
} from '@/lib/translate/taskStorage';
import { logger, serializeError } from '@/lib/logger';

/**
 * 文档翻译调度器（tick 对账制状态机，与 enhanceProcessor 同构）。
 *
 * 真源分工：JobQueue(type=doc_translate) 是**调度**真源（claim/attempt/退避），
 * TranslationTask 是**业务**真源（用户可见状态/进度/产物/计费）。worker 侧 jobId
 * 直接用 JobQueue 行 id，天然幂等：中断后下一轮 tick 查 worker 实际状态续接。
 *
 * 状态流转（JobQueue.status / TranslationTask.status）：
 *   SUBMITTED / PENDING     → 已确认扣费待派发（含自动重试回炉）
 *   PROCESSING / TRANSLATING → worker 排队或翻译中，每轮 tick 对账回写进度
 *   SUCCESS / COMPLETED     → mono/dual 已回存本地，代理凭据失效
 *   FAILED / TRANSLATING|FAILED → 可重试失败对用户仍显示处理中；终态失败自动全额退款
 *
 * 推进途径：1) ws 进程 startDocTranslateLoop 周期 tick；2) 任务状态路由 fire-and-forget
 * 踢一脚。多进程并发安全靠 claim 的条件 updateMany 抢占。
 *
 * ─── 代次不变式（generation invariant，本文件最重要的一条规矩）───
 *
 * `TranslationTask.jobQueueId` 是**代次令牌**：它指向"当前这一代"调度行。
 * 用户 retry 会把任务重置回 PENDING、重新扣一次费、并换一条全新的调度行
 *（retry 路由事务里先把 jobQueueId 置 null，再由 enqueueDocTranslate 绑到新行）。
 * 于是同一个 taskId 上可能同时存在**上一代的在途逻辑**和**新一代的任务行**。
 *
 * 不变式：**调度器里所有对 TranslationTask 的写、以及所有对任务目录的 rm -rf，
 * 都必须带 `jobQueueId: <自己这一代的 jobId>` 谓词。**
 *
 * 漏一处的后果都是真金白银级的（这一簇 bug 全部出自"漏了谓词"）：
 *   - harvest 漏 → 旧代产物把新一代标成 COMPLETED，新代收割再 rm -rf 删光整个目录
 *     = 用户看到"已完成"但文件 404，且新扣的钱不退（H4）；
 *   - markTaskTranslating 漏 → 旧 worker 的 workerId 被写进新一代，用户取消时停错台（M12）；
 *   - 进度回写漏 → 旧代低进度反复盖掉新代真实进度，进度条回跳（M13）；
 *   - issueProxyToken 漏 → 唯一索引互相覆盖，其中一台 worker 的 LLM 调用全 401（M11）；
 *   - 绑定漏 → 双进程孤儿扫描各建一行都绑定成功，同一份 PDF 翻两遍（M11）。
 *
 * 两道防线：① 入口的 `isSupersededGeneration` 早退（省掉无谓的 worker 往返与副作用）；
 * ② 每一次写都带谓词（原子、不受 TOCTOU 影响，这才是权威防线）。只有 ① 没有 ② 不作数。
 */

const translateLogger = logger.child({ component: 'doc-translate' });

/**
 * 单任务在 worker 侧最长滞留：大文档（数百页 × QPS 限速）给足 3 小时。
 * H5：导出是为了让单测能钉住「僵尸回收阈值必须严格大于它」这条跨模块不变式 ——
 * 这两个常量当初就是各改各的漂移开的（jobQueue 的 2h < 这里的 3h），必然误杀。
 */
export const MAX_WORKER_RUNTIME_MS = 180 * 60_000;
/**
 * 任务级**绝对死线**：一个 TranslationTask 允许停留在非终态（PENDING/TRANSLATING）的总时长。
 *
 * 为什么单有 MAX_WORKER_RUNTIME_MS 不够：`job.startedAt` 在**每一次重派时都被清空**
 *（回炉 SUBMITTED 的五处、以及 retryJob），所以那 3 小时其实是「每一次派发」的预算，
 * 不是任务总预算。整个 worker 机队长期不可达时，任务就在 SUBMITTED ↔ PROCESSING 之间
 * 无限弹跳、永不终态：用户侧永远显示「翻译中」，而 chargedCents 一直押着不退。
 * 机队被整个删掉/停用（getTranslateFleetConfig 返回 null）时更彻底 —— 连 tick 都直接早退。
 *
 * 取值 24h 的理由：一次完整的合法重试链最长 ≈ 3 次派发 × 3h + 退避(5+20+45min) ≈ 9.5h，
 * 24h 留了 2.5 倍余量；同时必须严格大于僵尸回收阈值（4h）与单次运行上限（3h），
 * 三者的序关系由 translateGeneration.test.ts 的跨模块不变式测试钉死 —— 它们当初就是
 * 各改各的漂移开的（H5 的成因）。
 *
 * **锚点**是 `max(TranslationTask.createdAt, 本代 JobQueue 行的 createdAt)`，不是裸的任务
 * createdAt：用户 retry 复用同一个 TranslationTask 行（createdAt 不变）但会换一条全新的调度行，
 * 若只看任务 createdAt，隔天来点一次重试会被本扫描当场打死 —— 钱虽然退了，重试却等于不可用。
 * 而调度行的 createdAt 在「弹跳」这条真正的病态路径上是稳定的（五处回炉只清 startedAt、
 * 不新建行），死线照样咬得住。
 */
export const MAX_TASK_LIFETIME_MS = 24 * 60 * 60_000;
/** 自动重试退避（按已消耗 attempt 索引） */
const RETRY_BACKOFF_MS = [5 * 60_000, 20 * 60_000, 45 * 60_000];
const DEFAULT_MAX_ATTEMPTS = 3;
/**
 * L23：孤儿任务（PENDING 但没有调度行）的补入队宽限期。
 * 正常路径里「扣费事务提交 → enqueueDocTranslate 写回 jobQueueId」只隔几十毫秒，
 * 取 2 分钟足以避开正常窗口，又不至于让真正的孤儿等太久。
 */
const ORPHAN_TASK_GRACE_MS = 2 * 60_000;
/**
 * H6：绑定台连续不可达多久之后解绑重派。
 * 断电/域名失效的 worker 会让对账每轮都在 getTranslateJob 上抛错，任务干等着那台复活。
 * 取 10 分钟：足够跨过一次重启/短暂网络抖动，又不至于让用户等上小时级。
 */
const WORKER_UNREACHABLE_REBIND_MS = 10 * 60_000;

interface TranslateJobParams {
  /** 业务行 id（TranslationTask） */
  taskId?: string;
  /** 任务绑定的 worker 行 id（多台时由派发选定；后续对账/收割/清理都走它） */
  workerId?: string;
  nextRetryAt?: string;
  progress?: { stage: string | null; percent: number; at: string };
  /** H6：绑定台首次不可达的时刻（ISO）；任何一次成功对账即清除 */
  unreachableSince?: string;
  [key: string]: unknown;
}

function parseJobParams(raw: string | null): TranslateJobParams {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as TranslateJobParams) : {};
  } catch {
    return {};
  }
}

async function writeJobParams(jobId: string, params: TranslateJobParams): Promise<void> {
  await prisma.jobQueue
    .update({ where: { id: jobId }, data: { params: JSON.stringify(params) } })
    .catch(() => undefined);
}

/**
 * 代次门的**入口版**（见文件头的代次不变式）：任务是不是已经改嫁给了别的调度行。
 *
 * 注意 `null` 刻意**不算**过期。enqueueDocTranslate 是「先 createJob 再回写 jobQueueId」
 * 两步，中间那几毫秒里别的进程的 tick 完全可能已经把这条 SUBMITTED 行捞去派发；
 * 此时若判它过期并终态化，任务会停在 PENDING、jobQueueId 随后又被写上，
 * 孤儿扫描（要求 jobQueueId=null）再也捞不回来 —— 拿一个更狠的死锁换一个竞态，不划算。
 * 只有明确指向**另一条**调度行才是确凿的过期代次。
 *
 * 这只是省往返用的快速判断，权威防线是每一次写 task 时都带的 `jobQueueId` 谓词。
 */
function isSupersededGeneration(
  task: { jobQueueId: string | null },
  jobId: string
): boolean {
  return task.jobQueueId !== null && task.jobQueueId !== jobId;
}

/**
 * 放弃一条已被新一代取代的调度行：只终态化调度行，**一个字都不碰 TranslationTask**。
 * 刻意不写 params.nextRetryAt —— 过期代次不该被自动重试捞回来复活。
 */
async function abandonSupersededJob(jobId: string): Promise<void> {
  await prisma.jobQueue
    .updateMany({
      where: { id: jobId, status: { in: [JOB_STATUS.SUBMITTED, JOB_STATUS.PROCESSING] } },
      data: {
        status: JOB_STATUS.FAILED,
        error: '调度行已被新一代取代（用户重试）',
        completedAt: new Date(),
      },
    })
    .catch(() => undefined);
}

// ─── 入队（由确认扣费路由调用） ───

/**
 * 把已确认扣费的翻译任务入队（幂等：task 已关联在途 JobQueue 行则复用）。
 * 返回 jobId；创建失败返回 null（调用方回滚扣费）。
 */
export async function enqueueDocTranslate(taskId: string, userId: string): Promise<string | null> {
  try {
    const task = await prisma.translationTask.findUnique({
      where: { id: taskId },
      select: { jobQueueId: true },
    });
    if (!task) return null; // 行已被删：别留一条没人认领的调度行占派发槽
    if (task.jobQueueId) {
      const existing = await prisma.jobQueue.findUnique({
        where: { id: task.jobQueueId },
        select: { id: true, status: true },
      });
      if (
        existing &&
        existing.status !== JOB_STATUS.SUCCESS &&
        existing.status !== JOB_STATUS.FAILED
      ) {
        return existing.id;
      }
    }
    const jobId = await createJob({
      type: JOB_TYPE.DOC_TRANSLATE,
      userId,
      triggeredBy: userId,
      params: { taskId },
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
    });
    if (!jobId) return null;
    // L23：绑定失败（任务被并发取消/删除、或状态已不是 PENDING）时必须把刚建的调度行
    // 就地终态化。原来用的是会抛的 prisma.update：抛出后外层 catch 只 return null，
    // 那行永远留在 SUBMITTED 里，每轮 tick 都被捞进 take(totalSlots)、白占一个全局派发槽。
    // M11：绑定必须是对**读到的那个代次令牌**的 CAS，不能只看 status。
    // tick 同时跑在 ws 进程和每个 API 进程里（runDocTranslateTick 的 globalThis 互斥仅
    // 进程内），两个进程的孤儿扫描可以同时捞到同一条 jobQueueId=null 的任务、各自 createJob，
    // 只带 `status: 'PENDING'` 的话两次绑定会**先后都成功**：两条 SUBMITTED 行都被派发，
    // 同一份 PDF 翻两遍、两笔 worker 费用，且 issueProxyToken 互相覆盖唯一索引，
    // 其中一台的 LLM 调用当场全 401。
    // 用读到的旧值做谓词（null 或上一条已终态的行 id）→ 只有第一个写入者能命中。
    const bound = await prisma.translationTask.updateMany({
      where: { id: taskId, status: 'PENDING', jobQueueId: task.jobQueueId },
      data: { jobQueueId: jobId },
    });
    if (bound.count === 0) {
      await prisma.jobQueue
        .updateMany({
          where: { id: jobId, status: JOB_STATUS.SUBMITTED },
          data: {
            status: JOB_STATUS.FAILED,
            error: '入队时任务状态已变化',
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
      return null;
    }
    return jobId;
  } catch (error) {
    translateLogger.warn({ taskId, err: serializeError(error) }, '翻译任务入队失败');
    return null;
  }
}

// ─── tick 入口（进程内互斥） ───

declare global {
  // eslint-disable-next-line no-var
  var __docTranslateTickRun: Promise<void> | undefined;
}

export function runDocTranslateTick(): Promise<void> {
  if (globalThis.__docTranslateTickRun) {
    return globalThis.__docTranslateTickRun;
  }
  const run = executeTick()
    .catch((error) => {
      translateLogger.warn({ err: serializeError(error) }, '文档翻译 tick 异常');
    })
    .finally(() => {
      globalThis.__docTranslateTickRun = undefined;
    });
  globalThis.__docTranslateTickRun = run;
  return run;
}

async function executeTick(): Promise<void> {
  const fleet = await getTranslateFleetConfig();

  // 0) 任务级绝对死线。**必须排在下面 `if (!fleet)` 早退之前** —— 机队被停用/删空正是
  // 任务永久挂起的形态之一（连 tick 都进不来），死线放在早退之后就永远够不着它。
  await enforceTaskLifetimeDeadlines(fleet).catch((error) =>
    translateLogger.warn(
      { err: serializeError(error) },
      '任务生存期死线扫描异常（下轮重试）'
    )
  );

  if (!fleet) {
    return; // 文档翻译未启用/无可用 worker：入队任务保留，配置好后自动推进
  }

  // 1) 对账所有 PROCESSING 任务
  const processing = await prisma.jobQueue.findMany({
    where: { type: JOB_TYPE.DOC_TRANSLATE, status: JOB_STATUS.PROCESSING },
    orderBy: { startedAt: 'asc' },
  });
  for (const job of processing) {
    await reconcileProcessingJob(job, fleet).catch((error) => {
      translateLogger.warn(
        { jobId: job.id, err: serializeError(error) },
        '文档翻译任务对账异常（下轮重试）'
      );
    });
  }

  // 2) 到期自动重试：FAILED 且未用尽 attempt 且过退避时间 → 回炉 SUBMITTED
  const failed = await prisma.jobQueue.findMany({
    where: { type: JOB_TYPE.DOC_TRANSLATE, status: JOB_STATUS.FAILED },
    orderBy: { completedAt: 'asc' },
    take: 20,
  });
  const now = Date.now();
  for (const job of failed) {
    const params = parseJobParams(job.params);
    if (!params.nextRetryAt) continue;
    if (job.attempt >= job.maxAttempts) continue;
    if (new Date(params.nextRetryAt).getTime() > now) continue;
    const retried = await retryJob(job.id);
    if (retried) {
      translateLogger.info(
        { jobId: job.id, attempt: job.attempt + 1 },
        '文档翻译任务自动重试回炉'
      );
    }
  }

  // 2.4) H5：断链任务自愈 —— 调度行已终态，业务行却还停在非终态。
  //
  // 通用僵尸回收（jobQueue.reclaimStaleProcessingJobs）是 updateMany 直改 job 行、
  // **绕过 failJob**：它不回写 TranslationTask、不退 chargedCents、不发通知、
  // 也不写 params.nextRetryAt（上面那圈自动重试要求该字段存在，没有就直接 continue）。
  // 结果是任务永久停在 TRANSLATING（前端一直转圈）、钱滞留在系统里，而且行已非 PROCESSING
  // → 上面第 1 步的对账永远捞不到它，worker 就算翻完也没人收割。
  // 进程在 failJob 的「先写 job 行、再写 task 行」中间被 kill、以及 admin 手动改状态，
  // 都会落到同一形态。
  //
  // 这里按业务行反查（在途任务数量受机队容量约束，很小）：只要它绑定的调度行已终态
  // 且没有排定自动重试，就补跑一次 failJob —— 还有 attempt 就排退避重试，
  // 用光了就终态失败 + 全额退款 + 通知。failJob 自带代次谓词，跨代不会误伤。
  const strandedTasks = await prisma.translationTask.findMany({
    where: {
      status: { in: ['PENDING', 'TRANSLATING'] },
      jobQueueId: { not: null },
      updatedAt: { lt: new Date(now - ORPHAN_TASK_GRACE_MS) },
    },
    select: { id: true, jobQueueId: true },
    orderBy: { updatedAt: 'asc' },
    take: 20,
  });
  for (const stranded of strandedTasks) {
    const jobId = stranded.jobQueueId;
    if (!jobId) continue;
    const jobRow = await prisma.jobQueue.findUnique({
      where: { id: jobId },
      select: { id: true, type: true, status: true, params: true },
    });
    if (!jobRow || jobRow.type !== JOB_TYPE.DOC_TRANSLATE) continue;
    if (jobRow.status !== JOB_STATUS.FAILED && jobRow.status !== JOB_STATUS.SUCCESS) {
      continue; // 还在途，正常推进中
    }
    if (parseJobParams(jobRow.params).nextRetryAt) continue; // 已排重试，等它自己回炉
    translateLogger.warn(
      { jobId, taskId: stranded.id, jobStatus: jobRow.status },
      '调度链断裂（调度行已终态但任务未结算），补做失败结算'
    );
    await failJob(jobId, new Error('调度中断，已自动补做结算'), {
      retryable: true,
    }).catch((error) =>
      translateLogger.warn(
        { jobId, taskId: stranded.id, err: serializeError(error) },
        '断链任务补结算失败（下轮重试）'
      )
    );
  }

  // 2.5) L23：捞回「扣了费但没有调度行」的孤儿任务。
  // 扣费必须先于建行（建行的 params 需要 taskId），confirm/retry 两条路由都是
  // 「事务里扣费 → 事务外 enqueueDocTranslate」。进程在这两步之间挂掉（部署/OOM）时，
  // 任务永久停在 PENDING + jobQueueId=null：钱扣了、没有任何调度器认识它、
  // 用户界面上是一个永远转圈的任务。宽限期避开正常请求内那几十毫秒的窗口。
  const orphanedTasks = await prisma.translationTask.findMany({
    where: {
      status: 'PENDING',
      jobQueueId: null,
      updatedAt: { lt: new Date(Date.now() - ORPHAN_TASK_GRACE_MS) },
    },
    select: { id: true, userId: true },
    orderBy: { updatedAt: 'asc' },
    take: 20,
  });
  for (const orphan of orphanedTasks) {
    const jobId = await enqueueDocTranslate(orphan.id, orphan.userId);
    translateLogger.warn(
      { taskId: orphan.id, jobId },
      jobId ? '补入队已扣费但无调度行的翻译任务' : '孤儿翻译任务补入队失败（下轮重试）'
    );
  }

  // 3) 派发：总槽位 = Σ每台 concurrency − 全部在途
  const busyRows = await prisma.jobQueue.findMany({
    where: { type: JOB_TYPE.DOC_TRANSLATE, status: JOB_STATUS.PROCESSING },
    select: { params: true },
  });
  const busyByWorkerId = new Map<string, number>();
  for (const row of busyRows) {
    const id = parseJobParams(row.params).workerId;
    if (id) busyByWorkerId.set(id, (busyByWorkerId.get(id) ?? 0) + 1);
  }
  const capacity = fleet.workers.reduce((sum, w) => sum + w.concurrency, 0);
  const totalSlots = capacity - busyRows.length;
  if (totalSlots <= 0) return;

  const submitted = await prisma.jobQueue.findMany({
    where: { type: JOB_TYPE.DOC_TRANSLATE, status: JOB_STATUS.SUBMITTED },
    orderBy: { createdAt: 'asc' },
    take: totalSlots,
  });
  const healthCache = new Map<string, { ok: boolean; load: number }>();
  for (const job of submitted) {
    const claimed = await claimJob(job.id);
    if (!claimed) continue;
    await dispatchJob(job, fleet, busyByWorkerId, healthCache).catch(async (error) => {
      translateLogger.warn(
        { jobId: job.id, err: serializeError(error) },
        '文档翻译任务派发异常'
      );
      await failJob(job.id, error, { retryable: true });
    });
  }
}

/**
 * 任务级绝对死线扫描：把在非终态停留超过 MAX_TASK_LIFETIME_MS 的任务终态化 + **退款**。
 *
 * 必须走 `failJob(..., { retryable: false })`，不能图省事用裸 updateMany —— 只有 failJob 会
 * 跑 refundTaskCharge（释放押着的 chargedCents，这正是本扫描存在的全部意义）、发失败通知、
 * 并带上 L24 代次谓词。绕过它就等于没修。
 *
 * 与既有机制的关系：
 *  - retryable:false ⇒ failJob 会 `delete params.nextRetryAt`，第 2 步的到期自动重试因此
 *    不会把它再捞回炉（那圈明确要求 nextRetryAt 存在）；
 *  - 任务随即变 FAILED，第 2.4 步 H5 断链自愈的 `status in [PENDING, TRANSLATING]` 不再匹配，
 *    两者不会互相打架，也没有造出 H5 捞不到的新形态；
 *  - 退避（RETRY_BACKOFF_MS / params.nextRetryAt）不受影响：它只作用于 retryable 的失败。
 */
async function enforceTaskLifetimeDeadlines(
  fleet: TranslateFleetConfig | null,
  now: number = Date.now()
): Promise<void> {
  const cutoff = new Date(now - MAX_TASK_LIFETIME_MS);
  // 命中 @@index([status, createdAt])。jobQueueId 非空是硬前提：failJob 的入参就是代次令牌，
  // 没有调度行的孤儿由第 2.5 步补入队，下一轮再落到这里。
  const candidates = await prisma.translationTask.findMany({
    where: {
      status: { in: ['PENDING', 'TRANSLATING'] },
      createdAt: { lt: cutoff },
      jobQueueId: { not: null },
    },
    select: { id: true, jobQueueId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });

  for (const task of candidates) {
    const jobId = task.jobQueueId;
    if (!jobId) continue;
    const job = await prisma.jobQueue.findUnique({
      where: { id: jobId },
      select: { id: true, type: true, status: true, params: true, createdAt: true },
    });
    if (!job || job.type !== JOB_TYPE.DOC_TRANSLATE) continue;
    // 锚点取较晚者（见 MAX_TASK_LIFETIME_MS 注释）：本代调度行还年轻 = 用户刚重试过，放行。
    if (job.createdAt.getTime() >= cutoff.getTime()) continue;

    // best-effort 收掉 worker 侧可能还在的那份任务（机队不可达时必然失败，无所谓）。
    const bound = fleet ? workerById(fleet, parseJobParams(job.params).workerId) : null;
    if (bound) await deleteTranslateJob(bound, job.id).catch(() => undefined);

    translateLogger.warn(
      {
        jobId,
        taskId: task.id,
        taskCreatedAt: task.createdAt.toISOString(),
        jobCreatedAt: job.createdAt.toISOString(),
        jobStatus: job.status,
      },
      '文档翻译任务超过最长生存期，终止并退款'
    );
    await failJob(jobId, new Error('文档翻译超时未完成，已终止并退款'), {
      retryable: false,
    }).catch((error) =>
      translateLogger.warn(
        { jobId, taskId: task.id, err: serializeError(error) },
        '死线终止失败（下轮重试）'
      )
    );
  }
}

// ─── 选台（负载均衡：评分 = (实际队列 + 本地在途) / 权重，取最小） ───

async function pickWorker(
  fleet: TranslateFleetConfig,
  busyByWorkerId: Map<string, number>,
  healthCache: Map<string, { ok: boolean; load: number }>
): Promise<TranslateWorkerConfig | null> {
  const candidates = fleet.workers.filter(
    (w) => (busyByWorkerId.get(w.id) ?? 0) < w.concurrency
  );
  if (candidates.length === 0) return null;

  await Promise.all(
    candidates
      .filter((w) => !healthCache.has(w.id))
      .map(async (w) => {
        try {
          const health = await pingTranslateWorker(w, { timeoutMs: 4_000 });
          healthCache.set(w.id, {
            // queue 缺失 = token 鉴权失败的裸响应，同样视为不可用
            ok: Boolean(health.ok && health.queue),
            load: (health.queue?.running ?? 0) + (health.queue?.queued ?? 0),
          });
        } catch {
          healthCache.set(w.id, { ok: false, load: Number.POSITIVE_INFINITY });
        }
      })
  );

  const alive = candidates.filter((w) => healthCache.get(w.id)?.ok);
  if (alive.length === 0) return null;
  alive.sort((a, b) => {
    const scoreA =
      (healthCache.get(a.id)!.load + (busyByWorkerId.get(a.id) ?? 0)) / a.weight;
    const scoreB =
      (healthCache.get(b.id)!.load + (busyByWorkerId.get(b.id) ?? 0)) / b.weight;
    return scoreA - scoreB;
  });
  return alive[0];
}

function workerById(
  fleet: TranslateFleetConfig,
  id: string | undefined
): TranslateWorkerConfig | null {
  if (!id) return null;
  return fleet.workers.find((w) => w.id === id) ?? null;
}

/** 无绑定时逐台查找该任务落在哪台上（找回场景） */
async function findJobOnFleet(
  fleet: TranslateFleetConfig,
  jobId: string
): Promise<{ worker: TranslateWorkerConfig; remote: TranslateJobStatus } | null> {
  for (const worker of fleet.workers) {
    try {
      const remote = await getTranslateJob(worker, jobId);
      return { worker, remote };
    } catch {
      continue;
    }
  }
  return null;
}

/** 条件抢占：SUBMITTED → PROCESSING（跨进程唯一赢家） */
async function claimJob(jobId: string): Promise<boolean> {
  const result = await prisma.jobQueue.updateMany({
    where: { id: jobId, status: JOB_STATUS.SUBMITTED },
    data: { status: JOB_STATUS.PROCESSING, startedAt: new Date() },
  });
  return result.count === 1;
}

// ─── 派发 ───

type TaskRow = NonNullable<Awaited<ReturnType<typeof loadTask>>>;

async function loadTask(taskId: string | undefined) {
  if (!taskId) return null;
  return prisma.translationTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      userId: true,
      status: true,
      sourceLang: true,
      targetLang: true,
      glossaryJson: true,
      chargedCents: true,
      refundedAt: true,
      pageCount: true,
      modelId: true,
      // L24：代次令牌 —— 清盘/退款前必须确认任务仍绑在当前这一代调度行上
      jobQueueId: true,
      user: { select: { role: true, customGroupId: true } },
    },
  });
}

function parseGlossary(raw: string | null): { src: string; dst: string }[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const entries = arr
      .filter(
        (e): e is { src: string; dst: string } =>
          Boolean(e) &&
          typeof e === 'object' &&
          typeof (e as { src?: unknown }).src === 'string' &&
          typeof (e as { dst?: unknown }).dst === 'string'
      )
      .slice(0, 500);
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

/**
 * 生成任务级 LLM 代理凭据：明文只下发给 worker，库里只存 sha256（同 EmailToken 惯例）。
 *
 * M11：带代次谓词，返回 null = 本代已过期（调用方必须放弃派发）。
 * proxyTokenHash 是唯一索引，一个任务只存得下一份凭据 —— 旧代派发晚到一步就会把
 * 新一代刚下发给 worker 的凭据覆盖掉，那台 worker 的所有 LLM 调用当场全 401，
 * 而它自己的凭据也已被后来者作废，两代一起废。
 */
async function issueProxyToken(taskId: string, jobId: string): Promise<string | null> {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const claimed = await prisma.translationTask.updateMany({
    where: { id: taskId, jobQueueId: jobId },
    data: { proxyTokenHash: hash },
  });
  return claimed.count > 0 ? raw : null;
}

async function dispatchJob(
  job: JobRow,
  fleet: TranslateFleetConfig,
  busyByWorkerId: Map<string, number>,
  healthCache: Map<string, { ok: boolean; load: number }>
): Promise<void> {
  const jobId = job.id;
  const params = parseJobParams(job.params);
  const task = await loadTask(params.taskId);
  if (!task) {
    await failJob(jobId, new Error('翻译任务已删除'), { retryable: false });
    return;
  }
  if (isSupersededGeneration(task, jobId)) {
    // 代次门：任务已改嫁给新一代调度行（用户 retry）。继续派发会白翻一遍、
    // 抢掉 issueProxyToken 的唯一索引让新一代 worker 的 LLM 全 401，
    // 收割时还会回写/删掉新一代的产物。只终态化自己这条行，不碰 task。
    const staleWorker = workerById(fleet, params.workerId);
    if (staleWorker) await deleteTranslateJob(staleWorker, jobId).catch(() => undefined);
    await abandonSupersededJob(jobId);
    translateLogger.info(
      { jobId, taskId: task.id, currentJobId: task.jobQueueId },
      '过期代次调度行，放弃派发'
    );
    return;
  }
  if (task.status === 'CANCELED' || task.status === 'COMPLETED') {
    // 用户已取消 / 任务已由别的路径完成：清 worker 痕迹，调度行终态
    const bound = workerById(fleet, params.workerId);
    if (bound) await deleteTranslateJob(bound, jobId).catch(() => undefined);
    await prisma.jobQueue.updateMany({
      where: { id: jobId, status: JOB_STATUS.PROCESSING },
      data: {
        status: task.status === 'COMPLETED' ? JOB_STATUS.SUCCESS : JOB_STATUS.FAILED,
        error: task.status === 'CANCELED' ? '用户已取消' : null,
        completedAt: new Date(),
      },
    });
    return;
  }

  // 对账 worker 现状：中断重派时任务可能已在某台上跑甚至已完成
  const bound = workerById(fleet, params.workerId);
  let located: { worker: TranslateWorkerConfig; remote: TranslateJobStatus } | null = null;
  if (bound) {
    try {
      located = { worker: bound, remote: await getTranslateJob(bound, jobId) };
    } catch (error) {
      if (!(error instanceof TranslateWorkerError) || error.status !== 404) {
        throw error; // 绑定台网络异常：保持 PROCESSING 下轮重试
      }
    }
  } else {
    located = await findJobOnFleet(fleet, jobId);
  }

  if (located) {
    if (located.worker.id !== params.workerId) {
      await writeJobParams(jobId, { ...params, workerId: located.worker.id });
    }
    if (located.remote.status === 'succeeded') {
      await harvestJob(jobId, task, located.worker);
      return;
    }
    if (located.remote.status === 'queued' || located.remote.status === 'running') {
      await markTaskTranslating(task.id, jobId, located.worker.id);
      return;
    }
    // created / failed：留在这台重推
  }

  const target = located?.worker ?? (await pickWorker(fleet, busyByWorkerId, healthCache));
  if (!target) {
    // 全部不可达/占满：让位回 SUBMITTED，不消耗 attempt
    await prisma.jobQueue.updateMany({
      where: { id: jobId, status: JOB_STATUS.PROCESSING },
      data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
    });
    return;
  }

  const source = await readSourceFile(task.id);
  if (!source) {
    await failJob(jobId, new Error('源文件读取失败'), { retryable: false });
    return;
  }

  const settings = await getSiteSettings();
  const appUrl = settings.site_url.replace(/\/+$/, '');

  // 派发时解析任务实际使用的模型：① 生成真实模型标识下发（pdf2zh 缓存按模型分键，
  // 换模型不再复用旧译文）；② 解析出具体路由行且任务尚无快照时定格回 task.modelId，
  // 让代理端点全程恒定同一模型（中途 admin 换全局默认不影响在途任务）。
  const boundId =
    task.modelId || (await resolveUserTranslationModelId(task.user).catch(() => null));
  const resolved = await resolveGroupBoundModel(boundId, 'TRANSLATION').catch(() => null);
  const resolvedDbId =
    resolved?.provider?.dbModelId && resolved.provider.purpose === 'TRANSLATION'
      ? resolved.provider.dbModelId
      : null;
  if (resolvedDbId && !task.modelId) {
    // 代次谓词 + modelId:null 双条件：只定格「本代、且确实还没定格过」的快照，
    // 不去改写新一代（用户 retry 时可能挑了别的模型）已经定下来的选择。
    await prisma.translationTask
      .updateMany({
        where: { id: task.id, jobQueueId: jobId, modelId: null },
        data: { modelId: resolvedDbId },
      })
      .catch(() => undefined);
  }
  const modelLabel = buildWorkerModelLabel(resolved?.provider ?? null);

  try {
    await uploadTranslateInput(target, jobId, source);
    const proxyToken = await issueProxyToken(task.id, jobId);
    if (!proxyToken) {
      // 上传期间用户 retry 换了代：别 start，把刚传上去的源文件清掉再放弃本代。
      await deleteTranslateJob(target, jobId).catch(() => undefined);
      await abandonSupersededJob(jobId);
      translateLogger.info({ jobId, taskId: task.id }, '上传后代次已变更，放弃派发');
      return;
    }
    await startTranslateJob(target, jobId, {
      langIn: task.sourceLang,
      langOut: task.targetLang,
      qps: target.qps,
      watermark: fleet.watermark,
      glossary: parseGlossary(task.glossaryJson),
      llm: {
        baseUrl: `${appUrl}/api/translate/llm-proxy/v1`,
        apiKey: proxyToken,
        model: modelLabel,
      },
    });
  } catch (error) {
    if (error instanceof TranslateWorkerError && error.status === 429) {
      // 这台队列满：清绑定让位，下轮重选别台，不消耗 attempt。
      // L28：让位前先删掉本次已经传上去的源文件 —— uploadTranslateInput 很可能已经成功，
      // 只是 startTranslateJob 撞上队列上限。不清的话这份 PDF 会一直躺在那台 worker 上
      // 干等它自己的定期自清扫；队列长期满时（正是 429 频发的场景）垃圾持续累积。
      await deleteTranslateJob(target, jobId).catch(() => undefined);
      await writeJobParams(jobId, { ...params, workerId: undefined });
      await prisma.jobQueue.updateMany({
        where: { id: jobId, status: JOB_STATUS.PROCESSING },
        data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
      });
      return;
    }
    if (
      error instanceof TranslateWorkerError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    ) {
      // 确定性 4xx（413 超限/401 token 错/400 参数错）：立即终态失败并退款
      await failJob(jobId, error, { retryable: false });
      return;
    }
    throw error; // 5xx/网络错：外层按可重试失败处理
  }

  await writeJobParams(jobId, { ...params, workerId: target.id });
  busyByWorkerId.set(target.id, (busyByWorkerId.get(target.id) ?? 0) + 1);
  await markTaskTranslating(task.id, jobId, target.id);
  translateLogger.info(
    { jobId, taskId: task.id, worker: target.name },
    '文档翻译任务已派发给 worker'
  );
}

/**
 * M12：代次谓词不能省。旧代调度行被回炉重派（404 找回路径）时，若只按
 * `{ id, status in [PENDING,TRANSLATING] }` 写，它会把用户 retry 出来的**新一代**
 * PENDING 任务改写成 TRANSLATING 并写进**旧 worker** 的 workerId；
 * 之后用户点取消，DELETE 路由按 task.workerId 去停机 —— 停错台，
 * 真正在跑的那台照跑不误（钱照烧、产物照产、用户以为已经停了）。
 */
async function markTaskTranslating(
  taskId: string,
  jobId: string,
  workerId: string
): Promise<void> {
  await prisma.translationTask.updateMany({
    where: { id: taskId, jobQueueId: jobId, status: { in: ['PENDING', 'TRANSLATING'] } },
    data: { status: 'TRANSLATING', workerId, errorMessage: null },
  });
}

// ─── 对账 ───

interface JobRow {
  id: string;
  startedAt: Date | null;
  attempt: number;
  maxAttempts: number;
  params: string | null;
}

async function reconcileProcessingJob(
  job: JobRow,
  fleet: TranslateFleetConfig
): Promise<void> {
  const params = parseJobParams(job.params);
  const task = await loadTask(params.taskId);
  if (!task || task.status === 'CANCELED') {
    const bound = workerById(fleet, params.workerId);
    if (bound) await deleteTranslateJob(bound, job.id).catch(() => undefined);
    // L24：deleteTaskFiles 是对整个任务目录的 `rm -rf`（含源文件）。用户「取消 → 重试」
    // 之后源文件必须留着给新一代用，而上一代的对账可能才刚跑到这里读到 CANCELED 快照。
    // 只有任务仍绑在本代调度行上时才允许清盘。
    if (task && (await stillOwnedByGeneration(task.id, job.id))) {
      await deleteTaskFiles(task.id).catch(() => undefined);
    }
    await prisma.jobQueue.updateMany({
      where: { id: job.id, status: JOB_STATUS.PROCESSING },
      data: {
        status: JOB_STATUS.FAILED,
        error: task ? '用户已取消' : '翻译任务已删除',
        completedAt: new Date(),
      },
    });
    return;
  }

  if (isSupersededGeneration(task, job.id)) {
    // 代次门：本代已被 retry 换掉。继续对账只会白占派发槽位
    //（totalSlots = 机队容量 − PROCESSING 行数），还可能把新一代的进度/状态写花。
    const staleWorker = workerById(fleet, params.workerId);
    if (staleWorker) await deleteTranslateJob(staleWorker, job.id).catch(() => undefined);
    await abandonSupersededJob(job.id);
    translateLogger.info(
      { jobId: job.id, taskId: task.id, currentJobId: task.jobQueueId },
      '过期代次调度行，停止对账'
    );
    return;
  }

  // H6：整体超时判定必须放在**接触 worker 之前**。
  // 原来它藏在下面 `switch (remote.status)` 的 default 分支里 —— 只有成功拿到 remote
  // 状态才会执行。而 getTranslateJob 抛非 404（连接超时/5xx/域名解析失败）时直接 throw，
  // 被 executeTick 的 per-job catch 吞成「下轮重试」：worker 断电或域名失效时，
  // MAX_WORKER_RUNTIME_MS 形同虚设，任务无限期挂在 PROCESSING，
  // 只等着被通用僵尸回收以错误方式（绕过 failJob、不退款）误杀。
  const startedAtMs = job.startedAt?.getTime() ?? Date.now();
  if (Date.now() - startedAtMs > MAX_WORKER_RUNTIME_MS) {
    const staleWorker = workerById(fleet, params.workerId);
    if (staleWorker) await deleteTranslateJob(staleWorker, job.id).catch(() => undefined);
    await failJob(job.id, new Error('worker 翻译超时'), { retryable: true });
    return;
  }

  const bound = workerById(fleet, params.workerId);
  if (!bound) {
    // PROCESSING 却无有效绑定（那台被删/禁用）：回炉重派（dispatch 会逐台找回）
    await prisma.jobQueue.updateMany({
      where: { id: job.id, status: JOB_STATUS.PROCESSING },
      data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
    });
    return;
  }

  let remote: TranslateJobStatus;
  try {
    remote = await getTranslateJob(bound, job.id);
  } catch (error) {
    if (error instanceof TranslateWorkerError && error.status === 404) {
      // worker 重启弄丢任务：清绑定回炉重推（jobId 不变，幂等）
      await writeJobParams(job.id, { ...params, workerId: undefined });
      await prisma.jobQueue.updateMany({
        where: { id: job.id, status: JOB_STATUS.PROCESSING },
        data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
      });
      translateLogger.info(
        { jobId: job.id, taskId: task.id, worker: bound.name },
        'worker 侧任务丢失，回炉重派'
      );
      return;
    }
    // H6 下半段：绑定台连不上（断电 / 域名失效 / 持续 5xx）。原来一路 throw 上去，
    // 由 executeTick 吞成「下轮重试」，任务就干等着那台自己复活 —— 可能永远不会。
    // 连续不可达超过阈值就解绑回炉，让 pickWorker（带健康探测）把它挪到活着的台上。
    const firstFailureMs = Number.isFinite(
      new Date(params.unreachableSince ?? '').getTime()
    )
      ? new Date(params.unreachableSince as string).getTime()
      : Date.now();
    if (Date.now() - firstFailureMs >= WORKER_UNREACHABLE_REBIND_MS) {
      await writeJobParams(job.id, {
        ...params,
        workerId: undefined,
        unreachableSince: undefined,
      });
      await prisma.jobQueue.updateMany({
        where: { id: job.id, status: JOB_STATUS.PROCESSING },
        data: { status: JOB_STATUS.SUBMITTED, startedAt: null },
      });
      translateLogger.warn(
        { jobId: job.id, taskId: task.id, worker: bound.name },
        'worker 持续不可达，解绑重派'
      );
      return;
    }
    if (!params.unreachableSince) {
      await writeJobParams(job.id, {
        ...params,
        unreachableSince: new Date(firstFailureMs).toISOString(),
      });
    }
    throw error;
  }

  // 拿到状态了 = 那台还活着，清掉不可达计时（否则一次抖动会永久拉高后续判定的基线）
  if (params.unreachableSince) {
    params.unreachableSince = undefined;
    await writeJobParams(job.id, { ...params, unreachableSince: undefined });
  }

  switch (remote.status) {
    case 'succeeded':
      await harvestJob(job.id, task, bound);
      return;
    case 'failed':
      await deleteTranslateJob(bound, job.id).catch(() => undefined);
      await failJob(job.id, new Error(remote.error || 'worker 翻译失败'), {
        retryable: true,
      });
      return;
    default: {
      // queued/running：进度回写 task 行（用户轮询直接读 task；变化才写）
      const percent = Number.isFinite(remote.progress)
        ? Math.max(0, Math.min(99, Math.round(remote.progress)))
        : 0;
      if (params.progress?.percent !== percent || params.progress?.stage !== (remote.stage ?? null)) {
        await writeJobParams(job.id, {
          ...params,
          progress: { stage: remote.stage ?? null, percent, at: new Date().toISOString() },
        });
        // M13：代次谓词。跨代窗口里旧代拿到的是**它自己那次翻译**的低进度，
        // 不带谓词就会反复盖掉新一代的真实进度，前端进度条来回跳。
        await prisma.translationTask
          .updateMany({
            where: { id: task.id, jobQueueId: job.id, status: 'TRANSLATING' },
            data: { progress: percent },
          })
          .catch(() => undefined);
      }
      // 超时判定已前移到本函数入口（H6）：它不能依赖「成功拿到 remote 状态」这个前提。
    }
  }
}

// ─── 收割与失败 ───

/**
 * 清盘（`rm -rf` 整个任务目录）前的代次复核：**必须重读**，不能用调用方手里的快照。
 *
 * 判定口径：
 *   - 行已不存在 → 允许清（DELETE 路由已经删过一次，我们刚 saveOutputFile 又把目录建了回来）；
 *   - 行还在且仍绑本代 → 允许清；
 *   - 行还在但绑了别代（用户已 retry）→ **不许清**，那是新一代的源文件；
 *   - 查询本身失败 → 不许清（保守：宁可留垃圾也不能误删源文件）。
 */
async function stillOwnedByGeneration(taskId: string, jobId: string): Promise<boolean> {
  try {
    const fresh = await prisma.translationTask.findUnique({
      where: { id: taskId },
      select: { jobQueueId: true },
    });
    return fresh === null || fresh.jobQueueId === jobId;
  } catch {
    return false;
  }
}

async function harvestJob(
  jobId: string,
  task: TaskRow,
  worker: TranslateWorkerConfig
): Promise<void> {
  // mono 必得；dual 允许缺（worker 侧按参数可能只产单语）
  const mono = await downloadTranslateOutput(worker, jobId, 'mono');
  let dual: { data: Buffer } | null = null;
  try {
    dual = await downloadTranslateOutput(worker, jobId, 'dual');
  } catch (error) {
    if (!(error instanceof TranslateWorkerError) || error.status !== 404) {
      throw error;
    }
  }

  // H4：落盘前先复核代次。产物目录按 taskId 共享，而上面的下载对大文档要几十秒 ——
  // 这段时间里用户完全可能已经 retry。抢先落盘会把新一代的 mono/dual 覆盖掉
  //（内容是同一份原文的译文，但进度/计费口径已经错位）。
  if (!(await stillOwnedByGeneration(task.id, jobId))) {
    await abandonSupersededJob(jobId);
    await deleteTranslateJob(worker, jobId).catch(() => undefined);
    translateLogger.info(
      { jobId, taskId: task.id },
      '下载期间代次已变更，丢弃本代产物'
    );
    return;
  }

  const monoPath = await saveOutputFile(task.id, 'mono', mono.data);
  const dualPath = dual ? await saveOutputFile(task.id, 'dual', dual.data) : null;

  // H4：**必须**带 jobQueueId 代次谓词（文件头的代次不变式）。
  // 少了它，上一代的迟到收割会命中用户 retry 出来的新一代任务：用旧产物把它标成
  // COMPLETED、顺手吊销 proxyTokenHash（新一代那台 worker 的 LLM 当场全 401）；
  // 随后新一代自己翻完来收割时 count===0，而彼时 task.jobQueueId 恰恰等于它自己，
  // 于是走进下面的清盘分支把**整个任务目录 rm -rf**（含源文件）——
  // 终态是「界面显示已完成 + 下载 404 + 新扣的钱不退 + 想重试还提示源文件已清理」。
  const updated = await prisma.translationTask.updateMany({
    where: { id: task.id, jobQueueId: jobId, status: { in: ['PENDING', 'TRANSLATING'] } },
    data: {
      status: 'COMPLETED',
      progress: 100,
      monoPath,
      dualPath,
      errorMessage: null,
      completedAt: new Date(),
      proxyTokenHash: null, // 任务终态即吊销代理凭据
    },
  });
  if (updated.count === 0) {
    // 任务在下载期间被取消/删除、或已被 retry 换代：清落盘产物，调度行终态。
    // L24：只清本代的盘（用户可能已经 retry，新一代还要用源文件）。
    // 这里刻意**重读**而不是用 task 快照：loadTask 到这里之间隔着整段下载
    //（大文档几十 MB，几秒到几十秒），快照里的 jobQueueId 完全可能已经过期 ——
    // 拿过期快照判「还是我的」再 rm -rf，删掉的正是新一代的源文件。
    if (await stillOwnedByGeneration(task.id, jobId)) {
      await deleteTaskFiles(task.id).catch(() => undefined);
    }
    await prisma.jobQueue.updateMany({
      where: { id: jobId, status: JOB_STATUS.PROCESSING },
      data: { status: JOB_STATUS.FAILED, error: '任务已取消', completedAt: new Date() },
    });
    await deleteTranslateJob(worker, jobId).catch(() => undefined);
    return;
  }

  await prisma.jobQueue
    .update({
      where: { id: jobId },
      data: {
        status: JOB_STATUS.SUCCESS,
        result: JSON.stringify({
          monoPath,
          dualPath,
          monoBytes: mono.data.length,
          dualBytes: dual?.data.length ?? null,
        }),
        completedAt: new Date(),
      },
    })
    .catch((err) =>
      translateLogger.warn({ jobId, err: serializeError(err) }, '标记任务成功失败')
    );
  await deleteTranslateJob(worker, jobId).catch(() => undefined);
  notifyTaskFinished(task.id, 'completed');
  translateLogger.info(
    { jobId, taskId: task.id, monoBytes: mono.data.length },
    '文档翻译完成并已回存'
  );
}

async function failJob(
  jobId: string,
  error: unknown,
  options: { retryable: boolean }
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const job = await prisma.jobQueue.findUnique({ where: { id: jobId } });
  if (!job) return;

  const canRetry = options.retryable && job.attempt < job.maxAttempts;
  const params = parseJobParams(job.params);
  if (canRetry) {
    const backoff = RETRY_BACKOFF_MS[Math.min(job.attempt - 1, RETRY_BACKOFF_MS.length - 1)];
    params.nextRetryAt = new Date(Date.now() + backoff).toISOString();
  } else {
    delete params.nextRetryAt;
  }

  await prisma.jobQueue
    .update({
      where: { id: jobId },
      data: {
        status: JOB_STATUS.FAILED,
        error: message.slice(0, 1000),
        params: JSON.stringify(params),
        completedAt: new Date(),
      },
    })
    .catch((err) =>
      translateLogger.warn({ jobId, err: serializeError(err) }, '标记任务失败失败')
    );

  const taskId = params.taskId;
  if (taskId) {
    // L24：所有对 TranslationTask 的写都带 `jobQueueId: jobId` 代次谓词。
    // 用户 retry 会把任务重置回 PENDING + 重新扣一次费 + 换一条新调度行，此时若上一代的
    // failJob 才姗姗来迟，它会把刚重试的任务打成 FAILED 并退掉**新一代**的钱
    //（refundedAt 被 retry 清成 null，幂等闸拦不住）——用户白拿一次翻译。
    // TranslationTask.jobQueueId 就是天然的代次令牌：retry 事务里先置 null，
    // 再由 enqueueDocTranslate 绑到新行，旧代次的谓词永远匹配不上。
    if (canRetry) {
      // 等待自动重试期间对用户仍显示「翻译中」，不闪失败
      await prisma.translationTask
        .updateMany({
          where: { id: taskId, jobQueueId: jobId, status: 'TRANSLATING' },
          data: { errorMessage: null },
        })
        .catch(() => undefined);
    } else {
      const marked = await prisma.translationTask
        .updateMany({
          where: {
            id: taskId,
            jobQueueId: jobId,
            status: { in: ['PENDING', 'TRANSLATING'] },
          },
          data: {
            status: 'FAILED',
            errorMessage: message.slice(0, 500),
            proxyTokenHash: null,
          },
        })
        .catch(() => ({ count: 0 }));
      if (marked.count > 0) {
        await refundTaskCharge(taskId, '翻译失败自动退款', jobId);
        notifyTaskFinished(taskId, 'failed');
      }
    }
  }
  translateLogger.warn(
    { jobId, taskId, retryable: canRetry, error: message },
    canRetry ? '文档翻译失败，稍后自动重试' : '文档翻译终态失败'
  );
}

/**
 * 终态失败/取消的全额退款。幂等闸：refundedAt 的条件 CAS 抢占（赢家才真正入账），
 * 杜绝「对账与取消路由并发都退一次」的双退。chargedCents=0（未扣费）直接跳过。
 *
 * L22：CAS 抢占 + 读金额 + 钱包入账三步必须同事务。原来是三条独立语句，
 * 中间任一步挂掉都会留下「refundedAt 已写、钱没到账」的状态 —— 幂等闸从此挡住所有重试，
 * 这笔钱永久消失（补偿写 refundedAt=null 本身也可能挂）。refundWalletCents 本就收
 * 可选 tx 参数，包进来后失败即整体回滚，refundedAt 自动还原，不需要任何补偿写。
 *
 * L24：可选的 expectJobQueueId 代次守卫 —— 只有当任务仍绑在发起方那一代调度行上时才退，
 * 防止上一代的迟到失败退掉用户重试后新扣的那笔钱。
 */
export async function refundTaskCharge(
  taskId: string,
  note: string,
  expectJobQueueId?: string
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.translationTask.updateMany({
        where: {
          id: taskId,
          refundedAt: null,
          chargedCents: { gt: 0 },
          ...(expectJobQueueId ? { jobQueueId: expectJobQueueId } : {}),
        },
        data: { refundedAt: new Date() },
      });
      if (claimed.count === 0) return;
      const task = await tx.translationTask.findUnique({
        where: { id: taskId },
        select: { userId: true, chargedCents: true },
      });
      if (!task) return;
      await refundWalletCents(
        {
          userId: task.userId,
          amountCents: task.chargedCents,
          type: 'translation_refund',
          note: `${note} doc-translate:${taskId}`,
        },
        tx
      );
    });
  } catch (error) {
    // 事务已整体回滚（refundedAt 自动还原），兜底路径下轮重试
    translateLogger.error(
      { taskId, err: serializeError(error) },
      '翻译退款入账失败（事务已回滚，等待重试）'
    );
  }
}

/** 完成/失败通知（邮件接偶合放 emailNotify 模块；fire-and-forget，不阻塞调度） */
function notifyTaskFinished(taskId: string, outcome: 'completed' | 'failed'): void {
  import('@/lib/translate/notify')
    .then(({ sendDocTranslateNotification }) =>
      sendDocTranslateNotification(taskId, outcome)
    )
    .catch(() => undefined);
}
