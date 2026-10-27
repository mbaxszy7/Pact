import { defineConfig } from 'vitest/config'

import {
  claudeDecisionNativeFiles,
  decisionNativeFiles,
  windowsOwnerNativeFiles,
} from './scripts/native-profiles.mjs'

export default defineConfig({
  test: {
    environment: 'node',
    isolate: true,
    setupFiles: ['tests/native/windows-process-owner-setup.ts'],
    include: ['tests/native/**/*.test.ts'],
    exclude: [...decisionNativeFiles, ...claudeDecisionNativeFiles, ...windowsOwnerNativeFiles],
    reporters: ['verbose'],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 30_000,
    testTimeout: 60_000,
    passWithNoTests: false,
  },
})
