import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  validateMediaContainerMock,
  probeAudioStreamCountMock,
  probeFormatNameMock,
  probeDurationSecMock,
  measureDecodedAudioDurationSecMock,
  scanWebmDocumentRangesMock,
  copyFileRangeMock,
  writeFileMock,
  mkdirMock,
  mkdtempMock,
  rmMock,
} = vi.hoisted(() => ({
  validateMediaContainerMock: vi.fn(),
  probeAudioStreamCountMock: vi.fn(),
  probeFormatNameMock: vi.fn(),
  probeDurationSecMock: vi.fn(),
  measureDecodedAudioDurationSecMock: vi.fn(),
  scanWebmDocumentRangesMock: vi.fn(),
  copyFileRangeMock: vi.fn(),
  writeFileMock: vi.fn(),
  mkdirMock: vi.fn(),
  mkdtempMock: vi.fn(),
  rmMock: vi.fn(),
}));

vi.mock('@/lib/audio/ffmpegTranscode', () => ({
  validateMediaContainer: validateMediaContainerMock,
  probeAudioStreamCount: probeAudioStreamCountMock,
  probeFormatName: probeFormatNameMock,
  probeDurationSec: probeDurationSecMock,
  measureDecodedAudioDurationSec: measureDecodedAudioDurationSecMock,
}));
vi.mock('@/lib/audio/webmDocuments', () => ({
  scanWebmDocumentRanges: scanWebmDocumentRangesMock,
  copyFileRange: copyFileRangeMock,
}));
vi.mock('@/lib/sessionPersistence', () => ({
  loadSessionTranscriptBundle: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: writeFileMock,
    mkdir: mkdirMock,
    mkdtemp: mkdtempMock,
    rm: rmMock,
  },
}));

import {
  measureAuthoritativeRecordingDurationMs,
  measureAuthoritativeRecordingDurationMsFromBuffer,
  RecordingDurationMeasurementError,
} from '@/lib/audio/recordingDuration';

beforeEach(() => {
  vi.clearAllMocks();
  validateMediaContainerMock.mockResolvedValue(undefined);
  probeAudioStreamCountMock.mockResolvedValue(1);
  probeFormatNameMock.mockResolvedValue('matroska,webm');
  probeDurationSecMock.mockResolvedValue(120.25);
  measureDecodedAudioDurationSecMock.mockResolvedValue(120.25);
  scanWebmDocumentRangesMock.mockResolvedValue([{ start: 0, end: 4096 }]);
  copyFileRangeMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
  mkdirMock.mockResolvedValue(undefined);
  mkdtempMock.mockResolvedValue('/tmp/ll-audio-doc-measure-test');
  rmMock.mockResolvedValue(undefined);
});

describe('authoritative recording duration', () => {
  it('普通 WebM 使用服务端实际解码时长且不改写调用方文件', async () => {
    await expect(
      measureAuthoritativeRecordingDurationMs('/tmp/recording.webm')
    ).resolves.toBe(120_250);

    expect(validateMediaContainerMock).toHaveBeenCalledWith(
      '/tmp/recording.webm'
    );
    expect(probeAudioStreamCountMock).toHaveBeenCalledWith(
      '/tmp/recording.webm'
    );
    expect(measureDecodedAudioDurationSecMock).toHaveBeenCalledWith(
      '/tmp/recording.webm',
      expect.objectContaining({
        idleTimeoutMs: expect.any(Number),
        maxTimeoutMs: expect.any(Number),
      })
    );
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('streaming/headerless WebM 没有 format.duration 时按实际解码时长结算', async () => {
    measureDecodedAudioDurationSecMock.mockResolvedValue(95.25);

    await expect(
      measureAuthoritativeRecordingDurationMs('/tmp/headerless.webm')
    ).resolves.toBe(95_250);

    expect(measureDecodedAudioDurationSecMock).toHaveBeenCalledWith(
      '/tmp/headerless.webm',
      expect.any(Object)
    );
  });

  it('完整解码无法得到正时长时 fail closed', async () => {
    measureDecodedAudioDurationSecMock.mockResolvedValue(0);

    await expect(
      measureAuthoritativeRecordingDurationMs('/tmp/unreadable.webm')
    ).rejects.toBeInstanceOf(RecordingDurationMeasurementError);
  });

  it('多音轨容器 fail closed，短第一轨不能掩盖长音轨', async () => {
    probeAudioStreamCountMock.mockResolvedValue(2);

    await expect(
      measureAuthoritativeRecordingDurationMs('/tmp/multi-track.mkv')
    ).rejects.toBeInstanceOf(RecordingDurationMeasurementError);

    expect(measureDecodedAudioDurationSecMock).not.toHaveBeenCalled();
  });

  it('多个独立 WebM 文档逐段校验并按解码样本时长求和', async () => {
    scanWebmDocumentRangesMock.mockResolvedValue([
      { start: 0, end: 4096 },
      { start: 4096, end: 12_288 },
    ]);
    measureDecodedAudioDurationSecMock
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3);

    await expect(
      measureAuthoritativeRecordingDurationMs('/tmp/concatenated.webm')
    ).resolves.toBe(4_000);

    expect(copyFileRangeMock).toHaveBeenCalledTimes(2);
    expect(validateMediaContainerMock).toHaveBeenCalledWith(
      '/tmp/ll-audio-doc-measure-test/document-0.webm'
    );
    expect(validateMediaContainerMock).toHaveBeenCalledWith(
      '/tmp/ll-audio-doc-measure-test/document-1.webm'
    );
  });

  it('后续独立文档出现多音轨时整体 fail closed', async () => {
    scanWebmDocumentRangesMock.mockResolvedValue([
      { start: 0, end: 4096 },
      { start: 4096, end: 12_288 },
    ]);
    probeAudioStreamCountMock
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    measureDecodedAudioDurationSecMock.mockResolvedValueOnce(1);

    await expect(
      measureAuthoritativeRecordingDurationMs('/tmp/heterogeneous.webm')
    ).rejects.toBeInstanceOf(RecordingDurationMeasurementError);

    expect(measureDecodedAudioDurationSecMock).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledWith(
      '/tmp/ll-audio-doc-measure-test',
      { recursive: true, force: true }
    );
  });

  it('没有音频流或音轨 probe 失败时 fail closed', async () => {
    probeAudioStreamCountMock.mockResolvedValue(0);

    await expect(
      measureAuthoritativeRecordingDurationMs('/tmp/video-only.mp4')
    ).rejects.toBeInstanceOf(RecordingDurationMeasurementError);

    expect(measureDecodedAudioDurationSecMock).not.toHaveBeenCalled();
  });

  it('Buffer 入口只清理自己创建的受控临时文件', async () => {
    const buffer = Buffer.from('webm-bytes');

    await expect(
      measureAuthoritativeRecordingDurationMsFromBuffer(buffer, 'audio/webm')
    ).resolves.toBe(120_250);

    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/ll-audio-measure-.*\.webm$/),
      buffer
    );
    expect(rmMock).toHaveBeenCalledWith(
      expect.stringMatching(/ll-audio-measure-.*\.webm$/),
      { force: true }
    );
  });
});
