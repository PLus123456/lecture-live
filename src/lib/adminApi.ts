import { NextResponse } from 'next/server';
import { verifyAuth, type UserPayload } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';

interface AdminAccessOptions {
  scope: string;
  limit?: number;
  windowMs?: number;
}

export async function requireAdminAccess(
  req: Request,
  options: AdminAccessOptions
): Promise<{
  user: UserPayload | null;
  response: NextResponse | null;
}> {
  const user = await verifyAuth(req);
  if (!user || user.role !== 'ADMIN') {
    return {
      user: null,
      response: NextResponse.json({ error: '权限不足' }, { status: 403 }),
    };
  }

  const rateLimited = await enforceRateLimit(req, {
    scope: options.scope,
    limit: options.limit ?? 60,
    windowMs: options.windowMs ?? 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) {
    return {
      user: null,
      response: rateLimited,
    };
  }

  return { user, response: null };
}
