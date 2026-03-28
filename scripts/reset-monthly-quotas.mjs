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
  const expiredUsers = await prisma.user.findMany({
    where: {
      quotaResetAt: {
        lte: now,
      },
    },
    select: {
      id: true,
    },
  });

  if (expiredUsers.length === 0) {
    console.log('No expired transcription quota windows found.');
    return;
  }

  const nextResetAt = getNextQuotaResetAt(now);
  await prisma.$transaction(
    expiredUsers.map((user) =>
      prisma.user.update({
        where: { id: user.id },
        data: {
          transcriptionMinutesUsed: 0,
          quotaResetAt: nextResetAt,
        },
      })
    )
  );

  console.log(
    `Reset transcription quotas for ${expiredUsers.length} users. Next reset at ${nextResetAt.toISOString()}.`
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
