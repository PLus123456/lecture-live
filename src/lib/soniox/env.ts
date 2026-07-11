import {
  isSonioxRegion,
  type SonioxRegion,
  type SonioxRegionPreference,
} from '@/types/transcript';
import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';

const DEFAULT_REGION: SonioxRegion = 'us';

// 数据库配置缓存（避免每次请求都查数据库）
let dbConfigCache: Record<string, string> | null = null;
let dbConfigCacheTime = 0;
const DB_CACHE_TTL = 60_000; // 1 分钟缓存

export function invalidateSonioxDbConfigCache() {
  dbConfigCache = null;
  dbConfigCacheTime = 0;
}

/** 从数据库加载 Soniox 配置（带缓存） */
async function loadDbConfig(): Promise<Record<string, string>> {
  const now = Date.now();
  if (dbConfigCache && now - dbConfigCacheTime < DB_CACHE_TTL) {
    return dbConfigCache;
  }

  try {
    const settings = await prisma.siteSetting.findMany({
      where: {
        OR: [
          { key: { startsWith: 'soniox_' } },
          { key: 'default_region' },
        ],
      },
    });

    const config: Record<string, string> = {};
    for (const s of settings) {
      config[s.key] = s.value;
    }
    dbConfigCache = config;
    dbConfigCacheTime = now;
    return config;
  } catch {
    return dbConfigCache ?? {};
  }
}

const GEO_COUNTRY_HEADERS = [
  'x-vercel-ip-country',
  'cf-ipcountry',
  'cloudfront-viewer-country',
  'x-country-code',
  'x-geo-country',
];

const DEFAULT_ENDPOINTS: Record<
  SonioxRegion,
  { restBaseUrl: string; wsBaseUrl: string }
> = {
  us: {
    restBaseUrl: 'https://api.soniox.com',
    wsBaseUrl: 'wss://stt-rt.soniox.com/transcribe-websocket',
  },
  eu: {
    restBaseUrl: 'https://api.eu.soniox.com',
    wsBaseUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
  },
  jp: {
    restBaseUrl: 'https://api.jp.soniox.com',
    wsBaseUrl: 'wss://stt-rt.jp.soniox.com/transcribe-websocket',
  },
};

export interface SonioxRuntimeConfig {
  region: SonioxRegion;
  apiKey: string;
  restBaseUrl: string;
  wsBaseUrl: string;
}

function normalizeRegion(value: string | null | undefined): SonioxRegion | null {
  const lowered = value?.trim().toLowerCase();
  return lowered && isSonioxRegion(lowered) ? lowered : null;
}

function normalizePreference(
  value: string | null | undefined
): SonioxRegionPreference | null {
  const lowered = value?.trim().toLowerCase();
  if (!lowered) return null;
  if (lowered === 'auto') return 'auto';
  return isSonioxRegion(lowered) ? lowered : null;
}

function isPrivateIp(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
}

function countryToRegion(countryCode: string): SonioxRegion {
  const normalized = countryCode.trim().toUpperCase();

  if (normalized === 'JP') {
    return 'jp';
  }

  if (
    [
      'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR',
      'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT',
      'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
    ].includes(normalized)
  ) {
    return 'eu';
  }

  return 'us';
}

function detectRegionFromHeaders(headers?: Headers): SonioxRegion | null {
  if (!headers) return null;

  for (const headerName of GEO_COUNTRY_HEADERS) {
    const country = headers.get(headerName);
    if (country && /^[A-Za-z]{2}$/.test(country)) {
      return countryToRegion(country);
    }
  }

  const forwardedFor = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = headers.get('x-real-ip')?.trim();
  const clientIp = forwardedFor || realIp || '';

  if (clientIp && !isPrivateIp(clientIp)) {
    return getDefaultRegion();
  }

  return null;
}

export function getDefaultRegion(): SonioxRegion {
  return normalizeRegion(process.env.SONIOX_DEFAULT_REGION) ?? DEFAULT_REGION;
}

export async function getDefaultRegionAsync(): Promise<SonioxRegion> {
  const envDefault = normalizeRegion(process.env.SONIOX_DEFAULT_REGION);
  if (envDefault) {
    return envDefault;
  }

  try {
    const dbConfig = await loadDbConfig();
    return (
      normalizeRegion(dbConfig.soniox_default_region) ??
      normalizeRegion(dbConfig.default_region) ??
      DEFAULT_REGION
    );
  } catch {
    return DEFAULT_REGION;
  }
}

