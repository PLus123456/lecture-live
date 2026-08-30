import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  backfillPaymentFulfillmentState,
  SQL_HOLD_UNRESOLVED_LEGACY_REFUNDS,
  SQL_BACKFILL_PAYMENT_FULFILLMENT,
} from '../../scripts/payment-data-migrations.mjs';

const REQUIRED_COLUMNS = [
  'fulfillmentStatus',
  'fulfilledAt',
  'fulfillmentError',
  'reviewReason',
];

function harness(input?: { tables?: string[]; columns?: string[]; updated?: number }) {
  const tables = input?.tables ?? [
    'PaymentOrder',
    'WalletTransaction',
    'WalletFundingLot',
    'WalletFundingAllocation',
    'PaymentDebt',
    'PaymentAccountHold',
  ];
  const columns = input?.columns ?? REQUIRED_COLUMNS;
  const prisma = {
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValueOnce(tables.map((TABLE_NAME) => ({ TABLE_NAME })))
      .mockResolvedValueOnce(columns.map((COLUMN_NAME) => ({ COLUMN_NAME }))),
    $executeRawUnsafe: vi.fn().mockResolvedValue(input?.updated ?? 0),
  };
  const logger = { log: vi.fn() };
  return { prisma, logger };
}

describe('SEC-027 production db-push fulfillment backfill', () => {
  it('统一数据库编排器在 db push 后重跑数据迁移入口', () => {
    const root = process.cwd();
    const orchestrator = readFileSync(
      path.join(root, 'scripts/ensure-database.mjs'),
      'utf8'
    );
    const migrator = readFileSync(
      path.join(root, 'scripts/db-migrate-data.mjs'),
      'utf8'
    );
    const dbPush = orchestrator.indexOf("'db',\n  'push'");
    const postPush = orchestrator.indexOf("'--security-only'", dbPush);

    expect(dbPush).toBeGreaterThan(0);
    expect(postPush).toBeGreaterThan(dbPush);
    expect(migrator).toContain('await backfillPaymentFulfillmentState(prisma)');
  });

  it('全新库/前置阶段缺表时安全跳过，等待 db push 后的第二次调用', async () => {
    const { prisma, logger } = harness({ tables: [] });

    await expect(backfillPaymentFulfillmentState(prisma, logger)).resolves.toEqual({
      status: 'table_missing',
      updated: 0,
    });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('列尚未由 db push 创建时安全跳过，不运行陈旧 SQL', async () => {
    const { prisma, logger } = harness({ columns: ['fulfillmentStatus'] });

    await expect(backfillPaymentFulfillmentState(prisma, logger)).resolves.toEqual({
      status: 'schema_pending',
      updated: 0,
    });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('只回填默认 pending 的历史终态；有流水证明才认定 purchase 已发放', async () => {
    const { prisma, logger } = harness({ updated: 4 });

    await expect(backfillPaymentFulfillmentState(prisma, logger)).resolves.toEqual({
      status: 'complete',
      updated: 4,
    });
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      SQL_BACKFILL_PAYMENT_FULFILLMENT
    );
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      SQL_HOLD_UNRESOLVED_LEGACY_REFUNDS
    );
    expect(SQL_BACKFILL_PAYMENT_FULFILLMENT).toMatch(
      /WalletTransaction[\s\S]*purchase_membership[\s\S]*purchase_minutes/
    );
    expect(SQL_BACKFILL_PAYMENT_FULFILLMENT).toMatch(
      /fulfillmentStatus` = 'pending'/
    );
    expect(SQL_BACKFILL_PAYMENT_FULFILLMENT).toContain(
      'legacy_fulfillment_unresolved'
    );
    expect(SQL_BACKFILL_PAYMENT_FULFILLMENT).toMatch(
      /refunded[\s\S]*reversed_lot[\s\S]*THEN 'reversed'[\s\S]*THEN 'review'/
    );
    expect(SQL_BACKFILL_PAYMENT_FULFILLMENT).toMatch(
      /originalCents[\s\S]*reversedCents[\s\S]*debtCents/
    );
    expect(SQL_BACKFILL_PAYMENT_FULFILLMENT).toMatch(
      /WalletFundingAllocation[\s\S]*reversedAt[\s\S]*IS NULL/
    );
    expect(SQL_BACKFILL_PAYMENT_FULFILLMENT).not.toContain(
      'PaymentWebhookEvent'
    );
    expect(SQL_BACKFILL_PAYMENT_FULFILLMENT).toContain(
      "'reversal_review_manually_resolved'"
    );
    expect(SQL_BACKFILL_PAYMENT_FULFILLMENT).toContain(
      "'terminal_refund_review_resolved'"
    );
    expect(SQL_BACKFILL_PAYMENT_FULFILLMENT).toContain(
      'historical refund has no complete downstream reversal proof'
    );
    expect(SQL_HOLD_UNRESOLVED_LEGACY_REFUNDS).toContain(
      "'legacy_refund_unresolved'"
    );
  });

  it('migration SQL quarantines historical refunded topups and installs an active hold', () => {
    const root = process.cwd();
    const fulfillment = readFileSync(
      path.join(
        root,
        'prisma/migrations/20260820_payment_fulfillment_state/migration.sql'
      ),
      'utf8'
    );
    const funding = readFileSync(
      path.join(
        root,
        'prisma/migrations/20260820_payment_funding_provenance/migration.sql'
      ),
      'utf8'
    );

    expect(fulfillment).toMatch(
      /status` = 'refunded'[\s\S]*THEN 'review'/
    );
    expect(fulfillment).not.toMatch(
      /status` = 'refunded'[^\n]*THEN 'reversed'/
    );
    expect(funding).toMatch(
      /PaymentAccountHold[\s\S]*legacy_refund_unresolved[\s\S]*status` = 'active'/
    );
  });

  it('重复执行由 pending 谓词收敛为 0 行，保持幂等', async () => {
    const { prisma, logger } = harness({ updated: 0 });

    await expect(backfillPaymentFulfillmentState(prisma, logger)).resolves.toEqual({
      status: 'complete',
      updated: 0,
    });
  });
});
