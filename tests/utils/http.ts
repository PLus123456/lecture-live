export function createJsonRequest(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: HeadersInit;
  } = {}
) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return new Request(url, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
}

export function createMultipartRequest(
  url: string,
  fields: Record<string, string>,
  file: {
    fieldName: string;
    fileName: string;
    contents: Uint8Array | string;
    type: string;
  }
) {
  const formData = new FormData();
  const fileContents =
    typeof file.contents === 'string'
      ? file.contents
      : Uint8Array.from(file.contents).buffer;

  Object.entries(fields).forEach(([key, value]) => {
    formData.set(key, value);
  });

  formData.set(
    file.fieldName,
    new File([fileContents], file.fileName, { type: file.type })
  );

  return new Request(url, {
    method: 'POST',
    body: formData,
  });
}

export async function readJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}
