import { defineConfig } from 'oxfmt'

export default defineConfig({
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  endOfLine: 'lf',
  insertFinalNewline: true,
  ignorePatterns: [
    'tests/e2e/baseline.json',
    '**/.claude/settings.local.json',
    '**/node_modules/**',
    '**/out/**',
    '**/dist/**',
    '**/release/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/generated/**',
    '**/drizzle/**',
    '**/test-fixtures/raw/**',
    '**/*.snap',
    '**/*.patch',
  ],
  sortImports: {
    internalPattern: ['@pact/', '@renderer/', '@/', '~/'],
    sortSideEffects: false,
    groups: [
      'type-import',
      ['value-builtin', 'value-external'],
      'type-internal',
      'value-internal',
      ['type-parent', 'type-sibling', 'type-index'],
      ['value-parent', 'value-sibling', 'value-index'],
      'unknown',
    ],
  },
  sortPackageJson: {
    sortScripts: true,
  },
})
