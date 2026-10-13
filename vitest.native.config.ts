import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/native/**/*.test.ts'],
    reporters: ['verbose'],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 30_000,
    testTimeout: 60_000,
    passWithNoTests: false,
  },
})
