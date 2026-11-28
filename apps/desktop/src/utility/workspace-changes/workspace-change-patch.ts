import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { WorkspaceFileVersion } from '@pact/contracts'

import {
  blobPathFor,
  copyBlobVersion,
  EMPTY_VERSION,
  isEnoent,
  isTextualBlob,
  verifyFileVersion,
  WorkspaceChangeError,
  writeDurableFile,
} from './workspace-change-fs'
import { workspaceGit } from './workspace-git'

export type CaptureStagedFn = (
  stagedPath: string,
  mode: number | undefined,
  signal: AbortSignal,
) => Promise<WorkspaceFileVersion>

/** Rejects mode-only/chmod diffs, binary diffs, and non-regular file modes (symlinks/gitlinks). */
export function hasUnsupportedPatchMetadata(patch: string): boolean {
  if (/^(?:old mode |new mode |GIT binary patch|Binary files )/mu.test(patch)) return true
  for (const match of patch.matchAll(/^(?:new|deleted) file mode ([0-7]+)\s*$/gmu)) {
    const mode = match[1]
    if (mode !== '100644' && mode !== '100755') return true
  }
  return false
}

export function extractDeletedFileMode(patch: string): number | undefined {
  const match = /^deleted file mode 100([0-7]{3})\s*$/mu.exec(patch)
  if (!match?.[1]) return undefined
  return Number.parseInt(match[1], 8)
}

/**
 * Normalizes synthetic `diff --git` headers that omit `new file mode` / `deleted file mode`
 * alongside `/dev/null` so `git apply` recognizes creation/deletion instead of looking for `dev/null`.
 */
export function normalizeGitApplyPatch(
  patch: string,
  kind: 'added' | 'modified' | 'deleted' | 'renamed',
): string {
  if (!patch.startsWith('diff --git ')) return patch
  if (
    kind === 'added' &&
    /^--- \/dev\/null\r?\n/mu.test(patch) &&
    !/^new file mode /mu.test(patch)
  ) {
    return patch.replace(/^(--- \/dev\/null\r?\n)/mu, 'new file mode 100644\n$1')
  }
  if (
    kind === 'deleted' &&
    /^\+\+\+ \/dev\/null\r?\n/mu.test(patch) &&
    !/^deleted file mode /mu.test(patch)
  ) {
    return patch.replace(
      /^(--- [^\r\n]+\r?\n\+\+\+ \/dev\/null\r?\n)/mu,
      'deleted file mode 100644\n$1',
    )
  }
  return patch
}

function parseNumstatPaths(output: string): string[] {
  const tokens = output.split('\0')
  const paths: string[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    index += 1
    if (!token) continue
    const parts = token.split('\t')
    if (parts.length < 3) continue
    const pathPart = parts.slice(2).join('\t')
    if (pathPart === '') {
      // Rename/copy -z format: "<add>\t<del>\t\0<old>\0<new>\0"
      const oldPath = tokens[index]
      const newPath = tokens[index + 1]
      index += 2
      if (oldPath) paths.push(oldPath)
      if (newPath) paths.push(newPath)
    } else {
      paths.push(pathPart)
    }
  }
  return paths
}

