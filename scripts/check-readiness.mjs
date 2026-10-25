import { createHmac } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HEALTH_READINESS_CONTEXT =
  'lecture-live:health-readiness:v1';

export function deriveReadinessToken(secret) {
  const value = secret?.trim();
  if (!value) throw new Error('JWT_SECRET is required for readiness checks');
  return createHmac('sha256', value)
    .update(HEALTH_READINESS_CONTEXT)
    .digest('hex');
}

class ReadinessHttpError extends Error {
  constructor(status) {
    super(`readiness check failed with HTTP ${status}`);
    this.status = status;
  }
}

async function checkOnce(env) {
  const token = deriveReadinessToken(env.JWT_SECRET);
  const url =
    env.HEALTH_READINESS_URL?.trim() ||
    'http://127.0.0.1:3000/api/health/ready';
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ReadinessHttpError(response.status);
  }
  await response.body?.cancel().catch(() => undefined);
}

export async function main(
  env = process.env,
  { attempts = 1, retryDelayMs = 1_000 } = {}
) {
  const boundedAttempts = Math.max(1, Math.min(10, Number(attempts) || 1));
  let lastError;
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      await checkOnce(env);
      return;
    } catch (error) {
      lastError = error;
      // A reachable 4xx is not a startup race: 401 means the deployment secret
      // disagrees and 404 means this is an old runtime without the protected
      // readiness endpoint. Never keep such a runtime online while retrying.
      const retryable =
        !(error instanceof ReadinessHttpError) || error.status >= 500;
      if (!retryable || attempt === boundedAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw lastError;
}

// 两边都取 realpath 再比：经软链路径启动时（如 /opt/lecturelive 或其上级是软链），Node 把
// import.meta.url 解析成真实路径、argv[1] 却原样保留，直接比较会把入口误判成「被 import」，
// 脚本什么都不做就 exit 0。只对 argv[1] 取 realpath 也不够：--preserve-symlinks-main 下
// import.meta.url 保留的是软链路径。
function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    // argv[1] 解析不了：本模块不可能是经它启动的
    return false;
  }
}

if (isEntrypoint()) {
  const waitForStartup = process.argv.includes('--wait');
  main(process.env, { attempts: waitForStartup ? 10 : 1 }).catch((error) => {
    console.error(
      '[health:ready] FATAL:',
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  });
}
