import type { Stats } from 'node:fs'

import { createHash } from 'node:crypto'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { RealWorkspace } from './real-harness.js'

import { nativeAnswerParity, type NativeAnswerParityInput } from './native-answer-parity.js'
const nativeFileLimit = 1000
export const nativeByteLimit = 8 * 1024 * 1024
const nativeRecordLimit = 10_000

/** Path and handle must describe the same unchanged complete snapshot throughout the read. */
export function nativeSnapshotStable(
  observations: readonly Pick<Stats, 'isFile' | 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>[],
  bytes: number,
): boolean {
  const first = observations[0]
  const keys = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const
  return (
    observations.length === 4 &&
    first !== undefined &&
    first.size === bytes &&
    observations.every((item) => item.isFile() && keys.every((key) => item[key] === first[key]))
  )
}

export type NativeEffortField = { present: false } | { present: true; value: string | null }

export interface CodexNativeTurnSettings {
  turnId?: string
  model: string
  effort: string | null
  effortSource: 'omitted' | 'effort' | 'reasoning_effort' | 'both'
  effortFields: { effort: NativeEffortField; reasoning_effort: NativeEffortField }
}

export interface CodexNativeDefaults {
  model: string | null
  effort: { source: 'model_reasoning_effort'; present: true; value: string | null }
}

export interface NativeEvidence {
  path: string
  sha256: string
  nativeIds: Set<string>
  codexModelStarts: number
  claudeUserInputs: number
  assistantModels: string[]
  shellCommands: string[]
  toolNames: string[]
  commandCalls: Array<{
    callId?: string
    command: string
    yieldTimeMs?: number
    timeoutMs?: number
    background?: boolean
    at?: string
  }>
  commandResults: Array<{ callId: string; output: string; at?: string }>
  execScripts: Array<{ callId?: string; input: string; at?: string }>
  codexTurnSettings: CodexNativeTurnSettings[]
  containsLiteralText(text: string): boolean
  containsText(text: string): boolean
  answerParity(input: NativeAnswerParityInput): ReturnType<typeof nativeAnswerParity> & {
    file: {
      sha256: string
      bytes: number
      records: number
      beforeSize: number
      afterSize: number
      identityStable: boolean
      snapshotStable: boolean
      modifiedDuringRead: boolean
    }
  }
}

export interface NativeSourceAuditProof {
  sourceFileSha256: string
  allToolsAllowed: boolean
  boundaryDiagnostics: { ledgerValid: boolean }
  codeModeScripts: Array<{ sha256: string }>
}
export type NativeSourceEvidence = Omit<
  NativeEvidence,
  'shellCommands' | 'commandCalls' | 'commandResults'
> & {
  commandInspection: {
    status: 'requires_source_audit'
    syntaxFailures: Array<{ sha256: string; bytes: number }>
  }
  certifySourceAudit(proof: NativeSourceAuditProof): NativeEvidence
}

export async function findNativeSourceRecord(
  ctx: RealWorkspace,
  agentId: 'claude' | 'codex',
  nativeSessionId: string,
): Promise<NativeSourceEvidence> {
  return findNativeRecordWith(ctx, agentId, nativeSessionId, readNativeSourceEvidence)
}

export async function findNativeRecord(
  ctx: RealWorkspace,
  agentId: 'claude' | 'codex',
  nativeSessionId: string,
): Promise<NativeEvidence> {
  return findNativeRecordWith(ctx, agentId, nativeSessionId, readNativeEvidence)
}

