'use client';

// 公开分享观看页面 — 无需登录即可访问
// 安全注意事项：
// 1. 不访问任何认证相关的 store（authStore / settingsStore）
// 2. 所有外部数据通过 React 的 JSX 转义防 XSS
// 3. shareToken 在服务端通过 sanitizeToken 清理
// 4. 使用独立的 viewerSettingsStore，与主应用完全隔离
// 5. 不发起任何需要认证的 API 请求

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLiveShare } from '@/hooks/useLiveShare';
import { useIsMobile } from '@/hooks/useIsMobile';
import { hasPreviewContent } from '@/lib/transcriptPreview';
import { useI18n } from '@/lib/i18n';
import { useTranscriptStore } from '@/stores/transcriptStore';
import { useSummaryStore } from '@/stores/summaryStore';
import { useSharedLinksStore } from '@/stores/sharedLinksStore';
import { useTranslationStore } from '@/stores/translationStore';
import { useViewerSettingsStore } from '@/stores/viewerSettingsStore';
import { SettingsToggle, SettingsDrawer } from '@/components/viewer/ViewerSettingsPanel';
import LiveShareBadge from '@/components/session/LiveShareBadge';
import { ViewerTranscriptPanel } from './ViewerTranscriptPanel';
import { FONT_SIZE_MAP, sanitizeDisplayText } from './viewerShared';
import {
  BookOpen,
  AlertCircle,
  Sparkles,
  Loader2,
  Calendar,
  Clock,
  Globe,
  FileText,
} from 'lucide-react';
import type { TranscriptSegment } from '@/types/transcript';
import type { SummaryBlock } from '@/types/summary';
import type { ViewerConnectionState } from '@/lib/liveShare/viewer';

// ─── 工具函数 ───

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// ─── 内联摘要面板（观看者专用） ───

