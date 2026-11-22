/* oxlint-disable no-await-in-loop -- Undo preflight, staging and atomic directory mutations are deliberately sequential to bound memory and guarantee zero-write refusal. */

import { lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type { WorkspaceChangesRepository } from '@pact/persistence'

import {
  WORKSPACE_ROUND_BYTES,
  type DirectoryFileOperationResult,
  type DirectoryIdentity,
  type WorkspaceFileChange,
  type WorkspaceFileVersion,
} from '@pact/contracts'

import {
  blobPathFor,
  copyBlobVersion,
  EMPTY_VERSION,
  isEnoent,
  isTextualBlob,
  safeRelativePath,
  verifyFileVersion,
  versionsEqual,
  WorkspaceChangeError,
  type ApplyFile,
  type StandardDirectoryOperation,
  type UndoOperation,
  type WorkspaceReservation,
} from './workspace-change-fs'
import { threeWayMergeVersion, type CaptureStagedFn } from './workspace-change-patch'

export interface UndoExecutionContext {
  repository: WorkspaceChangesRepository
  storageRoot: string
  capture: (
    root: string,
    path: string,
    signal: AbortSignal,
    reservation: WorkspaceReservation,
  ) => Promise<WorkspaceFileVersion>
  observe: (
    reservation: WorkspaceReservation,
    path: string,
    signal: AbortSignal,
  ) => Promise<WorkspaceFileVersion>
  captureStaged: CaptureStagedFn
  validateDirectoryJob: (
    reservation: WorkspaceReservation,
    rawPath: string,
    operation: StandardDirectoryOperation,
    auxiliaryPath?: string,
  ) => void
  directoryJob: (
    reservation: WorkspaceReservation,
    rawPath: string,
    operation: StandardDirectoryOperation,
    signal: AbortSignal,
    auxiliaryPath?: string,
  ) => Promise<Extract<DirectoryFileOperationResult, { ok: true }>>
  inspectParentDirs: (
    reservation: WorkspaceReservation,
    rawPath: string,
    signal: AbortSignal,
  ) => Promise<{ parentDirs: DirectoryIdentity[]; missingDirs: string[] }>
  ensureParentDirs: (
    reservation: WorkspaceReservation,
    rawPath: string,
    signal: AbortSignal,
  ) => Promise<DirectoryIdentity[]>
  roundVersions: (id: string) => { bytes: number; hashes: Set<string> }
}

export interface UndoSelection {
  targetPath: string | undefined
  targets: WorkspaceFileChange[]
}

export interface PreflightInstallParents {
  existing: DirectoryIdentity[]
  missing: string[]
}

export interface UndoPlan {
  prepared: ApplyFile[]
  installParents: Map<string, PreflightInstallParents>
}

function isFileUndoEvidenceComplete(file: WorkspaceFileChange): boolean {
  return (
    file.undoStrategy !== 'unavailable' &&
    file.undoStrategy !== 'patch' &&
    file.beforeAvailable !== false &&
    file.afterAvailable !== false
  )
}

export function selectUndoTargets(
  repository: WorkspaceChangesRepository,
  changeSetId: string,
  path?: string,
): UndoSelection {
  const changeSet = repository.find(changeSetId)
  if (!changeSet) throw new WorkspaceChangeError('VALIDATION', 'This saved round is unavailable.')
  if (path !== undefined) {
    if (
      changeSet.undoUnavailableReason !== null ||
      (changeSet.state !== 'ready' && changeSet.state !== 'mixed')
    )
      throw new WorkspaceChangeError(
        'WORKSPACE_UNDO_UNAVAILABLE',
        changeSet.undoUnavailableReason ?? 'This round is unavailable for Undo.',
      )
    const normalized = safeRelativePath(path)
    const file = repository.file(changeSetId, normalized)
    if (!file || file.hidden)
      throw new WorkspaceChangeError('VALIDATION', 'This file is not part of the round.')
    if (file.undone)
      throw new WorkspaceChangeError(
        'WORKSPACE_UNDO_UNAVAILABLE',
        'This file has already been undone.',
      )
    if (!isFileUndoEvidenceComplete(file))
      throw new WorkspaceChangeError(
        'WORKSPACE_UNDO_UNAVAILABLE',
        file.reason ?? 'Complete original and final native file versions are unavailable for Undo.',
      )
    return { targetPath: normalized, targets: [file] }
  }
  if (changeSet.state !== 'ready' || changeSet.undoUnavailableReason !== null)
    throw new WorkspaceChangeError(
      'WORKSPACE_UNDO_UNAVAILABLE',
      repository.summary(changeSetId).undoUnavailableReason ?? 'This round cannot be undone again.',
    )
  const remaining = repository.files(changeSetId).filter((file) => !file.hidden && !file.undone)
  if (remaining.length === 0)
    throw new WorkspaceChangeError(
      'WORKSPACE_UNDO_UNAVAILABLE',
      'No undoable files remain in this round.',
    )
  const unavailable = remaining.find((file) => !isFileUndoEvidenceComplete(file))
  if (unavailable)
    throw new WorkspaceChangeError(
      'WORKSPACE_UNDO_UNAVAILABLE',
      unavailable.reason ??
        'Complete original and final native file versions are unavailable for Undo.',
    )
  return { targetPath: undefined, targets: remaining }
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.path === right.path && left.device === right.device && left.inode === right.inode
}

function assertExpectedParentsMatch(
  expected: readonly DirectoryIdentity[],
  actual: readonly DirectoryIdentity[],
  message: string,
): void {
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]))
  for (const dir of expected) {
    const observed = actualByPath.get(dir.path)
    if (!observed || !sameDirectoryIdentity(dir, observed)) throw new Error(message)
  }
}

