/**
 * 录音收尾/状态同步的纯决策逻辑。
 *
 * 从 session 页面（一个巨大的 client component）中抽出，便于单测锁定回归：
 * 这些判定曾是「会话被服务端回收后客户端静默删库丢录音」这条 critical 的核心环节
 * （审计 2026-07-10）。规则一旦写错，用户续录的音频与转录会在停止时被无声销毁，
 * 所以必须有独立、可测的真值表。
 */

/** 客户端 PATCH /api/sessions/:id 同步录制状态的结果分类。 */
export type StatusSyncResult = 'ok' | 'rejected' | 'network-error';

/**
 * 把 PATCH 状态同步的响应归类。
 *
 * - `ok`            : 2xx，后端已接受状态迁移。
 * - `rejected`      : 4xx（典型 400「Invalid status transition」）——后端拒绝把会话
 *                     置回 RECORDING/PAUSED，几乎总是因为会话已被收尾成
 *                     COMPLETED/ARCHIVED 或正在 FINALIZING（多为服务端
 *                     reclaimStaleSessions 回收）。调用方应据此提示「会话已在服务器结束」，
 *                     而不是继续假装在录。
 * - `network-error` : fetch 抛错（断网等）——**不能**判定为被回收，否则一次瞬断就会误报。
 *
 * 注意 5xx 归入 `network-error` 而非 `rejected`：服务端临时故障不代表会话状态改变。
 */
export function classifyStatusSync(
  outcome: { ok: boolean; status: number } | { error: true }
): StatusSyncResult {
  if ('error' in outcome) return 'network-error';
  if (outcome.ok) return 'ok';
  if (outcome.status >= 400 && outcome.status < 500) return 'rejected';
  return 'network-error';
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
