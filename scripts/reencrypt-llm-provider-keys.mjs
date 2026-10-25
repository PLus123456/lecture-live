// ENCRYPTION_KEY 轮换工具（npm run security:reencrypt-llm-keys）。
//
// 文件名沿用历史（最初只处理 LLM 供应商 key），现在覆盖**全部**用 ENCRYPTION_KEY 加密落库的值：
//   - LlmProvider.apiKey（另把 legacy `enc:`（JWT_SECRET 派生）与明文 key 迁成当前格式，行为同旧版）；
//   - SiteSetting 里 `enc:v2:` 前缀的值（Stripe / 微信支付密钥、Soniox key、Cloudreve token、
//     音频增强 worker token、SMTP 密码等敏感设置）；
//   - TranslationWorker.token。
// 此前只轮换 LlmProvider：按 .env.example 的步骤删掉 ENCRYPTION_KEY_PREVIOUS 后，其余密钥全部
// 解密失败——支付/转录/存储静默失效，生产支付预检（check-production-payment-config）直接拒绝启动。
//
// 用法（先在 .env 里把新密钥写进 ENCRYPTION_KEY、旧密钥写进 ENCRYPTION_KEY_PREVIOUS 并重启服务）：
//   node --env-file=<部署 .env> scripts/reencrypt-llm-provider-keys.mjs --dry-run   # 只统计不写库
//   node --env-file=<部署 .env> scripts/reencrypt-llm-provider-keys.mjs             # 正式重加密
// 退出码 0 = 已没有任何值依赖旧密钥，此后才可删除 ENCRYPTION_KEY_PREVIOUS；
// 退出码 1 = 仍有值用当前/旧密钥都解不开（日志只列位置），这时删除旧密钥会让它们永久失效。
//
// 安全约束：日志与返回值只含位置（供应商名、设置 key、worker 名/id）与计数，绝不输出明文；
// 每次写回都是 CAS（WHERE 原密文快照），并发改过的值原样保留（SEC-034）。

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import nextEnv from '@next/env';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const prisma = new PrismaClient();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const LEGACY_PREFIX = 'enc:';
const CURRENT_PREFIX = 'enc:v2:';

function requireSecret(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getCurrentEncryptionSecret() {
  return requireSecret('ENCRYPTION_KEY');
}

function getPreviousEncryptionSecret() {
  return process.env.ENCRYPTION_KEY_PREVIOUS?.trim() || null;
}

function getJwtSecret() {
  return requireSecret('JWT_SECRET');
}

function deriveLegacyKey(secret) {
  return createHash('sha256').update(secret).digest();
}

function deriveCurrentKey(secret) {
  return Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      'lecturelive-salt',
      'lecturelive-encryption',
      32
    )
  );
}

function parsePayload(ciphertext, prefix) {
  const parts = ciphertext.slice(prefix.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format');
  }
  return {
    iv: Buffer.from(parts[0], 'hex'),
    tag: Buffer.from(parts[1], 'hex'),
    data: parts[2],
  };
}

