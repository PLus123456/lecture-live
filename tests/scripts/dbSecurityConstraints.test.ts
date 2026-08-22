import { describe, expect, it, vi } from 'vitest';
import {
  ensureRechargeTierAdminConstraint,
  RECHARGE_TIER_ADMIN_CONSTRAINT,
  SQL_ADD_RECHARGE_TIER_ADMIN_CONSTRAINT,
  SQL_ENFORCE_RECHARGE_TIER_ADMIN_CONSTRAINT,
  SQL_QUARANTINE_ACTIVE_ADMIN_TIERS,
  supportsEnforcedCheckConstraints,
} from '../../scripts/db-security-constraints.mjs';

describe('SEC-023 database CHECK version gate', () => {
  it.each([
    ['8.0.16', true],
    ['8.4.1-commercial', true],
    ['8.0.15', false],
    ['5.7.44', false],
    ['10.2.1-MariaDB', true],
    ['10.1.48-MariaDB', false],
    ['5.7.25-TiDB-v8.5.0', false],
    ['', false],
  ])('%s -> enforced=%s', (version, supported) => {
    expect(supportsEnforcedCheckConstraints(version)).toBe(supported);
  });
});

function createHarness(input?: {
  tableExists?: boolean;
  version?: string;
  constraintExists?: boolean;
  constraintEnforced?: boolean;
  quarantined?: number;
  concurrentInstall?: boolean;
}) {
  let constraintExists = input?.constraintExists ?? false;
  let constraintEnforced = input?.constraintEnforced ?? true;
  const events: string[] = [];
  const prisma = {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('information_schema.TABLES')) {
        return [{ cnt: input?.tableExists === false ? 0 : 1 }];
      }
      if (sql.includes('SELECT VERSION()')) {
        return [{ version: input?.version ?? '8.0.36' }];
      }
      if (sql.includes('SELECT ENFORCED')) {
        return [{ enforced: constraintEnforced ? 'YES' : 'NO' }];
      }
      if (sql.includes('information_schema.TABLE_CONSTRAINTS')) {
        return [{ cnt: constraintExists ? 1 : 0 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      if (sql === SQL_QUARANTINE_ACTIVE_ADMIN_TIERS) {
        events.push('quarantine');
        return input?.quarantined ?? 0;
      }
      if (sql === SQL_ADD_RECHARGE_TIER_ADMIN_CONSTRAINT) {
        events.push('constraint');
        constraintExists = true;
        if (input?.concurrentInstall) throw new Error('duplicate constraint name');
        return 0;
      }
      if (sql === SQL_ENFORCE_RECHARGE_TIER_ADMIN_CONSTRAINT) {
        events.push('enforce');
        constraintEnforced = true;
        return 0;
      }
      throw new Error(`unexpected execute: ${sql}`);
    }),
  };
  const logger = { log: vi.fn(), warn: vi.fn() };
  return { prisma, logger, events };
}

describe('SEC-023 database CHECK installer', () => {
  it('全新库在 db push 前无表时跳过，供 post-push 阶段重跑', async () => {
    const { prisma, logger } = createHarness({ tableExists: false });

    await expect(
      ensureRechargeTierAdminConstraint(prisma, logger)
    ).resolves.toEqual({ status: 'table_missing' });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('不支持强制 CHECK 的数据库拒绝启动，不安装装饰性假约束', async () => {
    const { prisma, logger } = createHarness({ version: '8.0.15' });

    await expect(
      ensureRechargeTierAdminConstraint(prisma, logger)
    ).rejects.toThrow('MySQL >= 8.0.16');
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('先隔离存量 active ADMIN，再安装并回读命名约束', async () => {
    const { prisma, logger, events } = createHarness({ quarantined: 2 });

    await expect(
      ensureRechargeTierAdminConstraint(prisma, logger)
    ).resolves.toEqual({ status: 'installed', quarantined: 2 });
    expect(events).toEqual(['quarantine', 'constraint']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('2'));
    expect(SQL_ADD_RECHARGE_TIER_ADMIN_CONSTRAINT).toContain(
      RECHARGE_TIER_ADMIN_CONSTRAINT
    );
  });

  it('约束已存在时幂等跳过 ALTER，但仍清理异常存量', async () => {
    const { prisma, logger, events } = createHarness({
      constraintExists: true,
      quarantined: 1,
    });

    await expect(
      ensureRechargeTierAdminConstraint(prisma, logger)
    ).resolves.toEqual({ status: 'already_present', quarantined: 1 });
    expect(events).toEqual(['quarantine']);
  });

  it('MySQL 中同名约束若被设为 NOT ENFORCED，会恢复强制状态后再放行', async () => {
    const { prisma, logger, events } = createHarness({
      constraintExists: true,
      constraintEnforced: false,
    });

    await expect(
      ensureRechargeTierAdminConstraint(prisma, logger)
    ).resolves.toEqual({ status: 'enforced_existing', quarantined: 0 });
    expect(events).toEqual(['quarantine', 'enforce']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('NOT ENFORCED'));
  });

  it('并发启动的 ALTER 冲突只有在回读确认约束存在后才吞掉', async () => {
    const { prisma, logger } = createHarness({ concurrentInstall: true });

    await expect(
      ensureRechargeTierAdminConstraint(prisma, logger)
    ).resolves.toEqual({ status: 'installed_concurrently', quarantined: 0 });
  });
});
