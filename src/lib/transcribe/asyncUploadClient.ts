'use client';

/**
 * 浏览器端：把一个文件分片上传到 /api/sessions/[id]/async-upload/chunks，
 * 然后调用 finalize 触发后端 ffmpeg + Soniox pipeline，再轮询 status 直到完成。
 *
 * 分片：20MB / 片，并发度 3（典型家宽 50-200Mbps 下吞吐和服务端处理速度匹配）。
 * 失败重试：每片最多重试 2 次（指数退避）。
 */

export const CHUNK_SIZE = 20 * 1024 * 1024;
const CONCURRENCY = 3;
const PER_CHUNK_RETRIES = 2;

export type AsyncUploadStatus =
  | 'uploading_chunks'
  | 'transcoding'
  | 'uploading_to_soniox'
  | 'transcribing'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'canceled';

interface StartOptions {
  file: File;
  sessionId: string;
  authToken: string;
  onUploadProgress?: (fraction: number) => void;
  /** 后端处理阶段（目前仅 transcoding）的子进度 0~1，由 status route 推送 */
  onProcessingProgress?: (fraction: number) => void;
  onStatusChange?: (status: AsyncUploadStatus) => void;
  signal?: AbortSignal;
}

interface StartResult {
  sessionId: string;
  finalStatus: AsyncUploadStatus;
  error?: string;
}

export function startAsyncUpload(opts: StartOptions): {
  promise: Promise<StartResult>;
  cancel: () => void;
} {
  const abort = new AbortController();
  const composed: AbortSignal = opts.signal
    ? anySignal([opts.signal, abort.signal])
    : abort.signal;

  const promise = (async (): Promise<StartResult> => {
    try {
      return await runPipeline();
    } catch (err) {
      // cancel 路径：abort signal 触发后，sleep / fetch 会抛 AbortError。
      // 这里统一转成 canceled 结果，避免被上层当作失败弹错 toast。
      if (composed.aborted) {
        return { sessionId: opts.sessionId, finalStatus: 'canceled' };
      }
      throw err;
    }
  })();

  async function runPipeline(): Promise<StartResult> {
    const totalChunks = Math.max(1, Math.ceil(opts.file.size / CHUNK_SIZE));

    // ── 1. init ──
    await callJson(
      `/api/sessions/${opts.sessionId}/async-upload/init`,
      {
        method: 'POST',
        headers: jsonHeaders(opts.authToken),
        body: JSON.stringify({
          originalFileName: opts.file.name,
          originalMimeType: opts.file.type || 'application/octet-stream',
          originalSize: opts.file.size,
          totalChunks,
          chunkSize: CHUNK_SIZE,
        }),
        signal: composed,
      },
      'init upload'
    );

    // ── 2. 分片上传（并发 + 进度） ──
    opts.onStatusChange?.('uploading_chunks');
    let uploadedCount = 0;
    await runWithConcurrency(totalChunks, CONCURRENCY, async (seq) => {
      const start = seq * CHUNK_SIZE;
      const end = Math.min(opts.file.size, start + CHUNK_SIZE);
      const blob = opts.file.slice(start, end);

      await uploadOneChunkWithRetry({
        sessionId: opts.sessionId,
        seq,
        blob,
        token: opts.authToken,
        signal: composed,
      });

      uploadedCount += 1;
      opts.onUploadProgress?.(uploadedCount / totalChunks);
    });

    // ── 3. finalize ──
    await callJson(
      `/api/sessions/${opts.sessionId}/async-upload/finalize`,
      {
        method: 'POST',
        headers: jsonHeaders(opts.authToken),
        signal: composed,
      },
      'finalize upload'
    );

    // ── 4. poll status ──
    const poll = await pollAsyncTranscribeStatus(opts.sessionId, opts.authToken, {
      onStatusChange: opts.onStatusChange,
      onProcessingProgress: opts.onProcessingProgress,
      signal: composed,
    });
    return {
      sessionId: opts.sessionId,
      finalStatus: poll.finalStatus,
      error: poll.error,
    };
  }

  return {
    promise,
    cancel: () => abort.abort(),
  };
}

interface PollOptions {
  /** 后端处理阶段（目前仅 transcoding）的子进度 0~1，由 status route 推送 */
  onProcessingProgress?: (fraction: number) => void;
  onStatusChange?: (status: AsyncUploadStatus) => void;
  signal?: AbortSignal;
  /**
   * 轮询起点状态。默认 transcoding（startAsyncUpload finalize 后的阶段）；
   * 刷新重连场景应传入服务端当前状态，避免进度条先倒退一格再修正。
   */
  initialStatus?: AsyncUploadStatus;
}

interface PollResult {
  finalStatus: AsyncUploadStatus;
  error?: string;
}

/**
 * 轮询 /api/sessions/[id]/async-transcribe-status 直到进入终态。
 *
 * 关键点：服务端 async pipeline 的"拉 transcript + 写盘 + 标 completed"那一步是由这个
 * GET 请求驱动的——没有 client poll，转录就永远停在 transcribing。所以刷新页面后必须
 * 重新挂上这个 poll（见 UploadJobsTracker），否则 session 变僵尸。
 *
 * 起始状态默认 transcoding（startAsyncUpload finalize 后即进入此阶段）；
 * 刷新重连场景下首个响应会立刻把真实状态透传给 onStatusChange。
 */
