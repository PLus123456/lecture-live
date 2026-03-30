import { describe, expect, it } from 'vitest';
import { buildSonioxConfig } from '@/lib/soniox/client';
import type { SessionConfig } from '@/types/transcript';

function makeConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    model: 'stt-rt-v4',
    sourceLang: 'en',
    targetLang: 'zh',
    languageHints: ['en', 'zh'],
    languageHintsStrict: undefined,
    enableSpeakerDiarization: true,
    enableLanguageIdentification: true,
    enableEndpointDetection: true,
    endpointDetectionMs: 5000,
    translationMode: 'soniox',
    domain: 'University Lecture',
    topic: 'Operating Systems',
    terms: ['LectureLive', 'Soniox', 'WebSocket'],
    sonioxRegionPreference: 'auto',
    clientReferenceId: 'session-123',
    ...overrides,
  };
}

describe('buildSonioxConfig', () => {
  it('普通单语课堂只提示 sourceLang，并启用 strict，同时钳制 endpoint delay', () => {
    const config = buildSonioxConfig(makeConfig());

    expect(config.language_hints).toEqual(['en']);
    expect(config.language_hints_strict).toBe(true);
    expect(config.max_endpoint_delay_ms).toBe(3000);
    expect(config.client_reference_id).toBe('session-123');
  });

  it('双向翻译保留双语 hints，但不启用 strict', () => {
    const config = buildSonioxConfig(
      makeConfig({
        sourceLang: 'en',
        targetLang: 'fr',
        twoWayTranslation: true,
      })
    );

    expect(config.language_hints).toEqual(['en', 'fr']);
    expect(config.language_hints_strict).toBeUndefined();
    expect(config.translation).toEqual({
      type: 'two_way',
      language_a: 'en',
      language_b: 'fr',
    });
  });

  it('把自定义术语同步到 translation_terms，避免专有词被乱译', () => {
    const config = buildSonioxConfig(makeConfig());

    expect(config.context?.translation_terms).toEqual([
      { source: 'LectureLive', target: 'LectureLive' },
      { source: 'Soniox', target: 'Soniox' },
      { source: 'WebSocket', target: 'WebSocket' },
    ]);
  });
});
