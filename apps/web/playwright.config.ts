import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: process.env.BUNKHOUSE_E2E_BASE_URL ?? 'http://localhost:4811',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