export async function pollAsyncTranscribeStatus(
  sessionId: string,
  authToken: string,
  opts: PollOptions = {}
): Promise<PollResult> {
  const signal = opts.signal;
  let lastStatus: AsyncUploadStatus = opts.initialStatus ?? 'transcoding';
  let lastProgress = -1;
  opts.onStatusChange?.(lastStatus);

  while (true) {
    if (signal?.aborted) {
      return { finalStatus: 'canceled' };
    }
    // 1.5s 间隔：足够快感知状态变化，又不至于 hammer 服务端
    await sleep(1500, signal);
    if (signal?.aborted) {
      return { finalStatus: 'canceled' };
    }

    const res = await fetch(
      `/api/sessions/${sessionId}/async-transcribe-status`,
      { headers: { Authorization: `Bearer ${authToken}` }, signal }
    );
    if (!res.ok) {
      // 502/503 等暂时性错误：继续 poll，不立即失败。
      // U35：429（服务端自身对高频 poll 的限流）同样是非致命的——它恰恰意味着
      // "还在轮询、只是太快了"。旧代码把 <500 一律 throw，会因一次 429 直接中断轮询，
      // 而收尾（拉 transcript + 标 completed + 扣费）正是由这个 poll 驱动的，导致已完成
      // 的转录卡死不收尾。这里把 429 纳入退避重试：多等一拍（叠加下方 sleep(1500)）再继续。
      if (res.status >= 500 || res.status === 429) {
        await sleep(3000, signal).catch(() => undefined);
        continue;
      }
      const errBody = await readError(res);
      throw new Error(`Status check failed: ${errBody}`);
    }
    const body = (await res.json()) as {
      status: AsyncUploadStatus | null;
      error?: string;
      processingProgress?: number;
    };

    if (!body.status) {
      // session 没有 async 状态 —— 异常情况，当失败处理
      throw new Error('Server returned null status');
    }

    if (body.status !== lastStatus) {
      lastStatus = body.status;
      opts.onStatusChange?.(lastStatus);
    }

    // transcoding 阶段把后端 ffmpeg 实时进度透传给上层（值无变化时不触发回调）
    if (
      typeof body.processingProgress === 'number' &&
      Number.isFinite(body.processingProgress)
    ) {
      const progress = Math.min(1, Math.max(0, body.processingProgress));
      if (progress !== lastProgress) {
        lastProgress = progress;
        opts.onProcessingProgress?.(progress);
      }
    }

    if (body.status === 'completed') {
      return { finalStatus: 'completed' };
    }
    if (body.status === 'failed') {
      return {
        finalStatus: 'failed',
        error: body.error || 'Transcription failed',
      };
    }
    if (body.status === 'canceled') {
      return { finalStatus: 'canceled' };
    }
  }
}

// ─── 内部 helpers ───

function jsonHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function callJson(
  url: string,
  init: RequestInit,
  label: string
): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const errBody = await readError(res);
    throw new Error(`${label} failed (${res.status}): ${errBody}`);
  }
  return await res.json().catch(() => ({}));
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    /* fall through */
  }
  return `HTTP ${res.status}`;
}

async function uploadOneChunkWithRetry(args: {
  sessionId: string;
  seq: number;
  blob: Blob;
  token: string;
  signal: AbortSignal;
}): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await uploadOneChunk(args);
      return;
    } catch (err) {
      if (args.signal.aborted) throw err;
      attempt += 1;
      if (attempt > PER_CHUNK_RETRIES) throw err;
      // 指数退避 500ms / 1.5s
      await sleep(500 * Math.pow(3, attempt - 1), args.signal);
    }
  }
}

async function uploadOneChunk(args: {
  sessionId: string;
  seq: number;
  blob: Blob;
  token: string;
  signal: AbortSignal;
}): Promise<void> {
  const formData = new FormData();
  formData.append('file', args.blob, `chunk-${args.seq}.bin`);
  formData.append('seq', String(args.seq));

  const res = await fetch(`/api/sessions/${args.sessionId}/async-upload/chunks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.token}` },
    body: formData,
    signal: args.signal,
  });

  if (!res.ok) {
    const errBody = await readError(res);
    throw new Error(`Chunk ${args.seq} failed (${res.status}): ${errBody}`);
  }
}

async function runWithConcurrency<T>(
  total: number,
  concurrency: number,
  worker: (index: number) => Promise<T>
): Promise<void> {
  let nextIndex = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, total); i++) {
    runners.push(
      (async () => {
        while (true) {
          const idx = nextIndex++;
          if (idx >= total) return;
          await worker(idx);
        }
      })()
    );
  }
  await Promise.all(runners);
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

/**
 * 把多个 AbortSignal 合并成一个 —— 任一触发就 abort。
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      ctrl.abort();
      return ctrl.signal;
    }
    sig.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

/**
 * 估算总耗时（毫秒）。基于：上传带宽 + Soniox 后端处理（约 0.3x 实时）。
 */
export function estimateAsyncTranscribeMs(
  fileSizeBytes: number,
  durationMs: number
): number {
  // 上传 10 MB/s（保守）；ffmpeg 转码 ~ 30s 固定；Soniox 0.4x 实时
  const uploadMs = (fileSizeBytes / (10 * 1024 * 1024)) * 1000;
  const transcodeMs = 30_000;
  const sonioxMs = durationMs * 0.4;
  return Math.round(uploadMs + transcodeMs + sonioxMs);
}
