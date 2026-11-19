import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import {
  nativeSkillSchema,
  SKILL_CATALOG_BYTES,
  SKILL_CATALOG_ITEMS,
  type SkillBinding,
  type SkillSelection,
} from '@pact/contracts'

import { OwnedProcessGroup } from '../owned-process-group'
import { AgentExecutionError } from './agent-execution-error'

export const AGY_SKILL_DISCOVERY_TIMEOUT_MS = 4_000
export const AGY_SKILL_DISCOVERY_MAX_BYTES = 256 * 1024
const AGY_SKILL_CLEANUP_MS = 1_000

interface ParsedAgySkillRecord {
  name: string
  description: string
  path?: string | undefined
  builtin?: boolean | undefined
  model_invocable?: boolean | undefined
  argument_hint?: string | undefined
  argumentHint?: string | undefined
  scope?: string | undefined
  enabled?: boolean | undefined
  plugin?: string | null | undefined
  plugin_id?: string | null | undefined
  pluginId?: string | null | undefined
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalBoundedString(
  value: unknown,
  maxLength: number,
  allowEmpty = true,
): { valid: true; value: string | undefined } | { valid: false } {
  if (value === undefined) return { valid: true, value: undefined }
  if (typeof value !== 'string') return { valid: false }
  if ((!allowEmpty && value.length === 0) || value.length > maxLength) return { valid: false }
  return { valid: true, value }
}

function optionalNullableString(
  value: unknown,
  maxLength: number,
): { valid: true; value: string | null | undefined } | { valid: false } {
  if (value === undefined || value === null) return { valid: true, value }
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    return { valid: false }
  }
  return { valid: true, value }
}

export function parseNativeAgySkillOutput(raw: unknown): ParsedAgySkillRecord[] | undefined {
  if (!isPlainRecord(raw)) return undefined
  if (raw.status !== 'SUCCESS' || raw.num_turns !== 0) return undefined
  const command = raw.command
  if (!isPlainRecord(command) || command.name !== 'skills') return undefined
  const data = command.data
  if (!isPlainRecord(data) || !Array.isArray(data.skills)) return undefined
  if (data.skills.length > SKILL_CATALOG_ITEMS) return undefined

  const out: ParsedAgySkillRecord[] = []
  for (const item of data.skills) {
    if (!isPlainRecord(item)) return undefined
    const name = item.name
    const description = item.description
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      name.length > 512 ||
      !/^[\p{L}\p{N}_.:-]+$/u.test(name) ||
      typeof description !== 'string' ||
      description.length > 4_096
    ) {
      return undefined
    }
    const path = optionalBoundedString(item.path, 4_096, false)
    const argHint1 = optionalBoundedString(item.argument_hint, 1_024, true)
    const argHint2 = optionalBoundedString(item.argumentHint, 1_024, true)
    const scope = optionalBoundedString(item.scope, 128, true)
    const plugin = optionalNullableString(item.plugin, 512)
    const pluginSnake = optionalNullableString(item.plugin_id, 512)
    const pluginCamel = optionalNullableString(item.pluginId, 512)
    if (
      !path.valid ||
      !argHint1.valid ||
      !argHint2.valid ||
      !scope.valid ||
      !plugin.valid ||
      !pluginSnake.valid ||
      !pluginCamel.valid ||
      (item.builtin !== undefined && typeof item.builtin !== 'boolean') ||
      (item.model_invocable !== undefined && typeof item.model_invocable !== 'boolean') ||
      (item.enabled !== undefined && typeof item.enabled !== 'boolean')
    ) {
      return undefined
    }
    out.push({
      name,
      description,
      path: path.value,
      builtin: item.builtin,
      model_invocable: item.model_invocable,
      argument_hint: argHint1.value,
      argumentHint: argHint2.value,
      scope: scope.value,
      enabled: item.enabled,
      plugin: plugin.value,
      plugin_id: pluginSnake.value,
      pluginId: pluginCamel.value,
    })
  }
  return out
}