/** This observer owns one bounded scan of this fixture's Native files; no symlinks are followed. */
async function findNativeRecordWith<T extends { nativeIds: Set<string> }>(
  ctx: RealWorkspace,
  agentId: 'claude' | 'codex',
  nativeSessionId: string,
  read: (path: string) => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(nativeSessionId))
    throw new Error('Unexpected Native file identity')
  const storageRoot = await realpath(
    join(
      agentId === 'codex' ? ctx.fixture.codexHome : ctx.fixture.claudeHome,
      agentId === 'codex' ? 'sessions' : 'projects',
    ),
  )
  const ownedRoot = await realpath(ctx.fixture.directory)
  if (!isOwnedPath(ownedRoot, storageRoot))
    throw new Error('Native observation escaped its owned fixture')
  const queue = [storageRoot]
  const matches: string[] = []
  let entries = 0
  while (queue.length) {
    const path = queue.shift()!
    // oxlint-disable-next-line eslint/no-await-in-loop -- Keep only one bounded directory handle open.
    const directory = await opendir(path)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Finish and close this directory before opening the next one.
    for await (const entry of directory) {
      entries += 1
      if (entries > nativeFileLimit) throw new Error('Native scan exceeded 1000 entries')
      if (entry.isSymbolicLink()) throw new Error('Native scan refuses a filesystem symlink')
      const child = join(path, entry.name)
      if (entry.isDirectory()) queue.push(child)
      else if (
        entry.isFile() &&
        entry.name.endsWith('.jsonl') &&
        entry.name.includes(nativeSessionId)
      )
        matches.push(child)
    }
  }
  if (matches.length !== 1) throw new Error('Expected exactly one authentic Native record')
  const evidence = await read(matches[0]!)
  if (!evidence.nativeIds.has(nativeSessionId))
    throw new Error('Native filename and stored identity disagree')
  return evidence
}

export async function readNativeEvidence(path: string): Promise<NativeEvidence> {
  return (await readNativeEvidenceWith(path, 'strict')).evidence
}

/** Typed diagnostic path: command absence stays unavailable until a complete source audit certifies it. */
export async function readNativeSourceEvidence(path: string): Promise<NativeSourceEvidence> {
  const { evidence, syntaxFailures } = await readNativeEvidenceWith(path, 'source')
  const {
    shellCommands: _commands,
    commandCalls: _calls,
    commandResults: _results,
    ...snapshot
  } = evidence
  return {
    ...snapshot,
    commandInspection: { status: 'requires_source_audit', syntaxFailures },
    certifySourceAudit(proof) {
      if (
        proof.sourceFileSha256 !== evidence.sha256 ||
        !proof.allToolsAllowed ||
        !proof.boundaryDiagnostics.ledgerValid ||
        proof.codeModeScripts.length !== evidence.execScripts.length ||
        proof.codeModeScripts.some(
          (entry, index) =>
            entry.sha256 !==
            createHash('sha256').update(evidence.execScripts[index]!.input).digest('hex'),
        )
      )
        throw Error('Native command inspection requires the complete matching source audit.')
      return evidence
    },
  }
}

