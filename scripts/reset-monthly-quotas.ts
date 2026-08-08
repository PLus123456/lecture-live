import { prisma } from '../src/lib/prisma';
import { resetExpiredTranscriptionQuotas } from '../src/lib/quota';

/**
 * P5-4：本脚本原先自带一份「只 updateMany 清 used」的旧账务模型，与 canonical
 * resetExpiredTranscriptionQuotas 有三处致命差异：
 *  - 不结算 purchasedMinutesBalance → 持池用户本周期动用的池分钟一分不扣，池子等于永久免费；
 *  - 不清 asyncReservedMinutes / fullReservedMinutes → 违反「先清预留列再归零 used」的顺序不变量，
 *    下一次 settleReservation 读到陈旧的 >0 值，会把新周期的真实扣费减掉（完成的转录白扣 0）；
 *  - 不清 sonioxStreamGrant.reservedMinutes。
 * 现在直接调 canonical 实现，杜绝两份口径。
 */
async function main() {
  const now = new Date();
  const resetUsers = await resetExpiredTranscriptionQuotas(now);

  if (resetUsers === 0) {
    console.log('No expired transcription quota windows found.');
    return;
  }

  console.log(`Reset transcription quotas for ${resetUsers} users.`);
}

main()
  .catch((error) => {
    console.error('Failed to reset monthly quotas:', error);
    process.exitCode = 1;
  })
  // 与其它脚本一致：手动/cron 跑完必须断开 Prisma 连接池，否则进程因 MySQL 连接常驻而永久挂起。
  .finally(async () => {
    await prisma.$disconnect();
  });
