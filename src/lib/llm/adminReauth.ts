import 'server-only';

import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';

export const LLM_RECENT_AUTH_REQUIRED = 'RECENT_AUTH_REQUIRED';

export type LlmAdminReauthResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'rate_limited' | 'missing_or_invalid';
      response: NextResponse;
    };

/**
 * Inline step-up authentication for a high-risk LLM provider mutation.
 *
 * Keeping the password proof in the same request is deliberately narrower than
 * adding a reusable bearer capability: it cannot be replayed from browser state,
 * needs no schema/session migration, and proves knowledge of the current password
 * immediately before the endpoint/key binding is changed.
 */
export async function requireLlmAdminCurrentPassword(
  req: Request,
  userId: string,
  suppliedPassword: unknown
): Promise<LlmAdminReauthResult> {
  const rateLimited = await enforceRateLimit(req, {
    scope: 'admin:reauth:llm-provider',
    limit: 5,
    windowMs: 10 * 60_000,
    key: `user:${userId}`,
  });
  if (rateLimited) {
    return { ok: false, reason: 'rate_limited', response: rateLimited };
  }

  // Do not trim: leading/trailing spaces may be part of a legitimate password.
  // Bound the value before bcrypt to avoid accepting an unreasonably large field.
  if (
    typeof suppliedPassword !== 'string' ||
    suppliedPassword.length === 0 ||
    suppliedPassword.length > 512
  ) {
    return {
      ok: false,
      reason: 'missing_or_invalid',
      response: NextResponse.json(
        {
          error: '需要重新验证当前管理员密码',
          code: LLM_RECENT_AUTH_REQUIRED,
        },
        { status: 403 }
      ),
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  const matches = user
    ? await bcrypt.compare(suppliedPassword, user.passwordHash)
    : false;
  if (!matches) {
    return {
      ok: false,
      reason: 'missing_or_invalid',
      response: NextResponse.json(
        {
          error: '需要重新验证当前管理员密码',
          code: LLM_RECENT_AUTH_REQUIRED,
        },
        { status: 403 }
      ),
    };
  }

  return { ok: true };
}
