export interface User {
  id: string;
  email: string;
  displayName: string;
  role: 'ADMIN' | 'PRO' | 'FREE';
  createdAt: string;
}

export interface UserQuotas {
  transcriptionMinutesUsed: number;
  transcriptionMinutesLimit: number;
  remainingTranscriptionMinutes?: number;
  remainingTranscriptionMs?: number;
  storageHoursUsed: number;
  storageHoursLimit: number;
  /**
   * 字节级存储配额（U1 schema 引入 BigInt，序列化时转 number）。
   * API 还未返回这些字段 — 全部可空，UI 用 ?? 兜底。
   */
  storageBytesUsed?: number;
  storageBytesLimit?: number;
  remainingStorageBytes?: number;
  allowedModels: string;
  role?: 'ADMIN' | 'PRO' | 'FREE';
  quotaResetAt?: string | null;
}

export interface AuthResponse {
  user: User;
  token: string;
}
