import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * P5-4 / P5-9：两个 npm 计费脚本必须调 canonical 实现，不得再自带一份账务模型。
 *
 * 旧 `scripts/reset-monthly-quotas.mjs` 全文只有一条 updateMany —— 不结算 purchasedMinutesBalance
 *（持池用户本周期动用的池分钟永久免费）、不清 async/full 预留列（违反「先清预留再归零 used」的顺序
 * 不变量，下一次 settleReservation 会把新周期真实扣费减掉）、不清 grant 预留。
 * 旧 `scripts/reconcile-transcription-usage.mjs` 同理有 6 处口径差异，每处都会凭空报 drift。
 * 二者都在 package.json + README 里与正确入口 `billing:maintenance` 并列、零警示。
 *
 * 放在 src/lib/__tests__ 而不是 scripts/__tests__：vitest 的 include 只覆盖 src/** 与 tests/**。
 */

const repoRoot = path.resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('计费脚本必须调 canonical 实现（P5-4 / P5-9）', () => {
  const pkg = JSON.parse(read('package.json')) as {
    scripts: Record<string, string>;
  };

  it('▶ billing:reset-quotas 指向调用 resetExpiredTranscriptionQuotas 的脚本', () => {
    const cmd = pkg.scripts['billing:reset-quotas'];
    expect(cmd).toBeDefined();
    const scriptPath = cmd.split(/\s+/).pop()!;
    const src = read(scriptPath);
    expect(src).toContain('resetExpiredTranscriptionQuotas');
    // 自带模型的标志：脚本自己写 user.updateMany 清 used
    expect(src).not.toMatch(/user\.updateMany/);
    expect(src).not.toMatch(/transcriptionMinutesUsed:\s*0/);
  });

  it('▶ billing:reconcile 指向调用 reconcileTranscriptionUsage 的脚本', () => {
    const cmd = pkg.scripts['billing:reconcile'];
    expect(cmd).toBeDefined();
    const scriptPath = cmd.split(/\s+/).pop()!;
    const src = read(scriptPath);
    expect(src).toContain('reconcileTranscriptionUsage');
    // 自带模型的标志：脚本自己遍历 session 重算
    expect(src).not.toMatch(/session\.findMany/);
    expect(src).not.toMatch(/driftMinutes:/);
  });

  it('README 里两个脚本旁必须点明 billing:maintenance 才是 cron 首选', () => {
    const readme = read('README.md');
    const row = readme
      .split('\n')
      .find((l) => l.includes('`npm run billing:maintenance`'));
    expect(row).toBeDefined();
    expect(row!.toLowerCase()).toContain('cron');
  });
});
