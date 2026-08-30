import { NextResponse } from 'next/server';
import { getCallbackPaymentProvider } from '@/lib/payment';
import { isPaymentProviderName, defaultCallbackAck } from '@/lib/payment/types';
import { handlePaymentReversal } from '@/lib/payment/refundHandling';
import { creditPaidOrder } from '@/lib/wallet';
import { getSiteSettings } from '@/lib/siteSettings';
import { logSystemEvent } from '@/lib/auditLog';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveRequestClientIp } from '@/lib/clientIp';
import {
  claimWebhookEvent,
  linkPaymentProviderObjects,
  markWebhookEventFailed,
  markWebhookEventProcessed,
  openPaymentReviewCase,
  persistVerifiedWebhookEvent,
  resolvePaymentOrderReference,
  settleStripePendingReversal,
  type PersistedWebhookEvent,
} from '@/lib/payment/webhookInbox';

/**
 * 支付渠道异步通知回调（公开端点，中间件放行）。鉴权由 provider.verifyCallback 的验签承担。
 *  - POST：真实网关服务端到服务端通知 → 验签 → 幂等到账 → 回网关要求的 ACK。
 *  - GET：沙箱确认页跳转（浏览器）→ 验签 → 到账 → 重定向回 returnUrl?recharge=success|cancel。
 */

/** 三家网关的通知都是小报文（最大的微信密文也就几 KB）；64KB 之上一定不是真通知。 */
const MAX_CALLBACK_BODY_BYTES = 64 * 1024;

/**
 * 验签失败审计的去重窗口（P6-2）。这个端点未认证可达，原实现每个请求都往 AuditLog
 * INSERT 一行、fire-and-forget 无节流 —— 单靠刷这个端点就能把审计表撑爆并淹没真信号。
 * 同一 (渠道, IP) 一分钟内只记一条。
 */
const VERIFY_FAILED_LOG_WINDOW_MS = 60_000;
const verifyFailedSeen = new Map<string, number>();

function shouldLogVerifyFailure(provider: string, ip: string): boolean {
  const now = Date.now();
  if (verifyFailedSeen.size > 500) {
    for (const [k, at] of verifyFailedSeen) {
      if (now - at > VERIFY_FAILED_LOG_WINDOW_MS) verifyFailedSeen.delete(k);
    }
  }
  const key = `${provider}:${ip}`;
  const last = verifyFailedSeen.get(key);
  if (last && now - last < VERIFY_FAILED_LOG_WINDOW_MS) return false;
  verifyFailedSeen.set(key, now);
  return true;
}

