import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Logger = { log(message: string): void; warn(message: string): void };

type StoreSummary = {
  store: string;
  scannedCount: number;
  updatedCount: number;
  alreadyCurrentCount: number;
  skippedConcurrentCount: number;
  undecryptableCount: number;
};

type UpdateManyMock = ReturnType<typeof vi.fn>;

type ReencryptModule = {
  reencryptProviderKeys(
    client: unknown,
    logger: Logger,
    options?: { dryRun?: boolean }
  ): Promise<StoreSummary>;
  reencryptSiteSettings(
    client: unknown,
    logger: Logger,
    options?: { dryRun?: boolean }
  ): Promise<StoreSummary>;
  reencryptTranslationWorkerTokens(
    client: unknown,
    logger: Logger,
    options?: { dryRun?: boolean }
  ): Promise<StoreSummary>;
  reencryptAllEncryptedValues(
    client: unknown,
    logger: Logger,
    options?: { dryRun?: boolean }
  ): Promise<StoreSummary & { dryRun: boolean; stores: StoreSummary[] }>;
};

const CURRENT = 'current-encryption-key-for-test';
const PREVIOUS = 'previous-encryption-key-for-test';
const UNRELATED = 'some-even-older-key-nobody-has';

function deriveKey(secret: string) {
  return Buffer.from(
    hkdfSync('sha256', secret, 'lecturelive-salt', 'lecturelive-encryption', 32)
  );
}

