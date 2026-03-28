import path from 'path';
import { fileURLToPath } from 'url';
import { configDefaults, defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './deploy/shims/server-only.js'),
    },
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
    globals: true,
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'tests/**/*.{test,spec}.{ts,tsx}',
    ],
    setupFiles: ['./vitest.setup.ts'],
    exclude: [
      ...configDefaults.exclude,
      'e2e/**',
      '.next/**',
      'coverage/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'src/lib/billing.ts',
        'src/lib/crypto.ts',
        'src/lib/security.ts',
        'src/lib/sessionApi.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
