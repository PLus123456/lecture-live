import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSonioxConfig, fetchTemporaryApiKey } from '@/lib/soniox/client';
import {
  isSessionDurationLimitError,
  TemporaryKeyError,
} from '@/lib/soniox/temporaryKeyError';
import type { SessionConfig } from '@/types/transcript';

function makeConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    model: 'stt-rt-v5',
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

describe('fetchTemporaryApiKey 的拒绝', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubResponse(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status }))
    );
  }

  it('单场时长闸（403 session_duration_limit）→ TemporaryKeyError，带状态码 / code / limitMs', async () => {
    stubResponse(403, {
      error: 'Session duration limit reached',
      code: 'session_duration_limit',
      limitMs: 4 * 60 * 60_000,
    });

    const error = await fetchTemporaryApiKey('token', 'eu', {
      kind: 'realtime',
      sessionId: 's1',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TemporaryKeyError);
    expect(error).toMatchObject({
      message: 'Session duration limit reached',
      status: 403,
      code: 'session_duration_limit',
      limitMs: 4 * 60 * 60_000,
    });
    expect(isSessionDurationLimitError(error)).toBe(true);
  });

  it('额度耗尽等其它拒绝 → 不是时长上限（上层照旧按断线 / 报错处理）', async () => {
    stubResponse(403, { error: 'Quota exceeded' });

    const error = await fetchTemporaryApiKey('token', 'eu', {
      kind: 'realtime',
      sessionId: 's1',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TemporaryKeyError);
    expect(error).toMatchObject({ message: 'Quota exceeded', status: 403 });
    expect(isSessionDurationLimitError(error)).toBe(false);
    expect(isSessionDurationLimitError(new Error('session_duration_limit'))).toBe(false);
  });
});
