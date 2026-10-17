import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import { isScriptEntry } from './script-entry.mjs'

const selectedWorkspace = process.env.PACT_CI_WORKSPACE
if (selectedWorkspace !== undefined && !isAbsolute(selectedWorkspace))
  throw new Error('Publication workspace must be an explicit absolute path.')
const root = selectedWorkspace ?? resolve(import.meta.dirname, '..')
export const publicationLimits = {
  paths: 4096,
  pathBytes: 1024 * 1024,
  singlePathBytes: 1024,
  documentBytes: 128 * 1024,
  totalDocumentBytes: 512 * 1024,
  problems: 128,
  problemBytes: 64 * 1024,
}

function validatePaths(paths) {
  if (paths.length > publicationLimits.paths)
    throw new Error('Publication path count exceeds its bound')
  let bytes = 0
  for (const path of paths) {
    const size = Buffer.byteLength(path)
    bytes += size + 1
    if (size > publicationLimits.singlePathBytes || bytes > publicationLimits.pathBytes)
      throw new Error('Publication path bytes exceed their bound')
  }
}
export const publicDocuments = new Set([
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'docs/product/requirements.md',
  'docs/technical-foundation.md',
  'apps/desktop/PRODUCT.md',
  'apps/desktop/DESIGN.md',
])
const designReferences = new Set(
  ['opaque-light', 'opaque-dark', 'translucent-light', 'translucent-dark'].map(
    (name) => `apps/desktop/design-references/main-workspace/${name}.png`,
  ),
)

export function publicationProblems(files) {
  if (files.size > publicationLimits.paths)
    throw new Error('Publication path count exceeds its bound')
  validatePaths([...files.keys()])
  const problems = []
  let problemBytes = 0
  const problem = (message) => {
    problemBytes += Buffer.byteLength(message)
    if (
      problems.length >= publicationLimits.problems ||
      problemBytes > publicationLimits.problemBytes
    )
      throw new Error('Publication diagnostics exceed their bound')
    problems.push(message)
  }
  let documentBytes = 0
  const paths = new Set(files.keys())
  for (const [path, contents] of files) {
    if (
      /(?:^|\/)(?:node_modules|out|dist|release|coverage|test-results|playwright-report|\.pact-data|\.git|\.ssh|\.aws|\.codex|\.claude)(?:\/|$)/u.test(
        path,
      ) ||
      /^docs\/(?:plans|deliveries|delivery-evidence)\//u.test(path) ||
      path.startsWith('tests/e2e/env/') ||
      /(?:^|\/)(?:auth\.json|credentials(?:\.json)?|\.gitleaksignore|\.env(?:\..*)?)$/u.test(
        path,
      ) ||
      /\.(?:pem|key|p12|pfx|cer|mobileprovision|sqlite(?:-(?:wal|shm))?|db(?:-(?:wal|shm))?|log|tsbuildinfo)$/iu.test(
        path,
      )
    )
      problem(`${path}: private, generated or historical material is not publishable`)
    if (/\.(?:md|mdx|rst|txt|pdf|docx|pptx|xlsx)$/iu.test(path) && !publicDocuments.has(path))
      problem(`${path}: document is outside the reviewed public allowlist`)
    if (path.includes('/.impeccable/') && path !== 'apps/desktop/.impeccable/design.json')
      problem(`${path}: unreviewed design-tool data`)
    if (path.includes('/design-references/') && !designReferences.has(path))
      problem(`${path}: unreviewed visual reference`)
    if (!publicDocuments.has(path)) continue
    if (!Buffer.isBuffer(contents)) throw new Error('Publication document content is unavailable')
    documentBytes += contents.length
    if (
      contents.length > publicationLimits.documentBytes ||
      documentBytes > publicationLimits.totalDocumentBytes
    )
      throw new Error('Publication document bytes exceed their bound')
    const text = contents.toString('utf8')
    if (/[\u3400-\u9fff]/u.test(text)) problem(`${path}: public documentation must be English`)
    if (
      /(?:\/Users\/[^\s/]+|[A-Z]:[\\/]Users[\\/][^\s\\/]+|agfahealthcare|atlassian\.net)/iu.test(
        text,
      )
    )
      problem(`${path}: personal or private development context`)
    for (const match of text.matchAll(/\]\(([^)]+)\)/gu)) {
      const link = match[1].split('#')[0]
      if (!link || /^(?:https?:|mailto:)/u.test(link)) continue
      const target = relative(root, resolve(root, dirname(path), link)).replaceAll('\\', '/')
      if (isAbsolute(target) || target === '..' || target.startsWith('../'))
        problem(`${path}: local link escapes the repository`)
      else if (!paths.has(target)) problem(`${path}: unavailable local link`)
    }
  }
  for (const path of [
    ...publicDocuments,
    'LICENSE',
    ...designReferences,
    'apps/desktop/.impeccable/design.json',
  ])
    if (!paths.has(path)) problem(`${path}: required public material is missing`)
  return problems
}

export function checkPublication(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== '--staged') || args.length > 1)
    throw new Error('Only --staged is supported')
  const staged = args.includes('--staged')
  const pathText = execFileSync(
    'git',
    staged ? ['ls-files', '-z'] : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: publicationLimits.pathBytes },
  )
  const paths = pathText.split('\0', publicationLimits.paths + 2).filter(Boolean)
  validatePaths(paths)
  const files = new Map()
  const buffer = Buffer.alloc(publicationLimits.documentBytes + 1)
  let documentBytes = 0
  for (const path of new Set(paths)) {
    if (!staged && !existsSync(resolve(root, path))) continue
    if (!publicDocuments.has(path)) {
      files.set(path, undefined)
      continue
    }
    const remaining = Math.min(
      publicationLimits.documentBytes,
      publicationLimits.totalDocumentBytes - documentBytes,
    )
    let contents
    if (staged) {
      contents = execFileSync('git', ['show', `:${path}`], {
        cwd: root,
        timeout: 10_000,
        maxBuffer: remaining,
      })
    } else {
      const descriptor = openSync(resolve(root, path), 'r')
      let size = 0
      try {
        while (size <= remaining) {
          const count = readSync(descriptor, buffer, size, remaining + 1 - size, null)
          if (!count) break
          size += count
        }
      } finally {
        closeSync(descriptor)
      }
      if (size > remaining) throw new Error('Publication document bytes exceed their bound')
      contents = Buffer.from(buffer.subarray(0, size))
    }
    documentBytes += contents.length
    files.set(path, contents)
  }
  const problems = publicationProblems(files)
  for (const problem of problems) console.error(problem)
  if (!problems.length) console.log(`Publication policy passed for ${files.size} files.`)
  return problems.length ? 1 : 0
}

if (isScriptEntry(import.meta.url))
  try {
    process.exitCode = checkPublication()
  } catch {
    console.error('Publication policy could not inspect the complete file set')
    process.exitCode = 1
  }
