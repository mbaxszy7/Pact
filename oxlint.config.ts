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
  jsPlugins: ['./scripts/oxlint-pact-plugin.mjs'],
  categories: {
    correctness: 'error',
    suspicious: 'error',
    perf: 'warn',
  },
  rules: {
    'import/no-cycle': 'error',
    'pact/no-async-transaction-callback': 'error',
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
      files: ['apps/desktop/src/{main,preload,utility}/**/*.ts'],
      env: { node: true },
      rules: {
        'unicorn/require-post-message-target-origin': 'off',
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: '@pact/persistence',
                importNames: [
                  'appSetupState',
                  'agentEventJournal',
                  'agentRunActivities',
                  'agentRuns',
                  'workspaceChangeSets',
                  'workspaceBlobs',
                  'workspaceFileChanges',
                  'workspaceChangeIntents',
                  'anchoredComments',
                  'commentDraftReceipts',
                  'collaborationTasks',
                  'workflowTurns',
                  'conversationInputBatches',
                  'conversationInputBatchMembers',
                  'conversationRunSourceRefs',
                  'conversationRebuildSourceRefs',
                  'conversationMessages',
                  'conversationImageAssets',
                  'conversationMessageImages',
                  'conversationBodyInputs',
                  'conversationBodyParts',
                  'conversationCutoffs',
                  'conversationCutoffRevisions',
                  'defaultSessionSettings',
                  'sessionCatalogRevisions',
                  'pactSchemaMeta',
                  'projects',
                  'nativeAgentContexts',
                  'runtimeCliPaths',
                  'sessions',
                  'sideChatOperations',
                  'sessionSettingsRevisions',
                  'sessionGroups',
                  'sessionGroupMembers',
                  'schema',
                ],
                message:
                  'Single-writer boundary: production code outside @pact/persistence must access SQLite tables through Repository owners, never raw Drizzle table handles.',
              },
            ],
            patterns: [
              {
                group: ['**/packages/persistence/src/schema*'],
                message:
                  'Single-writer boundary: production code outside @pact/persistence must not import persistence schema files directly.',
              },
            ],
          },
        ],
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
    {
      files: [
        'apps/desktop/src/{main,preload,utility}/**/*.{test,spec}.ts',
        'apps/desktop/src/{main,preload,utility}/**/*.test-support.ts',
      ],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
    {
      files: ['**/*.deterministic.test.ts', 'packages/agent-runtime/**/*.test.ts'],
      rules: {
        'pact/no-real-time-wait-in-deterministic-tests': 'error',
      },
    },
  ],
})
