/**
 * 录音收尾/状态同步的纯决策逻辑。
 *
 * 从 session 页面（一个巨大的 client component）中抽出，便于单测锁定回归：
 * 这些判定曾是「会话被服务端回收后客户端静默删库丢录音」这条 critical 的核心环节
 * （审计 2026-07-10）。规则一旦写错，用户续录的音频与转录会在停止时被无声销毁，
 * 所以必须有独立、可测的真值表。
 */

/**
 * 客户端 PATCH /api/sessions/:id 同步录制状态的结果分类。
 *
 * P2-1：不再把所有 4xx 都笼统当成「会话被回收」。401/403 是认证/权限问题，
 * 与「会话状态被服务端收尾」是两回事，误判成回收会让用户莫名看到「会话已结束」并
 * 触发本地清理路径。故细分：
 */
export type StatusSyncResult =
  | 'ok'
  | 'conflict' // 400/409：状态迁移冲突——会话多半已被收尾/回收（真正的 reclaim 信号）
  | 'not-found' // 404：会话已被删除（同样应视为 reclaim，本地不该继续假装在录）
  | 'unauthorized' // 401：token 失效/过期，需重新认证，**不是**会话被回收
  | 'forbidden' // 403：无权限，**不是**会话被回收
  | 'rejected' // 其它 4xx 兜底（保守视为被拒，但不特指某语义）
  | 'network-error';

/**
 * 把 PATCH 状态同步的响应归类。
 *
 * - `ok`            : 2xx，后端已接受状态迁移。
 * - `conflict`      : 400/409（典型「Invalid status transition」）——后端拒绝把会话
 *                     置回 RECORDING/PAUSED，几乎总是因为会话已被收尾成
 *                     COMPLETED/ARCHIVED 或正在 FINALIZING（多为服务端
 *                     reclaimStaleSessions 回收）。是真正的 reclaim 信号。
 * - `not-found`     : 404——会话已被删除，同样按 reclaim 处理。
 * - `unauthorized`  : 401——认证失效，应引导重新登录，**不能**当成会话被回收。
 * - `forbidden`     : 403——无权限，**不能**当成会话被回收。
 * - `rejected`      : 其它 4xx 兜底。
 * - `network-error` : fetch 抛错（断网等）或 5xx 临时故障——**不能**判定为被回收，
 *                     否则一次瞬断/服务端抖动就会误报。
 */
export function classifyStatusSync(
  outcome: { ok: boolean; status: number } | { error: true }
): StatusSyncResult {
  if ('error' in outcome) return 'network-error';
  if (outcome.ok) return 'ok';
  const status = outcome.status;
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 400 || status === 409) return 'conflict';
  if (status >= 400 && status < 500) return 'rejected';
  return 'network-error';
}

/**
 * 判定一次状态同步结果是否代表「会话已在服务端被收尾/回收」——只有这些结果才应触发
 * 客户端的「会话已结束」提示与相应清理。401/403（认证/权限）、network-error（瞬断/5xx）
 * 一律不算，避免误报（P2-1）。
 */
export function isSessionReclaimedResult(result: StatusSyncResult): boolean {
  return result === 'conflict' || result === 'not-found';
}

/** finalize 端点响应的语义分类，决定客户端能否安全销毁本地副本。 */
export type FinalizeOutcome =
  | { kind: 'ok' }
  | { kind: 'already-completed' }
  | { kind: 'error'; message?: string };

/**
 * 判定一次 finalize 调用的结果。
 *
 * 核心不变量：**只有 `ok` 才允许清空本地 sessionStorage / IndexedDB 音频。**
 *
 * - `already-completed`: 服务端返回 `{ success:true, alreadyCompleted:true }`。会话在本
 *   客户端之外已被收尾（服务端回收 / 另一标签抢先），本次随请求带上的 segments/音频
 *   **没有被服务端采纳**。此时本地缓存可能是唯一完整副本，绝不能清 —— 否则续录内容
 *   静默全丢（审计 critical）。调用方须保留本地数据并明确提示用户。
 * - `error`: 非 2xx，携带服务端 error 文案（若有）。
 * - `ok`: 正常收尾，服务端已持久化本地数据，清缓存是安全的。
 */