async function readNativeEvidenceWith(
  path: string,
  mode: 'strict' | 'source',
): Promise<{ evidence: NativeEvidence; syntaxFailures: Array<{ sha256: string; bytes: number }> }> {
  const syntaxFailures: Array<{ sha256: string; bytes: number }> = []
  const pathBefore = await lstat(path)
  if (!pathBefore.isFile()) throw new Error('Native evidence must be a regular file')
  const handle = await open(path, 'r')
  let bytes: Buffer
  let observedFile: {
    beforeSize: number
    afterSize: number
    identityStable: boolean
    snapshotStable: boolean
    modifiedDuringRead: boolean
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > nativeByteLimit)
      throw new Error('Native evidence exceeds 8 MiB')
    bytes = Buffer.alloc(nativeByteLimit + 1)
    let length = 0
    while (length < bytes.length) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One file read advances its owned bounded buffer.
      const result = await handle.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > nativeByteLimit) throw new Error('Native evidence exceeds 8 MiB')
    bytes = bytes.subarray(0, length)
    const after = await handle.stat()
    const pathAfter = await lstat(path)
    observedFile = {
      beforeSize: info.size,
      afterSize: after.size,
      identityStable: [pathBefore, after, pathAfter].every(
        (item) => item.isFile() && item.dev === info.dev && item.ino === info.ino,
      ),
      snapshotStable: nativeSnapshotStable([pathBefore, info, after, pathAfter], length),
      modifiedDuringRead:
        info.size !== after.size ||
        info.mtimeMs !== after.mtimeMs ||
        info.ctimeMs !== after.ctimeMs,
    }
  } finally {
    await handle.close()
  }
  const lines = bytes.toString('utf8').split('\n').filter(Boolean)
  if (lines.length > nativeRecordLimit) throw new Error('Native evidence exceeds 10000 records')
  const texts: string[] = []
  const codexStartedTurns = new Set<string>()
  const userRequestIds = new Set<string>()
  const containsLiteralText = (text: string): boolean =>
    bytes.toString('utf8').includes(JSON.stringify(text).slice(1, -1)) ||
    texts.some(
      (stored) => stored.includes(text) || stored.includes(JSON.stringify(text).slice(1, -1)),
    )
  const evidence: NativeEvidence = {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    nativeIds: new Set(),
    codexModelStarts: 0,
    claudeUserInputs: 0,
    assistantModels: [],
    shellCommands: [],
    toolNames: [],
    commandCalls: [],
    commandResults: [],
    execScripts: [],
    codexTurnSettings: [],
    containsLiteralText,
    containsText: (text) =>
      containsLiteralText(text) ||
      (evidence.nativeIds.size === 1 &&
        evidence.codexModelStarts === 1 &&
        codexStartedTurns.size === 1 &&
        observedFile.snapshotStable &&
        nativeAnswerParity(lines, {
          nativeSessionId: [...evidence.nativeIds][0]!,
          nativeTurnId: [...codexStartedTurns][0]!,
          text,
          markers: [],
        }).exactMatch),
    answerParity: (input) => {
      const projection = nativeAnswerParity(lines, input)
      return {
        ...projection,
        completeProjection: projection.completeProjection && observedFile.snapshotStable,
        exactMatch: projection.exactMatch && observedFile.snapshotStable,
        file: {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
          records: lines.length,
          ...observedFile,
        },
      }
    },
  }
  for (const line of lines) {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      throw new Error('Authentic Native evidence contains an incomplete JSON record')
    }
    if (!isRecord(record)) throw new Error('Malformed authentic Native record')
    const pending: unknown[] = [record]
    let textNodes = 0
    while (pending.length) {
      const value = pending.pop()
      textNodes += 1
      if (textNodes > nativeRecordLimit)
        throw new Error('Native record exceeds its structural bound')
      if (Array.isArray(value)) {
        if (value.length + pending.length > nativeRecordLimit)
          throw new Error('Native record exceeds its structural bound')
        pending.push(...value)
      } else if (isRecord(value)) {
        for (const [key, child] of Object.entries(value)) {
          if (
            (key === 'text' || key === 'content' || key === 'message') &&
            typeof child === 'string'
          ) {
            texts.push(child)
            if (texts.length > nativeRecordLimit)
              throw new Error('Native evidence exceeds its text-field bound')
          } else if (typeof child === 'object' && child !== null) pending.push(child)
        }
      }
    }
    if (typeof record['sessionId'] === 'string') evidence.nativeIds.add(record['sessionId'])
    if (record['type'] === 'assistant' && isRecord(record['message'])) {
      const message = record['message']
      if (typeof message['model'] === 'string' && message['model'].length <= 240)
        evidence.assistantModels.push(message['model'])
      if (Array.isArray(message['content']))
        for (const item of message['content']) {
          if (isRecord(item) && item['type'] === 'tool_use' && typeof item['name'] === 'string')
            evidence.toolNames.push(item['name'])
          if (
            isRecord(item) &&
            item['type'] === 'tool_use' &&
            item['name'] === 'Bash' &&
            isRecord(item['input']) &&
            typeof item['input']['command'] === 'string'
          ) {
            evidence.shellCommands.push(item['input']['command'])
            evidence.commandCalls.push({
              ...(typeof item['id'] === 'string' ? { callId: item['id'] } : {}),
              command: item['input']['command'],
              ...(typeof item['input']['timeout'] === 'number'
                ? { timeoutMs: item['input']['timeout'] }
                : {}),
              ...(typeof item['input']['run_in_background'] === 'boolean'
                ? { background: item['input']['run_in_background'] }
                : {}),
              ...(typeof record['timestamp'] === 'string' ? { at: record['timestamp'] } : {}),
            })
          }
        }
    }
    const payload = record['payload']
    if (record['type'] === 'turn_context' && !isRecord(payload))
      throw new Error('Malformed Native turn_context payload')
    if (isRecord(payload)) {
      if (record['type'] === 'session_meta' && typeof payload['id'] === 'string')
        evidence.nativeIds.add(payload['id'])
      if (record['type'] === 'event_msg' && payload['type'] === 'task_started') {
        evidence.codexModelStarts += 1
        if (typeof payload['turn_id'] === 'string') codexStartedTurns.add(payload['turn_id'])
      }
      if (record['type'] === 'turn_context') {
        const model = nativeSettingText(payload['model'], 'turn_context model')
        const effortFields = {
          effort: nativeEffortField(payload, 'effort'),
          reasoning_effort: nativeEffortField(payload, 'reasoning_effort'),
        }
        if (
          effortFields.effort.present &&
          effortFields.reasoning_effort.present &&
          effortFields.effort.value !== effortFields.reasoning_effort.value
        )
          throw new Error('Conflicting Native turn_context effort fields')
        const effortSource = effortFields.effort.present
          ? effortFields.reasoning_effort.present
            ? 'both'
            : 'effort'
          : effortFields.reasoning_effort.present
            ? 'reasoning_effort'
            : 'omitted'
        const effort = effortFields.effort.present
          ? effortFields.effort.value
          : effortFields.reasoning_effort.present
            ? effortFields.reasoning_effort.value
            : null
        const turnId = payload['turn_id']
        evidence.codexTurnSettings.push({
          ...(typeof turnId === 'string' ? { turnId } : {}),
          model,
          effort,
          effortSource,
          effortFields,
        })
      }
      if (
        record['type'] === 'response_item' &&
        ['function_call', 'custom_tool_call'].includes(String(payload['type'])) &&
        typeof payload['name'] === 'string'
      )
        evidence.toolNames.push(`${String(payload['type'])}:${payload['name']}`)
      if (
        record['type'] === 'response_item' &&
        ['function_call', 'custom_tool_call'].includes(String(payload['type'])) &&
        ['exec', 'exec_command', 'shell_command', 'shell'].includes(
          String(payload['name']).replace(/^functions\./u, ''),
        ) &&
        typeof (payload['arguments'] ?? payload['input']) === 'string'
      ) {
        const argument = payload['arguments'] ?? payload['input']
        if (typeof argument !== 'string') throw new Error('Native command input is not text')
        if (Buffer.byteLength(argument) > 8192)
          throw new Error('Native command arguments exceed 8 KiB')
        const callId = typeof payload['call_id'] === 'string' ? payload['call_id'] : undefined
        const at = typeof record['timestamp'] === 'string' ? record['timestamp'] : undefined
        if (payload['type'] === 'custom_tool_call')
          evidence.execScripts.push({
            input: argument,
            ...(callId ? { callId } : {}),
            ...(at ? { at } : {}),
          })
        try {
          const argumentsValue: unknown = JSON.parse(argument)
          // A CodeMode body remains JavaScript even when it also looks like JSON.
          if (
            payload['type'] === 'custom_tool_call' &&
            String(payload['name']).replace(/^functions\./u, '') === 'exec'
          )
            parseNativeExecScript(argument)
          if (isRecord(argumentsValue)) {
            const command = argumentsValue['cmd'] ?? argumentsValue['command']
            if (typeof command === 'string') {
              evidence.shellCommands.push(command)
              evidence.commandCalls.push({
                command,
                ...(callId ? { callId } : {}),
                ...(at ? { at } : {}),
                ...(typeof argumentsValue['yield_time_ms'] === 'number'
                  ? { yieldTimeMs: argumentsValue['yield_time_ms'] }
                  : {}),
                ...(typeof argumentsValue['timeout_ms'] === 'number'
                  ? { timeoutMs: argumentsValue['timeout_ms'] }
                  : {}),
              })
            }
          }
        } catch {
          // Native custom exec runs JavaScript that calls tools.exec_command.
          // Parse literal arguments without evaluating the untrusted script.
          if (payload['type'] === 'custom_tool_call') {
            let calls: NativeEvidence['commandCalls'] | undefined
            try {
              calls = literalExecCalls(argument)
            } catch (error) {
              if (mode !== 'source' || !(error instanceof SyntaxError)) throw error
              // oxlint-disable-next-line eslint/preserve-caught-error -- Parser causes may contain private script literals; retain bounded facts only.
              if (syntaxFailures.length >= 256) throw Error('Source syntax diagnostics exceed 256')
              syntaxFailures.push({
                sha256: createHash('sha256').update(argument).digest('hex'),
                bytes: Buffer.byteLength(argument),
              })
              // Unknown command inspection remains explicit and cannot leave this diagnostic path
              // until the caller supplies the matching complete source-ledger proof.
              calls = undefined
            }
            for (const call of calls ?? []) {
              evidence.shellCommands.push(call.command)
              evidence.commandCalls.push({
                ...call,
                ...(callId ? { callId } : {}),
                ...(at ? { at } : {}),
              })
            }
          }
        }
      }
      if (
        record['type'] === 'response_item' &&
        ['function_call_output', 'custom_tool_call_output'].includes(String(payload['type'])) &&
        typeof payload['call_id'] === 'string' &&
        typeof payload['output'] === 'string' &&
        (evidence.commandCalls.some((call) => call.callId === payload['call_id']) ||
          evidence.execScripts.some((call) => call.callId === payload['call_id']))
      ) {
        if (Buffer.byteLength(payload['output']) > 8192)
          throw new Error('Native command result exceeds 8 KiB')
        evidence.commandResults.push({
          callId: payload['call_id'],
          output: payload['output'],
          ...(typeof record['timestamp'] === 'string' ? { at: record['timestamp'] } : {}),
        })
      }
    }
    if (
      evidence.assistantModels.length > 1000 ||
      evidence.codexTurnSettings.length > 128 ||
      evidence.shellCommands.length > 256 ||
      evidence.toolNames.length > 256 ||
      evidence.commandCalls.length > 256 ||
      evidence.execScripts.length > 256 ||
      evidence.commandResults.length > 256 ||
      evidence.toolNames.some((name) => Buffer.byteLength(name) > 240) ||
      evidence.shellCommands.some((command) => Buffer.byteLength(command) > 8192)
    )
      throw new Error('Native task settings or command observation exceeded its bound')
    if (
      record['type'] === 'user' &&
      record['isSidechain'] !== true &&
      record['shouldQuery'] !== false
    ) {
      const message = record['message']
      const content = isRecord(message) ? message['content'] : undefined
      // Native tool-result envelopes are also type=user. They continue the
      // accepted task and are not a second human/model input.
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((block) => isRecord(block) && block['type'] === 'text')
                .map((block) => Reflect.get(block, 'text'))
                .filter((part): part is string => typeof part === 'string')
                .join('\n')
            : ''
      const marker = '\nPact context ('
      const offset = text.lastIndexOf(marker)
      const dataStart = offset >= 0 ? text.indexOf('\n', offset + 1) : -1
      if (dataStart >= 0 && typeof record['uuid'] === 'string') {
        try {
          const context: unknown = JSON.parse(text.slice(dataStart + 1))
          if (
            isRecord(context) &&
            context['version'] === 'pact-agent-prompt-v1' &&
            typeof context['messageId'] === 'string'
          )
            userRequestIds.add(record['uuid'])
        } catch {
          /* Quoted historical seeds are not a new explicit task. */
        }
      }
    }
  }
  evidence.claudeUserInputs = userRequestIds.size
  return { evidence, syntaxFailures }
}

