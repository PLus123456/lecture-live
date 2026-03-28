import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getQuotaSnapshot } from '@/lib/quota';

export async function GET(req: Request) {
  const payload = await verifyAuth(req);
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const quotas = await getQuotaSnapshot(payload.id);
  if (!quotas) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const response = NextResponse.json({ quotas });
  // 配额数据短时缓存，减少重复请求
  response.headers.set('Cache-Control', 'private, max-age=60');
  return response;
}
