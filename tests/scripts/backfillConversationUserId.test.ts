import { describe, expect, it } from 'vitest';

/**
 * L26：孤儿对话回填不得把「多上传者 / 多挂载者」的对话判给 MIN 那一位。
 *
 * 这条逻辑整个活在 SQL 里，而脚本本身跑在 MySQL 上（vitest 不连库），所以这里只能锁 SQL 形态：
 * 归属反推的两条聚合 UPDATE 必须带 `HAVING COUNT(DISTINCT userId) = 1`。
 * 少了它，MIN() 会在归属有歧义时静默挑一个人，把别人上传的附件 / 别人的录音摘录
 * 一并授予他 —— 而且 ensure-database.mjs 每次部署都会重跑这段。
 * （SQL 本身的可执行性已对着真实 MySQL 跑通验证过。）
 */

// 脚本已改为「仅作为入口点时才执行 main()」，可安全 import 常量
import {
  SQL_CATEGORY_1,
  SQL_CATEGORY_2,
  SQL_CATEGORY_3,
  SQL_AMBIGUOUS_COUNT,
} from '../../scripts/backfill-conversation-user-id.mjs';

/** 去掉反引号与多余空白，便于稳定断言 */
function normalize(sql: string): string {
  return sql.replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

describe('backfill-conversation-user-id SQL (L26)', () => {
  it('类别 1（sessionId 直连）归属天然唯一，不需要 HAVING', () => {
    const sql = normalize(SQL_CATEGORY_1);
    expect(sql).toContain('c.userId IS NULL');
    expect(sql).toContain('c.sessionId IS NOT NULL');
    expect(sql).not.toContain('MIN(');
  });

  it.each([
    ['类别 2（挂载 Session）', () => SQL_CATEGORY_2, 's.userId'],
    ['类别 3（附件上传者）', () => SQL_CATEGORY_3, 'a.userId'],
  ])('%s 只回填归属唯一的行', (_label, get, col) => {
    const sql = normalize(get());
    expect(sql).toContain(`HAVING COUNT(DISTINCT ${col}) = 1`);
    // 幂等守卫不能丢
    expect(sql).toContain('c.userId IS NULL');
  });

  it('诊断查询能把「有歧义所以刻意没回填」的行单独数出来', () => {
    const sql = normalize(SQL_AMBIGUOUS_COUNT);
    expect(sql).toContain('c.userId IS NULL');
    expect(sql).toContain('COUNT(DISTINCT s.userId)');
    expect(sql).toContain('COUNT(DISTINCT a.userId)');
    expect(sql).toContain('> 1');
  });
});
