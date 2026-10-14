import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: process.env.PACT_E2E_OUTPUT_DIR ?? './test-results',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  globalTimeout: 2 * 60 * 60_000,
  reporter: [['list']],
  timeout: 120_000,
  projects: [
    { name: 'ui', grep: /@ui\b/u, use: { trace: 'retain-on-failure' } },
    // Secrets stay in private configuration files; do not export raw provider traces.
    { name: 'real', grep: /@real\b/u, use: { trace: 'off', screenshot: 'off' } },
    { name: 'deterministic', grep: /@deterministic\b/u, use: { trace: 'retain-on-failure' } },
  ],
})
