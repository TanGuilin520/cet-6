const { defineConfig, devices } = require('@playwright/test');

// Use an isolated test server even if the developer already has port 4173 open.
const port = Number(process.env.CET_BROWSER_TEST_PORT || 4187);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('CET_BROWSER_TEST_PORT must be an integer from 1024 to 65535');
}
const baseURL = `http://127.0.0.1:${port}`;

module.exports = defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: '.venv-main/bin/python tools/browser-test-server.py',
    url: `${baseURL}/reader.html`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      CET_BROWSER_TEST_PORT: String(port),
      DEEPSEEK_API_KEY: '',
      CET_AGENT_URL: '',
      CET_AGENT_TOKEN: '',
      CET_PADDLEOCR_URL: '',
      PYTHONPATH: '',
    },
  },
});
