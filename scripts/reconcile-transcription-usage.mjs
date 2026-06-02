import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// 与 src/lib/siteSettings.ts 的 async_upload_billing_multiplier 默认值/范围保持一致。
const DEFAULT_ASYNC_MULTIPLIER = 0.8;
const ASYNC_MULTIPLIER_MIN = 0;
const ASYNC_MULTIPLIER_MAX = 10;

function toBillableMinutes(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }

  return Math.ceil(durationMs / 60_000);
}

/**
 * 从 SiteSetting 读取异步上传转录计费倍率（与 lib 层 getSiteSettings 同一数据源/口径）。
 * 缺失或非法值回落默认 0.8，并 clamp 到 [0, 10]，与 parseFloatSetting 行为一致。
 */
async function getAsyncBillingMultiplier() {
  const row = await prisma.siteSetting.findUnique({
    where: { key: 'async_upload_billing_multiplier' },
  });
  const parsed = Number.parseFloat(row?.value ?? '');
  if (!Number.isFinite(parsed)) {
    return DEFAULT_ASYNC_MULTIPLIER;
  }
  return Math.min(ASYNC_MULTIPLIER_MAX, Math.max(ASYNC_MULTIPLIER_MIN, parsed));
}

/** 根据 quotaResetAt（下次重置时间）反推当前配额周期的起始时间 */
function getCycleStartFromResetAt(quotaResetAt) {
  if (!quotaResetAt) {
    return new Date(0);
  }
  return new Date(Date.UTC(
    quotaResetAt.getUTCFullYear(),
    quotaResetAt.getUTCMonth() - 1,
    1,
    0,
    0,
    0,
    0
  ));
}

async function main() {
  // 异步上传转录按可配置倍率计费（默认 0.8）；对账侧须乘同样倍率，否则有异步
  // session 的用户会被误报 drift（与 src/lib/quota.ts reconcileTranscriptionUsage 同口径）。
  const asyncMultiplier = await getAsyncBillingMultiplier();

  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      transcriptionMinutesUsed: true,
      quotaResetAt: true,
    },
  });

  const results = await Promise.all(
    users.map(async (user) => {
      const cycleStart = getCycleStartFromResetAt(user.quotaResetAt);

      const sessions = await prisma.session.findMany({
        where: {
          userId: user.id,
          status: 'COMPLETED',
          createdAt: { gte: cycleStart },
        },
        select: { durationMs: true, asyncTranscribeStatus: true },
      });

      const actualMinutes = sessions.reduce((total, session) => {
        const billable = toBillableMinutes(session.durationMs);
        // 异步上传转录（asyncTranscribeStatus 非空）按 ceil(分钟×倍率) 计费，实时转录全额。
        // 与扣费侧（async-transcribe-status）完全一致，保证折扣不被误报成 drift。
        const charged =
          session.asyncTranscribeStatus != null
            ? Math.ceil(billable * asyncMultiplier)
            : billable;
        return total + charged;
      }, 0);

      return {
        id: user.id,
        email: user.email,
        transcriptionMinutesUsed: user.transcriptionMinutesUsed,
        actualMinutes,
        driftMinutes: actualMinutes - user.transcriptionMinutesUsed,
      };
    })
  );

  const mismatches = results.filter((entry) => entry.driftMinutes !== 0);

  if (mismatches.length === 0) {
    console.log('No transcription usage drift detected.');
    return;
  }

  console.log(JSON.stringify({ mismatches }, null, 2));
}

main()
  .catch((error) => {
    console.error('Failed to reconcile transcription usage:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