export interface NativeSkillCatalogRecord {
  name: string
  description: string
  argumentHint?: string
  path?: string
  scope?: string
  enabled?: boolean
  builtin?: boolean
  modelInvocable?: boolean
  pluginId?: unknown
}

export type OwnedAgySkillProbeProcess = {
  child: ChildProcessWithoutNullStreams
  close?: (deadlineAt?: number) => Promise<void>
}

export interface AgySkillDiscoveryOptions {
  env?: NodeJS.ProcessEnv
  spawnProcess?: (
    executablePath: string,
    args: readonly string[],
    probeCwd: string,
    env: NodeJS.ProcessEnv | undefined,
  ) => OwnedAgySkillProbeProcess | Promise<OwnedAgySkillProbeProcess>
}

function canonicalizeWithExistingAncestor(targetPath: string): string {
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

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
  if (!isAbsolute(candidatePath) || !isAbsolute(directoryPath)) return false
  const resolvedDirectory = canonicalizeWithExistingAncestor(directoryPath)
  const resolvedCandidate = canonicalizeWithExistingAncestor(candidatePath)
  const rel = relative(resolvedDirectory, resolvedCandidate).replaceAll('\\', '/')
  return Boolean(rel) && !rel.startsWith('../') && rel !== '..' && !isAbsolute(rel)
}

function isPluginSkillPath(skillPath: string | undefined): boolean {
  if (!skillPath) return false
  const normalized = skillPath.replaceAll('\\', '/')
  return normalized.includes('/plugins/')
}

/** Normalize only provider-advertised metadata. No Skill/configuration files are scanned. */
export function nativeSkillCatalog(
  agentId: 'claude' | 'codex' | 'agy',
  cwd: string,
  executablePath: string,
  records: NativeSkillCatalogRecord[],
): SkillBinding[] {
  if (records.length > SKILL_CATALOG_ITEMS)
    throw new Error('The native Skill catalog exceeds its item capacity.')
  const executable = realpathSync(executablePath)
  const info = statSync(executable)
  const executableGeneration = [executable, info.size, info.mtimeMs]
  const result: SkillBinding[] = []
  const names = new Set<string>()
  let bytes = 0
  for (const record of records) {
    if (record.enabled === false) continue
    // Native dispatch by name must have one effective definition, not an invented source picker.
    if (names.has(record.name))
      throw new Error(`The native Skill name /${record.name} is ambiguous.`)
    names.add(record.name)
    const source =
      record.pluginId || (agentId === 'agy' && isPluginSkillPath(record.path))
        ? 'plugin'
        : record.scope === 'repo' ||
            record.scope === 'project' ||
            (agentId === 'agy' &&
              record.builtin !== true &&
              typeof record.path === 'string' &&
              isPathInsideDirectory(record.path, cwd))
          ? 'project'
          : record.scope === 'system' || record.builtin === true
            ? 'system'
            : record.scope === 'user' ||
                (agentId === 'agy' && record.builtin === false && Boolean(record.path))
              ? 'user'
              : 'native'
    const value = nativeSkillSchema.parse({
      id: createHash('sha256')
        .update(JSON.stringify([agentId, cwd, executableGeneration, record]))
        .digest('hex'),
      agentId,
      name: record.name,
      description: record.description,
      argumentHint: record.argumentHint ?? '',
      source,
    })
    const binding = { ...value, ...(record.path ? { path: record.path } : {}) }
    bytes += Buffer.byteLength(JSON.stringify(binding))
    if (bytes > SKILL_CATALOG_BYTES)
      throw new Error('The native Skill catalog exceeds its byte capacity.')
    result.push(binding)
  }
  // Project Skills are user-authored; keep unknown Native provenance explicit and last.
  const priority = { user: 0, project: 0, system: 1, plugin: 2, native: 3 }
  return result.toSorted(
    (a, b) => priority[a.source] - priority[b.source] || a.name.localeCompare(b.name),
  )
}

