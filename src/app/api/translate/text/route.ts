import { NextResponse } from 'next/server';
import type { LlmPurpose } from '@/types/llm';
import { verifyAuth } from '@/lib/auth';
import { callLLMWithHistoryStream, type LLMStreamEvent } from '@/lib/llm/gateway';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import { LLMAccessError, resolveAuthorizedLlmSelection } from '@/lib/llm/access';
import { resolveUserTranslationModelId } from '@/lib/userRoles';
import { resolveGroupBoundModel } from '@/lib/llm/summaryModel';
import { isTranslationModelAllowed } from '@/lib/translate/modelAccess';
import { getSiteSettings } from '@/lib/siteSettings';
import { spendWalletCents, WalletError } from '@/lib/wallet';
import { isBillingExempt } from '@/lib/billing';
import {
  LLMValidationError,
  readOptionalIdentifier,
  readOptionalText,
  readRequiredText,
} from '@/lib/llm/security';
import {
  buildTextTranslationPrompt,
  consumeDailyTextQuota,
  releaseDailyTextQuota,
} from '@/lib/translate/textTranslation';

/** 单次句子翻译输入上限（字符）。Google Translate 同级：5k；给到 10k 容纳整段摘录 */
const MAX_TEXT_LENGTH = 10_000;

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * POST /api/translate/text — 句子翻译（SSE 流式）。
 * body: { text, sourceLang?='auto', targetLang, modelId? }
 * 门禁链：站点开关 → 组能力 allowTextTranslation → 计费（free=每日额度 / per_char=钱包扣分）→
 * 模型解析（用户显式选择（须在 TRANSLATION 路由行且 allowedModels 内）> 组绑定 > 全局默认）。
 * SSE 事件：text{delta} / usage{inputTokens,outputTokens} / done{charged} / error{message}
 */
