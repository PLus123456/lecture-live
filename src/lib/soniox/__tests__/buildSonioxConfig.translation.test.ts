import { describe, expect, it } from 'vitest';
import { buildSonioxConfig } from '@/lib/soniox/client';

// U10 回归：only 'soniox' 模式才发 Soniox 云翻译；'both'/'local' 由本地引擎出译文，
// 不能再发云翻译（否则与本地结果写同一 translations[segId] 互相覆盖 + 'both' 翻倍成本）。
type Cfg = Parameters<typeof buildSonioxConfig>[0];

function cfg(overrides: Partial<Cfg>): Cfg {
  return {
    model: 'stt-rt-preview-v2',
    sourceLang: 'en',
    targetLang: 'es',
    twoWayTranslation: false,
    languageHints: [],
    languageHintsStrict: undefined,
    enableSpeakerDiarization: false,
    enableLanguageIdentification: false,
    enableEndpointDetection: true,
    endpointDetectionMs: undefined,
    clientReferenceId: 'ref-1',
    domain: '',
    topic: '',
    terms: [],
    translationMode: 'soniox',
    ...overrides,
  } as unknown as Cfg;
}

describe('buildSonioxConfig — translation mode gating (U10)', () => {
  it("emits Soniox cloud translation in 'soniox' mode", () => {
    expect(buildSonioxConfig(cfg({ translationMode: 'soniox' })).translation).toBeDefined();
  });

  it("omits cloud translation in 'both' mode (本地出译文，避免双写覆盖 + 翻倍成本)", () => {
    expect(buildSonioxConfig(cfg({ translationMode: 'both' })).translation).toBeUndefined();
  });

  it("omits cloud translation in 'local' mode", () => {
    expect(buildSonioxConfig(cfg({ translationMode: 'local' })).translation).toBeUndefined();
  });
});
