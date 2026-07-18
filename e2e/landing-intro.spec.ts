import { test, expect, type Page } from '@playwright/test';

/**
 * Landing 首屏入场编排（第一幕）e2e
 *
 * 背景：e2e harness 无数据库（DATABASE_URL 指向不可达端口），SSR 查库失败
 * 时 / 会重定向 /setup；playwright.config 里的 E2E_FORCE_SETUP_COMPLETE=1
 * 种子让 Landing 可渲染（其余 SSR 数据源均有 catch 兜底回默认值）。
 *
 * 断言策略：动画表现依赖真实时钟，逐帧截图在慢机器（NAS）上必然 flaky，
 * 所以这里验证的是「编排契约」——各元素 computed style 里的动画名/延迟/
 * 曲线构成的时序关系，加上终态（全部落定可见）。时序关系与机器快慢无关。
 */

// 入场顺序契约：顶栏 → 左列逐行（眉题/标题/描述/按钮/信号）→ 右侧视觉
// → 产品窗口 → 徽章。每一项都必须严格晚于前一项。
const SEQUENCE: { label: string; selector: string }[] = [
  { label: 'navWrap', selector: 'header[class*="navWrap"]' },
  { label: 'eyebrow', selector: '[class*="eyebrow"]' },
  { label: 'h1', selector: '#landing-title' },
  { label: 'description', selector: '[class*="heroDescription"]' },
  { label: 'actions', selector: '[class*="heroActions"]' },
  { label: 'signals', selector: '[class*="heroSignals"]' },
  { label: 'heroVisual', selector: '[class*="heroVisual"]' },
  { label: 'productWindow', selector: '[class*="productWindow"]' },
  { label: 'badgeLive', selector: '[class*="floatBadgeLive"]' },
];

interface AnimationContract {
  label: string;
  name: string;
  /** 首条动画的 delay（秒） */
  delay: number;
  /** 首条动画的 timing function */
  ease: string;
}

async function readContracts(page: Page): Promise<AnimationContract[]> {
  return page.evaluate((seq) => {
    return seq.map(({ label, selector }) => {
      const el = document.querySelector(selector);
      if (!el) {
        return { label, name: 'MISSING', delay: NaN, ease: '' };
      }
      const cs = getComputedStyle(el);
      return {
        label,
        name: cs.animationName.split(',')[0].trim(),
        delay: parseFloat(cs.animationDelay) || 0,
        ease: cs.animationTimingFunction.split(')')[0] + ')',
      };
    });
  }, SEQUENCE);
}