export function resolveFinalizeOutcome(ok: boolean, body: unknown): FinalizeOutcome {
  const record =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

  if (!ok) {
    const message = typeof record.error === 'string' ? record.error : undefined;
    return { kind: 'error', message };
  }

  if (record.alreadyCompleted === true) {
    return { kind: 'already-completed' };
  }

  return { kind: 'ok' };
}

/** 刷新/导航恢复的分派模式，由后端 status + 挂载时本地录音态共同决定。 */
export type RecoveryMode =
  | 'pending'
  | 'terminal'
  | 'finalizing'
  | 'live-refresh'
  | 'resume-cold'
  | 'fresh';

/**
 * 全局实时 store 的 recordingState 只有在明确绑定到本会话时才作数（P0-3）。
 *
 * 背景：transcript store 是 SPA 内的内存单例，导航到别的会话不会销毁它。若直接拿
 * `store.recordingState` 当「本会话本地是否在录」，会话 A 录音中导航到 B 时，B 会读到
 * A 的 recording 态、进而 deriveRecoveryMode → live-refresh，复用 A 的 segments/计时/
 * processor，造成 A 的转录写进 B、音频/转录错配（审计 critical）。
 *
 * 规则：
 * - store 已绑定到别的会话（activeSessionId 有值且 ≠ 本会话）→ 一律视为「本会话本地无录音」
 *   （返回 null），绝不据此走 live-refresh。
 * - store 未绑定（activeSessionId 为空，如旧版持久化数据 / 刷新前未写入）→ 保守回退到
 *   信任 recordingState，保持既有刷新恢复行为不回归。
 * - store 绑定到本会话 → 返回其 recordingState。
 */
export function localRecordingForSession(
  storeActiveSessionId: string | null | undefined,
  pageSessionId: string,
  storeRecordingState: string | null | undefined
): string | null {
  if (storeActiveSessionId && storeActiveSessionId !== pageSessionId) {
    return null;
  }
  return storeRecordingState ?? null;
}

/**
 * 推导恢复分派模式 —— 四个恢复分支（自动续录 / 冷恢复 draft / FINALIZING 遮罩 /
 * clear 守卫）的单一权威。从 page.tsx 的 useMemo 抽出便于单测。
 *
 * @param sessionChecked  后端 status 是否已拉回（false → pending，任何恢复/清除都不动）
 * @param backendStatus   后端会话状态；**GET 失败或响应缺 status 字段时为 null**
 * @param localRecording  挂载时本地 store 的 recordingState 快照
 *
 * 关键修复（审计 high）：`backendStatus === null`（拉取失败/无 status）时，**不能**无脑
 * 判 fresh —— 若本地明确处于 recording/paused，说明这台设备正在录，必须保守视同
 * live-refresh 恢复到 paused 展示，保护本地录音；否则一次网络抖动就会把进行中的会话
 * 当成新会话，后续开录会清除覆盖。只有本地也不在录时才真的当 fresh。
 */
export function deriveRecoveryMode(
  sessionChecked: boolean,
  backendStatus: string | null | undefined,
  localRecording: string | null | undefined
): RecoveryMode {
  if (!sessionChecked) return 'pending';
  if (backendStatus === 'COMPLETED' || backendStatus === 'ARCHIVED') return 'terminal';
  if (backendStatus === 'FINALIZING') return 'finalizing';

  const localActive = localRecording === 'recording' || localRecording === 'paused';

  if (backendStatus === 'RECORDING' || backendStatus === 'PAUSED') {
    return localActive ? 'live-refresh' : 'resume-cold';
  }

  // backendStatus 未知（拉取失败 / 无 status）：本地在录 → 保护本地（live-refresh），
  // 否则才当新会话。
  if (localActive) return 'live-refresh';
  return 'fresh';
}

/**
 * 回放/查看页在同步/清空全局实时 store 前的守卫：若此刻正有活跃录音（麦克风开着），
 * 回放页既不应清空、也不应把自己的历史 segments 灌进全局 store —— 否则会抹掉/污染
 * 正在进行的录音状态（含刷新恢复所依赖的 sessionStorage 快照）。审计 high：录音中
 * 打开回放页 clearAll 毁掉 live-refresh 本地状态。
 *
 * 只拦 'recording'（真正开着麦克风）：'paused' 允许去看回放，其本地状态被清后仍可由
 * resume-cold 从服务端 draft 兜底恢复，且不与「已回收→paused」态相互干扰。
 */
