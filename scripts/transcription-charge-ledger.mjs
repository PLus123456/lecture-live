const MARKER_KEY = 'transcription_charge_ledger_backfilled_v1';

async function tableExists(prisma, table) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    table
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

/**
 * Cut existing counters over to the immutable TranscriptionCharge ledger.
 *
 * Session.billedMinutes is cumulative while Session.billedAt is only the most recent charge time,
 * so existing rows cannot be split across quota periods without guessing. We preserve the current
 * committed counter as one opening-balance event and mark it ambiguous. Reconciliation may detect
 * drift but must not auto-repair while that marker is inside the active quota window. After the
 * next reset, only exact per-charge rows remain in scope.
 *
 * The marker row is inserted and locked inside the same transaction as the backfill. Concurrent
 * web/WS startup processes therefore serialize on its primary key; a crash rolls back both marker
 * and ledger rows, making retries safe.
 */
/** @param {{ log: (...data: unknown[]) => void }} [logger] */
export async function backfillTranscriptionChargeLedger(prisma, logger = console) {
  if (!(await tableExists(prisma, 'TranscriptionCharge'))) {
    logger.log('[migrate-data] TranscriptionCharge 不存在，跳过（等待 db push 建表）');
    return { status: 'missing-table', inserted: 0 };
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT IGNORE INTO SiteSetting (\`key\`, \`value\`, \`updatedAt\`)
       VALUES (?, 'running', NOW(3))`,
      MARKER_KEY
    );
    const markerRows = await tx.$queryRawUnsafe(
      'SELECT `value` FROM SiteSetting WHERE `key` = ? FOR UPDATE',
      MARKER_KEY
    );
    if (markerRows[0]?.value === 'complete') {
      logger.log('[migrate-data] SEC-030 转录逐笔台账已回填，跳过');
      return { status: 'already-complete', inserted: 0 };
    }

    // Every charge/reservation path mutates User.transcriptionMinutesUsed in the same transaction.
    // Lock all billable users before taking the opening snapshot so a live process cannot commit an
    // exact charge between reading the counter and inserting its opening row. Any exact ledger rows
    // that won before this lock are subtracted below; losers resume after the cutover and append only
    // their exact row.
    await tx.$queryRawUnsafe(
      "SELECT id FROM User WHERE role <> 'ADMIN' ORDER BY id FOR UPDATE"
    );

    const inserted = await tx.$executeRawUnsafe(`
      INSERT IGNORE INTO TranscriptionCharge
        (id, userId, source, referenceId, minutes, chargedAt, legacyAmbiguous, createdAt)
      SELECT
        CONCAT('legacy-opening-', SHA2(u.id, 256)),
        u.id,
        'legacy_opening_balance',
        u.id,
        GREATEST(
          0,
          u.transcriptionMinutesUsed
          - COALESCE(sr.sessionReserved, 0)
          - COALESCE(gr.grantReserved, 0)
          - COALESCE(ec.exactCharged, 0)
        ),
        NOW(3),
        TRUE,
        NOW(3)
      FROM User u
      LEFT JOIN (
        SELECT
          userId,
          SUM(GREATEST(asyncReservedMinutes, 0) + GREATEST(fullReservedMinutes, 0)) AS sessionReserved
        FROM Session
        GROUP BY userId
      ) sr ON sr.userId = u.id
      LEFT JOIN (
        SELECT userId, SUM(GREATEST(reservedMinutes, 0)) AS grantReserved
        FROM SonioxStreamGrant
        WHERE settledAt IS NULL
        GROUP BY userId
      ) gr ON gr.userId = u.id
      LEFT JOIN (
        SELECT userId, SUM(GREATEST(minutes, 0)) AS exactCharged
        FROM TranscriptionCharge
        WHERE legacyAmbiguous = FALSE
        GROUP BY userId
      ) ec ON ec.userId = u.id
      WHERE u.role <> 'ADMIN'
        AND GREATEST(
          0,
          u.transcriptionMinutesUsed
          - COALESCE(sr.sessionReserved, 0)
          - COALESCE(gr.grantReserved, 0)
          - COALESCE(ec.exactCharged, 0)
        ) > 0
    `);

    await tx.$executeRawUnsafe(
      `UPDATE SiteSetting SET \`value\` = 'complete', \`updatedAt\` = NOW(3)
       WHERE \`key\` = ?`,
      MARKER_KEY
    );
    const count = Number(inserted);
    logger.log(`[migrate-data] SEC-030 转录逐笔台账切换完成（opening rows: ${count}）`);
    return { status: 'complete', inserted: count };
  });
}

export { MARKER_KEY as TRANSCRIPTION_CHARGE_LEDGER_MARKER };