test.describe('Landing 首屏入场编排', () => {
  test.beforeEach(async ({ page }) => {
    // 并行 + 冷 dev server 下 '/' 的客户端 chunk 可能落后于流式 shell 很久，
    // 先用 page.request 预热编译（不产生导航、不动页面状态）。
    await page.request.get('/').catch(() => undefined);
  });

  test('第一幕时序：顶栏先落，再左列逐行，最后右侧视觉', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#landing-title')).toBeAttached({
      timeout: 15_000,
    });

    const contracts = await readContracts(page);

    // 每个元素都真的挂上了入场动画
    for (const c of contracts) {
      expect(c.name, `${c.label} 应有入场动画`).not.toBe('MISSING');
      expect(c.name, `${c.label} 应有入场动画`).not.toBe('none');
    }

    // 顶栏最先（delay = 0），其余严格递增
    expect(contracts[0].delay).toBe(0);
    for (let i = 1; i < contracts.length; i++) {
      expect(
        contracts[i].delay,
        `${contracts[i].label}(${contracts[i].delay}s) 应晚于 ${contracts[i - 1].label}(${contracts[i - 1].delay}s)`
      ).toBeGreaterThan(contracts[i - 1].delay);
    }

    // 非线性曲线：顶栏用回弹曲线（控制点 y > 1），文案/视觉用 expo-out
    expect(contracts[0].ease).toContain('cubic-bezier');
    expect(contracts[0].ease).not.toBe('linear');
    const h1 = contracts.find((c) => c.label === 'h1');
    expect(h1?.ease).toContain('cubic-bezier');

    // 左右分区：左列最后一项（signals）仍早于右侧容器（heroVisual）
    const signals = contracts.find((c) => c.label === 'signals');
    const visual = contracts.find((c) => c.label === 'heroVisual');
    expect(signals!.delay).toBeLessThan(visual!.delay);

    // hero 首屏元素不再挂 data-reveal（避免和入场编排双重驱动）
    expect(await page.locator('#landing-title').getAttribute('data-reveal')).toBeNull();

    // 终态：编排完成后全部落定可见，顶栏归位（transform 无残留位移）
    for (const { label, selector } of SEQUENCE) {
      const opacity = () =>
        page.locator(selector).first().evaluate((el) => getComputedStyle(el).opacity);
      await expect
        .poll(opacity, { message: `${label} 应落定为不透明`, timeout: 10_000 })
        .toBe('1');
    }
    const navTransform = await page
      .locator('header[class*="navWrap"]')
      .evaluate((el) => getComputedStyle(el).transform);
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(navTransform);
  });

  test('折叠线以下：分区显隐编排与悬浮交互恢复', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#landing-title')).toBeAttached({
      timeout: 15_000,
    });

    // ── Bento 卡片：入场动画错峰契约（animation-delay 与 hover 的
    //    transition-delay 解耦），以及被通用 reveal 规则压死的 hover
    //    过渡已恢复（transition 必须含 box-shadow / border-color）
    const cards = page.locator('[class*="bentoGrid"] > article');
    await expect(cards).toHaveCount(5);
    const cardContracts = await cards.evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el);
        return { animDelay: cs.animationDelay, transition: cs.transitionProperty };
      })
    );
    expect(cardContracts.map((c) => c.animDelay)).toEqual(['0s', '0.09s', '0s', '0.09s', '0.18s']);
    for (const c of cardContracts) {
      expect(c.transition).toContain('box-shadow');
      expect(c.transition).toContain('border-color');
    }

    // ── capabilities 标题：滚动到位后父块直通、子元素错峰
    const capHeader = page.locator('header[class*="capabilitiesHeader"]');
    await capHeader.scrollIntoViewIfNeeded();
    await expect(capHeader).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
    const pDelay = await capHeader
      .locator('p')
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDelay);
    expect(parseFloat(pDelay)).toBeCloseTo(0.14, 2);

    // 卡片可见后动画真的挂上（cardRise），且最终落定
    const firstCard = cards.first();
    await firstCard.scrollIntoViewIfNeeded();
    await expect(firstCard).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
    await expect
      .poll(() => firstCard.evaluate((el) => getComputedStyle(el).opacity), { timeout: 10_000 })
      .toBe('1');

    // ── finalCta：子元素错峰 + 图标 back-out 弹出 + 轨道环淡入至 0.9
    const cta = page.locator('[class*="ctaContent"]');
    await cta.scrollIntoViewIfNeeded();
    await expect(cta).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
    const kidDelays = await cta.evaluate((el) =>
      [...el.children].map((k) => parseFloat(getComputedStyle(k).transitionDelay) || 0)
    );
    // 严格递增（0 → 0.07 → 0.14 → 0.21 → 0.28）
    for (let i = 1; i < kidDelays.length; i++) {
      expect(kidDelays[i]).toBeGreaterThan(kidDelays[i - 1]);
    }
    const markEase = await cta
      .locator('[class*="ctaMark"]')
      .evaluate((el) => getComputedStyle(el).transitionTimingFunction);
    expect(markEase).toContain('1.56'); // back-out 控制点，非线性弹出

    const orbit = page.locator('[class*="ctaOrbit"]');
    await expect(orbit).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
    await expect
      .poll(() => orbit.evaluate((el) => getComputedStyle(el).opacity), { timeout: 10_000 })
      .toBe('0.9');
    // 呼吸动画仍占用 transform（reveal 只淡 opacity）
    expect(
      await orbit.evaluate((el) => getComputedStyle(el).animationName)
    ).toContain('orbitBreathe');

    // ── story 叙事区：设备框 reveal、角标晚一拍（0.15s）
    const device = page.locator('[class*="storyDevice"]');
    await device.scrollIntoViewIfNeeded();
    await expect(device).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
    const capDelay = await page
      .locator('[class*="deviceCaption"]')
      .evaluate((el) => getComputedStyle(el).transitionDelay);
    expect(parseFloat(capDelay)).toBeCloseTo(0.15, 2);
  });

  test('prefers-reduced-motion：内容立即全部呈现，无分批入场', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator('#landing-title')).toBeAttached({
      timeout: 15_000,
    });

    // reduce 下动画被压到 0.01ms 且 delay 清零：所有元素应当已经可见，
    // 不给 10s 的宽限——2s 内没到位就说明 delay 清零失效（分批瞬移回归）。
    for (const { label, selector } of SEQUENCE) {
      const opacity = () =>
        page.locator(selector).first().evaluate((el) => getComputedStyle(el).opacity);
      await expect
        .poll(opacity, { message: `reduce 下 ${label} 应立即可见`, timeout: 2_000 })
        .toBe('1');
    }
  });
});
