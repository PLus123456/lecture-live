#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { decryptStoredSetting } from './payment-production-preflight-core.mjs';
import {
  applyStripeHistoricalReconciliation,
  finalizeStripeHistoricalReconciliation,
  scanStripeHistoricalReversals,
  STRIPE_HISTORY_CONFIRMATION,
  STRIPE_HISTORY_FINALIZE_CONFIRMATION,
  summarizeStripeHistoricalScan,
  verifyLegacyStripeOrderNamespaces,
} from './stripe-history-reconciliation-core.mjs';

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    const separator = arg.indexOf('=');
    if (separator < 0) flags.add(arg.slice(2));
    else values.set(arg.slice(2, separator), arg.slice(separator + 1));
  }
  const known = new Set(['apply', 'finalize', 'dry-run', 'help']);
  for (const flag of flags) if (!known.has(flag)) throw new Error(`unknown flag: --${flag}`);
  const knownValues = new Set(['since', 'through', 'max-items', 'reason', 'confirm']);
  for (const key of values.keys()) {
    if (!knownValues.has(key)) throw new Error(`unknown option: --${key}`);
  }
  if (
    [flags.has('apply'), flags.has('finalize'), flags.has('dry-run')].filter(Boolean)
      .length > 1
  ) {
    throw new Error('--apply, --finalize, and --dry-run are mutually exclusive');
  }
  return {
    help: flags.has('help'),
    apply: flags.has('apply'),
    finalize: flags.has('finalize'),
    since: values.get('since'),
    through: values.get('through'),
    maxItems: Number(values.get('max-items') ?? 5000),
    reason: values.get('reason') ?? '',
    confirm: values.get('confirm') ?? '',
  };
}

function usage() {
  return `Usage:
  node scripts/reconcile-stripe-history.mjs [--since=ISO] [--through=ISO] [--max-items=5000]
  node scripts/reconcile-stripe-history.mjs --apply --reason="..." --confirm=${STRIPE_HISTORY_CONFIRMATION}
  node scripts/reconcile-stripe-history.mjs --finalize --reason="..." --confirm=${STRIPE_HISTORY_FINALIZE_CONFIRMATION}

Default mode is read-only dry-run. --apply writes bounded inbox/review rows and a completion marker.`;
}

