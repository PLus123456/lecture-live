'use client';

import { create } from 'zustand';

export type UploadJobStatus =
  | 'pending'        // 已加入队列，等待用户确认
  | 'creating'       // 正在创建 session
  | 'uploading'      // 正在上传音频
  | 'transcribing'   // 正在做转录
  | 'finalizing'     // 正在写入最终结果
  | 'done'
  | 'failed'
  | 'canceled';

export interface UploadJob {
  id: string;                  // local job id
  fileName: string;
  fileSize: number;
  durationMs?: number;         // 解码后获得的音频时长
  estimatedDurationMs?: number;// 预计转录耗时
  startedAt?: number;          // 转录开始时间戳
  status: UploadJobStatus;
  progress: number;            // 0~1
  uploadProgress: number;      // 0~1（上传阶段）
  transcribeProgress: number;  // 0~1（转录阶段，用音频回放进度推算）
  sessionId?: string;
  errorMessage?: string;
  // 用户配置
  sourceLang: string;
  targetLang: string;
  folderId?: string | null;
}

interface UploadJobsStore {
  jobs: Record<string, UploadJob>;
  /** 创建任务，返回 jobId */
  create: (input: Omit<UploadJob, 'id' | 'status' | 'progress' | 'uploadProgress' | 'transcribeProgress'>) => string;
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
      transcribeProgress: 0,
    };
    set((state) => ({ jobs: { ...state.jobs, [id]: job } }));
    return id;
  },

  update: (id, patch) =>
    set((state) => {
      const existing = state.jobs[id];
      if (!existing) return state;
      const merged = { ...existing, ...patch };
      // 派生总进度：上传 30% + 转录 70%
      merged.progress = Math.min(
        1,
        merged.uploadProgress * 0.3 + merged.transcribeProgress * 0.7
      );
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
 * 全局便捷调用，无需在组件中订阅 store。
 */
export const uploadJobs = {
  create: (input: Parameters<UploadJobsStore['create']>[0]) =>
    useUploadJobsStore.getState().create(input),
  update: (id: string, patch: Partial<UploadJob>) =>
    useUploadJobsStore.getState().update(id, patch),
  get: (id: string) => useUploadJobsStore.getState().get(id),
  remove: (id: string) => useUploadJobsStore.getState().remove(id),
};
