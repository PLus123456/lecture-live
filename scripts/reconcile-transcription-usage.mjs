import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function toBillableMinutes(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }

  return Math.ceil(durationMs / 60_000);
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
        select: { durationMs: true },
      });

      const actualMinutes = sessions.reduce(
        (total, session) => total + toBillableMinutes(session.durationMs),
        0
      );

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
