// src/lib/soniox/audioSource.ts
// v2.1 §B.2: Audio source acquisition with full error handling

export type AudioSourceType = 'microphone' | 'system_audio';

export interface AudioSourceResult {
  stream: MediaStream;
  sourceType: AudioSourceType;
  deviceLabel: string;
  cleanup: () => void;
}

export class AudioSourceError extends Error {
  code: string;
  helpUrl?: string;

  constructor(code: string, message: string, helpUrl?: string) {
    super(message);
    this.code = code;
    this.helpUrl = helpUrl;
    this.name = 'AudioSourceError';
  }
}

/**
 * Acquire an audio source — handles all permission/device error scenarios
 */
export async function acquireAudioSource(
  sourceType: AudioSourceType,
  micDeviceId?: string
): Promise<AudioSourceResult> {
  if (sourceType === 'microphone') {
    return acquireMicrophone(micDeviceId);
  } else {
    return acquireSystemAudio();
  }
}

async function acquireMicrophone(deviceId?: string): Promise<AudioSourceResult> {
  // Check permission state without prompting
  try {
    const permStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    if (permStatus.state === 'denied') {
      throw new AudioSourceError(
        'PERMISSION_DENIED',
        'Microphone permission denied. Please allow microphone access in your browser settings.',
        'https://support.google.com/chrome/answer/2693767'
      );
    }
  } catch (e) {
    if (e instanceof AudioSourceError) throw e;
    // permissions.query not supported for microphone in some browsers — skip
  }

  try {
    const constraints: MediaStreamConstraints = {
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
        : { echoCancellation: true, noiseSuppression: true },
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const audioTrack = stream.getAudioTracks()[0];

    return {
      stream,
      sourceType: 'microphone',
      deviceLabel: audioTrack.label || 'Unknown Microphone',
      cleanup: () => stream.getTracks().forEach((t) => t.stop()),
    };
  } catch (err: unknown) {
    const e = err as DOMException;
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      throw new AudioSourceError(
        'PERMISSION_DENIED',
        'Microphone permission denied. Click the lock icon in the address bar and allow microphone access, then refresh.'
      );
    }
    if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
      throw new AudioSourceError(
        'DEVICE_NOT_FOUND',
        'No microphone detected. Please connect a microphone and try again.'
      );
    }
    if (e.name === 'NotReadableError' || e.name === 'TrackStartError') {
      throw new AudioSourceError(
        'DEVICE_IN_USE',
        'Microphone is in use by another application. Please close other apps using the microphone and try again.'
      );
    }
    throw new AudioSourceError('UNKNOWN', `Failed to acquire microphone: ${e.message || e}`);
  }
}

async function acquireSystemAudio(): Promise<AudioSourceResult> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new AudioSourceError(
      'NOT_SUPPORTED',
      'Your browser does not support system audio capture. Please use Chrome or Edge.'
    );
  }

  try {
    // Chrome requires video to be requested with getDisplayMedia
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new AudioSourceError(
        'NO_AUDIO_TRACK',
        'No system audio captured. Please check "Share audio" in the screen sharing dialog.\n\n' +
        'Tips:\n' +
        '- Chrome: Select a Browser Tab and check "Share audio" at the bottom\n' +
        '- Selecting a tab is the easiest way to capture audio\n' +
        '- Some systems do not support full-screen audio capture'
      );
    }

    // Discard video tracks, keep only audio
    stream.getVideoTracks().forEach((t) => t.stop());
    const audioStream = new MediaStream(audioTracks);

    return {
      stream: audioStream,
      sourceType: 'system_audio',
      deviceLabel: 'System Audio',
      cleanup: () => {
        audioStream.getTracks().forEach((t) => t.stop());
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  } catch (err: unknown) {
    if (err instanceof AudioSourceError) throw err;
    const e = err as DOMException;
    if (e.name === 'NotAllowedError') {
      throw new AudioSourceError(
        'USER_CANCELLED',
        'System audio capture cancelled.'
      );
    }
    throw new AudioSourceError('UNKNOWN', `System audio capture failed: ${e.message || e}`);
  }
}
