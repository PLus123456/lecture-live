import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import {
  getConfiguredSonioxRegionsAsync,
  resolveRequestedRegionAsync,
} from '@/lib/soniox/env';
import { getFlagUrlByRegion } from '@/lib/flags';
import { enforceRateLimit } from '@/lib/rateLimit';

const PING_TARGETS: Record<string, { label: string; url: string }> = {
  us: { label: 'US (Virginia)', url: 'https://api.soniox.com' },
  eu: { label: 'EU (Frankfurt)', url: 'https://api.eu.soniox.com' },
  jp: { label: 'JP (Tokyo)', url: 'https://api.jp.soniox.com' },
};

async function measureLatency(url: string): Promise<number | null> {
  try {
    const start = performance.now();
    // HEAD request to minimize data transfer — we only care about RTT
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return Math.round(performance.now() - start);
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: 'soniox:ping',
    limit: 5,
    windowMs: 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return rateLimited;
  }

  const configuredRegions = await getConfiguredSonioxRegionsAsync();
  const recommendedRegion = await resolveRequestedRegionAsync('auto', req.headers);

  const results = await Promise.all(
    Object.entries(PING_TARGETS).map(async ([region, { label, url }]) => {
      // Run 3 pings and take median for more stable results
      const pings = await Promise.all([
        measureLatency(url),
        measureLatency(url),
        measureLatency(url),
      ]);
      const valid = pings.filter((p): p is number => p !== null).sort((a, b) => a - b);
      const median = valid.length > 0 ? valid[Math.floor(valid.length / 2)] : null;

      return {
        region,
        label,
        latencyMs: median,
        reachable: valid.length > 0,
        flagUrl: getFlagUrlByRegion(region, 40),
      };
    })
  );

  return NextResponse.json({
    results,
    configuredRegions,
    recommendedRegion,
    timestamp: Date.now(),
  });
}
