'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, ArrowLeftRight, Circle, AudioLines } from 'lucide-react';
import {
  EMPTY_STREAMING_PREVIEW_TEXT,
  EMPTY_STREAMING_PREVIEW_TRANSLATION,
  hasPreviewContent,
} from '@/lib/transcriptPreview';
import { useInterpret, type InterpretLine } from '@/hooks/useInterpret';
import { useI18n } from '@/lib/i18n';
import { useAuthStore } from '@/stores/authStore';
import type {
  StreamingPreviewText,
  StreamingPreviewTranslation,
} from '@/types/transcript';

/** 支持的语言对列表（带 emoji 国旗） */
const LANG_OPTIONS = [
  { value: 'en', label: 'English', emoji: '🇺🇸' },
  { value: 'zh', label: '中文', emoji: '🇨🇳' },
  { value: 'ja', label: '日本語', emoji: '🇯🇵' },
  { value: 'ko', label: '한국어', emoji: '🇰🇷' },
  { value: 'fr', label: 'Français', emoji: '🇫🇷' },
  { value: 'de', label: 'Deutsch', emoji: '🇩🇪' },
  { value: 'es', label: 'Español', emoji: '🇪🇸' },
  { value: 'ru', label: 'Русский', emoji: '🇷🇺' },
  { value: 'pt', label: 'Português', emoji: '🇵🇹' },
  { value: 'ar', label: 'العربية', emoji: '🇸🇦' },
];

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function getLangOption(code: string) {
  return LANG_OPTIONS.find((o) => o.value === code);
}

