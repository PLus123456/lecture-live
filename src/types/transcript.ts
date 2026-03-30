export interface TranscriptSegment {
  id: string;
  sessionIndex: number; // 哪个 Soniox session 产生的
  speaker: string;
  language: string;
  text: string;
  translatedText?: string;
  globalStartMs: number; // 全局时间戳（考虑 offset）
  globalEndMs: number;
  startMs: number; // backward compat alias
  endMs: number;
  isFinal: boolean;
  confidence: number;
  timestamp: string; // formatted HH:MM:SS
}

export type PreviewTranslationState = 'idle' | 'waiting' | 'streaming' | 'final';
export type SegmentTranslationState = 'pending' | 'streaming' | 'final';

export interface StreamingPreviewText {
  finalText: string;
  nonFinalText: string;
}

export interface StreamingPreviewTranslation extends StreamingPreviewText {
  state: PreviewTranslationState;
  sourceLanguage: string | null;
}

export interface SegmentTranslationEntry {
  text: string;
  state: SegmentTranslationState;
  sourceLanguage: string | null;
}

export type SonioxRegion = 'us' | 'eu' | 'jp';
export type SonioxRegionPreference = 'auto' | SonioxRegion;
export type AudioSourceType = 'mic' | 'system';
export type SessionAudioSource = 'microphone' | 'system_audio';

export const SONIOX_REGION_OPTIONS: Array<{
  value: SonioxRegionPreference;
  label: string;
  shortLabel: string;
}> = [
  { value: 'auto', label: 'Auto (nearest region)', shortLabel: 'Auto' },
  { value: 'us', label: 'US East (Virginia)', shortLabel: 'US' },
  { value: 'eu', label: 'EU West (Frankfurt)', shortLabel: 'EU' },
  { value: 'jp', label: 'AP Northeast (Tokyo)', shortLabel: 'JP' },
];

export function isSonioxRegion(value: unknown): value is SonioxRegion {
  return value === 'us' || value === 'eu' || value === 'jp';
}

export function isSonioxRegionPreference(
  value: unknown
): value is SonioxRegionPreference {
  return value === 'auto' || isSonioxRegion(value);
}

export function isSessionAudioSource(
  value: unknown
): value is SessionAudioSource {
  return value === 'microphone' || value === 'system_audio';
}

export function toSessionAudioSource(
  value: AudioSourceType | SessionAudioSource
): SessionAudioSource {
  if (value === 'system' || value === 'system_audio') {
    return 'system_audio';
  }
  return 'microphone';
}

export function toUiAudioSource(
  value: AudioSourceType | SessionAudioSource | null | undefined
): AudioSourceType {
  if (value === 'system' || value === 'system_audio') {
    return 'system';
  }
  return 'mic';
}

// v2.1: 6-state session lifecycle
export type SessionStatus =
  | 'CREATED'       // 刚创建，未开始录音
  | 'RECORDING'     // 录音中
  | 'PAUSED'        // 暂停
  | 'FINALIZING'    // 正在结束
  | 'COMPLETED'     // 已完成，文件已保存
  | 'ARCHIVED';     // 归档

export interface SessionInfo {
  id: string;
  title: string;
  courseName: string;
  date: string;
  durationMs: number;
  sourceLang: string;
  targetLang: string;
  tags: string[];
  segmentCount: number;
  status: SessionStatus;
  audioSource?: SessionAudioSource;
  sonioxRegion?: SonioxRegionPreference;
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';
export type RecordingState = 'idle' | 'recording' | 'paused' | 'finalizing' | 'stopped';
export type TranslationMode = 'soniox' | 'local' | 'both';

export interface SessionConfig {
  model: 'stt-rt-v4';
  sourceLang: string;
  targetLang: string;
  languageHints: string[];
  enableSpeakerDiarization: boolean;
  enableLanguageIdentification: boolean;
  enableEndpointDetection: boolean;
  endpointDetectionMs: number;
  translationMode: TranslationMode;
  domain: string;
  topic: string;
  terms: string[];
  sonioxRegionPreference: SonioxRegionPreference;
  /** 启用 Soniox two_way 双向翻译（来回翻译模式） */
  twoWayTranslation?: boolean;
}
