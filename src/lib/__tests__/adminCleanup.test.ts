import { describe, expect, it } from 'vitest';
import {
  expandCategoriesToActions,
  isNeverDeleteAction,
  validateAuditLogCleanupParams,
  validateJobCleanupParams,
} from '@/lib/adminCleanup';

describe('expandCategoriesToActions', () => {
  it('展开单个类别为具体的 action 名（precise，不是 prefix）', () => {
    expect(expandCategoriesToActions(['session'])).toEqual(
      expect.arrayContaining(['session.create', 'session.finalize'])
    );
    expect(expandCategoriesToActions(['login'])).toEqual(
      expect.arrayContaining(['user.login', 'user.logout'])
    );
  });

  it('多个类别合并并去重', () => {
    const actions = expandCategoriesToActions(['session', 'share', 'login']);
    expect(new Set(actions)).toEqual(
      new Set([
        'session.create',
        'session.finalize',
        'share.create',
        'share.revoke',
        'share.view',
        'share.transition_playback',
        'user.login',
        'user.logout',
      ])
    );
  });

  it('永不包含 admin.* / user.register / user.password.change', () => {
    const all = expandCategoriesToActions(['session', 'share', 'login', 'system']);
    for (const a of all) {
      expect(a.startsWith('admin.')).toBe(false);
      expect(a).not.toBe('user.register');
      expect(a).not.toBe('user.password.change');
    }
  });

  it('login 类别不包含登录失败（user.login.failed）— 安全审计需要长留', () => {
    const actions = expandCategoriesToActions(['login']);
    expect(actions).not.toContain('user.login.failed');
  });

  it('空类别返回空数组', () => {
    expect(expandCategoriesToActions([])).toEqual([]);
  });
});

describe('isNeverDeleteAction', () => {
  it('admin.* 全部禁删', () => {
    expect(isNeverDeleteAction('admin.user.delete')).toBe(true);
    expect(isNeverDeleteAction('admin.session.read')).toBe(true);
    expect(isNeverDeleteAction('admin.job.retry')).toBe(true);
    expect(isNeverDeleteAction('admin.auditlog.cleanup')).toBe(true);
  });

  it('user.register / user.password.change / user.login.failed 禁删', () => {
    expect(isNeverDeleteAction('user.register')).toBe(true);
    expect(isNeverDeleteAction('user.password.change')).toBe(true);
    expect(isNeverDeleteAction('user.login.failed')).toBe(true);
  });

  it('普通 action 允许删除', () => {
    expect(isNeverDeleteAction('user.login')).toBe(false);
    expect(isNeverDeleteAction('user.logout')).toBe(false);
    expect(isNeverDeleteAction('session.create')).toBe(false);
    expect(isNeverDeleteAction('share.create')).toBe(false);
    expect(isNeverDeleteAction('system.start')).toBe(false);
  });
});

describe('validateJobCleanupParams', () => {
  it('SUCCESS + 合法天数 = ok', () => {
    const r = validateJobCleanupParams({ statuses: ['SUCCESS'], olderThanDays: 30 });
    expect(r.ok).toBe(true);
    expect(r.statuses).toEqual(['SUCCESS']);
    expect(r.olderThanDays).toBe(30);
  });

  it.each(['SUBMITTED', 'PENDING', 'PROCESSING'])(
    '拒绝 in-flight 状态 %s',
    (status) => {
      const r = validateJobCleanupParams({ statuses: [status], olderThanDays: 30 });
      expect(r.ok).toBe(false);
      expect(r.error).toContain(status);
    }
  );

  it('就算混了一个 SUBMITTED 在 SUCCESS 后也拒绝', () => {
    const r = validateJobCleanupParams({
      statuses: ['SUCCESS', 'SUBMITTED'],
      olderThanDays: 30,
    });
    expect(r.ok).toBe(false);
  });

  it('拒绝空 statuses', () => {
    const r = validateJobCleanupParams({ statuses: [], olderThanDays: 30 });
    expect(r.ok).toBe(false);
  });

  it('拒绝未知状态', () => {
    const r = validateJobCleanupParams({ statuses: ['BOGUS'], olderThanDays: 30 });
    expect(r.ok).toBe(false);
  });

  it('拒绝 0 / 负数 / 超大天数', () => {
    expect(validateJobCleanupParams({ statuses: ['SUCCESS'], olderThanDays: 0 }).ok).toBe(false);
    expect(validateJobCleanupParams({ statuses: ['SUCCESS'], olderThanDays: -1 }).ok).toBe(false);
    expect(validateJobCleanupParams({ statuses: ['SUCCESS'], olderThanDays: 366 }).ok).toBe(false);
  });

  it('拒绝小数天数', () => {
    expect(
      validateJobCleanupParams({ statuses: ['SUCCESS'], olderThanDays: 1.5 }).ok
    ).toBe(false);
  });

  it('已知 type 通过、未知 type 拒绝', () => {
    const okR = validateJobCleanupParams({
      statuses: ['SUCCESS'],
      olderThanDays: 7,
      type: 'report_generation',
    });
    expect(okR.ok).toBe(true);
    expect(okR.type).toBe('report_generation');

    const badR = validateJobCleanupParams({
      statuses: ['SUCCESS'],
      olderThanDays: 7,
      type: 'mystery_type',
    });
    expect(badR.ok).toBe(false);
  });

  it('去重 statuses', () => {
    const r = validateJobCleanupParams({
      statuses: ['SUCCESS', 'SUCCESS', 'FAILED'],
      olderThanDays: 30,
    });
    expect(r.ok).toBe(true);
    expect(r.statuses).toEqual(['SUCCESS', 'FAILED']);
  });
});

describe('validateAuditLogCleanupParams', () => {
  it('合法类别 + 30 天 = ok', () => {
    const r = validateAuditLogCleanupParams({
      actionCategories: ['session', 'login'],
      olderThanDays: 60,
    });
    expect(r.ok).toBe(true);
    expect(r.actions.length).toBeGreaterThan(0);
    expect(r.actions).not.toContain('user.register');
    expect(r.actions).not.toContain('user.password.change');
  });

  it('拒绝小于 30 天', () => {
    const r = validateAuditLogCleanupParams({
      actionCategories: ['session'],
      olderThanDays: 7,
    });
    expect(r.ok).toBe(false);
  });

  it('拒绝大于 730 天', () => {
    const r = validateAuditLogCleanupParams({
      actionCategories: ['session'],
      olderThanDays: 1000,
    });
    expect(r.ok).toBe(false);
  });

  it('拒绝空类别', () => {
    const r = validateAuditLogCleanupParams({
      actionCategories: [],
      olderThanDays: 60,
    });
    expect(r.ok).toBe(false);
  });

  it('拒绝未知类别（如 admin / register）', () => {
    expect(
      validateAuditLogCleanupParams({
        actionCategories: ['admin'],
        olderThanDays: 60,
      }).ok
    ).toBe(false);
    expect(
      validateAuditLogCleanupParams({
        actionCategories: ['register'],
        olderThanDays: 60,
      }).ok
    ).toBe(false);
  });
});
