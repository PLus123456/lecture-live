'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  acquireMicrophoneStream,
  getMicrophonePlaceholderLabel,
  normalizeMicrophoneDevices,
} from '@/lib/audio/audioCapture';

const BAR_COUNT = 24;
const SILENT_BAR_LEVEL = 0.06;

export type PermissionState =
  | 'idle'
  | 'requesting'
  | 'granted'
  | 'denied'
  | 'unsupported'
  | 'error';

interface UseMicrophoneMonitorOptions {
  enabled: boolean;
  preferredDeviceId?: string | null;
}

function createSilentBars() {
  return Array.from({ length: BAR_COUNT }, () => SILENT_BAR_LEVEL);
}

function buildBars(data: Uint8Array) {
  if (data.length === 0) {
    return createSilentBars();
  }

  const bucketSize = Math.max(1, Math.floor(data.length / BAR_COUNT));

  return Array.from({ length: BAR_COUNT }, (_, index) => {
    const start = index * bucketSize;
    const end =
      index === BAR_COUNT - 1 ? data.length : Math.min(data.length, start + bucketSize);

    let sum = 0;
    for (let i = start; i < end; i += 1) {
      sum += data[i] ?? 0;
    }

    const avg = sum / Math.max(1, end - start);
    const normalized = avg / 255;
    return Math.max(SILENT_BAR_LEVEL, Math.min(1, normalized * 1.15));
  });
}

function computeRms(data: Float32Array) {
  if (data.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const sample = data[i] ?? 0;
    sum += sample * sample;
  }

  return Math.sqrt(sum / data.length);
}

function getErrorDetails(error: unknown): {
  permissionState: PermissionState;
  message: string;
} {
  if (error instanceof DOMException) {
    if (
      error.name === 'NotAllowedError' ||
      error.name === 'PermissionDeniedError'
    ) {
      return {
        permissionState: 'denied',
        message: '麦克风权限被拒绝，请在浏览器中允许访问麦克风。',
      };
    }

    if (
      error.name === 'NotFoundError' ||
      error.name === 'DevicesNotFoundError'
    ) {
      return {
        permissionState: 'error',
        message: '没有检测到可用的麦克风设备。',
      };
    }

    if (
      error.name === 'NotReadableError' ||
      error.name === 'TrackStartError'
    ) {
      return {
        permissionState: 'error',
        message: '麦克风当前不可读，可能正被其他应用占用。',
      };
    }
  }

  return {
    permissionState: 'error',
    message: error instanceof Error ? error.message : '无法启动麦克风预览。',
  };
}

