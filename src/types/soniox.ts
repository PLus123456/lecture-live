import type { SonioxRegion } from '@/types/transcript';

export interface RealtimeToken {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
  is_final: boolean;
  speaker?: string;
  language?: string;
  translation_status?: 'transcription' | 'translation';
}

export interface SonioxSessionConfig {
  model: 'stt-rt-v4';
  language_hints?: string[];
  enable_speaker_diarization?: boolean;
  enable_language_identification?: boolean;
  enable_endpoint_detection?: boolean;
  max_endpoint_delay_ms?: number;
  context?: {
    general?: Array<{ key: string; value: string }>;
    terms?: string[];
  };
  translation?: {
    type: 'one_way';
    target_language: string;
  } | {
    type: 'two_way';
    language_a: string;
    language_b: string;
  };
}

export interface TemporaryApiKeyResponse {
  api_key: string;
  expires_at: string;
  ws_base_url?: string;
  ws_url?: string;
  rest_base_url?: string;
  region: SonioxRegion;
}