export async function deriveAfterFromBeforeAndPatch(options: {
  storageRoot: string
  stagingRoot: string
  path: string
  kind: 'added' | 'modified' | 'deleted' | 'renamed'
  before: WorkspaceFileVersion
  patch: string
  mode: number
  captureStaged: CaptureStagedFn
  signal: AbortSignal
}): Promise<WorkspaceFileVersion> {
  const { storageRoot, stagingRoot, path, kind, before, patch, mode, captureStaged, signal } =
    options
  const work = join(stagingRoot, `native-patch-${randomUUID()}`)
  const tree = join(work, 'tree')
  const candidate = join(tree, path)
  const patchFile = join(work, 'input.patch')
  try {
    await mkdir(dirname(candidate), { recursive: true, mode: 0o700 })
    if (before.hash) await copyBlobVersion(storageRoot, before, candidate, signal)
    const normalized = normalizeGitApplyPatch(patch, kind)
    await writeDurableFile(patchFile, Buffer.from(normalized))
    const summary = await workspaceGit(['apply', '--numstat', '-z', '--', patchFile], tree, signal)
    const numstatPaths = parseNumstatPaths(summary.output)
    if (summary.code !== 0 || numstatPaths.length !== 1 || numstatPaths[0] !== path)
      throw new Error('The native patch does not describe exactly its recorded file.')
    const check = await workspaceGit(['apply', '--check', '--', patchFile], tree, signal)
    if (check.code !== 0)
      throw new Error('The native patch does not apply to its original version.')
    const applied = await workspaceGit(['apply', '--', patchFile], tree, signal)
    if (applied.code !== 0) throw new Error('Git could not derive the complete native version.')
    if (kind === 'deleted') {
      const stillPresent = await lstat(candidate).catch((error) => {
        if (isEnoent(error)) return undefined
        throw error
      })
      if (stillPresent) throw new Error('The deletion patch did not remove its recorded file.')
      return EMPTY_VERSION
    }
    return await captureStaged(candidate, mode, signal)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * Derives `before` for a complete deletion patch (where the file is absent on disk) by running
 * `git apply --reverse` in one cold-start-cleaned staging directory and verifying forward deletion.
 * Relocatable reverse matching against disk bytes for `modified` or `renamed` is forbidden.
 */
export async function deriveBeforeFromCurrentAndPatch(options: {
  storageRoot: string
  stagingRoot: string
  path: string
  previousPath?: string
  kind: 'added' | 'modified' | 'deleted' | 'renamed'
  current: WorkspaceFileVersion
  patch: string
  mode: number
  captureStaged: CaptureStagedFn
  signal: AbortSignal
}): Promise<WorkspaceFileVersion> {
  const { stagingRoot, path, kind, current, patch, mode, captureStaged, signal } = options
  if (kind !== 'deleted')
    throw new Error(
      'Relocatable reverse patch derivation is forbidden for modified or renamed files.',
    )
  if (current.hash !== null) throw new Error('The deleted file still exists on disk.')
  const work = join(stagingRoot, `native-revpatch-${randomUUID()}`)
  const tree = join(work, 'tree')
  const patchFile = join(work, 'input.patch')
  try {
    const normalized = normalizeGitApplyPatch(patch, kind)
    await mkdir(tree, { recursive: true, mode: 0o700 })
    await writeDurableFile(patchFile, Buffer.from(normalized))

    const summary = await workspaceGit(['apply', '--numstat', '-z', '--', patchFile], tree, signal)
    if (summary.code !== 0) throw new Error('The native patch could not be inspected by Git.')
    const numstatPaths = parseNumstatPaths(summary.output)
    if (numstatPaths.length !== 1 || numstatPaths[0] !== path)
      throw new Error('The native deletion patch does not describe exactly its recorded file.')
    const candidate = join(tree, path)
    await mkdir(dirname(candidate), { recursive: true, mode: 0o700 })
    const revCheck = await workspaceGit(
      ['apply', '--reverse', '--check', '--', patchFile],
      tree,
      signal,
    )
    if (revCheck.code !== 0)
      throw new Error('The native deletion patch could not be reversed cleanly.')
    const revApplied = await workspaceGit(['apply', '--reverse', '--', patchFile], tree, signal)
    if (revApplied.code !== 0)
      throw new Error('Git could not derive the original version of the deleted file.')
    const derivedBefore = await captureStaged(candidate, mode, signal)
    // Forward verification: re-applying the deletion patch must remove the candidate file.
    const fwdCheck = await workspaceGit(['apply', '--check', '--', patchFile], tree, signal)
    if (fwdCheck.code !== 0)
      throw new Error('Forward verification of the native deletion patch failed.')
    const fwdApplied = await workspaceGit(['apply', '--', patchFile], tree, signal)
    if (fwdApplied.code !== 0)
      throw new Error('Forward verification of the native deletion patch could not apply.')
    const stillPresent = await lstat(candidate).catch((error) => {
      if (isEnoent(error)) return undefined
      throw error
    })
    if (stillPresent)
      throw new Error('Forward verification did not reproduce deletion of the recorded file.')
    return derivedBefore
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

export async function threeWayMergeVersion(options: {
  storageRoot: string
  workDir: string
  index: number
  current: WorkspaceFileVersion
  before: WorkspaceFileVersion
  after: WorkspaceFileVersion
  targetMode: number
  captureStaged: CaptureStagedFn
  signal: AbortSignal
}): Promise<WorkspaceFileVersion> {
  const { storageRoot, workDir, index, current, before, after, targetMode, captureStaged, signal } =
    options
  if (!current.hash || !before.hash || !after.hash)
    throw new Error('Path, type or metadata conflict.')
  for (const version of [current, before, after]) {
    // oxlint-disable-next-line no-await-in-loop -- Verify each immutable blob before invoking Git merge-file.
    await verifyFileVersion(blobPathFor(storageRoot, version.hash!), version, signal)
  }
  if (
    !(await isTextualBlob(storageRoot, current, signal)) ||
    !(await isTextualBlob(storageRoot, before, signal)) ||
    !(await isTextualBlob(storageRoot, after, signal))
  )
    throw new Error('Binary conflict.')
  const merged = join(workDir, `merged-${index}`)
  try {
    const result = await workspaceGit(
      [
        'merge-file',
        '-p',
        blobPathFor(storageRoot, current.hash),
        blobPathFor(storageRoot, after.hash),
        blobPathFor(storageRoot, before.hash),
      ],
      workDir,
      signal,
      merged,
    )
    if (result.code !== 0) throw new Error('Text conflict.')
    return await captureStaged(merged, targetMode, signal)
  } finally {
    await unlink(merged).catch(() => undefined)
  }
}

export async function computeDiffStatistics(options: {
  storageRoot: string
  before: WorkspaceFileVersion
  after: WorkspaceFileVersion
  workDir: string
  signal: AbortSignal
}): Promise<{ additions: number | null; deletions: number | null }> {
  const { storageRoot, before, after, workDir, signal } = options
  const empty = join(workDir, 'empty')
  await writeDurableFile(empty, Buffer.alloc(0), true)
  const result = await workspaceGit(
    [
      'diff',
      '--no-index',
      '--numstat',
      '-z',
      '--',
      before.hash ? blobPathFor(storageRoot, before.hash) : empty,
      after.hash ? blobPathFor(storageRoot, after.hash) : empty,
    ],
    workDir,
    signal,
  )
  if (result.code > 1)
    throw new WorkspaceChangeError('VALIDATION', 'Git could not inspect the saved change.')
  if (!result.output) return { additions: 0, deletions: 0 }
  const [added, removed] = result.output.split('\t')
  return {
    additions: added === '-' ? null : Number(added),
    deletions: removed === '-' ? null : Number(removed),
  }
}
