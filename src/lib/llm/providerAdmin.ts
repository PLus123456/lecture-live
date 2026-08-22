import { decrypt } from '@/lib/crypto';

type ProviderWithApiKey = {
  apiKey: string;
  apiBase?: string;
};

function serializeEndpointForAdmin(value: string | undefined): {
  apiBase?: string;
  endpointRedacted: boolean;
} {
  if (value === undefined) return { endpointRedacted: false };
  try {
    const url = new URL(value);
    const endpointRedacted = Boolean(
      url.username || url.password || url.search || url.hash
    );
    if (endpointRedacted) {
      // Legacy rows may predate the no-query/no-userinfo policy. Preserve only the
      // non-secret shape so an admin can repair it; never return credential-like
      // URL components through GET, browser state, devtools, or client logs.
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
    }
    return { apiBase: url.toString().replace(/\/$/, ''), endpointRedacted };
  } catch {
    return { apiBase: '', endpointRedacted: true };
  }
}

export function serializeProviderForAdmin<T extends ProviderWithApiKey>(
  provider: T
): Omit<T, 'apiKey'> & {
  apiKey: string;
  hasApiKey: boolean;
  maskedApiKey: string;
  endpointRedacted: boolean;
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

  const endpoint = serializeEndpointForAdmin(provider.apiBase);
  return {
    ...provider,
    ...endpoint,
    apiKey: '',
    hasApiKey: Boolean(provider.apiKey),
    maskedApiKey,
  };
}
