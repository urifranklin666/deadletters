'use strict';

const { defineConfig, devices } = require('@playwright/test');

const port = Number.parseInt(process.env.E2E_PORT || '3210', 10);

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: '.e2e-results',
  reporter: process.env.CI ? [['line'], ['html', { open: 'never', outputFolder: '.e2e-report' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'node e2e/run-server.js',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      E2E_PORT: String(port)
    }
  }
});
