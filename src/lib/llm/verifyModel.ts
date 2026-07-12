// 模型库「验证」：对登记的模型发一次最小请求，确认网关地址/密钥/模型标识可用。
// 只做连通性验证，不评估输出质量；结果写回 LlmRegistryModel.status。
import { decrypt } from '@/lib/crypto';

const VERIFY_TIMEOUT_MS = 20_000;

/** 截断上游错误，避免把整段响应（可能含敏感信息）落库/回显 */
function sanitizeVerifyError(text: string, maxLen = 300): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLen
    ? collapsed.slice(0, maxLen) + '...(truncated)'
    : collapsed;
}

export interface VerifyTarget {
  provider: {
    apiBase: string;
    apiKey: string; // 加密存储值，内部解密
    isAnthropic: boolean;
  };
  modelId: string;
  kind: string; // "TEXT" | "EMBEDDING"
}

export interface VerifyResult {
  ok: boolean;
  error: string | null;
}

/**
 * 发起一次最小化探测请求：
 *  - TEXT × Anthropic 原生：POST /v1/messages（max_tokens 给 16，部分模型拒绝过小值）
 *  - TEXT × OpenAI 兼容：POST /chat/completions
 *  - EMBEDDING：POST /embeddings（Anthropic 原生无 embeddings 端点，直接判失败）
 */
export async function verifyRegistryModel(
  target: VerifyTarget
): Promise<VerifyResult> {
  let apiKey: string;
  try {
    apiKey = decrypt(target.provider.apiKey);
  } catch {
    return { ok: false, error: 'API 密钥解密失败，请重新保存网关密钥' };
  }

  const { apiBase, isAnthropic } = target.provider;

  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;

  if (target.kind === 'EMBEDDING') {
    if (isAnthropic) {
      return {
        ok: false,
        error: 'Anthropic 原生 API 不提供 embeddings 端点，嵌入模型请配置 OpenAI 兼容网关',
      };
    }
    url = `${apiBase}/embeddings`;
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    body = { model: target.modelId, input: ['ping'] };
  } else if (isAnthropic) {
    url = `${apiBase}/v1/messages`;
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
    body = {
      model: target.modelId,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    };
  } else {
    url = `${apiBase}/chat/completions`;
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    body = {
      model: target.modelId,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: `HTTP ${res.status}: ${sanitizeVerifyError(text) || res.statusText}`,
      };
    }
    return { ok: true, error: null };
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'TimeoutError'
        ? `请求超时（${VERIFY_TIMEOUT_MS / 1000}s）`
        : err instanceof Error
          ? sanitizeVerifyError(err.message)
          : '未知错误';
    return { ok: false, error: message };
  }
}