/** Parse only the independent config/read ACK's settings scalars, never its private config. */
export function readCodexNativeDefaults(reply: unknown): CodexNativeDefaults {
  if (
    !isRecord(reply) ||
    Object.hasOwn(reply, 'error') ||
    !isRecord(reply['result']) ||
    !isRecord(reply['result']['config'])
  )
    throw new Error('Native config/read did not supply a successful configuration ACK')
  const config = reply['result']['config']
  if (!Object.hasOwn(config, 'model'))
    throw new Error('Native config/read did not report its model field')
  const model = config['model'] === null ? null : nativeSettingText(config['model'], 'model')
  const effort = nativeEffortField(config, 'model_reasoning_effort')
  if (!effort.present) throw new Error('Native config/read did not report its default effort field')
  return { model, effort: { source: 'model_reasoning_effort', ...effort } }
}

function nativeEffortField(record: Record<string, unknown>, key: string): NativeEffortField {
  if (!Object.hasOwn(record, key)) return { present: false }
  const value = record[key]
  return { present: true, value: value === null ? null : nativeSettingText(value, key) }
}

function nativeSettingText(value: unknown, field: string): string {
  // The pinned native protocol admits custom effort strings, not a closed enum.
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > 240 ||
    /[\0\r\n]/u.test(value)
  )
    throw new Error(`Invalid Native ${field} setting scalar`)
  return value
}

