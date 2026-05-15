import { describe, expect, it } from 'vitest';
import { buildLlmRoutingOptions } from '@/lib/llm/llmRoutingOptions';

describe('buildLlmRoutingOptions', () => {
  it('用户显式选了 DB model 时透传 modelId', () => {
    expect(
      buildLlmRoutingOptions({ modelId: 'cl-abc-123' }, 'CHAT')
    ).toEqual({ modelId: 'cl-abc-123' });
  });

  it('用户选了 env-var provider name 时透传 providerOverride', () => {
    expect(
      buildLlmRoutingOptions({ providerName: 'huoshan' }, 'CHAT')
    ).toEqual({ providerOverride: 'huoshan' });
  });

  it('两者都没有时必须 fallback 到调用方指定的 purpose —— 否则 gateway 会落到 getActiveProvider() 在 DB-only 部署里抛 500', () => {
    expect(buildLlmRoutingOptions({}, 'CHAT')).toEqual({ purpose: 'CHAT' });
    expect(buildLlmRoutingOptions({}, 'REALTIME_SUMMARY')).toEqual({
      purpose: 'REALTIME_SUMMARY',
    });
  });

  it('modelId 优先级高于 providerName（同时给两个时只用 modelId）', () => {
    expect(
      buildLlmRoutingOptions(
        { modelId: 'cl-abc-123', providerName: 'huoshan' },
        'CHAT'
      )
    ).toEqual({ modelId: 'cl-abc-123' });
  });
});
