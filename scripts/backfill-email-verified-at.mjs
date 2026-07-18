// 回填 User.emailVerifiedAt（邮箱验证硬门禁 · 存量用户豁免）
//
// 用法：node --env-file=.env scripts/backfill-email-verified-at.mjs
//      （开发：node --env-file=.env.local scripts/backfill-email-verified-at.mjs）
//      也由 scripts/ensure-database.mjs 在 db push 之后自动调用。
//
// 背景：emailVerifiedAt 是本次新加的可空列，db push 加列后存量用户一律为 NULL。
//   管理员一旦开启 email_verification，login() 会对 emailVerifiedAt IS NULL 的账号一律 403
//   —— 也就是把「本功能上线前就存在的全部老用户」当场锁死。他们当年注册时站点从未要求过
//   邮箱验证，注册邮箱可能是假的/已停用，走 resend-verification 与 forgot-password 都要求
//   能收信，等于永久失去账号。故这些账号必须视为已验证（回填 createdAt，语义："自注册起即受信任"）。
//
// 一次性：靠 SiteSetting 里的标记键幂等。跑过一次就永不再跑 —— 否则将来某次升级会把
//   「真·待验证」的新用户（注册后没点链接）也一并标成已验证，直接架空门禁。
//
// 本次回填的甄别口径：只动「从未被签发过 VERIFY_EMAIL 令牌」的账号。
//   有过验证令牌 = 该账号是在门禁生效后注册的，它的 NULL 是「待验证」而非「历史遗留」，必须保留。
//   两道保险叠加（标记键 + 令牌甄别），即便混合部署（先跑过一版没有本脚本的代码）也不会误放行。

import { existsSync } from 'fs';
import { PrismaClient } from '@prisma/client';

// 独立运行时（npm run db:backfill-email-verified-at，无 --env-file）自动加载 env，
// 使 PrismaClient 能读到 DATABASE_URL。若已由环境注入（编排器 / --env-file）则不覆盖。
if (!process.env.DATABASE_URL) {
  for (const f of ['.env', '.env.local']) {
    if (existsSync(f)) {
      try {
        process.loadEnvFile(f);
      } catch {
        /* 解析失败时忽略，交由 Prisma 连接报错 */
      }
      if (process.env.DATABASE_URL) break;
    }
  }
}

const prisma = new PrismaClient();

/** 标记键：值为完成时间的 ISO 串。存在即表示回填已执行过，永不重跑。 */
const MARKER_KEY = 'email_verified_backfill_at';

// 全程走 raw SQL，不碰生成的 Prisma Client 模型（同 db-migrate-data.mjs）。
// 迁移脚本要在「客户端可能尚未按新 schema 重新生成」的时刻也能跑通 —— 一旦用了
// prisma.user.count({ where: { emailVerifiedAt: null } })，客户端稍旧就直接抛
// 「Unknown field」而不是完成迁移，正是最不该失败的场景失败。

async function tableExists(table) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`
  );
  return Number(rows[0].cnt) > 0;
}

async function columnExists(table, column) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`
  );
  return Number(rows[0].cnt) > 0;
}

async function countUnverified() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*) AS cnt FROM `User` WHERE `emailVerifiedAt` IS NULL'
  );
  return Number(rows[0].cnt);
}

// 只回填「从未收到过验证邮件」的历史账号；签发过 VERIFY_EMAIL 令牌的属于门禁生效后注册，保持 NULL。
const SQL_WITH_TOKEN_GUARD = `
  UPDATE \`User\` \`u\`
    LEFT JOIN (
      SELECT DISTINCT \`userId\` FROM \`EmailToken\` WHERE \`type\` = 'VERIFY_EMAIL'
    ) \`t\` ON \`t\`.\`userId\` = \`u\`.\`id\`
    SET \`u\`.\`emailVerifiedAt\` = \`u\`.\`createdAt\`
    WHERE \`u\`.\`emailVerifiedAt\` IS NULL AND \`t\`.\`userId\` IS NULL
`;

// EmailToken 尚未建表（AUTO_DB_PUSH=off 的手工管理场景）时的退化形式：此时不可能存在
// 门禁生效后注册的待验证用户，全部 NULL 都是历史遗留，直接回填。
const SQL_PLAIN = `
  UPDATE \`User\`
    SET \`emailVerifiedAt\` = \`createdAt\`
    WHERE \`emailVerifiedAt\` IS NULL
`;

async function main() {
  if (!(await tableExists('User')) || !(await tableExists('SiteSetting'))) {
    console.log('[backfill-email-verified] User / SiteSetting 表不存在（全新库），跳过');
    return;
  }
  // db push 尚未加列（AUTO_DB_PUSH=off 且运维还没手工同步）：什么都别做，等结构就位后再跑。
  if (!(await columnExists('User', 'emailVerifiedAt'))) {
    console.log('[backfill-email-verified] User.emailVerifiedAt 列尚不存在，跳过（待 db push 后重跑）');
    return;
  }

  const markerRows = await prisma.$queryRaw`
    SELECT \`value\` FROM \`SiteSetting\` WHERE \`key\` = ${MARKER_KEY}
  `;
  if (markerRows.length > 0) {
    console.log(`[backfill-email-verified] 已于 ${markerRows[0].value} 执行过，跳过`);
    return;
  }

  const before = await countUnverified();
  console.log(`[backfill-email-verified] 回填前：emailVerifiedAt 为 NULL 的用户 ${before} 个`);

  const hasTokenTable = await tableExists('EmailToken');
  if (!hasTokenTable) {
    console.log('[backfill-email-verified] EmailToken 表不存在，按「全部 NULL 均为历史遗留」回填');
  }
  const filled = await prisma.$executeRawUnsafe(
    hasTokenTable ? SQL_WITH_TOKEN_GUARD : SQL_PLAIN
  );
  console.log(`[backfill-email-verified] 已回填 ${filled} 个历史账号（emailVerifiedAt = createdAt）`);

  const after = await countUnverified();
  if (after > 0) {
    console.log(
      `[backfill-email-verified] 仍为 NULL ${after} 个 —— 这些是门禁生效后注册、尚未点验证链接的账号（符合预期，保持待验证）`
    );
  }

  // 即便 0 行也要落标记：全新库首次部署就把标记钉死，杜绝将来把真·待验证用户误标为已验证。
  await prisma.$executeRaw`
    INSERT INTO \`SiteSetting\` (\`key\`, \`value\`, \`updatedAt\`)
    VALUES (${MARKER_KEY}, ${new Date().toISOString()}, NOW(3))
    ON DUPLICATE KEY UPDATE \`key\` = \`key\`
  `;
  console.log('[backfill-email-verified] 已记录一次性标记，后续升级不再执行');
}

main()
  .catch((error) => {
    console.error('回填 User.emailVerifiedAt 失败:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
