import path from 'path';
import { fileURLToPath } from 'url';
import { configDefaults, defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_ROOTS = ['src', 'tests'];
// 组件测试（*.test.tsx）跑 jsdom，其余跑 node。Vitest 4 删除了 environmentMatchGlobs，
// 改用 projects 表达同一划分；两个 project 都 extends 根配置（alias / setupFiles / exclude）。
const JSDOM_TESTS = TEST_ROOTS.map((root) => `${root}/**/*.test.tsx`);

export default defineConfig({
  // Vite 8 起 esbuild 转换被 oxc 取代（esbuild 选项只做兼容转换并告警）。
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './deploy/shims/server-only.js'),
    },
  },
  test: {
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    exclude: [
      ...configDefaults.exclude,
      'e2e/**',
      '.next/**',
      'coverage/**',
    ],
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: TEST_ROOTS.map((root) => `${root}/**/*.{test,spec}.{ts,tsx}`),
          exclude: [
            ...configDefaults.exclude,
            'e2e/**',
            '.next/**',
            'coverage/**',
            ...JSDOM_TESTS,
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: JSDOM_TESTS,
        },
      },
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
