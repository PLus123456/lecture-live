'use client';

import type { AudioSourceType } from '@/types/transcript';

export function buildMicrophoneConstraints(
  deviceId?: string | null
): MediaTrackConstraints {
  return {
    echoCancellation: { ideal: false },
    noiseSuppression: { ideal: false },
    autoGainControl: { ideal: false },
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 16000 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

function buildCompatibleMicrophoneConstraints(
  deviceId?: string | null
): MediaTrackConstraints {
  return {
    echoCancellation: { ideal: false },
    noiseSuppression: { ideal: false },
    autoGainControl: { ideal: false },
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
  };
}

function isPermissionDeniedError(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError')
  );
}

function isRetryableMicrophoneError(error: unknown) {
  if (error instanceof DOMException) {
    return [
      'AbortError',
      'ConstraintNotSatisfiedError',
      'DevicesNotFoundError',
      'NotFoundError',
      'OverconstrainedError',
    ].includes(error.name);
  }

  return error instanceof TypeError;
}

export function pickRecorderOptions(): MediaRecorderOptions {
  const preferredMimeTypes = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
  ];

  if (
    typeof MediaRecorder === 'undefined' ||
    typeof MediaRecorder.isTypeSupported !== 'function'
  ) {
    return {};
  }

  for (const mimeType of preferredMimeTypes) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return { mimeType };
    }
  }

  return {};
}

export async function acquireMicrophoneStream(deviceId?: string | null) {
  const candidates: Array<MediaTrackConstraints | true> = [
    buildMicrophoneConstraints(deviceId),
    buildCompatibleMicrophoneConstraints(deviceId),
    true,
  ];

  let lastError: unknown = null;

  for (const audio of candidates) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio });
    } catch (error) {
      lastError = error;

      if (
        isPermissionDeniedError(error) ||
        !isRetryableMicrophoneError(error)
      ) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error('当前浏览器无法启动麦克风。');
}

export async function acquireSystemAudioStream() {
  if (!navigator.mediaDevices.getDisplayMedia) {
    throw new Error('当前浏览器不支持系统音频采集。');
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true,
  });

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error(
      '没有捕获到系统音频，请在浏览器共享窗口里勾选“共享音频/Share audio”。'
    );
  }

  stream.getVideoTracks().forEach((track) => track.stop());
  return new MediaStream(audioTracks);
}

export function mapStartError(error: unknown, sourceType: AudioSourceType) {
  if (error instanceof DOMException) {
    if (
      error.name === 'NotAllowedError' ||
      error.name === 'PermissionDeniedError'
    ) {
      return new Error(
        sourceType === 'system'
          ? '系统音频授权被取消，请重新选择共享内容并允许音频。'
          : '麦克风权限被拒绝，请允许浏览器访问麦克风。'
      );
    }

    if (
      error.name === 'NotFoundError' ||
      error.name === 'DevicesNotFoundError'
    ) {
      return new Error(
        sourceType === 'system'
          ? '没有检测到可用的系统音频输入。'
          : '没有检测到可用的麦克风设备。'
      );
    }

    if (
      error.name === 'NotReadableError' ||
      error.name === 'TrackStartError'
    ) {
      return new Error(
        sourceType === 'system'
          ? '系统音频流当前不可用，请关闭其他占用屏幕共享的应用后重试。'
          : '麦克风当前不可读，可能正被其他应用占用。'
      );
    }
  }

  return error instanceof Error ? error : new Error(String(error));
}

function createMicrophoneDevicePlaceholder(
  deviceId: string,
  label: string
): MediaDeviceInfo {
  return {
    deviceId,
    groupId: '',
    kind: 'audioinput',
    label,
    toJSON: () => ({
      deviceId,
      groupId: '',
      kind: 'audioinput',
      label,
    }),
  } as MediaDeviceInfo;
}

export function normalizeMicrophoneDevices(
  devices: MediaDeviceInfo[],
  options?: {
    activeTrack?: MediaStreamTrack | null;
    fallbackDeviceId?: string | null;
    fallbackLabel?: string;
  }
): MediaDeviceInfo[] {
  const microphones = devices.filter((device) => device.kind === 'audioinput');
  const activeTrack = options?.activeTrack ?? null;
  const fallbackDeviceId =
    activeTrack?.getSettings().deviceId ||
    options?.fallbackDeviceId ||
    null;
  const fallbackLabel =
    activeTrack?.label ||
    options?.fallbackLabel ||
    'Current microphone';

  if (!fallbackDeviceId) {
    return microphones;
  }

  const hasMatchingDevice = microphones.some(
    (device) => device.deviceId === fallbackDeviceId
  );

  if (hasMatchingDevice) {
    return microphones;
  }

  return [
    createMicrophoneDevicePlaceholder(fallbackDeviceId, fallbackLabel),
    ...microphones,
  ];
}

export function getMicrophonePlaceholderLabel(options: {
  permissionState:
    | 'idle'
    | 'requesting'
    | 'granted'
    | 'denied'
    | 'unsupported'
    | 'error';
  error?: string | null;
  hasDevices: boolean;
}) {
  if (options.hasDevices) {
    return '';
  }

  if (options.permissionState === 'requesting') {
    return 'Requesting access...';
  }

  if (options.error) {
    return options.error;
  }

  if (options.permissionState === 'idle') {
    return 'Tap Microphone to allow access';
  }

  if (options.permissionState === 'denied') {
    return 'Microphone access blocked';
  }

  if (options.permissionState === 'unsupported') {
    return 'Browser microphone unsupported';
  }

  return 'No microphone detected';
}
