import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { Script } from 'node:vm'

import {
  collaborationDocumentSchema,
  decisionJsonBytes,
  collaborationInputBatchReferenceSchema,
  type CollaborationInputBatchReference,
  collaborationSourceReadResultSchema,
  collaborationSourceReadSchema,
  collaborationSourceNativeReadSchema,
  collaborationSourceNativeProofSchema,
  collaborationSourceReferenceReadSchema,
  collaborationSourceReferencePayloadSchema,
  collaborationSourceWireResultSchema,
  type CollaborationDocument,
  type CollaborationSourceRead,
  type CollaborationSourceReadResult,
  type CollaborationSourceWireResult,
  sourceReadCallIdentity,
} from '../../packages/contracts/src/index.js'
import { assembleFrozenBatch } from './frozen-batch-evidence.js'
import {
  nativeByteLimit,
  parseNativeExecScript,
  type NativeEvidence,
} from './real-native-evidence.js'

const recordLimit = 10_000
const sourceTool = /^(?:function_call:)?mcp__pact_peer_[a-f0-9]{32}__read_collaboration_source$/u
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function isRoutingSourceTool(name: string) {
  return sourceTool.test(name)
}

interface ExpectedSource {
  runId: string
  batchId: string
  commentId: string
  commentSha256: string
  batchBodySha256?: string | undefined
  nativeSessionId?: string | undefined
  nativeTurnId?: string | undefined
  declaration?: CollaborationDocument | undefined
  answer?: CollaborationDocument | undefined
}
interface NativeCall {
  id: string
  name: string
  input: unknown
  output?: unknown
  observedAt?: number
  sourceRejected?: true
  nativeRootObserved?: true
}
interface SourceReceipt {
  request: CollaborationSourceRead
  page: CollaborationSourceReadResult
  reader: string
  submitted: 'legacy' | 'sourceReference' | 'nativeRoot'
}

interface NativeCallShapeDiagnostic {
  shapes: string[]
  readerHashes: string[]
  omittedReaderOccurrences: number
}

const sourceCapabilityRefusal =
  'Use the exact sourceGrant from the current root input. This request has no active matching source capability.'
const canonicalReader = (name: string) => name.replace(/^function_call:/u, '')

/** Diagnostic categories only: never retain native error messages, arguments or source text. */
function nativeErrorShape(input: unknown, observeTransport = false) {
  const value = typeof input === 'string' ? { message: input } : input
  if (!object(value)) return { object: false }
  const error = object(value['error']) ? value['error'] : undefined,
    code = error?.['code'] ?? value['code'],
    content = Array.isArray(value['content']) ? value['content'].slice(0, 4) : [],
    text = [
      value['message'],
      value['error'],
      error?.['message'],
      ...content.map((part) => (object(part) ? part['text'] : undefined)),
    ]
      .filter((part): part is string => typeof part === 'string')
      .map((part) => part.slice(0, 2048))
      .join('\n')
  const missingCall = /([A-Za-z_$][A-Za-z0-9_$.[\]]{0,255}) is not a function/u.exec(text)?.[1],
    missingReader = missingCall?.replace(/^tools\./u, ''),
    notFunction = /not a function/iu.test(text),
    transportText =
      observeTransport && typeof value['message'] === 'string'
        ? value['message'].slice(0, 2048)
        : '',
    httpStatus = /\b(?:HTTP(?: status)?|status(?: code)?)\D{0,16}([45]\d{2})\b/iu.exec(
      transportText,
    ),
    notFound = /\b404\s+Not Found\b/iu.test(transportText),
    jsonDecode =
      /JSON\.parse|not valid JSON|JSON input|expected value at line \d+ column \d+|(?:decod|pars).{0,24}(?:JSON|response)/iu.test(
        transportText,
      )
  return {
    object: true,
    isError: value['isError'] === true,
    code: typeof code === 'number' && Number.isSafeInteger(code) ? code : null,
    validation: /validation|invalid_type|invalid_format|unrecognized_keys/iu.test(text),
    unknownTool: /unknown tool|tool not found|no such tool/iu.test(text),
    notFunction,
    notFunctionTarget: !notFunction
      ? null
      : missingReader && sourceTool.test(missingReader)
        ? 'qualified_source_reader'
        : missingCall === 'tools.read_collaboration_source'
          ? 'unqualified_source_reader'
          : missingCall === 'tools.get'
            ? 'tool_lookup'
            : missingCall === 'tools.call'
              ? 'generic_tool_call'
              : missingCall?.startsWith('tools[')
                ? 'computed_tool'
                : 'local_or_other',
    notFunctionReaderSha256:
      missingReader && sourceTool.test(missingReader) ? digest(missingReader) : null,
    jsonParseFailure:
      /JSON\.parse|not valid JSON|JSON input|expected value at line \d+ column \d+/iu.test(text),
    ...(observeTransport
      ? {
          nativeFailureKind: httpStatus
            ? httpStatus[1] === '404'
              ? 'http_404'
              : 'http_status'
            : notFound
              ? 'http_404'
              : transportText.includes(sourceCapabilityRefusal)
                ? 'source_capability_refused'
                : transportText.includes('The peer Tool request failed.')
                  ? 'host_json_error'
                  : jsonDecode
                    ? 'json_decode'
                    : /timed? ?out|timeout/iu.test(transportText)
                      ? 'timeout'
                      : /connection|transport.{0,24}(?:closed|error)|broken pipe/iu.test(
                            transportText,
                          )
                        ? 'connection_or_transport'
                        : /not a function/iu.test(transportText)
                          ? 'not_function'
                          : 'unknown',
          nativeHttpStatus: httpStatus ? Number(httpStatus[1]) : notFound ? 404 : null,
          nativeConnectionKind: /connection closed/iu.test(transportText)
            ? 'closed'
            : /connection reset|ECONNRESET/iu.test(transportText)
              ? 'reset'
              : /connection refused|ECONNREFUSED/iu.test(transportText)
                ? 'refused'
                : /broken pipe|EPIPE/iu.test(transportText)
                  ? 'broken_pipe'
                  : /error sending|failed to send/iu.test(transportText)
                    ? 'send_error'
                    : /client.{0,20}(?:not connected|disconnected)/iu.test(transportText)
                      ? 'client_disconnected'
                      : null,
        }
      : {}),
    scriptErrorClass:
      /(?:^|\n)Script error:\r?\n+(SyntaxError|TypeError|ReferenceError|RangeError|EvalError|URIError|Error):/u.exec(
        text,
      )?.[1] ?? null,
    capabilityRefused: text === sourceCapabilityRefusal,
    contentCount: Array.isArray(value['content']) ? value['content'].length : 0,
  }
}

function sourceArgumentShape(value: unknown) {
  const known = new Set([
      'runId',
      'grant',
      'source',
      'document',
      'batchId',
      'offset',
      'id',
      'sha256',
      'bytes',
      'chars',
      'sourceReference',
      'context',
      'part',
      'ordinal',
    ]),
    keys = (entry: unknown) =>
      object(entry)
        ? Object.keys(entry)
            .slice(0, 12)
            .map((key) => (known.has(key) ? key : 'other'))
        : [],
    validation =
      object(value) && Object.hasOwn(value, 'context')
        ? collaborationSourceNativeReadSchema.safeParse(value)
        : object(value) && Object.hasOwn(value, 'sourceReference')
          ? collaborationSourceReferenceReadSchema.safeParse(value)
          : collaborationSourceReadSchema.safeParse(value)
  const document = collaborationDocumentSchema.safeParse(
    object(value) ? value['document'] : undefined,
  )
  return {
    kind: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    documentIdSha256: document.success ? digest(document.data.id) : null,
    documentSha256: document.success ? document.data.sha256 : null,
    referenceChars:
      object(value) && typeof value['sourceReference'] === 'string'
        ? value['sourceReference'].length
        : null,
    valid: validation.success,
    source:
      collaborationSourceNativeReadSchema.shape.source.safeParse(
        object(value) ? value['source'] : undefined,
      ).data ?? 'unknown',
    part: object(value)
      ? (collaborationSourceNativeReadSchema.shape.part.safeParse(value['part']).data ?? null)
      : null,
    ordinal: object(value)
      ? (collaborationSourceNativeReadSchema.shape.ordinal.safeParse(value['ordinal']).data ?? null)
      : null,
    offset:
      object(value) && Number.isSafeInteger(value['offset']) && Number(value['offset']) >= 0
        ? Number(value['offset'])
        : null,
    submitted:
      object(value) && Object.hasOwn(value, 'context')
        ? 'nativeRoot'
        : object(value) && Object.hasOwn(value, 'sourceReference')
          ? 'sourceReference'
          : 'legacy',
    referenceSha256:
      object(value) && typeof value['sourceReference'] === 'string'
        ? digest(value['sourceReference'])
        : null,
    keys: keys(value),
    documentKeys: object(value) ? keys(value['document']) : [],
    issues: validation.success
      ? []
      : validation.error.issues.slice(0, 8).map((issue) => ({
          code: issue.code,
          path: issue.path
            .slice(0, 4)
            .map((key) => (typeof key === 'string' && known.has(key) ? key : 'other')),
        })),
  }
}

/** Exact PactPeerToolServer pre-read denial, never a generic native error or failed operation. */
function definiteSourceRefusal(value: unknown): boolean {
  if (
    !object(value) ||
    value['isError'] !== true ||
    Object.keys(value).some((key) => !['content', 'isError'].includes(key)) ||
    !Array.isArray(value['content']) ||
    value['content'].length !== 1
  )
    return false
  const text = value['content'][0]
  return (
    object(text) &&
    Object.keys(text).every((key) => ['type', 'text'].includes(key)) &&
    text['type'] === 'text' &&
    text['text'] === sourceCapabilityRefusal
  )
}

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function resultPage(
  value: unknown,
  depth = 0,
): CollaborationSourceReadResult | CollaborationSourceWireResult | undefined {
  if (depth > 4) throw Error('Frozen-source Native result exceeds its wrapper bound')
  const raw = parsed(value),
    page = collaborationSourceWireResultSchema.safeParse(raw)
  if (page.success) return page.data
  const legacy = collaborationSourceReadResultSchema.safeParse(raw)
  if (legacy.success) return legacy.data
  if (Array.isArray(raw)) {
    if (raw.length > 24) throw Error('Frozen-source Native result exceeds its item bound')
    for (const item of raw) {
      const found = resultPage(item, depth + 1)
      if (found) return found
    }
  } else if (object(raw)) {
    if (raw['isError'] === true) return undefined
    for (const key of ['content', 'text', 'Ok']) {
      if (!Object.hasOwn(raw, key)) continue
      const found = resultPage(raw[key], depth + 1)
      if (found) return found
    }
  }
  return undefined
}

function currentGrant(text: unknown, expected: ExpectedSource) {
  if (typeof text !== 'string') return undefined
  const start = text.indexOf('Pact context (JSON reference data;')
  if (start < 0) return undefined
  const context = parsed(text.slice(text.indexOf('\n', start) + 1).trim())
  if (!object(context) || !object(context['sourceGrant']) || !object(context['inputBatchRef']))
    return undefined
  const grant = context['sourceGrant']
  if (expected.answer) {
    const answer = collaborationDocumentSchema.safeParse(context['clarificationAnswer'])
    if (!answer.success || JSON.stringify(answer.data) !== JSON.stringify(expected.answer))
      return undefined
  }
  return grant['runId'] === expected.runId &&
    typeof grant['grant'] === 'string' &&
    context['inputBatchRef']['id'] === expected.batchId
    ? grant['grant']
    : undefined
}

/** Resolve only the explicit new selection form; authentication still requires the genuine Native leaf and Host proof below. */
function nativeSelection(
  raw: unknown,
  expected: ExpectedSource,
  grant: string,
  documents?: ReadonlyMap<string, { canonicalDocument?: CollaborationDocument }>,
) {
  const supplied = collaborationSourceNativeReadSchema.safeParse(raw)
  if (!supplied.success) return undefined
  const { context: _context, part, ordinal: _ordinal, ...target } = supplied.data
  const document =
    target.source === 'root_document' && part
      ? documents?.get(digest(JSON.stringify({ ...supplied.data, offset: 0 })))?.canonicalDocument
      : undefined
  if (target.source === 'root_document' && !document) return undefined
  return collaborationSourceReadSchema.parse({
    ...target,
    ...(target.source === 'root_batch' ? { source: 'batch', batchId: expected.batchId } : {}),
    ...(document ? { source: 'document', document } : {}),
    runId: expected.runId,
    grant,
  })
}

