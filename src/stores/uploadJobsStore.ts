'use client';

import { create } from 'zustand';

/**
 * 文件上传 + Soniox async 转录的状态机。
 *
 * 阶段：
 *   pending          —— 用户在 modal 确认前
 *   creating         —— 调 /api/sessions 创建 session
 *   uploading_chunks —— 分片上传（前端按 20MB 切，可并发）
 *   transcoding      —— 后端 ffmpeg 抽音频 + 压成 MP3
 *   uploading_to_soniox —— 后端把 MP3 传给 Soniox /v1/files
 *   transcribing     —— Soniox 排队/转录中
 *   finalizing       —— 服务端拉 transcript + 写盘 + 删 Soniox 文件
 *   completed
 *   failed
 *   canceled
 */
export type UploadJobStatus =
  | 'pending'
  | 'creating'
  | 'uploading_chunks'
  | 'transcoding'
  | 'uploading_to_soniox'
  | 'transcribing'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface UploadJob {
  id: string;
  fileName: string;
  fileSize: number;
  durationMs?: number;
  estimatedDurationMs?: number;
  startedAt?: number;
  status: UploadJobStatus;
  /** 总体进度 0~1，从 status + uploadProgress 派生 */
  progress: number;
  /** 分片上传进度 0~1（已上传分片数 / 总分片数） */
  uploadProgress: number;
  sessionId?: string;
  errorMessage?: string;
  // 用户配置
  sourceLang: string;
  targetLang: string;
  folderId?: string | null;
}

interface UploadJobsStore {
  jobs: Record<string, UploadJob>;
  create: (
    input: Omit<UploadJob, 'id' | 'status' | 'progress' | 'uploadProgress'>
  ) => string;
  update: (id: string, patch: Partial<UploadJob>) => void;
  remove: (id: string) => void;
  get: (id: string) => UploadJob | undefined;
  list: () => UploadJob[];
}

let counter = 0;
const nextId = () => {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `upload-${Date.now()}-${counter}`;
};

/**
 * 各阶段占据的进度区间。区间内根据子进度线性插值。
 * 数字代表"进入该阶段时显示的进度起点"。下个阶段的起点 = 本阶段的终点。
 */
const STAGE_RANGES: Record<UploadJobStatus, [number, number]> = {
  pending: [0, 0],
  creating: [0, 0.02],
  uploading_chunks: [0.02, 0.5],  // 分片上传占大头
  transcoding: [0.5, 0.65],
  uploading_to_soniox: [0.65, 0.7],
  transcribing: [0.7, 0.95],        // Soniox 处理时间不可控，给宽
  finalizing: [0.95, 0.99],
  completed: [1, 1],
  failed: [0, 0],                   // 由 modal 单独处理
  canceled: [0, 0],
};

function computeProgress(job: UploadJob): number {
  const [start, end] = STAGE_RANGES[job.status];
  if (job.status === 'uploading_chunks') {
    return start + (end - start) * Math.min(1, Math.max(0, job.uploadProgress));
  }
  // 其它阶段没有精细子进度，停在区间起点 + 一点点偏移示意"在跑"
  return start;
}

export const useUploadJobsStore = create<UploadJobsStore>((set, get) => ({
  jobs: {},

  create: (input) => {
    const id = nextId();
    const job: UploadJob = {
      ...input,
      id,
      status: 'pending',
      progress: 0,
      uploadProgress: 0,
    };
    set((state) => ({ jobs: { ...state.jobs, [id]: job } }));
    return id;
  },

  update: (id, patch) =>
    set((state) => {
      const existing = state.jobs[id];
      if (!existing) return state;
      const merged: UploadJob = { ...existing, ...patch };
      merged.progress = computeProgress(merged);
      return { jobs: { ...state.jobs, [id]: merged } };
    }),

  remove: (id) =>
    set((state) => {
      const next = { ...state.jobs };
      delete next[id];
      return { jobs: next };
    }),

  get: (id) => get().jobs[id],
  list: () => Object.values(get().jobs),
}));

/**
 * 取消 handle 注册表。modal 卸载后后台 widget 仍能取消。
 */
const cancelHandles = new Map<string, () => void>();

export const uploadJobs = {
  create: (input: Parameters<UploadJobsStore['create']>[0]) =>
    useUploadJobsStore.getState().create(input),
  update: (id: string, patch: Partial<UploadJob>) =>
    useUploadJobsStore.getState().update(id, patch),
  get: (id: string) => useUploadJobsStore.getState().get(id),
  remove: (id: string) => useUploadJobsStore.getState().remove(id),
  registerCancel: (id: string, cancel: () => void) => {
    cancelHandles.set(id, cancel);
  },
  unregisterCancel: (id: string) => {
    cancelHandles.delete(id);
  },
  cancel: (id: string) => {
    const fn = cancelHandles.get(id);
    if (fn) {
      try { fn(); } catch { /* ignore */ }
    }
    cancelHandles.delete(id);
    useUploadJobsStore.getState().update(id, { status: 'canceled' });
  },
};
