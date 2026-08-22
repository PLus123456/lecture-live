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

    let task = await prisma.translationTask.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        status: true,
        estimatedCents: true,
        chargedCents: true,
        refundedAt: true,
        jobQueueId: true,
        proxyGeneration: true,
        updatedAt: true,
      },
    });
    if (!task || task.userId !== user.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (task.status !== 'FAILED' && task.status !== 'CANCELED') {
      return NextResponse.json({ error: '仅失败/已取消任务可重试' }, { status: 409 });
    }
    if (task.chargedCents > 0 && task.refundedAt === null) {
      // 上一次终态退款可能因瞬时 DB/钱包错误失败；这里先做幂等补偿并读回，
      // 避免安全闸把用户永久锁死在无法 retry 的状态。
      const refundSnapshot = task;
      const refunded = await refundTaskCharge(task.id, '重试前补退款', {
        status: task.status,
        jobQueueId: task.jobQueueId,
        proxyGeneration: task.proxyGeneration,
        chargedCents: task.chargedCents,
        updatedAt: task.updatedAt,
      });
      if (!refunded.claimed || !refunded.updatedAt) {
        return NextResponse.json(
          { error: '上一代退款尚未完成，请稍后重试', code: 'refund_pending' },
          { status: 409 }
        );
      }
      const refreshed = await prisma.translationTask.findUnique({
        where: { id: task.id },
        select: {
          id: true,
          userId: true,
          status: true,
          estimatedCents: true,
          chargedCents: true,
          refundedAt: true,
          jobQueueId: true,
          proxyGeneration: true,
          updatedAt: true,
        },
      });
      if (
        !refreshed ||
        refreshed.userId !== user.id ||
        refreshed.status !== refundSnapshot.status ||
        refreshed.jobQueueId !== refundSnapshot.jobQueueId ||
        refreshed.proxyGeneration !== refundSnapshot.proxyGeneration ||
        refreshed.chargedCents !== refundSnapshot.chargedCents ||
        refreshed.refundedAt === null ||
        refreshed.updatedAt.getTime() !== refunded.updatedAt.getTime()
      ) {
        return NextResponse.json(
          { error: '上一代退款尚未完成，请稍后重试', code: 'refund_pending' },
          { status: 409 }
        );
      }
      task = refreshed;
    }
    const source = await readSourceFile(task.id);
    if (!source) {
      return NextResponse.json({ error: '源文件已清理，请重新上传' }, { status: 410 });
    }

    const pendingAt = new Date(
      Math.max(Date.now(), task.updatedAt.getTime() + 1)
    );
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.translationTask.updateMany({
        where: {
          id: task.id,
          status: task.status,
          jobQueueId: task.jobQueueId,
          proxyGeneration: task.proxyGeneration,
          chargedCents: task.chargedCents,
          refundedAt: task.refundedAt,
          updatedAt: task.updatedAt,
          OR: [
            { chargedCents: { lte: 0 } },
            { refundedAt: { not: null } },
          ],
        },
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
          proxyTokenHash: null, // 旧 worker 凭据不得跨代次复活
          proxyGeneration: null,
          workerId: null,
          updatedAt: pendingAt,
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
