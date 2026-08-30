import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { resolveRequestClientIp } from '@/lib/clientIp';
import { prisma } from '@/lib/prisma';

export type SecurityAuditOutcome =
  | 'ATTEMPTED'
  | 'SUCCESS'
  | 'FAILED'
  | 'PARTIAL'
  | 'DISPATCHED'
  | 'DENIED';

export interface SecurityAuditEvent {
  event: string;
  operator: {
    id: string;
    email?: string | null;
    displayName?: string | null;
    role?: string | null;
  };
  target: {
    type: string;
    id?: string | null;
    ownerId?: string | null;
    ids?: string[];
    [key: string]: unknown;
  };
  before?: unknown;
  after?: unknown;
  reason: string;
  outcome: SecurityAuditOutcome;
  metadata?: unknown;
  requestId?: string;
}

type SecurityAuditDb = Pick<Prisma.TransactionClient, 'auditLog'>;

const REQUEST_IDS = new WeakMap<Request, string>();
const REQUEST_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})?$/;
const EVENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const OUTCOMES = new Set<SecurityAuditOutcome>([
  'ATTEMPTED',
  'SUCCESS',
  'FAILED',
  'PARTIAL',
  'DISPATCHED',
  'DENIED',
]);

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_STRING_CODE_POINTS = 2_048;
const MAX_DETAIL_BYTES = 32_768;

const SENSITIVE_KEY_PARTS = new Set([
  'password',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'privatekey',
  'code',
  'verifier',
]);
const SAFE_SECRET_MARKER_KEYS = new Set([
  'changed',
  'configured',
  'present',
  'rotated',
]);

function isValidRequestId(value: string | null | undefined): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export function getSecurityAuditRequestId(req: Request): string {
  const existing = REQUEST_IDS.get(req);
  if (existing) return existing;

  // SEC-033: a browser/client can choose x-request-id freely. Treating it as the canonical
  // correlation key lets an attacker collide with or impersonate another audit trail. Generate the
  // ID inside the trusted process; an edge-provided ID may be recorded separately only after an
  // authenticated proxy protocol is introduced.
  const requestId = randomUUID();
  REQUEST_IDS.set(req, requestId);
  return requestId;
}

function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const compact = words.join('');

  if (words.some((word) => SENSITIVE_KEY_PARTS.has(word))) return true;
  if (words.includes('api') && words.includes('key')) return true;
  if (words.includes('private') && words.includes('key')) return true;

  return [...SENSITIVE_KEY_PARTS].some(
    (part) => compact === part || compact.startsWith(part) || compact.endsWith(part)
  );
}

function truncateString(value: string): string {
  const points = Array.from(value);
  if (points.length <= MAX_STRING_CODE_POINTS) return value;
  const marker = '…[TRUNCATED]';
  return points
    .slice(0, Math.max(0, MAX_STRING_CODE_POINTS - Array.from(marker).length))
    .join('') + marker;
}

function safeSecretMarker(value: unknown): boolean | Record<string, boolean> | null {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.length === 0 ||
    entries.some(
      ([key, item]) =>
        !SAFE_SECRET_MARKER_KEYS.has(key) || typeof item !== 'boolean'
    )
  ) {
    return null;
  }
  return Object.fromEntries(entries) as Record<string, boolean>;
}

function sanitizeValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>
): unknown {
  if (value === null) return null;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== 'object') return null;
  if (depth >= MAX_DEPTH) return '[TRUNCATED: max depth]';
  if (ancestors.has(value)) return '[CIRCULAR]';

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => sanitizeValue(item, depth + 1, ancestors));
      if (value.length > MAX_ARRAY_ITEMS) {
        output.push(`[TRUNCATED: ${value.length - MAX_ARRAY_ITEMS} items]`);
      }
      return output;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const output: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
      if (isSensitiveKey(key)) {
        // Preserve an explicit boolean-only change marker, never a credential value. This keeps
        // `passwordChanged: true` / `{ changed: true }` useful without weakening redaction.
        output[key] = safeSecretMarker(item) ?? REDACTED;
      } else {
        output[key] = sanitizeValue(item, depth + 1, ancestors);
      }
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      output.__truncated__ = `${entries.length - MAX_OBJECT_KEYS} keys`;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function sanitize(value: unknown): unknown {
  return sanitizeValue(value, 0, new WeakSet<object>());
}

