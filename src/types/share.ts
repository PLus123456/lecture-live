export interface ShareLinkInfo {
  id: string;
  sessionId: string;
  token: string;
  isLive: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface LiveEvent {
  type:
    | 'transcript_delta'
    | 'translation_delta'
    | 'summary_update'
    | 'status_update'
    | 'preview_update';
  sessionId: string;
  payload: unknown;
  timestamp: number;
}

export interface LiveBroadcast {
  type:
    | 'initial_state'
    | 'transcript_delta'
    | 'translation_delta'
    | 'summary_update'
    | 'status_update'
    | 'preview_update';
  payload: unknown;
  timestamp: number;
}

export interface JoinEvent {
  type: 'join';
  shareToken: string;
}
