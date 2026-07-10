'use client';

/**
 * 浏览器端：完整版补全转录（对已录完会话的完整音频重跑 Soniox 异步文件转录）的
 * 触发 + 状态轮询封装。轮询退避复用 asyncUploadClient 的思路：
 *   - 状态收尾由 GET full-transcribe-status 驱动（transcribing 时服务端就地 poll Soniox 并 finalize），
 *     没有 client poll 转录就永远停在 transcribing —— 所以触发后必须一直 poll 到终态。
 *   - 429（服务端对高频 poll 限流）/ 5xx / 网络抖动都当作非致命：退避后继续，绝不中断轮询。
 */

export type FullTranscribeStatus =
  | 'pending'
  | 'transcoding'
  | 'transcribing'
  | 'finalizing'
  | 'completed'
  | 'failed';

/** 进行中（非终态）的状态集合 —— 决定按钮是否禁用、是否需要接管轮询。 */
const IN_PROGRESS: readonly FullTranscribeStatus[] = [
  'pending',
  'transcoding',
  'transcribing',
  'finalizing',
];

export function isFullTranscribeInProgress(
  status: string | null | undefined
): boolean {
  return !!status && IN_PROGRESS.includes(status as FullTranscribeStatus);
}

export interface TriggerFullTranscribeResult {
  /** res.ok（200 系）。402/409 等为 false。 */
  ok: boolean;
  httpStatus: number;
  status?: FullTranscribeStatus;
  /** 200 首次触发返回的预估计费分钟（ceil(可计费分钟 × 异步倍率)）。 */
  estimatedMinutes?: number;
  /** 已在跑：服务端返回 { alreadyRunning:true, status }。 */
  alreadyRunning?: boolean;
  error?: string;
}

/**
 * POST /api/sessions/:id/full-transcribe 触发一次完整版补全转录。
 * 200: { status:'pending', estimatedMinutes } 或 { alreadyRunning:true, status }
 * 402: 额度不足 { error, estimatedMinutes }；409: 会话未完成/无录音。
 */
export async function triggerFullTranscribe(
  sessionId: string,
  authToken: string
): Promise<TriggerFullTranscribeResult> {
  const res = await fetch(`/api/sessions/${sessionId}/full-transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
  });
  const body = (await res.json().catch(() => ({}))) as {
    status?: FullTranscribeStatus;
    estimatedMinutes?: number;
    alreadyRunning?: boolean;
    error?: string;
  };
  return {
    ok: res.ok,
    httpStatus: res.status,
    status: body.status,
    estimatedMinutes: body.estimatedMinutes,
    alreadyRunning: body.alreadyRunning,
    error: body.error,
  };
}

export interface PollFullTranscribeOptions {
  onStatusChange?: (status: FullTranscribeStatus) => void;
  signal?: AbortSignal;
  /** 正常轮询间隔（默认 1500ms）。 */
  intervalMs?: number;
  /** 429/5xx/网络抖动的退避时长（默认 3000ms）。 */
  retryDelayMs?: number;
}

export interface PollFullTranscribeResult {
  finalStatus: FullTranscribeStatus | null;
  error?: string;
  hasFullTranscript: boolean;
  segmentCount?: number;
}

/**
 * 轮询 GET /api/sessions/:id/full-transcribe-status 直到进入终态
 * （completed / failed / null）。中途 429/5xx/网络错误退避重试，不中断。
 * signal abort → 立即返回当前已知状态（finalStatus 为最后一次收到的状态）。
 */
export async function pollFullTranscribeStatus(
  sessionId: string,
  authToken: string,
  opts: PollFullTranscribeOptions = {}
): Promise<PollFullTranscribeResult> {
  const interval = opts.intervalMs ?? 1500;
  const retryDelay = opts.retryDelayMs ?? 3000;
  const signal = opts.signal;
  let last: FullTranscribeStatus | null = null;

  while (true) {
    if (signal?.aborted) {
      return { finalStatus: last, hasFullTranscript: false };
    }
    await sleep(interval, signal).catch(() => undefined);
    if (signal?.aborted) {
      return { finalStatus: last, hasFullTranscript: false };
    }

    let res: Response;
    try {
      res = await fetch(`/api/sessions/${sessionId}/full-transcribe-status`, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal,
      });
    } catch {
      if (signal?.aborted) {
        return { finalStatus: last, hasFullTranscript: false };
      }
      // 网络抖动：退避后继续
      await sleep(retryDelay, signal).catch(() => undefined);
      continue;
    }

    if (!res.ok) {
      // 429（限流）/ 5xx（暂时性）：退避重试，绝不中断收尾驱动
      if (res.status >= 500 || res.status === 429) {
        await sleep(retryDelay, signal).catch(() => undefined);
        continue;
      }
      // 4xx（401/403/404 等）：致命，停止
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      return {
        finalStatus: 'failed',
        hasFullTranscript: false,
        error: errBody.error || `HTTP ${res.status}`,
      };
    }

    const body = (await res.json().catch(() => ({}))) as {
      status?: FullTranscribeStatus | null;
      error?: string | null;
      hasFullTranscript?: boolean;
      segmentCount?: number;
    };
    const status = (body.status ?? null) as FullTranscribeStatus | null;

    if (status && status !== last) {
      last = status;
      opts.onStatusChange?.(status);
    }

    if (status === 'completed') {
      return {
        finalStatus: 'completed',
        hasFullTranscript: Boolean(body.hasFullTranscript),
        segmentCount: body.segmentCount,
      };
    }
    if (status === 'failed') {
      return {
        finalStatus: 'failed',
        hasFullTranscript: false,
        error: body.error || 'Full transcription failed',
      };
    }
    if (status === null) {
      // 状态被清空 / 从未触发：无进行中任务，结束轮询
      return {
        finalStatus: null,
        hasFullTranscript: Boolean(body.hasFullTranscript),
      };
    }
    // pending / transcoding / transcribing / finalizing：继续下一拍
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