export function isActivelyRecording(recordingState: string | null | undefined): boolean {
  return recordingState === 'recording';
}

/**
 * P1-8：受保护的录音上下文 —— recording / paused / finalizing 三态都算「活跃」，回放页
 * 一律不得清空/覆盖全局实时 store。
 *
 * 背景（审计 P1-8）：旧的 `isActivelyRecording` 只拦 'recording'，允许 paused 时回放页
 * clearAll。但断网、或最近一个分片（现在最长 3s）尚未上传到服务端时，paused 态下
 * store 里的 segments/preview/摘要/计时可能是**唯一**副本，被清后 resume-cold 也恢复不回
 * （服务端 draft 缺尾）。finalizing 更是收尾进行中，清空会直接毁掉正在提交的数据。
 * 故三态都视为受保护上下文。
 */
export function isProtectedRecordingContext(
  recordingState: string | null | undefined
): boolean {
  return (
    recordingState === 'recording' ||
    recordingState === 'paused' ||
    recordingState === 'finalizing'
  );
}

/**
 * P1-8 / P0-3：回放页是否应「让位」给活跃录音 store（不清空、不灌历史）。按 sessionId 隔离：
 *
 * - store 绑定到**本**会话（或未绑定的旧数据 activeSessionId 为空）且处于受保护录音上下文
 *   → 让位：本会话的实时录音/暂停/收尾尚未安全落库，回放页不得清空或覆盖。
 * - store 绑定到**别的**会话（activeSessionId 有值且 ≠ 回放页会话）→ **不让位**：回放 B
 *   绝不能被 A 的实时 store 挡住，否则要么把 A 的 live segments 暴露成 B 的回放（跨会话
 *   泄漏），要么 B 自己的历史永远灌不进来（数据丢失）——P0-3 回归。回放 B 应清掉外来
 *   的 A store 并载入 B 自己的历史（A 的未落库数据由会话页 unmount 的最终 flush 保护）。
 * - 非受保护态（idle/stopped）→ 不让位，回放页可正常同步展示历史。
 */
export function shouldPlaybackYieldToLiveStore(
  storeActiveSessionId: string | null | undefined,
  playbackSessionId: string,
  storeRecordingState: string | null | undefined
): boolean {
  return (
    isProtectedRecordingContext(storeRecordingState) &&
    (storeActiveSessionId == null || storeActiveSessionId === playbackSessionId)
  );
}

/**
 * P0-5 契约2：草稿音频完整性判定 —— 用「集合包含」而非数量比较。
 *
 * 期望区间为 `[0..maxSeq]`（maxSeq = 本地已录最大 seq，即本设备录到的最后一片）；该区间内
 * 每一个 seq 都必须已存在于远端集合（服务端确认已收）。首块必须是 seq 0：缺 seq 0
 * （leading gap）一律判不完整。
 *
 * 旧的数量判断（`remoteSet.size >= localCount`）会把 `local=[0,1] / remote=[0,9]` 误判为
 * 完整（两边都是 2 个），从而清掉本地唯一完整副本（审计 P0-5 critical 反例）。
 *
 * @param localSeqs  本地 IndexedDB 已落盘的分片 seq 列表
 * @param remoteSeqs 服务端已确认收到的分片 seq 集合（或列表）
 */
export function isRecordingDraftComplete(
  localSeqs: readonly number[],
  remoteSeqs: readonly number[] | ReadonlySet<number>
): boolean {
  // 无本地分片：本设备没有需要保护的音频（空录音 / 冷设备尚未采集），完整性不成立障碍。
  if (localSeqs.length === 0) {
    return true;
  }

  let maxSeq = -1;
  for (const seq of localSeqs) {
    if (Number.isInteger(seq) && seq > maxSeq) {
      maxSeq = seq;
    }
  }
  if (maxSeq < 0) {
    return false;
  }

  const remote = Array.isArray(remoteSeqs)
    ? new Set(remoteSeqs)
    : (remoteSeqs as ReadonlySet<number>);

  // [0..maxSeq] 每个 seq 都必须在远端集合中；从 0 起遍历天然覆盖 leading gap（缺 seq 0）。
  for (let seq = 0; seq <= maxSeq; seq += 1) {
    if (!remote.has(seq)) {
      return false;
    }
  }
  return true;
}
