import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import LandingPage from '@/components/landing/LandingPage';
import { getSiteSettings } from '@/lib/siteSettings';
import { verifyAuthToken, getAuthCookieName } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { detectServerLocale } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

const META: Record<'en' | 'zh', { suffix: string; description: string }> = {
  zh: {
    suffix: '让课堂里的每一句话继续生长',
    description:
      '实时课堂转录、多语言翻译、AI 总结与问答、直播分享和课后回放，一条连续的学习工作流。',
  },
  en: {
    suffix: 'where every word keeps growing',
    description:
      'Real-time lecture transcription, live translation, AI summaries and Q&A, shareable broadcasts and replay — one continuous learning flow.',
  },
};

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings().catch(() => null);
  const siteName = settings?.site_name?.trim() || 'LectureLive';
  const locale = await detectServerLocale(settings?.language);
  const meta = META[locale];

  return {
    title: `${siteName} — ${meta.suffix}`,
    description: settings?.site_description?.trim() || meta.description,
  };
}

/**
 * 检查初始设置是否完成。
 * 如果 setup_complete 标记不存在，但核心配置（admin）已就绪，
 * 视为完成（兼容已有部署）——**只判定，不落库**。
 *
 * M24（修正版）：这里原来会 `upsert setup_complete='true'`。那是一个由**任意匿名访客
 * 访问 `/`** 触发的 SSR 写副作用，且前置条件只有 `adminCount > 0`（不要求 llm/soniox
 * 就绪）——比 `api/setup` GET 那处（要求 db+admin+llm+soniox 四者全齐）宽得多。
 *
 * 而向导自身的步骤顺序是 database → admin → llm → soniox，`POST /api/setup` 又在入口
 * 对 `setup_complete===true` 一律 403，全仓**没有任何代码把该键写回 false**。于是：
 *   step=admin 成功 → 任何人（运维自己开首页 / 爬虫 / 链接预取）访问一次 `/`
 *   → setup_complete 被置位 → 后续 step=llm / step=soniox 永久 403
 *   → LLM 一次都没配上，向导就锁死了，只能连数据库改。
 *
 * 修法与 api/setup 的 GET 同口径：去掉写副作用，置位只保留在 `step=complete`
 * （以及管理员显式完成向导的路径）。判定本身保留，存量部署照旧不会被丢回 /setup。
 */
async function isSetupComplete(): Promise<boolean> {
  // E2E 种子：e2e harness 的 DATABASE_URL 指向不可达端口（全靠 page.route 拦
  // 浏览器请求），SSR 查库必然失败并把 / 重定向到 /setup，Landing 页就永远
  // 测不到。置此环境变量跳过检查（其余数据源均有 catch 兜底回默认值）。
  if (process.env.E2E_FORCE_SETUP_COMPLETE === '1') return true;
  try {
    const setting = await prisma.siteSetting.findUnique({
      where: { key: 'setup_complete' },
    });
    if (setting?.value === 'true') return true;

    const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
    // 只读判定：不写库（见上方 M24 说明）。
    return adminCount > 0;
  } catch {
    // 数据库不可用时跳过检查，让用户进入 setup
    return false;
  }
}

/** 服务端读取 auth cookie，判断当前访客是否已登录（用于自适应 CTA） */
async function getIsAuthenticated(): Promise<boolean> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(getAuthCookieName())?.value;
    if (!token) return false;
    const session = await verifyAuthToken(token);
    return !!session;
  } catch {
    return false;
  }
}

export default async function RootPage() {
  const setupDone = await isSetupComplete();
  if (!setupDone) {
    redirect('/setup');
  }

  const [settings, isAuthenticated] = await Promise.all([
    getSiteSettings().catch(() => null),
    getIsAuthenticated(),
  ]);

  // 让 SSR 首屏语言尽量贴近访客（浏览器 Accept-Language → 站点默认）；
  // 客户端 I18nProvider 再据 localStorage / navigator 精修。
  const initialLocale = await detectServerLocale(settings?.language);

  return (
    <LandingPage
      siteName={settings?.site_name?.trim() || 'LectureLive'}
      siteDescription={settings?.site_description?.trim() || ''}
      logoPath={settings?.logo_path?.trim() || ''}
      allowRegistration={settings?.allow_registration !== false}
      isAuthenticated={isAuthenticated}
      initialLocale={initialLocale}
    />
  );
}