function spawnDefaultAgySkillProbe(
  executablePath: string,
  args: readonly string[],
  probeCwd: string,
  env: NodeJS.ProcessEnv | undefined,
): OwnedAgySkillProbeProcess {
  const isWindowsCommand = process.platform === 'win32' && /\.cmd$/iu.test(executablePath)
  if (isWindowsCommand && /[&|<>^%!"\r\n]/u.test(executablePath)) {
    throw new AgentExecutionError(
      'runtime_incompatible',
      'Unsafe Antigravity executable path.',
      false,
    )
  }
  if (args.some((arg) => !/^(?:-[a-z]|--[a-z-]+|\/skills|json)$/u.test(arg))) {
    throw new AgentExecutionError(
      'protocol_error',
      'Unexpected Antigravity Skill probe arguments.',
      false,
    )
  }
  const group = new OwnedProcessGroup()
  const target = isWindowsCommand ? (process.env.ComSpec ?? 'cmd.exe') : executablePath
  const spawnArgs = isWindowsCommand
    ? ['/d', '/s', '/c', `""${executablePath}" ${args.join(' ')}"`]
    : [...args]
  const child = group.spawn(target, spawnArgs, {
    cwd: probeCwd,
    ...(env ? { env } : {}),
    windowsHide: true,
    windowsVerbatimArguments: isWindowsCommand,
  })
  return {
    child,
    close: (deadlineAt) => group.close(deadlineAt),
  }
}

/**
 * Discovers Antigravity Skills via zero-Turn `agy -p /skills --output-format json`
 * inside the canonical target project working directory with a 4s / 256 KiB cap.
 */
export async function discoverAgySkills(
  cwd: string,
  executablePath: string,
  signal: AbortSignal,
  options: AgySkillDiscoveryOptions = {},
): Promise<SkillBinding[]> {
  signal.throwIfAborted()
  const probeArgs = ['-p', '/skills', '--output-format', 'json'] as const
  const canonicalCwd = options.spawnProcess
    ? await realpath(cwd).catch(() => canonicalizeWithExistingAncestor(cwd))
    : await realpath(cwd)
  let owned: OwnedAgySkillProbeProcess | undefined
  try {
    signal.throwIfAborted()
    if (options.spawnProcess) {
      const supplied = options.spawnProcess(executablePath, probeArgs, canonicalCwd, options.env)
      owned = 'then' in supplied ? await supplied : supplied
    } else {
      owned = spawnDefaultAgySkillProbe(executablePath, probeArgs, canonicalCwd, options.env)
    }
    const { child } = owned
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let stdout = ''
    let capturedBytes = 0
    let failure: Error | undefined

    const rawOutput = await new Promise<string>((resolveOutput, rejectOutput) => {
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        failure = error
        stdout = ''
        cleanupListeners()
        rejectOutput(error)
      }
      const onTimeout = (): void => {
        fail(
          new AgentExecutionError(
            'transient_transport',
            'Antigravity Skill discovery exceeded its four-second deadline.',
            true,
          ),
        )
      }
      const onAbort = (): void => {
        fail(
          new AgentExecutionError(
            'user_stopped',
            'Antigravity Skill discovery was cancelled.',
            false,
          ),
        )
      }
      const timer = setTimeout(onTimeout, AGY_SKILL_DISCOVERY_TIMEOUT_MS)
      const onStdout = (chunk: Buffer): void => {
        if (settled) return
        capturedBytes += chunk.length
        if (capturedBytes > AGY_SKILL_DISCOVERY_MAX_BYTES) {
          fail(
            new AgentExecutionError(
              'response_too_large',
              'Antigravity Skill discovery exceeded its 256 KiB output limit.',
              false,
            ),
          )
          return
        }
        try {
          stdout += decoder.decode(chunk, { stream: true })
        } catch {
          fail(
            new AgentExecutionError(
              'protocol_error',
              'Antigravity returned invalid UTF-8 during Skill discovery.',
              false,
            ),
          )
        }
      }
      const onStderr = (chunk: Buffer): void => {
        if (settled) return
        capturedBytes += chunk.length
        if (capturedBytes > AGY_SKILL_DISCOVERY_MAX_BYTES) {
          fail(
            new AgentExecutionError(
              'response_too_large',
              'Antigravity Skill discovery exceeded its 256 KiB output limit.',
              false,
            ),
          )
        }
      }
      const onError = (): void => {
        fail(
          new AgentExecutionError(
            'runtime_incompatible',
            'Antigravity could not start its Skill discovery process.',
            false,
          ),
        )
      }
      const onStdinError = (): void => {
        child.stdin.destroy()
      }
      const onClose = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
        if (settled) return
        settled = true
        cleanupListeners()
        if (code !== 0 || closeSignal !== null) {
          rejectOutput(
            new AgentExecutionError(
              'runtime_incompatible',
              'Antigravity could not provide its native Skill catalog.',
              false,
            ),
          )
          return
        }
        try {
          resolveOutput(stdout + decoder.decode())
        } catch {
          rejectOutput(
            new AgentExecutionError(
              'protocol_error',
              'Antigravity returned truncated UTF-8 during Skill discovery.',
              false,
            ),
          )
        }
      }
      const cleanupListeners = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        child.stdout.off('data', onStdout)
        child.stderr.off('data', onStderr)
        child.off('error', onError)
        child.stdin.off('error', onStdinError)
        child.off('close', onClose)
      }

      signal.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', onStdout)
      child.stderr.on('data', onStderr)
      child.once('error', onError)
      child.stdin.once('error', onStdinError)
      child.once('close', onClose)
      child.stdin.end()
      if (signal.aborted) onAbort()
    })

    if (failure) throw failure
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(rawOutput)
    } catch {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity returned invalid JSON for /skills.',
        false,
      )
    }
    const parsedSkills = parseNativeAgySkillOutput(parsedJson)
    if (!parsedSkills) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity returned an unexpected /skills payload.',
        false,
      )
    }
    const records: NativeSkillCatalogRecord[] = parsedSkills.map((item) => {
      const record: NativeSkillCatalogRecord = {
        name: item.name,
        description: item.description,
        argumentHint: item.argumentHint ?? item.argument_hint ?? '',
      }
      if (item.path) record.path = item.path
      if (item.scope) record.scope = item.scope
      if (item.enabled !== undefined) record.enabled = item.enabled
      if (item.builtin !== undefined) record.builtin = item.builtin
      if (item.model_invocable !== undefined) record.modelInvocable = item.model_invocable
      const pluginRef = item.pluginId ?? item.plugin_id ?? item.plugin
      if (pluginRef) record.pluginId = pluginRef
      return record
    })
    return nativeSkillCatalog('agy', canonicalCwd, executablePath, records)
  } finally {
    if (owned?.close) {
      await owned.close(Date.now() + AGY_SKILL_CLEANUP_MS)
    } else if (owned && owned.child.exitCode === null && owned.child.signalCode === null) {
      try {
        owned.child.kill('SIGKILL')
      } catch {
        // Process may have exited concurrently.
      }
    }
  }
}

/** Validates and binds explicit /skill selections targeting Antigravity against its current catalog. */
export function bindAgySkillSelections(
  selections: readonly Pick<SkillSelection, 'id' | 'agentId' | 'name'>[],
  catalog: readonly SkillBinding[],
): SkillBinding[] {
  const bound: SkillBinding[] = []
  for (const selection of selections) {
    if (selection.agentId !== 'agy') continue
    const match = catalog.find(
      (candidate) =>
        candidate.agentId === 'agy' &&
        candidate.id === selection.id &&
        candidate.name === selection.name,
    )
    if (!match) {
      throw new AgentExecutionError(
        'protocol_error',
        `The native Skill /${selection.name} changed or is unavailable in Antigravity.`,
        false,
      )
    }
    bound.push(match)
  }
  return bound
}
