import { isAbsolute, relative } from 'node:path'

import type { AgentRunInput, NativeFileChange } from '@pact/agent-runtime'

import { WORKSPACE_FILE_BYTES } from '@pact/contracts'

const MAX_NATIVE_CHANGES = 256
interface NativeChanges {
  changes: NativeFileChange[]
  uncertain?: string | undefined
  invalidatesPriorEvidence?: boolean
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
