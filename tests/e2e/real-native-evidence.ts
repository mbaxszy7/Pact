import { createHash } from 'node:crypto'
import { open, opendir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { RealWorkspace } from './real-harness.js'
const nativeFileLimit = 1000
export const nativeByteLimit = 8 * 1024 * 1024
const nativeRecordLimit = 10_000

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
  codexTurnSettings: Array<{ turnId?: string; model: string; effort: string | null }>
  containsText(text: string): boolean
}

/** This observer owns one bounded scan of this fixture's Native files; no symlinks are followed. */
export async function findNativeRecord(
  ctx: RealWorkspace,
  agentId: 'claude' | 'codex',
  nativeSessionId: string,
): Promise<NativeEvidence> {
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
  const evidence = await readNativeEvidence(matches[0]!)
  if (!evidence.nativeIds.has(nativeSessionId))
    throw new Error('Native filename and stored identity disagree')
  return evidence
}

export async function readNativeEvidence(path: string): Promise<NativeEvidence> {
  const handle = await open(path, 'r')
  let bytes: Buffer
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
  } finally {
    await handle.close()
  }
  const lines = bytes.toString('utf8').split('\n').filter(Boolean)
  if (lines.length > nativeRecordLimit) throw new Error('Native evidence exceeds 10000 records')
  const texts: string[] = []
  const userRequestIds = new Set<string>()
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
    containsText: (text) =>
      bytes.toString('utf8').includes(JSON.stringify(text).slice(1, -1)) ||
      texts.some(
        (stored) => stored.includes(text) || stored.includes(JSON.stringify(text).slice(1, -1)),
      ),
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
    if (isRecord(payload)) {
      if (record['type'] === 'session_meta' && typeof payload['id'] === 'string')
        evidence.nativeIds.add(payload['id'])
      if (record['type'] === 'event_msg' && payload['type'] === 'task_started')
        evidence.codexModelStarts += 1
      if (record['type'] === 'turn_context' && typeof payload['model'] === 'string') {
        const effort = payload['effort'] ?? payload['reasoning_effort']
        const turnId = payload['turn_id']
        evidence.codexTurnSettings.push({
          ...(typeof turnId === 'string' ? { turnId } : {}),
          model: payload['model'],
          effort: typeof effort === 'string' ? effort : null,
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
            const calls = literalExecCalls(argument)
            for (const call of calls) {
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
  return evidence
}

function isOwnedPath(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate)
  return remainder !== '' && !remainder.startsWith('..') && !isAbsolute(remainder)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function literalExecCalls(script: string): NativeEvidence['commandCalls'] {
  const desktopRequire = createRequire(
    resolve(import.meta.dirname, '../../apps/desktop/package.json'),
  )
  const reactRequire = createRequire(desktopRequire.resolve('@vitejs/plugin-react'))
  const babelRequire = createRequire(reactRequire.resolve('@babel/core'))
  const parser: unknown = babelRequire('@babel/parser')
  if (!isRecord(parser) || typeof parser['parse'] !== 'function')
    throw new Error('Native exec parser is unavailable')
  const source: unknown = Reflect.apply(parser['parse'], undefined, [
    script,
    { sourceType: 'module' },
  ])
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