export function useMicrophoneMonitor({
  enabled,
  preferredDeviceId,
}: UseMicrophoneMonitorOptions) {
  const silentBars = useMemo(() => createSilentBars(), []);
  const [availableMics, setAvailableMics] = useState<MediaDeviceInfo[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [permissionState, setPermissionState] =
    useState<PermissionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [bars, setBars] = useState<number[]>(silentBars);
  const [level, setLevel] = useState(0);
  const [peakDb, setPeakDb] = useState<number | null>(null);
  const requestVersionRef = useRef(0);
  const rafIdRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const resetMonitorState = useCallback(() => {
    setLevel(0);
    setPeakDb(null);
    setBars(silentBars);
  }, [silentBars]);

  const cleanupMonitor = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
  }, []);

  const refreshDevices = useCallback(async (activeTrack?: MediaStreamTrack | null) => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.enumerateDevices
    ) {
      setAvailableMics([]);
      return [];
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const microphones = normalizeMicrophoneDevices(devices, {
        activeTrack,
        fallbackDeviceId:
          activeTrack?.getSettings().deviceId || preferredDeviceId,
        fallbackLabel: 'Current microphone',
      });
      setAvailableMics(microphones);
      return microphones;
    } catch {
      const fallbackDevices = normalizeMicrophoneDevices([], {
        activeTrack,
        fallbackDeviceId:
          activeTrack?.getSettings().deviceId || preferredDeviceId,
        fallbackLabel: 'Current microphone',
      });
      setAvailableMics(fallbackDevices);
      return fallbackDevices;
    }
  }, [preferredDeviceId]);

  useEffect(() => {
    void refreshDevices();

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.addEventListener
    ) {
      return;
    }

    const handleDeviceChange = () => {
      void refreshDevices();
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener(
        'devicechange',
        handleDeviceChange
      );
    };
  }, [refreshDevices]);

  const requestAccess = useCallback(async () => {
    requestVersionRef.current += 1;
    const requestVersion = requestVersionRef.current;

    cleanupMonitor();
    resetMonitorState();
    setPermissionState('requesting');
    setError(null);

    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setPermissionState('unsupported');
      setError('iPad Safari 只允许在 HTTPS 或 localhost 下使用麦克风，HTTP 局域网地址不会弹出授权。');
      setActiveDeviceId(null);
      return;
    }

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setPermissionState('unsupported');
      setError('当前浏览器不支持麦克风预览。');
      setActiveDeviceId(null);
      return;
    }

    const AudioContextCtor =
      window.AudioContext ||
      (window as Window & {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;

    if (!AudioContextCtor) {
      setPermissionState('unsupported');
      setError('当前浏览器不支持音频分析。');
      setActiveDeviceId(null);
      return;
    }

    try {
      const stream = await acquireMicrophoneStream(preferredDeviceId);

      if (requestVersion !== requestVersionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      const actualDeviceId =
        track?.getSettings().deviceId || preferredDeviceId || null;

      setActiveDeviceId(actualDeviceId);
      setPermissionState('granted');
      await refreshDevices(track);

      const audioContext = new AudioContextCtor();
      audioContextRef.current = audioContext;

      if (audioContext.state === 'suspended') {
        await audioContext.resume().catch(() => undefined);
      }

      if (requestVersion !== requestVersionRef.current) {
        void audioContext.close();
        audioContextRef.current = null;
        return;
      }

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const freqData = new Uint8Array(analyser.frequencyBinCount);
      const timeData = new Float32Array(analyser.fftSize);

      const tick = () => {
        if (requestVersion !== requestVersionRef.current) {
          return;
        }

        analyser.getByteFrequencyData(freqData);
        analyser.getFloatTimeDomainData(timeData);

        const nextLevel = computeRms(timeData);
        const nextPeakDb = nextLevel > 0 ? 20 * Math.log10(nextLevel) : -90;

        setBars(buildBars(freqData));
        setLevel(Math.min(1, nextLevel * 6.5));
        setPeakDb(Number.isFinite(nextPeakDb) ? nextPeakDb : null);

        rafIdRef.current = requestAnimationFrame(tick);
      };

      tick();
    } catch (monitorError) {
      if (requestVersion !== requestVersionRef.current) {
        return;
      }

      const details = getErrorDetails(monitorError);
      setPermissionState(details.permissionState);
      setError(details.message);
      setActiveDeviceId(null);
      resetMonitorState();
    }
  }, [
    cleanupMonitor,
    preferredDeviceId,
    refreshDevices,
    resetMonitorState,
  ]);

  useEffect(() => {
    if (!enabled) {
      requestVersionRef.current += 1;
      cleanupMonitor();
      setPermissionState('idle');
      setError(null);
      setActiveDeviceId(null);
      resetMonitorState();
      return;
    }

    void requestAccess();

    return () => {
      requestVersionRef.current += 1;
      cleanupMonitor();
    };
  }, [cleanupMonitor, enabled, requestAccess, resetMonitorState]);

  return {
    activeDeviceId,
    availableMics,
    bars,
    error,
    level,
    peakDb,
    permissionState,
    placeholderLabel: getMicrophonePlaceholderLabel({
      permissionState,
      error,
      hasDevices: availableMics.length > 0,
    }),
    requestAccess,
    refreshDevices,
  };
}