export function resolveRequestedRegion(
  preference?: SonioxRegionPreference | null,
  headers?: Headers
): SonioxRegion {
  if (preference && preference !== 'auto') {
    return preference;
  }

  return detectRegionFromHeaders(headers) ?? getDefaultRegion();
}

export async function resolveRequestedRegionAsync(
  preference?: SonioxRegionPreference | null,
  headers?: Headers
): Promise<SonioxRegion> {
  if (preference && preference !== 'auto') {
    return preference;
  }

  return detectRegionFromHeaders(headers) ?? (await getDefaultRegionAsync());
}

export function getConfiguredSonioxRegions(): SonioxRegion[] {
  const configured = (['us', 'eu', 'jp'] as const).filter((region) => {
    const upper = region.toUpperCase();
    return Boolean(process.env[`SONIOX_${upper}_API_KEY`]);
  });

  return configured.length > 0 ? configured : [getDefaultRegion()];
}

/**
 * 异步版本：同时检查环境变量和数据库中已配置的 Soniox 区域。
 * 用于 API route 中需要完整区域列表的场景。
 */
export async function getConfiguredSonioxRegionsAsync(): Promise<SonioxRegion[]> {
  // 先检查环境变量
  const envConfigured = (['us', 'eu', 'jp'] as const).filter((region) => {
    const upper = region.toUpperCase();
    return Boolean(process.env[`SONIOX_${upper}_API_KEY`]);
  });

  if (envConfigured.length > 0) return envConfigured;

  // 再检查数据库
  try {
    const dbConfig = await loadDbConfig();
    const dbConfigured = (['us', 'eu', 'jp'] as const).filter((region) => {
      return Boolean(dbConfig[`soniox_${region.toUpperCase()}_api_key`]);
    });

    if (dbConfigured.length > 0) return dbConfigured;
  } catch {
    // 数据库不可用
  }

  return [await getDefaultRegionAsync()];
}

export function parseSonioxRegionPreference(
  value: string | null | undefined
): SonioxRegionPreference | null {
  return normalizePreference(value);
}

/**
 * P1-16：按 session 存储的 region 偏好解析运行配置。传入 session.sonioxRegion（'auto' | 具体 region |
 * 空）。用于**任务开始之后**的所有 poll / finalize / cancel / maintenance —— 它们必须按任务已固定的
 * region 字段解析，绝不再落回可变默认 region（默认中途变更会让 poll/delete 去错 region，致任务卡死 +
 * 外部资源孤儿）。'auto'/空 时退化为默认解析（与旧行为一致），但正常任务开始时已被 persist 成具体值。
 */
export async function resolveSonioxConfigForSessionRegion(
  region: string | null | undefined
): Promise<SonioxRuntimeConfig | null> {
  return resolveSonioxRuntimeConfigAsync({
    requestedRegion: parseSonioxRegionPreference(region),
  });
}

/**
 * P1-16：任务开始时解析出「实际使用的 region」并持久化到 session.sonioxRegion，返回其运行配置。
 *
 * 入参 preference 为 session.sonioxRegion（可能 'auto' 或具体 region）。解析为具体 region（含凭据
 * 回退——若首选 region 无 key 会回退到实际可用的 region）后，把该**具体值**写回 session.sonioxRegion，
 * 固定本任务 region；之后所有 poll/finalize/cancel/maintenance 用 resolveSonioxConfigForSessionRegion
 * 读同一字段，全链路同 region。拿不到任何凭据 → 返回 null（不写库，调用方按缺凭据处理）。
 */
export async function resolveAndPersistTaskRegion(
  sessionId: string,
  preference: string | null | undefined
): Promise<SonioxRuntimeConfig | null> {
  const config = await resolveSonioxRuntimeConfigAsync({
    requestedRegion: parseSonioxRegionPreference(preference),
  });
  if (!config) {
    return null;
  }
  // 仅当持久化的具体 region 与解析出的实际 region 不同才写库（'auto'→'us'、或凭据回退换 region）。
  if (normalizeRegion(preference) !== config.region) {
    await prisma.session
      .updateMany({ where: { id: sessionId }, data: { sonioxRegion: config.region } })
      .catch(() => undefined);
  }
  return config;
}

