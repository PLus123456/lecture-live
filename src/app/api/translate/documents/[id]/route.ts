import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { JOB_STATUS, JOB_TYPE } from '@/lib/jobQueue';
import { TASK_VIEW_SELECT, toTaskView } from '@/lib/translate/taskApi';
import { deleteTaskFiles } from '@/lib/translate/taskStorage';
import {
  runDocTranslateTick,
  refundTaskCharge,
  translationRemoteJobId,
} from '@/lib/translate/translateProcessor';
import {
  getTranslateFleetConfig,
  deleteTranslateJob,
} from '@/lib/translate/workerClient';

export const runtime = 'nodejs';

/**
 * GET /api/translate/documents/[id] — 任务状态（前端轮询驱动）。
 * 在途任务顺带踢一脚调度 tick（与异步转录/音频增强同惯例：轮询是加速通道）。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const task = await prisma.translationTask.findUnique({
    where: { id },
    select: { ...TASK_VIEW_SELECT, userId: true },
  });
  if (!task || task.userId !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (task.status === 'PENDING' || task.status === 'TRANSLATING') {
    void runDocTranslateTick();
  }
  return NextResponse.json({ task: toTaskView(task) });
}

/**
 * DELETE /api/translate/documents/[id] — 删除/取消任务。
 *  - QUOTED / 终态：删行 + 清文件（FAILED 已自动退款，COMPLETED 不退）。
 *  - PENDING / TRANSLATING：标 CANCELED + 全额退款 + best-effort 通知 worker 停止，
 *    行保留供用户看到「已取消」，可再次 DELETE 彻底删除。
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await verifyAuth(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  let task = await prisma.translationTask.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      status: true,
      jobQueueId: true,
      workerId: true,
      proxyGeneration: true,
      chargedCents: true,
      refundedAt: true,
      updatedAt: true,
    },
  });
  if (!task || task.userId !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (task.status === 'PENDING' || task.status === 'TRANSLATING') {
    // 取消：CAS 同时绑定调度行与 generation；输了可能是另一 tick 已换代，
    // 不能拿旧快照继续返回“成功”而让新 worker 在后台付费运行。
    const canceledAt = new Date(
      Math.max(Date.now(), task.updatedAt.getTime() + 1)
    );
    const canceled = await prisma.translationTask.updateMany({
      where: {
        id: task.id,
        status: { in: ['PENDING', 'TRANSLATING'] },
        jobQueueId: task.jobQueueId,
        proxyGeneration: task.proxyGeneration,
        updatedAt: task.updatedAt,
      },
      data: {
        status: 'CANCELED',
        proxyTokenHash: null,
        proxyGeneration: null,
        updatedAt: canceledAt,
      },
    });
    if (canceled.count > 0) {
      if (task.chargedCents > 0) {
        const refunded = await refundTaskCharge(task.id, '用户取消退款', {
          status: 'CANCELED',
          jobQueueId: task.jobQueueId,
          proxyGeneration: null,
          chargedCents: task.chargedCents,
          updatedAt: canceledAt,
        });
        if (!refunded.claimed) {
          return NextResponse.json(
            { error: '退款或任务生命周期已变化，请刷新后重试', code: 'task_generation_changed' },
            { status: 409 }
          );
        }
      }
      // 调度行终态化（还在 SUBMITTED 时直接拦下；PROCESSING 交给对账清理 worker）
      if (task.jobQueueId) {
        await prisma.jobQueue
          .updateMany({
            where: {
              id: task.jobQueueId,
              status: JOB_STATUS.SUBMITTED,
              ...(task.proxyGeneration
                ? {
                    params: {
                      contains: `\"proxyGeneration\":\"${task.proxyGeneration}\"`,
                    },
                  }
                : {}),
            },
            data: { status: JOB_STATUS.FAILED, error: '用户取消', completedAt: new Date() },
          })
          .catch(() => undefined);
      }
      // best-effort 让 worker 立即停止（失败无妨：对账/worker 24h 自清扫兜底）
      const workerId = task.workerId;
      const jobQueueId = task.jobQueueId;
      const proxyGeneration = task.proxyGeneration;
      if (workerId && jobQueueId) {
        const fleet = await getTranslateFleetConfig().catch(() => null);
        const worker = fleet?.workers.find((w) => w.id === workerId);
        if (worker) {
          const remoteJobId = proxyGeneration
            ? translationRemoteJobId(jobQueueId, proxyGeneration)
            : jobQueueId;
          await deleteTranslateJob(worker, remoteJobId).catch(() => undefined);
        }
      }
      return NextResponse.json({ ok: true, canceled: true });
    }
    return NextResponse.json(
      {
        error: '任务调度状态已变化，请重试取消',
        code: 'task_generation_changed',
      },
      { status: 409 }
    );
  }

  // QUOTED / COMPLETED / FAILED / CANCELED：物理删除
  //
  // L22：删行前必须先把欠着的退款结清。TranslationTask 行是这笔待退款的唯一记录
  //（refundedAt / chargedCents 都在行上），行一删，兜底对账再也找不到它，钱就永久留在
  // 系统里 —— 而 FAILED/CANCELED 恰恰是「退款曾经失败、refundedAt 被还原成 null」
  // 最常落脚的两个状态。
  // COMPLETED 是正常消费不退；QUOTED 尚未扣费（chargedCents=0），refundTaskCharge 自会跳过。
  if (
    (task.status === 'FAILED' || task.status === 'CANCELED') &&
    task.chargedCents > 0 &&
    task.refundedAt === null
  ) {
    const refundSnapshot = task;
    const refunded = await refundTaskCharge(task.id, '删除任务前补退款', {
      status: task.status,
      jobQueueId: task.jobQueueId,
      proxyGeneration: task.proxyGeneration,
      chargedCents: task.chargedCents,
      updatedAt: task.updatedAt,
    });
    if (!refunded.claimed || !refunded.updatedAt) {
      return NextResponse.json(
        { error: '退款尚未完成，请稍后重试删除', code: 'refund_pending' },
        { status: 409 }
      );
    }
    const refreshed = await prisma.translationTask.findUnique({
      where: { id: task.id },
      select: {
        id: true,
        userId: true,
        status: true,
        jobQueueId: true,
        workerId: true,
        proxyGeneration: true,
        chargedCents: true,
        refundedAt: true,
        updatedAt: true,
      },
    });
    if (!refreshed) {
      return NextResponse.json({ ok: true, canceled: false });
    }
    if (
      refreshed.userId !== user.id ||
      refreshed.status !== refundSnapshot.status ||
      refreshed.jobQueueId !== refundSnapshot.jobQueueId ||
      refreshed.proxyGeneration !== refundSnapshot.proxyGeneration ||
      refreshed.chargedCents !== refundSnapshot.chargedCents ||
      refreshed.refundedAt === null ||
      refreshed.updatedAt.getTime() !== refunded.updatedAt.getTime()
    ) {
      return NextResponse.json(
        { error: '任务生命周期已变化，请刷新后重试', code: 'task_generation_changed' },
        { status: 409 }
      );
    }
    task = refreshed;
  }

  const deleted = await prisma.$transaction(async (tx) => {
    const result = await tx.translationTask.deleteMany({
      where: {
        id: task.id,
        status: task.status,
        jobQueueId: task.jobQueueId,
        proxyGeneration: task.proxyGeneration,
        chargedCents: task.chargedCents,
        refundedAt: task.refundedAt,
        updatedAt: task.updatedAt,
        // 仍欠退款的行不许删（上面的补退款也失败了）——留给兜底对账继续看得见
        OR: [
          { chargedCents: { lte: 0 } },
          { refundedAt: { not: null } },
          { status: 'COMPLETED' },
        ],
      },
    });
    if (result.count > 0) {
      // resource JobQueue 仍是当日用户/全局 token 账本，不能物理删除；但 SUCCESS
      // result 可含完整翻译 cache。与 task 删除同事务抹除所有可恢复内容，只留计量。
      await tx.jobQueue.updateMany({
        where: {
          resourceScope: { not: null },
          sessionId: task.id,
          userId: task.userId,
        },
        data: {
          sessionId: null,
          params: null,
          result: null,
          error: null,
          activeKey: null,
          triggeredBy: 'translation-task-deleted',
        },
      });
      await tx.jobQueue.updateMany({
        where: {
          resourceScope: null,
          type: JOB_TYPE.DOC_TRANSLATE,
          userId: task.userId,
          OR: [
            ...(task.jobQueueId ? [{ id: task.jobQueueId }] : []),
            { params: { contains: `\"taskId\":\"${task.id}\"` } },
          ],
        },
        data: {
          sessionId: null,
          userId: null,
          params: null,
          result: null,
          error: null,
          activeKey: null,
          triggeredBy: 'translation-task-deleted',
        },
      });
    }
    return result;
  });
  if (deleted.count > 0) {
    await deleteTaskFiles(task.id).catch(() => undefined);
    return NextResponse.json({ ok: true, canceled: false });
  }

  const stillThere = await prisma.translationTask.findUnique({
    where: { id: task.id },
    select: { status: true, refundedAt: true, chargedCents: true },
  });
  if (stillThere && stillThere.chargedCents > 0 && stillThere.refundedAt === null) {
    return NextResponse.json(
      { error: '退款尚未完成，请稍后重试删除', code: 'refund_pending' },
      { status: 409 }
    );
  }
  if (stillThere) {
    return NextResponse.json(
      { error: '任务生命周期已变化，请刷新后重试', code: 'task_generation_changed' },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true, canceled: false });
}