/** Diagnostic only: compare the actual supplied seed with the current root, never repair it. */
function currentReadArguments(text: unknown, expected: ExpectedSource, grant: string) {
  if (typeof text !== 'string') return undefined
  const start = text.indexOf('Pact context (JSON reference data;')
  if (start < 0) return undefined
  const context = parsed(text.slice(text.indexOf('\n', start) + 1).trim())
  if (!object(context) || !Object.hasOwn(context, 'sourceReadArguments')) return undefined
  const seed = context['sourceReadArguments']
  const native = nativeSelection(seed, expected, grant)
  if (native)
    return (
      native.source === 'batch' &&
      native.batchId === expected.batchId &&
      native.document === undefined &&
      native.offset === 0
    )
  const reference = referenceRequest(seed, expected, grant)
  if (reference)
    return (
      reference.source === 'batch' &&
      reference.batchId === expected.batchId &&
      reference.offset === 0
    )
  return (
    object(seed) &&
    Object.keys(seed).length === 5 &&
    seed['source'] === 'batch' &&
    seed['runId'] === expected.runId &&
    seed['grant'] === grant &&
    seed['batchId'] === expected.batchId &&
    seed['offset'] === 0
  )
}

/** Payload claims are untrusted; this does not authenticate the signature or authorize a read. */
function untrustedReferenceRequest(raw: unknown): CollaborationSourceRead | undefined {
  const supplied = collaborationSourceReferenceReadSchema.safeParse(raw)
  if (!supplied.success) return undefined
  const parts = /^p1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(supplied.data.sourceReference)
  if (!parts) return undefined
  const bytes = Buffer.from(parts[1]!, 'base64url')
  if (bytes.length > 1200 || bytes.toString('base64url') !== parts[1]) return undefined
  const payload = collaborationSourceReferencePayloadSchema.safeParse(
    parsed(bytes.toString('utf8')),
  )
  if (!payload.success) return undefined
  const request = collaborationSourceReadSchema.parse({
    ...payload.data.request,
    offset: supplied.data.offset,
  })
  if (
    request.source === 'document'
      ? !request.document || request.batchId !== undefined
      : request.source === 'batch'
        ? !request.batchId || request.document !== undefined
        : request.document !== undefined || request.batchId !== undefined
  )
    return undefined
  return request
}

/** Only a previously supplied reference plus actual Host binding proves a read. */
function referenceRequest(
  raw: unknown,
  expected: ExpectedSource,
  grant: string,
): CollaborationSourceRead | undefined {
  const request = untrustedReferenceRequest(raw)
  return request?.runId === expected.runId && request.grant === grant ? request : undefined
}

function sourcePageFacts({
  source,
  text,
  offset,
  nextOffset,
  document,
}: CollaborationSourceReadResult) {
  return JSON.stringify({ source, text, offset, nextOffset, document })
}

function completePages(pages: CollaborationSourceReadResult[]) {
  const seen = new Map<number, CollaborationSourceReadResult>()
  for (const page of pages) {
    const previous = seen.get(page.offset)
    if (previous && sourcePageFacts(previous) !== sourcePageFacts(page))
      throw Error('A frozen-source Native page changed at the same cursor')
    seen.set(page.offset, page)
  }
  const ordered: CollaborationSourceReadResult[] = []
  let cursor = 0
  for (let count = 0; count <= pages.length; count += 1) {
    const page = seen.get(cursor)
    if (!page) return undefined
    ordered.push(page)
    if (page.nextOffset === null) return ordered
    if (page.nextOffset <= cursor) throw Error('Frozen-source Native pagination did not advance')
    cursor = page.nextOffset
  }
  throw Error('Frozen-source Native pagination exceeded its receipt bound')
}

/** Statically prove reader-metadata lookup and output; never evaluate native scripts. */
/** A closed data-only grammar. No capability aliases, unknown globals, imports or dynamic code. */
function pureLocalData(file: unknown): boolean {
  if (
    !object(file) ||
    !object(file['program']) ||
    !Array.isArray(file['program']['body']) ||
    file['program']['interpreter'] != null
  )
    return false
  const locals = new Set<string>(),
    forbidden = new Set([
      '__proto__',
      'prototype',
      'constructor',
      'call',
      'apply',
      'bind',
      'toString',
      'valueOf',
      '__defineGetter__',
      '__defineSetter__',
      '__lookupGetter__',
      '__lookupSetter__',
    ]),
    builtins = new Set([
      'JSON',
      'text',
      'tools',
      'ALL_TOOLS',
      'exit',
      'undefined',
      'globalThis',
      'Function',
      'eval',
      'Object',
      'Array',
      'String',
      'Number',
      'Boolean',
      'Math',
      'Date',
      'RegExp',
      'Promise',
      'Proxy',
      'Reflect',
      'Map',
      'Set',
      'WeakMap',
      'WeakSet',
      'Symbol',
      'BigInt',
      'Error',
      'TypeError',
      'SyntaxError',
    ])
  const identifier = (
    node: unknown,
  ): node is Record<string, unknown> & { type: 'Identifier'; name: string } =>
    object(node) && node['type'] === 'Identifier' && typeof node['name'] === 'string'
  const expression = (node: unknown, depth = 0): boolean => {
    if (depth > 64 || !object(node)) return false
    const next = (value: unknown) => expression(value, depth + 1)
    if (
      ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral'].includes(
        String(node['type']),
      )
    )
      return true
    if (identifier(node)) return node['name'] === 'undefined' || locals.has(node['name'])
    if (node['type'] === 'ArrayExpression')
      return (
        Array.isArray(node['elements']) &&
        node['elements'].every((value) => value === null || next(value))
      )
    if (node['type'] === 'ObjectExpression')
      return (
        Array.isArray(node['properties']) &&
        node['properties'].every((property) => {
          if (
            !object(property) ||
            property['type'] !== 'ObjectProperty' ||
            property['computed'] === true ||
            property['method'] === true ||
            !object(property['key'])
          )
            return false
          const key = property['key'],
            name =
              key['type'] === 'Identifier'
                ? key['name']
                : ['StringLiteral', 'NumericLiteral'].includes(String(key['type']))
                  ? key['value']
                  : undefined
          return (
            (typeof name === 'string' || typeof name === 'number') &&
            !forbidden.has(String(name)) &&
            next(property['value'])
          )
        })
      )
    if (
      node['type'] === 'MemberExpression' &&
      node['optional'] !== true &&
      object(node['property'])
    ) {
      const property = node['property'],
        name =
          node['computed'] === true
            ? ['StringLiteral', 'NumericLiteral'].includes(String(property['type']))
              ? property['value']
              : undefined
            : identifier(property)
              ? property['name']
              : undefined
      return (
        (typeof name === 'string' || typeof name === 'number') &&
        !forbidden.has(String(name)) &&
        next(node['object'])
      )
    }
    if (
      node['type'] === 'CallExpression' &&
      node['optional'] !== true &&
      Array.isArray(node['arguments']) &&
      node['arguments'].length === 1
    ) {
      const callee = node['callee']
      if (identifier(callee) && callee['name'] === 'text') return next(node['arguments'][0])
      return (
        object(callee) &&
        callee['type'] === 'MemberExpression' &&
        callee['computed'] !== true &&
        callee['optional'] !== true &&
        identifier(callee['object']) &&
        callee['object']['name'] === 'JSON' &&
        identifier(callee['property']) &&
        ['parse', 'stringify'].includes(callee['property']['name']) &&
        next(node['arguments'][0])
      )
    }
    if (node['type'] === 'BinaryExpression' || node['type'] === 'LogicalExpression')
      return next(node['left']) && next(node['right'])
    if (
      node['type'] === 'UnaryExpression' &&
      ['!', '+', '-', '~', 'typeof', 'void'].includes(String(node['operator']))
    )
      return next(node['argument'])
    if (node['type'] === 'ConditionalExpression')
      return next(node['test']) && next(node['consequent']) && next(node['alternate'])
    if (node['type'] === 'TemplateLiteral')
      return Array.isArray(node['expressions']) && node['expressions'].every(next)
    return false
  }
  return file['program']['body'].every((statement) => {
    if (!object(statement)) return false
    if (statement['type'] === 'EmptyStatement') return true
    if (statement['type'] === 'ExpressionStatement') return expression(statement['expression'])
    if (
      statement['type'] !== 'VariableDeclaration' ||
      statement['kind'] !== 'const' ||
      !Array.isArray(statement['declarations'])
    )
      return false
    return statement['declarations'].every((declaration) => {
      if (!object(declaration) || !identifier(declaration['id'])) return false
      const name = declaration['id']['name']
      if (locals.size >= 128 || locals.has(name) || builtins.has(name)) return false
      locals.add(name)
      return expression(declaration['init'])
    })
  })
}