function getRegionConfig(region: SonioxRegion): SonioxRuntimeConfig | null {
  const upper = region.toUpperCase();
  const apiKey = process.env[`SONIOX_${upper}_API_KEY`];

  if (!apiKey) {
    return null;
  }

  return {
    region,
    apiKey,
    restBaseUrl:
      process.env[`SONIOX_${upper}_REST_URL`] ??
      DEFAULT_ENDPOINTS[region].restBaseUrl,
    wsBaseUrl:
      process.env[`SONIOX_${upper}_WS_URL`] ?? DEFAULT_ENDPOINTS[region].wsBaseUrl,
  };
}

/**
 * 从数据库获取区域配置（加密存储的 API Key 会自动解密）。
 * 环境变量优先，数据库其次。
 */
async function getRegionConfigAsync(region: SonioxRegion): Promise<SonioxRuntimeConfig | null> {
  // 先尝试环境变量
  const envConfig = getRegionConfig(region);
  if (envConfig) return envConfig;

  // 再尝试数据库
  const dbConfig = await loadDbConfig();
  const upper = region.toUpperCase();
  const encryptedKey = dbConfig[`soniox_${upper}_api_key`];
  if (!encryptedKey) return null;

  return {
    region,
    apiKey: decrypt(encryptedKey),
    restBaseUrl:
      dbConfig[`soniox_${upper}_rest_url`] ??
      DEFAULT_ENDPOINTS[region].restBaseUrl,
    wsBaseUrl:
      dbConfig[`soniox_${upper}_ws_url`] ??
      DEFAULT_ENDPOINTS[region].wsBaseUrl,
  };
}

export function resolveSonioxRuntimeConfig(options?: {
  requestedRegion?: SonioxRegionPreference | null;
  headers?: Headers;
}): SonioxRuntimeConfig | null {
  const requestedRegion = resolveRequestedRegion(
    options?.requestedRegion,
    options?.headers
  );

  const fallbackOrder = Array.from(
    new Set<SonioxRegion>([
      requestedRegion,
      getDefaultRegion(),
      'us',
      'eu',
      'jp',
    ])
  );

  for (const region of fallbackOrder) {
    const regionalConfig = getRegionConfig(region);
    if (regionalConfig) {
      return regionalConfig;
    }
  }

  const legacyApiKey = process.env.SONIOX_API_KEY;
  if (!legacyApiKey) {
    return null;
  }

  const region = requestedRegion ?? getDefaultRegion();
  return {
    region,
    apiKey: legacyApiKey,
    restBaseUrl:
      process.env.SONIOX_REST_URL ?? DEFAULT_ENDPOINTS[region].restBaseUrl,
    wsBaseUrl: process.env.SONIOX_WS_URL ?? DEFAULT_ENDPOINTS[region].wsBaseUrl,
  };
}

/**
 * 异步版本：优先环境变量，回退到数据库中的加密配置。
 * 用于 API 路由中需要解密数据库存储 Key 的场景。
 */
export async function resolveSonioxRuntimeConfigAsync(options?: {
  requestedRegion?: SonioxRegionPreference | null;
  headers?: Headers;
}): Promise<SonioxRuntimeConfig | null> {
  const requestedRegion = await resolveRequestedRegionAsync(
    options?.requestedRegion,
    options?.headers
  );
  const defaultRegion = await getDefaultRegionAsync();

  const fallbackOrder = Array.from(
    new Set<SonioxRegion>([
      requestedRegion,
      defaultRegion,
      'us',
      'eu',
      'jp',
    ])
  );

  for (const region of fallbackOrder) {
    const config = await getRegionConfigAsync(region);
    if (config) return config;
  }

  // 最后尝试旧的单 Key 环境变量
  const legacyApiKey = process.env.SONIOX_API_KEY;
  if (!legacyApiKey) return null;

  const region = requestedRegion ?? defaultRegion;
  return {
    region,
    apiKey: legacyApiKey,
    restBaseUrl:
      process.env.SONIOX_REST_URL ?? DEFAULT_ENDPOINTS[region].restBaseUrl,
    wsBaseUrl:
      process.env.SONIOX_WS_URL ?? DEFAULT_ENDPOINTS[region].wsBaseUrl,
  };
}
