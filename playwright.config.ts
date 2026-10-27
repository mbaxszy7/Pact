import { defineConfig } from '@playwright/test'
import { registerHooks } from 'node:module'

// Contracts export their actual TypeScript sources as ESM. Playwright 1.63's
// transform cache is keyed by filename across import/require, so Desktop's CJS
// imports can otherwise reuse ESM text incorrectly labelled as CommonJS. Keep
// this exact workspace package in its declared format; do not replace its code.
const contractsSource = new URL('./packages/contracts/src/', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(contractsSource) && url.endsWith('.ts'))
      return nextLoad(url, {
        ...context,
        format: 'module',
        conditions: [
          ...new Set([...context.conditions.filter((value) => value !== 'require'), 'import']),
        ],
      })
    return nextLoad(url, context)
  },
})

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
