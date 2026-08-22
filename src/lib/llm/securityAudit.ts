import 'server-only';

import type { UserPayload } from '@/lib/auth';
import { writeSecurityAudit } from '@/lib/securityAudit';

/**
 * Awaited adapter for SEC-034 rejection records.
 *
 * General activity logs are intentionally best-effort, but a rejected credential
 * retarget must be durably recorded before the route returns. The detail object is
 * produced by callers from redacted endpoint metadata only.
 */
export async function writeLlmSecurityAudit(
  req: Request,
  event: 'llm-provider.create-rejected' | 'llm-provider.update-rejected',
  input: {
    user: UserPayload;
    detail: Record<string, unknown>;
  }
): Promise<void> {
  const { providerId, reason, ...metadata } = input.detail;
  await writeSecurityAudit(req, {
    event,
    operator: {
      id: input.user.id,
      email: input.user.email,
      role: input.user.role,
    },
    target: {
      type: 'llm-provider',
      id: typeof providerId === 'string' ? providerId : null,
    },
    reason: typeof reason === 'string' ? reason : 'llm_provider_policy_rejected',
    outcome: 'DENIED',
    metadata,
  });
}
