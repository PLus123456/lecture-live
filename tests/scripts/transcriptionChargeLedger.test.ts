import { describe, expect, it, vi } from 'vitest';
import {
  backfillTranscriptionChargeLedger,
  TRANSCRIPTION_CHARGE_LEDGER_MARKER,
} from '../../scripts/transcription-charge-ledger.mjs';

function harness(marker = 'running') {
  const execute = vi.fn().mockResolvedValue(2);
  const query = vi.fn().mockResolvedValue([{ value: marker }]);
  const tx = { $executeRawUnsafe: execute, $queryRawUnsafe: query };
  const prisma = {
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ cnt: 1 }]),
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const logger = { log: vi.fn() };
  return { prisma, tx, execute, query, logger };
}

describe('SEC-030 transcription charge ledger cutover', () => {
  it('skips safely before db push creates the ledger table', async () => {
    const { prisma, logger } = harness();
    prisma.$queryRawUnsafe.mockResolvedValueOnce([{ cnt: 0 }]);

    await expect(backfillTranscriptionChargeLedger(prisma, logger)).resolves.toEqual({
      status: 'missing-table',
      inserted: 0,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('serializes on an idempotent marker and never repeats a completed cutover', async () => {
    const { prisma, execute, logger } = harness('complete');

    await expect(backfillTranscriptionChargeLedger(prisma, logger)).resolves.toEqual({
      status: 'already-complete',
      inserted: 0,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toBe(TRANSCRIPTION_CHARGE_LEDGER_MARKER);
  });

  it('locks counters, subtracts live reservations and already-exact charges, and only marks a positive opening balance ambiguous', async () => {
    const { prisma, execute, query, logger } = harness('running');

    await expect(backfillTranscriptionChargeLedger(prisma, logger)).resolves.toEqual({
      status: 'complete',
      inserted: 2,
    });

    const openingSql = String(execute.mock.calls[1][0]);
    expect(openingSql).toContain('INSERT IGNORE INTO TranscriptionCharge');
    expect(openingSql).toContain('u.transcriptionMinutesUsed');
    expect(openingSql).toContain('COALESCE(sr.sessionReserved, 0)');
    expect(openingSql).toContain('COALESCE(gr.grantReserved, 0)');
    expect(openingSql).toContain('COALESCE(ec.exactCharged, 0)');
    expect(openingSql).toContain('legacyAmbiguous = FALSE');
    expect(openingSql).toContain(') > 0');
    expect(openingSql).toContain('legacy_opening_balance');
    expect(openingSql).toContain('TRUE');
    expect(String(query.mock.calls[1][0])).toContain(
      "SELECT id FROM User WHERE role <> 'ADMIN' ORDER BY id FOR UPDATE"
    );
    expect(execute.mock.calls[2][1]).toBe(TRANSCRIPTION_CHARGE_LEDGER_MARKER);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
