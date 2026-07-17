import type { SonioxRegion } from '@/types/transcript';

export interface RealtimeToken {
  text: string;
  start_ms?: number;
  end_ms?: number;
  confidence: number;
  is_final: boolean;
  speaker?: string;
  language?: string;
  translation_status?: 'none' | 'original' | 'translation';
  source_language?: string;
}

export interface SonioxSessionConfig {
  model: 'stt-rt-v4';
  language_hints?: string[];
  language_hints_strict?: boolean;
  enable_speaker_diarization?: boolean;
  enable_language_identification?: boolean;
  enable_endpoint_detection?: boolean;
  max_endpoint_delay_ms?: number;
  client_reference_id?: string;
  context?: {
    general?: Array<{ key: string; value: string }>;
    text?: string;
    terms?: string[];
    translation_terms?: Array<{ source: string; target: string }>;
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
  /**
   * R1-L1：本 key 建立的连接的串流时长硬上限（秒）＝服务端本次预扣的额度。到点 Soniox 服务端
   * 断连（temp_api_key_session_expired）；客户端应提前 ~30s 主动平滑轮换（重新 mint 接续）。
   */
  max_session_duration_seconds?: number;
}
