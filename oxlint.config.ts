import { defineConfig } from 'oxlint'

export default defineConfig({
  ignorePatterns: [
    '**/node_modules/**',
    '**/out/**',
    '**/dist/**',
    '**/release/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/generated/**',
    '**/test-fixtures/raw/**',
    '**/*.min.js',
  ],
  options: {
    typeAware: true,
    typeCheck: false,
    denyWarnings: true,
    reportUnusedDisableDirectives: 'error',
  },
  plugins: [
    'eslint',
    'typescript',
    'react',
    'import',
    'unicorn',
    'oxc',
    'jsx-a11y',
    'vitest',
    'node',
    'promise',
  ],
  categories: {
    correctness: 'error',
    suspicious: 'error',
    perf: 'warn',
  },
  rules: {
    'import/no-cycle': 'error',
    'react/jsx-key': 'error',
    'react/react-in-jsx-scope': 'off',
    'typescript/no-floating-promises': 'error',
    'typescript/no-misused-promises': 'error',
  },
  overrides: [
    {
      files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
      env: { browser: true },
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  'electron',
                  'node:*',
                  'better-sqlite3',
                  '@pact/agent-runtime',
                  '@pact/agent-adapters',
                  '@pact/persistence',
                ],
                message: 'Renderer must use the DesktopBridge interface for privileged work.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['apps/desktop/src/{main,utility}/**/*.ts'],
      env: { node: true },
      rules: {
        'unicorn/require-post-message-target-origin': 'off',
      },
    },
    {
      files: ['apps/desktop/src/renderer/src/main.tsx'],
      rules: {
        'import/no-unassigned-import': 'off',
      },
    },
    {
      files: ['**/*.{test,spec}.{ts,tsx}', 'packages/test-fixtures/**'],
      env: { node: true },
      rules: {
        'typescript/no-explicit-any': 'off',
      },
    },
  ],
})
