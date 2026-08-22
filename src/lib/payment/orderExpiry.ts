import 'server-only';

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

type Db = Pick<Prisma.TransactionClient, '$executeRaw'> | typeof prisma;

/**
 * Advance unpaid orders into the explicit expired state.
 *
 * This sweep is intentionally only a visibility/state-machine aid: settlement still locks the
 * order and compares the provider-signed paidAt with expiresAt in the same transaction. Therefore
 * either race order is safe: a pre-expiry payment may resume an `expired` row, while a post-expiry
 * payment is quarantined as `late_paid` and never receives wallet credit or entitlements.
 */
export async function expirePendingPaymentOrders(
  now = new Date(),
  db: Db = prisma
): Promise<number> {
  if (!Number.isFinite(now.getTime())) throw new Error('invalid payment expiry timestamp');
  const changed = await db.$executeRaw`
    UPDATE PaymentOrder
    SET status = 'expired'
    WHERE status = 'pending'
      AND fulfillmentStatus = 'pending'
      AND expiresAt IS NOT NULL
      AND expiresAt <= ${now}
  `;
  return Number(changed);
}
