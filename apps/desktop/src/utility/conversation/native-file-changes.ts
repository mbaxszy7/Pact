import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

import type { AgentRunInput, NativeFileChange } from '@pact/agent-runtime'

import { WORKSPACE_FILE_BYTES } from '@pact/contracts'

const MAX_NATIVE_CHANGES = 256
const MAX_ROUND_COMMANDS = 64
const MAX_COMMAND_INSPECT_BYTES = 16 * 1024

export interface NativeChanges {
  changes: NativeFileChange[]
  uncertain?: string | undefined
  invalidatesPriorEvidence?: boolean
}

export interface AgyFileChangesOptions {
  appDataDir?: string | undefined
  nativeSessionId?: string | undefined
  priorRecordedPaths?: ReadonlySet<string> | undefined
}

function object(value: unknown): value is object {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function patchPath(path: string, cwd: string): string | undefined {
  const value = (isAbsolute(path) ? relative(cwd, path) : path).replaceAll('\\', '/')
  if (!value) return undefined
  for (const character of value) if (character.charCodeAt(0) < 32) return undefined
  return value
}
function patchHeader(
  path: string,
  cwd: string,
  kind: NativeFileChange['kind'],
): string | undefined {
  const value = patchPath(path, cwd)
  if (!value) return undefined
  return `diff --git ${JSON.stringify(`a/${value}`)} ${JSON.stringify(`b/${value}`)}\n--- ${kind === 'added' ? '/dev/null' : JSON.stringify(`a/${value}`)}\n+++ ${kind === 'deleted' ? '/dev/null' : JSON.stringify(`b/${value}`)}\n`
}

/** Serializes native hunks only. It never matches/replaces text or computes a diff. */
function nativeHunks(
  value: unknown,
  path: string,
  cwd: string,
  kind: NativeFileChange['kind'],
): string | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 4096) return undefined
  const header = patchHeader(path, cwd, kind)
  if (!header) return undefined
  const hunks: string[] = []
  let bytes = Buffer.byteLength(header)
  for (const hunk of value) {
    if (!object(hunk)) return undefined
    const oldStart = Reflect.get(hunk, 'oldStart'),
      oldLines = Reflect.get(hunk, 'oldLines')
    const newStart = Reflect.get(hunk, 'newStart'),
      newLines = Reflect.get(hunk, 'newLines')
    const lines: unknown = Reflect.get(hunk, 'lines')
    if (
      ![oldStart, oldLines, newStart, newLines].every(
        (number) => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0,
      ) ||
      !Array.isArray(lines) ||
      !lines.every(
        (line) => typeof line === 'string' && /^[ +\\-]/u.test(line) && !line.includes('\n'),
      )
    )
      return undefined
    const serialized = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@\n${lines.join('\n')}\n`
    bytes += Buffer.byteLength(serialized)
    if (bytes > WORKSPACE_FILE_BYTES) return undefined
    hunks.push(serialized)
  }
  return `${header}${hunks.join('')}`
}

export function claudeFileChanges(toolName: string, output: unknown, cwd: string): NativeChanges {
  if (toolName !== 'Write' && toolName !== 'Edit') return { changes: [] }
  if (!object(output))
    return {
      changes: [],
      uncertain: 'The native file result did not expose operation evidence.',
      invalidatesPriorEvidence: true,
    }
  if (Reflect.get(output, 'staged') === true) return { changes: [] }
  const path = text(Reflect.get(output, 'filePath'))
  if (!path || path.length > 4096)
    return {
      changes: [],
      uncertain: 'The native file result did not expose its file path.',
      invalidatesPriorEvidence: true,
    }
  const original = Reflect.get(output, 'originalFile')
  const before = text(original)
  const mixed = Reflect.get(output, 'userModified') === true
  if (toolName === 'Write') {
    const created = Reflect.get(output, 'type') === 'create'
    const after = text(Reflect.get(output, 'content'))
    if (after === undefined)
      return {
        changes: [
          {
            path,
            kind: created ? 'added' : 'modified',
            ...(mixed ? { mixed: true } : {}),
            ...(created ? { before: null } : before !== undefined ? { before } : {}),
            unavailableReason: 'The native Write result did not include its completed content.',
          },
        ],
      }
    if (!created && before === after) return { changes: [] }
    return {
      changes: [
        {
          path,
          kind: created ? 'added' : 'modified',
          ...(mixed ? { mixed: true } : {}),
          ...(created ? { before: null } : before !== undefined ? { before } : {}),
          after,
          ...(!created && before === undefined
            ? { unavailableReason: 'The native Write result omitted the previous content.' }
            : {}),
        },
      ],
    }
  }
  const patch = nativeHunks(Reflect.get(output, 'structuredPatch'), path, cwd, 'modified')
  return {
    changes: [
      {
        path,
        kind: 'modified',
        ...(mixed ? { mixed: true } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(patch
          ? { patch }
          : { unavailableReason: 'The native Edit result omitted a complete operation patch.' }),
      },
    ],
  }
}

export function codexFileChanges(item: object, cwd: string): NativeChanges {
  if (Reflect.get(item, 'type') !== 'fileChange') return { changes: [] }
  if (Reflect.get(item, 'status') === 'failed') {
    const source: unknown = Reflect.get(item, 'changes')
    const reason = 'A failed native file operation may have left a partial final version.'
    if (!Array.isArray(source) || source.length > MAX_NATIVE_CHANGES)
      return { changes: [], uncertain: reason, invalidatesPriorEvidence: true }
    const targets = new Set<string>()
    let incomplete = false
    for (const entry of source) {
      if (!object(entry)) {
        incomplete = true
        continue
      }
      const path = text(Reflect.get(entry, 'path')),
        kind = Reflect.get(entry, 'kind')
      const moved = object(kind)
        ? text(Reflect.get(kind, 'move_path') ?? Reflect.get(kind, 'movePath'))
        : undefined
      if (path && path.length <= 4096) targets.add(path)
      else incomplete = true
      if (moved && moved.length <= 4096) targets.add(moved)
    }
    return {
      changes: [...targets].map((path) => ({
        path,
        kind: 'modified',
        invalidateOnly: true,
        unavailableReason: reason,
      })),
      uncertain: reason,
      ...(incomplete ? { invalidatesPriorEvidence: true } : {}),
    }
  }
  if (Reflect.get(item, 'status') !== 'completed')
    return {
      changes: [],
      ...(Reflect.get(item, 'status') === 'failed'
        ? { uncertain: 'A failed native file operation may have left partial changes.' }
        : {}),
    }
  const source: unknown = Reflect.get(item, 'changes')
  if (!Array.isArray(source) || source.length > MAX_NATIVE_CHANGES)
    return {
      changes: [],
      uncertain: 'The native file operation exceeded its bounded evidence reader.',
      invalidatesPriorEvidence: true,
    }
  const changes: NativeFileChange[] = []
  for (const entry of source) {
    if (!object(entry))
      return {
        changes,
        uncertain: 'A native file-change entry was invalid.',
        invalidatesPriorEvidence: true,
      }
    const path = text(Reflect.get(entry, 'path')),
      diff = text(Reflect.get(entry, 'diff'))
    const nativeKind = Reflect.get(entry, 'kind')
    const type = object(nativeKind) ? Reflect.get(nativeKind, 'type') : undefined
    const destination = object(nativeKind)
      ? text(Reflect.get(nativeKind, 'move_path') ?? Reflect.get(nativeKind, 'movePath'))
      : undefined
    if (!path || path.length > 4096 || !['add', 'delete', 'update'].includes(String(type)))
      return {
        changes,
        uncertain: 'The native file-change identity was unavailable.',
        invalidatesPriorEvidence: true,
      }
    const kind =
      type === 'add'
        ? 'added'
        : type === 'delete'
          ? 'deleted'
          : destination
            ? 'renamed'
            : 'modified'
    const patch =
      diff &&
      (/^(?:diff --git |--- )/u.test(diff)
        ? diff
        : diff.startsWith('@@ ')
          ? `${patchHeader(path, cwd, kind) ?? ''}${diff}`
          : undefined)
    changes.push({
      path: destination ?? path,
      kind,
      ...(destination ? { previousPath: path } : {}),
      ...(kind === 'added' ? { before: null } : kind === 'deleted' ? { after: null } : {}),
      ...(patch
        ? { patch }
        : {
            unavailableReason:
              'The native file result did not include a complete Git operation patch.',
          }),
    })
  }
  return { changes }
}

function canonicalOrResolved(targetPath: string): string {
  const resolved = resolve(targetPath)
  let current = resolved
  const tailSegments: string[] = []
  while (true) {
    try {
      const realAncestor = realpathSync(current)
      return tailSegments.length > 0 ? resolve(realAncestor, ...tailSegments) : realAncestor
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolved
      tailSegments.unshift(relative(parent, current))
      current = parent
    }
  }
}

export function workspaceRelativePath(rawPath: string, cwd: string): string | undefined {
  if (!rawPath || rawPath.length > 4096) return undefined
  for (const ch of rawPath) if (ch.charCodeAt(0) < 32) return undefined
  const canonicalCwd = canonicalOrResolved(cwd)
  const resolvedTarget = canonicalOrResolved(resolve(canonicalCwd, rawPath))
  const rel = relative(canonicalCwd, resolvedTarget).replaceAll('\\', '/')
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    return undefined
  const segments = rel.split('/')
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) return undefined
  return rel
}

export function isAgyBrainArtifactPath(
  rawPath: string,
  cwd: string,
  appDataDir: string | undefined,
  nativeSessionId: string | undefined,
): boolean {
  if (!appDataDir || !nativeSessionId || !rawPath || rawPath.length > 4096) return false
  if (workspaceRelativePath(rawPath, cwd) !== undefined) return false
  const brainDir = canonicalOrResolved(resolve(appDataDir, 'brain', nativeSessionId))
  const resolvedTarget = canonicalOrResolved(resolve(canonicalOrResolved(cwd), rawPath))
  const rel = relative(brainDir, resolvedTarget).replaceAll('\\', '/')
  return Boolean(rel) && !rel.startsWith('../') && rel !== '..' && !isAbsolute(rel)
}

const AGY_PRIMARY_PATH_KEYS = [
  'Path',
  'path',
  'file_path',
  'filePath',
  'Source',
  'source',
  'OldPath',
  'oldPath',
] as const

const AGY_MOVE_PATH_KEYS = [
  'Destination',
  'destination',
  'TargetPath',
  'targetPath',
  'NewPath',
  'newPath',
  'movePath',
  'move_path',
  'previousPath',
] as const

const AGY_DIFF_MOVE_KEYS = ['movePath', 'move_path', 'previousPath'] as const

function isValidTargetPathString(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4096) return false
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127) return false
  }
  return true
}

function collectPathsFromObjectKeys(
  source: object,
  keys: readonly string[],
  found: string[],
  markMoveTarget?: () => void,
): boolean {
  let valid = true
  for (const key of keys) {
    if (!Object.hasOwn(source, key)) continue
    const raw = Reflect.get(source, key)
    if (raw === undefined) continue
    markMoveTarget?.()
    if (isValidTargetPathString(raw)) {
      found.push(raw)
    } else {
      valid = false
    }
  }
  return valid
}

export function collectAgyTargetPaths(item: object): {
  paths: string[]
  complete: boolean
  hasMoveTarget: boolean
} {
  const found: string[] = []
  let complete = true
  let hasMoveTarget = false
  for (const argField of ['args', 'rawInput'] as const) {
    if (!Object.hasOwn(item, argField)) continue
    const container = Reflect.get(item, argField)
    if (container === undefined) continue
    if (!object(container)) {
      complete = false
      continue
    }
    if (!collectPathsFromObjectKeys(container, AGY_PRIMARY_PATH_KEYS, found)) {
      complete = false
    }
    if (
      !collectPathsFromObjectKeys(container, AGY_MOVE_PATH_KEYS, found, () => {
        hasMoveTarget = true
      })
    ) {
      complete = false
    }
  }
  if (Object.hasOwn(item, 'locations') && Reflect.get(item, 'locations') !== undefined) {
    const locations = Reflect.get(item, 'locations')
    if (!Array.isArray(locations) || locations.length > MAX_NATIVE_CHANGES) {
      complete = false
    } else {
      for (const loc of locations) {
        const rawPath = object(loc) ? Reflect.get(loc, 'path') : undefined
        if (object(loc) && isValidTargetPathString(rawPath)) {
          found.push(rawPath)
        } else {
          complete = false
        }
      }
    }
  }
  if (Object.hasOwn(item, 'content') && Reflect.get(item, 'content') !== undefined) {
    const content = Reflect.get(item, 'content')
    if (!Array.isArray(content) || content.length > MAX_NATIVE_CHANGES) {
      complete = false
    } else {
      for (const entry of content) {
        if (!object(entry)) {
          complete = false
          continue
        }
        const hasPathField =
          Reflect.get(entry, 'type') === 'diff' ||
          Object.hasOwn(entry, 'path') ||
          AGY_DIFF_MOVE_KEYS.some((moveKey) => Object.hasOwn(entry, moveKey))
        if (!hasPathField) continue
        const rawPath = Reflect.get(entry, 'path')
        if (isValidTargetPathString(rawPath)) found.push(rawPath)
        else complete = false
        if (
          !collectPathsFromObjectKeys(entry, AGY_DIFF_MOVE_KEYS, found, () => {
            hasMoveTarget = true
          })
        ) {
          complete = false
        }
      }
    }
  }
  return { paths: [...new Set(found)], complete, hasMoveTarget }
}

const AGY_DELETE_OR_RENAME_TOOLS = new Set([
  'delete_file',
  'remove_file',
  'move_file',
  'rename_file',
])

const AGY_READ_ONLY_TOOLS = new Set([
  'read_file',
  'search_web',
  'ask_question',
  'list_resources',
  'read_resource',
  'grep_search',
  'find_by_name',
  'list_dir',
  'view_file_outline',
  'view_code_item',
  'update_focus',
  'update_steps',
])

const PACT_READ_ONLY_OR_METADATA_MCP_TOOLS = new Set([
  'read_collaboration_source',
  'publish_session_title',
  'submit_review',
  'submit_input_result',
  'retain_current_plan',
  'publish_plan',
  'request_peer_assistance',
])

function collectWorkspacePathsFromSources(
  sources: readonly unknown[],
  extraRawPaths: readonly string[],
  cwd: string,
): string[] {
  const found = new Set<string>()
  for (const raw of extraRawPaths) {
    const rel = workspaceRelativePath(raw, cwd)
    if (rel) found.add(rel)
  }
  for (const source of sources) {
    if (!object(source)) continue
    for (const key of [...AGY_PRIMARY_PATH_KEYS, ...AGY_MOVE_PATH_KEYS]) {
      const raw = Reflect.get(source, key)
      if (!isValidTargetPathString(raw)) continue
      const rel = workspaceRelativePath(raw, cwd)
      if (rel) found.add(rel)
    }
  }
  return [...found]
}

/**
 * Extracts NativeFileChange records strictly from completed Antigravity `write_file`/`edit_file`
 * `diff` blocks (`oldText`/`newText`), requiring new-file creation proof when `oldText` is absent,
 * and disabling reliable Undo on failed/partial edits, deletions, or renames.
 */
export function agyFileChanges(
  item: object,
  cwd: string,
  options: AgyFileChangesOptions = {},
): NativeChanges {
  const toolName = text(Reflect.get(item, 'name')) ?? ''
  const status = text(Reflect.get(item, 'status'))
  const content = Reflect.get(item, 'content')
  const argsConflicted = Reflect.get(item, 'argsConflicted') === true
  const toolIdentityConflicted = Reflect.get(item, 'toolIdentityConflicted') === true
  const hasConflict = argsConflicted || toolIdentityConflicted
  const conflictReason =
    'The Antigravity tool call reported conflicting arguments or identity across updates.'
  const rawConflictedArgsSources: unknown = Reflect.get(item, 'conflictedArgsSources')
  const conflictedArgsSources: readonly unknown[] = Array.isArray(rawConflictedArgsSources)
    ? [...rawConflictedArgsSources]
    : []
  const hasDiffBlocks =
    Array.isArray(content) &&
    content.some((entry) => object(entry) && Reflect.get(entry, 'type') === 'diff')

  if (AGY_DELETE_OR_RENAME_TOOLS.has(toolName)) {
    const reason = 'Antigravity file deletions and renames cannot be safely undone.'
    const { paths, complete } = collectAgyTargetPaths(item)
    const workspacePaths = hasConflict
      ? collectWorkspacePathsFromSources(
          [Reflect.get(item, 'args'), Reflect.get(item, 'rawInput'), ...conflictedArgsSources],
          paths,
          cwd,
        )
      : paths
          .map((raw) => workspaceRelativePath(raw, cwd))
          .filter((rel): rel is string => rel !== undefined)
    const isRename = toolName === 'move_file' || toolName === 'rename_file'
    return {
      changes: workspacePaths.map((path) => ({
        path,
        kind: isRename ? ('renamed' as const) : ('deleted' as const),
        ...(status !== 'completed' || hasConflict ? { invalidateOnly: true as const } : {}),
        ...(!isRename && status === 'completed' && !hasConflict ? { after: null } : {}),
        unavailableReason: hasConflict ? conflictReason : reason,
      })),
      uncertain: hasConflict ? conflictReason : reason,
      invalidatesPriorEvidence:
        hasConflict || !complete || workspacePaths.length === 0 || status !== 'completed',
    }
  }

  if (toolName !== 'write_file' && toolName !== 'edit_file') {
    if (hasDiffBlocks || hasConflict) {
      const collected = collectAgyTargetPaths(item)
      const workspacePaths = collectWorkspacePathsFromSources(
        [Reflect.get(item, 'args'), Reflect.get(item, 'rawInput'), ...conflictedArgsSources],
        collected.paths,
        cwd,
      )
      return {
        changes: workspacePaths.map((path) => ({
          path,
          kind: 'modified' as const,
          invalidateOnly: true as const,
          unavailableReason: hasConflict
            ? conflictReason
            : 'An unrecognized Antigravity tool emitted unverified diff blocks.',
        })),
        uncertain: hasConflict
          ? conflictReason
          : 'An unrecognized Antigravity tool emitted unverified diff blocks.',
        invalidatesPriorEvidence: true,
      }
    }
    return { changes: [] }
  }

  const collected = collectAgyTargetPaths(item)
  if (
    !hasConflict &&
    !collected.hasMoveTarget &&
    collected.complete &&
    collected.paths.length > 0 &&
    collected.paths.every((raw) =>
      isAgyBrainArtifactPath(raw, cwd, options.appDataDir, options.nativeSessionId),
    )
  ) {
    return { changes: [] }
  }

  const args = object(Reflect.get(item, 'args'))
    ? Reflect.get(item, 'args')!
    : object(Reflect.get(item, 'rawInput'))
      ? Reflect.get(item, 'rawInput')!
      : undefined
  const conflictWorkspacePaths = hasConflict
    ? collectWorkspacePathsFromSources([args, ...conflictedArgsSources], collected.paths, cwd)
    : []

  if (status !== 'completed') {
    const reason = hasConflict
      ? conflictReason
      : 'A failed or incomplete Antigravity file operation may have left partial edits.'
    const workspacePaths = hasConflict
      ? conflictWorkspacePaths
      : collected.paths
          .map((raw) => workspaceRelativePath(raw, cwd))
          .filter((rel): rel is string => rel !== undefined)
    return {
      changes: workspacePaths.map((path) => ({
        path,
        kind: 'modified',
        invalidateOnly: true,
        unavailableReason: reason,
      })),
      uncertain: reason,
      invalidatesPriorEvidence: true,
    }
  }

  const requestedRawPath = args
    ? text(Reflect.get(args, 'Path') ?? Reflect.get(args, 'path'))
    : undefined
  const requestedRelPath = requestedRawPath
    ? workspaceRelativePath(requestedRawPath, cwd)
    : undefined

  if (!Array.isArray(content) || content.length === 0 || content.length > MAX_NATIVE_CHANGES) {
    const reason = hasConflict
      ? conflictReason
      : 'The completed Antigravity file operation did not provide bounded diff blocks.'
    const affected = hasConflict
      ? conflictWorkspacePaths
      : requestedRelPath
        ? [requestedRelPath]
        : []
    return {
      changes: affected.map((path) => ({
        path,
        kind: 'modified',
        invalidateOnly: true,
        unavailableReason: reason,
      })),
      uncertain: reason,
      invalidatesPriorEvidence: true,
    }
  }

  const diffs = content.filter(
    (entry): entry is object => object(entry) && Reflect.get(entry, 'type') === 'diff',
  )
  if (diffs.length === 0) {
    const reason = hasConflict
      ? conflictReason
      : 'The completed Antigravity file operation omitted its diff block.'
    const affected = hasConflict
      ? conflictWorkspacePaths
      : requestedRelPath
        ? [requestedRelPath]
        : []
    return {
      changes: affected.map((path) => ({
        path,
        kind: 'modified',
        invalidateOnly: true,
        unavailableReason: reason,
      })),
      uncertain: reason,
      invalidatesPriorEvidence: true,
    }
  }

  const changes: NativeFileChange[] = []
  let uncertain: string | undefined = hasConflict ? conflictReason : undefined
  let invalidatesPriorEvidence = hasConflict

  for (const diff of diffs) {
    const rawDiffPath = text(Reflect.get(diff, 'path'))
    if (!rawDiffPath || rawDiffPath.length > 4096) {
      return {
        changes,
        uncertain: 'An Antigravity diff block omitted a valid target path.',
        invalidatesPriorEvidence: true,
      }
    }
    const moveKeyPresent = AGY_DIFF_MOVE_KEYS.some(
      (moveKey) => Reflect.get(diff, moveKey) !== undefined,
    )
    const rawMoveTarget =
      Reflect.get(diff, 'movePath') ??
      Reflect.get(diff, 'move_path') ??
      Reflect.get(diff, 'previousPath')
    const moveTarget = text(rawMoveTarget)
    if (moveKeyPresent && (!isValidTargetPathString(moveTarget) || moveTarget === undefined)) {
      return {
        changes,
        uncertain: 'An Antigravity move diff omitted a valid endpoint path.',
        invalidatesPriorEvidence: true,
      }
    }

    const primaryBrain = isAgyBrainArtifactPath(
      rawDiffPath,
      cwd,
      options.appDataDir,
      options.nativeSessionId,
    )
    const relPath = workspaceRelativePath(rawDiffPath, cwd)

    if (moveTarget !== undefined) {
      const moveBrain = isAgyBrainArtifactPath(
        moveTarget,
        cwd,
        options.appDataDir,
        options.nativeSessionId,
      )
      const moveRel = workspaceRelativePath(moveTarget, cwd)
      if (!hasConflict && primaryBrain && moveBrain) {
        continue
      }
      if (relPath || moveRel) {
        const reason = hasConflict
          ? conflictReason
          : 'Antigravity rename operations do not provide complete Undo metadata.'
        changes.push({
          path: relPath ?? moveRel!,
          previousPath: relPath && moveRel ? moveRel : relPath ? moveTarget : rawDiffPath,
          kind: 'renamed',
          unavailableReason: reason,
        })
        uncertain ??= reason
        invalidatesPriorEvidence = true
        continue
      }
      uncertain ??= 'An Antigravity file operation targeted a path outside the project workspace.'
      invalidatesPriorEvidence = true
      continue
    }

    if (!hasConflict && primaryBrain) {
      continue
    }
    if (!relPath) {
      if (!primaryBrain) {
        uncertain ??= 'An Antigravity file operation targeted a path outside the project workspace.'
      }
      continue
    }

    const pathMismatch =
      requestedRawPath !== undefined &&
      (requestedRelPath === undefined || requestedRelPath !== relPath)
    const oldText = Reflect.get(diff, 'oldText')
    const newText = Reflect.get(diff, 'newText')

    if (newText === null) {
      if (
        typeof oldText === 'string' &&
        Buffer.byteLength(oldText, 'utf8') > WORKSPACE_FILE_BYTES
      ) {
        const reason = 'The Antigravity diff original content exceeded the file byte limit.'
        return { changes, uncertain: reason, invalidatesPriorEvidence: true }
      }
      const reason = 'Antigravity file deletions cannot be safely undone.'
      changes.push({
        path: relPath,
        kind: 'deleted',
        ...(typeof oldText === 'string' ? { before: oldText } : {}),
        after: null,
        unavailableReason: reason,
      })
      uncertain ??= reason
      invalidatesPriorEvidence = true
      continue
    }

    if (typeof newText !== 'string' || Buffer.byteLength(newText, 'utf8') > WORKSPACE_FILE_BYTES) {
      const reason = 'The Antigravity diff block omitted valid completed file content.'
      changes.push({
        path: relPath,
        kind: 'modified',
        invalidateOnly: true,
        unavailableReason: reason,
      })
      return {
        changes,
        uncertain: reason,
        invalidatesPriorEvidence: true,
      }
    }

    const contentMismatch =
      toolName === 'write_file' &&
      args !== undefined &&
      Reflect.get(args, 'Append') !== true &&
      typeof Reflect.get(args, 'Content') === 'string' &&
      Reflect.get(args, 'Content') !== newText

    if (typeof oldText === 'string') {
      if (Buffer.byteLength(oldText, 'utf8') > WORKSPACE_FILE_BYTES) {
        const reason = 'The Antigravity diff original content exceeded the file byte limit.'
        return { changes, uncertain: reason, invalidatesPriorEvidence: true }
      }
      if (!hasConflict && !pathMismatch && !contentMismatch && oldText === newText) {
        continue
      }
      const unavailableReason = hasConflict
        ? conflictReason
        : pathMismatch
          ? 'The Antigravity file target path differed from its diff path.'
          : contentMismatch
            ? 'The Antigravity write_file diff did not match its requested content.'
            : undefined
      changes.push({
        path: relPath,
        kind: 'modified',
        before: oldText,
        after: newText,
        ...(unavailableReason ? { unavailableReason } : {}),
      })
      if (unavailableReason) {
        uncertain ??= unavailableReason
        invalidatesPriorEvidence = true
      }
      continue
    }

    if (oldText === undefined || oldText === null) {
      // New-file creation proof: `write_file` natively fails on an existing path unless
      // `Overwrite` or `Append` is true. Require explicit `args` proving neither flag was set
      // (or an explicit `created: true` witness), no argument/identity conflict, and that no prior
      // operation in the round already recorded this path.
      const overwrite = args ? Reflect.get(args, 'Overwrite') === true : true
      const append = args ? Reflect.get(args, 'Append') === true : true
      const rawOutput = Reflect.get(item, 'rawOutput')
      const explicitCreated =
        (object(rawOutput) && Reflect.get(rawOutput, 'created') === true) ||
        Reflect.get(diff, 'created') === true
      const alreadyRecorded = options.priorRecordedPaths?.has(relPath) === true
      const provenNewFile =
        !hasConflict &&
        toolName === 'write_file' &&
        !alreadyRecorded &&
        !pathMismatch &&
        !contentMismatch &&
        ((args !== undefined && !overwrite && !append) || explicitCreated)

      if (provenNewFile) {
        changes.push({
          path: relPath,
          kind: 'added',
          before: null,
          after: newText,
        })
      } else {
        const reason = hasConflict
          ? conflictReason
          : 'The Antigravity file diff omitted original content without new-file creation proof.'
        changes.push({
          path: relPath,
          kind: 'modified',
          after: newText,
          unavailableReason: reason,
        })
        uncertain ??= reason
        invalidatesPriorEvidence = true
      }
      continue
    }

    return {
      changes,
      uncertain: 'The Antigravity file diff contained an invalid oldText field.',
      invalidatesPriorEvidence: true,
    }
  }

  if (hasConflict) {
    const represented = new Set(changes.map((c) => c.path))
    for (const extraRel of conflictWorkspacePaths) {
      if (!represented.has(extraRel)) {
        changes.push({
          path: extraRel,
          kind: 'modified',
          invalidateOnly: true,
          unavailableReason: conflictReason,
        })
      }
    }
    uncertain ??= conflictReason
    invalidatesPriorEvidence = true
  }

  return {
    changes,
    ...(uncertain ? { uncertain } : {}),
    ...(invalidatesPriorEvidence ? { invalidatesPriorEvidence: true } : {}),
  }
}

function tokenizeSimpleShellWords(commandLine: string): string[] | undefined {
  if (
    !commandLine ||
    Buffer.byteLength(commandLine, 'utf8') > MAX_COMMAND_INSPECT_BYTES ||
    /[\r\n\0]/u.test(commandLine)
  ) {
    return undefined
  }
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: "'" | '"' | undefined

  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i]!
    if (quote === "'") {
      if (ch === "'") quote = undefined
      else current += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined
        continue
      }
      // Disallow shell expansion or escapes inside double quotes for conservative disjointness proof.
      if (ch === '$' || ch === '`' || ch === '\\') return undefined
      current += ch
      continue
    }
    if (/\s/u.test(ch)) {
      if (inToken) {
        tokens.push(current)
        current = ''
        inToken = false
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      inToken = true
      continue
    }
    if (/[;&|<>()$*?[{~`\\]/u.test(ch)) {
      return undefined
    }
    current += ch
    inToken = true
  }
  if (quote !== undefined) return undefined
  if (inToken) tokens.push(current)
  return tokens.length > 0 && tokens.length <= 128 ? tokens : undefined
}

const TRUSTED_SYSTEM_COMMAND_DIRS = new Set([
  '/bin',
  '/usr/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
])

const PURE_INSPECTION_COMMANDS = new Set([
  'pwd',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'file',
  'which',
  'whoami',
  'uname',
  'date',
  'true',
  'false',
  'echo',
  'printf',
  'diff',
  'grep',
  'rg',
])

const EXPLICIT_PATH_FILE_COMMANDS = new Set([
  'touch',
  'mkdir',
  'rmdir',
  'rm',
  'unlink',
  'cp',
  'mv',
  'chmod',
])

function pathsOverlap(relA: string, relB: string): boolean {
  return relA === relB || relA.startsWith(`${relB}/`) || relB.startsWith(`${relA}/`)
}

function resolveTrustedSystemCommand(token0: string, cwd: string): string | undefined {
  if (!token0 || token0 === '.' || token0 === '..') return undefined
  // Bare command names depend on mutable shell PATH, functions, or aliases and could hit a
  // same-named project script/binary; require an explicit absolute path to a verified system binary.
  if (!token0.includes('/') && !token0.includes('\\')) return undefined
  if (!isAbsolute(token0)) return undefined

  const lexicalCwd = resolve(cwd)
  const lexicalTarget = resolve(token0)
  const lexicalRel = relative(lexicalCwd, lexicalTarget).replaceAll('\\', '/')
  if (
    !lexicalRel ||
    (!lexicalRel.startsWith('../') && lexicalRel !== '..' && !isAbsolute(lexicalRel))
  ) {
    return undefined
  }
  if (workspaceRelativePath(token0, cwd) !== undefined) return undefined

  let canonicalTarget: string
  try {
    canonicalTarget = realpathSync(token0)
    const targetStat = lstatSync(canonicalTarget)
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) return undefined
  } catch {
    return undefined
  }

  const canonicalCwd = canonicalOrResolved(cwd)
  if (canonicalTarget === canonicalCwd) return undefined
  const canonicalRel = relative(canonicalCwd, canonicalTarget).replaceAll('\\', '/')
  if (
    !canonicalRel ||
    (!canonicalRel.startsWith('../') && canonicalRel !== '..' && !isAbsolute(canonicalRel))
  ) {
    return undefined
  }

  const canonicalDir = dirname(canonicalTarget).replaceAll('\\', '/')
  if (!TRUSTED_SYSTEM_COMMAND_DIRS.has(canonicalDir)) return undefined
  const name = basename(canonicalTarget)
  return name && name !== '.' && name !== '..' ? name : undefined
}

function hasUnsafePureInspectionFlags(binary: string, args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--') break
    if (!arg.startsWith('-') || arg === '-') continue
    if (binary === 'rg') {
      if (
        arg === '--pre' ||
        arg.startsWith('--pre=') ||
        arg === '--pre-glob' ||
        arg.startsWith('--pre-glob=') ||
        arg === '--search-zip' ||
        (!arg.startsWith('--') && arg.slice(1).includes('z'))
      ) {
        return true
      }
    } else if (binary === 'file') {
      if (arg === '--compile' || (!arg.startsWith('--') && arg.slice(1).includes('C'))) {
        return true
      }
    } else if (binary === 'date') {
      if (
        arg === '--set' ||
        arg.startsWith('--set=') ||
        (!arg.startsWith('--') && arg.slice(1).includes('s'))
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * Conservatively proves whether a shell command line cannot touch any path in `recordedPaths`.
 * Any metacharacter, redirection, wildcard, interpreter, project-local executable, external-processor
 * flag, or overlapping directory/file returns false.
 */
export function isAgyCommandProvablyDisjoint(
  commandLine: string,
  recordedPaths: ReadonlySet<string>,
  cwd: string,
): boolean {
  const tokens = tokenizeSimpleShellWords(commandLine)
  if (!tokens || tokens.length === 0) return false
  const binary = resolveTrustedSystemCommand(tokens[0]!, cwd)
  if (!binary) return false
  if (PURE_INSPECTION_COMMANDS.has(binary)) {
    return !hasUnsafePureInspectionFlags(binary, tokens.slice(1))
  }
  if (binary === 'git') {
    let idx = 1
    while (idx < tokens.length) {
      const arg = tokens[idx]!
      if (arg === '-C') {
        if (idx + 1 >= tokens.length) return false
        idx += 2
        continue
      }
      if (arg === '--no-pager' || arg === '--literal-pathspecs') {
        idx += 1
        continue
      }
      break
    }
    const subcommand = tokens[idx]
    if (!subcommand) return false
    if (['status', 'diff', 'log', 'show', 'rev-parse'].includes(subcommand)) {
      // Ensure `-o` / `--output` or external diff/textconv drivers cannot run or write into workspace.
      return !tokens
        .slice(idx + 1)
        .some(
          (arg) =>
            arg === '-o' ||
            arg.startsWith('-o') ||
            arg.startsWith('--output') ||
            arg === '--ext-diff' ||
            arg === '--textconv',
        )
    }
    if (subcommand === 'branch') {
      const rest = tokens.slice(idx + 1)
      return (
        rest.length > 0 &&
        rest.every((arg) =>
          ['--show-current', '-a', '-r', '-l', '--list', '-v', '-vv'].includes(arg),
        )
      )
    }
    return false
  }
  if (EXPLICIT_PATH_FILE_COMMANDS.has(binary)) {
    const operands: string[] = []
    let acceptFlags = true
    for (let i = 1; i < tokens.length; i += 1) {
      const arg = tokens[i]!
      if (acceptFlags && arg === '--') {
        acceptFlags = false
        continue
      }
      if (acceptFlags && arg.startsWith('-')) {
        // Reject flags that take separate unknown arguments or target files indirectly.
        if (
          !/^-[a-zA-Z0-9]+$/u.test(arg) &&
          !/^--(?:parents|force|recursive|verbose|no-preserve-root)$/u.test(arg)
        ) {
          return false
        }
        continue
      }
      if (
        binary === 'chmod' &&
        operands.length === 0 &&
        /^[0-7]{3,4}$|^[ugoa]*[+-=][rwxXst]+$/u.test(arg)
      ) {
        continue
      }
      operands.push(arg)
    }
    if (operands.length === 0) return false
    const canonicalCwd = canonicalOrResolved(cwd)
    for (const operand of operands) {
      const resolvedOperand = canonicalOrResolved(resolve(canonicalCwd, operand))
      const rel = relative(canonicalCwd, resolvedOperand).replaceAll('\\', '/')
      if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) {
        // Root workspace directory `.` or parent `..` could encompass recorded workspace paths.
        if (!rel || rel === '.' || rel === '..') return false
        const canonicalParent = canonicalOrResolved(resolvedOperand)
        const reverseRel = relative(canonicalParent, canonicalCwd).replaceAll('\\', '/')
        if (
          !reverseRel ||
          (!reverseRel.startsWith('../') && reverseRel !== '..' && !isAbsolute(reverseRel))
        ) {
          return false
        }
        continue
      }
      for (const recorded of recordedPaths) {
        if (pathsOverlap(rel, recorded)) return false
      }
    }
    return true
  }
  return false
}

export interface AgyToolUncertaintyClassification {
  uncertain: boolean
  scope: 'unlisted' | 'recorded_files'
  reason?: string
}

/**
 * Per-round tracker for Antigravity file changes and command/tool side-effect uncertainty.
 * Upgrades uncertainty to `recorded_files` whenever a command/tool in the same round could touch
 * any recorded path (in either `write -> command` or `command -> write` order).
 */
export class AgyRoundEffectsTracker {
  private readonly recorded = new Set<string>()
  private readonly priorCommands: Array<{ commandLine?: string | undefined }> = []
  private priorArbitraryMutator = false

  constructor(
    private readonly cwd: string,
    private readonly ownPeerServerName?: string,
    private readonly appDataDir?: string,
    private readonly nativeSessionId?: string,
  ) {}

  get recordedPaths(): ReadonlySet<string> {
    return this.recorded
  }

  observeFileTool(item: object): NativeChanges {
    const result = agyFileChanges(item, this.cwd, {
      appDataDir: this.appDataDir,
      nativeSessionId: this.nativeSessionId,
      priorRecordedPaths: this.recorded,
    })
    const argsConflicted = Reflect.get(item, 'argsConflicted') === true
    const toolIdentityConflicted = Reflect.get(item, 'toolIdentityConflicted') === true
    const hasConflict = argsConflicted || toolIdentityConflicted
    const nextPaths = new Set<string>()
    for (const change of result.changes) {
      const rel = workspaceRelativePath(change.path, this.cwd) ?? change.path
      nextPaths.add(rel)
      if (change.previousPath) {
        const prevRel = workspaceRelativePath(change.previousPath, this.cwd)
        if (prevRel) nextPaths.add(prevRel)
      }
    }
    if (hasConflict) {
      this.priorArbitraryMutator = true
      result.uncertain ??=
        'The Antigravity tool call reported conflicting arguments or identity across updates.'
      result.invalidatesPriorEvidence = true
    }
    if (nextPaths.size > 0) {
      const priorOverlap =
        this.priorArbitraryMutator ||
        this.priorCommands.some(
          (entry) =>
            !entry.commandLine ||
            !isAgyCommandProvablyDisjoint(entry.commandLine, nextPaths, this.cwd),
        )
      if (priorOverlap) {
        result.uncertain ??=
          'An earlier command or tool in this round may have modified a recorded file before its edit.'
        result.invalidatesPriorEvidence = true
      }
      for (const rel of nextPaths) {
        if (this.recorded.size < MAX_NATIVE_CHANGES) this.recorded.add(rel)
      }
    }
    return result
  }

  observeNonFileTool(item: object): AgyToolUncertaintyClassification {
    const toolIdentityConflicted = Reflect.get(item, 'toolIdentityConflicted') === true
    if (toolIdentityConflicted) {
      this.priorArbitraryMutator = true
      return {
        uncertain: true,
        scope: 'recorded_files',
        reason:
          'An Antigravity tool call reported conflicting tool identities; Undo is unavailable.',
      }
    }
    const argsConflicted = Reflect.get(item, 'argsConflicted') === true
    const toolName = text(Reflect.get(item, 'name')) ?? ''
    if (
      !toolName ||
      toolName === 'write_file' ||
      toolName === 'edit_file' ||
      AGY_DELETE_OR_RENAME_TOOLS.has(toolName)
    ) {
      return { uncertain: false, scope: 'unlisted' }
    }
    if (!argsConflicted && AGY_READ_ONLY_TOOLS.has(toolName)) {
      return { uncertain: false, scope: 'unlisted' }
    }
    if (!argsConflicted && this.ownPeerServerName) {
      const prefix = `mcp_${this.ownPeerServerName}_`
      if (toolName.startsWith(prefix)) {
        const suffix = toolName.slice(prefix.length)
        if (PACT_READ_ONLY_OR_METADATA_MCP_TOOLS.has(suffix)) {
          return { uncertain: false, scope: 'unlisted' }
        }
      }
    }
    if (toolName === 'run_command') {
      if (argsConflicted) {
        this.priorArbitraryMutator = true
        if (this.priorCommands.length < MAX_ROUND_COMMANDS) {
          this.priorCommands.push({ commandLine: undefined })
        }
        return {
          uncertain: true,
          scope: 'recorded_files',
          reason:
            'A native command in this round reported conflicting arguments; Undo is unavailable.',
        }
      }
      const args = object(Reflect.get(item, 'args'))
        ? Reflect.get(item, 'args')!
        : object(Reflect.get(item, 'rawInput'))
          ? Reflect.get(item, 'rawInput')!
          : undefined
      const commandLine = args
        ? text(Reflect.get(args, 'CommandLine') ?? Reflect.get(args, 'command'))
        : undefined
      if (this.priorCommands.length < MAX_ROUND_COMMANDS) {
        this.priorCommands.push({ commandLine })
      } else {
        this.priorArbitraryMutator = true
      }
      const disjoint =
        commandLine !== undefined &&
        isAgyCommandProvablyDisjoint(commandLine, this.recorded, this.cwd)
      return disjoint
        ? {
            uncertain: true,
            scope: 'unlisted',
            reason:
              'Native command execution may have effects outside the recorded file operations.',
          }
        : {
            uncertain: true,
            scope: 'recorded_files',
            reason:
              'A native command in this round may have modified recorded files; Undo is unavailable.',
          }
    }
    this.priorArbitraryMutator = true
    return {
      uncertain: true,
      scope: this.recorded.size > 0 ? 'recorded_files' : 'unlisted',
      reason:
        this.recorded.size > 0
          ? 'A native tool or subagent in this round may have modified recorded files; Undo is unavailable.'
          : 'Native tool or subagent execution may have effects outside recorded file operations.',
    }
  }
}

export async function anchorNativeFileBeforeEdit(
  input: AgentRunInput,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  if (!path || path.length > 4096) return
  try {
    await input.anchorFileBeforeEdit?.(path, signal)
  } catch {
    /* Pre-touch anchoring is passive and must never block or fail a native tool. */
  }
}

export function nativeEffectsUncertain(
  input: Pick<AgentRunInput, 'recordUncertainEffects'>,
  reason: string,
  scope: 'unlisted' | 'recorded_files' = 'unlisted',
): void {
  try {
    input.recordUncertainEffects?.(reason, scope)
  } catch {
    /* Observation never changes a native operation's result. */
  }
}

export function nativeFileChangesSettled(
  input: Pick<
    AgentRunInput,
    'runId' | 'nativeGeneration' | 'reportNativeEffects' | 'recordUncertainEffects'
  >,
  state: 'settled' | 'unknown' = 'settled',
  reason?: string,
): void {
  try {
    input.reportNativeEffects?.({
      runId: input.runId,
      generation: input.nativeGeneration ?? input.runId,
      state,
      ...(reason ? { reason } : {}),
    })
  } catch {
    nativeEffectsUncertain(
      input,
      'The native observation state could not be saved; its final outcome is not confirmed.',
    )
  }
}
export async function recordNativeChanges(
  input: Pick<AgentRunInput, 'recordFileChange' | 'recordUncertainEffects'>,
  result: NativeChanges,
  signal: AbortSignal,
): Promise<void> {
  if (result.uncertain)
    nativeEffectsUncertain(
      input,
      result.uncertain,
      result.invalidatesPriorEvidence ? 'recorded_files' : 'unlisted',
    )
  for (const change of result.changes) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Native evidence is recorded in operation order.
      await input.recordFileChange?.(change, signal)
    } catch {
      nativeEffectsUncertain(
        input,
        'Native file-change evidence could not be saved. The native operation was not blocked.',
        'recorded_files',
      )
    }
  }
}
