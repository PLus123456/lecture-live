import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function getNextQuotaResetAt(baseDate = new Date()) {
  return new Date(
    Date.UTC(
      baseDate.getUTCFullYear(),
      baseDate.getUTCMonth() + 1,
      1,
      0,
      0,
      0,
      0
    )
  );
}

async function main() {
  const now = new Date();
  const nextResetAt = getNextQuotaResetAt(now);

  // 乐观锁：用单条 updateMany WHERE quotaResetAt<=now 条件更新，避免与请求路径上的
  // ensureQuotaWindow（同样的条件重置）或扣费在毫秒级并发时互相覆写——无条件 update
  // 会把刚被某请求重置并扣过费的窗口又清零，造成额度被白送。
  // 直接以 updateMany 的 count 为准（而非先 findMany 再 update），消除两步之间的 TOCTOU 窗口。
  const result = await prisma.user.updateMany({
    where: {
      quotaResetAt: { lte: now },
    },
    data: {
      transcriptionMinutesUsed: 0,
      quotaResetAt: nextResetAt,
    },
  });

  if (result.count === 0) {
    console.log('No expired transcription quota windows found.');
    return;
  }

  console.log(
    `Reset transcription quotas for ${result.count} users. Next reset at ${nextResetAt.toISOString()}.`
  );
}

main()
  .catch((error) => {
    console.error('Failed to reset monthly quotas:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