/** 单侧面板：显示原文和翻译的内容流 */
function LangPanel({
  langCode,
  lines,
  previewText,
  previewTranslation,
  isPreviewSide,
  label,
  direction,
}: {
  langCode: string;
  lines: InterpretLine[];
  previewText: StreamingPreviewText;
  previewTranslation: StreamingPreviewTranslation;
  isPreviewSide: boolean;
  label: string;
  direction: 'top' | 'bottom';
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const opt = getLangOption(langCode);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, previewText, previewTranslation]);

  const borderClass =
    direction === 'top' ? 'border-b border-cream-200' : '';
  const hasPreview = hasPreviewContent(previewText);
  const hasPreviewTranslation = hasPreviewContent(previewTranslation);
  const showPreviewTranslationWaiting =
    previewTranslation.state === 'waiting' && !hasPreviewTranslation;

  return (
    <div className={`flex flex-1 flex-col min-h-0 ${borderClass}`}>
      {/* 语言标签 */}
      <div className="flex items-center gap-2 px-4 py-2 bg-cream-50 border-b border-cream-100 flex-shrink-0">
        <span className="text-base">{opt?.emoji}</span>
        <span className="text-xs font-semibold text-charcoal-500 uppercase tracking-wider">
          {label}
        </span>
        <span className="text-xs text-charcoal-400">
          {opt?.label ?? langCode}
        </span>
      </div>

      {/* 内容区域 */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-2"
      >
        {lines.length === 0 && !isPreviewSide && (
          <p className="text-sm text-charcoal-300 italic text-center mt-8">
            {/* 等待内容 */}
          </p>
        )}
        {lines.map((line) => (
          <div key={line.id} className="text-sm leading-relaxed segment-enter">
            {line.language ? (
              <p className="text-charcoal-800">{line.text}</p>
            ) : (
              <p className="text-rust-500 text-[13px]">{line.text}</p>
            )}
          </div>
        ))}

        {/* 实时预览 */}
        {isPreviewSide && hasPreview && (
          <div className="text-sm leading-relaxed">
            <p>
              {previewText.finalText ? (
                <span className="text-charcoal-800">{previewText.finalText}</span>
              ) : null}
              {previewText.nonFinalText ? (
                <span className="text-charcoal-500">{previewText.nonFinalText}</span>
              ) : null}
            </p>
          </div>
        )}
        {!isPreviewSide && hasPreviewTranslation && (
          <div className="text-sm leading-relaxed">
            <p className="text-[13px]">
              {previewTranslation.finalText ? (
                <span className="text-rust-500">
                  {previewTranslation.finalText}
                </span>
              ) : null}
              {previewTranslation.nonFinalText ? (
                <span className="text-rust-400">
                  {previewTranslation.nonFinalText}
                </span>
              ) : null}
            </p>
          </div>
        )}
        {!isPreviewSide && showPreviewTranslationWaiting && (
          <div className="text-sm leading-relaxed">
            <p className="text-rust-300 italic text-[13px]">翻译中…</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function InterpretPage() {
  const { t } = useI18n();
  const quotas = useAuthStore((s) => s.quotas);
  const {
    isRunning,
    connectionState,
    linesA,
    linesB,
    previewText,
    previewTranslation,
    previewLang,
    elapsedMs,
    start,
    stop,
  } = useInterpret();

  const [langA, setLangA] = useState('en');
  const [langB, setLangB] = useState('zh');

  /* 麦克风设备 */
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState('');
  const [micTesting, setMicTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((devices) => {
      const mics = devices.filter((d) => d.kind === 'audioinput');
      setMicDevices(mics);
      if (mics.length > 0 && !selectedMic) {
        setSelectedMic(mics[0].deviceId);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canStart =
    !isRunning &&
    langA !== langB &&
    quotas &&
    quotas.transcriptionMinutesUsed < quotas.transcriptionMinutesLimit;

  const handleSwap = useCallback(() => {
    if (isRunning) return;
    setLangA(langB);
    setLangB(langA);
  }, [isRunning, langA, langB]);

  const handleStart = useCallback(async () => {
    if (!canStart) return;
    await start(langA, langB);
  }, [canStart, langA, langB, start]);

  const handleStop = useCallback(async () => {
    await stop();
  }, [stop]);

  /** 测试麦克风 — 录 3 秒后自动停止 */
  const testMic = useCallback(async () => {
    if (micTesting) return;
    setMicTesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMic ? { deviceId: selectedMic } : true,
      });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const interval = setInterval(() => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setMicLevel(avg / 255);
      }, 50);

      setTimeout(() => {
        clearInterval(interval);
        stream.getTracks().forEach((track) => track.stop());
        void ctx.close();
        setMicTesting(false);
        setMicLevel(0);
      }, 3000);
    } catch {
      setMicTesting(false);
    }
  }, [micTesting, selectedMic]);

  // 录制中离开页面时提示数据丢失
  useEffect(() => {
    if (!isRunning) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isRunning]);

  const previewIsA = previewLang === langA;
  const previewTranslationSourceIsA =
    (previewTranslation.sourceLanguage ?? previewLang) === langA;
  const hasContent = linesA.length > 0 || linesB.length > 0;

  /* ── 空闲状态：居中布局 ── */
  if (!isRunning && !hasContent) {
    return (
      <div className="flex flex-col h-screen bg-white">
        {/* 配额不足警告 */}
        {quotas &&
          quotas.transcriptionMinutesUsed >= quotas.transcriptionMinutesLimit && (
            <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-700 text-sm">
              {t('interpret.quotaWarning')}
            </div>
          )}

        <div className="flex-1 flex flex-col items-center justify-center gap-8 px-4 animate-fade-in-up">
          {/* 大麦克风按钮 */}
          <button
            onClick={() => void handleStart()}
            disabled={!canStart}
            className="group relative w-28 h-28 rounded-full text-white flex items-center justify-center
                       disabled:opacity-50 disabled:cursor-not-allowed
                       transition-all active:scale-95 active:shadow-md animate-fade-in-scale
                       shadow-[0_6px_20px_rgba(196,75,32,0.45),0_2px_6px_rgba(0,0,0,0.15)]
                       hover:shadow-[0_8px_28px_rgba(196,75,32,0.55),0_3px_8px_rgba(0,0,0,0.2)]"
            style={{
              background: 'linear-gradient(145deg, #d9623a 0%, #C44B20 45%, #a33d18 100%)',
            }}
          >
            {/* 顶部高光 */}
            <span
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{
                background: 'radial-gradient(ellipse 60% 40% at 40% 25%, rgba(255,255,255,0.30) 0%, transparent 70%)',
              }}
            />
            {/* 内阴影增加凹凸感 */}
            <span
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{
                boxShadow: 'inset 0 2px 4px rgba(255,255,255,0.25), inset 0 -3px 6px rgba(0,0,0,0.2)',
              }}
            />
            <Mic className="w-12 h-12 relative drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]" />
          </button>

          {connectionState === 'connecting' && (
            <span className="text-sm text-charcoal-400 animate-pulse">
              {t('common.loading')}
            </span>
          )}

          {/* 第一排：麦克风选择 + 测试 */}
          <div className="flex items-center gap-3 animate-fade-in-up stagger-2">
            <div className="flex items-center gap-2 px-3 py-2 border border-cream-200 rounded-xl bg-cream-50">
              <Mic className="w-4 h-4 text-charcoal-400 flex-shrink-0" />
              <select
                value={selectedMic}
                onChange={(e) => setSelectedMic(e.target.value)}
                className="text-sm bg-transparent text-charcoal-700 focus:outline-none max-w-[200px] truncate"
              >
                {micDevices.length === 0 && <option>无可用麦克风</option>}
                {micDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || '麦克风'}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={() => void testMic()}
              disabled={micTesting}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium transition-all
                ${micTesting
                  ? 'bg-green-100 text-green-700 border border-green-200'
                  : 'bg-cream-50 text-charcoal-600 border border-cream-200 hover:bg-cream-100'
                }`}
            >
              <AudioLines className="w-4 h-4" />
              {micTesting ? '测试中…' : '测试'}
            </button>

            {/* 音量指示条 */}
            {micTesting && (
              <div className="flex items-end gap-0.5 h-6">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className="w-1 rounded-full bg-green-500 transition-all duration-75"
                    style={{
                      height: `${Math.max(4, micLevel > (i + 1) * 0.15 ? micLevel * 24 : 4)}px`,
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* 第二排：语言选择（带 emoji） */}
          <div className="flex items-center gap-3 animate-fade-in-up stagger-4">
            <div className="flex items-center gap-2 px-4 py-2.5 border border-cream-200 rounded-xl bg-cream-50">
              <span className="text-lg leading-none">{getLangOption(langA)?.emoji}</span>
              <select
                value={langA}
                onChange={(e) => setLangA(e.target.value)}
                className="text-sm bg-transparent text-charcoal-700 focus:outline-none font-medium"
              >
                {LANG_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.emoji} {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={handleSwap}
              className="p-2 rounded-full text-charcoal-400 hover:bg-cream-100 hover:text-charcoal-600 transition-colors"
              title={t('interpret.swap')}
            >
              <ArrowLeftRight className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2 px-4 py-2.5 border border-cream-200 rounded-xl bg-cream-50">
              <span className="text-lg leading-none">{getLangOption(langB)?.emoji}</span>
              <select
                value={langB}
                onChange={(e) => setLangB(e.target.value)}
                className="text-sm bg-transparent text-charcoal-700 focus:outline-none font-medium"
              >
                {LANG_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.emoji} {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── 录制中 / 有内容：面板布局 ── */
  return (
    <div className="flex flex-col h-screen">
      {/* 顶部状态栏 */}
      <div className="flex items-center justify-center gap-4 px-4 py-3 bg-white border-b border-cream-200 flex-shrink-0 animate-fade-in">
        {isRunning && (
          <div className="flex items-center gap-1.5">
            <Circle className="w-2 h-2 fill-red-500 text-red-500 animate-pulse" />
            <span className="text-xs text-charcoal-500 font-mono">
              {formatElapsed(elapsedMs)}
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 text-sm text-charcoal-500">
          <span>{getLangOption(langA)?.emoji} {getLangOption(langA)?.label}</span>
          <ArrowLeftRight className="w-3.5 h-3.5 text-charcoal-300" />
          <span>{getLangOption(langB)?.emoji} {getLangOption(langB)?.label}</span>
        </div>

        {isRunning ? (
          <button
            onClick={() => void handleStop()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                       bg-red-500 text-white hover:bg-red-600 transition-colors shadow-sm"
          >
            <MicOff className="w-4 h-4" />
            {t('interpret.stop')}
          </button>
        ) : (
          <button
            onClick={() => void handleStart()}
            disabled={!canStart}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                       bg-rust-500 text-white hover:bg-rust-600
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            <Mic className="w-4 h-4" />
            {t('interpret.start')}
          </button>
        )}
      </div>

      {/* 配额不足警告 */}
      {quotas &&
        quotas.transcriptionMinutesUsed >= quotas.transcriptionMinutesLimit && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-700 text-sm">
            {t('interpret.quotaWarning')}
          </div>
        )}

      {/* 双面板区域 */}
      <div className="flex-1 flex flex-col min-h-0 bg-white animate-fade-in-up">
        <LangPanel
          langCode={langA}
          lines={linesA}
          previewText={previewIsA ? previewText : EMPTY_STREAMING_PREVIEW_TEXT}
          previewTranslation={
            previewTranslationSourceIsA
              ? EMPTY_STREAMING_PREVIEW_TRANSLATION
              : previewTranslation
          }
          isPreviewSide={previewIsA}
          label={t('interpret.langA')}
          direction="top"
        />
        <LangPanel
          langCode={langB}
          lines={linesB}
          previewText={!previewIsA ? previewText : EMPTY_STREAMING_PREVIEW_TEXT}
          previewTranslation={
            previewTranslationSourceIsA
              ? previewTranslation
              : EMPTY_STREAMING_PREVIEW_TRANSLATION
          }
          isPreviewSide={!previewIsA}
          label={t('interpret.langB')}
          direction="bottom"
        />
      </div>
    </div>
  );
}
