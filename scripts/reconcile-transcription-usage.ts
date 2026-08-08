import { prisma } from '../src/lib/prisma';
import { reconcileTranscriptionUsage } from '../src/lib/quota';
import { getSiteSettings } from '../src/lib/siteSettings';

/**
 * P5-9：本脚本原先自带一份旧对账模型，与 canonical reconcileTranscriptionUsage 有 6 处口径差异
 *（不排除 ADMIN、不含 interpret 台账、不含完整版补全转录那笔、不含 grant 直接补扣、按 createdAt
 * 而非 billedAt 归期、不看 transcriptionUsageReconcileFrom 下界），每一处都会凭空报出 drift。
 * 现在直接调 canonical 实现。仍是**只读报表**：不建 ReconciliationRun、不改任何用量
 *（要留档请走 admin 面板或 `npm run billing:maintenance`）。
 */
async function main() {
  // 异步上传转录按可配置倍率计费，对账须乘同样倍率（与 lib 层同一数据源/口径）。
  const { async_upload_billing_multiplier } = await getSiteSettings();
  const mismatches = await reconcileTranscriptionUsage(async_upload_billing_multiplier);

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
