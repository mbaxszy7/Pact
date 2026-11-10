import { createHash } from 'node:crypto'

import { parseNativeExecScript } from './real-native-evidence.js'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const known = new Set([
  'undefined',
  'isError',
  'stringify',
  'push',
  'exit',
  'read_collaboration_source',
  'tools',
  'JSON',
  'parse',
  'Promise',
  'all',
  'map',
  'filter',
  'forEach',
  'Object',
  'Array',
  'keys',
  'values',
  'entries',
  'isArray',
  'console',
  'log',
  'text',
  'content',
  'structuredContent',
  'members',
  'items',
  'documents',
  'read',
  'bodyRead',
  'userInformation',
  'userInformationRead',
  'clarificationAnswer',
  'clarificationAnswerRead',
  'body',
  'batchRead',
  'sourceReadArguments',
  'sourceNavigation',
  'sourceGrant',
  'grant',
  'runId',
  'source',
  'document',
  'batchId',
  'offset',
  'sourceReference',
  'nextOffset',
  'nextRead',
  'context',
  'kind',
  'id',
  'sha256',
  'bytes',
  'chars',
  'batch',
  'root_batch',
  'inputs',
  'handoff_sources',
  'native-root-v1',
])

/** Diagnostic syntax only: literals/comments/private identifiers never leave the snapshot owner. */
export function sourceReadFailureScript(input: string) {
  const sha256 = digest(input)
  if (Buffer.byteLength(input) > 8192)
    return { sha256, status: 'unavailable', reason: 'input_bound' }
  try {
    const ast = parseNativeExecScript(input)
    const names = new Map<string, string>(),
      seen = new WeakSet<object>()
    const edits: Array<{ start: number; end: number; text: string }> = []
    let nodes = 0
    const literal = (value: string) => `<literal:${Buffer.byteLength(value)}:${digest(value)}>`
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object' || seen.has(value)) return
      seen.add(value)
      if (++nodes > 10_000) throw Error('AST bound')
      if (Array.isArray(value)) {
        for (const item of value) visit(item)
        return
      }
      if (!record(value)) return
      const item = value,
        type = item['type']
      const start = item['start'],
        end = item['end']
      if (typeof start === 'number' && typeof end === 'number') {
        const replace = (text: string) => edits.push({ start, end, text })
        if (type === 'Identifier' && typeof item['name'] === 'string') {
          const name = item['name']
          if (!known.has(name)) {
            if (!names.has(name))
              names.set(
                name,
                /^mcp__pact_peer_[a-f0-9]{32}__read_collaboration_source$/u.test(name)
                  ? 'sourceReader'
                  : `v${names.size + 1}`,
              )
            replace(names.get(name)!)
          }
          return
        }
        if (['StringLiteral', 'DirectiveLiteral'].includes(String(type))) {
          const text = String(item['value'])
          replace(JSON.stringify(known.has(text) ? text : literal(text)))
          return
        }
        if (type === 'TemplateElement') {
          const part = item['value']
          if (!record(part)) throw Error('Invalid template structure')
          replace(literal(String(part['raw'])))
          return
        }
        if (type === 'CommentLine' || type === 'CommentBlock') {
          replace('/*redacted*/')
          return
        }
        if (type === 'RegExpLiteral') {
          replace('/redacted/')
          return
        }
        if (type === 'BigIntLiteral' || type === 'DecimalLiteral') {
          replace('0')
          return
        }
      }
      for (const [key, child] of Object.entries(item))
        if (!['loc', 'extra', 'tokens', 'errors'].includes(key)) visit(child)
    }
    visit(ast)
    let skeleton = input,
      previous = input.length + 1
    for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
      if (edit.end > previous) continue
      skeleton = skeleton.slice(0, edit.start) + edit.text + skeleton.slice(edit.end)
      previous = edit.start
    }
    if (Buffer.byteLength(skeleton) > 8192)
      return { sha256, status: 'unavailable', reason: 'output_bound' }
    return { sha256, status: 'observed', skeleton, nodes, rawScriptRetained: false }
  } catch {
    return { sha256, status: 'unavailable', reason: 'parse_or_structure_bound' }
  }
}
