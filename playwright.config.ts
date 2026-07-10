import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      // 常规 e2e：用 installBrowserStubs 的假音频 API（不真录音）。
      name: 'chromium',
      testIgnore: /recording-offline-capture/,
      use: {
        ...devices['Desktop Chrome'],
      },
    },
    {
      // 需要真实录音（archiveManager 真录、hasLiveCapture 为真）的 e2e：用 chromium 假麦克风
      // 提供真实音频轨 + 自动授权。仅限断网续采等必须驱动到真实录音态的用例，避免与常规
      // e2e 的假音频桩冲突。
      name: 'chromium-media',
      testMatch: /recording-offline-capture/,
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'npm run dev -- --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100/login',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NODE_ENV: 'test',
      NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:3100',
      DATABASE_URL: 'mysql://lecturelive:lecturelive@127.0.0.1:9/lecturelive',
      JWT_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ENCRYPTION_KEY: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  },
});