async function readHistoryBounds(prisma, requestedSince, requestedThrough) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS orderCount, MIN(createdAt) AS earliest
     FROM PaymentOrder
     WHERE provider = 'stripe' AND status IN ('paid', 'late_paid', 'refunded')`
  );
  const namespaces = await prisma.$queryRawUnsafe(
    `SELECT providerMode, providerAccount, COUNT(*) AS orderCount
     FROM PaymentOrder
     WHERE provider = 'stripe' AND status IN ('paid', 'late_paid', 'refunded')
     GROUP BY providerMode, providerAccount
     ORDER BY providerMode, providerAccount`
  );
  const orderCount = Number(rows[0]?.orderCount ?? 0);
  const earliest = rows[0]?.earliest ? new Date(rows[0].earliest) : null;
  const through = requestedThrough ? new Date(requestedThrough) : new Date();
  const since = requestedSince
    ? new Date(requestedSince)
    : earliest
      ? new Date(earliest.getTime() - 24 * 60 * 60 * 1000)
      : new Date(through.getTime() - 24 * 60 * 60 * 1000);
  if (!Number.isFinite(since.getTime()) || !Number.isFinite(through.getTime())) {
    throw new Error('--since/--through must be valid ISO dates');
  }
  if (earliest && since.getTime() > earliest.getTime()) {
    throw new Error(
      `--since is later than the earliest local Stripe order (${earliest.toISOString()}); refusing a partial completion marker`
    );
  }
  return {
    orderCount,
    since,
    through,
    namespaces: namespaces.map((row) => ({
      providerMode: String(row.providerMode),
      providerAccount: String(row.providerAccount),
      orderCount: Number(row.orderCount),
    })),
  };
}

async function readStripeSecret(prisma, env) {
  const fromEnv = env.STRIPE_SECRET_KEY?.trim();
  if (fromEnv) return fromEnv;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT value FROM SiteSetting WHERE \`key\` = 'recharge_stripe_secret_key' LIMIT 1`
  );
  const stored = typeof rows[0]?.value === 'string' ? rows[0].value : '';
  if (!stored) {
    throw new Error(
      'Stripe secret key is not configured; set one-time STRIPE_SECRET_KEY or configure recharge Stripe first'
    );
  }
  return decryptStoredSetting(stored, env);
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  logger = console,
  prisma = new PrismaClient(),
  ownsPrisma = true,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    logger.log(usage());
    return { status: 'help' };
  }
  if (args.apply || args.finalize) {
    const expectedConfirmation = args.finalize
      ? STRIPE_HISTORY_FINALIZE_CONFIRMATION
      : STRIPE_HISTORY_CONFIRMATION;
    if (args.confirm !== expectedConfirmation) {
      throw new Error(
        `--${args.finalize ? 'finalize' : 'apply'} requires --confirm=${expectedConfirmation}`
      );
    }
    if (args.reason.trim().length < 3 || args.reason.trim().length > 500) {
      throw new Error('--apply requires a 3-500 character --reason');
    }
  }
  try {
    const bounds = await readHistoryBounds(prisma, args.since, args.through);
    const secretKey = await readStripeSecret(prisma, env);
    if (args.finalize) {
      const markerRows = await prisma.$queryRawUnsafe(
        `SELECT value FROM SiteSetting WHERE \`key\` = 'payment_stripe_history_reconciliation_v1' LIMIT 1`
      );
      let pendingMarker;
      try {
        pendingMarker = JSON.parse(markerRows[0]?.value ?? '');
      } catch {
        throw new Error('Stripe history pending marker is missing or invalid');
      }
      if (
        pendingMarker?.status !== 'scan_complete_pending_review' ||
        !pendingMarker?.since
      ) {
        throw new Error('Stripe history must be imported before finalization');
      }
      // Close the maintenance-window gap: rescan the original coverage start through now,
      // idempotently import anything that arrived while operators were resolving the queue,
      // then finalize only if the fresh import still leaves no review/inbox/hold.
      const catchup = await scanStripeHistoricalReversals({
        secretKey,
        since: pendingMarker.since,
        through: new Date(),
        maxItems: args.maxItems,
        fetchImpl,
      });
      catchup.namespaceAudit = await verifyLegacyStripeOrderNamespaces(prisma, {
        secretKey,
        fetchImpl,
        reason: args.reason,
        dryRun: false,
      });
      await applyStripeHistoricalReconciliation(prisma, catchup, {
        reason: `${args.reason.trim()} (final catch-up scan)`.slice(0, 500),
      });
      const summary = await finalizeStripeHistoricalReconciliation(prisma, {
        secretKey,
        reason: args.reason,
      });
      logger.log(JSON.stringify({ mode: 'finalize', ...summary }, null, 2));
      return { status: 'complete', summary };
    }
    const scan = await scanStripeHistoricalReversals({
      secretKey,
      since: bounds.since,
      through: bounds.through,
      maxItems: args.maxItems,
      fetchImpl,
    });
    scan.namespaceAudit = await verifyLegacyStripeOrderNamespaces(prisma, {
      secretKey,
      fetchImpl,
      reason: args.reason || 'dry-run namespace verification',
      dryRun: !args.apply,
    });
    if (!args.apply) {
      const summary = summarizeStripeHistoricalScan(scan);
      logger.log(
        JSON.stringify(
          {
            mode: 'dry-run',
            orderCount: bounds.orderCount,
            localNamespaces: bounds.namespaces,
            namespaceAudit: scan.namespaceAudit,
            ...summary,
          },
          null,
          2
        )
      );
      return { status: 'dry-run', scan };
    }
    const applied = await applyStripeHistoricalReconciliation(prisma, scan, {
      reason: args.reason,
    });
    logger.log(JSON.stringify({ mode: 'apply', ...applied.summary }, null, 2));
    return { status: applied.summary.status, ...applied };
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
}

const isEntrypoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error(
      '[stripe-history] FATAL:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  });
}
