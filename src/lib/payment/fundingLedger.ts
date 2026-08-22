import 'server-only';

import crypto from 'crypto';
import type { Prisma } from '@prisma/client';

export type FundingSourceKind =
  | 'payment'
  | 'admin'
  | 'service_refund'
  | 'legacy_unattributed';

interface FundingLotRow {
  id: string;
  userId: string;
  originalCents: number;
  remainingCents: number;
  status: string;
}

export interface FundingAllocationRow {
  id: string;
  fundingLotId: string;
  userId: string;
  spendTransactionId: string;
  entitlementId: string | null;
  targetKind: string;
  amountCents: number;
  entitlementUnits: number;
  recoveredUnits: number;
  debtCents: number;
  reversedAt: Date | string | null;
}

const cents = (value: number) => Math.max(0, Math.round(value));

export async function assertNoActivePaymentHold(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM PaymentAccountHold
    WHERE userId = ${userId} AND status = 'active'
    LIMIT 1
    FOR UPDATE
  `;
  if (rows[0]) throw new Error('payment_account_frozen');
}

export async function createWalletFundingLot(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    sourceOrderId?: string;
    sourceTransactionId?: string;
    sourceKind: FundingSourceKind;
    amountCents: number;
  }
): Promise<string> {
  const amount = cents(input.amountCents);
  const id = crypto.randomUUID();
  await tx.$executeRaw`
    INSERT INTO WalletFundingLot (
      id, userId, sourceOrderId, sourceTransactionId, sourceKind,
      originalCents, remainingCents, reversedCents, status, createdAt, updatedAt
    ) VALUES (
      ${id}, ${input.userId}, ${input.sourceOrderId ?? null},
      ${input.sourceTransactionId ?? null}, ${input.sourceKind},
      ${amount}, ${amount}, 0, 'active', NOW(3), NOW(3)
    )
  `;
  return id;
}

/**
 * Allocate a spend FIFO across tracked lots while the caller holds the User row lock. Any gap is
 * represented by a consumed legacy_unattributed lot instead of being guessed as a historical
 * payment source. `entitlementUnits` are apportioned once and sum exactly to totalUnits.
 */
export async function allocateWalletSpend(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    spendTransactionId: string;
    amountCents: number;
    /** Wallet balance after this spend; caller holds the User row lock. */
    balanceAfterCents: number;
    targetKind: 'membership' | 'minutes' | 'service' | 'admin';
    entitlementId?: string;
    totalUnits?: number;
    forcedFundingLotId?: string;
  }
): Promise<void> {
  const amount = cents(input.amountCents);
  if (amount === 0) return;
  if (
    !Number.isSafeInteger(input.balanceAfterCents) ||
    input.balanceAfterCents < 0 ||
    !Number.isSafeInteger(input.balanceAfterCents + amount)
  ) {
    throw new Error('invalid wallet balance for funding allocation');
  }
  const pieces: Array<{ lotId: string; amount: number }> = [];

  if (input.forcedFundingLotId) {
    pieces.push({ lotId: input.forcedFundingLotId, amount });
  } else {
    const lots = await tx.$queryRaw<FundingLotRow[]>`
      SELECT id, userId, originalCents, remainingCents, status
      FROM WalletFundingLot
      WHERE userId = ${input.userId} AND status = 'active' AND remainingCents > 0
      ORDER BY CASE WHEN sourceKind = 'legacy_unattributed' THEN 0 ELSE 1 END,
               createdAt, id
      FOR UPDATE
    `;
    const trackedRemaining = lots.reduce((sum, lot) => {
      const remaining = Number(lot.remainingCents);
      if (!Number.isSafeInteger(remaining) || remaining < 0) {
        throw new Error('invalid wallet funding lot balance');
      }
      return sum + remaining;
    }, 0);
    const walletBeforeSpend = input.balanceAfterCents + amount;
    if (!Number.isSafeInteger(trackedRemaining) || trackedRemaining > walletBeforeSpend) {
      throw new Error('wallet funding ledger exceeds locked wallet balance');
    }

    // A balance that predates the lot ledger is necessarily older than every tracked payment.
    // Materialize the whole gap and consume it first; otherwise a post-upgrade spend would be
    // misattributed to a new topup, causing a later chargeback to claw back unrelated legacy money.
    const legacyGap = walletBeforeSpend - trackedRemaining;
    if (legacyGap > 0) {
      const legacyLotId = await createWalletFundingLot(tx, {
        userId: input.userId,
        sourceKind: 'legacy_unattributed',
        amountCents: legacyGap,
      });
      pieces.push({ lotId: legacyLotId, amount: Math.min(amount, legacyGap) });
    }

    let remaining = amount;
    if (pieces[0]) remaining -= pieces[0].amount;
    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, cents(Number(lot.remainingCents)));
      if (take > 0) {
        pieces.push({ lotId: lot.id, amount: take });
        remaining -= take;
      }
    }
    if (remaining > 0) {
      throw new Error('wallet funding allocation does not conserve locked balance');
    }
  }

  const totalUnits = Math.max(0, Math.round(input.totalUnits ?? 0));
  let assignedUnits = 0;
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];
    const units =
      i === pieces.length - 1
        ? totalUnits - assignedUnits
        : Math.floor((totalUnits * piece.amount) / amount);
    assignedUnits += units;
    const changed = await tx.$executeRaw`
      UPDATE WalletFundingLot
      SET remainingCents = remainingCents - ${piece.amount}, updatedAt = NOW(3)
      WHERE id = ${piece.lotId} AND userId = ${input.userId}
        AND status = 'active' AND remainingCents >= ${piece.amount}
    `;
    if (Number(changed) !== 1) {
      throw new Error('wallet funding lot allocation raced or became insufficient');
    }
    await tx.$executeRaw`
      INSERT INTO WalletFundingAllocation (
        id, fundingLotId, userId, spendTransactionId, entitlementId, targetKind,
        amountCents, entitlementUnits, recoveredUnits, debtCents, createdAt
      ) VALUES (
        ${crypto.randomUUID()}, ${piece.lotId}, ${input.userId},
        ${input.spendTransactionId}, ${input.entitlementId ?? null}, ${input.targetKind},
        ${piece.amount}, ${units}, 0, 0, NOW(3)
      )
    `;
  }
}

export async function lockFundingLotForOrder(
  tx: Prisma.TransactionClient,
  orderId: string
): Promise<FundingLotRow | null> {
  const rows = await tx.$queryRaw<FundingLotRow[]>`
    SELECT id, userId, originalCents, remainingCents, status
    FROM WalletFundingLot
    WHERE sourceOrderId = ${orderId}
    LIMIT 1
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function lockFundingAllocations(
  tx: Prisma.TransactionClient,
  lotId: string
): Promise<FundingAllocationRow[]> {
  return tx.$queryRaw<FundingAllocationRow[]>`
    SELECT id, fundingLotId, userId, spendTransactionId, entitlementId, targetKind,
           amountCents, entitlementUnits, recoveredUnits, debtCents, reversedAt
    FROM WalletFundingAllocation
    WHERE fundingLotId = ${lotId}
    ORDER BY createdAt, id
    FOR UPDATE
  `;
}

export async function recordPaymentDebtAndHold(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    sourceOrderId: string;
    sourceLotId?: string;
    amountCents: number;
    reason: string;
  }
): Promise<void> {
  const amount = cents(input.amountCents);
  if (amount === 0) return;
  const debtId = crypto.randomUUID();
  const reason = input.reason.slice(0, 191);
  await tx.$executeRaw`
    INSERT INTO PaymentDebt (
      id, userId, sourceOrderId, sourceLotId, amountCents, recoveredCents,
      reason, status, createdAt, updatedAt
    ) VALUES (
      ${debtId}, ${input.userId}, ${input.sourceOrderId}, ${input.sourceLotId ?? null},
      ${amount}, 0, ${reason}, 'open', NOW(3), NOW(3)
    )
    ON DUPLICATE KEY UPDATE
      amountCents = GREATEST(amountCents, VALUES(amountCents)), updatedAt = NOW(3)
  `;
  const debtRows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM PaymentDebt
    WHERE sourceOrderId = ${input.sourceOrderId} AND reason = ${reason}
    LIMIT 1
    FOR UPDATE
  `;
  const persistedDebtId = debtRows[0]?.id ?? debtId;
  const dedupeKey = crypto
    .createHash('sha256')
    .update(`${input.userId}\0${input.sourceOrderId}\0${reason}`)
    .digest('hex');
  await tx.$executeRaw`
    INSERT INTO PaymentAccountHold (
      id, dedupeKey, userId, sourceOrderId, debtId, reason,
      status, createdAt, updatedAt
    ) VALUES (
      ${crypto.randomUUID()}, ${dedupeKey}, ${input.userId}, ${input.sourceOrderId},
      ${persistedDebtId}, ${reason}, 'active', NOW(3), NOW(3)
    )
    ON DUPLICATE KEY UPDATE status = 'active', releasedAt = NULL, updatedAt = NOW(3)
  `;
}

/** Freeze payment-derived mutations while an amount-limited reversal awaits human disposition. */
export async function recordPaymentHold(
  tx: Prisma.TransactionClient,
  input: { userId: string; sourceOrderId: string; reason: string }
): Promise<void> {
  const reason = input.reason.slice(0, 191);
  const dedupeKey = crypto
    .createHash('sha256')
    .update(`${input.userId}\0${input.sourceOrderId}\0${reason}`)
    .digest('hex');
  await tx.$executeRaw`
    INSERT INTO PaymentAccountHold (
      id, dedupeKey, userId, sourceOrderId, debtId, reason,
      status, createdAt, updatedAt
    ) VALUES (
      ${crypto.randomUUID()}, ${dedupeKey}, ${input.userId}, ${input.sourceOrderId},
      NULL, ${reason}, 'active', NOW(3), NOW(3)
    )
    ON DUPLICATE KEY UPDATE status = 'active', releasedAt = NULL, updatedAt = NOW(3)
  `;
}

export async function markFundingAllocationReversed(
  tx: Prisma.TransactionClient,
  input: { allocationId: string; recoveredUnits: number; debtCents: number }
): Promise<void> {
  await tx.$executeRaw`
    UPDATE WalletFundingAllocation
    SET recoveredUnits = ${Math.max(0, Math.round(input.recoveredUnits))},
        debtCents = ${cents(input.debtCents)}, reversedAt = NOW(3)
    WHERE id = ${input.allocationId} AND reversedAt IS NULL
  `;
}

export async function markFundingLotReversed(
  tx: Prisma.TransactionClient,
  input: { lotId: string; recoveredCents: number }
): Promise<void> {
  await tx.$executeRaw`
    UPDATE WalletFundingLot
    SET remainingCents = 0, reversedCents = ${cents(input.recoveredCents)},
        status = 'reversed', reversedAt = NOW(3), updatedAt = NOW(3)
    WHERE id = ${input.lotId} AND status <> 'reversed'
  `;
}
