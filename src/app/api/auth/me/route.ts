import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(req: Request) {
  const payload = await verifyAuth(req);
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
