const { defineConfig } = require('playwright/test');

module.exports = defineConfig({
  testDir: './playwright/tests',
  timeout: 120 * 1000,
  expect: {
    timeout: 30 * 1000
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    actionTimeout: 0,
    headless: true,
    trace: 'retain-on-failure'
  }
});
