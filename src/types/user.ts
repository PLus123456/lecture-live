export interface User {
  id: string;
  email: string;
  displayName: string;
  role: 'ADMIN' | 'PRO' | 'FREE';
  createdAt: string;
}

/** 用户组绑定的能力开关（前端据此隐藏未开通功能；服务端才是权威门禁） */
export interface UserFeatureFlags {
  /** 最大思考深度上限，'off' 表示禁止思考 */
  maxThinkingDepth: 'off' | 'low' | 'medium' | 'high';
  /** 是否允许实时摘要 */
  allowRealtimeSummary: boolean;
  /** 是否允许总摘要（结束时结构化报告） */
  allowFinalSummary: boolean;
  /** 是否允许录音音频增强（注意：与其它开关相反，缺省禁止 → UI 用 === true 判断） */
  allowAudioEnhance?: boolean;
}

export interface UserQuotas {
  transcriptionMinutesUsed: number;
  transcriptionMinutesLimit: number;
  /** 购买的永久转录时长池余额（分钟，充值系统 Model A）。remainingTranscriptionMinutes 已含它。 */
  purchasedMinutesBalance?: number;
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
  /** 用户组能力开关（由 /api/users/quota 附带返回，可能缺省 → UI 默认放行） */
  featureFlags?: UserFeatureFlags;
}

export interface AuthResponse {
  user: User;
  token: string;
}
