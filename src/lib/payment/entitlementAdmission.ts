import 'server-only';

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

type AdmissionDb = Prisma.TransactionClient;

export class PaymentAccountFrozenError extends Error {
  readonly code = 'payment_account_frozen';

  constructor() {
    super('账户存在未处理的支付争议，付费权益已冻结');
    this.name = 'PaymentAccountFrozenError';
  }
}

/**
 * Shared source-of-truth for every paid-benefit admission boundary. Callers that will mutate quota
 * pass a transaction and request the User lock, matching reversal's global User -> Hold suffix.
 * Login, account recovery, and the ADMIN review surface deliberately do not call this helper.
 */
export async function assertPaymentBenefitAvailable(
  userId: string,
  db: AdmissionDb = prisma,
  options: { lockUser?: boolean } = {}
): Promise<void> {
  if (options.lockUser) {
    const users = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM User WHERE id = ${userId} FOR UPDATE
    `;
    if (!users[0]) throw new Error('payment_user_not_found');
  }
  const holds = options.lockUser
    ? await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM PaymentAccountHold
        WHERE userId = ${userId} AND status = 'active'
        ORDER BY id LIMIT 1
        FOR UPDATE
      `
    : await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM PaymentAccountHold
        WHERE userId = ${userId} AND status = 'active'
        ORDER BY id LIMIT 1
      `;
  if (holds[0]) throw new PaymentAccountFrozenError();
}

export async function isPaymentBenefitAvailable(
  userId: string,
  db: AdmissionDb = prisma
): Promise<boolean> {
  try {
    await assertPaymentBenefitAvailable(userId, db);
    return true;
  } catch (error) {
    if (error instanceof PaymentAccountFrozenError) return false;
    throw error;
  }
}
