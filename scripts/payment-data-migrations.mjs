// Idempotent payment data backfills required by the production \`db push\` deployment path.
// Keep this module side-effect free so the probes and SQL can be regression-tested without a DB.

export const SQL_BACKFILL_PAYMENT_FULFILLMENT = `
UPDATE \`PaymentOrder\` \`po\`
LEFT JOIN (
  SELECT \`orderId\`
  FROM \`WalletTransaction\`
  WHERE \`orderId\` IS NOT NULL
    AND \`type\` IN ('purchase_membership', 'purchase_minutes')
  GROUP BY \`orderId\`
) \`proof\` ON \`proof\`.\`orderId\` = \`po\`.\`id\`
LEFT JOIN (
  SELECT \`lot\`.\`sourceOrderId\`
  FROM \`WalletFundingLot\` \`lot\`
  LEFT JOIN (
    SELECT \`sourceOrderId\`, SUM(\`amountCents\`) AS \`debtCents\`
    FROM \`PaymentDebt\`
    GROUP BY \`sourceOrderId\`
  ) \`debt\` ON \`debt\`.\`sourceOrderId\` = \`lot\`.\`sourceOrderId\`
  WHERE \`lot\`.\`sourceOrderId\` IS NOT NULL
    AND \`lot\`.\`status\` = 'reversed'
    AND \`lot\`.\`remainingCents\` = 0
    AND \`lot\`.\`reversedAt\` IS NOT NULL
    AND \`lot\`.\`originalCents\` =
        \`lot\`.\`reversedCents\` + COALESCE(\`debt\`.\`debtCents\`, 0)
    AND NOT EXISTS (
      SELECT 1 FROM \`WalletFundingAllocation\` \`allocation\`
      WHERE \`allocation\`.\`fundingLotId\` = \`lot\`.\`id\`
        AND \`allocation\`.\`reversedAt\` IS NULL
    )
) \`reversed_lot\` ON \`reversed_lot\`.\`sourceOrderId\` = \`po\`.\`id\`
SET \`po\`.\`fulfillmentStatus\` = CASE
      WHEN (\`po\`.\`status\` = 'refunded' OR \`po\`.\`refundedAt\` IS NOT NULL)
           AND \`reversed_lot\`.\`sourceOrderId\` IS NOT NULL THEN 'reversed'
      WHEN \`po\`.\`status\` = 'refunded' OR \`po\`.\`refundedAt\` IS NOT NULL THEN 'review'
      WHEN \`po\`.\`status\` = 'paid' AND \`po\`.\`kind\` = 'topup' THEN 'fulfilled'
      WHEN \`po\`.\`status\` = 'paid' AND \`po\`.\`kind\` = 'purchase'
           AND \`proof\`.\`orderId\` IS NOT NULL THEN 'fulfilled'
      WHEN \`po\`.\`status\` = 'paid' THEN 'review'
      ELSE \`po\`.\`fulfillmentStatus\`
    END,
    \`po\`.\`fulfilledAt\` = CASE
      WHEN \`po\`.\`status\` = 'paid' AND (
        \`po\`.\`kind\` = 'topup' OR \`proof\`.\`orderId\` IS NOT NULL
      ) THEN COALESCE(\`po\`.\`fulfilledAt\`, \`po\`.\`paidAt\`)
      ELSE \`po\`.\`fulfilledAt\`
    END,
    \`po\`.\`reviewReason\` = CASE
      WHEN (\`po\`.\`status\` = 'refunded' OR \`po\`.\`refundedAt\` IS NOT NULL)
           AND \`reversed_lot\`.\`sourceOrderId\` IS NULL
        THEN 'legacy_refund_unresolved'
      WHEN \`po\`.\`status\` = 'paid' AND NOT (
        \`po\`.\`kind\` = 'topup' OR
        (\`po\`.\`kind\` = 'purchase' AND \`proof\`.\`orderId\` IS NOT NULL)
      ) THEN COALESCE(\`po\`.\`reviewReason\`, 'legacy_fulfillment_unresolved')
      ELSE \`po\`.\`reviewReason\`
    END,
    \`po\`.\`fulfillmentError\` = CASE
      WHEN (\`po\`.\`status\` = 'refunded' OR \`po\`.\`refundedAt\` IS NOT NULL)
           AND \`reversed_lot\`.\`sourceOrderId\` IS NULL
        THEN 'historical refund has no complete downstream reversal proof'
      WHEN \`po\`.\`status\` = 'paid' AND NOT (
        \`po\`.\`kind\` = 'topup' OR
        (\`po\`.\`kind\` = 'purchase' AND \`proof\`.\`orderId\` IS NOT NULL)
      ) THEN COALESCE(\`po\`.\`fulfillmentError\`, 'historical paid order has no grant ledger proof')
      ELSE \`po\`.\`fulfillmentError\`
    END
WHERE (
    \`po\`.\`fulfillmentStatus\` = 'pending'
    AND (\`po\`.\`status\` = 'paid' OR \`po\`.\`status\` = 'refunded' OR \`po\`.\`refundedAt\` IS NOT NULL)
  ) OR (
    -- Remediate databases that briefly ran the unsafe historical refunded -> reversed backfill.
    \`po\`.\`fulfillmentStatus\` = 'reversed'
    AND (\`po\`.\`status\` = 'refunded' OR \`po\`.\`refundedAt\` IS NOT NULL)
    AND \`reversed_lot\`.\`sourceOrderId\` IS NULL
    -- A reason-bound ADMIN action writes this marker and a security audit in the same tx.
    -- Preserve that durable manual disposition across every idempotent startup backfill.
    AND COALESCE(\`po\`.\`reviewReason\`, '') NOT IN (
      'legacy_refund_manually_resolved', 'reversal_review_manually_resolved',
      'terminal_refund_review_resolved'
    )
  )
`;