export async function POST(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rateLimited = await enforceApiRateLimit(req, {
    scope: 'translate:text',
    windowMs: 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) return rateLimited;

  let quotaConsumed = false;
  try {
    const settings = await getSiteSettings();
    if (!settings.translation_text_enabled) {
      return NextResponse.json({ error: '站点未开启句子翻译' }, { status: 403 });
    }

    const body = await req.json();
    const text = readRequiredText(body.text, 'text', MAX_TEXT_LENGTH);
    const sourceLang =
      readOptionalText(body.sourceLang, 'sourceLang', 32) || 'auto';
    const targetLang = readRequiredText(body.targetLang, 'targetLang', 32);
    const requestedModelId = readOptionalIdentifier(body.modelId, 'modelId', 128);

    // 组能力门禁（组配置为唯一真源；identifier 传 undefined，翻译模型另行解析）
    const selection = await resolveAuthorizedLlmSelection(user.id, undefined, {
      enforceDefaultModelAccess: false,
    });
    if (!selection.featureFlags.allowTextTranslation) {
      return NextResponse.json(
        { error: '当前用户组未开通句子翻译' },
        { status: 403 }
      );
    }

    // L21：模型解析与鉴权必须排在计费**之前**。原顺序是「先扣钱再鉴权」，per_char 模式下
    // 组绑定模型不在 allowedModels 时必现：/api/translate/models 会把组绑定模型当默认项
    // 下发给前端（管理员决策可越过 allowedModels），前端把它当 modelId 回传，这里却按
    // allowedModels 判 403 —— 钱已经扣了。再叠加自动翻译 800ms 防抖，用户每敲一次键盘
    // 就被扣一次、一次译文也拿不到。
    //
    // 模型优先级：用户显式选择（须挂 TRANSLATION 用途；allowedModels 门禁，组绑定模型豁免）>
    // 组绑定翻译模型（管理员决策，可越过 allowedModels）> 全局 TRANSLATION 默认
    const groupModelId = await resolveUserTranslationModelId(selection.user).catch(
      () => null
    );
    let routing: { modelId: string } | { purpose: LlmPurpose } = {
      purpose: 'TRANSLATION',
    };
    if (requestedModelId) {
      // 门禁口径见 isTranslationModelAllowed（与文档翻译共用；组绑定模型豁免 allowedModels）
      const accessOk = await isTranslationModelAllowed(
        selection.user,
        requestedModelId,
        groupModelId
      );
      if (!accessOk) {
        return NextResponse.json(
          { error: '所选模型不可用或未授权' },
          { status: 403 }
        );
      }
      routing = { modelId: requestedModelId };
    } else {
      routing = (await resolveGroupBoundModel(groupModelId, 'TRANSLATION')).routing;
    }

    // 计费：free=每日额度（请求时预消耗，彻底失败回滚）；per_char=钱包按千字符扣分。
    // ADMIN 两条线都豁免（role 取自 DB，见 isBillingExempt 的调用约定）：与配额哨兵同口径，
    // 管理员既不扣钱包也不占每日免费次数。
    let chargedCents = 0;
    const billingExempt = isBillingExempt(selection.user.role);
    if (billingExempt) {
      // 不计费：既不扣钱包也不消耗每日额度
    } else if (settings.translation_text_billing_mode === 'per_char') {
      const cents =
        Math.ceil(text.length / 1000) *
        Math.max(0, settings.translation_text_price_cents_per_kchar);
      if (cents > 0) {
        try {
          await spendWalletCents({
            userId: user.id,
            amountCents: cents,
            type: 'translation',
            note: `text-translate:${text.length}chars`,
          });
          chargedCents = cents;
        } catch (err) {
          if (err instanceof WalletError && err.code === 'insufficient_balance') {
            return NextResponse.json(
              { error: '钱包余额不足', code: 'insufficient_balance' },
              { status: 402 }
            );
          }
          throw err;
        }
      }
    } else {
      const quota = await consumeDailyTextQuota(
        user.id,
        settings.translation_text_daily_free_limit
      );
      if (!quota.allowed) {
        return NextResponse.json(
          {
            error: '今日免费翻译次数已用完',
            code: 'daily_limit_reached',
            limit: quota.limit,
          },
          { status: 429 }
        );
      }
      quotaConsumed = quota.limit > 0;
    }

    const { system, user: userMsg } = buildTextTranslationPrompt(
      text,
      sourceLang,
      targetLang
    );

    const encoder = new TextEncoder();
    const upstreamAbort = new AbortController();
    const consumedQuota = quotaConsumed;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(sseFrame(event, data)));
        };
        let emitted = false;
        try {
          const result = await callLLMWithHistoryStream(
            system,
            [{ role: 'user', content: userMsg }],
            { ...routing, signal: upstreamAbort.signal },
            (ev: LLMStreamEvent) => {
              // 翻译不外发 thinking（用户只要译文）；text 增量直出
              if (ev.type === 'text' && ev.delta) {
                emitted = true;
                send('text', { delta: ev.delta });
              } else if (ev.type === 'usage') {
                send('usage', {
                  inputTokens: ev.inputTokens,
                  outputTokens: ev.outputTokens,
                });
              }
            }
          );
          if (!emitted && result.text) {
            // 个别 provider 不吐增量只回全文：兜底整段发出
            send('text', { delta: result.text });
          }
          send('done', { charged: chargedCents });
        } catch (err) {
          // 一字未出就失败 → 退回本次免费额度（扣了钱的 per_char 不自动退：已产生上游用量的
          // 概率高，且金额为分级小额；彻底失败可由用户重试，争议走 admin 台账调整）
          if (!emitted && consumedQuota) {
            await releaseDailyTextQuota(user.id).catch(() => {});
          }
          const message =
            err instanceof Error ? err.message : '翻译失败，请稍后重试';
          try {
            send('error', { message });
          } catch {
            // 客户端已断开，忽略
          }
        } finally {
          try {
            controller.close();
          } catch {
            // 已关闭
          }
        }
      },
      cancel() {
        upstreamAbort.abort();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    if (quotaConsumed) {
      await releaseDailyTextQuota(user.id).catch(() => {});
    }
    if (error instanceof LLMValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof LLMAccessError) {
      const status = error.message === 'User not found' ? 404 : 403;
      return NextResponse.json({ error: error.message }, { status });
    }
    if (error instanceof WalletError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('句子翻译失败:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