function sourceToolDiscovery(file: unknown): boolean {
  if (!object(file) || !object(file['program']) || !Array.isArray(file['program']['body']))
    return false
  if (
    (Array.isArray(file['program']['directives']) && file['program']['directives'].length > 0) ||
    file['program']['interpreter'] != null
  )
    return false
  const body = file['program']['body']
  const identifier = (node: unknown, name?: string): node is Record<string, unknown> =>
    object(node) &&
    node['type'] === 'Identifier' &&
    typeof node['name'] === 'string' &&
    (name === undefined || node['name'] === name)
  const member = (node: unknown, name: string): node is Record<string, unknown> =>
    object(node) &&
    node['type'] === 'MemberExpression' &&
    node['computed'] === false &&
    identifier(node['property'], name)
  const metadataText = (node: unknown, parameter: string, depth = 0): boolean => {
    if (!object(node) || depth > 8) return false
    if (node['type'] === 'StringLiteral') return typeof node['value'] === 'string'
    if (
      (member(node, 'name') || member(node, 'description')) &&
      identifier(node['object'], parameter)
    )
      return true
    return (
      node['type'] === 'BinaryExpression' &&
      node['operator'] === '+' &&
      metadataText(node['left'], parameter, depth + 1) &&
      metadataText(node['right'], parameter, depth + 1)
    )
  }
  // Undefined rejects syntax; false is a pure metadata predicate without the reader.
  // Every branch must be pure and the complete disjunction must include the reader.
  const predicate = (node: unknown, parameter: string, depth = 0): boolean | undefined => {
    if (!object(node) || depth > 8) return undefined
    if (node['type'] === 'LogicalExpression' && node['operator'] === '||') {
      const left = predicate(node['left'], parameter, depth + 1),
        right = predicate(node['right'], parameter, depth + 1)
      return left === undefined || right === undefined ? undefined : left || right
    }
    if (
      node['type'] !== 'CallExpression' ||
      !Array.isArray(node['arguments']) ||
      node['arguments'].length !== 1
    )
      return undefined
    const callee = node['callee'],
      argument = node['arguments'][0]
    if (member(callee, 'includes')) {
      if (
        !(
          metadataText(callee['object'], parameter) &&
          object(argument) &&
          argument['type'] === 'StringLiteral' &&
          typeof argument['value'] === 'string' &&
          /^[A-Za-z_][A-Za-z0-9_]{0,239}$/u.test(argument['value'])
        )
      )
        return undefined
      return argument['value'] === 'read_collaboration_source'
    }
    if (
      !member(callee, 'test') ||
      !object(callee['object']) ||
      callee['object']['type'] !== 'RegExpLiteral' ||
      !metadataText(argument, parameter)
    )
      return undefined
    const pattern = callee['object']['pattern'],
      flags = callee['object']['flags']
    if (
      !(
        typeof pattern === 'string' &&
        pattern.length <= 240 &&
        /^[A-Za-z_][A-Za-z0-9_]*(?:\|[A-Za-z_][A-Za-z0-9_]*)*$/u.test(pattern) &&
        ['', 'i', 'u', 'iu', 'ui'].includes(String(flags))
      )
    )
      return undefined
    return pattern.split('|').includes('read_collaboration_source')
  }
  const lookup = (node: unknown): 'filter' | 'find' | false => {
    if (
      !object(node) ||
      node['type'] !== 'CallExpression' ||
      !Array.isArray(node['arguments']) ||
      node['arguments'].length !== 1
    )
      return false
    const callee = node['callee'],
      kind = member(callee, 'filter') ? 'filter' : member(callee, 'find') ? 'find' : false
    if (!kind || !object(callee) || !identifier(callee['object'], 'ALL_TOOLS')) return false
    const arrow = node['arguments'][0]
    if (
      !object(arrow) ||
      arrow['type'] !== 'ArrowFunctionExpression' ||
      arrow['async'] === true ||
      !Array.isArray(arrow['params']) ||
      arrow['params'].length !== 1 ||
      !identifier(arrow['params'][0]) ||
      identifier(arrow['params'][0], 'JSON')
    )
      return false
    return predicate(arrow['body'], String(arrow['params'][0]['name'])) === true ? kind : false
  }
  const statementCall = (statement: unknown, name: string): unknown[] | undefined => {
    if (
      !object(statement) ||
      statement['type'] !== 'ExpressionStatement' ||
      !object(statement['expression'])
    )
      return undefined
    const call = statement['expression']
    return call['type'] === 'CallExpression' &&
      identifier(call['callee'], name) &&
      Array.isArray(call['arguments'])
      ? call['arguments']
      : undefined
  }
  const output = (statement: unknown, name?: string, kind?: 'filter' | 'find') => {
    const args = statementCall(statement, 'text')
    if (!args || args.length !== 1) return false
    let value = args[0]
    if (
      object(value) &&
      value['type'] === 'CallExpression' &&
      value['optional'] !== true &&
      object(value['callee']) &&
      value['callee']['optional'] !== true &&
      member(value['callee'], 'stringify') &&
      identifier(value['callee']['object'], 'JSON') &&
      Array.isArray(value['arguments']) &&
      value['arguments'].length === 1
    )
      value = value['arguments'][0]
    return name === undefined
      ? lookup(value) !== false
      : identifier(value, name) ||
          (kind === 'find' &&
            (member(value, 'name') || member(value, 'description')) &&
            identifier(value['object'], name))
  }
  if (body.length === 1) return output(body[0])
  const first = body[0]
  if (
    ![2, 3].includes(body.length) ||
    !object(first) ||
    first['type'] !== 'VariableDeclaration' ||
    first['kind'] !== 'const' ||
    !Array.isArray(first['declarations']) ||
    first['declarations'].length !== 1
  )
    return false
  const declaration = first['declarations'][0]
  if (
    !object(declaration) ||
    !identifier(declaration['id']) ||
    ['ALL_TOOLS', 'text', 'tools', 'exit', 'JSON'].includes(String(declaration['id']['name']))
  )
    return false
  const name = String(declaration['id']['name']),
    kind = lookup(declaration['init'])
  if (!kind || !output(body.at(-1), name, kind)) return false
  if (body.length === 2) return true
  const guard = body[1]
  if (
    kind !== 'find' ||
    !object(guard) ||
    guard['type'] !== 'IfStatement' ||
    guard['alternate'] != null ||
    !object(guard['test']) ||
    guard['test']['type'] !== 'UnaryExpression' ||
    guard['test']['operator'] !== '!' ||
    !identifier(guard['test']['argument'], name) ||
    !object(guard['consequent']) ||
    guard['consequent']['type'] !== 'BlockStatement' ||
    !Array.isArray(guard['consequent']['body']) ||
    guard['consequent']['body'].length !== 2 ||
    (Array.isArray(guard['consequent']['directives']) &&
      guard['consequent']['directives'].length !== 0)
  )
    return false
  const warning = statementCall(guard['consequent']['body'][0], 'text'),
    finish = statementCall(guard['consequent']['body'][1], 'exit')
  return Boolean(
    warning &&
    warning.length === 1 &&
    object(warning[0]) &&
    warning[0]['type'] === 'StringLiteral' &&
    typeof warning[0]['value'] === 'string' &&
    warning[0]['value'].length <= 240 &&
    finish &&
    finish.length === 0,
  )
}

type UsageNumbers = { [key: string]: number | UsageNumbers }
function usageNumbers(value: unknown, depth = 0): UsageNumbers | undefined {
  if (!object(value) || depth > 4) return undefined
  const projected: UsageNumbers = {}
  for (const key of [
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'cached_input_tokens',
    'reasoning_output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'cached_tokens',
    'reasoning_tokens',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cachedInputTokens',
    'total_cost_usd',
    'cost_usd',
  ]) {
    const count = value[key]
    if (
      typeof count === 'number' &&
      Number.isFinite(count) &&
      count >= 0 &&
      (key.endsWith('_usd') || Number.isSafeInteger(count))
    )
      projected[key] = count
  }
  for (const key of [
    'info',
    'usage',
    'token_usage',
    'tokenUsage',
    'total_token_usage',
    'last_token_usage',
    'turn_token_usage',
    'thread_token_usage',
    'input_tokens_details',
    'output_tokens_details',
  ]) {
    const nested = usageNumbers(value[key], depth + 1)
    if (nested) projected[key] = nested
  }
  return Object.keys(projected).length ? projected : undefined
}

