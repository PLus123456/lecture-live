'use client';

const accountObjectUrls = new Set<string>();

export function createAccountObjectUrl(value: Blob | MediaSource): string {
  const url = URL.createObjectURL(value);
  accountObjectUrls.add(url);
  return url;
}

export function revokeAccountObjectUrl(url: string): void {
  accountObjectUrls.delete(url);
  URL.revokeObjectURL(url);
}

export function revokeAllAccountObjectUrls(): void {
  for (const url of accountObjectUrls) {
    URL.revokeObjectURL(url);
  }
  accountObjectUrls.clear();
}