function validateEvent(event: SecurityAuditEvent): void {
  if (
    typeof event.event !== 'string' ||
    event.event.length > 96 ||
    !EVENT_PATTERN.test(event.event)
  ) {
    throw new TypeError(
      'Security audit event must be a canonical lowercase slug using letters, numbers, dots, underscores, or hyphens'
    );
  }
  if (!event.operator || typeof event.operator.id !== 'string' || !event.operator.id) {
    throw new TypeError('Security audit operator.id is required');
  }
  if (!event.target || typeof event.target.type !== 'string' || !event.target.type) {
    throw new TypeError('Security audit target.type is required');
  }
  if (typeof event.reason !== 'string' || !event.reason.trim()) {
    throw new TypeError('Security audit reason is required');
  }
  if (!OUTCOMES.has(event.outcome)) {
    throw new TypeError('Invalid security audit outcome');
  }
  if (event.requestId !== undefined && !isValidRequestId(event.requestId)) {
    throw new TypeError('Invalid security audit requestId');
  }
}

function serializeDetail(detail: Record<string, unknown>): string {
  let serialized = JSON.stringify(detail);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_DETAIL_BYTES) {
    return serialized;
  }

  const bounded = {
    ...detail,
    target: {
      type: (detail.target as Record<string, unknown>)?.type ?? 'unknown',
      id: (detail.target as Record<string, unknown>)?.id ?? null,
      ownerId: (detail.target as Record<string, unknown>)?.ownerId ?? null,
      ids: Array.isArray((detail.target as Record<string, unknown>)?.ids)
        ? ((detail.target as Record<string, unknown>).ids as unknown[]).slice(0, 10)
        : undefined,
      __truncated__: 'audit detail size limit exceeded',
    },
    before: '[TRUNCATED: audit detail size limit exceeded]',
    after: '[TRUNCATED: audit detail size limit exceeded]',
    metadata: '[TRUNCATED: audit detail size limit exceeded]',
  };
  serialized = JSON.stringify(bounded);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DETAIL_BYTES) {
    const operator = detail.operator as Record<string, unknown> | undefined;
    const target = detail.target as Record<string, unknown> | undefined;
    serialized = JSON.stringify({
      version: detail.version,
      requestId: detail.requestId,
      operator: {
        id: truncateString(String(operator?.id ?? '')).slice(0, 256),
        role: truncateString(String(operator?.role ?? '')).slice(0, 64),
      },
      target: {
        type: truncateString(String(target?.type ?? 'unknown')).slice(0, 256),
        id: truncateString(String(target?.id ?? '')).slice(0, 256),
        __truncated__: 'audit detail size limit exceeded',
      },
      before: '[TRUNCATED: audit detail size limit exceeded]',
      after: '[TRUNCATED: audit detail size limit exceeded]',
      reason: truncateString(String(detail.reason ?? '')).slice(0, 512),
      outcome: detail.outcome,
      metadata: '[TRUNCATED: audit detail size limit exceeded]',
      method: detail.method,
      path: truncateString(String(detail.path ?? '')).slice(0, 512),
    });
  }
  return serialized;
}

export async function writeSecurityAudit(
  req: Request,
  event: SecurityAuditEvent,
  db?: SecurityAuditDb
): Promise<{ requestId: string; action: string }> {
  validateEvent(event);

  const requestId = getSecurityAuditRequestId(req);
  if (event.requestId !== undefined && event.requestId !== requestId) {
    throw new TypeError('Security audit requestId does not match this request');
  }

  const action = `admin.security.${event.event}`;
  const ip = resolveRequestClientIp(req);
  const operator = sanitize(event.operator) as Record<string, unknown>;
  const detail = serializeDetail({
    version: 1,
    requestId,
    operator,
    target: sanitize(event.target),
    before: sanitize(event.before),
    after: sanitize(event.after),
    reason: sanitize(event.reason),
    outcome: event.outcome,
    metadata: sanitize(event.metadata),
    method: truncateString(req.method),
    path: truncateString(new URL(req.url).pathname),
  });

  await (db?.auditLog ?? prisma.auditLog).create({
    data: {
      action,
      detail,
      userId: event.operator.id,
      userName:
        (operator.displayName as string | null | undefined) ??
        (operator.email as string | null | undefined) ??
        null,
      ip: ip === 'unknown' ? null : ip,
    },
  });

  return { requestId, action };
}