function isOwnedPath(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate)
  return remainder !== '' && !remainder.startsWith('..') && !isAbsolute(remainder)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseNativeExecScript(script: string): unknown {
  const desktopRequire = createRequire(
    resolve(import.meta.dirname, '../../apps/desktop/package.json'),
  )
  const reactRequire = createRequire(desktopRequire.resolve('@vitejs/plugin-react'))
  const babelRequire = createRequire(reactRequire.resolve('@babel/core'))
  const parser: unknown = babelRequire('@babel/parser')
  if (!isRecord(parser) || typeof parser['parse'] !== 'function')
    throw new Error('Native exec parser is unavailable')
  try {
    return Reflect.apply(parser['parse'], undefined, [script, { sourceType: 'module' }])
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    const position: unknown = Reflect.get(error, 'pos'),
      location: unknown = Reflect.get(error, 'loc'),
      reason: unknown = Reflect.get(error, 'reasonCode'),
      offset =
        typeof position === 'number' &&
        Number.isSafeInteger(position) &&
        position >= 0 &&
        position <= script.length
          ? position
          : null,
      punctuation: Record<string, string> = {
        '{': 'brace_open',
        '}': 'brace_close',
        '[': 'bracket_open',
        ']': 'bracket_close',
        '(': 'parenthesis_open',
        ')': 'parenthesis_close',
        ':': 'colon',
        ',': 'comma',
        ';': 'semicolon',
        "'": 'single_quote',
        '"': 'double_quote',
        '`': 'backtick',
        '\\': 'backslash',
        '/': 'slash',
        '=': 'equals',
        '.': 'period',
      },
      start = offset === null ? 0 : Math.max(0, offset - 8),
      characters =
        offset === null
          ? []
          : Array.from({ length: Math.min(script.length, offset + 9) - start }, (_, index) => {
              const value = script[start + index]!
              return {
                relativeOffset: start + index - offset,
                kind:
                  punctuation[value] ??
                  (/[a-zA-Z_$]/u.test(value)
                    ? 'ascii_letter'
                    : /[0-9]/u.test(value)
                      ? 'digit'
                      : /[\r\n]/u.test(value)
                        ? 'linebreak'
                        : /\s/u.test(value)
                          ? 'whitespace'
                          : value.charCodeAt(0) > 127
                            ? 'non_ascii'
                            : 'other_punctuation'),
              }
            }),
      boundedCoordinate = (key: string) => {
        const value: unknown = isRecord(location) ? location[key] : undefined
        return typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= script.length + 1
          ? value
          : null
      },
      facts = {
        version: 'pact-native-script-syntax-v1',
        inputSha256: createHash('sha256').update(script).digest('hex'),
        inputUtf8Bytes: Buffer.byteLength(script),
        reasonCode:
          typeof reason === 'string' && /^[A-Za-z]{1,80}$/u.test(reason) ? reason : 'unknown',
        offset,
        line: boundedCoordinate('line'),
        column: boundedCoordinate('column'),
        characters,
        rawScriptOrParserMessageRetained: false,
      },
      message = `Native exec script syntax inspection failed: ${JSON.stringify(facts)}`
    // Keep rejection and safe localization before fixture cleanup; Babel messages/causes may quote private inputs.
    throw new SyntaxError(
      Buffer.byteLength(message) <= 2048 ? message : 'Native exec script syntax inspection failed',
    )
  }
}

