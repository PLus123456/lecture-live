import { afterEach, vi } from 'vitest';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

Object.assign(process.env, {
  NODE_ENV: process.env.NODE_ENV ?? 'test',
  JWT_SECRET: process.env.JWT_SECRET ?? 'a'.repeat(64),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? 'b'.repeat(64),
  DATABASE_URL:
    process.env.DATABASE_URL ??
    'mysql://lecturelive:lecturelive@127.0.0.1:3306/lecturelive',
});

afterEach(() => {
  vi.clearAllMocks();
});

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  }

  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => {
    cleanup();
  });
}