/** Decode actual completed Native calls only; quoted prompt/tool-looking text is never a receipt. */
export function inspectRoutingSourceRecords(records: unknown[], expected: ExpectedSource) {
  if (records.length > recordLimit) throw Error('Frozen-source Native records exceed 10000')
  const calls = new Map<string, NativeCall>(),
    outputs = new Map<string, unknown>(),
    outputOrdinals = new Map<string, number>(),
    firstOfferedOrdinals = new Map<string, number>(),
    sourceStarts = new Map<
      string,
      { ordinal: number; readerSha256: string; wrapper: number; completed: boolean } | null
    >(),
    successfulReferenceWitnesses: Array<{
      sha256: string
      ordinal: number | null
      readerSha256: string
    }> = [],
    grants = new Set<string>(),
    readArgumentProofs = new Set<boolean>(),
    outerIds = new Set<string>(),
    wrappers: Array<{
      sha256: string
      bytes: number
      grammar: 'source' | 'metadata' | 'data' | 'rejected' | 'unknown'
      leaves: number
      startOrdinal: number
      completed: boolean
      operations: number
      diagnosticCalls?: NativeCallShapeDiagnostic
      classification:
        | 'pending'
        | 'source_operations'
        | 'metadata_discovery'
        | 'local_data'
        | 'preexecution_syntax_failure'
        | 'unclassified_wrapper'
    }> = [],
    wrapperIds = new Map<string, number>(),
    wrapperDiagnostics: Array<{
      index: number
      startedTurnMatched: boolean
      outputTurnMatched?: boolean
      outputClass?: string
      error?: ReturnType<typeof nativeErrorShape>
    }> = [],
    failedLeaves: Array<{
      ordinal: number
      wrapper: number | null
      sameRoot: boolean
      nameSha256: string
      status: string
      readOnly: boolean
      readerSha256: string
      startObservation: {
        kind: 'native_item_started' | 'wrapper_lower_bound' | 'unavailable'
        ordinal: number | null
      }
      untrustedReferenceClaims: {
        signatureAuthentication: 'not_verified'
        payloadValid: boolean
        source: CollaborationSourceRead['source'] | 'unknown'
        runMatchesCurrent: boolean | null
        grantMatchesCurrent: boolean | null
      } | null
      requestedRunMatched: boolean | null
      requestedGrantMatched: boolean | null
      requestedGrantRelations: ReturnType<typeof grantRelations>
      requestedBatchMatched: boolean | null
      nativeCallSha256: string | null
      nativeCallUnique: boolean
      requestSha256: string | null
      arguments: ReturnType<typeof sourceArgumentShape>
      result: ReturnType<typeof nativeErrorShape>
      error: ReturnType<typeof nativeErrorShape>
    }> = [],
    ledgerReasons = new Set<string>()
  const headers = records.filter(
    (record) =>
      object(record) &&
      record['type'] === 'session_meta' &&
      object(record['payload']) &&
      record['payload']['id'] === expected.nativeSessionId,
  )
  const syntaxVersionVerified =
    headers.length === 1 &&
    object(headers[0]) &&
    object(headers[0]['payload']) &&
    headers[0]['payload']['cli_version'] === '0.163.0'
  const suppliedReferences = new Map<string, CollaborationSourceRead>()
  const suppliedNativeArguments = new Map<
    string,
    {
      requestSha256: string
      documentIdSha256: string | null
      documentSha256: string | null
      firstOfferedOrdinal: number
      canonicalDocument?: CollaborationDocument
      selector?: { part: string; ordinal: number | null }
    }
  >()
  function grantRelations(value: unknown) {
    const supplied = object(value) ? value['grant'] : undefined
    if (typeof supplied !== 'string') return null
    return {
      sha256: digest(supplied),
      utf8Bytes: Buffer.byteLength(supplied),
      matchesRunId: supplied === expected.runId,
      matchesBatchId: supplied === expected.batchId,
      matchesCommentId: supplied === expected.commentId,
      matchesSuppliedDocumentId: [...suppliedReferences.values()].some(
        (read) => read.source === 'document' && read.document?.id === supplied,
      ),
      isNilUuid: supplied === '00000000-0000-0000-0000-000000000000',
      // This current-root snapshot does not establish an earlier root's grant.
      matchesPriorRootGrant: null,
    }
  }
  let frozenBatch: CollaborationInputBatchReference | undefined,
    frozenBatchConsistent = true
  const usageBySource: Record<
    string,
    { recordOrdinal: number; scope: string; values: UsageNumbers }
  > = {}
  const rejectedSourceReads = { document: 0, batch: 0, inputs: 0, handoff_sources: 0, other: 0 }
  let usageTurn: string | undefined,
    usageSeen = false,
    ordinal = 0
  let openWrapper:
      | { id: string; index: number; facts: (typeof wrappers)[number]; startedTurnMatched: boolean }
      | undefined,
    ledgerValid = true,
    rootMatched = false,
    failedLeafCount = 0
  // The existing Native snapshot owns the complete file/records and execScripts.
  // This additional workspace borrows one input, retains only proof metadata,
  // and releases its parsed AST before the next record. No script text is exported.
  const scriptAudit = {
    scripts: 0,
    syntaxVersionVerified,
    totalUtf8Bytes: 0,
    inputUtf8HighWaterBytes: 0,
    borrowedInputUtf16PayloadHighWaterBytes: 0,
    retainedRawScriptBytes: 0,
    diagnosticScriptTextBytes: 0,
    proofMetadataHighWaterBytes: 0,
    parsedAstObjectHighWater: 0,
    parsedAstStringUtf16PayloadHighWaterBytes: 0,
    parsedAstPendingHighWater: 0,
    processHeapUsedBefore: process.memoryUsage().heapUsed,
    processHeapUsedAfterParseHighWater: 0,
  }
  const chargeWrapperMetadata = () => {
    // Only bounded hashes/counters/flags are copied; identities borrow snapshot strings.
    const limit = 64 * 1024
    let size = 0
    const count = (value: unknown): void => {
      if (size > limit) return
      if (typeof value === 'string') size += decisionJsonBytes(value, limit - size)
      else if (typeof value === 'boolean') size += value ? 4 : 5
      else if (typeof value === 'number') size += String(value).length
      else if (value === null) size += 4
      else if (Array.isArray(value) || value instanceof Map) {
        size += 2
        let items = 0
        for (const item of value) {
          if (items++) size++
          count(item)
          if (size > limit) break
        }
      } else if (object(value)) {
        size += 2
        let fields = 0
        for (const [key, item] of Object.entries(value)) {
          if (item === undefined) continue
          if (fields++) size++
          count(key)
          size++
          count(item)
          if (size > limit) break
        }
      } else throw Error('Invalid source script proof metadata')
    }
    // Map entries are visited one at a time. In particular, a long untrusted call ID
    // is counted before any encoded copy is allocated, rather than stringified first.
    count({ wrappers, wrapperDiagnostics, identities: wrapperIds })
    if (size > limit) throw Error('Source script proof metadata exceeds 64 KiB')
    scriptAudit.proofMetadataHighWaterBytes = Math.max(
      scriptAudit.proofMetadataHighWaterBytes,
      size,
    )
  }
  const inspectScript = (input: string) => {
    const bytes = Buffer.byteLength(input)
    if (bytes > 8192) throw Error('Native command arguments exceed 8 KiB')
    scriptAudit.scripts++
    scriptAudit.totalUtf8Bytes += bytes
    scriptAudit.inputUtf8HighWaterBytes = Math.max(scriptAudit.inputUtf8HighWaterBytes, bytes)
    scriptAudit.borrowedInputUtf16PayloadHighWaterBytes = Math.max(
      scriptAudit.borrowedInputUtf16PayloadHighWaterBytes,
      input.length * 2,
    )
    let ast: unknown
    try {
      ast = parseNativeExecScript(input)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      let compileRejected = false
      if (syntaxVersionVerified) {
        try {
          // oxlint-disable-next-line eslint/no-new -- Compilation is the check; never execute the untrusted Script.
          new Script(`(async () => {\n${input}\n})`)
        } catch (compileError) {
          if (compileError instanceof SyntaxError) compileRejected = true
          else throw compileError
        }
      }
      return {
        sha256: digest(input),
        bytes,
        grammar: compileRejected ? ('rejected' as const) : ('unknown' as const),
      }
    }
    const diagnosticCalls: NativeCallShapeDiagnostic | undefined =
      wrappers.length < 8
        ? { shapes: [], readerHashes: [], omittedReaderOccurrences: 0 }
        : undefined
    {
      // Babel has already constructed this AST. These samples/thresholds describe
      // returned AST acceptance, never a bound on the parser's allocation peak.
      scriptAudit.processHeapUsedAfterParseHighWater = Math.max(
        scriptAudit.processHeapUsedAfterParseHighWater,
        process.memoryUsage().heapUsed,
      )
      const pending: unknown[] = [ast]
      let objects = 0,
        stringBytes = 0
      while (pending.length) {
        scriptAudit.parsedAstPendingHighWater = Math.max(
          scriptAudit.parsedAstPendingHighWater,
          pending.length,
        )
        const value = pending.pop()
        if (typeof value === 'string') stringBytes += value.length * 2
        else if (value !== null && typeof value === 'object') {
          if (++objects > 10_000) throw Error('Native exec script exceeds its structural bound')
          if (diagnosticCalls && object(value) && value['type'] === 'CallExpression') {
            const callee = value['callee']
            let shape = 'local_or_other'
            if (object(callee) && callee['type'] === 'MemberExpression') {
              const target = callee['object'],
                property = callee['property'],
                name =
                  object(property) &&
                  ((callee['computed'] !== true && property['type'] === 'Identifier') ||
                    (callee['computed'] === true && property['type'] === 'StringLiteral'))
                    ? (property['name'] ?? property['value'])
                    : undefined
              if (object(target) && target['type'] === 'Identifier') {
                if (target['name'] === 'JSON' && name === 'parse') shape = 'json_parse'
                if (target['name'] === 'tools') {
                  shape =
                    name === undefined
                      ? 'computed_tools'
                      : name === 'read_collaboration_source'
                        ? 'unqualified_reader'
                        : name === 'get' || name === 'list'
                          ? 'lookup'
                          : 'other_tools'
                  if (
                    typeof name === 'string' &&
                    name.startsWith('mcp__') &&
                    sourceTool.test(name)
                  ) {
                    shape = 'qualified_reader'
                    const hash = digest(name)
                    if (!diagnosticCalls.readerHashes.includes(hash)) {
                      if (diagnosticCalls.readerHashes.length < 4)
                        diagnosticCalls.readerHashes.push(hash)
                      else diagnosticCalls.omittedReaderOccurrences++
                    }
                  }
                }
              }
            }
            if (!diagnosticCalls.shapes.includes(shape)) diagnosticCalls.shapes.push(shape)
          }
          pending.push(...Object.values(value))
        }
        if (pending.length > 10_000 || stringBytes > 512 * 1024)
          throw Error('Native exec parse workspace exceeds its bound')
      }
      scriptAudit.parsedAstObjectHighWater = Math.max(scriptAudit.parsedAstObjectHighWater, objects)
      scriptAudit.parsedAstStringUtf16PayloadHighWaterBytes = Math.max(
        scriptAudit.parsedAstStringUtf16PayloadHighWaterBytes,
        stringBytes,
      )
    }
    return {
      sha256: digest(input),
      bytes,
      ...(diagnosticCalls ? { diagnosticCalls } : {}),
      grammar: pureLocalData(ast)
        ? ('data' as const)
        : sourceToolDiscovery(ast)
          ? ('metadata' as const)
          : ('source' as const),
    }
  }
  const invalidate = (reason: string) => {
    ledgerValid = false
    ledgerReasons.add(reason)
  }
  const rememberReference = (
    raw: unknown,
    target: Omit<CollaborationSourceRead, 'runId' | 'grant' | 'offset'>,
    grant: string,
    validateLegacy = false,
    observedAt?: number,
  ) => {
    if (raw === undefined) return
    const referenceForm = object(raw) && Object.hasOwn(raw, 'sourceReference')
    const nativeForm = object(raw) && Object.hasOwn(raw, 'context')
    if (!referenceForm && !nativeForm && !validateLegacy) return
    const legacy =
      referenceForm || nativeForm ? undefined : collaborationSourceReadSchema.safeParse(raw)
    const decoded = nativeForm
      ? nativeSelection(raw, expected, grant, suppliedNativeArguments)
      : referenceForm
        ? referenceRequest(raw, expected, grant)
        : legacy?.success
          ? legacy.data
          : undefined
    const wanted = collaborationSourceReadSchema.safeParse({
      ...target,
      runId: expected.runId,
      grant,
      offset: object(raw) ? raw['offset'] : 0,
    })
    if (!decoded || !wanted.success || JSON.stringify(decoded) !== JSON.stringify(wanted.data)) {
      invalidate('supplied_reference_binding')
      return
    }
    if (nativeForm && observedAt !== undefined) {
      const normalized = collaborationSourceNativeReadSchema.parse(raw),
        hash = digest(JSON.stringify(normalized)),
        prior = suppliedNativeArguments.get(hash)
      suppliedNativeArguments.set(hash, {
        requestSha256: hash,
        documentIdSha256: normalized.document ? digest(normalized.document.id) : null,
        documentSha256: normalized.document?.sha256 ?? null,
        firstOfferedOrdinal: Math.min(prior?.firstOfferedOrdinal ?? observedAt, observedAt),
        ...(prior?.canonicalDocument ? { canonicalDocument: prior.canonicalDocument } : {}),
        ...(normalized.source === 'root_document'
          ? { selector: { part: normalized.part!, ordinal: normalized.ordinal ?? null } }
          : {}),
      })
      if (suppliedNativeArguments.size > 256)
        throw Error('Supplied native Source arguments exceed256')
    }
    if (referenceForm) {
      const supplied = collaborationSourceReferenceReadSchema.parse(raw)
      suppliedReferences.set(supplied.sourceReference, { ...decoded, offset: 0 })
      if (suppliedReferences.size > 256) throw Error('Supplied frozen-source references exceed 256')
      if (observedAt !== undefined) {
        const hash = digest(supplied.sourceReference),
          previous = firstOfferedOrdinals.get(hash)
        firstOfferedOrdinals.set(hash, Math.min(previous ?? observedAt, observedAt))
      }
    }
  }
  const rememberPageReferences = (
    page: CollaborationSourceReadResult,
    grant: string,
    observedAt?: number,
    authenticatedNative = false,
  ) => {
    const documentRead = (
      document: unknown,
      read: unknown,
      part?: string,
      memberOrdinal?: number,
    ) => {
      const parsedDocument = collaborationDocumentSchema.safeParse(document)
      if (parsedDocument.success) {
        if (authenticatedNative && part) {
          const selector = collaborationSourceNativeReadSchema.safeParse(read)
          if (selector.success && selector.data.source === 'root_document') {
            if (
              selector.data.part !== part ||
              selector.data.ordinal !== memberOrdinal ||
              selector.data.offset !== 0
            ) {
              invalidate('native_root_document_identity')
              return
            }
            const key = digest(JSON.stringify(selector.data)),
              prior = suppliedNativeArguments.get(key)
            if (
              prior?.canonicalDocument &&
              JSON.stringify(prior.canonicalDocument) !== JSON.stringify(parsedDocument.data)
            ) {
              invalidate('native_root_document_identity')
              return
            }
            suppliedNativeArguments.set(key, {
              requestSha256: key,
              documentIdSha256: null,
              documentSha256: null,
              firstOfferedOrdinal: Math.min(
                prior?.firstOfferedOrdinal ?? observedAt ?? 0,
                observedAt ?? 0,
              ),
              canonicalDocument: parsedDocument.data,
              selector: { part, ordinal: memberOrdinal ?? null },
            })
            if (suppliedNativeArguments.size > 256)
              throw Error('Supplied native Source arguments exceed256')
          }
        }
        rememberReference(
          read,
          { source: 'document', document: parsedDocument.data },
          grant,
          true,
          observedAt,
        )
      }
    }
    const next = Reflect.get(page, 'nextRead')
    if (object(next) && Object.hasOwn(next, 'context')) {
      const selection = nativeSelection(next, expected, grant, suppliedNativeArguments)
      if (selection)
        rememberReference(
          next,
          {
            source: selection.source,
            ...(selection.document ? { document: selection.document } : {}),
            ...(selection.batchId ? { batchId: selection.batchId } : {}),
          },
          grant,
          true,
          observedAt,
        )
    }
    if (page.source === 'document') return
    const index = parsed(page.text)
    if (!object(index)) return
    if (page.source === 'batch') {
      const current = object(index['batch']) && index['batch']['id'] === expected.batchId
      documentRead(index['body'], index['bodyRead'], current ? 'body' : undefined)
      documentRead(
        index['userInformation'],
        index['userInformationRead'],
        current ? 'user_information' : undefined,
      )
      documentRead(
        index['clarificationAnswer'],
        index['clarificationAnswerRead'],
        current ? 'clarification_answer' : undefined,
      )
      if (Array.isArray(index['members']))
        for (const member of index['members'].slice(0, 24))
          if (object(member))
            documentRead(
              member['body'],
              member['bodyRead'],
              current && Number.isSafeInteger(member['ordinal']) && Number(member['ordinal']) >= 0
                ? 'comment'
                : undefined,
              typeof member['ordinal'] === 'number' ? member['ordinal'] : undefined,
            )
      return
    }
    if (!Array.isArray(index['items'])) return
    for (const item of index['items'].slice(0, 24)) {
      if (!object(item)) continue
      const batch = page.source === 'inputs' ? item['batch'] : item['inputBatchRef']
      if (object(batch) && typeof batch['id'] === 'string')
        rememberReference(
          item['batchRead'],
          { source: 'batch', batchId: batch['id'] },
          grant,
          true,
          observedAt,
        )
      if (page.source === 'inputs') documentRead(item['body'], item['bodyRead'])
      else if (Array.isArray(item['documents']))
        for (const entry of item['documents'].slice(0, 24))
          if (object(entry)) documentRead(entry['source'], entry['read'])
    }
  }
  const outer = (id: string) => {
    if (outerIds.has(id)) throw Error('A Native outer tool call identity was repeated')
    outerIds.add(id)
    if (outerIds.size > 256)
      throw Error('Native task settings or command observation exceeded its bound')
  }
  const add = (call: NativeCall, isOuter = true) => {
    const previous = calls.get(call.id)
    if (previous) throw Error('A Native tool call identity was repeated')
    if (isOuter) outer(call.id)
    call.observedAt = ordinal
    calls.set(call.id, call)
    if (call.output !== undefined) outputOrdinals.set(call.id, ordinal)
    if (outputOrdinals.size > 256) throw Error('Source output diagnostics exceed 256')
    if (calls.size > 256) throw Error('Frozen-source Native tools exceed 256')
  }
  const recordOutput = (id: string, value: unknown) => {
    if (outputs.has(id)) throw Error('A Native tool output identity was repeated')
    outputs.set(id, value)
    outputOrdinals.set(id, ordinal)
    if (outputOrdinals.size > 256) throw Error('Source output diagnostics exceed 256')
    if (outputs.size > 256) throw Error('Frozen-source Native outputs exceed 256')
  }
  const rootTexts = (content: unknown) => {
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content : []
    if (texts.length > recordLimit) throw Error('Native input text exceeds its structural bound')
    for (const part of texts) {
      const text = object(part) ? part['text'] : part
      const grant = currentGrant(text, expected)
      if (grant) {
        grants.add(grant)
        const proof = currentReadArguments(text, expected, grant)
        if (proof !== undefined) readArgumentProofs.add(proof)
        if (typeof text === 'string') {
          const start = text.indexOf('Pact context (JSON reference data;')
          const context = parsed(text.slice(text.indexOf('\n', start) + 1).trim())
          if (object(context)) {
            const batch = collaborationInputBatchReferenceSchema.safeParse(context['inputBatchRef'])
            if (
              !batch.success ||
              (frozenBatch && JSON.stringify(frozenBatch) !== JSON.stringify(batch.data))
            ) {
              frozenBatchConsistent = false
              invalidate('root_batch_identity')
            } else frozenBatch = batch.data
            rememberReference(
              context['sourceReadArguments'],
              { source: 'batch', batchId: expected.batchId },
              grant,
              false,
              ordinal,
            )
            if (Array.isArray(context['sourceNavigation'])) {
              if (context['sourceNavigation'].length > 256)
                throw Error('Root source navigation exceeds 256')
              for (const navigation of context['sourceNavigation']) {
                if (!object(navigation)) continue
                const document = collaborationDocumentSchema.safeParse(navigation['document'])
                if (navigation['kind'] === 'document' && document.success)
                  rememberReference(
                    navigation['read'],
                    { source: 'document', document: document.data },
                    grant,
                    false,
                    ordinal,
                  )
                else if (navigation['kind'] === 'workflow_inputs')
                  rememberReference(navigation['read'], { source: 'inputs' }, grant, false, ordinal)
                else if (navigation['kind'] === 'handoff_sources')
                  rememberReference(
                    navigation['read'],
                    { source: 'handoff_sources' },
                    grant,
                    false,
                    ordinal,
                  )
              }
            }
          }
        }
      }
    }
  }
  for (const record of records) {
    ordinal += 1
    if (!object(record)) throw Error('Malformed frozen-source Native record')
    const message = record['message']
    if (
      record['type'] === 'assistant' &&
      record['isSidechain'] !== true &&
      object(message) &&
      (record['sessionId'] === undefined || record['sessionId'] === expected.nativeSessionId) &&
      object(message['usage'])
    ) {
      usageSeen = true
      const values = usageNumbers(message['usage'])
      if (values)
        usageBySource['claude.assistant.usage'] = {
          recordOrdinal: ordinal,
          scope: 'latest root assistant message; native fields, not summed',
          values,
        }
    }
    if (record['type'] === 'user' && record['isSidechain'] !== true && object(message)) {
      rootTexts(message['content'])
      if (Array.isArray(message['content']))
        for (const item of message['content'])
          if (
            object(item) &&
            item['type'] === 'tool_result' &&
            typeof item['tool_use_id'] === 'string'
          )
            recordOutput(
              item['tool_use_id'],
              item['is_error'] === true ? undefined : item['content'],
            )
    }
    if (record['type'] === 'assistant' && object(message) && Array.isArray(message['content']))
      for (const item of message['content'])
        if (
          object(item) &&
          item['type'] === 'tool_use' &&
          typeof item['id'] === 'string' &&
          typeof item['name'] === 'string'
        )
          add({ id: item['id'], name: item['name'], input: item['input'] })
    const payload = record['payload']
    if (openWrapper && record['type'] === 'event_msg' && object(payload)) {
      const kind = payload['type'],
        item = payload['item']
      if (kind === 'item_started' || kind === 'item_completed') {
        if (
          !object(item) ||
          !['Reasoning', 'AgentMessage', 'UserMessage'].includes(String(item['type']))
        ) {
          openWrapper.facts.operations++
        }
      } else if (
        ![
          'token_count',
          'agent_message',
          'agent_reasoning',
          'agent_reasoning_raw_content',
          'agent_reasoning_section_break',
        ].includes(String(kind))
      ) {
        openWrapper.facts.operations++
        invalidate('unknown_wrapper_event')
      }
    }
    if (
      openWrapper &&
      record['type'] === 'response_item' &&
      object(payload) &&
      ['function_call', 'custom_tool_call', 'mcp_tool_call'].includes(String(payload['type']))
    )
      openWrapper.facts.operations++

    if (
      record['type'] === 'turn_context' &&
      object(payload) &&
      typeof payload['turn_id'] === 'string'
    )
      usageTurn = payload['turn_id']
    if (
      record['type'] === 'token_usage_record' ||
      (record['type'] === 'event_msg' && object(payload) && payload['type'] === 'token_count')
    ) {
      usageSeen = true
      const usage = object(payload) ? payload : record,
        values = usageNumbers(usage),
        explicitScopeMatches = [record, usage].every(
          (source) =>
            (!Object.hasOwn(source, 'turn_id') || source['turn_id'] === expected.nativeTurnId) &&
            (!Object.hasOwn(source, 'thread_id') ||
              source['thread_id'] === expected.nativeSessionId),
        )
      if (
        values &&
        explicitScopeMatches &&
        usageTurn !== undefined &&
        usageTurn === expected.nativeTurnId
      )
        usageBySource[
          `codex.${record['type'] === 'token_usage_record' ? 'token_usage_record' : 'event_msg.token_count'}`
        ] = {
          recordOrdinal: ordinal,
          scope:
            'latest record under current native turn context; original cumulative/per-request fields, not summed',
          values,
        }
    }
    if (record['type'] === 'event_msg' && object(payload) && payload['type'] === 'item_started') {
      const item = payload['item'],
        sameRoot =
          expected.nativeSessionId !== undefined &&
          expected.nativeTurnId !== undefined &&
          payload['thread_id'] === expected.nativeSessionId &&
          payload['turn_id'] === expected.nativeTurnId
      if (!object(item)) invalidate('malformed_started_item')
      else if (!sameRoot) invalidate('started_item_scope')
      else if (['Reasoning', 'AgentMessage', 'UserMessage'].includes(String(item['type']))) {
        // These native display items do not perform a tool operation.
      } else if (
        !openWrapper ||
        item['type'] !== 'McpToolCall' ||
        typeof item['id'] !== 'string' ||
        typeof item['server'] !== 'string' ||
        typeof item['tool'] !== 'string' ||
        !isRoutingSourceTool(`mcp__${item['server']}__${item['tool']}`)
      )
        invalidate('unknown_started_operation')
      if (
        object(item) &&
        item['type'] === 'McpToolCall' &&
        typeof item['id'] === 'string' &&
        typeof item['server'] === 'string' &&
        typeof item['tool'] === 'string' &&
        sameRoot &&
        openWrapper &&
        isRoutingSourceTool(`mcp__${item['server']}__${item['tool']}`)
      ) {
        sourceStarts.set(
          item['id'],
          sourceStarts.has(item['id'])
            ? null
            : {
                ordinal,
                readerSha256: digest(`mcp__${item['server']}__${item['tool']}`),
                wrapper: openWrapper.index,
                completed: false,
              },
        )
        if (sourceStarts.size > 256) throw Error('Source start diagnostics exceed 256')
      }
    }
    if (record['type'] === 'event_msg' && object(payload) && payload['type'] === 'item_completed') {
      if (!object(payload['item'])) {
        invalidate('malformed_completed_item')
        continue
      }
      const item = payload['item'],
        sameRoot =
          expected.nativeSessionId !== undefined &&
          expected.nativeTurnId !== undefined &&
          payload['thread_id'] === expected.nativeSessionId &&
          payload['turn_id'] === expected.nativeTurnId
      if (!sameRoot) invalidate('completed_item_scope')
      if (item['type'] === 'UserMessage') {
        const content = item['content']
        if (
          sameRoot &&
          Array.isArray(content) &&
          content.some((part) => object(part) && currentGrant(part['text'], expected))
        ) {
          rootMatched = true
          usageTurn = expected.nativeTurnId
        }
      } else if (item['type'] === 'McpToolCall') {
        if (typeof item['id'] === 'string' && sourceStarts.has(item['id'])) {
          const start = sourceStarts.get(item['id'])
          if (
            !start ||
            start.completed ||
            !sameRoot ||
            start.wrapper !== openWrapper?.index ||
            start.readerSha256 !== digest(`mcp__${String(item['server'])}__${String(item['tool'])}`)
          )
            invalidate('contradictory_source_start')
          else start.completed = true
        }

        const sourceRejected =
          typeof item['server'] === 'string' &&
          typeof item['tool'] === 'string' &&
          isRoutingSourceTool(`mcp__${item['server']}__${item['tool']}`) &&
          definiteSourceRefusal(item['result'])
        if (
          sameRoot &&
          typeof item['server'] === 'string' &&
          typeof item['tool'] === 'string' &&
          isRoutingSourceTool(`mcp__${item['server']}__${item['tool']}`) &&
          (item['status'] !== 'completed' ||
            !object(item['result']) ||
            item['result']['isError'] === true)
        ) {
          const request = collaborationSourceReadSchema.safeParse(item['arguments'])
          rejectedSourceReads[request.success ? request.data.source : 'other'] += 1
        }
        if (
          !sameRoot ||
          !openWrapper ||
          item['status'] !== 'completed' ||
          item['readOnlyHint'] !== true ||
          typeof item['id'] !== 'string' ||
          typeof item['server'] !== 'string' ||
          typeof item['tool'] !== 'string' ||
          !object(item['result']) ||
          (item['result']['isError'] === true && !sourceRejected)
        ) {
          invalidate('mcp_leaf_boundary')
          failedLeafCount += 1
          const readerSha256 = digest(`mcp__${String(item['server'])}__${String(item['tool'])}`),
            start = typeof item['id'] === 'string' ? sourceStarts.get(item['id']) : undefined,
            started = sameRoot && start?.readerSha256 === readerSha256 ? start : undefined,
            claimed = untrustedReferenceRequest(item['arguments']),
            nativeCallIdentity = sourceReadCallIdentity(
              payload['thread_id'],
              payload['turn_id'],
              item['id'],
            ),
            nativeArguments = collaborationSourceNativeReadSchema.safeParse(item['arguments'])
          if (failedLeaves.length < 4)
            failedLeaves.push({
              ordinal,
              wrapper: openWrapper ? openWrapper.index : null,
              sameRoot,
              nativeCallSha256: nativeCallIdentity ? digest(nativeCallIdentity) : null,
              nativeCallUnique: Boolean(
                nativeCallIdentity &&
                records.filter((entry) => {
                  if (!object(entry) || entry['type'] !== 'event_msg' || !object(entry['payload']))
                    return false
                  const candidate = entry['payload']
                  return (
                    candidate['type'] === 'item_completed' &&
                    candidate['thread_id'] === payload['thread_id'] &&
                    candidate['turn_id'] === payload['turn_id'] &&
                    object(candidate['item']) &&
                    candidate['item']['type'] === 'McpToolCall' &&
                    candidate['item']['id'] === item['id']
                  )
                }).length === 1,
              ),
              requestSha256: nativeArguments.success
                ? digest(JSON.stringify(nativeArguments.data))
                : null,
              nameSha256: digest(`${String(item['server'])}/${String(item['tool'])}`),
              status: ['completed', 'failed'].includes(String(item['status']))
                ? String(item['status'])
                : 'other',
              readOnly: item['readOnlyHint'] === true,
              readerSha256,
              startObservation: started
                ? { kind: 'native_item_started', ordinal: started.ordinal }
                : sameRoot && openWrapper?.startedTurnMatched
                  ? { kind: 'wrapper_lower_bound', ordinal: openWrapper.facts.startOrdinal }
                  : { kind: 'unavailable', ordinal: null },
              untrustedReferenceClaims:
                object(item['arguments']) && Object.hasOwn(item['arguments'], 'sourceReference')
                  ? {
                      signatureAuthentication: 'not_verified',
                      payloadValid: claimed !== undefined,
                      source: claimed?.source ?? 'unknown',
                      runMatchesCurrent: claimed ? claimed.runId === expected.runId : null,
                      grantMatchesCurrent:
                        claimed && grants.size === 1 ? claimed.grant === [...grants][0] : null,
                    }
                  : null,
              requestedRunMatched:
                object(item['arguments']) && Object.hasOwn(item['arguments'], 'runId')
                  ? item['arguments']['runId'] === expected.runId
                  : null,
              requestedGrantMatched:
                object(item['arguments']) &&
                Object.hasOwn(item['arguments'], 'grant') &&
                grants.size === 1
                  ? item['arguments']['grant'] === [...grants][0]
                  : null,
              requestedGrantRelations: grantRelations(item['arguments']),
              requestedBatchMatched:
                object(item['arguments']) && typeof item['arguments']['batchId'] === 'string'
                  ? item['arguments']['batchId'] === expected.batchId
                  : null,
              arguments: sourceArgumentShape(item['arguments']),
              result: nativeErrorShape(item['result']),
              error: nativeErrorShape(item['error'], item['status'] === 'failed'),
            })
          continue
        }
        add(
          {
            id: `code-mode:${item['id']}`,
            name: `mcp__${item['server']}__${item['tool']}`,
            input: item['arguments'],
            output: item['result'],
            nativeRootObserved: true,
            ...(sourceRejected ? { sourceRejected: true as const } : {}),
          },
          false,
        )
        openWrapper.facts.leaves += 1
        chargeWrapperMetadata()
      } else if (!['AgentMessage', 'Reasoning'].includes(String(item['type']))) {
        // Includes failed/caught CommandExecution and every unknown operation type.
        invalidate('unknown_completed_operation')
      }
      continue
    }
    if (record['type'] !== 'response_item') continue
    if (
      !object(payload) ||
      ![
        'message',
        'reasoning',
        'function_call',
        'custom_tool_call',
        'function_call_output',
        'custom_tool_call_output',
        'mcp_tool_call',
      ].includes(String(payload['type']))
    ) {
      invalidate('unknown_response_item')
      continue
    }
    if (
      (['function_call', 'custom_tool_call'].includes(String(payload['type'])) &&
        (typeof payload['call_id'] !== 'string' ||
          typeof payload['name'] !== 'string' ||
          (Object.hasOwn(payload, 'namespace') && typeof payload['namespace'] !== 'string'))) ||
      (['function_call_output', 'custom_tool_call_output'].includes(String(payload['type'])) &&
        typeof payload['call_id'] !== 'string') ||
      (payload['type'] === 'mcp_tool_call' &&
        (typeof payload['id'] !== 'string' ||
          typeof payload['server'] !== 'string' ||
          typeof payload['tool'] !== 'string'))
    )
      invalidate('malformed_response_item')
    if (payload['type'] === 'message' && payload['role'] === 'user') rootTexts(payload['content'])
    const metadata = payload['internal_chat_message_metadata_passthrough'],
      sameTurn =
        expected.nativeTurnId !== undefined &&
        object(metadata) &&
        metadata['turn_id'] === expected.nativeTurnId
    if (
      payload['type'] === 'custom_tool_call' &&
      payload['name'] === 'exec' &&
      (payload['namespace'] === 'functions' || !Object.hasOwn(payload, 'namespace')) &&
      typeof payload['call_id'] === 'string' &&
      typeof payload['input'] === 'string'
    ) {
      outer(payload['call_id'])
      if (openWrapper || !sameTurn) invalidate('wrapper_start_boundary')
      const script = inspectScript(payload['input'])
      const wrapper = {
        ...script,
        leaves: 0,
        startOrdinal: ordinal,
        completed: false,
        operations: 0,
        classification: 'pending' as const,
      }
      const index = wrappers.length
      wrappers.push(wrapper)
      wrapperIds.set(payload['call_id'], index)
      if (index < 8) wrapperDiagnostics.push({ index, startedTurnMatched: sameTurn })
      chargeWrapperMetadata()
      openWrapper = { id: payload['call_id'], index, facts: wrapper, startedTurnMatched: sameTurn }
      continue
    }
    if (
      payload['type'] === 'custom_tool_call_output' &&
      typeof payload['call_id'] === 'string' &&
      wrapperIds.has(payload['call_id'])
    ) {
      const output = payload['output'],
        head = Array.isArray(output) ? output[0] : undefined
      const diagnostic = openWrapper ? wrapperDiagnostics[openWrapper.index] : undefined
      if (diagnostic) {
        diagnostic.outputTurnMatched = sameTurn
        const text = object(head) && typeof head['text'] === 'string' ? head['text'] : ''
        diagnostic.outputClass = text.startsWith('Script completed\n')
          ? 'completed'
          : text.startsWith('Script failed')
            ? 'failed'
            : 'other'
        const tail = Array.isArray(output) ? output.at(-1) : undefined,
          scriptError =
            diagnostic.outputClass === 'failed' &&
            object(tail) &&
            tail['type'] === 'input_text' &&
            typeof tail['text'] === 'string' &&
            /^Script error:\r?\n/u.test(tail['text'])
              ? tail['text']
              : ''
        diagnostic.error = {
          ...nativeErrorShape({ message: scriptError }),
          contentCount: Array.isArray(output) ? Math.min(Math.max(output.length - 1, 0), 4) : 0,
        }
      }
      if (
        !openWrapper ||
        openWrapper.id !== payload['call_id'] ||
        !sameTurn ||
        !object(head) ||
        head['type'] !== 'input_text' ||
        typeof head['text'] !== 'string'
      )
        invalidate('wrapper_output_boundary')
      else {
        const wrapper = openWrapper.facts,
          text = head['text'],
          completed = text.startsWith('Script completed\n'),
          failed = text.startsWith('Script failed\n')
        wrapper.completed = completed
        const noPrefixOutput =
          Array.isArray(output) &&
          output.length === 2 &&
          /^Script failed\nWall time[^\r\n]{1,120}\nOutput:\n$/u.test(text) &&
          object(output[1]) &&
          output[1]['type'] === 'input_text' &&
          typeof output[1]['text'] === 'string' &&
          /^Script error:(?:\r?\n)+(?:SyntaxError:)/u.test(output[1]['text'])
        wrapper.classification =
          completed && wrapper.leaves > 0 && wrapper.grammar === 'source'
            ? 'source_operations'
            : wrapper.operations === 0 && wrapper.grammar === 'data' && (completed || failed)
              ? 'local_data'
              : wrapper.operations === 0 && completed && wrapper.grammar === 'metadata'
                ? 'metadata_discovery'
                : wrapper.operations === 0 &&
                    wrapper.grammar === 'rejected' &&
                    failed &&
                    noPrefixOutput
                  ? 'preexecution_syntax_failure'
                  : 'unclassified_wrapper'
        if (wrapper.classification === 'unclassified_wrapper') invalidate('wrapper_output_boundary')
      }
      chargeWrapperMetadata()
      openWrapper = undefined
      continue
    }
    if (
      ['function_call', 'custom_tool_call'].includes(String(payload['type'])) &&
      typeof payload['call_id'] === 'string' &&
      typeof payload['name'] === 'string'
    )
      add({
        id: payload['call_id'],
        name: `${String(payload['type'])}:${
          typeof payload['namespace'] === 'string' ? `${payload['namespace']}__` : ''
        }${payload['name']}`,
        input: parsed(payload['arguments'] ?? payload['input']),
      })
    if (
      ['function_call_output', 'custom_tool_call_output'].includes(String(payload['type'])) &&
      typeof payload['call_id'] === 'string'
    )
      recordOutput(payload['call_id'], payload['output'])
    if (
      payload['type'] === 'mcp_tool_call' &&
      typeof payload['id'] === 'string' &&
      typeof payload['server'] === 'string' &&
      typeof payload['tool'] === 'string'
    )
      add({
        id: payload['id'],
        name: `mcp__${payload['server']}__${payload['tool']}`,
        input: parsed(payload['arguments']),
        output: payload['result'],
      })
  }
  if ([...sourceStarts.values()].some((start) => !start || !start.completed))
    invalidate('unclosed_source_operation')
  const allowed = [...calls.values()].filter((call) => isRoutingSourceTool(call.name)),
    grant = grants.size === 1 ? [...grants][0] : undefined,
    receipts: SourceReceipt[] = []
  if ([...outputs.keys()].some((id) => !calls.has(id))) invalidate('unmatched_tool_output')
  const successful = allowed.filter((call) => !call.sourceRejected)
  let matched = successful.length > 0 && grant !== undefined
  const resolvedRequests = new Map<string, CollaborationSourceRead>()
  const submittedForms = { legacy: 0, sourceReference: 0, nativeRoot: 0 }
  for (const call of successful) {
    const reference = collaborationSourceReferenceReadSchema.safeParse(call.input)
    const legacy = collaborationSourceReadSchema.safeParse(call.input)
    const native = collaborationSourceNativeReadSchema.safeParse(call.input)
    const page = resultPage(call.output ?? outputs.get(call.id))
    const supplied = reference.success
      ? suppliedReferences.get(reference.data.sourceReference)
      : undefined
    const request =
      native.success && grant
        ? nativeSelection(call.input, expected, grant, suppliedNativeArguments)
        : reference.success && supplied
          ? { ...supplied, offset: reference.data.offset }
          : legacy.success
            ? legacy.data
            : undefined
    const submitted = native.success
      ? 'nativeRoot'
      : reference.success
        ? 'sourceReference'
        : 'legacy'
    if (request) resolvedRequests.set(call.id, request)
    const binding = page && 'binding' in page ? page.binding : undefined
    if (
      object(call.input) &&
      call.input['context'] === 'native-root-v1' &&
      call.input['source'] === 'root_document' &&
      (!native.success ||
        !request ||
        !page ||
        JSON.stringify(page.document) !== JSON.stringify(request.document))
    ) {
      invalidate('native_root_document_target')
      matched = false
      continue
    }
    if (native.success) {
      const output = parsed(call.output ?? outputs.get(call.id)),
        meta = object(output) ? output['_meta'] : undefined,
        proof = collaborationSourceNativeProofSchema.safeParse(
          object(meta) ? meta['pactSourceRoot'] : undefined,
        )
      if (
        !call.nativeRootObserved ||
        !proof.success ||
        !page ||
        !binding ||
        !grant ||
        !expected.nativeSessionId ||
        !expected.nativeTurnId ||
        binding.submitted !== 'nativeRoot' ||
        binding.nativeRoot?.threadId !== expected.nativeSessionId ||
        binding.nativeRoot.turnId !== expected.nativeTurnId ||
        proof.data.root.threadId !== expected.nativeSessionId ||
        proof.data.root.turnId !== expected.nativeTurnId ||
        proof.data.callerRunId !== expected.runId ||
        proof.data.grantSha256 !== digest(grant) ||
        proof.data.requestSha256 !== digest(JSON.stringify(native.data)) ||
        proof.data.pageSha256 !== digest(JSON.stringify(page))
      ) {
        invalidate('native_source_root_binding')
        matched = false
        continue
      }
      if (native.data.source === 'root_document') {
        const nextRead = 'nextRead' in page ? page.nextRead : undefined,
          next = collaborationSourceNativeReadSchema.safeParse(nextRead)
        if (
          page.nextOffset === null
            ? nextRead !== undefined
            : !next.success ||
              JSON.stringify(next.data) !==
                JSON.stringify({ ...native.data, offset: page.nextOffset })
        ) {
          invalidate('native_root_document_navigation')
          matched = false
          continue
        }
      }
      if (native.data.source === 'root_batch') {
        const index = parsed(page.text)
        if (
          !object(index) ||
          !object(index['batch']) ||
          index['batch']['id'] !== expected.batchId
        ) {
          invalidate('native_root_batch_target')
          matched = false
          continue
        }
        const nextRead = 'nextRead' in page ? page.nextRead : undefined,
          next = collaborationSourceNativeReadSchema.safeParse(nextRead)
        if (
          page.nextOffset === null
            ? nextRead !== undefined
            : !next.success ||
              next.data.source !== 'root_batch' ||
              next.data.offset !== page.nextOffset
        ) {
          invalidate('native_root_batch_navigation')
          matched = false
          continue
        }
      }
    }

    if (
      !request ||
      !page ||
      request.runId !== expected.runId ||
      request.grant !== grant ||
      (reference.success &&
        (!supplied ||
          !binding ||
          binding.submitted !== 'sourceReference' ||
          binding.referenceSha256 !== digest(reference.data.sourceReference))) ||
      (binding &&
        (binding.submitted !== submitted ||
          binding.callerRunId !== expected.runId ||
          binding.grantSha256 !== digest(grant) ||
          (submitted !== 'sourceReference' && binding.referenceSha256 !== null))) ||
      page.source !== request.source ||
      page.offset !== request.offset ||
      (page.source === 'document' &&
        JSON.stringify(page.document) !== JSON.stringify(request.document))
    ) {
      matched = false
      continue
    }
    if (grant) {
      const observedAt = outputOrdinals.get(call.id)
      rememberPageReferences(page, grant, observedAt, native.success)
      if ('nextRead' in page && page.nextRead) {
        if (page.nextOffset === null || page.nextRead.offset !== page.nextOffset)
          invalidate('source_next_navigation')
        else rememberReference(page.nextRead, request, grant, true, observedAt)
      }
    }
    if (reference.success)
      successfulReferenceWitnesses.push({
        sha256: digest(reference.data.sourceReference),
        ordinal: outputOrdinals.get(call.id) ?? null,
        readerSha256: digest(canonicalReader(call.name)),
      })
    submittedForms[submitted]++
    receipts.push({ request, page, reader: canonicalReader(call.name), submitted })
  }
  const readers = new Set(receipts.map((receipt) => receipt.reader))
  const sourceRejections = allowed
    .filter((call) => call.sourceRejected)
    .map((call) => {
      const request = parsed(call.input)
      return {
        nativeCallSha256: digest(call.id),
        readerSha256: digest(canonicalReader(call.name)),
        readerBoundToSuccessfulSource:
          readers.size === 1 && readers.has(canonicalReader(call.name)),
        nativeStatus: 'completed' as const,
        outcome: 'capability_refused_before_source_read' as const,
        requestedRunMatched:
          object(request) && Object.hasOwn(request, 'runId')
            ? request['runId'] === expected.runId
            : null,
        requestedGrantMatched:
          object(request) && Object.hasOwn(request, 'grant') ? request['grant'] === grant : null,
      }
    })
  const batchReceipts = receipts.filter(
    ({ request }) =>
      request.source === 'batch' &&
      (request.batchId === undefined || request.batchId === expected.batchId),
  )
  const batch =
    frozenBatch && frozenBatchConsistent
      ? assembleFrozenBatch(
          frozenBatch,
          batchReceipts.map(({ page }) => page),
        )
      : undefined
  const batchPages = batch?.pages,
    batchBody = batch?.body,
    declaredInformation = batch?.userInformation
  let comment: CollaborationDocument | undefined
  for (const page of batchPages ?? []) {
    const index = parsed(page.text)
    if (!object(index) || !Array.isArray(index['members']))
      throw Error('The complete Batch index is unavailable')
    for (const member of index['members'])
      if (object(member) && member['commentId'] === expected.commentId) {
        const document = collaborationDocumentSchema.parse(member['body'])
        if (comment && JSON.stringify(comment) !== JSON.stringify(document))
          throw Error('The Native Comment reference changed between pages')
        comment = document
      }
  }
  const matchesBodyDocument = (request: CollaborationSourceRead) =>
    Boolean(
      batchBody &&
      request.source === 'document' &&
      request.document?.id === batchBody.id &&
      request.document.sha256 === batchBody.sha256 &&
      request.document.bytes === batchBody.bytes &&
      request.document.chars === batchBody.chars,
    )
  const bodyReceipts = receipts.filter(({ request }) => matchesBodyDocument(request)),
    exactBodyDocumentCallCount = allowed.filter((call) => {
      const legacy = collaborationSourceReadSchema.safeParse(call.input)
      const request = resolvedRequests.get(call.id) ?? (legacy.success ? legacy.data : undefined)
      return request !== undefined && matchesBodyDocument(request)
    }).length
  const batchBodyPages = batchBody
      ? completePages(bodyReceipts.map(({ page }) => page))
      : undefined,
    batchBodyText = batchBodyPages?.map((page) => page.text).join(''),
    batchBodySha256 = batchBodyText === undefined ? null : digest(batchBodyText),
    completeBatchBody = Boolean(
      batchBody &&
      batchBodyPages &&
      batchBodyPages.every(
        (page) => page.nextOffset === null || page.offset + page.text.length === page.nextOffset,
      ) &&
      batchBodyText?.length === batchBody.chars &&
      Buffer.byteLength(batchBodyText) === batchBody.bytes &&
      batchBodySha256 === batchBody.sha256 &&
      (expected.batchBodySha256 === undefined || batchBodySha256 === expected.batchBodySha256),
    ),
    commentPages = comment
      ? completePages(
          receipts
            .filter(
              ({ request }) => request.source === 'document' && request.document?.id === comment.id,
            )
            .map(({ page }) => page),
        )
      : undefined,
    text = commentPages?.map((page) => page.text).join(''),
    actualHash = text === undefined ? null : digest(text),
    completeComment = Boolean(
      comment &&
      commentPages &&
      commentPages.every(
        (page) => page.nextOffset === null || page.offset + page.text.length === page.nextOffset,
      ) &&
      text?.length === comment.chars &&
      Buffer.byteLength(text) === comment.bytes &&
      actualHash === comment.sha256 &&
      actualHash === expected.commentSha256,
    )
  const answerPages = expected.answer
      ? completePages(
          receipts
            .filter(
              ({ request }) =>
                request.source === 'document' && request.document?.id === expected.answer!.id,
            )
            .map(({ page }) => page),
        )
      : undefined,
    answerText = answerPages?.map((page) => page.text).join(''),
    completeAnswer = Boolean(
      expected.answer &&
      answerPages &&
      answerText !== undefined &&
      answerPages.every(
        (page) => page.nextOffset === null || page.offset + page.text.length === page.nextOffset,
      ) &&
      answerText.length === expected.answer.chars &&
      Buffer.byteLength(answerText) === expected.answer.bytes &&
      digest(answerText) === expected.answer.sha256,
    )
  const declaredPages =
    expected.declaration &&
    declaredInformation &&
    JSON.stringify(expected.declaration) === JSON.stringify(declaredInformation)
      ? completePages(
          receipts
            .filter(
              ({ request }) =>
                request.source === 'document' &&
                JSON.stringify(request.document) === JSON.stringify(expected.declaration),
            )
            .map(({ page }) => page),
        )
      : undefined
  const declaredText = declaredPages?.map((page) => page.text).join('')
  const completeDeclaredInformation = Boolean(
    expected.declaration &&
    declaredPages &&
    declaredPages.every(
      (page) => page.nextOffset === null || page.offset + page.text.length === page.nextOffset,
    ) &&
    declaredText?.length === expected.declaration.chars &&
    Buffer.byteLength(declaredText) === expected.declaration.bytes &&
    digest(declaredText) === expected.declaration.sha256,
  )
  const documentReferences = new Map<string, CollaborationDocument>()
  for (const receipt of receipts)
    if (receipt.request.source === 'document' && receipt.request.document)
      documentReferences.set(
        digest(JSON.stringify(receipt.request.document)),
        receipt.request.document,
      )
  const documents = [...documentReferences].map(([referenceSha256, document]) => {
    const pages = completePages(
      receipts
        .filter(
          (receipt) =>
            receipt.request.source === 'document' &&
            JSON.stringify(receipt.request.document) === JSON.stringify(document),
        )
        .map((receipt) => receipt.page),
    )
    const hash = createHash('sha256')
    let chars = 0,
      bytes = 0
    for (const page of pages ?? []) {
      chars += page.text.length
      bytes += Buffer.byteLength(page.text)
      hash.update(page.text)
    }
    return {
      referenceSha256,
      documentSha256: document.sha256,
      complete: Boolean(
        pages &&
        chars === document.chars &&
        bytes === document.bytes &&
        hash.digest('hex') === document.sha256 &&
        pages.every(
          (page) => page.nextOffset === null || page.offset + page.text.length === page.nextOffset,
        ),
      ),
      pages: pages?.length ?? 0,
      chars,
      bytes,
    }
  })
  const allToolsAllowed =
    calls.size === allowed.length &&
    ledgerValid &&
    readers.size === 1 &&
    sourceRejections.length === 0 &&
    (wrappers.length === 0 ||
      (rootMatched &&
        openWrapper === undefined &&
        wrappers.every(
          (wrapper) => !['pending', 'unclassified_wrapper'].includes(wrapper.classification),
        )))
  chargeWrapperMetadata()
  return {
    sourceToolCalls: allowed.length,
    submittedForms,
    documents,
    rejectedSourceReads,
    sourceRejections,
    allToolsAllowed,
    genericToolCallCount: outerIds.size,
    codeModeScriptAudit: {
      ...scriptAudit,
      snapshotOwner: {
        nativeFileByteLimit: nativeByteLimit,
        recordLimit,
        commandLimit: 256,
        retainsOriginalExecScripts: true,
      },
      workspaceLimits: {
        perScriptUtf8Bytes: 8192,
        proofMetadataBytes: 64 * 1024,
        acceptedAstObjects: 10_000,
        acceptedAstStringUtf16PayloadBytes: 512 * 1024,
        diagnosticScriptTextBytes: 0,
      },
      parserAllocationScope:
        'The inherited per-command input cap bounds parser input; AST thresholds apply after Babel construction and do not bound its allocation peak',
      heapSampleScope:
        'Process samples include the existing Native snapshot, not isolated workspace attribution',
    },
    boundaryDiagnostics: {
      toolScope: {
        totalCalls: calls.size,
        sourceCalls: allowed.length,
        sourceReaders: readers.size,
        nativeInputObserved: rootMatched,
        openWrapper: openWrapper !== undefined,
        nonSourceCalls: [...calls.values()]
          .filter((call) => !isRoutingSourceTool(call.name))
          .slice(0, 4)
          .map((call) => ({
            kind:
              /__(publish_session_title|submit_review|submit_input_result|request_peer_assistance)$/u.exec(
                canonicalReader(call.name),
              )?.[1] ?? 'other',
            nameSha256: digest(call.name),
          })),
        omittedNonSourceCalls: Math.max(0, calls.size - allowed.length - 4),
      },
      bodyReferencePresent: batchBody !== undefined,
      bodyReferenceExpectedShaMatched:
        batchBody && expected.batchBodySha256 !== undefined
          ? batchBody.sha256 === expected.batchBodySha256
          : null,
      exactBodyDocumentCallCount,
      authenticatedBodyPageCount: bodyReceipts.length,
      bodyReadOutcome: !batchBody
        ? 'body_reference_unavailable'
        : expected.batchBodySha256 !== undefined && batchBody.sha256 !== expected.batchBodySha256
          ? 'reference_hash_mismatch'
          : exactBodyDocumentCallCount === 0
            ? 'document_not_called'
            : bodyReceipts.length === 0
              ? 'no_authenticated_page'
              : !batchBodyPages
                ? 'incomplete_page_chain'
                : !completeBatchBody
                  ? 'content_mismatch'
                  : 'complete',
      rootSourceReadArgumentsMatched:
        readArgumentProofs.size === 1 ? [...readArgumentProofs][0]! : null,
      ledgerValid,
      reasons: [...ledgerReasons],
      failedLeafCount,
      failedLeaves: failedLeaves.map((leaf) => {
        const reference = leaf.arguments.referenceSha256,
          firstOffered = reference ? firstOfferedOrdinals.get(reference) : undefined,
          start = leaf.startObservation,
          beforeCompletion = firstOffered !== undefined && firstOffered < leaf.ordinal,
          observedBeforeStart =
            start.ordinal === null
              ? null
              : firstOffered !== undefined && firstOffered < start.ordinal
                ? true
                : start.kind === 'wrapper_lower_bound' && beforeCompletion
                  ? null
                  : false
        return {
          ...leaf,
          referenceObservation: reference
            ? {
                scope:
                  'Root input and authenticated successful source-page navigation only; no physical owner or signature proof',
                firstOfferedOrdinal: firstOffered ?? null,
                observedBeforeStart,
                observedBeforeCompletion: beforeCompletion,
                sameNativeReaderNameAsSuccessfulSource: [...readers].some(
                  (reader) => digest(reader) === leaf.readerSha256,
                ),
                successfulUsesOfSameReference: successfulReferenceWitnesses
                  .filter((entry) => entry.sha256 === reference)
                  .slice(0, 4),
                omittedSuccessfulUses: Math.max(
                  0,
                  successfulReferenceWitnesses.filter((entry) => entry.sha256 === reference)
                    .length - 4,
                ),
              }
            : null,
        }
      }),
      omittedFailedLeaves: failedLeafCount - failedLeaves.length,
      // oxlint-disable-next-line oxc/no-map-spread -- At most eight immutable diagnostic projections; do not mutate source records.
      wrappers: wrapperDiagnostics.map((diagnostic) => {
        const wrapper = wrappers[diagnostic.index]!,
          errorReaderHash = diagnostic.error
            ? Reflect.get(diagnostic.error, 'notFunctionReaderSha256')
            : undefined
        return {
          index: diagnostic.index,
          sha256: wrapper.sha256,
          completed: wrapper.completed,
          grammar: wrapper.grammar,
          admissible: !['pending', 'unclassified_wrapper'].includes(wrapper.classification),
          classification: wrapper.classification,
          operations: wrapper.operations,
          startedTurnMatched: diagnostic.startedTurnMatched,
          outputTurnMatched: diagnostic.outputTurnMatched ?? false,
          leaves: wrapper.leaves,
          outputClass: diagnostic.outputClass ?? 'missing',
          error: diagnostic.error,
          ...(!allToolsAllowed
            ? {
                errorReaderMatchesSuccessfulSource:
                  typeof errorReaderHash === 'string' && readers.size
                    ? [...readers].some((reader) => digest(reader) === errorReaderHash)
                    : null,
                callShapes: wrapper.diagnosticCalls
                  ? {
                      shapes: wrapper.diagnosticCalls.shapes,
                      readers: wrapper.diagnosticCalls.readerHashes.map((hash) => ({
                        sha256: hash,
                        matchesSuccessfulSource:
                          readers.size === 1
                            ? [...readers].some((reader) => digest(reader) === hash)
                            : null,
                      })),
                      omittedReaderOccurrences: wrapper.diagnosticCalls.omittedReaderOccurrences,
                      executionProvenByShape: false,
                    }
                  : null,
              }
            : {}),
        }
      }),
      omittedWrappers: Math.max(0, wrappers.length - 8),
    },
    nativeArgumentDiagnostics: {
      offered: [...suppliedNativeArguments.values()].slice(0, 24).map((fact) => ({
        requestSha256: fact.requestSha256,
        documentIdSha256: fact.documentIdSha256,
        documentSha256: fact.documentSha256,
        firstOfferedOrdinal: fact.firstOfferedOrdinal,
        selector: fact.selector,
      })),
      offeredOmitted: Math.max(0, suppliedNativeArguments.size - 24),
      submitted: [
        ...allowed
          .filter((call) => object(call.input) && Object.hasOwn(call.input, 'context'))
          .slice(0, 24)
          .map((call) => {
            const value = collaborationSourceNativeReadSchema.safeParse(call.input),
              hash = value.success ? digest(JSON.stringify(value.data)) : null,
              shape = sourceArgumentShape(call.input),
              offered = hash ? suppliedNativeArguments.get(hash) : undefined
            return {
              requestSha256: hash,
              documentIdSha256: shape.documentIdSha256,
              documentSha256: shape.documentSha256,
              selector:
                value.success && value.data.source === 'root_document'
                  ? { part: value.data.part!, ordinal: value.data.ordinal ?? null }
                  : undefined,
              callOrdinal: call.observedAt ?? null,
              exactOfferedBeforeRecord:
                offered !== undefined &&
                call.observedAt !== undefined &&
                offered.firstOfferedOrdinal < call.observedAt,
            }
          }),
        ...failedLeaves
          .filter((leaf) => leaf.arguments.submitted === 'nativeRoot')
          .map((leaf) => {
            const offered = leaf.requestSha256
              ? suppliedNativeArguments.get(leaf.requestSha256)
              : undefined
            return {
              requestSha256: leaf.requestSha256,
              documentIdSha256: leaf.arguments.documentIdSha256,
              documentSha256: leaf.arguments.documentSha256,
              selector:
                leaf.arguments.source === 'root_document' && leaf.arguments.part
                  ? { part: leaf.arguments.part, ordinal: leaf.arguments.ordinal }
                  : undefined,
              callOrdinal: leaf.ordinal,
              exactOfferedBeforeRecord:
                offered !== undefined && offered.firstOfferedOrdinal < leaf.ordinal,
            }
          }),
      ]
        .toSorted((a, b) => (a.callOrdinal ?? 0) - (b.callOrdinal ?? 0))
        .slice(0, 24),
      unretainedFailedLeaves: failedLeafCount - failedLeaves.length,
      scope:
        'Exact canonical argument fingerprints from current Root and successful Source pages; record ordinal is not a transport-start witness.',
    },
    sourceReferenceDiagnostics: {
      issued: [...suppliedReferences].slice(0, 24).map(([token, request]) => ({
        sha256: digest(token),
        chars: token.length,
        source: request.source,
        documentSha256: request.document?.sha256 ?? null,
        firstOfferedOrdinal: firstOfferedOrdinals.get(digest(token)) ?? null,
      })),
      issuedOmitted: Math.max(0, suppliedReferences.size - 24),
      submitted: [
        ...allowed
          .filter((call) => object(call.input) && typeof call.input['sourceReference'] === 'string')
          .slice(0, 24)
          .map((call) => {
            const input = call.input
            if (!object(input) || typeof input['sourceReference'] !== 'string')
              throw Error('Invalid diagnostic reference shape')
            const token = input['sourceReference'],
              request = untrustedReferenceRequest(call.input),
              offered = firstOfferedOrdinals.get(digest(token))
            return {
              sha256: digest(token),
              chars: token.length,
              encodingValid: request !== undefined,
              claimedDocumentSha256: request?.document?.sha256 ?? null,
              callOrdinal: call.observedAt ?? null,
              firstOfferedOrdinal: offered ?? null,
              exactIssuedBeforeObservedCallRecord:
                offered !== undefined && call.observedAt !== undefined && offered < call.observedAt,
              error: (() => {
                const shape = nativeErrorShape(call.output ?? outputs.get(call.id))
                return { isError: 'isError' in shape ? shape.isError : null }
              })(),
            }
          }),
        ...failedLeaves
          .filter((leaf) => leaf.arguments.referenceSha256 !== null)
          .map((leaf) => {
            const hash = leaf.arguments.referenceSha256!,
              offered = firstOfferedOrdinals.get(hash)
            return {
              sha256: hash,
              chars: leaf.arguments.referenceChars,
              encodingValid: leaf.untrustedReferenceClaims?.payloadValid === true,
              claimedDocumentSha256: null,
              callOrdinal: leaf.ordinal,
              firstOfferedOrdinal: offered ?? null,
              exactIssuedBeforeObservedCallRecord: offered !== undefined && offered < leaf.ordinal,
              error: { isError: 'isError' in leaf.result ? leaf.result.isError : null },
            }
          }),
      ]
        .toSorted((a, b) => (a.callOrdinal ?? 0) - (b.callOrdinal ?? 0))
        .slice(0, 24),
      submittedOmitted: Math.max(
        0,
        allowed.filter(
          (call) => object(call.input) && typeof call.input['sourceReference'] === 'string',
        ).length +
          failedLeaves.filter((leaf) => leaf.arguments.referenceSha256 !== null).length -
          24,
      ),
      unretainedFailedLeaves: failedLeafCount - failedLeaves.length,
      scope:
        'Fingerprints and Native record ordinals only; a Codex completed leaf ordinal is not invocation time. No signature or lifecycle proof.',
    },
    nativeUsage: {
      status: Object.keys(usageBySource).length
        ? 'observed'
        : usageSeen
          ? 'unmapped'
          : 'not-recorded',
      lastBySource: usageBySource,
    },
    codeModeScripts: wrappers.map((wrapper) => ({
      sha256: wrapper.sha256,
      bytes: wrapper.bytes,
      syntaxAudited: !['rejected', 'unknown'].includes(wrapper.grammar),
      nativeCompleted: wrapper.completed,
      classification: wrapper.classification,
      admissible: !['pending', 'unclassified_wrapper'].includes(wrapper.classification),
      sourceToolDiscovery: wrapper.grammar === 'metadata',
      // Source text, encoded references and grants stay in the original snapshot owner.
      sanitizedInput: null,
    })),
    sourceGrantMatched: matched,
    completeBatch: batchPages !== undefined,
    batchPageCount: batchPages?.length ?? 0,
    completeBatchBody,
    ...(expected.declaration
      ? {
          completeDeclaredInformation,
          declaredInformationPageCount: declaredPages?.length ?? 0,
          declaredInformationSha256: declaredText === undefined ? null : digest(declaredText),
        }
      : {}),
    batchBodyPageCount: batchBodyPages?.length ?? 0,
    batchBodySha256,
    completeComment,
    commentPageCount: commentPages?.length ?? 0,
    commentSha256: actualHash,
    ...(expected.answer
      ? {
          completeAnswer,
          answerPageCount: answerPages?.length ?? 0,
          answerSha256: answerText === undefined ? null : digest(answerText),
        }
      : {}),
  }
}