function encryptWith(secret: string, plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `enc:v2:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
}

function decryptWith(secret: string, value: string) {
  const [iv, tag, data] = value.slice('enc:v2:'.length).split(':');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
}

async function loadScript(): Promise<ReencryptModule> {
  const url = pathToFileURL(
    path.join(process.cwd(), 'scripts', 'reencrypt-llm-provider-keys.mjs')
  ).href;
  return (await import(/* @vite-ignore */ url)) as ReencryptModule;
}

function makeLogger() {
  const log = vi.fn();
  const warn = vi.fn();
  const allMessages = () =>
    [...log.mock.calls, ...warn.mock.calls].map((args) => args.join(' ')).join('\n');
  return { logger: { log, warn }, log, warn, allMessages };
}

/** 新密文写回参数：从 updateMany 的调用里取出 data 里的那个值。 */
function writtenValue(updateMany: UpdateManyMock, field: string): string {
  const [{ data }] = updateMany.mock.calls[0] as [{ data: Record<string, string> }];
  return data[field];
}

describe('reencrypt-llm-provider-keys SEC-034 CAS', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', CURRENT);
    vi.stubEnv('ENCRYPTION_KEY_PREVIOUS', '');
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
    ).resolves.toMatchObject({ updatedCount: 1, skippedConcurrentCount: 0 });
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
    ).resolves.toMatchObject({ updatedCount: 0, skippedConcurrentCount: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/changed concurrently/));
  });
});

describe('ENCRYPTION_KEY 轮换覆盖全部加密落库的值', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', CURRENT);
    vi.stubEnv('ENCRYPTION_KEY_PREVIOUS', PREVIOUS);
    vi.stubEnv('JWT_SECRET', 'legacy-jwt-secret-for-test');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('SiteSetting：只改写旧密钥加密的 enc:v2: 值，CAS 写回且新值可用当前密钥解出原文', async () => {
    const { reencryptSiteSettings } = await loadScript();
    const stripeSnapshot = encryptWith(PREVIOUS, 'sk_live_rotated_secret');
    const sonioxCurrent = encryptWith(CURRENT, 'soniox-already-current');
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findMany = vi.fn().mockResolvedValue([
      { key: 'recharge_stripe_secret_key', value: stripeSnapshot },
      { key: 'soniox_EU_api_key', value: sonioxCurrent },
      // 即使数据库过滤失效把明文设置也带回来，也绝不能被「加密」或改写
      { key: 'site_name', value: 'My Lecture Site' },
    ]);
    const { logger, allMessages } = makeLogger();

    const summary = await reencryptSiteSettings(
      { siteSetting: { findMany, updateMany } },
      logger
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { value: { startsWith: 'enc:v2:' } } })
    );
    expect(summary).toMatchObject({
      store: 'SiteSetting.value',
      scannedCount: 3,
      updatedCount: 1,
      alreadyCurrentCount: 2,
      undecryptableCount: 0,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { key: 'recharge_stripe_secret_key', value: stripeSnapshot },
      data: { value: expect.stringMatching(/^enc:v2:/) },
    });
    expect(decryptWith(CURRENT, writtenValue(updateMany, 'value'))).toBe(
      'sk_live_rotated_secret'
    );
    expect(allMessages()).toContain('recharge_stripe_secret_key');
    expect(allMessages()).not.toContain('sk_live_rotated_secret');
  });

  it('TranslationWorker.token：旧密钥值被轮换，两把钥匙都解不开的值原样保留并计数', async () => {
    const { reencryptTranslationWorkerTokens } = await loadScript();
    const rotatedSnapshot = encryptWith(PREVIOUS, 'worker-token-plaintext-aaaa');
    const orphan = encryptWith(UNRELATED, 'worker-token-plaintext-bbbb');
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const { logger, warn, allMessages } = makeLogger();

    const summary = await reencryptTranslationWorkerTokens(
      {
        translationWorker: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'w1', name: 'ARM-1', token: rotatedSnapshot },
            { id: 'w2', name: 'ARM-2', token: orphan },
          ]),
          updateMany,
        },
      },
      logger
    );

    expect(summary).toMatchObject({ updatedCount: 1, undecryptableCount: 1 });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'w1', token: rotatedSnapshot },
      data: { token: expect.stringMatching(/^enc:v2:/) },
    });
    expect(decryptWith(CURRENT, writtenValue(updateMany, 'token'))).toBe(
      'worker-token-plaintext-aaaa'
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ARM-2 (w2)'));
    expect(allMessages()).not.toMatch(/worker-token-plaintext/);
  });

  it('--dry-run：只统计不写库，汇总覆盖三类存储；有解不开的值时提示勿删旧密钥', async () => {
    const { reencryptAllEncryptedValues } = await loadScript();
    const providerUpdate = vi.fn();
    const settingUpdate = vi.fn();
    const workerUpdate = vi.fn();
    const client = {
      llmProvider: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'p1', name: 'OpenAI', apiKey: encryptWith(PREVIOUS, 'sk-provider-secret') },
        ]),
        updateMany: providerUpdate,
      },
      siteSetting: {
        findMany: vi.fn().mockResolvedValue([
          { key: 'smtp_password', value: encryptWith(PREVIOUS, 'smtp-secret') },
          { key: 'cloudreve_refresh_token', value: encryptWith(UNRELATED, 'refresh-secret') },
        ]),
        updateMany: settingUpdate,
      },
      translationWorker: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'w1', name: 'ARM-1', token: encryptWith(CURRENT, 'already-current') },
        ]),
        updateMany: workerUpdate,
      },
    };
    const { logger, warn, allMessages } = makeLogger();

    const result = await reencryptAllEncryptedValues(client, logger, { dryRun: true });

    expect(providerUpdate).not.toHaveBeenCalled();
    expect(settingUpdate).not.toHaveBeenCalled();
    expect(workerUpdate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      scannedCount: 4,
      updatedCount: 2,
      alreadyCurrentCount: 1,
      undecryptableCount: 1,
    });
    expect(result.stores.map((store) => store.store)).toEqual([
      'LlmProvider.apiKey',
      'SiteSetting.value',
      'TranslationWorker.token',
    ]);
    expect(allMessages()).toContain('[dry-run] Would re-encrypt site setting: smtp_password');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Do NOT remove ENCRYPTION_KEY_PREVIOUS')
    );
    expect(allMessages()).not.toMatch(/sk-provider-secret|smtp-secret|refresh-secret/);
  });

  it('LLM 供应商：旧密钥值同样轮换，解不开的值不再中断整个脚本', async () => {
    const { reencryptProviderKeys } = await loadScript();
    const snapshot = encryptWith(PREVIOUS, 'sk-rotate-me');
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const { logger } = makeLogger();

    const summary = await reencryptProviderKeys(
      {
        llmProvider: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'p0', name: 'broken', apiKey: encryptWith(UNRELATED, 'lost') },
            { id: 'p1', name: 'rotate', apiKey: snapshot },
          ]),
          updateMany,
        },
      },
      logger
    );

    expect(summary).toMatchObject({ updatedCount: 1, undecryptableCount: 1 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', apiKey: snapshot },
      data: { apiKey: expect.stringMatching(/^enc:v2:/) },
    });
    expect(decryptWith(CURRENT, writtenValue(updateMany, 'apiKey'))).toBe('sk-rotate-me');
  });
});
