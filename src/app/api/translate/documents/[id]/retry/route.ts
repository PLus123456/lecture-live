import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { spendWalletCents, WalletError } from '@/lib/wallet';
import { getSiteSettings } from '@/lib/siteSettings';
import { resolveUserFeatureFlags } from '@/lib/userRoles';
import { TASK_VIEW_SELECT, toTaskView } from '@/lib/translate/taskApi';
import { readSourceFile } from '@/lib/translate/taskStorage';
import {
  enqueueDocTranslate,
  refundTaskCharge,
  runDocTranslateTick,
} from '@/lib/translate/translateProcessor';

export const runtime = 'nodejs';

/**
 * POST /api/translate/documents/[id]/retry — 终态失败/已取消任务的重新发起。
 * 语义 = 重新扣费 + 复位进重译队列（复用原文件与报价；失败时已退款，重试即再付费）。
 * 幂等：FAILED|CANCELED→PENDING 的条件 CAS 唯一赢家；refundedAt 一并复位让下次失败仍能退。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;

  try {
    const settings = await getSiteSettings();
    if (!settings.translation_doc_enabled) {
      return NextResponse.json({ error: '站点未开启文档翻译' }, { status: 403 });
    }
    const flags = await resolveUserFeatureFlags(user);
    if (!flags.allowDocTranslation) {
      return NextResponse.json({ error: '当前用户组未开通文档翻译' }, { status: 403 });
    }

    const task = await prisma.translationTask.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true, estimatedCents: true },
    });
    if (!task || task.userId !== user.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (task.status !== 'FAILED' && task.status !== 'CANCELED') {
      return NextResponse.json({ error: '仅失败/已取消任务可重试' }, { status: 409 });
    }
    const source = await readSourceFile(task.id);
    if (!source) {
      return NextResponse.json({ error: '源文件已清理，请重新上传' }, { status: 410 });
    }

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.translationTask.updateMany({
        where: { id: task.id, status: { in: ['FAILED', 'CANCELED'] } },
        data: {
          status: 'PENDING',
          progress: 0,
          errorMessage: null,
          refundedAt: null,
          chargedCents: task.estimatedCents,
          monoPath: null,
          dualPath: null,
          completedAt: null,
          jobQueueId: null, // 旧调度行已终态，重试建新行（attempt 计数重置）
        },
      });
      if (claimed.count === 0) {
        throw new WalletError('任务状态已变化', 'bad_request');
      }
      if (task.estimatedCents > 0) {
        await spendWalletCents(
          {
            userId: user.id,
            amountCents: task.estimatedCents,
            type: 'translation',
            note: `doc-translate-retry:${task.id}`,
          },
          tx
        );
      }
    });

    const jobId = await enqueueDocTranslate(task.id, user.id);
    if (!jobId) {
      await prisma.translationTask.updateMany({
        where: { id: task.id, status: 'PENDING' },
        data: { status: 'FAILED', errorMessage: '任务入队失败，请重试' },
      });
      await refundTaskCharge(task.id, '入队失败退款');
      return NextResponse.json({ error: '任务入队失败，费用已退回' }, { status: 500 });
    }
    void runDocTranslateTick();

    const full = await prisma.translationTask.findUnique({
      where: { id: task.id },
      select: TASK_VIEW_SELECT,
    });
    return NextResponse.json({ task: full ? toTaskView(full) : null });
  } catch (error) {
    if (error instanceof WalletError) {
      if (error.code === 'insufficient_balance') {
        return NextResponse.json(
          { error: '钱包余额不足', code: 'insufficient_balance' },
          { status: 402 }
        );
      }
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error('重试文档翻译失败:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
