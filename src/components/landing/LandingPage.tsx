'use client';

import Link from 'next/link';
import Image from 'next/image';
import {
  ArrowDown,
  ArrowRight,
  AudioLines,
  BrainCircuit,
  Captions,
  Check,
  Cloud,
  Cpu,
  FileDown,
  FolderOpen,
  Home,
  Languages,
  Link2,
  LockKeyhole,
  MessageSquare,
  MessageSquareText,
  Mic2,
  Play,
  Radio,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  Users,
  Volume2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n, type Locale } from '@/lib/i18n';
import { makeLandingCopy, type LandingT } from './copy';
import styles from './LandingPage.module.css';

interface LandingPageProps {
  siteName: string;
  siteDescription: string;
  logoPath: string;
  allowRegistration: boolean;
  isAuthenticated?: boolean;
  initialLocale?: Locale;
}

const waveform = [
  24, 42, 58, 36, 72, 88, 54, 40, 66, 92, 76, 46, 62, 84, 52, 34, 68, 96,
  78, 48, 70, 86, 60, 38, 56, 74, 44, 64, 82, 50, 32, 60, 76, 48, 30, 54,
];

function BrandMark({ logoPath }: { logoPath: string }) {
  if (logoPath) {
    return (
      <span className={styles.brandMark}>
        <Image src={logoPath} alt="" width={36} height={36} unoptimized />
      </span>
    );
  }

  return (
    <span className={styles.brandMark}>
      <AudioLines size={18} />
    </span>
  );
}

