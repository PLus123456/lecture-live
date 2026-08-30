import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ReencryptModule = {
  reencryptProviderKeys(
    client: {
      llmProvider: {
        findMany(args: unknown): Promise<Array<{
          id: string;
          name: string;
          apiKey: string;
        }>>;
        updateMany(args: unknown): Promise<{ count: number }>;
      };
    },
    logger: { log(message: string): void; warn(message: string): void }
  ): Promise<{ updatedCount: number; skippedConcurrentCount: number }>;
};

async function loadScript(): Promise<ReencryptModule> {
  const url = pathToFileURL(
    path.join(process.cwd(), 'scripts', 'reencrypt-llm-provider-keys.mjs')
  ).href;
  return (await import(/* @vite-ignore */ url)) as ReencryptModule;
}

describe('reencrypt-llm-provider-keys SEC-034 CAS', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', 'current-encryption-key-for-test');
    vi.stubEnv('JWT_SECRET', 'legacy-jwt-secret-for-test');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('only replaces the exact ciphertext snapshot it decrypted', async () => {
    const { reencryptProviderKeys } = await loadScript();
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const client = {
      llmProvider: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'p1', name: 'provider', apiKey: 'legacy-plaintext-key' },
        ]),
        updateMany,
      },
    };

    await expect(
      reencryptProviderKeys(client, { log: vi.fn(), warn: vi.fn() })
    ).resolves.toEqual({ updatedCount: 1, skippedConcurrentCount: 0 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', apiKey: 'legacy-plaintext-key' },
      data: { apiKey: expect.stringMatching(/^enc:v2:/) },
    });
  });

  it('does not overwrite a fresh key written concurrently with endpoint retargeting', async () => {
    const { reencryptProviderKeys } = await loadScript();
    const warn = vi.fn();
    const client = {
      llmProvider: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'p1', name: 'provider', apiKey: 'old-key-snapshot' },
        ]),
        // count=0 模拟 PATCH 已原子写入新端点 + 新 key。
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };

    await expect(
      reencryptProviderKeys(client, { log: vi.fn(), warn })
    ).resolves.toEqual({ updatedCount: 0, skippedConcurrentCount: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/changed concurrently/));
  });
});
