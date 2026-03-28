const ALLOWED_AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
  'audio/mpeg',
]);

const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

export const MAX_AUDIO_UPLOAD_BYTES = 500 * 1024 * 1024;

export function normalizeAudioMimeType(value: string | null | undefined): string {
  const normalized = (value ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  switch (normalized) {
    case 'audio/x-wav':
      return 'audio/wav';
    case 'audio/mp3':
      return 'audio/mpeg';
    case 'audio/x-m4a':
      return 'audio/mp4';
    default:
      return normalized;
  }
}

export function isAllowedAudioMimeType(value: string | null | undefined): boolean {
  return ALLOWED_AUDIO_TYPES.has(normalizeAudioMimeType(value));
}

function hasBytes(buffer: Buffer, bytes: number[], offset = 0): boolean {
  return bytes.every((value, index) => buffer[offset + index] === value);
}

function isMp4(buffer: Buffer): boolean {
  if (buffer.length < 12) {
    return false;
  }

  return buffer.toString('ascii', 4, 8) === 'ftyp';
}

function isWav(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

function isOgg(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS';
}

function isMpeg(buffer: Buffer): boolean {
  if (buffer.length < 3) {
    return false;
  }

  if (buffer.toString('ascii', 0, 3) === 'ID3') {
    return true;
  }

  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

export function matchesAudioSignature(
  buffer: Buffer,
  mimeType: string | null | undefined
): boolean {
  const normalized = normalizeAudioMimeType(mimeType);

  switch (normalized) {
    case 'audio/webm':
      return hasBytes(buffer, WEBM_MAGIC);
    case 'audio/mp4':
      return isMp4(buffer);
    case 'audio/wav':
      return isWav(buffer);
    case 'audio/ogg':
      return isOgg(buffer);
    case 'audio/mpeg':
      return isMpeg(buffer);
    default:
      return false;
  }
}
