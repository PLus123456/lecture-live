import { NextResponse } from 'next/server';

/**
 * GET /api/translation/supported-pairs
 * 返回本地翻译（Transformers.js）支持的语言对列表，
 * 前端可在用户选择语言时判断是否可用本地翻译模式。
 */

// Helsinki-NLP opus-mt 模型支持的语言对（与 localTranslator.ts 保持一致）
const SUPPORTED_PAIRS = [
  'en-zh',
  'zh-en',
  'en-ja',
  'en-ko',
  'en-fr',
  'en-de',
  'en-es',
  'de-en',
  'fr-en',
  'es-en',
  'ja-en',
];

export async function GET() {
  return NextResponse.json({
    pairs: SUPPORTED_PAIRS,
    count: SUPPORTED_PAIRS.length,
  });
}
