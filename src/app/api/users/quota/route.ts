import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getQuotaSnapshot } from '@/lib/quota';
import { resolveUserFeatureFlags } from '@/lib/userRoles';

export async function GET(req: Request) {
  const payload = await verifyAuth(req);
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const quotas = await getQuotaSnapshot(payload.id);
  if (!quotas) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // 附上用户组能力开关（供前端隐藏未开通功能；服务端仍是权威门禁）
  const owner = await prisma.user.findUnique({
    where: { id: payload.id },
    select: { role: true, customGroupId: true },
  });
  const featureFlags = owner
    ? await resolveUserFeatureFlags(owner)
    : undefined;

  const response = NextResponse.json({ quotas: { ...quotas, featureFlags } });
  // 配额数据短时缓存，减少重复请求
  response.headers.set('Cache-Control', 'private, max-age=60');
  return response;
}
