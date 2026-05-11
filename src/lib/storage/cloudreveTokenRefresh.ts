import 'server-only';

import { logger, serializeError } from '@/lib/logger';
import { logSystemEvent } from '@/lib/auditLog';
import {
  refreshCloudreveTokenProactively,
  type CloudreveRefreshSource,
} from '@/lib/storage/cloudreve';

const REFRESH_INTERVAL_MS = 30 * 60_000;
const REFRESH_AHEAD_MS = 15 * 60_000;

const refreshLogger = logger.child({ component: 'cloudreve-token-refresh' });

type LoopGlobal = typeof globalThis & {
  __cloudreveTokenRefreshStarted?: boolean;
  __cloudreveTokenRefreshTimer?: ReturnType<typeof setInterval>;
  __cloudreveTokenRefreshRun?: Promise<void> | null;
};

export function startCloudreveTokenRefreshLoop(
  intervalMs = REFRESH_INTERVAL_MS
): void {
  const state = globalThis as LoopGlobal;
  if (state.__cloudreveTokenRefreshStarted) {
    return;
  }
  state.__cloudreveTokenRefreshStarted = true;

  const trigger = (source: CloudreveRefreshSource) => {
    if (state.__cloudreveTokenRefreshRun) {
      return;
    }
    state.__cloudreveTokenRefreshRun = runOnce(source).finally(() => {
      state.__cloudreveTokenRefreshRun = null;
    });
  };

  // 启动即跑一次，做两件事：
  //   1. 把 DB 里的 token 装进内存缓存
  //   2. 验证 refresh 链路是否健康（解密 / Cloudreve 端响应）
  // 任何一步出问题都会在日志和 AuditLog 留下记录，无需等用户上传时才暴露。
  trigger('boot');

  const timer = setInterval(() => trigger('scheduler'), intervalMs);
  timer.unref?.();
  state.__cloudreveTokenRefreshTimer = timer;

  refreshLogger.info(
    { intervalMs, refreshAheadMs: REFRESH_AHEAD_MS },
    'Cloudreve token refresh loop started'
  );
}

export function stopCloudreveTokenRefreshLoop(): void {
  const state = globalThis as LoopGlobal;
  if (state.__cloudreveTokenRefreshTimer) {
    clearInterval(state.__cloudreveTokenRefreshTimer);
    state.__cloudreveTokenRefreshTimer = undefined;
  }
  state.__cloudreveTokenRefreshStarted = false;
  state.__cloudreveTokenRefreshRun = null;
}

async function runOnce(source: CloudreveRefreshSource): Promise<void> {
  try {
    const result = await refreshCloudreveTokenProactively({
      source,
      minTimeToExpiryMs: REFRESH_AHEAD_MS,
    });

    switch (result.action) {
      case 'refreshed': {
        refreshLogger.info(
          {
            source,
            expiresAt: new Date(result.expiresAt).toISOString(),
          },
          'Cloudreve access_token 已刷新'
        );
        // 仅启动那次写 AuditLog，定时刷成功不写避免审计日志噪音。
        // 失败已经在 refreshCloudreveTokenProactively 内部写过，这里不再重复。
        if (source === 'boot') {
          logSystemEvent(
            'admin.cloudreve.refresh.success',
            JSON.stringify({ source, expiresAt: result.expiresAt })
          );
        }
        break;
      }
      case 'skipped_not_due':
        refreshLogger.debug(
          {
            source,
            minutesUntilExpiry: Math.round(result.msUntilExpiry / 60_000),
          },
          'Cloudreve token 仍在有效期，跳过刷新'
        );
        break;
      case 'skipped_unauthorized':
        refreshLogger.info(
          { source },
          'Cloudreve 未授权，跳过 token 刷新'
        );
        break;
      case 'skipped_unconfigured':
        refreshLogger.debug(
          { source },
          'Cloudreve 未配置，跳过 token 刷新'
        );
        break;
    }
  } catch (err) {
    // refreshCloudreveTokenProactively 已经写过 AuditLog 并清掉 DB token，
    // 此处仅记录循环层日志，避免审计日志重复。
    refreshLogger.error(
      { source, err: serializeError(err) },
      'Cloudreve token 刷新循环异常'
    );
  }
}
