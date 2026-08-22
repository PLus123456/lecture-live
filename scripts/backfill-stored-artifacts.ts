import { prisma } from '../src/lib/prisma';
import { runStoredArtifactBackfill } from '../src/lib/storage/storedArtifactBackfill';

async function main() {
  const summary = await runStoredArtifactBackfill();
  console.log(`[backfill-stored-artifacts] ${JSON.stringify(summary)}`);
}

main()
  .catch((error) => {
    console.error('[backfill-stored-artifacts] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
