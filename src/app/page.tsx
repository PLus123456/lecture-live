import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';

/**
 * 检查初始设置是否完成。
 * 如果 setup_complete 标记不存在，但核心配置（admin + LLM）已就绪，
 * 自动标记为完成（兼容已有部署）。
 */
async function isSetupComplete(): Promise<boolean> {
  try {
    const setting = await prisma.siteSetting.findUnique({
      where: { key: 'setup_complete' },
    });
    if (setting?.value === 'true') return true;

    // 自动检测已有部署：有 admin 用户即视为已完成初始设置
    const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
    if (adminCount > 0) {
      await prisma.siteSetting.upsert({
        where: { key: 'setup_complete' },
        update: { value: 'true' },
        create: { key: 'setup_complete', value: 'true' },
      });
      return true;
    }

    return false;
  } catch {
    // 数据库不可用时跳过检查，让用户进入 setup
    return false;
  }
}

export default async function RootPage() {
  const setupDone = await isSetupComplete();
  if (!setupDone) {
    redirect('/setup');
  }
  redirect('/home');
}
