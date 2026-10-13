import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    benchmark: {
      include: [
        '**/*.{bench,benchmark}.?(c|m)[jt]s?(x)',
        'packages/persistence/src/session-repository.test.ts',
      ],
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
    },
    environment: 'node',
    // Bound concurrent database/process fixtures without relaxing their deadlines.
    maxWorkers: 2,
    include: [
      'apps/**/*.test.{ts,tsx}',
      'packages/**/*.test.ts',
      'tests/e2e/provider-environment.test.ts',
      'tests/e2e/native-transport-fault.test.ts',
      'tests/e2e/runtime-fixture-cleanup.test.ts',
      'tests/e2e/runtime-fixture-admission.test.ts',
      'tests/e2e/windows-cli-launcher.test.ts',
      'tests/e2e/windows-process-observation.test.ts',
      'tests/e2e/windows-test-command.test.ts',
      'tests/e2e/real-native-evidence.test.ts',
    ],
    passWithNoTests: false,
  },
})
