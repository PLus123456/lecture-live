import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

// vitest.setup supplies a syntactically valid fallback URL even when no server is running locally.
// CI provisions MySQL; developers can opt in against an isolated test database explicitly.
const hasMysql =
  /^mysql:/i.test(process.env.DATABASE_URL ?? '') &&
  (process.env.CI === 'true' || process.env.RUN_MYSQL_INTEGRATION_TESTS === '1');
const describeMysql = hasMysql ? describe : describe.skip;

describeMysql('SEC-030 MySQL REPEATABLE READ barrier', () => {
  const clientA = new PrismaClient();
  const clientB = new PrismaClient();

  afterAll(async () => {
    await Promise.all([clientA.$disconnect(), clientB.$disconnect()]);
  });

  it(
    'proves a batch-wide snapshot is stale, while a fresh per-user lock-first transaction sees settlement',
    async () => {
      const suffix = randomUUID();
      const userId = `sec030-${suffix}`;
      const sessionId = `sec030-session-${suffix}`;
      const email = `sec030-${suffix}@example.invalid`;

      await clientA.$executeRawUnsafe(
        `INSERT INTO User
          (id, email, passwordHash, displayName, role, transcriptionMinutesUsed,
           quotaResetAt, createdAt, updatedAt)
         VALUES (?, ?, 'not-a-login', 'SEC-030 test', 'FREE', 10,
                 DATE_ADD(NOW(3), INTERVAL 1 MONTH), NOW(3), NOW(3))`,
        userId,
        email
      );
      await clientA.$executeRawUnsafe(
        `INSERT INTO Session
          (id, userId, title, status, asyncReservedMinutes, createdAt, updatedAt)
         VALUES (?, ?, 'SEC-030 barrier', 'CREATED', 10, NOW(3), NOW(3))`,
        sessionId,
        userId
      );

      let snapshotReady!: () => void;
      let settlementCommitted!: () => void;
      const snapshotReadyPromise = new Promise<void>((resolve) => {
        snapshotReady = resolve;
      });
      const settlementPromise = new Promise<void>((resolve) => {
        settlementCommitted = resolve;
      });

      try {
        const staleBatch = clientA.$transaction(
          async (tx) => {
            const initial = await tx.$queryRawUnsafe<Array<{ reserved: number }>>(
              'SELECT asyncReservedMinutes AS reserved FROM Session WHERE id = ?',
              sessionId
            );
            snapshotReady();
            await settlementPromise;

            const currentUser = await tx.$queryRawUnsafe<Array<{ used: number }>>(
              'SELECT transcriptionMinutesUsed AS used FROM User WHERE id = ? FOR UPDATE',
              userId
            );
            const staleSession = await tx.$queryRawUnsafe<Array<{ reserved: number }>>(
              'SELECT asyncReservedMinutes AS reserved FROM Session WHERE id = ?',
              sessionId
            );
            return {
              initialReservation: Number(initial[0].reserved),
              currentUsed: Number(currentUser[0].used),
              staleReservation: Number(staleSession[0].reserved),
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
        );

        await snapshotReadyPromise;
        await clientB.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'UPDATE Session SET asyncReservedMinutes = 0 WHERE id = ?',
            sessionId
          );
          await tx.$executeRawUnsafe(
            'UPDATE User SET transcriptionMinutesUsed = 0 WHERE id = ?',
            userId
          );
        });
        settlementCommitted();

        await expect(staleBatch).resolves.toEqual({
          initialReservation: 10,
          currentUsed: 0,
          staleReservation: 10,
        });

        const freshPerUser = await clientA.$transaction(
          async (tx) => {
            const currentUser = await tx.$queryRawUnsafe<Array<{ used: number }>>(
              'SELECT transcriptionMinutesUsed AS used FROM User WHERE id = ? FOR UPDATE',
              userId
            );
            const currentSession = await tx.$queryRawUnsafe<Array<{ reserved: number }>>(
              'SELECT asyncReservedMinutes AS reserved FROM Session WHERE id = ?',
              sessionId
            );
            return {
              used: Number(currentUser[0].used),
              reservation: Number(currentSession[0].reserved),
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
        );
        expect(freshPerUser).toEqual({ used: 0, reservation: 0 });
      } finally {
        settlementCommitted?.();
        await clientA.$executeRawUnsafe('DELETE FROM Session WHERE id = ?', sessionId);
        await clientA.$executeRawUnsafe('DELETE FROM User WHERE id = ?', userId);
      }
    },
    20_000
  );
});
