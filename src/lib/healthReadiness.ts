import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { JWT_SECRET } from '@/lib/serverSecrets';
import { getHealthReport, type HealthReport } from '@/lib/health';

export const HEALTH_READINESS_CONTEXT =
  'lecture-live:health-readiness:v1';
const READINESS_CACHE_MS = 5_000;

let cached: { expiresAt: number; report: HealthReport } | null = null;
let inFlight: Promise<HealthReport> | null = null;

export function deriveHealthReadinessToken(secret = JWT_SECRET): string {
  return createHmac('sha256', secret)
    .update(HEALTH_READINESS_CONTEXT)
    .digest('hex');
}

export function isHealthReadinessAuthorized(req: Request): boolean {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;
  const providedHex = header.slice('Bearer '.length).trim();
  if (!/^[a-f0-9]{64}$/i.test(providedHex)) return false;

  const provided = Buffer.from(providedHex, 'hex');
  const expected = Buffer.from(deriveHealthReadinessToken(), 'hex');
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

/**
 * Coalesce concurrent readiness callers and briefly reuse the result. Even an
 * authorized but over-eager monitor cannot fan one request into four fresh
 * dependency probes on every connection.
 */
export async function getCoalescedHealthReport(
  now = Date.now()
): Promise<HealthReport> {
  if (cached && cached.expiresAt > now) return cached.report;
  if (inFlight) return inFlight;

  inFlight = getHealthReport()
    .then((report) => {
      cached = { report, expiresAt: Date.now() + READINESS_CACHE_MS };
      return report;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
