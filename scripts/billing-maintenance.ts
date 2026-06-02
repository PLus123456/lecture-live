import { prisma } from '../src/lib/prisma';
import { runBillingMaintenance } from '../src/lib/billingMaintenance';

async function main() {
  const summary = await runBillingMaintenance({ source: 'manual' });
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error('Failed to run billing maintenance:', error);
    process.exitCode = 1;
  })
  // 与其它 .mjs 脚本一致：手动/cron 跑完必须断开 Prisma 连接池，
  // 否则进程会因 MySQL 连接常驻而永久挂起，cron 槽位泄漏。
  .finally(async () => {
    await prisma.$disconnect();
  });