export const SQL_HOLD_UNRESOLVED_LEGACY_REFUNDS = `
INSERT INTO \`PaymentAccountHold\` (
  \`id\`, \`dedupeKey\`, \`userId\`, \`sourceOrderId\`, \`debtId\`, \`reason\`,
  \`status\`, \`createdAt\`, \`updatedAt\`
)
SELECT UUID(), SHA2(CONCAT('legacy_refund_unresolved:', \`po\`.\`id\`), 256),
       \`po\`.\`userId\`, \`po\`.\`id\`, NULL, 'legacy_refund_unresolved',
       'active', NOW(3), NOW(3)
FROM \`PaymentOrder\` \`po\`
WHERE \`po\`.\`fulfillmentStatus\` = 'review'
  AND \`po\`.\`reviewReason\` = 'legacy_refund_unresolved'
ON DUPLICATE KEY UPDATE
  \`status\` = 'active', \`releasedAt\` = NULL, \`updatedAt\` = NOW(3)
`;

const defaultLogger = {
  log(message) {
    console.log(message);
  },
};

async function currentSchemaState(prisma) {
  const tables = await prisma.$queryRawUnsafe(`
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN (
        'PaymentOrder', 'WalletTransaction', 'WalletFundingLot',
        'WalletFundingAllocation', 'PaymentDebt', 'PaymentAccountHold'
      )
  `);
  const tableNames = new Set(tables.map((row) => String(row.TABLE_NAME)));
  const requiredTables = [
    'PaymentOrder',
    'WalletTransaction',
    'WalletFundingLot',
    'WalletFundingAllocation',
    'PaymentDebt',
    'PaymentAccountHold',
  ];
  if (!requiredTables.every((table) => tableNames.has(table))) {
    return { ready: false, reason: 'table_missing' };
  }

  const columns = await prisma.$queryRawUnsafe(`
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'PaymentOrder'
      AND COLUMN_NAME IN (
        'fulfillmentStatus', 'fulfilledAt', 'fulfillmentError', 'reviewReason'
      )
  `);
  const columnNames = new Set(columns.map((row) => String(row.COLUMN_NAME)));
  const required = ['fulfillmentStatus', 'fulfilledAt', 'fulfillmentError', 'reviewReason'];
  return required.every((column) => columnNames.has(column))
    ? { ready: true, reason: 'ready' }
    : { ready: false, reason: 'schema_pending' };
}

/**
 * Backfill first-class fulfillment state after \`db push\` adds its columns. Running this both
 * before and after db push is intentional: the pre-pass updates already-upgraded databases, and
 * the post-pass handles a legacy database whose columns were created by this deployment.
 */
export async function backfillPaymentFulfillmentState(prisma, logger = defaultLogger) {
  const state = await currentSchemaState(prisma);
  if (!state.ready) {
    logger.log(`[migrate-data] payment fulfillment 回填跳过（${state.reason}）`);
    return { status: state.reason, updated: 0 };
  }
  const updated = Number(
    await prisma.$executeRawUnsafe(SQL_BACKFILL_PAYMENT_FULFILLMENT)
  );
  const held = Number(
    await prisma.$executeRawUnsafe(SQL_HOLD_UNRESOLVED_LEGACY_REFUNDS)
  );
  logger.log(
    `[migrate-data] payment fulfillment 回填完成（更新 ${updated} 行，冻结/复核 ${held} 行）`
  );
  return { status: 'complete', updated };
}