/** The caller already located this fixture-owned Native file; recheck identity/hash before parsing. */
export async function routingNativeSourceEvidence(
  native: Pick<NativeEvidence, 'path' | 'sha256'>,
  expected: ExpectedSource,
) {
  const before = await lstat(native.path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > nativeByteLimit)
    throw Error('Frozen-source Native file exceeds its owned observation budget')
  const handle = await open(native.path, 'r')
  try {
    const current = await handle.stat()
    if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size)
      throw Error('Frozen-source Native file identity changed')
    const bytes = Buffer.alloc(nativeByteLimit + 1)
    let size = 0
    while (size < bytes.length) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One bounded owned file advances its read cursor.
      const read = await handle.read(bytes, size, bytes.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    if (size > nativeByteLimit || digest(bytes.subarray(0, size)) !== native.sha256)
      throw Error('Frozen-source Native file changed after initial inspection')
    const lines = bytes.subarray(0, size).toString('utf8').split('\n').filter(Boolean)
    if (lines.length > recordLimit) throw Error('Frozen-source Native records exceed 10000')
    return {
      ...inspectRoutingSourceRecords(
        lines.map((line) => JSON.parse(line) as unknown),
        expected,
      ),
      sourceFileSha256: native.sha256,
    }
  } finally {
    await handle.close()
  }
}

