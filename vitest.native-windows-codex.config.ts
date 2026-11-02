import { defineConfig } from 'vitest/config'

import base from './vitest.native.config.js'
if (process.platform !== 'win32') throw new Error('Windows Codex decision checks require Windows.')
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['tests/native/codex-decision-windows.test.ts'], exclude: [] },
})
