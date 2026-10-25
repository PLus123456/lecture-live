import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
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
  main().catch((error) => {
    console.error('[payment:preflight] FATAL:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
