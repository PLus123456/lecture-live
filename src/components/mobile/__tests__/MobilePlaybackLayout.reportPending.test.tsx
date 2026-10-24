import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * 移动端回放报告空态与 desktop 同口径（shouldShowSessionReportPending）：后台仍在生成时，
 * 旧的 worth=true / report=null 失败对象也要显示「生成中」，而不是「生成失败」+ 重新生成按钮。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
const stableT = (key: string) => key;
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: stableT, locale: 'zh', setLocale: () => {} }),
}));
vi.mock('@/components/session/ChatTab', () => ({ default: () => null }));
vi.mock('@/components/session/PlaybackSharePopover', () => ({ default: () => null }));

const { default: MobilePlaybackLayout } = await import('@/components/mobile/MobilePlaybackLayout');

const FAILED_REPORT = {
  significance: { isWorthSummarizing: true, score: 0.9, reason: 'ok' },
  report: null,
  generatedAt: '2026-10-20T09:00:00Z',
};

function renderLayout(reportPendingBg: boolean) {
  return render(
    <MobilePlaybackLayout
      session={{
        id: 's1',
        title: 'T',
        createdAt: '2026-10-20T08:00:00Z',
        durationMs: 60_000,
        sourceLang: 'en',
        targetLang: 'zh',
        status: 'COMPLETED',
      }}
      segments={[]}
      summaries={[]}
      reportData={FAILED_REPORT}
      reportLoading={false}
      reportPendingBg={reportPendingBg}
      isPlaying={false}
      currentTimeMs={0}
      effectiveDurationMs={60_000}
      playbackRate={1}
      volume={1}
      muted={false}
      onVolumeChange={() => {}}
      onToggleMuted={() => {}}
      hasAudio={false}
      onTogglePlayback={() => {}}
      onSeekToMs={() => {}}
      onCycleSpeed={() => {}}
      onSegmentClick={() => {}}
      onOpenExport={() => {}}
      onRegenerateReport={() => {}}
    />
  );
}

describe('MobilePlaybackLayout 报告空态', () => {
  it('失败报告 + 后台重新生成中 → 显示「生成中」，不再给重新生成按钮', () => {
    renderLayout(true);
    expect(screen.getByTestId('report-generating-bg')).toBeInTheDocument();
    expect(screen.queryByTestId('report-regen-btn')).toBeNull();
  });

  it('失败报告且后台未在生成 → 显示失败 + 重新生成入口', () => {
    renderLayout(false);
    expect(screen.queryByTestId('report-generating-bg')).toBeNull();
    expect(screen.getByText('playback.reportFailed')).toBeInTheDocument();
    expect(screen.getByTestId('report-regen-btn')).toBeInTheDocument();
  });
});
