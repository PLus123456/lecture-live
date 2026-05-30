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
//   类别 2  sessionId 空 + 有 ConversationSession → 任一挂载 Session 的 owner（MIN 取确定值）
//   类别 3  仅有 ChatAttachment                   → 附件上传者（MIN 取确定值）
//   类别 4  无任何反推材料                         → 保留 NULL（代码侧当"无主"）

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// 类别 1：legacy 单录音对话 → 该 Session 的 owner
const SQL_CATEGORY_1 = `
  UPDATE \`Conversation\` \`c\`
    JOIN \`Session\` \`s\` ON \`s\`.\`id\` = \`c\`.\`sessionId\`
    SET \`c\`.\`userId\` = \`s\`.\`userId\`
    WHERE \`c\`.\`userId\` IS NULL AND \`c\`.\`sessionId\` IS NOT NULL
`;

// 类别 2：多录音全局对话 → 挂载 Session 的 owner（挂载时已校验同属一人，MIN 取确定值）
const SQL_CATEGORY_2 = `
  UPDATE \`Conversation\` \`c\`
    JOIN (
      SELECT \`cs\`.\`conversationId\` AS \`cid\`, MIN(\`s\`.\`userId\`) AS \`uid\`
      FROM \`ConversationSession\` \`cs\`
      JOIN \`Session\` \`s\` ON \`s\`.\`id\` = \`cs\`.\`sessionId\`
      GROUP BY \`cs\`.\`conversationId\`
    ) \`j\` ON \`j\`.\`cid\` = \`c\`.\`id\`
    SET \`c\`.\`userId\` = \`j\`.\`uid\`
    WHERE \`c\`.\`userId\` IS NULL
`;

// 类别 3：仅有附件的全局对话 → 附件上传者（MIN 取确定值）
const SQL_CATEGORY_3 = `
  UPDATE \`Conversation\` \`c\`
    JOIN (
      SELECT \`a\`.\`conversationId\` AS \`cid\`, MIN(\`a\`.\`userId\`) AS \`uid\`
      FROM \`ChatAttachment\` \`a\`
      GROUP BY \`a\`.\`conversationId\`
    ) \`j\` ON \`j\`.\`cid\` = \`c\`.\`id\`
    SET \`c\`.\`userId\` = \`j\`.\`uid\`
    WHERE \`c\`.\`userId\` IS NULL
`;

async function main() {
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
}

main()
  .catch((error) => {
    console.error('回填 Conversation.userId 失败:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
