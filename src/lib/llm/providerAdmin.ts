import { decrypt } from '@/lib/crypto';

type ProviderWithApiKey = {
  apiKey: string;
};

export function serializeProviderForAdmin<T extends ProviderWithApiKey>(
  provider: T
): Omit<T, 'apiKey'> & {
  apiKey: string;
  hasApiKey: boolean;
  maskedApiKey: string;
} {
  let maskedApiKey = '';

  if (provider.apiKey) {
    try {
      const decrypted = decrypt(provider.apiKey);
      maskedApiKey =
        decrypted.length > 8
          ? `${decrypted.slice(0, 4)}****${decrypted.slice(-4)}`
          : '****';
    } catch {
      maskedApiKey = '（已保存）';
    }
  }

  return {
    ...provider,
    apiKey: '',
    hasApiKey: Boolean(provider.apiKey),
    maskedApiKey,
  };
}
