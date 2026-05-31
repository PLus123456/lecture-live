// 「数据感知」数据库迁移 —— 处理 `prisma db push` 无法自动完成、否则会要求 reset 的演进。
//
// 用法（独立运行）：
//   node scripts/db-migrate-data.mjs            （自动读取 .env / .env.local）
//   node --env-file=.env scripts/db-migrate-data.mjs
//
// 背景：本项目部署走 `prisma db push`（见 deploy/upgrade.sh、scripts/ensure-database.mjs）。
//   db push 只把 schema 的「最终形态」对齐到库，不执行 prisma/migrations/ 里的多步 SQL。
//   当某次变更是「在已有数据的表上加必填/唯一/自增列」或「加列后需要数据回填」时，
//   db push 没法原地完成，只能提议「reset 整库重建」。本脚本把这类变更拆成
//   「先加可空列 → 回填 → 再收紧约束」的幂等步骤，在 db push 之前先做掉，
//   让随后的 db push 看到结构已对齐、不再要求 reset。
//
// 设计要点：
//   ① 幂等 / 可重复执行：每步先查 information_schema 判断是否已应用，已应用则跳过。
//   ② 全新空库友好：表还不存在时直接跳过，交给随后的 db push 建表（空表加自增列无碍）。
//   ③ 何时往这里加内容：以后再遇到 db push 提示「need to reset / data loss」的变更，
//      把对应迁移（参考 prisma/migrations/ 里的写法）改写成下面这种幂等步骤加进来即可。

import { existsSync } from 'fs';
import { PrismaClient } from '@prisma/client';

// 独立运行时自动加载 env（与 prisma CLI 读取 .env 的行为一致）。
// 若 DATABASE_URL 已由环境注入（Docker / systemd / --env-file），则不覆盖。
if (!process.env.DATABASE_URL) {
  for (const f of ['.env', '.env.local']) {
    if (existsSync(f)) {
      try {
        process.loadEnvFile(f);
      } catch {
        /* 解析失败时忽略，交由下方 Prisma 连接报错 */
      }
      break;
    }
  }
}

const prisma = new PrismaClient();

// ── information_schema 探针（全部针对当前连接的 DATABASE()） ──

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

async function indexExists(table, index) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND INDEX_NAME = '${index}'`
  );
  return Number(rows[0].cnt) > 0;
}

async function columnIsAutoIncrement(table, column) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT EXTRA FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`
  );
  return (
    rows.length > 0 &&
    String(rows[0].EXTRA || '')
      .toLowerCase()
      .includes('auto_increment')
  );
}

async function hasNull(table, column) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS cnt FROM \`${table}\` WHERE \`${column}\` IS NULL`
  );
  return Number(rows[0].cnt) > 0;
}

// ── 迁移：ConversationMessage.seq（全局单调自增稳定排序键） ──
// 对应 prisma/migrations/20260530_add_message_seq。db push 会因「给有数据的表加必填自增列」
// 要求 reset，故这里拆成：加可空 → 回填 → 唯一索引 → 转 NOT NULL AUTO_INCREMENT → 切有序索引。
async function migrateConversationMessageSeq() {
  const T = 'ConversationMessage';

  if (!(await tableExists(T))) {
    console.log(`[migrate-data] ${T} 不存在（全新库），跳过 seq 迁移，交由 db push 建表`);
    return;
  }

  // 1) 加可空列（供回填）
  if (!(await columnExists(T, 'seq'))) {
    console.log('[migrate-data] 添加可空 seq 列...');
    await prisma.$executeRawUnsafe('ALTER TABLE `ConversationMessage` ADD COLUMN `seq` BIGINT NULL');
  }

  // 2) 按 createdAt（同毫秒用 id 兜底）全局升序回填单调序号（幂等：无 NULL 时不执行）
  if (await hasNull(T, 'seq')) {
    console.log('[migrate-data] 按 createdAt 升序回填 seq...');
    await prisma.$executeRawUnsafe(`
      UPDATE \`ConversationMessage\` \`cm\`
      JOIN (
        SELECT \`id\`, ROW_NUMBER() OVER (ORDER BY \`createdAt\` ASC, \`id\` ASC) AS \`rn\`
        FROM \`ConversationMessage\`
      ) \`ranked\` ON \`ranked\`.\`id\` = \`cm\`.\`id\`
      SET \`cm\`.\`seq\` = \`ranked\`.\`rn\`
    `);
  }

  // 3) 唯一索引（MySQL 要求自增列须为某键首列；同时给 orderBy seq 提供索引）
  if (!(await indexExists(T, 'ConversationMessage_seq_key'))) {
    console.log('[migrate-data] 建唯一索引 ConversationMessage_seq_key...');
    await prisma.$executeRawUnsafe(
      'ALTER TABLE `ConversationMessage` ADD UNIQUE INDEX `ConversationMessage_seq_key` (`seq`)'
    );
  }

  // 4) 转 NOT NULL AUTO_INCREMENT（计数器自动取 max(seq)+1）
  if (!(await columnIsAutoIncrement(T, 'seq'))) {
    console.log('[migrate-data] 将 seq 转为 NOT NULL AUTO_INCREMENT...');
    await prisma.$executeRawUnsafe(
      'ALTER TABLE `ConversationMessage` MODIFY COLUMN `seq` BIGINT NOT NULL AUTO_INCREMENT'
    );
  }

  // 5) 切换有序索引：加 (conversationId, seq)，删旧 (conversationId, createdAt)
  if (!(await indexExists(T, 'ConversationMessage_conversationId_seq_idx'))) {
    console.log('[migrate-data] 建有序索引 (conversationId, seq)...');
    await prisma.$executeRawUnsafe(
      'CREATE INDEX `ConversationMessage_conversationId_seq_idx` ON `ConversationMessage`(`conversationId`, `seq`)'
    );
  }
  if (await indexExists(T, 'ConversationMessage_conversationId_createdAt_idx')) {
    console.log('[migrate-data] 删除旧索引 (conversationId, createdAt)...');
    await prisma.$executeRawUnsafe(
      'DROP INDEX `ConversationMessage_conversationId_createdAt_idx` ON `ConversationMessage`'
    );
  }

  console.log('[migrate-data] seq 迁移完成');
}

async function main() {
  console.log('[migrate-data] 开始数据感知迁移（db push 前置）...');
  await migrateConversationMessageSeq();
  // 注：Conversation.userId 是可空列，db push 加列不会触发 reset，故由 db push 负责加列、
  //     由 scripts/backfill-conversation-user-id.mjs 负责（db push 之后）回填历史归属。
  console.log('[migrate-data] 全部完成');
}

main()
  .catch((error) => {
    console.error('[migrate-data] 迁移失败:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
