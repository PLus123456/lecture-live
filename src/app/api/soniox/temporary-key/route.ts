import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { checkQuota } from '@/lib/quota';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  parseSonioxRegionPreference,
  resolveRequestedRegionAsync,
  resolveSonioxRuntimeConfigAsync,
} from '@/lib/soniox/env';

export async function POST(req: Request) {
  const rateLimited = await enforceRateLimit(req, {
    scope: 'soniox:temporary-key',
    limit: 30,
    windowMs: 60_000,
  });
  if (rateLimited) {
    return rateLimited;
  }

  // JWT 鉴权
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 配额检查
  const quotaOk = await checkQuota(user.id, 'transcription_minutes');
  if (!quotaOk) {
    return NextResponse.json({ error: 'Quota exceeded' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({})) as {
    region?: string;
    clientReferenceId?: string;
  };
  const requestedRegion = parseSonioxRegionPreference(body.region) ?? 'auto';
  const clientReferenceId =
    typeof body.clientReferenceId === 'string'
      ? body.clientReferenceId.trim().slice(0, 256)
      : undefined;
  const resolvedRegion = await resolveRequestedRegionAsync(requestedRegion, req.headers);
  const sonioxConfig = await resolveSonioxRuntimeConfigAsync({
    requestedRegion,
    headers: req.headers,
  });
  if (!sonioxConfig) {
    return NextResponse.json(
      { error: 'Soniox credentials not configured' },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(
      `${sonioxConfig.restBaseUrl}/v1/auth/temporary-api-key`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sonioxConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          usage_type: 'transcribe_websocket',
          expires_in_seconds: 60,
          client_reference_id: clientReferenceId || undefined,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      // 安全：仅记录状态码，避免完整错误响应中可能包含的敏感信息
      console.error(`Soniox API error: status=${response.status}`, errorText.slice(0, 200));
      return NextResponse.json(
        { error: 'Failed to get temporary key' },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json({
      ...data,
      ws_url: sonioxConfig.wsBaseUrl,
      ws_base_url: sonioxConfig.wsBaseUrl,
      rest_base_url: sonioxConfig.restBaseUrl,
      region: sonioxConfig.region,
      requested_region: requestedRegion,
      resolved_region: resolvedRegion,
    });
  } catch (error) {
    console.error('Temporary key error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
