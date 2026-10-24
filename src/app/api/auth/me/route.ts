import { NextResponse } from 'next/server';
import { isAuthVerificationInfrastructureError, verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(req: Request) {
  let payload: Awaited<ReturnType<typeof verifyAuth>>;
  try {
    payload = await verifyAuth(req);
  } catch (error) {
    // 认证真源（DB）暂不可判定：503 而不是 401，前端不会因此登出并撤销仍有效的会话。
    if (isAuthVerificationInfrastructureError(error)) {
      return NextResponse.json(
        { error: 'Session verification unavailable' },
        { status: 503 }
      );
    }
    throw error;
  }
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.id },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      createdAt: true,
      emailVerifiedAt: true,
      transcriptionMinutesUsed: true,
      transcriptionMinutesLimit: true,
      storageHoursUsed: true,
      storageHoursLimit: true,
      allowedModels: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  return NextResponse.json({ user });
}