async function handle(req: Request, providerName: string, isBrowserGet: boolean) {
  if (!isPaymentProviderName(providerName)) {
    return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
  }

  // 验签前先挡住明显不是通知的大报文：Next 的 32MB 限制是**截断**不是拒绝，
  // 而验签天然要求先读完整 body，不设上界等于让未认证请求随意占内存（P6-2）。
  const declaredLength = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CALLBACK_BODY_BYTES) {
    return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  }

  // 按 IP 限流（P6-2）：此前整个端点零限流，而每个请求要付「无缓存的 settings 查询 +
  // 一行 AuditLog 写入」两笔 DB 开销。429 对网关是非 2xx → 它们会自行重投，不丢通知。
  const limited = await enforceRateLimit(req, {
    scope: 'wallet:callback',
    limit: 120,
    windowMs: 60_000,
  });
  if (limited) return limited;

  // P3-11：回调按**凭据齐全**装配 provider，忽略 enabled 开关。管理员在用户付款之后停用渠道
  // （或关总开关）不该把在途通知打成 400 —— 网关重试到耗尽即放弃，钱收了、订单永久 pending。
  const provider = await getCallbackPaymentProvider(providerName);
  if (!provider) {
    return NextResponse.json({ error: 'channel unavailable' }, { status: 400 });
  }

  const rawBody = isBrowserGet ? '' : await req.text();
  if (rawBody.length > MAX_CALLBACK_BODY_BYTES) {
    return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  }

  const result = await provider.verifyCallback(req, rawBody);
  if (!result) {
    // 验签失败/无法解析：拒绝，绝不到账。
    if (shouldLogVerifyFailure(providerName, resolveRequestClientIp(req))) {
      logSystemEvent('recharge.callback.verify_failed', `provider=${providerName}`);
    }
    if (isBrowserGet) {
      return redirectBack(await returnBase(), 'failed');
    }
    return ackResponse(provider, false, 400);
  }

  // SEC-026: a verified delivery must be durable before any success ACK. The stored payload is
  // a <=16KiB normalized projection; raw request bodies/signatures are intentionally excluded.
  let inbox: PersistedWebhookEvent;
  try {
    inbox = await persistVerifiedWebhookEvent({
      provider: providerName,
      result,
      rawFingerprintSource: isBrowserGet ? req.url : rawBody,
    });
  } catch (err) {
    console.error('支付回调 durable inbox 写入失败:', err);
    if (isBrowserGet) return redirectBack(await returnBase(), 'failed');
    return ackResponse(provider, false, 500);
  }
  if (inbox.status === 'processed') {
    if (isBrowserGet) {
      return redirectBack(await returnBase(), result.paid ? 'success' : 'cancel');
    }
    return ackResponse(provider, true, 200);
  }
  if (!(await claimWebhookEvent(inbox))) {
    // Another worker owns this event (or its prior claim has not reached the stale threshold).
    // Returning failure is deliberate: ACK success before the owner commits would lose the event
    // if that worker crashes.
    if (isBrowserGet) return redirectBack(await returnBase(), 'failed');
    return ackResponse(provider, false, 500);
  }

  const providerMode = result.providerMode ?? (providerName === 'sandbox' ? 'sandbox' : 'unknown');
  const providerAccount = result.providerAccount?.trim() || 'default';
  try {
    const orderRef = await resolvePaymentOrderReference({
      provider: providerName,
      providerMode,
      providerAccount,
      outTradeNo: result.outTradeNo,
      objectRefs: result.objectRefs,
    });
    if (orderRef) {
      await linkPaymentProviderObjects({
        provider: providerName,
        providerMode,
        providerAccount,
        orderId: orderRef.id,
        eventId: inbox.eventId,
        objectRefs: result.objectRefs,
      });
    }

    const stripeLifecycleRef =
      providerName === 'stripe'
        ? result.objectRefs?.find(
            (ref) => ref.objectType === 'refund' || ref.objectType === 'dispute'
          )
        : undefined;

    // A signed won-dispute / failed-or-canceled-refund update may release only the hold created
    // for that exact dp_/re_ object. Never let the generic harmless ACK path bypass correlation.
    if (result.reversalState === 'reinstated') {
      if (!orderRef || !stripeLifecycleRef) {
        await openPaymentReviewCase({
          reason: 'unresolved_reversal_resolution',
          event: inbox,
          orderId: orderRef?.id,
          userId: orderRef?.userId,
          detail: {
            provider: providerName,
            eventType: inbox.eventType,
            reversalState: result.reversalState,
            objectRefs: result.objectRefs ?? [],
          },
        });
        await markWebhookEventFailed(
          inbox.id,
          'terminal reversal resolution did not map to its source object',
          'review'
        );
        if (isBrowserGet) return redirectBack(await returnBase(), 'failed');
        return ackResponse(provider, false, 500);
      }
      await settleStripePendingReversal({
        orderId: orderRef.id,
        userId: orderRef.userId,
        currentEventId: inbox.id,
        providerMode,
        providerAccount,
        objectType: stripeLifecycleRef.objectType as 'refund' | 'dispute',
        objectId: stripeLifecycleRef.objectId,
        terminalState: 'reinstated',
      });
      if (isBrowserGet) return redirectBack(await returnBase(), 'cancel');
      return ackResponse(provider, true, 200);
    }

    // 验签通过但无需到账的通知也必须先完成 durable inbox + typed object mapping。
    if (result.acknowledged && !result.reversal && !result.paid) {
      await markWebhookEventProcessed(inbox.id);
      if (isBrowserGet) return redirectBack(await returnBase(), 'cancel');
      return ackResponse(provider, true, 200);
    }

    // Future/unknown signed event types are not automatically harmless. Preserve them in the
    // durable review queue and return failure so the provider retries while an operator decides
    // whether the new type can grant/revoke value. Provider adapters set `acknowledged` only from
    // narrow, explicit no-op allowlists.
    if (!result.paid && !result.reversal) {
      await openPaymentReviewCase({
        reason: 'unknown_payment_event',
        event: inbox,
        orderId: orderRef?.id,
        userId: orderRef?.userId,
        detail: {
          provider: providerName,
          providerMode,
          providerAccount,
          eventType: inbox.eventType,
          objectRefs: result.objectRefs ?? [],
        },
      });
      await markWebhookEventFailed(
        inbox.id,
        'signed payment event is not in the harmless no-op allowlist',
        'review'
      );
      logSystemEvent(
        'recharge.webhook.unknown_event',
        `provider=${providerName} eventId=${inbox.eventId} type=${inbox.eventType}`
      );
      if (isBrowserGet) return redirectBack(await returnBase(), 'failed');
      return ackResponse(provider, false, 500);
    }

    // Refund/dispute events without an exact provider-scoped mapping remain in review and return
    // failure so the gateway retries. This replaces the old warn+200 silent data loss.
    if (result.reversal) {
      if (!orderRef) {
        await openPaymentReviewCase({
          reason: 'unresolved_reversal_object',
          event: inbox,
          detail: {
            provider: providerName,
            providerMode,
            providerAccount,
            eventType: inbox.eventType,
            objectRefs: result.objectRefs ?? [],
          },
        });
        await markWebhookEventFailed(inbox.id, 'reversal did not map to a local order', 'review');
        logSystemEvent(
          'recharge.reversal.unresolved',
          `provider=${providerName} eventId=${inbox.eventId} type=${inbox.eventType}`
        );
        if (isBrowserGet) return redirectBack(await returnBase(), 'failed');
        return ackResponse(provider, false, 500);
      }
      const reversal = await handlePaymentReversal({
        outTradeNo: orderRef.outTradeNo,
        provider: providerName,
        rawStatus: result.rawStatus,
        providerRef: result.providerRef,
        reversalAmountCents: result.reversalAmountCents,
        fullReversal: result.fullReversal,
        reversalState: result.reversalState,
        providerMode,
        providerAccount,
        sourceObjectType: stripeLifecycleRef?.objectType as
          | 'refund'
          | 'dispute'
          | undefined,
        sourceObjectId: stripeLifecycleRef?.objectId,
        occurredAt: result.occurredAt,
        currency: result.currency,
      });
      if (
        stripeLifecycleRef &&
        result.reversalState === 'withdrawn' &&
        (reversal.handled ||
          reversal.outcome === 'review' ||
          reversal.outcome === 'partial_review')
      ) {
        await settleStripePendingReversal({
          orderId: orderRef.id,
          userId: orderRef.userId,
          currentEventId: inbox.id,
          providerMode,
          providerAccount,
          objectType: stripeLifecycleRef.objectType as 'refund' | 'dispute',
          objectId: stripeLifecycleRef.objectId,
          terminalState: 'withdrawn',
        });
      }
      if (reversal.handled) {
        await markWebhookEventProcessed(inbox.id);
      } else if (reversal.outcome === 'review' || reversal.outcome === 'partial_review') {
        await openPaymentReviewCase({
          reason:
            result.reversalState === 'pending'
              ? 'stripe_pending_reversal'
              : reversal.outcome === 'partial_review'
              ? 'partial_reversal_unsupported'
              : 'legacy_reversal_source_unresolved',
          event: inbox,
          orderId: orderRef.id,
          userId: orderRef.userId,
          detail: {
            provider: providerName,
            eventType: inbox.eventType,
            reversalAmountCents: result.reversalAmountCents ?? null,
            fullReversal: result.fullReversal ?? null,
            reversalState: result.reversalState ?? null,
            currency: result.currency ?? null,
          },
        });
        await markWebhookEventFailed(
          inbox.id,
          reversal.outcome === 'partial_review'
            ? 'partial reversal requires administrator disposition'
            : 'legacy reversal requires review',
          'review'
        );
      } else {
        await markWebhookEventFailed(inbox.id, `reversal outcome=${reversal.outcome}`);
      }
      if (isBrowserGet) return redirectBack(await returnBase(), 'cancel');
      return ackResponse(provider, reversal.handled, reversal.handled ? 200 : 500);
    }

    let credit: Awaited<ReturnType<typeof creditPaidOrder>> | null = null;
    if (result.paid) {
      if (!orderRef) {
        await openPaymentReviewCase({
          reason: 'unresolved_paid_object',
          event: inbox,
          detail: { provider: providerName, eventType: inbox.eventType },
        });
        await markWebhookEventFailed(inbox.id, 'paid event did not map to a local order', 'review');
        if (isBrowserGet) return redirectBack(await returnBase(), 'failed');
        return ackResponse(provider, false, 500);
      }
      // 传入回调渠道名（H3 绑定订单 provider）与网关实付金额（M1/M2 对账）。
      credit = await creditPaidOrder(
        orderRef.outTradeNo,
        result.providerRef,
        providerName,
        result.amountCents,
        result.currency,
        result.occurredAt
      );
      if (credit.ok) {
        await markWebhookEventProcessed(inbox.id);
      } else if (credit.acknowledged) {
        await openPaymentReviewCase({
          reason: credit.status === 'late_paid' ? 'payment_after_expiry' : 'payment_review',
          event: inbox,
          orderId: orderRef.id,
          userId: orderRef.userId,
          detail: { status: credit.status ?? null },
        });
        await markWebhookEventProcessed(inbox.id);
      } else {
        await openPaymentReviewCase({
          reason: 'payment_credit_rejected',
          event: inbox,
          orderId: orderRef.id,
          userId: orderRef.userId,
          detail: { status: credit.status ?? null },
        });
        await markWebhookEventFailed(inbox.id, 'payment credit rejected', 'review');
      }
    }

    if (isBrowserGet) {
      const base = credit?.returnUrl || (await returnBase());
      return redirectBack(base, result.paid && (credit?.ok ?? false) ? 'success' : 'cancel');
    }

    // 真实网关：到账成功（或 durable no-op）才回成功 ACK，否则回失败让网关重试。
    const ok = credit?.ok === true || credit?.acknowledged === true;
    return ackResponse(provider, ok, ok ? 200 : 500);
  } catch (err) {
    await markWebhookEventFailed(inbox.id, err).catch(() => undefined);
    console.error('支付回调处理失败:', err);
    if (isBrowserGet) return redirectBack(await returnBase(), 'failed');
    return ackResponse(provider, false, 500);
  }
}

/**
 * 按网关要求组装 ACK。各家判据不同，别把状态码一刀切：
 *  - 支付宝看**响应体**（"success"/"fail"），状态码恒 200 是对的；
 *  - 微信与 Stripe 看**状态码**，失败必须回 5xx 才会重投（P3-3）。
 */
function ackResponse(
  provider: { callbackAck?: (ok: boolean) => { body: string; contentType: string; status?: number } },
  ok: boolean,
  fallbackStatus: number
) {
  const ack = (provider.callbackAck ?? defaultCallbackAck)(ok);
  return new NextResponse(ack.body, {
    status: ack.status ?? fallbackStatus,
    headers: { 'Content-Type': ack.contentType },
  });
}

async function returnBase(): Promise<string> {
  const site = await getSiteSettings();
  return `${(site.site_url || 'http://localhost:3000').replace(/\/+$/, '')}/home`;
}

function redirectBack(returnUrl: string, status: 'success' | 'cancel' | 'failed') {
  const sep = returnUrl.includes('?') ? '&' : '?';
  return NextResponse.redirect(`${returnUrl}${sep}recharge=${status}`);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  return handle(req, provider, false);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  return handle(req, provider, true);
}
