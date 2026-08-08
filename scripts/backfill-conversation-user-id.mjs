// 回填 Conversation.userId（鉴权根因修复 · 第 6 批）
//
// 用法：node --env-file=.env scripts/backfill-conversation-user-id.mjs
//      （开发：node --env-file=.env.local scripts/backfill-conversation-user-id.mjs）
//
// 幂等 / 可重跑：每条 UPDATE 都带 `userId IS NULL` 守卫，按现有录音 / 附件归属反推回填。
// 与迁移 20260530_add_conversation_user_id 内嵌的回填逻辑一致；迁移已在 deploy 时跑过一遍，
// 本脚本供运维事后核对 / 修复（例如迁移时 Session 尚未到位、或新增孤儿需再归属）。
//
// 归属优先级（同迁移）：
//   类别 1  sessionId 非空                       → 该 Session 的 owner
//   类别 2  sessionId 空 + 有 ConversationSession → 挂载 Session 的 owner（**必须唯一**）
//   类别 3  仅有 ChatAttachment                   → 附件上传者（**必须唯一**）
//   类别 4  无任何反推材料 / 归属不唯一             → 保留 NULL（代码侧当"无主"，访问被拒）
//
// L26：类别 2/3 原本用 MIN(userId) 取"确定值"。归属本身唯一时 MIN 无害，但 2026-05-30 之前的
// 存量脏数据里存在多上传者/多挂载者的对话 —— 那时 MIN 等于**随便挑一个人**把整段对话
// （含别人上传的附件、别人的录音摘录）判给他，另一位真正的当事人反而被挡在外面。
// 这是一次静默的越权授予，而且每次部署都会重跑。现在只回填归属唯一的行，
// 有歧义的一律留 NULL（fail-closed，与类别 4 同语义），并在日志里点名让运维人工裁定。

import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { PrismaClient } from '@prisma/client';

// 独立运行时（npm run db:backfill-conversation-user-id，无 --env-file）自动加载 env，
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

// 类别 1：legacy 单录音对话 → 该 Session 的 owner
export const SQL_CATEGORY_1 = `
  UPDATE \`Conversation\` \`c\`
    JOIN \`Session\` \`s\` ON \`s\`.\`id\` = \`c\`.\`sessionId\`
    SET \`c\`.\`userId\` = \`s\`.\`userId\`
    WHERE \`c\`.\`userId\` IS NULL AND \`c\`.\`sessionId\` IS NOT NULL
`;

// 类别 2：多录音全局对话 → 挂载 Session 的 owner。
// HAVING COUNT(DISTINCT userId) = 1：挂载时本应已校验同属一人，但存量脏数据不保证；
// 归属不唯一的一律不回填（L26）。
export const SQL_CATEGORY_2 = `
  UPDATE \`Conversation\` \`c\`
    JOIN (
      SELECT \`cs\`.\`conversationId\` AS \`cid\`, MIN(\`s\`.\`userId\`) AS \`uid\`
      FROM \`ConversationSession\` \`cs\`
      JOIN \`Session\` \`s\` ON \`s\`.\`id\` = \`cs\`.\`sessionId\`
      GROUP BY \`cs\`.\`conversationId\`
      HAVING COUNT(DISTINCT \`s\`.\`userId\`) = 1
    ) \`j\` ON \`j\`.\`cid\` = \`c\`.\`id\`
    SET \`c\`.\`userId\` = \`j\`.\`uid\`
    WHERE \`c\`.\`userId\` IS NULL
`;

// 类别 3：仅有附件的全局对话 → 附件上传者（同样要求唯一，L26）
export const SQL_CATEGORY_3 = `
  UPDATE \`Conversation\` \`c\`
    JOIN (
      SELECT \`a\`.\`conversationId\` AS \`cid\`, MIN(\`a\`.\`userId\`) AS \`uid\`
      FROM \`ChatAttachment\` \`a\`
      GROUP BY \`a\`.\`conversationId\`
      HAVING COUNT(DISTINCT \`a\`.\`userId\`) = 1
    ) \`j\` ON \`j\`.\`cid\` = \`c\`.\`id\`
    SET \`c\`.\`userId\` = \`j\`.\`uid\`
    WHERE \`c\`.\`userId\` IS NULL
`;

// 诊断：仍为 NULL 且反推材料指向多个人的对话（人工裁定，绝不自动挑一个）
export const SQL_AMBIGUOUS_COUNT = `
  SELECT COUNT(*) AS \`n\` FROM \`Conversation\` \`c\` WHERE \`c\`.\`userId\` IS NULL AND (
    (SELECT COUNT(DISTINCT \`s\`.\`userId\`)
       FROM \`ConversationSession\` \`cs\`
       JOIN \`Session\` \`s\` ON \`s\`.\`id\` = \`cs\`.\`sessionId\`
      WHERE \`cs\`.\`conversationId\` = \`c\`.\`id\`) > 1
    OR
    (SELECT COUNT(DISTINCT \`a\`.\`userId\`)
       FROM \`ChatAttachment\` \`a\`
      WHERE \`a\`.\`conversationId\` = \`c\`.\`id\`) > 1
  )
`;

export async function main() {
  const prisma = new PrismaClient();
  try {
    await run(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

async function run(prisma) {
  const before = await prisma.conversation.count({ where: { userId: null } });
  console.log(`回填前：userId 为 NULL 的对话 ${before} 条`);

  const filled1 = await prisma.$executeRawUnsafe(SQL_CATEGORY_1);
  console.log(`类别 1（legacy 单录音）回填 ${filled1} 条`);

  const filled2 = await prisma.$executeRawUnsafe(SQL_CATEGORY_2);
  console.log(`类别 2（多录音全局）回填 ${filled2} 条`);

  const filled3 = await prisma.$executeRawUnsafe(SQL_CATEGORY_3);
  console.log(`类别 3（仅附件全局）回填 ${filled3} 条`);

  const after = await prisma.conversation.count({ where: { userId: null } });
  console.log(
    `回填后：仍为 NULL（类别 4 无主孤儿）${after} 条 —— 这些将不可见且访问被拒（符合预期）`
  );

  // L26：把"归属有歧义所以刻意没回填"的那部分单独点名，避免混在无主孤儿里被忽略。
  const [{ n: ambiguous } = { n: 0 }] = await prisma.$queryRawUnsafe(SQL_AMBIGUOUS_COUNT);
  if (Number(ambiguous) > 0) {
    console.warn(
      `⚠️ 其中 ${ambiguous} 条的反推材料指向多个用户（多上传者/多挂载者），已刻意保留 NULL。` +
        '自动挑一个等于把别人的数据判给他，请人工裁定后手动回填。'
    );
  }
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error('回填 Conversation.userId 失败:', error);
    process.exitCode = 1;
  });
}
