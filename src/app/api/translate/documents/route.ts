import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { isPaymentBenefitAvailable } from '@/lib/payment/entitlementAdmission';
import { prisma } from '@/lib/prisma';
import { enforceApiRateLimit } from '@/lib/rateLimit';
import { getSiteSettings } from '@/lib/siteSettings';
import { resolveUserFeatureFlags, resolveUserTranslationModelId } from '@/lib/userRoles';
import { getModelById } from '@/lib/llm/gateway';
import {
  DocumentParserError,
  inspectPdfDocument,
} from '@/lib/documentParserProcess';
import { saveSourceFile, deleteTaskFiles } from '@/lib/translate/taskStorage';
import {
  TASK_VIEW_SELECT,
  toTaskView,
  quoteCents,
  sanitizeGlossary,
  sanitizeLangCode,
  sweepExpiredQuotes,
} from '@/lib/translate/taskApi';

export const runtime = 'nodejs';

/**
 * GET /api/translate/documents — 当前用户的翻译任务列表（新→旧，最多 50 条）。
 */
export async function GET(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rows = await prisma.translationTask.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: TASK_VIEW_SELECT,
  });
  return NextResponse.json({ tasks: rows.map(toTaskView) });
}

/**
 * POST /api/translate/documents — 上传 PDF → 读页数报价 → 建 QUOTED 任务。
 * multipart/form-data：file（PDF）+ sourceLang + targetLang + glossary?（JSON 字符串）。
 * 报价 30 分钟内确认（/confirm 扣费入队），超时懒清理。
 */
export async function POST(req: Request) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await isPaymentBenefitAvailable(user.id))) {
    return NextResponse.json(
      { error: '账户存在未处理的支付争议', code: 'payment_account_frozen' },
      { status: 403 }
    );
  }
  const rateLimited = await enforceApiRateLimit(req, {
    scope: 'translate:doc-upload',
    windowMs: 60_000,
    key: `user:${user.id}`,
  });
  if (rateLimited) return rateLimited;

  let taskId: string | null = null;
  try {
    const settings = await getSiteSettings();
    if (!settings.translation_doc_enabled) {
      return NextResponse.json({ error: '站点未开启文档翻译' }, { status: 403 });
    }
    const flags = await resolveUserFeatureFlags(user);
    if (!flags.allowDocTranslation) {
      return NextResponse.json({ error: '当前用户组未开通文档翻译' }, { status: 403 });
    }

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '缺少文件' }, { status: 400 });
    }
    const maxBytes = settings.translation_doc_max_mb * 1024 * 1024;
    if (file.size <= 0 || file.size > maxBytes) {
      return NextResponse.json(
        { error: `文件大小超限（≤${settings.translation_doc_max_mb}MB）`, code: 'file_too_large' },
        { status: 413 }
      );
    }
    const fileName = (file.name || 'document.pdf').slice(0, 180);
    const isPdf =
      file.type === 'application/pdf' || /\.pdf$/i.test(fileName);
    if (!isPdf) {
      return NextResponse.json({ error: '仅支持 PDF 文件' }, { status: 400 });
    }

    const sourceLang = sanitizeLangCode(form.get('sourceLang'), settings.default_source_lang || 'en');
    const targetLang = sanitizeLangCode(form.get('targetLang'), settings.default_target_lang || 'zh');
    let glossary: { src: string; dst: string }[] | null = null;
    const glossaryRaw = form.get('glossary');
    if (typeof glossaryRaw === 'string' && glossaryRaw) {
      try {
        glossary = sanitizeGlossary(JSON.parse(glossaryRaw));
      } catch {
        glossary = null;
      }
    }

    const data = Buffer.from(await file.arrayBuffer());
    // 魔数校验：PDF 头 %PDF-（防伪装扩展名）
    if (!data.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
      return NextResponse.json({ error: '不是有效的 PDF 文件' }, { status: 400 });
    }

    // 读页数（getInfo 只读元数据，不抽全文）
    let pageCount = 0;
    try {
      const info = await inspectPdfDocument(data, { signal: req.signal });
      pageCount = info.pages;
    } catch (error) {
      if (error instanceof DocumentParserError) {
        if (error.code === 'cancelled') {
          return NextResponse.json({ error: 'Request cancelled' }, { status: 499 });
        }
        if (error.code === 'input_limit' || error.code === 'archive_limit') {
          return NextResponse.json(
            { error: 'PDF 过大或过于复杂', code: 'document_too_complex' },
            { status: 413 }
          );
        }
        if (error.code === 'timeout') {
          return NextResponse.json(
            { error: 'PDF 解析超时', code: 'document_parse_timeout' },
            { status: 422 }
          );
        }
        if (error.code === 'busy' || error.code === 'worker_failed') {
          return NextResponse.json(
            { error: 'PDF 解析服务暂不可用', code: 'parser_unavailable' },
            { status: 503, headers: { 'Retry-After': '5' } }
          );
        }
      }
      return NextResponse.json({ error: 'PDF 解析失败（可能已加密或损坏）' }, { status: 400 });
    }
    if (!Number.isFinite(pageCount) || pageCount <= 0) {
      return NextResponse.json({ error: 'PDF 页数读取失败' }, { status: 400 });
    }
    if (pageCount > settings.translation_doc_max_pages) {
      return NextResponse.json(
        { error: `页数超限（≤${settings.translation_doc_max_pages} 页）`, code: 'too_many_pages' },
        { status: 413 }
      );
    }

    // 顺手清理本人超时未确认的旧报价
    await sweepExpiredQuotes(user.id).catch(() => undefined);

    // 模型快照：任务创建时定格（组绑定失效则空=全局默认，代理端点兜底再解析）
    let modelId: string | null = null;
    const groupModelId = await resolveUserTranslationModelId(user).catch(() => null);
    if (groupModelId) {
      const cfg = await getModelById(groupModelId).catch(() => null);
      if (cfg?.dbModelId === groupModelId && cfg.purpose === 'TRANSLATION') {
        modelId = groupModelId;
      }
    }

    const estimatedCents = quoteCents(pageCount, settings.translation_doc_price_cents_per_page);
    const task = await prisma.translationTask.create({
      data: {
        userId: user.id,
        fileName,
        fileBytes: data.length,
        pageCount,
        status: 'QUOTED',
        sourceLang,
        targetLang,
        modelId,
        glossaryJson: glossary ? JSON.stringify(glossary) : null,
        estimatedCents,
      },
      select: { id: true },
    });
    taskId = task.id;
    const sourcePath = await saveSourceFile(task.id, data);
    await prisma.translationTask.update({
      where: { id: task.id },
      data: { sourcePath },
    });

    const wallet = await prisma.user.findUnique({
      where: { id: user.id },
      select: { walletBalanceCents: true },
    });
    const full = await prisma.translationTask.findUnique({
      where: { id: task.id },
      select: TASK_VIEW_SELECT,
    });
    return NextResponse.json({
      task: full ? toTaskView(full) : null,
      walletBalanceCents: wallet?.walletBalanceCents ?? 0,
    });
  } catch (error) {
    // 建行后半途失败：清掉半成品（行 + 已落盘文件）
    if (taskId) {
      await prisma.translationTask.deleteMany({ where: { id: taskId } }).catch(() => undefined);
      await deleteTaskFiles(taskId).catch(() => undefined);
    }
    console.error('文档翻译上传失败:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