function literalExecCalls(script: string): NativeEvidence['commandCalls'] {
  const source = parseNativeExecScript(script)
  const pending: unknown[] = [source]
  const calls: NativeEvidence['commandCalls'] = []
  let nodes = 0
  while (pending.length) {
    const node = pending.pop()
    if (++nodes > 10_000) throw new Error('Native exec script exceeds its structural bound')
    if (!isRecord(node)) continue
    const callee = node['callee'],
      args = node['arguments']
    if (
      node['type'] === 'CallExpression' &&
      isRecord(callee) &&
      callee['type'] === 'MemberExpression' &&
      callee['computed'] !== true &&
      isRecord(callee['object']) &&
      callee['object']['type'] === 'Identifier' &&
      callee['object']['name'] === 'tools' &&
      isRecord(callee['property']) &&
      ['exec_command', 'shell_command'].includes(String(callee['property']['name'])) &&
      Array.isArray(args) &&
      isRecord(args[0]) &&
      args[0]['type'] === 'ObjectExpression' &&
      Array.isArray(args[0]['properties'])
    ) {
      const values: Record<string, string | number | boolean> = {}
      for (const property of args[0]['properties']) {
        if (
          !isRecord(property) ||
          property['type'] !== 'ObjectProperty' ||
          property['computed'] === true ||
          !isRecord(property['key']) ||
          !isRecord(property['value'])
        )
          continue
        const key = property['key']['name'] ?? property['key']['value'],
          value = property['value']
        if (
          typeof key !== 'string' ||
          ![
            'cmd',
            'command',
            'yield_time_ms',
            'timeout_ms',
            'timeout',
            'run_in_background',
          ].includes(key)
        )
          continue
        if (
          ['StringLiteral', 'NumericLiteral', 'BooleanLiteral'].includes(String(value['type'])) &&
          ['string', 'number', 'boolean'].includes(typeof value['value'])
        ) {
          const scalar = value['value']
          if (
            typeof scalar === 'string' ||
            typeof scalar === 'number' ||
            typeof scalar === 'boolean'
          )
            values[key] = scalar
        } else if (
          value['type'] === 'TemplateLiteral' &&
          Array.isArray(value['expressions']) &&
          value['expressions'].length === 0 &&
          Array.isArray(value['quasis']) &&
          value['quasis'].length === 1 &&
          isRecord(value['quasis'][0]) &&
          isRecord(value['quasis'][0]['value']) &&
          typeof value['quasis'][0]['value']['cooked'] === 'string'
        ) {
          // A no-substitution template is a literal string. Never evaluate an interpolation or tag.
          values[key] = value['quasis'][0]['value']['cooked']
        }
      }
      const command = values['cmd'] ?? values['command']
      if (typeof command === 'string')
        calls.push({
          command,
          ...(typeof values['yield_time_ms'] === 'number'
            ? { yieldTimeMs: values['yield_time_ms'] }
            : {}),
          ...(typeof values['timeout_ms'] === 'number'
            ? { timeoutMs: values['timeout_ms'] }
            : typeof values['timeout'] === 'number'
              ? { timeoutMs: values['timeout'] }
              : {}),
          ...(typeof values['run_in_background'] === 'boolean'
            ? { background: values['run_in_background'] }
            : {}),
        })
    }
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'comments', 'leadingComments', 'trailingComments', 'tokens'].includes(key))
        continue
      if (Array.isArray(child)) pending.push(...child)
      else if (isRecord(child)) pending.push(child)
    }
    if (pending.length > 10_000 || calls.length > 256)
      throw new Error('Native exec script exceeds its structural bound')
  }
  return calls
}