function Waveform({ quiet = false }: { quiet?: boolean }) {
  return (
    <div className={`${styles.waveform} ${quiet ? styles.waveformQuiet : ''}`} aria-hidden="true">
      {waveform.map((height, index) => (
        <span
          key={`${height}-${index}`}
          style={{
            height: `${height}%`,
            animationDelay: `${(index % 9) * -0.11}s`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * 演示内容的语言约定：
 * - “原文/转录”一律固定英文（演示的这堂课就是英文课）；
 * - “译文”一律固定中文（演示 EN → 中文 的翻译能力）；
 * - UI 文案、旁白、AI 生成的摘要/问答 走 tl()，跟随界面语言。
 */

function CaptureScene({ tl }: { tl: LandingT }) {
  return (
    <div className={styles.captureScene}>
      <div className={styles.sceneToolbar}>
        <div className={styles.liveIndicator}>
          <span />
          LIVE · 42:16
        </div>
        <div className={styles.sceneToolbarMeta}>
          <AudioLines size={14} />
          {tl('scene.capture.toolbarMeta')}
        </div>
      </div>

      <div className={styles.sceneWave}>
        <Waveform />
      </div>

      <div className={styles.transcriptRows}>
        <div className={styles.transcriptRow}>
          <span className={styles.speakerDot}>DR</span>
          <div>
            <small>09:42:18</small>
            <p>Photosynthesis converts light energy into chemical energy the cell can store.</p>
          </div>
        </div>
        <div className={styles.transcriptRow}>
          <span className={`${styles.speakerDot} ${styles.speakerDotBlue}`}>DR</span>
          <div>
            <small>09:42:26</small>
            <p>So the first stage happens on the thylakoid membrane of the chloroplast.</p>
          </div>
        </div>
        <div className={`${styles.transcriptRow} ${styles.transcriptRowActive}`}>
          <span className={styles.speakerDot}>DR</span>
          <div>
            <small>{tl('scene.capture.activeRow.label')}</small>
            <p>Next, let&rsquo;s look at how this process affects&hellip;</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function TranslateScene({ tl }: { tl: LandingT }) {
  return (
    <div className={styles.translateScene}>
      <div className={styles.languageHeader}>
        <div>
          <span>EN</span>
          English
        </div>
        <Languages size={18} />
        <div>
          <span>中</span>
          {tl('scene.translate.langHeader.zh')}
        </div>
      </div>

      <div className={styles.translationGrid}>
        <div className={styles.translationPane}>
          <small>09:43:02 · ORIGINAL</small>
          <p>Energy is not created during this process. It is transformed and stored.</p>
          <small>09:43:16 · ORIGINAL</small>
          <p>The chlorophyll molecule plays a central role in capturing light.</p>
        </div>
        <div className={`${styles.translationPane} ${styles.translationPaneAccent}`}>
          <small>09:43:02 · {tl('scene.translate.pane.accent.label')}</small>
          <p>能量并没有在这个过程中被创造，而是被转换并储存下来。</p>
          <small>09:43:16 · {tl('scene.translate.pane.accent.label')}</small>
          <p>叶绿素分子在捕获光能的过程中起到核心作用。</p>
        </div>
      </div>

      <div className={styles.localTranslateBadge}>
        <Cpu size={15} />
        {tl('scene.translate.localBadge')}
        <span>WebGPU</span>
      </div>
    </div>
  );
}

function ThinkScene({ tl }: { tl: LandingT }) {
  return (
    <div className={styles.thinkScene}>
      <div className={styles.aiHeader}>
        <div className={styles.aiMark}>
          <Sparkles size={17} />
        </div>
        <div>
          <strong>{tl('scene.think.header.title')}</strong>
          <small>{tl('scene.think.header.sub')}</small>
        </div>
        <span>{tl('scene.think.header.status')}</span>
      </div>

      <div className={styles.summaryCard}>
        <small>{tl('scene.think.summaryCard.label')}</small>
        <h4>{tl('scene.think.summaryCard.title')}</h4>
        <ul>
          <li><Check size={13} /> {tl('scene.think.summaryCard.li1')}</li>
          <li><Check size={13} /> {tl('scene.think.summaryCard.li2')}</li>
          <li><Check size={13} /> {tl('scene.think.summaryCard.li3')}</li>
        </ul>
      </div>

      <div className={styles.questionCard}>
        <div className={styles.questionBubble}>{tl('scene.think.question')}</div>
        <div className={styles.answerBubble}>
          <BrainCircuit size={16} />
          {tl('scene.think.answer')}
        </div>
      </div>
    </div>
  );
}

function ShareScene({ tl }: { tl: LandingT }) {
  return (
    <div className={styles.shareScene}>
      <div className={styles.shareHero}>
        <div className={styles.shareIcon}>
          <Radio size={24} />
        </div>
        <small>LIVE CLASSROOM</small>
        <h4>Biology 204 · Photosynthesis</h4>
        <p>{tl('scene.share.hero.p')}</p>
      </div>

      <div className={styles.shareLink}>
        <Link2 size={16} />
        <span>lecture.live/s/8f2k</span>
        <button type="button" tabIndex={-1}>{tl('scene.share.copyButton')}</button>
      </div>

      <div className={styles.audienceRow}>
        <div className={styles.avatars} aria-hidden="true">
          <span>YL</span><span>AK</span><span>ME</span><span>+9</span>
        </div>
        <div>
          <strong>{tl('scene.share.audience.count')}</strong>
          <small>{tl('scene.share.audience.sub')}</small>
        </div>
      </div>

      <div className={styles.exportRow}>
        {['PDF', 'DOCX', 'SRT', 'MD', 'JSON'].map((format) => (
          <span key={format}>{format}</span>
        ))}
      </div>
    </div>
  );
}

export default function LandingPage({
  siteName,
  siteDescription,
  logoPath,
  allowRegistration,
  isAuthenticated = false,
  initialLocale,
}: LandingPageProps) {
  const { locale: ctxLocale, setLocale } = useI18n();
  // SSR 首屏用 initialLocale（Accept-Language 推断，避免 hydration 抖动），
  // 挂载后同步到 I18n 上下文（localStorage / 浏览器 / 站点默认的最终结果）。
  const [locale, setLocaleLocal] = useState<Locale>(initialLocale ?? ctxLocale);
  useEffect(() => {
    setLocaleLocal(ctxLocale);
  }, [ctxLocale]);

  const tl = useMemo(() => makeLandingCopy(locale, siteName), [locale, siteName]);

  const storySteps = useMemo(
    () =>
      ['0', '1', '2', '3'].map((n, i) => ({
        index: `0${i + 1}`,
        label: tl(`storyStep.${n}.label`),
        title: tl(`storyStep.${n}.title`),
        description: tl(`storyStep.${n}.description`),
      })),
    [tl]
  );

  const scenes = useMemo(
    () => [
      <CaptureScene key="capture" tl={tl} />,
      <TranslateScene key="translate" tl={tl} />,
      <ThinkScene key="think" tl={tl} />,
      <ShareScene key="share" tl={tl} />,
    ],
    [tl]
  );

  const pageRef = useRef<HTMLElement>(null);
  const storyRef = useRef<HTMLElement>(null);
  const frameRef = useRef<number | null>(null);
  const activeStepRef = useRef(0);
  const navScrolledRef = useRef(false);
  const [activeStep, setActiveStep] = useState(0);
  const [navScrolled, setNavScrolled] = useState(false);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const updateScroll = () => {
      frameRef.current = null;
      const viewportHeight = Math.max(window.innerHeight, 1);
      const scrollable = Math.max(document.documentElement.scrollHeight - viewportHeight, 1);
      const heroProgress = Math.min(window.scrollY / viewportHeight, 1);

      page.style.setProperty('--page-progress', `${window.scrollY / scrollable}`);
      page.style.setProperty('--hero-copy-shift', reducedMotion.matches ? '0px' : `${heroProgress * 76}px`);
      page.style.setProperty('--hero-visual-shift', reducedMotion.matches ? '0px' : `${heroProgress * 128}px`);
      page.style.setProperty('--hero-fade', `${1 - heroProgress * 0.62}`);
      const nextNavScrolled = window.scrollY > 36;
      if (nextNavScrolled !== navScrolledRef.current) {
        navScrolledRef.current = nextNavScrolled;
        setNavScrolled(nextNavScrolled);
      }

      const story = storyRef.current;
      if (!story) return;

      if (reducedMotion.matches) {
        story.style.setProperty('--story-progress', '0');
        story.style.setProperty('--story-drift', '0px');
        return;
      }

      const rect = story.getBoundingClientRect();
      const travel = Math.max(rect.height - viewportHeight, 1);
      const progress = Math.min(Math.max(-rect.top / travel, 0), 1);
      story.style.setProperty('--story-progress', `${progress}`);
      story.style.setProperty('--story-drift', `${(progress - 0.5) * -64}px`);
      const nextStep = Math.min(storySteps.length - 1, Math.floor(progress * storySteps.length));
      if (nextStep !== activeStepRef.current) {
        activeStepRef.current = nextStep;
        setActiveStep(nextStep);
      }
    };

    const requestUpdate = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(updateScroll);
    };

    updateScroll();
    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);
    reducedMotion.addEventListener('change', requestUpdate);

    return () => {
      window.removeEventListener('scroll', requestUpdate);
      window.removeEventListener('resize', requestUpdate);
      reducedMotion.removeEventListener('change', requestUpdate);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [storySteps.length]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const revealNodes = Array.from(page.querySelectorAll<HTMLElement>('[data-reveal]'));

    if (reducedMotion || !('IntersectionObserver' in window)) {
      revealNodes.forEach((node) => node.setAttribute('data-visible', 'true'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.setAttribute('data-visible', 'true');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 }
    );

    revealNodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const page = pageRef.current;
    if (!page || window.matchMedia('(pointer: coarse)').matches) return;

    const moveGlow = (event: PointerEvent) => {
      page.style.setProperty('--pointer-x', `${event.clientX}px`);
      page.style.setProperty('--pointer-y', `${event.clientY}px`);
    };

    window.addEventListener('pointermove', moveGlow, { passive: true });
    return () => window.removeEventListener('pointermove', moveGlow);
  }, []);

  const scrollToStep = useCallback((index: number) => {
    const story = storyRef.current;
    if (!story) return;
    const travel = Math.max(story.offsetHeight - window.innerHeight, 0);
    const progress = index / Math.max(storySteps.length - 1, 1);
    window.scrollTo({
      top: story.offsetTop + travel * progress,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }, [storySteps.length]);

  const toggleLocale = useCallback(() => {
    const next: Locale = locale === 'zh' ? 'en' : 'zh';
    setLocaleLocal(next);
    setLocale(next);
  }, [locale, setLocale]);

  // 已登录 → 直接进工作区；否则按是否开放注册决定入口。
  const primaryHref = isAuthenticated ? '/home' : allowRegistration ? '/register' : '/login';
  const primaryLabel = isAuthenticated
    ? tl('cta.workspace')
    : allowRegistration
      ? tl('cta.start')
      : tl('cta.enter');
  const heroDescription = siteDescription || tl('hero.description');
  const otherLocaleLabel = locale === 'zh' ? 'EN' : '中';

  return (
    <main ref={pageRef} className={styles.page} data-stage={activeStep}>
      <a href="#landing-content" className={styles.skipLink}>{tl('skipLink')}</a>
      <div className={styles.pointerGlow} aria-hidden="true" />
      <div className={styles.scrollProgress} aria-hidden="true"><span /></div>

      <header className={`${styles.navWrap} ${navScrolled ? styles.navWrapScrolled : ''}`}>
        <nav className={styles.nav} aria-label={tl('nav.aria')}>
          <Link href="/" className={styles.brand} aria-label={tl('nav.brand.aria')}>
            <BrandMark logoPath={logoPath} />
            <span>{siteName}</span>
          </Link>

          <div className={styles.navLinks}>
            <a href="#workflow">{tl('nav.workflow')}</a>
            <a href="#capabilities">{tl('nav.capabilities')}</a>
            <a href="#ownership">{tl('nav.ownership')}</a>
          </div>

          <div className={styles.navActions}>
            <button
              type="button"
              className={styles.langToggle}
              onClick={toggleLocale}
              aria-label={locale === 'zh' ? 'Switch to English' : '切换到中文'}
            >
              <Languages size={14} />
              {otherLocaleLabel}
            </button>
            {!isAuthenticated && allowRegistration && (
              <Link href="/login" className={styles.navLogin}>{tl('nav.login')}</Link>
            )}
            <Link href={primaryHref} className={styles.navPrimary}>
              {primaryLabel}
              <ArrowRight size={15} />
            </Link>
          </div>
        </nav>
      </header>

      <section id="landing-content" className={styles.hero} aria-labelledby="landing-title">
        <div className={styles.heroGrid}>
          <div className={styles.heroCopy}>
            <div className={styles.eyebrow} data-reveal data-visible="true">
              <span><Radio size={13} /></span>
              {tl('hero.eyebrow')}
            </div>

            <h1 id="landing-title" data-reveal data-visible="true">
              {tl('hero.h1.lead')}
              <span>{tl('hero.h1.accent')}</span>
              {tl('hero.h1.tail')}
            </h1>

            <p className={styles.heroDescription} data-reveal data-visible="true">
              {heroDescription}
            </p>

            <div className={styles.heroActions} data-reveal data-visible="true">
              <Link href={primaryHref} className={styles.heroPrimary}>
                <span>{primaryLabel}</span>
                <ArrowRight size={18} />
              </Link>
              <a href="#workflow" className={styles.heroSecondary}>
                {tl('hero.secondaryCta')}
                <ArrowDown size={17} />
              </a>
            </div>

            <div className={styles.heroSignals} data-reveal data-visible="true">
              <span><Captions size={15} /> {tl('hero.signals.0')}</span>
              <span><Languages size={15} /> {tl('hero.signals.1')}</span>
              <span><Play size={15} /> {tl('hero.signals.2')}</span>
            </div>
          </div>

          <div className={styles.heroVisual} aria-hidden="true">
            <div className={styles.heroOrb} aria-hidden="true" />
            <div className={`${styles.floatBadge} ${styles.floatBadgeLive}`}>
              <span /> LIVE
              <small>00:42:16</small>
            </div>
            <div className={`${styles.floatBadge} ${styles.floatBadgeLanguage}`}>
              <Languages size={15} /> EN <ArrowRight size={12} /> {tl('hero.floatBadge.language')}
            </div>

            <div className={styles.productWindow}>
              <div className={styles.windowTopbar}>
                <div className={styles.windowDots}><span /><span /><span /></div>
                <div className={styles.windowTitle}>Biology 204 · Live session</div>
                <div className={styles.windowStatus}><span /> Recording</div>
              </div>

              <div className={styles.windowBody}>
                <aside className={styles.miniSidebar}>
                  <div className={styles.miniLogo}><AudioLines size={18} /></div>
                  <span className={styles.miniNavActive}><Home size={17} /></span>
                  <span><Languages size={17} /></span>
                  <span><MessageSquare size={17} /></span>
                  <span><FolderOpen size={17} /></span>
                  <span><Share2 size={17} /></span>
                </aside>

                <div className={styles.windowContent}>
                  <div className={styles.windowContentHeader}>
                    <div>
                      <small>NOW TRANSCRIBING</small>
                      <strong>Photosynthesis &amp; energy</strong>
                    </div>
                    <button type="button" tabIndex={-1} aria-label={tl('hero.window.pauseButton.aria')}><Volume2 size={17} /></button>
                  </div>

                  <div className={styles.heroWave}><Waveform /></div>

                  <div className={styles.heroTranscript}>
                    <div>
                      <span className={styles.heroAvatar}>DR</span>
                      <p>Photosynthesis is how plants convert <mark>light energy</mark> into chemical energy.</p>
                      <small>09:42:18</small>
                    </div>
                    <div>
                      <span className={`${styles.heroAvatar} ${styles.heroAvatarBlue}`}>中</span>
                      <p>光合作用是植物将<mark>光能</mark>转化为化学能的过程。</p>
                      <small>{tl('hero.window.transcript.zhLine.label')}</small>
                    </div>
                    <div className={styles.heroTranscriptActive}>
                      <span className={styles.heroAvatar}>DR</span>
                      <p>The first stage happens inside the thylakoid membrane<span className={styles.typingCursor} /></p>
                      <small>{tl('hero.window.transcript.active.label')}</small>
                    </div>
                  </div>
                </div>

                <aside className={styles.insightPanel}>
                  <div className={styles.insightTitle}><Sparkles size={14} /> LIVE INSIGHTS</div>
                  <div className={styles.insightCard}>
                    <small>KEY CONCEPT</small>
                    <strong>Energy conversion</strong>
                    <p>Light → chemical energy</p>
                  </div>
                  <div className={styles.insightCard}>
                    <small>KEYWORDS</small>
                    <div className={styles.keywordList}><span>chlorophyll</span><span>ATP</span><span>light</span></div>
                  </div>
                  <div className={styles.viewers}><Users size={14} /><span>12 viewers</span><i /><i /><i /></div>
                </aside>
              </div>
            </div>

            <div className={`${styles.floatBadge} ${styles.floatBadgeAi}`}>
              <Sparkles size={16} />
              <div><strong>{tl('hero.aiBadge.title')}</strong><small>{tl('hero.aiBadge.sub')}</small></div>
              <Check size={14} />
            </div>
          </div>
        </div>

        <a href="#workflow" className={styles.scrollCue} aria-label={tl('hero.scrollCue.aria')}>
          <span>SCROLL TO FOLLOW</span>
          <i><ArrowDown size={15} /></i>
        </a>
      </section>

      <div className={styles.wordStream} aria-hidden="true">
        <div>
          <span>{tl('wordStream.0')}</span><i>·</i><span>{tl('wordStream.1')}</span><i>·</i><span>{tl('wordStream.2')}</span><i>·</i><span>{tl('wordStream.3')}</span><i>·</i>
          <span>{tl('wordStream.0')}</span><i>·</i><span>{tl('wordStream.1')}</span><i>·</i><span>{tl('wordStream.2')}</span><i>·</i><span>{tl('wordStream.3')}</span><i>·</i>
        </div>
      </div>

      <section ref={storyRef} id="workflow" className={styles.story} aria-labelledby="workflow-title">
        <div className={styles.storySticky}>
          <div className={styles.storyAtmosphere} aria-hidden="true"><span /><span /><span /></div>
          <div className={styles.storyGrid}>
            <div className={styles.storyCopy}>
              <div className={styles.sectionKicker}>{tl('story.kicker')}</div>
              <h2 id="workflow-title">{tl('story.h2')}</h2>

              <div className={styles.storyStepCopy}>
                {storySteps.map((step, index) => (
                  <article key={step.index} data-active={activeStep === index} aria-hidden={activeStep !== index}>
                    <div className={styles.stepLabel}>{step.index} / {step.label}</div>
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                  </article>
                ))}
              </div>

              <div className={styles.storyNavigation}>
                <div className={styles.storyRail}><span /></div>
                {storySteps.map((step, index) => (
                  <button
                    key={step.index}
                    type="button"
                    data-active={activeStep === index}
                    onClick={() => scrollToStep(index)}
                    aria-label={tl('story.navButton.aria', { index: step.index, label: step.label })}
                  >
                    <span>{step.index}</span>
                    <i>{step.label}</i>
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.storyVisual} aria-hidden="true">
              <div className={styles.storyDevice}>
                <div className={styles.deviceBar}>
                  <div className={styles.deviceBrand}><span><AudioLines size={14} /></span>{siteName}</div>
                  <div className={styles.deviceCenter}>Biology 204</div>
                  <div className={styles.deviceActions}><Search size={15} /><span /><span /></div>
                </div>

                <div className={styles.deviceBody}>
                  <div className={styles.deviceSidebar}>
                    {[Captions, Languages, BrainCircuit, Share2].map((Icon, index) => (
                      <span key={index} data-active={activeStep === index}><Icon size={17} /></span>
                    ))}
                  </div>
                  <div className={styles.sceneViewport}>
                    {scenes.map((scene, index) => (
                      <div key={index} className={styles.sceneLayer} data-active={activeStep === index} aria-hidden={activeStep !== index}>
                        {scene}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className={styles.deviceShadow} aria-hidden="true" />
              <div className={styles.deviceCaption}>
                <span>{storySteps[activeStep].index}</span>
                {storySteps[activeStep].label}
              </div>
            </div>
          </div>

          <div className={styles.mobileStoryList}>
            {storySteps.map((step, index) => (
              <article key={step.index} className={styles.mobileStoryCard}>
                <div className={styles.stepLabel}>{step.index} / {step.label}</div>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
                <div className={styles.mobileScene} aria-hidden="true">{scenes[index]}</div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="capabilities" className={styles.capabilities} aria-labelledby="capabilities-title">
        <div className={styles.lightNoise} aria-hidden="true" />
        <div className={styles.sectionInner}>
          <header className={styles.capabilitiesHeader} data-reveal>
            <div>
              <span className={styles.lightKicker}>{tl('capabilities.kicker')}</span>
              <h2 id="capabilities-title">{tl('capabilities.h2')}</h2>
            </div>
            <p>{tl('capabilities.p')}</p>
          </header>

          <div className={styles.bentoGrid}>
            <article className={`${styles.bentoCard} ${styles.playbackCard}`} data-reveal>
              <div className={styles.cardTopline}>
                <span><Play size={16} /></span>
                <small>{tl('bento.playback.topline')}</small>
              </div>
              <h3>{tl('bento.playback.h3')}</h3>
              <p>{tl('bento.playback.p')}</p>
              <div className={styles.playbackVisual}>
                <div className={styles.playbackText}>
                  <span>09:42</span>
                  <p>{tl('bento.playback.visual.line1')}</p>
                  <span>09:43</span>
                  <p className={styles.playbackTextActive}>{tl('bento.playback.visual.line2')}</p>
                  <span>09:44</span>
                  <p>{tl('bento.playback.visual.line3')}</p>
                </div>
                <div className={styles.playbackControl}>
                  <span className={styles.playControlButton} aria-hidden="true"><Play size={14} fill="currentColor" /></span>
                  <div className={styles.playbackProgress}><span /></div>
                  <strong>19:28</strong><small>/ 48:02</small>
                </div>
              </div>
            </article>

            <article className={`${styles.bentoCard} ${styles.translationCard}`} data-reveal>
              <div className={styles.cardTopline}>
                <span><Languages size={16} /></span>
                <small>{tl('bento.translation.topline')}</small>
              </div>
              <h3>{tl('bento.translation.h3')}</h3>
              <p>{tl('bento.translation.p')}</p>
              <div className={styles.modeSwitch}>
                <span className={styles.modeSwitchActive}><Cloud size={15} /> Cloud</span>
                <span><Cpu size={15} /> Local</span>
              </div>
              <div className={styles.miniTranslation}>
                <span>Energy is transformed.</span>
                <ArrowDown size={14} />
                <strong>{tl('bento.translation.miniTranslation.result')}</strong>
              </div>
            </article>

            <article className={`${styles.bentoCard} ${styles.aiCard}`} data-reveal>
              <div className={styles.cardTopline}>
                <span><MessageSquareText size={16} /></span>
                <small>{tl('bento.ai.topline')}</small>
              </div>
              <h3>{tl('bento.ai.h3')}</h3>
              <p>{tl('bento.ai.p')}</p>
              <div className={styles.modelOrbit} aria-hidden="true">
                <div className={styles.modelCenter}><BrainCircuit size={22} /></div>
                <span>Claude</span><span>GPT</span><span>DeepSeek</span><span>Custom</span>
              </div>
            </article>

            <article id="ownership" className={`${styles.bentoCard} ${styles.ownershipCard}`} data-reveal>
              <div className={styles.cardTopline}>
                <span><ShieldCheck size={16} /></span>
                <small>{tl('bento.ownership.topline')}</small>
              </div>
              <h3>{tl('bento.ownership.h3')}</h3>
              <p>{tl('bento.ownership.p')}</p>
              <div className={styles.stackVisual}>
                <span><LockKeyhole size={15} /> LectureLive</span>
                <div><i /> <i /> <i /></div>
                <span>MySQL</span><span>Redis</span><span>Cloudreve</span>
              </div>
            </article>

            <article className={`${styles.bentoCard} ${styles.exportCard}`} data-reveal>
              <div className={styles.cardTopline}>
                <span><FileDown size={16} /></span>
                <small>{tl('bento.export.topline')}</small>
              </div>
              <h3>{tl('bento.export.h3')}</h3>
              <p>{tl('bento.export.p')}</p>
              <div className={styles.fileStack}>
                {['DOCX', 'PDF', 'SRT', 'MD', 'JSON'].map((format) => (
                  <span key={format}>{format}</span>
                ))}
              </div>
            </article>
          </div>

          <div className={styles.continuum} data-reveal>
            <div className={styles.continuumHeader}>
              <span>{tl('continuum.header.kicker')}</span>
              <h3>{tl('continuum.header.h3')}</h3>
            </div>
            <div className={styles.continuumTrack}>
              <div className={styles.continuumLine}><span /></div>
              {[
                [Mic2, tl('continuum.node.0')],
                [Captions, tl('continuum.node.1')],
                [Languages, tl('continuum.node.2')],
                [Sparkles, tl('continuum.node.3')],
                [MessageSquareText, tl('continuum.node.4')],
                [Share2, tl('continuum.node.5')],
              ].map(([Icon, label], index) => {
                const ItemIcon = Icon as typeof Mic2;
                return (
                  <div key={label as string} className={styles.continuumNode} style={{ transitionDelay: `${index * 80}ms` }}>
                    <span><ItemIcon size={18} /></span>
                    <small>{label as string}</small>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className={styles.finalCta} aria-labelledby="final-cta-title">
        <div className={styles.ctaOrbit} aria-hidden="true">
          <span className={styles.orbitOne}>{tl('finalCta.orbit.0')}</span>
          <span className={styles.orbitTwo}>{tl('finalCta.orbit.1')}</span>
          <span className={styles.orbitThree}>{tl('finalCta.orbit.2')}</span>
          <i /><i /><i />
        </div>
        <div className={styles.ctaContent} data-reveal>
          <div className={styles.ctaMark}><AudioLines size={26} /></div>
          <span>{tl('finalCta.kicker')}</span>
          <h2 id="final-cta-title">{tl('finalCta.h2')}</h2>
          <p>{tl('finalCta.p')}</p>
          <div className={styles.ctaActions}>
            <Link href={primaryHref} className={styles.heroPrimary}>
              <span>{primaryLabel}</span><ArrowRight size={18} />
            </Link>
            {!isAuthenticated && allowRegistration && (
              <Link href="/login" className={styles.ctaLogin}>{tl('finalCta.login')}</Link>
            )}
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerBrand}>
          <BrandMark logoPath={logoPath} />
          <strong>{siteName}</strong>
          <span>{tl('footer.tagline')}</span>
        </div>
        <div className={styles.footerLinks}>
          <Link href="/privacy">{tl('footer.links.privacy')}</Link>
          <Link href="/terms">{tl('footer.links.terms')}</Link>
          <Link href="/login">{tl('footer.links.login')}</Link>
        </div>
        <small>© {new Date().getFullYear()} {siteName}. {tl('footer.copyright')}</small>
      </footer>
    </main>
  );
}
