import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { JOB_STATUS } from '@/lib/jobQueue';
import { TASK_VIEW_SELECT, toTaskView } from '@/lib/translate/taskApi';
import { deleteTaskFiles } from '@/lib/translate/taskStorage';
import {
  runDocTranslateTick,
  refundTaskCharge,
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
  const task = await prisma.translationTask.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      status: true,
      jobQueueId: true,
      workerId: true,
    },
  });
  if (!task || task.userId !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (task.status === 'PENDING' || task.status === 'TRANSLATING') {
    // 取消：CAS 抢占防与收割并发（输了说明已终态，按新状态走）
    const canceled = await prisma.translationTask.updateMany({
      where: { id: task.id, status: { in: ['PENDING', 'TRANSLATING'] } },
      data: { status: 'CANCELED', proxyTokenHash: null },
    });
    if (canceled.count > 0) {
      await refundTaskCharge(task.id, '用户取消退款');
      // 调度行终态化（还在 SUBMITTED 时直接拦下；PROCESSING 交给对账清理 worker）
      if (task.jobQueueId) {
        await prisma.jobQueue
          .updateMany({
            where: { id: task.jobQueueId, status: JOB_STATUS.SUBMITTED },
            data: { status: JOB_STATUS.FAILED, error: '用户取消', completedAt: new Date() },
          })
          .catch(() => undefined);
      }
      // best-effort 让 worker 立即停止（失败无妨：对账/worker 24h 自清扫兜底）
      if (task.workerId && task.jobQueueId) {
        const fleet = await getTranslateFleetConfig().catch(() => null);
        const worker = fleet?.workers.find((w) => w.id === task.workerId);
        if (worker) {
          await deleteTranslateJob(worker, task.jobQueueId).catch(() => undefined);
        }
      }
      return NextResponse.json({ ok: true, canceled: true });
    }
  }

  // QUOTED / COMPLETED / FAILED / CANCELED：物理删除
  const deleted = await prisma.translationTask.deleteMany({
    where: { id: task.id, status: { in: ['QUOTED', 'COMPLETED', 'FAILED', 'CANCELED'] } },
  });
  if (deleted.count > 0) {
    await deleteTaskFiles(task.id).catch(() => undefined);
  }
  return NextResponse.json({ ok: true, canceled: false });
}
