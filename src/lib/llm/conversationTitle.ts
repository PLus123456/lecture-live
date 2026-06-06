import 'server-only';

import { callLLM } from '@/lib/llm/gateway';
import { logger, serializeError } from '@/lib/logger';

const titleLogger = logger.child({ component: 'conversation-title' });

const MAX_TITLE_LEN = 40;

/** 去掉 markdown 图片语法 ![alt](url)，标题不需要图片引用噪声 */
function stripImageMarkdown(text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').trim();
}

/**
 * 规整 LLM 返回的标题：取首行、去包裹引号、去首尾标点/空白、截断到 MAX_TITLE_LEN。
 * 规整后为空返回 null。
 */
export function sanitizeTitle(raw: string): string | null {
  let t = (raw ?? '').trim();
  if (!t) return null;
  t = t.split('\n')[0].trim();
  t = t.replace(/^["'“”『「]+|["'“”』」]+$/g, '').trim();
  t = t.replace(/[。.!！?？，,；;：:\s]+$/g, '').trim();
  if (!t) return null;
  if (t.length > MAX_TITLE_LEN) t = t.slice(0, MAX_TITLE_LEN).trim();
  return t || null;
}

/**
 * 用 KEYWORD_EXTRACTION 模型（便宜，标题不需强模型）给对话起一个简短标题，
 * 基于首条用户消息（可附首条助手回复）。失败返回 null（调用方保持 title=null，可重试）。
 */
export async function generateConversationTitle(input: {
  firstUserMessage: string;
  firstAssistantMessage?: string | null;
}): Promise<string | null> {
  const userMsg = stripImageMarkdown(input.firstUserMessage).slice(0, 500);
  if (!userMsg) return null;

  const system =
    '你是给对话起标题的助手。根据下面的对话开头，生成一个不超过 16 个字、概括主题的简短标题。' +
    '只返回标题本身：不要引号、不要前缀、不要结尾标点。';
  const assistant = input.firstAssistantMessage
    ? stripImageMarkdown(input.firstAssistantMessage).slice(0, 300)
    : '';
  const userPrompt = assistant
    ? `用户：${userMsg}\n\n助手：${assistant}`
    : `用户：${userMsg}`;

  try {
    const raw = await callLLM(system, userPrompt, {
      purpose: 'KEYWORD_EXTRACTION',
    });
    return sanitizeTitle(raw);
  } catch (err) {
    titleLogger.warn({ err: serializeError(err) }, '生成对话标题失败');
    return null;
  }
}
