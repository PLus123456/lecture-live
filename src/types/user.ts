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
  allowedModels: string;
  role?: 'ADMIN' | 'PRO' | 'FREE';
  quotaResetAt?: string | null;
}

export interface AuthResponse {
  user: User;
  token: string;
}
