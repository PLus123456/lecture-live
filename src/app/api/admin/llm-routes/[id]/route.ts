import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAdminAccess } from '@/lib/adminApi';
import { logAction } from '@/lib/auditLog';
import {
  VALID_THINKING_MODES,
  VALID_DEPTHS,
  coerceTemperature,
} from '@/lib/llm/routeParams';

/**
 * PATCH /api/admin/llm-routes/[id]
 * 更新一条用途路由行的路由层参数：thinkingMode / thinkingDepth / temperature / isDefault。
 * isDefault=true 时同用途其余路由自动取消默认（每用途至多一个默认）。
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-routes:update',
    limit: 60,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  try {
    const { id } = await params;
    const existing = await prisma.llmModel.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: '路由不存在' }, { status: 404 });
    }

    const body = await req.json();
    const data: Record<string, unknown> = {};

    if (body.thinkingMode !== undefined) {
      if (!(VALID_THINKING_MODES as readonly string[]).includes(body.thinkingMode)) {
        return NextResponse.json(
          { error: `无效的思考模式，允许值: ${VALID_THINKING_MODES.join(', ')}` },
          { status: 400 }
        );
      }
      data.thinkingMode = body.thinkingMode;
      // 派生：与 thinkingMode 保持一致（历史兼容字段）
      data.supportsThinkingDepth = body.thinkingMode === 'DEPTH';
    }

    if (body.thinkingDepth !== undefined) {
      if (!(VALID_DEPTHS as readonly string[]).includes(body.thinkingDepth)) {
        return NextResponse.json(
          { error: `无效的思考深度，允许值: ${VALID_DEPTHS.join(', ')}` },
          { status: 400 }
        );
      }
      data.thinkingDepth = body.thinkingDepth;
    }

    if (body.temperature !== undefined) {
      const temperature = coerceTemperature(body.temperature, existing.temperature);
      if (temperature === null) {
        return NextResponse.json(
          { error: 'temperature 必须是 0–2 之间的数字' },
          { status: 400 }
        );
      }
      data.temperature = temperature;
    }

    if (body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))) {
      data.sortOrder = Math.floor(Number(body.sortOrder));
    }

    const makeDefault = body.isDefault === true;
    if (body.isDefault !== undefined) {
      data.isDefault = Boolean(body.isDefault);
    }

    const route = await prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.llmModel.updateMany({
          where: { purpose: existing.purpose, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.llmModel.update({ where: { id }, data });
    });

    logAction(req, 'admin.llm.route.update', {
      user: admin,
      detail: `更新用途路由: ${existing.displayName} @ ${existing.purpose}`,
    });

    return NextResponse.json({ route });
  } catch (err) {
    console.error('更新用途路由失败:', err);
    return NextResponse.json({ error: '更新失败' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/llm-routes/[id]
 * 把模型从某用途摘除（删路由行，不动模型库条目）。
 * 摘除的是默认路由时不自动提升其他行：getProviderForPurpose 会回落该用途 sortOrder 最前的路由。
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user: admin, response } = await requireAdminAccess(req, {
    scope: 'admin:llm-routes:delete',
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (response) {
    return response;
  }

  try {
    const { id } = await params;
    const existing = await prisma.llmModel.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: '路由不存在' }, { status: 404 });
    }

    await prisma.llmModel.delete({ where: { id } });

    logAction(req, 'admin.llm.route.delete', {
      user: admin,
      detail: `摘除用途路由: ${existing.displayName} @ ${existing.purpose}`,
    });

    return NextResponse.json({ message: '已摘除' });
  } catch (err) {
    console.error('摘除用途路由失败:', err);
    return NextResponse.json({ error: '摘除失败' }, { status: 500 });
  }
}