async function assertTextualEndpoints(
  storageRoot: string,
  versions: readonly WorkspaceFileVersion[],
  signal: AbortSignal,
): Promise<void> {
  const checked = new Set<string>()
  for (const version of versions) {
    if (!version.hash || checked.has(version.hash)) continue
    checked.add(version.hash)
    if (!(await isTextualBlob(storageRoot, version, signal)))
      throw new Error('Binary or non-UTF-8 file content cannot be undone safely.')
  }
}

/**
 * Preflights every target file and stages all rollback candidates into `work`.
 * Zero Project files are created, removed, or replaced during this function.
 */
export async function planUndoOperations(
  ctx: UndoExecutionContext,
  reservation: WorkspaceReservation,
  changeSetId: string,
  work: string,
  targets: readonly WorkspaceFileChange[],
  singleFilePath: string | undefined,
  signal: AbortSignal,
): Promise<UndoPlan> {
  const prepared: ApplyFile[] = []
  const installParents = new Map<string, PreflightInstallParents>()
  const conflicts: string[] = []
  const plannedPaths = new Set<string>()
  let candidateBytes = 0
  let backupBytes = 0
  const retained = ctx.roundVersions(changeSetId)

  const trackBudget = (
    versions: readonly WorkspaceFileVersion[],
    addCandidateBytes: number,
    addBackupBytes: number,
  ): void => {
    candidateBytes += addCandidateBytes
    backupBytes += addBackupBytes
    for (const version of versions) {
      if (version.hash && !retained.hashes.has(version.hash)) {
        retained.hashes.add(version.hash)
        retained.bytes += version.bytes
      }
    }
    if (
      candidateBytes + backupBytes > WORKSPACE_ROUND_BYTES ||
      retained.bytes + backupBytes > WORKSPACE_ROUND_BYTES
    )
      throw new WorkspaceChangeError(
        'VALIDATION',
        'Undo candidates exceed the round temporary-storage budget.',
      )
  }

  const claimPath = (relPath: string): void => {
    if (plannedPaths.has(relPath)) throw new Error('Multiple Undo operations target the same path.')
    plannedPaths.add(relPath)
  }

  for (const file of targets) {
    signal.throwIfAborted()
    try {
      if (!isFileUndoEvidenceComplete(file))
        throw new Error('Complete original and final native file versions are unavailable.')

      // Validate path components, <= 128 directory depth, live-DB exclusion, and request size
      // before any disk inspection or staging, even when parent directories are currently absent.
      ctx.validateDirectoryJob(reservation, file.path, 'capture')
      ctx.validateDirectoryJob(reservation, file.path, 'inspect_parents')
      ctx.validateDirectoryJob(reservation, file.path, 'mkdir_parents')

      // 1. Renamed file rollback: require trusted modes, verify destination & source absence, restore source and remove destination.
      if (file.previousPath !== null) {
        if (file.modeKnown === false)
          throw new Error('Renamed file lacks trusted file mode metadata for Undo.')
        const sourcePath = safeRelativePath(file.previousPath)
        ctx.validateDirectoryJob(reservation, sourcePath, 'capture')
        ctx.validateDirectoryJob(reservation, sourcePath, 'inspect_parents')
        ctx.validateDirectoryJob(reservation, sourcePath, 'mkdir_parents')
        if (sourcePath === file.path || !file.before.hash || !file.after.hash)
          throw new Error('Incomplete rename metadata for Undo.')
        const currentDest = await ctx.capture(reservation.root, file.path, signal, reservation)
        if (!currentDest.hash || !versionsEqual(currentDest, file.after))
          throw new Error('Renamed destination changed after this round.')
        const currentSource = await ctx.observe(reservation, sourcePath, signal)
        if (currentSource.hash !== null)
          throw new Error('Original rename source path already exists on disk.')
        await verifyFileVersion(blobPathFor(ctx.storageRoot, file.before.hash), file.before, signal)
        await assertTextualEndpoints(ctx.storageRoot, [file.before, file.after], signal)
        const sourceParents = await ctx.inspectParentDirs(reservation, sourcePath, signal)
        const desiredSource: WorkspaceFileVersion = {
          hash: file.before.hash,
          bytes: file.before.bytes,
          mode: file.before.mode,
        }
        claimPath(file.path)
        claimPath(sourcePath)
        trackBudget([currentDest, desiredSource], desiredSource.bytes, currentDest.bytes)
        const destIndex = prepared.length
        const sourceIndex = destIndex + 1
        const destBackup = join(work, `original-${destIndex}`)
        const sourceBackup = join(work, `original-${sourceIndex}`)
        const stageSource = join(work, `candidate-${sourceIndex}`)
        ctx.validateDirectoryJob(reservation, file.path, 'stash', destBackup)
        ctx.validateDirectoryJob(reservation, file.path, 'absent')
        ctx.validateDirectoryJob(reservation, sourcePath, 'install', stageSource)
        await copyBlobVersion(ctx.storageRoot, desiredSource, stageSource, signal)
        installParents.set(sourcePath, {
          existing: sourceParents.parentDirs,
          missing: sourceParents.missingDirs,
        })
        prepared.push(
          {
            path: file.path,
            before: currentDest,
            after: EMPTY_VERSION,
            stage: null,
            backup: destBackup,
          },
          {
            path: sourcePath,
            before: EMPTY_VERSION,
            after: desiredSource,
            stage: stageSource,
            backup: sourceBackup,
          },
        )
        continue
      }

      // 2. Added file rollback: require verified final mode and textual content, check exact version match, then remove file (preserving parent dirs).
      if (file.before.hash === null) {
        if (file.modeKnown === false)
          throw new Error('Added file lacks verified final file mode for Undo.')
        if (!file.after.hash) throw new Error('Added file lacks final version evidence.')
        const current = await ctx.capture(reservation.root, file.path, signal, reservation)
        if (!current.hash || !versionsEqual(current, file.after))
          throw new Error('Added file was modified or removed after this round.')
        await assertTextualEndpoints(ctx.storageRoot, [file.after], signal)
        claimPath(file.path)
        trackBudget([current], 0, current.bytes)
        const index = prepared.length
        const backup = join(work, `original-${index}`)
        ctx.validateDirectoryJob(reservation, file.path, 'stash', backup)
        ctx.validateDirectoryJob(reservation, file.path, 'absent')
        prepared.push({
          path: file.path,
          before: current,
          after: EMPTY_VERSION,
          stage: null,
          backup,
        })
        continue
      }

      // 3. Deleted file rollback: require trusted original mode (preserving 0o000), verify absence, exclusively install before blob.
      if (file.after.hash === null) {
        if (file.modeKnown === false)
          throw new Error('Deleted file lacks trusted original file mode for Undo.')
        const current = await ctx.observe(reservation, file.path, signal)
        if (current.hash !== null) throw new Error('Deleted file path already exists on disk.')
        await verifyFileVersion(blobPathFor(ctx.storageRoot, file.before.hash), file.before, signal)
        await assertTextualEndpoints(ctx.storageRoot, [file.before], signal)
        const targetParents = await ctx.inspectParentDirs(reservation, file.path, signal)
        const desired: WorkspaceFileVersion = {
          hash: file.before.hash,
          bytes: file.before.bytes,
          mode: file.before.mode,
        }
        claimPath(file.path)
        trackBudget([desired], desired.bytes, 0)
        const index = prepared.length
        const backup = join(work, `original-${index}`)
        const stage = join(work, `candidate-${index}`)
        ctx.validateDirectoryJob(reservation, file.path, 'install', stage)
        await copyBlobVersion(ctx.storageRoot, desired, stage, signal)
        installParents.set(file.path, {
          existing: targetParents.parentDirs,
          missing: targetParents.missingDirs,
        })
        prepared.push({
          path: file.path,
          before: EMPTY_VERSION,
          after: desired,
          stage,
          backup,
        })
        continue
      }

      // 4. Modified file rollback: exact match or Git 3-way merge preserving non-overlapping later user edits.
      // Only in-place text modification rollback may preserve current regular-file mode when modeKnown === false.
      const textOnly = file.modeKnown === false
      const current = await ctx.capture(reservation.root, file.path, signal, reservation)
      if (!current.hash) throw new Error('Modified file was removed after this round.')
      await assertTextualEndpoints(ctx.storageRoot, [file.before, file.after, current], signal)
      const targetParents = await ctx.inspectParentDirs(reservation, file.path, signal)
      if (targetParents.missingDirs.length > 0)
        throw new Error('A parent directory disappeared during Undo preflight.')
      let desired: WorkspaceFileVersion = textOnly
        ? { ...file.before, mode: current.mode }
        : file.before
      if (
        textOnly
          ? current.hash !== file.after.hash || current.bytes !== file.after.bytes
          : !versionsEqual(current, file.after)
      ) {
        if (
          (!textOnly && current.mode !== file.after.mode) ||
          (!textOnly && file.before.mode !== file.after.mode)
        )
          throw new Error('Path, type or metadata conflict.')
        desired = await threeWayMergeVersion({
          storageRoot: ctx.storageRoot,
          workDir: work,
          index: prepared.length,
          current,
          before: file.before,
          after: file.after,
          targetMode: textOnly ? current.mode : file.before.mode,
          captureStaged: ctx.captureStaged,
          signal,
        })
      }
      claimPath(file.path)
      trackBudget([current, desired], desired.bytes, current.bytes)
      const index = prepared.length
      const backup = join(work, `original-${index}`)
      const stage = join(work, `candidate-${index}`)
      ctx.validateDirectoryJob(reservation, file.path, 'stash', backup)
      ctx.validateDirectoryJob(reservation, file.path, 'install', stage)
      await copyBlobVersion(ctx.storageRoot, desired, stage, signal)
      installParents.set(file.path, {
        existing: targetParents.parentDirs,
        missing: [],
      })
      prepared.push({
        path: file.path,
        before: current,
        after: desired,
        stage,
        backup,
      })
    } catch (error) {
      if (signal.aborted) throw error
      if (
        error instanceof WorkspaceChangeError &&
        error.code === 'VALIDATION' &&
        error.message.includes('temporary-storage budget')
      )
        throw error
      conflicts.push(file.path)
    }
  }

  // Nothing above this line creates/removes/replaces any Project file.
  if (conflicts.length) {
    const scopeLabel = singleFilePath ? `file ${singleFilePath}` : 'the entire round'
    throw new WorkspaceChangeError(
      'WORKSPACE_CONFLICT',
      `Undo was refused for ${scopeLabel}. No files were changed. Conflicts: ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? '…' : ''}`,
    )
  }

  for (const file of prepared) {
    const current = await ctx.observe(reservation, file.path, signal)
    if (!versionsEqual(current, file.before))
      throw new WorkspaceChangeError(
        'WORKSPACE_CONFLICT',
        `Undo was refused because ${file.path} changed during checking. No files were changed.`,
      )
  }

  return { prepared, installParents }
}

