import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { isScriptEntry } from './script-entry.mjs'

export const MAX_PRODUCTION_FILE_LINES = 2500

/**
 * Monotonic shrinking ratchet for legacy oversized production files.
 * Rules:
 * - No new file may exceed MAX_PRODUCTION_FILE_LINES.
 * - Existing allowlisted files may never grow above their recorded cap.
 * - Once an allowlisted file drops to <= MAX_PRODUCTION_FILE_LINES (or is deleted),
 *   its entry MUST be removed from this ratchet immediately.
 */
export const LEGACY_FILE_LINE_RATCHET = Object.freeze({
  'apps/desktop/src/utility/conversation/agy-agent-adapter.ts': 8170,
  'apps/desktop/src/utility/conversation/conversation.ts': 11530,
  'apps/desktop/src/utility/conversation/codex-agent-adapter.ts': 7417,
  'apps/desktop/src/utility/conversation/claude-agent-adapter.ts': 5919,
  'apps/desktop/src/renderer/src/components/conversation/useConversation.ts': 4662,
  'packages/contracts/src/index.ts': 4470,
  'apps/desktop/src/renderer/src/components/conversation/ConversationView.tsx': 4199,
  'packages/persistence/src/conversation-repository/collaboration-queries.ts': 3293,
  'apps/desktop/src/main/utility-process/client.ts': 3264,
  'packages/persistence/src/side-chat-persistence.ts': 2878,
  'packages/persistence/src/conversation-repository/handoff-source-queries.ts': 2857,
  'packages/persistence/src/session-repository.ts': 2805,
  'packages/persistence/src/conversation-repository/relay-decision-queries.ts': 2762,
  'packages/persistence/src/conversation-repository/native-rebuild-queries.ts': 2738,
  'apps/desktop/src/utility/conversation/native-fork-worker.ts': 2640,
  'apps/desktop/src/renderer/src/components/project-file/WorkspaceChangesPanel.tsx': 2612,
})

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'release',
  'coverage',
  'generated',
  'drizzle',
])

const TEST_FILE_PATTERN = /\.(?:test|spec|test-support)\.(?:ts|tsx)$/u
const SOURCE_FILE_PATTERN = /\.(?:ts|tsx)$/u

function walkProductionSourceFiles(rootDir, currentDir, out) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      walkProductionSourceFiles(rootDir, resolve(currentDir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (!SOURCE_FILE_PATTERN.test(entry.name) || TEST_FILE_PATTERN.test(entry.name)) continue
    const fullPath = resolve(currentDir, entry.name)
    out.push(relative(rootDir, fullPath).replaceAll('\\', '/'))
  }
}

export function countLines(text) {
  if (!text) return 0
  let count = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1
  }
  return text.endsWith('\n') ? count : count + 1
}

export function checkArchitectureBudgets(rootDir = resolve(import.meta.dirname, '..')) {
  const files = []
  for (const top of ['apps', 'packages']) {
    walkProductionSourceFiles(rootDir, resolve(rootDir, top), files)
  }
  const seen = new Set(files)
  const problems = []

  for (const relPath of files.toSorted((left, right) => left.localeCompare(right))) {
    const lineCount = countLines(readFileSync(resolve(rootDir, relPath), 'utf8'))
    const cap = LEGACY_FILE_LINE_RATCHET[relPath]
    if (cap !== undefined) {
      if (lineCount > cap) {
        problems.push(
          `${relPath}: ${lineCount} lines exceeds legacy ratchet cap ${cap} (monolith files may only shrink)`,
        )
      } else if (lineCount <= MAX_PRODUCTION_FILE_LINES) {
        problems.push(
          `${relPath}: ${lineCount} lines is now <= ${MAX_PRODUCTION_FILE_LINES}; remove it from LEGACY_FILE_LINE_RATCHET`,
        )
      }
      continue
    }
    if (lineCount > MAX_PRODUCTION_FILE_LINES) {
      problems.push(
        `${relPath}: ${lineCount} lines exceeds MAX_PRODUCTION_FILE_LINES (${MAX_PRODUCTION_FILE_LINES})`,
      )
    }
  }

  for (const relPath of Object.keys(LEGACY_FILE_LINE_RATCHET)) {
    if (!seen.has(relPath)) {
      problems.push(`${relPath}: no longer exists; remove it from LEGACY_FILE_LINE_RATCHET`)
    }
  }

  return { checkedFiles: files.length, problems }
}

if (isScriptEntry(import.meta.url)) {
  const { checkedFiles, problems } = checkArchitectureBudgets()
  for (const problem of problems) console.error(problem)
  if (problems.length === 0) {
    console.log(
      `Architecture budgets passed for ${checkedFiles} production source files (${Object.keys(LEGACY_FILE_LINE_RATCHET).length} legacy ratchet entries remaining).`,
    )
    process.exitCode = 0
  } else {
    process.exitCode = 1
  }
}
