import { pathToFileURL } from 'url';
import { PrismaClient } from '@prisma/client';
import { checkProductionPaymentConfiguration } from './payment-production-preflight-core.mjs';

export async function main() {
  const prisma = new PrismaClient();
  try {
    await checkProductionPaymentConfiguration(prisma, console, process.env, {
      allowReconciliationMaintenance: process.argv.includes(
        '--allow-reconciliation-maintenance'
      ),
    });
  } finally {
    await prisma.$disconnect();
  }
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error('[payment:preflight] FATAL:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