/** Retain bounded source facts before assertions and owned Native cleanup can discard the file. */
export async function retainRoutingNativeSourceEvidence(
  native: Pick<NativeEvidence, 'path' | 'sha256'>,
  expected: ExpectedSource,
  retain: (receipt: unknown) => Promise<void>,
) {
  const nativeFileSha256 = /^[a-f0-9]{64}$/u.test(native.sha256) ? native.sha256 : null
  let evidence: Awaited<ReturnType<typeof routingNativeSourceEvidence>>
  try {
    evidence = await routingNativeSourceEvidence(native, expected)
  } catch (error) {
    await retain({
      version: 'pact-native-source-inspection-v1',
      status: 'unavailable',
      nativeFileSha256,
      errorType:
        error instanceof Error &&
        ['Error', 'TypeError', 'SyntaxError', 'RangeError'].includes(error.name)
          ? error.name
          : 'other',
    })
    // oxlint-disable-next-line eslint/preserve-caught-error -- Native parser errors can contain private references; retain only the safe receipt.
    throw Error('Native source inspection failed; see the retained safe receipt')
  }
  const receipt = {
    version: 'pact-native-source-inspection-v1',
    status: 'observed',
    nativeFileSha256,
    sourceToolCalls: evidence.sourceToolCalls,
    allToolsAllowed: evidence.allToolsAllowed,
    sourceGrantMatched: evidence.sourceGrantMatched,
    completeBatch: evidence.completeBatch,
    completeBatchBody: evidence.completeBatchBody,
    completeComment: evidence.completeComment,
    completeDeclaredInformation: evidence.completeDeclaredInformation ?? null,
    completeAnswer: evidence.completeAnswer ?? null,
    boundaryDiagnostics: evidence.boundaryDiagnostics,
  }
  if (Buffer.byteLength(JSON.stringify(receipt)) > 16 * 1024) {
    await retain({
      version: receipt.version,
      status: 'unavailable',
      nativeFileSha256,
      reason: 'diagnostic_budget_exceeded',
    })
    throw Error('Native source diagnostic receipt exceeds sixteen KiB')
  }
  await retain(receipt)
  return evidence
}
