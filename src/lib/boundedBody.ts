/**
 * Read an HTTP body while enforcing the actual encoded byte count.
 * Content-Length is only an early rejection; chunked and dishonest requests
 * are still canceled as soon as the streamed limit is crossed.
 */
export class BoundedBodyError extends Error {
  constructor(
    message: string,
    public readonly code: 'too_large' | 'invalid'
  ) {
    super(message);
    this.name = 'BoundedBodyError';
  }
}

type BodySource = Pick<Request | Response, 'body' | 'headers'>;

export async function readBodyBytesBounded(
  source: BodySource,
  maxBytes: number
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }

  const declared = source.headers.get('content-length')?.trim();
  if (declared && /^\d+$/.test(declared)) {
    try {
      if (BigInt(declared) > BigInt(maxBytes)) {
        throw new BoundedBodyError('HTTP body exceeds byte limit', 'too_large');
      }
    } catch (error) {
      if (error instanceof BoundedBodyError) throw error;
      throw new BoundedBodyError('HTTP body exceeds byte limit', 'too_large');
    }
  }

  if (!source.body) {
    throw new BoundedBodyError('HTTP body is missing', 'invalid');
  }

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel('HTTP body exceeds byte limit').catch(() => undefined);
        throw new BoundedBodyError('HTTP body exceeds byte limit', 'too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BoundedBodyError) throw error;
    throw new BoundedBodyError('HTTP body could not be read', 'invalid');
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonBodyBounded(
  source: BodySource,
  maxBytes: number
): Promise<unknown> {
  const bytes = await readBodyBytesBounded(source, maxBytes);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new BoundedBodyError('HTTP body must contain valid UTF-8 JSON', 'invalid');
  }
}