/** Executes the staged rollback atomically via protected directory operations. */
export async function applyUndoOperations(
  ctx: UndoExecutionContext,
  reservation: WorkspaceReservation,
  plan: UndoPlan,
  signal: AbortSignal,
  intentId: string,
  operation: UndoOperation,
  requireIdle: () => void,
): Promise<void> {
  const { prepared, installParents } = plan
  let actualBackupBytes = 0

  for (const file of prepared) {
    signal.throwIfAborted()
    requireIdle()
    if (file.before.hash) {
      let stashFailure: { error: unknown } | undefined
      try {
        operation.applicationStarted = true
        await ctx.directoryJob(reservation, file.path, 'stash', signal, file.backup)
      } catch (error) {
        stashFailure = { error }
      }
      const saved = await lstat(file.backup).catch((error) => {
        if (isEnoent(error)) return undefined
        throw error
      })
      if (saved) actualBackupBytes += saved.size
      const intent = ctx.repository.findIntent(intentId)!
      const remainingEstimate = prepared
        .slice(prepared.indexOf(file) + 1)
        .reduce((sum, later) => sum + later.before.bytes, 0)
      const retainedBytes = Math.max(intent.retainedBytes, actualBackupBytes + remainingEstimate)
      ctx.repository.intent({ ...intent, retainedBytes })
      if (stashFailure) throw stashFailure.error
      const actual = await ctx.captureStaged(file.backup, undefined, signal)
      if (!versionsEqual(actual, file.before))
        throw new Error(
          'A source changed after Undo preflight; its actual object was preserved. Undo did not complete.',
        )
    }
  }

  const createdDuringUndo = new Map<string, DirectoryIdentity>()

  for (const file of prepared) {
    signal.throwIfAborted()
    if (file.stage) {
      requireIdle()
      const expectedParents = installParents.get(file.path)
      if (!expectedParents)
        throw new Error('Missing preflight parent directory verification for Undo install.')
      const currentParents = await ctx.inspectParentDirs(reservation, file.path, signal)
      assertExpectedParentsMatch(
        expectedParents.existing,
        currentParents.parentDirs,
        'An existing parent directory changed or disappeared before Undo install.',
      )
      if (expectedParents.missing.length === 0) {
        if (currentParents.missingDirs.length > 0)
          throw new Error('A pre-existing parent directory disappeared before Undo install.')
        // Never call ensureParentDirs when all parent directories existed at preflight:
        // a renamed/removed parent must halt Undo safely rather than being recreated.
        operation.applicationStarted = true
        const installed = await ctx.directoryJob(
          reservation,
          file.path,
          'install',
          signal,
          file.stage,
        )
        assertExpectedParentsMatch(
          expectedParents.existing,
          installed.parentDirs ?? [],
          'An existing parent directory changed during Undo install.',
        )
      } else {
        const missingSet = new Set(expectedParents.missing)
        for (const observed of currentParents.parentDirs) {
          if (!missingSet.has(observed.path)) continue
          const created = createdDuringUndo.get(observed.path)
          if (!created || !sameDirectoryIdentity(created, observed))
            throw new Error('A missing parent directory appeared externally before Undo install.')
        }
        operation.applicationStarted = true
        const ensuredParents = await ctx.ensureParentDirs(reservation, file.path, signal)
        assertExpectedParentsMatch(
          expectedParents.existing,
          ensuredParents,
          'An existing parent directory changed while creating confirmed-absent parents.',
        )
        const ensuredByPath = new Map(ensuredParents.map((entry) => [entry.path, entry]))
        const expectedAfterEnsure: DirectoryIdentity[] = [...expectedParents.existing]
        for (const missingPath of expectedParents.missing) {
          const created = ensuredByPath.get(missingPath)
          if (!created)
            throw new Error('A confirmed-absent parent directory could not be verified.')
          const prior = createdDuringUndo.get(missingPath)
          if (prior && !sameDirectoryIdentity(prior, created))
            throw new Error('A parent directory created during Undo changed unexpectedly.')
          if (!prior) createdDuringUndo.set(missingPath, created)
          expectedAfterEnsure.push(created)
        }
        // Creating a hard link is exclusive: EEXIST preserves any external file that appeared.
        const installed = await ctx.directoryJob(
          reservation,
          file.path,
          'install',
          signal,
          file.stage,
        )
        assertExpectedParentsMatch(
          expectedAfterEnsure,
          installed.parentDirs ?? [],
          'A parent directory changed during Undo install.',
        )
      }
      await unlink(file.stage)
    } else {
      await ctx.directoryJob(reservation, file.path, 'absent', signal)
    }
  }
}
