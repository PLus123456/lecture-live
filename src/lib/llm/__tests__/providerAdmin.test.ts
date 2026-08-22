import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/crypto', () => ({ decrypt: (value: string) => value }));

import { serializeProviderForAdmin } from '@/lib/llm/providerAdmin';

describe('serializeProviderForAdmin security boundary', () => {
  it('never returns the API key or legacy URL query/userinfo secrets', () => {
    const serialized = serializeProviderForAdmin({
      id: 'p1',
      apiKey: 'sk-super-secret',
      apiBase: 'https://query-user:query-password@api.example.com/v1?token=query-secret#fragment-secret',
    });
    const json = JSON.stringify(serialized);

    expect(serialized.apiKey).toBe('');
    expect(serialized.apiBase).toBe('https://api.example.com/v1');
    expect(serialized.endpointRedacted).toBe(true);
    expect(json).not.toContain('sk-super-secret');
    expect(json).not.toContain('query-user');
    expect(json).not.toContain('query-password');
    expect(json).not.toContain('query-secret');
    expect(json).not.toContain('fragment-secret');
  });

  it('keeps an ordinary path-only endpoint unchanged', () => {
    const serialized = serializeProviderForAdmin({
      apiKey: 'secret',
      apiBase: 'https://api.example.com/v1',
    });
    expect(serialized.apiBase).toBe('https://api.example.com/v1');
    expect(serialized.endpointRedacted).toBe(false);
  });
});
