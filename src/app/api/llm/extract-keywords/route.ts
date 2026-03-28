import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { callLLM } from '@/lib/llm/gateway';
import { buildKeywordExtractionPrompt } from '@/lib/llm/prompts';
import { extractTextFromFile } from '@/lib/fileParser';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  LLMResponseError,
  parseKeywordExtractionResult,
} from '@/lib/llm/security';

export async function POST(req: Request) {
  const rateLimited = await enforceRateLimit(req, {
    scope: 'llm:extract-keywords',
    limit: 20,
    windowMs: 60_000,
  });
  if (rateLimited) {
    return rateLimited;
  }

  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const textInput = formData.get('text') as string | null;
    const existingKeywords = formData.get('existingKeywords') as string | null;

    let sourceText = '';

    if (file) {
      // 安全检查：文件类型白名单
      const allowedTypes = [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
      ];
      if (!allowedTypes.includes(file.type)) {
        return NextResponse.json(
          { error: 'Unsupported file type' },
          { status: 400 }
        );
      }

      // 文件大小限制 (50MB)
      if (file.size > 50 * 1024 * 1024) {
        return NextResponse.json(
          { error: 'File too large (max 50MB)' },
          { status: 400 }
        );
      }

      sourceText = await extractTextFromFile(file);
    } else if (textInput) {
      sourceText = textInput;
    } else {
      return NextResponse.json(
        { error: 'No input provided' },
        { status: 400 }
      );
    }

    const system = buildKeywordExtractionPrompt(existingKeywords ?? undefined);
    const result = await callLLM(
      system,
      `Extract keywords from:\n\n${sourceText.slice(0, 8000)}`,
      { purpose: 'KEYWORD_EXTRACTION' }
    );

    const keywords = parseKeywordExtractionResult(result);

    return NextResponse.json({ keywords });
  } catch (error) {
    if (error instanceof LLMResponseError) {
      return NextResponse.json(
        { error: 'Invalid LLM response format' },
        { status: 502 }
      );
    }

    console.error('Extract keywords error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