function decryptWithKey(payload, key) {
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.tag);
  let decrypted = decipher.update(payload.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * `enc:v2:` 值归属判定：当前密钥能解 → current；只有旧密钥能解 → previous（附明文，仅供
 * 重加密使用）；都解不开或格式坏 → undecryptable。缺 ENCRYPTION_KEY 属配置错误，直接抛出。
 */
function classifyCurrentFormat(value) {
  const currentKey = deriveCurrentKey(getCurrentEncryptionSecret());
  let payload;
  try {
    payload = parsePayload(value, CURRENT_PREFIX);
  } catch {
    return { kind: 'undecryptable' };
  }
  try {
    decryptWithKey(payload, currentKey);
    return { kind: 'current' };
  } catch {
    // 不是当前密钥加密的，继续试旧密钥
  }
  const previousSecret = getPreviousEncryptionSecret();
  if (previousSecret) {
    try {
      return {
        kind: 'previous',
        plaintext: decryptWithKey(payload, deriveCurrentKey(previousSecret)),
      };
    } catch {
      // 旧密钥也解不开
    }
  }
  return { kind: 'undecryptable' };
}

function verdictFromCurrentFormat(value) {
  const verdict = classifyCurrentFormat(value);
  if (verdict.kind === 'current') return { action: 'skip' };
  if (verdict.kind === 'previous') return { action: 'rewrite', plaintext: verdict.plaintext };
  return { action: 'undecryptable' };
}

/** LlmProvider.apiKey：除旧密钥轮换外，沿用旧版把 legacy `enc:` 与明文 key 迁成当前格式。 */
function inspectProviderKey(value) {
  if (!value) {
    return { action: 'skip' };
  }
  if (value.startsWith(CURRENT_PREFIX)) {
    return verdictFromCurrentFormat(value);
  }
  if (value.startsWith(LEGACY_PREFIX)) {
    try {
      return {
        action: 'rewrite',
        plaintext: decryptWithKey(
          parsePayload(value, LEGACY_PREFIX),
          deriveLegacyKey(getJwtSecret())
        ),
      };
    } catch {
      return { action: 'undecryptable' };
    }
  }
  return { action: 'rewrite', plaintext: value };
}

/**
 * SiteSetting / TranslationWorker：只改写「只能用 ENCRYPTION_KEY_PREVIOUS 解开」的 `enc:v2:` 值。
 * 明文设置（站点名等，本就不是密文）与 legacy `enc:`（JWT_SECRET 派生，不受本次轮换影响）一律不碰。
 */
function inspectRotationOnly(value) {
  if (typeof value !== 'string' || !value.startsWith(CURRENT_PREFIX)) {
    return { action: 'skip' };
  }
  return verdictFromCurrentFormat(value);
}

function encryptCurrent(plaintext) {
  if (!plaintext) {
    return plaintext;
  }

  const key = deriveCurrentKey(getCurrentEncryptionSecret());
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return `${CURRENT_PREFIX}${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * 逐行判定 + CAS 写回的公共流程。rows 的 value 是密文快照；label(row) 只能返回位置信息。
 */
async function rotateRows({ store, rows, inspect, label, write, logger, dryRun }) {
  const summary = {
    store,
    scannedCount: rows.length,
    updatedCount: 0,
    alreadyCurrentCount: 0,
    skippedConcurrentCount: 0,
    undecryptableCount: 0,
  };

  for (const row of rows) {
    const verdict = inspect(row.value);
    if (verdict.action === 'skip') {
      summary.alreadyCurrentCount += 1;
      continue;
    }
    if (verdict.action === 'undecryptable') {
      summary.undecryptableCount += 1;
      logger.warn(
        `Cannot decrypt ${label(row)} with ENCRYPTION_KEY or ENCRYPTION_KEY_PREVIOUS; left unchanged`
      );
      continue;
    }
    if (dryRun) {
      summary.updatedCount += 1;
      logger.log(`[dry-run] Would re-encrypt ${label(row)}`);
      continue;
    }

    // SEC-034：读取之后端点 PATCH 等可能已写入新值。只在密文仍与读取快照一致时写回，
    // 避免迟到写把旧值覆盖回去；同时轮换的另一个脚本实例也受同一 CAS 保护。
    const count = await write(row, encryptCurrent(verdict.plaintext));
    if (count === 1) {
      summary.updatedCount += 1;
      logger.log(`Re-encrypted ${label(row)}`);
    } else {
      summary.skippedConcurrentCount += 1;
      logger.warn(`Skipped ${label(row)}: changed concurrently (no value overwritten)`);
    }
  }

  return summary;
}

export async function reencryptProviderKeys(
  client = prisma,
  logger = console,
  { dryRun = false } = {}
) {
  const providers = await client.llmProvider.findMany({
    select: {
      id: true,
      name: true,
      apiKey: true,
    },
    orderBy: { sortOrder: 'asc' },
  });

  return rotateRows({
    store: 'LlmProvider.apiKey',
    rows: providers.map((provider) => ({ ...provider, value: provider.apiKey })),
    inspect: inspectProviderKey,
    label: (row) => `API key for provider: ${row.name}`,
    write: async (row, next) =>
      (
        await client.llmProvider.updateMany({
          where: { id: row.id, apiKey: row.value },
          data: { apiKey: next },
        })
      ).count,
    logger,
    dryRun,
  });
}

export async function reencryptSiteSettings(
  client = prisma,
  logger = console,
  { dryRun = false } = {}
) {
  const settings = await client.siteSetting.findMany({
    where: { value: { startsWith: CURRENT_PREFIX } },
    select: { key: true, value: true },
    orderBy: { key: 'asc' },
  });

  return rotateRows({
    store: 'SiteSetting.value',
    rows: settings,
    inspect: inspectRotationOnly,
    label: (row) => `site setting: ${row.key}`,
    write: async (row, next) =>
      (
        await client.siteSetting.updateMany({
          where: { key: row.key, value: row.value },
          data: { value: next },
        })
      ).count,
    logger,
    dryRun,
  });
}

export async function reencryptTranslationWorkerTokens(
  client = prisma,
  logger = console,
  { dryRun = false } = {}
) {
  const workers = await client.translationWorker.findMany({
    where: { token: { startsWith: CURRENT_PREFIX } },
    select: { id: true, name: true, token: true },
    orderBy: { sortOrder: 'asc' },
  });

  return rotateRows({
    store: 'TranslationWorker.token',
    rows: workers.map((worker) => ({ ...worker, value: worker.token })),
    inspect: inspectRotationOnly,
    label: (row) => `translation worker token: ${row.name} (${row.id})`,
    write: async (row, next) =>
      (
        await client.translationWorker.updateMany({
          where: { id: row.id, token: row.value },
          data: { token: next },
        })
      ).count,
    logger,
    dryRun,
  });
}

export async function reencryptAllEncryptedValues(
  client = prisma,
  logger = console,
  { dryRun = false } = {}
) {
  // 先确认当前密钥已配置：缺它时任何判定都没有意义，直接失败。
  getCurrentEncryptionSecret();
  if (!getPreviousEncryptionSecret()) {
    logger.warn(
      'ENCRYPTION_KEY_PREVIOUS is not set: only verifying that every value decrypts with ENCRYPTION_KEY'
    );
  }

  const stores = [];
  for (const rotate of [
    reencryptProviderKeys,
    reencryptSiteSettings,
    reencryptTranslationWorkerTokens,
  ]) {
    stores.push(await rotate(client, logger, { dryRun }));
  }

  const totals = {
    scannedCount: 0,
    updatedCount: 0,
    alreadyCurrentCount: 0,
    skippedConcurrentCount: 0,
    undecryptableCount: 0,
  };
  for (const summary of stores) {
    for (const key of Object.keys(totals)) totals[key] += summary[key];
    logger.log(
      `${summary.store}: scanned=${summary.scannedCount} ` +
        `${dryRun ? 'would-re-encrypt' : 're-encrypted'}=${summary.updatedCount} ` +
        `already-current=${summary.alreadyCurrentCount} ` +
        `skipped-concurrent=${summary.skippedConcurrentCount} ` +
        `undecryptable=${summary.undecryptableCount}`
    );
  }

  if (totals.undecryptableCount > 0) {
    logger.warn(
      `${totals.undecryptableCount} value(s) decrypt with neither ENCRYPTION_KEY nor ENCRYPTION_KEY_PREVIOUS. ` +
        'Do NOT remove ENCRYPTION_KEY_PREVIOUS until they are re-entered or removed.'
    );
  } else if (dryRun) {
    logger.log('Dry run finished; re-run without --dry-run to apply.');
  } else if (totals.skippedConcurrentCount > 0) {
    logger.warn('Some values changed concurrently; re-run once more before removing ENCRYPTION_KEY_PREVIOUS.');
  } else {
    logger.log('Finished. No stored value depends on ENCRYPTION_KEY_PREVIOUS any more.');
  }

  return { dryRun, stores, ...totals };
}

// 两边都取 realpath 再比：经软链路径启动时（如 /opt/lecturelive 或其上级是软链），Node 把
// import.meta.url 解析成真实路径、argv[1] 却原样保留，直接比较会把入口误判成「被 import」，
// 脚本什么都不做就 exit 0。只对 argv[1] 取 realpath 也不够：--preserve-symlinks-main 下
// import.meta.url 保留的是软链路径。
function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // argv[1] 解析不了：本模块不可能是经它启动的
    return false;
  }
}

if (invokedAsMain()) {
  const dryRun = process.argv.includes('--dry-run');
  reencryptAllEncryptedValues(prisma, console, { dryRun })
    .then((result) => {
      // 无法解密的值存在 / 并发改动未收敛时非零退出：运维据此判断能否删除旧密钥。
      if (result.undecryptableCount > 0 || (!dryRun && result.skippedConcurrentCount > 0)) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(
        'Failed to re-encrypt stored secrets:',
        error instanceof Error ? error.message : error
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
