import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { spendWalletCents, WalletError } from '@/lib/wallet';
import { getSiteSettings } from '@/lib/siteSettings';
import { resolveUserFeatureFlags } from '@/lib/userRoles';
import { TASK_VIEW_SELECT, toTaskView } from '@/lib/translate/taskApi';
import {
  enqueueDocTranslate,
  refundTaskCharge,
  runDocTranslateTick,
} from '@/lib/translate/translateProcessor';

export const runtime = 'nodejs';

/**
 * POST /api/translate/documents/[id]/confirm — 确认报价：原子扣费 + 入队。
 * 幂等/防双击：事务内先做 QUOTED→PENDING 的条件 CAS（唯一赢家），再扣钱包分
 * （spendWalletCents 的原子守卫防超扣）；扣费失败整个事务回滚，任务留在 QUOTED。
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
      select: {
        id: true,
        userId: true,
        status: true,
        estimatedCents: true,
        updatedAt: true,
      },
    });
    if (!task || task.userId !== user.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (task.status !== 'QUOTED') {
      return NextResponse.json(
        { error: '任务已确认或已失效', code: 'not_quoted' },
        { status: 409 }
      );
    }

    const pendingAt = new Date(
      Math.max(Date.now(), task.updatedAt.getTime() + 1)
    );
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.translationTask.updateMany({
        where: { id: task.id, status: 'QUOTED', updatedAt: task.updatedAt },
        data: {
          status: 'PENDING',
          chargedCents: task.estimatedCents,
          updatedAt: pendingAt,
        },
      });
      if (claimed.count === 0) {
        throw new WalletError('任务已确认或已失效', 'bad_request');
      }
      if (task.estimatedCents > 0) {
        await spendWalletCents(
          {
            userId: user.id,
            amountCents: task.estimatedCents,
            type: 'translation',
            note: `doc-translate:${task.id}`,
          },
          tx
        );
      }
    });

    const jobId = await enqueueDocTranslate(task.id, user.id);
    if (!jobId) {
      // 入队失败（极罕见）：终态失败 + 自动退款，用户可 retry
      const failedAt = new Date(
        Math.max(Date.now(), pendingAt.getTime() + 1)
      );
      const failed = await prisma.translationTask.updateMany({
        where: {
          id: task.id,
          status: 'PENDING',
          jobQueueId: null,
          proxyGeneration: null,
          updatedAt: pendingAt,
        },
        data: {
          status: 'FAILED',
          errorMessage: '任务入队失败，请重试',
          updatedAt: failedAt,
        },
      });
      if (failed.count !== 1) {
        return NextResponse.json(
          { error: '任务调度状态已变化，请刷新后重试', code: 'task_generation_changed' },
          { status: 409 }
        );
      }
      if (task.estimatedCents > 0) {
        const refunded = await refundTaskCharge(task.id, '入队失败退款', {
          status: 'FAILED',
          jobQueueId: null,
          proxyGeneration: null,
          chargedCents: task.estimatedCents,
          updatedAt: failedAt,
        });
        if (!refunded.claimed) {
          return NextResponse.json(
            { error: '任务生命周期已变化，请刷新后重试', code: 'task_generation_changed' },
            { status: 409 }
          );
        }
      }
      return NextResponse.json({ error: '任务入队失败，费用已退回' }, { status: 500 });
    }
    void runDocTranslateTick();

    const [full, wallet] = await Promise.all([
      prisma.translationTask.findUnique({ where: { id: task.id }, select: TASK_VIEW_SELECT }),
      prisma.user.findUnique({ where: { id: user.id }, select: { walletBalanceCents: true } }),
    ]);
    return NextResponse.json({
      task: full ? toTaskView(full) : null,
      walletBalanceCents: wallet?.walletBalanceCents ?? 0,
    });
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
    console.error('确认文档翻译失败:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