function ViewerSummaryPanel() {
  const { t } = useI18n();
  const summaryBlocks = useSummaryStore((s) => s.blocks);
  const fontSize = useViewerSettingsStore((s) => s.fontSize);
  const compact = useViewerSettingsStore((s) => s.compact);
  const theme = useViewerSettingsStore((s) => s.theme);

  const fs = FONT_SIZE_MAP[fontSize];

  return (
    <div className={`flex flex-col h-full rounded-xl border overflow-hidden ${
      theme === 'dark'
        ? 'bg-charcoal-800 border-charcoal-600'
        : 'bg-white border-cream-200'
    }`}>
      <div className={`flex items-center gap-2 px-4 py-3 border-b ${
        theme === 'dark' ? 'border-charcoal-600' : 'border-cream-100'
      }`}>
        <Sparkles className={`w-4 h-4 ${theme === 'dark' ? 'text-cream-500' : 'text-charcoal-400'}`} />
        <span className={`text-xs font-semibold ${
          theme === 'dark' ? 'text-cream-200' : 'text-charcoal-600'
        }`}>
          {t('viewer.summary')}
        </span>
        <span className={`text-[10px] ${theme === 'dark' ? 'text-cream-600' : 'text-charcoal-400'}`}>
          {t('viewer.readOnly')}
        </span>
      </div>
      <div className={`flex-1 overflow-y-auto p-4 ${compact ? 'space-y-2' : 'space-y-3'}`}>
        {summaryBlocks.length === 0 ? (
          <div className={`text-center text-sm py-10 ${
            theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-400'
          }`}>
            <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>{t('viewer.liveSummaryPlaceholder')}</p>
          </div>
        ) : (
          summaryBlocks.map((block) => (
            <div
              key={block.id}
              className={`rounded-lg border p-3 ${
                theme === 'dark'
                  ? 'border-charcoal-600 bg-charcoal-700/50'
                  : 'border-cream-200 bg-cream-50'
              }`}
            >
              <div className={`mb-2 ${fs.timestamp} font-mono ${
                theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-400'
              }`}>
                {formatDuration(block.timeRange.startMs)} - {formatDuration(block.timeRange.endMs)}
              </div>
              <p className={`${fs.summary} ${
                theme === 'dark' ? 'text-cream-200' : 'text-charcoal-700'
              }`}>
                {sanitizeDisplayText(block.summary)}
              </p>
              {block.keyPoints.length > 0 && (
                <div className="mt-2 space-y-1">
                  {block.keyPoints.map((point, index) => (
                    <p key={`${block.id}-${index}`} className={`${fs.keypoint} ${
                      theme === 'dark' ? 'text-cream-400' : 'text-charcoal-500'
                    }`}>
                      {/* 安全：React JSX 自动转义文本内容 */}
                      • {sanitizeDisplayText(point)}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ViewerTranslationPanel() {
  const { t } = useI18n();
  const segments = useTranscriptStore((s) => s.segments);
  const translations = useTranslationStore((s) => s.translations);
  const translationEntries = useTranslationStore((s) => s.translationEntries);
  const currentPreviewText = useTranscriptStore((s) => s.currentPreviewText);
  const currentPreviewTranslationText = useTranscriptStore(
    (s) => s.currentPreviewTranslationText
  );
  const fontSize = useViewerSettingsStore((s) => s.fontSize);
  const compact = useViewerSettingsStore((s) => s.compact);
  const theme = useViewerSettingsStore((s) => s.theme);
  const fs = FONT_SIZE_MAP[fontSize];
  const hasPreviewText = hasPreviewContent(currentPreviewText);
  const hasPreviewTranslation = hasPreviewContent(currentPreviewTranslationText);
  const showPreviewWaiting =
    hasPreviewText &&
    currentPreviewTranslationText.state === 'waiting' &&
    !hasPreviewTranslation;

  return (
    <div className={`flex h-full flex-col rounded-xl border overflow-hidden ${
      theme === 'dark'
        ? 'bg-charcoal-800 border-charcoal-600'
        : 'bg-white border-cream-200'
    }`}>
      <div className={`flex items-center justify-between px-4 py-3 border-b ${
        theme === 'dark' ? 'border-charcoal-600' : 'border-cream-100'
      }`}>
        <div className="flex items-center gap-2">
          <Globe className={`w-4 h-4 ${theme === 'dark' ? 'text-cream-500' : 'text-charcoal-400'}`} />
          <span className={`text-xs font-semibold ${theme === 'dark' ? 'text-cream-100' : 'text-charcoal-700'}`}>
            {t('viewer.liveTranslation')}
          </span>
        </div>
        <span className={`text-[11px] ${theme === 'dark' ? 'text-cream-500' : 'text-charcoal-400'}`}>
          {t('transcriptPanel.segmentCount', { n: segments.length })}
        </span>
      </div>
      <div className={`flex-1 overflow-y-auto px-4 ${compact ? 'py-2 space-y-2' : 'py-4 space-y-3'}`}>
        {segments.length === 0 && !hasPreviewTranslation && !showPreviewWaiting ? (
          <div className={`flex h-full flex-col items-center justify-center ${
            theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-300'
          }`}>
            <Globe className="mb-3 h-10 w-10 opacity-50" />
            <p className="text-sm">{t('viewer.waitTranslation')}</p>
          </div>
        ) : (
          segments.map((segment) => {
            const translation = translationEntries[segment.id]?.text ?? translations[segment.id] ?? '';
            return (
              <div
                key={segment.id}
                className={`border-b pb-3 last:border-0 ${
                  theme === 'dark' ? 'border-charcoal-700' : 'border-cream-100'
                }`}
              >
                <div className={`mb-1 ${fs.timestamp} font-mono ${
                  theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-300'
                }`}>
                  {sanitizeDisplayText(segment.timestamp)}
                </div>
                <p className={`${fs.translation} leading-relaxed ${
                  translation
                    ? theme === 'dark'
                      ? 'text-rust-400'
                      : 'text-rust-700'
                    : theme === 'dark'
                      ? 'text-charcoal-500'
                      : 'text-charcoal-300'
                }`}>
                  {translation ? sanitizeDisplayText(translation) : t('translationPanel.translating')}
                </p>
              </div>
            );
          })
        )}

        {(hasPreviewTranslation || showPreviewWaiting) && (
          <div
            className={`border-b pb-3 last:border-0 ${
              theme === 'dark' ? 'border-charcoal-700' : 'border-cream-100'
            }`}
          >
            <div className={`mb-1 ${fs.timestamp} font-mono ${
              theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-300'
            }`}>
              {t('translationPanel.translating')}
            </div>
            {hasPreviewTranslation ? (
              <p className={`${fs.translation} leading-relaxed`}>
                {currentPreviewTranslationText.finalText ? (
                  <span className={theme === 'dark' ? 'text-rust-300' : 'text-rust-700'}>
                    {sanitizeDisplayText(currentPreviewTranslationText.finalText)}
                  </span>
                ) : null}
                {currentPreviewTranslationText.nonFinalText ? (
                  <span className={theme === 'dark' ? 'text-rust-400' : 'text-rust-500'}>
                    {sanitizeDisplayText(currentPreviewTranslationText.nonFinalText)}
                  </span>
                ) : null}
              </p>
            ) : (
              <p className={`${fs.translation} italic ${
                theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-300'
              }`}>
                {t('translationPanel.translating')}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 回放风格的转录面板（已完成会话专用） ───

function PlaybackStyleTranscriptPanel({ segments: segs, translations: trans }: {
  segments: TranscriptSegment[];
  translations: Record<string, string>;
}) {
  const { t } = useI18n();
  const theme = useViewerSettingsStore((s) => s.theme);
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div className={`min-w-0 flex-1 rounded-xl border flex flex-col ${
      theme === 'dark'
        ? 'bg-charcoal-800 border-charcoal-600'
        : 'bg-white border-cream-200'
    }`}>
      <div className={`px-4 py-3 border-b flex items-center gap-2 flex-shrink-0 ${
        theme === 'dark' ? 'border-charcoal-600' : 'border-cream-100'
      }`}>
        <FileText className={`w-4 h-4 ${theme === 'dark' ? 'text-cream-500' : 'text-charcoal-400'}`} />
        <span className={`text-xs font-semibold ${theme === 'dark' ? 'text-cream-200' : 'text-charcoal-600'}`}>
          {t('viewer.transcriptRecord')}
        </span>
        <span className={`text-[10px] ${theme === 'dark' ? 'text-cream-600' : 'text-charcoal-400'}`}>
          {t('transcriptPanel.segmentCount', { n: segs.length })}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {segs.length === 0 ? (
          <div className={`text-center text-sm py-12 ${
            theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-400'
          }`}>
            <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>{t('viewer.noTranscript')}</p>
          </div>
        ) : (
          segs.map((seg) => {
            const translation = trans[seg.id] || seg.translatedText;
            return (
              <div
                key={seg.id}
                className={`p-3 rounded-lg border ${
                  theme === 'dark'
                    ? 'border-transparent hover:bg-charcoal-700/50'
                    : 'border-transparent hover:bg-cream-50'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] font-mono ${
                    theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-400'
                  }`}>
                    {sanitizeDisplayText(seg.timestamp)}
                  </span>
                  {seg.language && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      theme === 'dark'
                        ? 'bg-charcoal-700 text-cream-400'
                        : 'bg-cream-100 text-charcoal-500'
                    }`}>
                      {sanitizeDisplayText(seg.language).toUpperCase()}
                    </span>
                  )}
                </div>
                <p className={`text-sm leading-relaxed ${
                  theme === 'dark' ? 'text-cream-200' : 'text-charcoal-800'
                }`}>
                  {sanitizeDisplayText(seg.text)}
                </p>
                {translation && (
                  <p className={`text-sm leading-relaxed mt-1 ${
                    theme === 'dark' ? 'text-rust-400/80' : 'text-rust-600/80'
                  }`}>
                    {sanitizeDisplayText(translation)}
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── 回放风格的右侧面板（摘要+信息 Tab） ───

type ViewerTab = 'summary' | 'info';

function PlaybackStyleRightPanel({ summaries, sessionInfo }: {
  summaries: SummaryBlock[];
  sessionInfo: { sourceLang: string; targetLang: string; createdAt?: string; durationMs?: number } | null;
}) {
  const { t, locale } = useI18n();
  const theme = useViewerSettingsStore((s) => s.theme);
  const [activeTab, setActiveTab] = useState<ViewerTab>('summary');

  return (
    <div className={`w-[380px] flex-shrink-0 rounded-xl border flex flex-col ${
      theme === 'dark'
        ? 'bg-charcoal-800 border-charcoal-600'
        : 'bg-white border-cream-200'
    }`}>
      {/* Tab 栏 */}
      <div className={`flex border-b flex-shrink-0 ${
        theme === 'dark' ? 'border-charcoal-600' : 'border-cream-100'
      }`}>
        {([
          { key: 'summary' as const, icon: Sparkles, label: t('viewer.summary') },
          { key: 'info' as const, icon: FileText, label: t('viewer.info') },
        ]).map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium
                       transition-colors border-b-2 ${
                         activeTab === key
                           ? 'border-rust-500 text-rust-600'
                           : theme === 'dark'
                             ? 'border-transparent text-cream-500 hover:text-cream-300'
                             : 'border-transparent text-charcoal-400 hover:text-charcoal-600'
                       }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 min-h-0">
        {activeTab === 'summary' && (
          <div className="space-y-4">
            {summaries.length === 0 ? (
              <div className={`text-center text-sm py-8 ${
                theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-400'
              }`}>
                <Sparkles className="w-6 h-6 mx-auto mb-2 opacity-30" />
                <p>{t('viewer.noSummary')}</p>
              </div>
            ) : (
              summaries.map((block, i) => (
                <div key={i} className={`p-3 rounded-lg border ${
                  theme === 'dark'
                    ? 'bg-charcoal-700/50 border-charcoal-600'
                    : 'bg-cream-50 border-cream-200'
                }`}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-[10px] font-mono ${
                      theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-400'
                    }`}>
                      {formatDuration(block.timeRange.startMs)} – {formatDuration(block.timeRange.endMs)}
                    </span>
                  </div>
                  <p className={`text-sm mb-2 ${
                    theme === 'dark' ? 'text-cream-200' : 'text-charcoal-700'
                  }`}>
                    {sanitizeDisplayText(block.summary)}
                  </p>
                  {block.keyPoints.length > 0 && (
                    <ul className="space-y-1">
                      {block.keyPoints.map((pt, j) => (
                        <li key={j} className={`text-xs flex gap-1.5 ${
                          theme === 'dark' ? 'text-cream-400' : 'text-charcoal-600'
                        }`}>
                          <span className="text-rust-400">•</span>
                          {sanitizeDisplayText(pt)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'info' && sessionInfo && (
          <div className="space-y-3">
            {[
              { label: t('viewer.infoStatus'), value: t('viewer.statusCompleted') },
              { label: t('viewer.infoDuration'), value: sessionInfo.durationMs ? formatDuration(sessionInfo.durationMs) : '—' },
              { label: t('viewer.infoSourceLanguage'), value: sessionInfo.sourceLang?.toUpperCase() || '—' },
              { label: t('viewer.infoTargetLanguage'), value: sessionInfo.targetLang?.toUpperCase() || '—' },
              {
                label: t('viewer.infoCreatedAt'),
                value: sessionInfo.createdAt
                  ? new Date(sessionInfo.createdAt).toLocaleString(
                      locale === 'zh' ? 'zh-CN' : 'en-US'
                    )
                  : '—',
              },
            ].map(({ label, value }) => (
              <div key={label} className={`flex justify-between items-center py-1.5 border-b last:border-0 ${
                theme === 'dark' ? 'border-charcoal-600' : 'border-cream-100'
              }`}>
                <span className={`text-xs ${theme === 'dark' ? 'text-cream-500' : 'text-charcoal-400'}`}>{label}</span>
                <span className={`text-xs font-medium ${theme === 'dark' ? 'text-cream-200' : 'text-charcoal-700'}`}>{value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 连接/完整性提示条 ───

/**
 * M2 + H1 的可见化出口：
 * - reconnecting：观众端此前对断连零反馈（viewer.ts 没有 connect_error/disconnect
 *   监听），画面会静止在最后一帧却看不出任何异常；
 * - truncated：主播端因传输体积上限丢过最早的一段 backlog，历史不完整。
 *
 * 注：这里的文案没有走 i18n 字典，而是就地按 locale 分支——本批只允许改直播分享
 * 相关文件，不动共享的 locales/*.ts（并行批次同时在编辑）。合并后建议提取为
 * viewer.reconnecting / viewer.backlogTruncated 两个键。
 */
function ViewerNotice({
  connectionState,
  backlogTruncated,
  theme,
  locale,
}: {
  connectionState: ViewerConnectionState;
  backlogTruncated: boolean;
  theme: 'light' | 'dark';
  locale: string;
}) {
  const reconnecting = connectionState === 'reconnecting';
  if (!reconnecting && !backlogTruncated) return null;

  const message = reconnecting
    ? locale === 'zh'
      ? '连接已断开，正在自动重连…'
      : 'Connection lost — reconnecting…'
    : locale === 'zh'
      ? '较早的内容因体量过大已省略，仅显示最近部分。'
      : 'Earlier content was omitted because the backlog was too large; showing the most recent part.';

  return (
    <div
      role="status"
      className={`flex items-center gap-2 px-4 py-1.5 text-[11px] border-b ${
        reconnecting
          ? theme === 'dark'
            ? 'border-charcoal-600 bg-charcoal-700 text-cream-300'
            : 'border-cream-200 bg-cream-100 text-charcoal-600'
          : theme === 'dark'
            ? 'border-charcoal-600 bg-charcoal-800 text-cream-500'
            : 'border-cream-200 bg-white text-charcoal-500'
      }`}
    >
      {reconnecting ? (
        <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
      ) : (
        <AlertCircle className="w-3 h-3 flex-shrink-0" />
      )}
      <span className="truncate">{message}</span>
    </div>
  );
}

// ─── 主页面 ───

export default function ViewerPage() {
  const { t, locale } = useI18n();
  const isMobile = useIsMobile();
  const searchParams = useSearchParams();
  const shareToken = searchParams.get('token') || searchParams.get('share');
  const { joinAsViewer, leaveAsViewer } = useLiveShare();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionTitle, setSessionTitle] = useState('Live Session');
  const [sessionInfo, setSessionInfo] = useState<{
    sourceLang: string;
    targetLang: string;
    status: string;
    createdAt?: string;
    durationMs?: number;
  } | null>(null);

  const addFinalSegment = useTranscriptStore((s) => s.addFinalSegment);
  const clearTranscript = useTranscriptStore((s) => s.clearAll);
  const updatePreview = useTranscriptStore((s) => s.updatePreview);
  const updatePreviewTranslation = useTranscriptStore((s) => s.updatePreviewTranslation);
  const addBlock = useSummaryStore((s) => s.addBlock);
  const clearSummaries = useSummaryStore((s) => s.clearAll);
  const summaryBlocks = useSummaryStore((s) => s.blocks);
  const rememberViewedLink = useSharedLinksStore((s) => s.rememberViewedLink);
  const setTranslation = useTranslationStore((s) => s.setTranslation);
  const clearTranslations = useTranslationStore((s) => s.clearAll);
  const translations = useTranslationStore((s) => s.translations);
  const segments = useTranscriptStore((s) => s.segments);

  // 观看者设置
  const theme = useViewerSettingsStore((s) => s.theme);
  const fontSize = useViewerSettingsStore((s) => s.fontSize);
  const setFontSize = useViewerSettingsStore((s) => s.setFontSize);
  const compact = useViewerSettingsStore((s) => s.compact);
  const setCompact = useViewerSettingsStore((s) => s.setCompact);
  const autoScroll = useViewerSettingsStore((s) => s.autoScroll);
  const setAutoScroll = useViewerSettingsStore((s) => s.setAutoScroll);
  const [mobileTab, setMobileTab] = useState<'transcript' | 'translation' | 'summary'>('transcript');

  // 是否为已完成会话的静态查看模式
  const [isCompleted, setIsCompleted] = useState(false);
  // 供 socket 回调读取最新完成态（回调闭包捕获的是首帧 state，会读到陈旧值）
  const isCompletedRef = useRef(false);

  /**
   * M2：观众端连接态。此前 viewer.ts 只注册业务事件，没有任何 connect_error /
   * disconnect 监听 —— WS 不可达、Origin 被拒（server/websocket.ts 的 io.use）、
   * 每 IP 连接数超限时，loading spinner 会永久悬挂，用户完全不知道发生了什么。
   */
  const [connectionState, setConnectionState] =
    useState<ViewerConnectionState>('connecting');
  /** H1：主播端因传输体积上限截断过 backlog，本次拿到的历史不是完整的。 */
  const [backlogTruncated, setBacklogTruncated] = useState(false);

  useEffect(() => {
    if (!shareToken) {
      setError(t('viewer.missingShareLink'));
      setLoading(false);
      return;
    }

    // 安全：验证 token 格式（仅允许 base64url 字符）
    if (!/^[A-Za-z0-9_-]+$/.test(shareToken)) {
      setError(t('viewer.invalidShareLink'));
      setLoading(false);
      return;
    }

    clearTranscript();
    clearSummaries();
    clearTranslations();

    // M1：socket 是在 fetch 的 .then() 里才建的，而 React 的 cleanup 只会在**卸载
    // 那一刻**跑一次 leaveAsViewer()——此时 viewerInstance 还是 null，是个空操作；
    // 随后迟到的 .then() 照常 joinAsViewer，建出的 socket 再也没有任何代码路径断得掉
    // （viewerInstance 是模块级单例，跟着整个 SPA 生命周期活着），永久计入服务端
    // viewer_count。用 cancelled 闸门：resolve 之后一律先复查归属，已卸载就什么都不做。
    let cancelled = false;

    fetch(`/api/share/view/${encodeURIComponent(shareToken)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
          setLoading(false);
          return;
        }

        const title = sanitizeDisplayText(data.session?.title) || t('viewer.defaultTitle');
        const status = data.session?.status || 'LIVE';
        setSessionTitle(title);
        setSessionInfo({
          sourceLang: sanitizeDisplayText(data.session?.sourceLang) || '',
          targetLang: sanitizeDisplayText(data.session?.targetLang) || '',
          status: sanitizeDisplayText(status),
          createdAt: data.session?.createdAt,
          durationMs: data.session?.durationMs,
        });

        // 「最近看过的分享」落 localStorage（sharedLinksStore 走 zustand persist）。
        // 存储不可用时（Safari 无痕、企业策略禁用、配额耗尽）写入会抛，而这里身处
        // .then() 内部，抛出去就被下面的 .catch() 吞成「加载会话失败」——一个纯锦上添花
        // 的历史记录把整个观看功能拖挂。就地兜住：记不住不影响看直播。
        try {
          rememberViewedLink({
            token: shareToken,
            url: window.location.href,
            sessionId: data.sessionId,
            title,
            sourceLang: data.session?.sourceLang || '',
            targetLang: data.session?.targetLang || '',
            status,
            viewedAt: new Date().toISOString(),
          });
        } catch {
          // 忽略：仅影响「最近看过」列表
        }

        // 已完成/已归档的会话：重定向到 playback 页面（完整回放体验）
        if (status === 'COMPLETED' || status === 'ARCHIVED') {
          window.location.replace(
            `/session/${data.sessionId}/playback?token=${encodeURIComponent(shareToken)}`
          );
          return;
        }

        // 进行中的会话：连接 WebSocket 实时接收数据
        joinAsViewer(shareToken, {
          // M2：连接态 → UI。'reconnecting' 只挂一条提示条，不清内容——主播瞬断
          // （Wi-Fi 切换）在服务端有 15s 宽限，重连后 'connect' 会重新 join 并拿到
          // 全量 initial_state（C6），把内容清掉纯属自找闪烁。
          onConnectionChange: (state, info) => {
            if (cancelled) return;
            setConnectionState(state);
            if (state !== 'closed') return;

            // 终态：服务端主动踢（撤销/过期驱逐、优雅关停强断）或握手被拒。
            setLoading(false);
            // 录制正常结束（SHARE_OFFLINE 已把页面切成静态完成态）后的静默断开
            // 不是错误，别把已经好好的完成视图盖成错误页（transition 模式就是静默断）。
            if (isCompletedRef.current) return;
            setError(
              (prev) => prev ?? (info?.message || t('viewer.loadSessionFailed'))
            );
          },
          onInitialState: (snapshot) => {
            // C6：每次 socket.io 自动重连都会重新 emit join → 服务端重发全量快照，
            // 而 addFinalSegment/addBlock 按 id 追加不去重，盲目重填会让转录/摘要
            // 成倍复制。重填前先清空三个 store，保证快照即为当前全量、无重复。
            clearTranscript();
            clearSummaries();
            clearTranslations();
            if (snapshot.segments) {
              (snapshot.segments as TranscriptSegment[]).forEach(addFinalSegment);
            }
            if (snapshot.translations) {
              Object.entries(snapshot.translations).forEach(([segmentId, translation]) => {
                setTranslation(segmentId, translation);
              });
            }
            if (snapshot.summaryBlocks) {
              (snapshot.summaryBlocks as SummaryBlock[]).forEach(addBlock);
            }
            // 恢复当前预览文本
            if (snapshot.previewText) {
              updatePreview(snapshot.previewText);
            }
            if (snapshot.previewTranslation) {
              updatePreviewTranslation(snapshot.previewTranslation);
            }
            // H1：主播端/服务端截断过 backlog 时明确告知观众，别让残缺历史冒充完整。
            setBacklogTruncated(snapshot.truncated === true);
            setLoading(false);
          },
          onTranscriptDelta: (delta) => {
            // 新段落到达时清空预览（该段落已从预览变为正式段落）
            updatePreview({ finalText: '', nonFinalText: '' });
            updatePreviewTranslation({
              finalText: '',
              nonFinalText: '',
              state: 'idle',
              sourceLanguage: null,
            });
            addFinalSegment(delta as TranscriptSegment);
          },
          onTranslationDelta: ({ segmentId, translation }) => {
            setTranslation(segmentId, translation);
          },
          onSummaryUpdate: (block) => {
            addBlock(block as SummaryBlock);
          },
          onStatusUpdate: ({ status: newStatus }) => {
            if (cancelled) return;
            if (newStatus === 'SERVER_SHUTDOWN') {
              // M2：WS 进程优雅关停会向所有 socket 广播这条（server/websocket.ts），
              // 此前全仓零消费。它不代表直播结束，只代表「本次连接即将中断」——
              // 进程重启后 socket.io 会自动重连，所以只提示、不切静态完成态。
              setConnectionState('reconnecting');
              return;
            }
            if (newStatus === 'SHARE_OFFLINE' || newStatus === 'COMPLETED') {
              // 录制结束：清空预览，切换到静态模式
              updatePreview({ finalText: '', nonFinalText: '' });
              updatePreviewTranslation({
                finalText: '',
                nonFinalText: '',
                state: 'idle',
                sourceLanguage: null,
              });
              isCompletedRef.current = true;
              setIsCompleted(true);
              setSessionInfo((prev) => prev ? { ...prev, status: newStatus } : prev);
            } else if (newStatus === 'SHARE_LIVE') {
              // C3：主播瞬断（Wi-Fi 切换 / ping 超时）后重连成功，服务端广播 SHARE_LIVE。
              // 观众自身 socket 通常并未断开、内存快照仍在，只是此前可能因误报的
              // SHARE_OFFLINE 被单向锁成静态完成态——这里解锁回实时视图，后续增量继续渲染。
              isCompletedRef.current = false;
              setIsCompleted(false);
              setSessionInfo((prev) => prev ? { ...prev, status: 'LIVE' } : prev);
            }
          },
          onPreviewUpdate: ({ previewText, previewTranslation }) => {
            updatePreview(previewText);
            updatePreviewTranslation(previewTranslation);
          },
          onError: (err) => {
            if (cancelled) return;
            setError(err.message);
            setLoading(false);
          },
        });
      })
      .catch(() => {
        if (cancelled) return;
        setError(t('viewer.loadSessionFailed'));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      leaveAsViewer();
      clearTranscript();
      clearSummaries();
      clearTranslations();
    };
  }, [
    shareToken,
    joinAsViewer,
    leaveAsViewer,
    addFinalSegment,
    addBlock,
    clearTranscript,
    clearSummaries,
    clearTranslations,
    rememberViewedLink,
    setTranslation,
    updatePreview,
    updatePreviewTranslation,
    t,
  ]);

  // 错误页面
  if (error) {
    return (
      <div className={`min-h-[100dvh] flex items-center justify-center ${
        theme === 'dark' ? 'bg-charcoal-900' : 'bg-cream-50'
      }`}>
        <div className="text-center max-w-sm px-6">
          <AlertCircle className="w-12 h-12 mx-auto mb-4 text-red-400" />
          <h2 className={`text-lg font-semibold mb-2 ${
            theme === 'dark' ? 'text-cream-100' : 'text-charcoal-800'
          }`}>
            {t('viewer.inaccessible')}
          </h2>
          <p className={`text-sm ${
            theme === 'dark' ? 'text-cream-400' : 'text-charcoal-600'
          }`}>
            {error}
          </p>
          <p className={`text-xs mt-3 ${
            theme === 'dark' ? 'text-charcoal-500' : 'text-charcoal-400'
          }`}>
            {t('viewer.checkLink')}
          </p>
        </div>
      </div>
    );
  }

  // 加载中
  if (loading) {
    return (
      <div className={`min-h-[100dvh] flex items-center justify-center ${
        theme === 'dark' ? 'bg-charcoal-900' : 'bg-cream-50'
      }`}>
        <div className="text-center">
          <Loader2 className="w-8 h-8 mx-auto mb-3 text-rust-500 animate-spin" />
          <p className={`text-sm ${
            theme === 'dark' ? 'text-cream-400' : 'text-charcoal-500'
          }`}>
            {isCompleted ? t('viewer.loadingTranscript') : t('viewer.connectingLive')}
          </p>
        </div>
      </div>
    );
  }

  // 已完成会话：回放风格布局（与 playback 页面一致，但无音频播放器）
  if (isCompleted) {
    const effectiveDurationMs = sessionInfo?.durationMs || segments.reduce((max, seg) => {
      const endMs = typeof seg.globalEndMs === 'number' ? seg.globalEndMs : seg.endMs;
      return Math.max(max, endMs);
    }, 0);

    if (isMobile) {
      return (
        <div className={`h-[100dvh] flex flex-col overflow-hidden ${
          theme === 'dark' ? 'bg-charcoal-900' : 'bg-cream-50'
        }`}>
          <header className={`border-b px-4 py-3 ${
            theme === 'dark'
              ? 'bg-charcoal-800 border-charcoal-600'
              : 'bg-white border-cream-200'
          }`}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h1 className={`truncate text-sm font-semibold ${
                  theme === 'dark' ? 'text-cream-100' : 'text-charcoal-800'
                }`}>
                  {sessionTitle}
                </h1>
                <p className={`mt-1 text-[11px] ${
                  theme === 'dark' ? 'text-cream-500' : 'text-charcoal-400'
                }`}>
                  {t('viewer.completedMeta')} · {sessionInfo?.sourceLang.toUpperCase()} → {sessionInfo?.targetLang.toUpperCase()}
                </p>
              </div>
              <SettingsToggle />
            </div>
          </header>

          <div className={`border-b px-2 backdrop-blur-md ${
              theme === 'dark'
                ? 'border-charcoal-600 bg-charcoal-800/95'
                : 'border-cream-200 bg-white/95'
            }`}>
            <div className="flex">
              {[
                ['transcript', t('viewer.tabsTranscript')],
                ['translation', t('viewer.tabsTranslation')],
                ['summary', t('viewer.tabsSummary')],
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setMobileTab(key as 'transcript' | 'translation' | 'summary')}
                  className={`flex-1 border-b-2 px-3 py-2 text-xs font-medium ${
                    mobileTab === key
                      ? 'border-rust-500 text-rust-600'
                      : theme === 'dark'
                        ? 'border-transparent text-cream-500'
                        : 'border-transparent text-charcoal-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-hidden p-3">
            {mobileTab === 'transcript' ? (
              <PlaybackStyleTranscriptPanel segments={segments} translations={translations} />
            ) : null}
            {mobileTab === 'translation' ? <ViewerTranslationPanel /> : null}
            {mobileTab === 'summary' ? <ViewerSummaryPanel /> : null}
          </div>

          <div className={`border-t px-3 py-3 safe-bottom ${
            theme === 'dark'
              ? 'border-charcoal-600 bg-charcoal-800'
              : 'border-cream-200 bg-white'
          }`}>
            <div className="flex items-center justify-between gap-2 text-xs">
              <button
                onClick={() =>
                  setFontSize(
                    fontSize === 'small' ? 'medium' : fontSize === 'medium' ? 'large' : 'small'
                  )
                }
                className={`rounded-full px-3 py-2 ${theme === 'dark' ? 'bg-charcoal-700 text-cream-200' : 'bg-cream-100 text-charcoal-700'}`}
              >
                Aa {fontSize}
              </button>
              <button
                onClick={() => setCompact(!compact)}
                className={`rounded-full px-3 py-2 ${theme === 'dark' ? 'bg-charcoal-700 text-cream-200' : 'bg-cream-100 text-charcoal-700'}`}
              >
                {compact ? t('viewer.expanded') : t('viewer.compact')}
              </button>
              <button
                onClick={() => setAutoScroll(!autoScroll)}
                className={`rounded-full px-3 py-2 ${theme === 'dark' ? 'bg-charcoal-700 text-cream-200' : 'bg-cream-100 text-charcoal-700'}`}
              >
                {autoScroll ? t('viewer.autoScroll') : t('viewer.manualScroll')}
              </button>
            </div>
          </div>

          <SettingsDrawer />
        </div>
      );
    }

    return (
      <div className={`h-screen flex flex-col overflow-hidden ${
        theme === 'dark' ? 'bg-charcoal-900' : 'bg-cream-50'
      }`}>
        {/* 头部 — 与 playback 页面一致的风格 */}
        <header className={`flex-shrink-0 backdrop-blur-md border-b z-30 ${
          theme === 'dark'
            ? 'bg-charcoal-800/95 border-charcoal-600'
            : 'bg-white/95 border-cream-200'
        }`}>
          <div className="flex items-center justify-between px-5 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 bg-rust-500 rounded-lg flex items-center justify-center flex-shrink-0">
                <BookOpen className="w-4 h-4 text-white" />
              </div>
              <div className="min-w-0">
                <h1 className={`font-serif font-bold text-base leading-tight truncate ${
                  theme === 'dark' ? 'text-cream-100' : 'text-charcoal-800'
                }`}>
                  {sessionTitle}
                </h1>
                <div className={`flex items-center gap-3 text-[11px] mt-0.5 ${
                  theme === 'dark' ? 'text-cream-500' : 'text-charcoal-400'
                }`}>
                  {sessionInfo?.createdAt && (
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {new Date(sessionInfo.createdAt).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
                        year: 'numeric', month: 'long', day: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                  )}
                  {effectiveDurationMs > 0 && (
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatDuration(effectiveDurationMs)}
                    </span>
                  )}
                  {sessionInfo && (
                    <span className="flex items-center gap-1">
                      <Globe className="w-3 h-3" />
                      {sessionInfo.sourceLang.toUpperCase()} → {sessionInfo.targetLang.toUpperCase()}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <span className={`text-[11px] px-2 py-1 rounded-full font-medium ${
                theme === 'dark'
                  ? 'bg-charcoal-700 text-cream-400'
                  : 'bg-cream-200 text-charcoal-600'
              }`}>
                {t('viewer.statusCompleted')}
              </span>
              <SettingsToggle />
            </div>
          </div>
        </header>

        {/* 内容区域：与 playback 页面一致的两栏布局 */}
        <div className="flex-1 flex gap-4 p-4 min-h-0 overflow-hidden">
          <PlaybackStyleTranscriptPanel segments={segments} translations={translations} />
          <PlaybackStyleRightPanel summaries={summaryBlocks} sessionInfo={sessionInfo} />
        </div>

        {/* 设置抽屉 */}
        <SettingsDrawer />
      </div>
    );
  }

  // 直播中：实时观看布局
  if (isMobile) {
    return (
      <div className={`h-[100dvh] flex flex-col overflow-hidden ${
        theme === 'dark' ? 'bg-charcoal-900' : 'bg-cream-50'
      }`}>
        <header className={`border-b px-4 py-3 ${
          theme === 'dark'
            ? 'bg-charcoal-800 border-charcoal-600'
            : 'bg-white border-cream-200'
        }`}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className={`truncate text-sm font-semibold ${
                theme === 'dark' ? 'text-cream-100' : 'text-charcoal-800'
              }`}>
                {sessionTitle}
              </h1>
              <div className="mt-1 flex items-center gap-2">
                <p className={`text-[11px] ${
                  theme === 'dark' ? 'text-cream-500' : 'text-charcoal-400'
                }`}>
                  {t('viewer.liveViewing')}
                </p>
                <LiveShareBadge />
              </div>
            </div>
            <SettingsToggle />
          </div>
        </header>

        <ViewerNotice
          connectionState={connectionState}
          backlogTruncated={backlogTruncated}
          theme={theme}
          locale={locale}
        />

        <div className="border-b border-cream-200 bg-white/95 px-2 backdrop-blur-md">
          <div className="flex">
            {[
              ['transcript', t('viewer.tabsTranscript')],
              ['translation', t('viewer.tabsTranslation')],
              ['summary', t('viewer.tabsSummary')],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setMobileTab(key as 'transcript' | 'translation' | 'summary')}
                className={`flex-1 border-b-2 px-3 py-2 text-xs font-medium ${
                  mobileTab === key
                    ? 'border-rust-500 text-rust-600'
                    : 'border-transparent text-charcoal-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-hidden p-3">
          {mobileTab === 'transcript' ? <ViewerTranscriptPanel isLive /> : null}
          {mobileTab === 'translation' ? <ViewerTranslationPanel /> : null}
          {mobileTab === 'summary' ? <ViewerSummaryPanel /> : null}
        </div>

        <div className={`border-t px-3 py-3 safe-bottom ${
          theme === 'dark'
            ? 'border-charcoal-600 bg-charcoal-800'
            : 'border-cream-200 bg-white'
        }`}>
          <div className="flex items-center justify-between gap-2 text-xs">
            <button
              onClick={() =>
                setFontSize(
                  fontSize === 'small' ? 'medium' : fontSize === 'medium' ? 'large' : 'small'
                )
              }
              className={`rounded-full px-3 py-2 ${theme === 'dark' ? 'bg-charcoal-700 text-cream-200' : 'bg-cream-100 text-charcoal-700'}`}
            >
              Aa {fontSize}
            </button>
            <button
              onClick={() => setCompact(!compact)}
              className={`rounded-full px-3 py-2 ${theme === 'dark' ? 'bg-charcoal-700 text-cream-200' : 'bg-cream-100 text-charcoal-700'}`}
            >
              {compact ? t('viewer.expanded') : t('viewer.compact')}
            </button>
            <button
              onClick={() => setAutoScroll(!autoScroll)}
              className={`rounded-full px-3 py-2 ${theme === 'dark' ? 'bg-charcoal-700 text-cream-200' : 'bg-cream-100 text-charcoal-700'}`}
            >
              {autoScroll ? t('viewer.autoScroll') : t('viewer.manualScroll')}
            </button>
          </div>
        </div>

        <SettingsDrawer />
      </div>
    );
  }

  return (
    <div className={`h-screen flex flex-col overflow-hidden ${
      theme === 'dark' ? 'bg-charcoal-900' : 'bg-cream-50'
    }`}>
      {/* 头部 */}
      <header className={`px-4 sm:px-6 py-3 flex items-center justify-between flex-shrink-0 border-b ${
        theme === 'dark'
          ? 'bg-charcoal-800 border-charcoal-600'
          : 'bg-white border-cream-200'
      }`}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 bg-rust-500 rounded-lg flex items-center justify-center flex-shrink-0">
            <BookOpen className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className={`text-sm font-semibold truncate ${
              theme === 'dark' ? 'text-cream-100' : 'text-charcoal-800'
            }`}>
              {sessionTitle}
            </h1>
            <div className="flex items-center gap-2">
              <p className={`text-[11px] ${
                theme === 'dark' ? 'text-cream-500' : 'text-charcoal-400'
              }`}>
                {t('viewer.liveViewingReadOnly')}
              </p>
              {sessionInfo && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  theme === 'dark'
                    ? 'bg-charcoal-700 text-cream-400'
                    : 'bg-cream-100 text-charcoal-500'
                }`}>
                  {sessionInfo.sourceLang.toUpperCase()} → {sessionInfo.targetLang.toUpperCase()}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <LiveShareBadge />
          <SettingsToggle />
        </div>
      </header>

      <ViewerNotice
        connectionState={connectionState}
        backlogTruncated={backlogTruncated}
        theme={theme}
        locale={locale}
      />

      {/* 内容区域：两栏布局（转录+翻译 | 摘要），与录音界面一致 */}
      <div className="flex-1 flex gap-4 p-4 min-h-0 overflow-hidden">
        <div className="flex-1 min-w-0">
          <ViewerTranscriptPanel isLive={true} />
        </div>
        <div className="w-[380px] flex-shrink-0">
          <ViewerSummaryPanel />
        </div>
      </div>

      {/* 设置抽屉 */}
      <SettingsDrawer />
    </div>
  );
}
