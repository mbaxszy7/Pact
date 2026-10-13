import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'

import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

import {
  nativeForkBoundarySchema,
  nativeForkWitnessSchema,
  collaborationAnswerFormatSchema,
} from '@pact/contracts'

import type {
  NativeForkFileInput,
  NativeForkFileResult,
  NativeForkAnswerResult,
  NativeForkHistoryReference,
} from './native-fork-files'

import {
  projectCollaborationAnswer,
  readSubmittedCollaborationReport,
} from './collaboration-answer'
import { nativeHistoryImageBytes } from './native-image-content'

const TEXT_BYTES = 8 * 1024 * 1024
const MAX_BYTES = 32 * 1024 * 1024
const MAX_RECORDS = 10_000
// Individual records share the aggregate read bound, rather than a smaller message gate.
const MAX_LINE_BYTES = MAX_BYTES
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
type RecordValue = Record<string, unknown>
function isObject(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function object(value: unknown): RecordValue {
  if (!isObject(value)) throw new Error('Invalid native transcript record.')
  return value
}
function nativeEntry(value: RecordValue): SessionStoreEntry {
  if (
    typeof value.type !== 'string' ||
    (value.uuid != null && (typeof value.uuid !== 'string' || !uuid.test(value.uuid))) ||
    (value.timestamp != null && typeof value.timestamp !== 'string')
  )
    throw new Error('Invalid native SDK store entry.')
  return { ...value, type: value.type }
}

const claudeAccountingNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15

/** Claude 2.1.292 writes this bookkeeping on empty-input Windows resume as well as real Turns. */
function isClaudeCostState(entry: RecordValue, nativeSessionId: string): boolean {
  const totals = [
    'totalCostUSD',
    'totalAPIDuration',
    'totalAPIDurationWithoutRetries',
    'totalToolDuration',
    'totalLinesAdded',
    'totalLinesRemoved',
    'totalDuration',
    'startTime',
  ]
  const allowed = new Set(['type', 'sessionId', 'modelUsage', 'hasUnknownModelCost', ...totals])
  if (
    entry.type !== 'cost-state' ||
    entry.sessionId !== nativeSessionId ||
    Object.keys(entry).some((key) => !allowed.has(key)) ||
    !totals.every((key) => claudeAccountingNumber(entry[key])) ||
    !claudeAccountingNumber(entry.totalCostUSD) ||
    entry.totalCostUSD > 1e9 ||
    (entry.hasUnknownModelCost !== undefined && typeof entry.hasUnknownModelCost !== 'boolean') ||
    !isObject(entry.modelUsage)
  )
    return false
  const models = Object.keys(entry.modelUsage)
  if (models.length > MAX_RECORDS) return false
  const tokenFields = [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
  ]
  const usageFields = [...tokenFields, 'webSearchRequests', 'costUSD']
  const tokenTotals = [0, 0, 0, 0]
  for (const model of models) {
    if (!model.length || model.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(model)) return false
    const usage = entry.modelUsage[model]
    if (
      !isObject(usage) ||
      !usageFields.every((key) => claudeAccountingNumber(usage[key])) ||
      (usage.thinkingTokens !== undefined && !claudeAccountingNumber(usage.thinkingTokens)) ||
      Object.keys(usage).some((key) => !usageFields.includes(key) && key !== 'thinkingTokens')
    )
      return false
    for (const [index, key] of tokenFields.entries()) {
      tokenTotals[index] = tokenTotals[index]! + Number(usage[key])
      if (tokenTotals[index] > 1e15) return false
    }
  }
  return true
}
function isInput(value: unknown): value is NativeForkFileInput {
  if (
    !isObject(value) ||
    !['claude', 'codex'].includes(String(value.provider)) ||
    !['prepare', 'fork', 'inspect', 'read', 'read-answer'].includes(String(value.action))
  )
    return false
  for (const key of ['cwd', 'nativeSessionId'])
    if (typeof value[key] !== 'string' || !value[key].length || value[key].length > 4096)
      return false
  for (const key of ['nativeTurnId', 'storageRoot', 'path'])
    if (
      value[key] != null &&
      (typeof value[key] !== 'string' || !value[key].length || value[key].length > 4096)
    )
      return false
  if (
    value.answerFormat !== undefined &&
    !collaborationAnswerFormatSchema.safeParse(value.answerFormat).success
  )
    return false
  if (
    (isObject(value.source) && value.source.answerFormat !== value.answerFormat) ||
    (isObject(value.witness) && value.witness.answerFormat !== value.answerFormat)
  )
    return false
  if (
    value.action === 'read-answer' &&
    (value.provider !== 'claude' ||
      value.answerFormat === undefined ||
      typeof value.nativeTurnId !== 'string' ||
      !uuid.test(value.nativeTurnId))
  )
    return false
  if (
    value.responseHash != null &&
    (typeof value.responseHash !== 'string' || !/^[a-f\d]{64}$/u.test(value.responseHash))
  )
    return false
  if (
    value.historyMode !== undefined &&
    value.historyMode !== 'legacy' &&
    value.historyMode !== 'paginated'
  )
    return false
  if (
    value.lastDispatchedPhase != null &&
    (typeof value.lastDispatchedPhase !== 'string' ||
      !['fork', 'initialize'].includes(value.lastDispatchedPhase))
  )
    return false
  return (
    (value.source == null || nativeForkBoundarySchema.safeParse(value.source).success) &&
    (value.witness == null || nativeForkWitnessSchema.safeParse(value.witness).success)
  )
}
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalValue(item)]),
    )
  return value
}
function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex')
}
function stable(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}
function inside(root: string, path: string): boolean {
  const location = relative(root, path)
  return (
    Boolean(location) &&
    location !== '..' &&
    !location.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(location)
  )
}
/** Reads a stable ordinary file in fixed chunks. Growth never bypasses the byte ceiling. */
async function records(
  path: string,
  root: string,
  endBytes?: number,
  maxRecords = MAX_RECORDS,
  captureBoundaries = false,
  collaborationContent = false,
): Promise<{
  entries: RecordValue[]
  rawHash: string
  rawBytes: number
  imageBytes: number
  rawRecords: number
  lineEnds: number[]
  lineHashes: string[]
  identity: BigIntStats
  canonicalPath: string
  originalPath: string
}> {
  const canonicalRoot = await realpath(root),
    canonical = await realpath(path)
  if (!inside(canonicalRoot, canonical))
    throw new Error('Native transcript escaped its effective storage root.')
  const before = await lstat(path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    (endBytes === undefined && before.size > BigInt(MAX_BYTES)) ||
    (endBytes !== undefined &&
      (!Number.isSafeInteger(endBytes) ||
        endBytes <= 0 ||
        endBytes > MAX_BYTES ||
        before.size < BigInt(endBytes)))
  )
    throw new Error(
      'Native transcript is linked, unsupported or exceeds its 32 MiB image history budget.',
    )
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!stable(before, opened) || (await realpath(path)) !== canonical)
      throw new Error('Native transcript identity changed.')
    const entries: RecordValue[] = [],
      digest = createHash('sha256'),
      prefixDigest = captureBoundaries ? createHash('sha256') : undefined,
      lineEnds: number[] = [],
      lineHashes: string[] = [],
      decoder = new TextDecoder('utf-8', { fatal: true })
    const buffer = Buffer.alloc(64 * 1024)
    let total = 0,
      consumed = 0,
      lineBytes = 0,
      imageBytes = 0
    let parts: Buffer[] = []
    for (;;) {
      if (endBytes !== undefined && total === endBytes) break
      // oxlint-disable-next-line no-await-in-loop -- One file handle is read in order.
      const read = await handle.read(
        buffer,
        0,
        endBytes === undefined ? buffer.length : Math.min(buffer.length, endBytes - total),
        total,
      )
      if (!read.bytesRead) break
      total += read.bytesRead
      if (total > MAX_BYTES)
        throw new Error(
          'Native transcript exceeds its 32 MiB image history budget; no truncation was used.',
        )
      digest.update(buffer.subarray(0, read.bytesRead))
      // Copy each reusable read-buffer slice once; concatenate a complete record only once.
      let offset = 0
      while (offset < read.bytesRead) {
        const newline = buffer.indexOf(10, offset)
        const end = newline < 0 || newline >= read.bytesRead ? read.bytesRead : newline
        const fragment = buffer.subarray(offset, end)
        lineBytes += fragment.length
        if (lineBytes > MAX_LINE_BYTES)
          throw new Error('Native transcript line exceeds the complete read budget.')
        if (fragment.length) parts.push(Buffer.from(fragment))
        if (end === read.bytesRead) break
        if (entries.length >= maxRecords)
          throw new Error('Native transcript exceeds its record budget.')
        consumed += lineBytes + 1
        const line = Buffer.concat(parts, lineBytes)
        prefixDigest?.update(line)
        prefixDigest?.update('\n')
        if (captureBoundaries && !line.length)
          throw new Error('Native paginated history contains an empty physical record.')
        if (line.length) {
          let parsed: unknown
          try {
            parsed = JSON.parse(decoder.decode(line))
          } catch {
            throw new Error('Native transcript contains invalid JSON or UTF-8.')
          }
          const entry = object(parsed)
          imageBytes += nativeHistoryImageBytes(entry)
          entries.push(entry)
          if (prefixDigest) {
            lineEnds.push(consumed)
            lineHashes.push(prefixDigest.copy().digest('hex'))
          }
        }
        parts = []
        lineBytes = 0
        offset = end + 1
      }
    }
    if (!collaborationContent && total - imageBytes > TEXT_BYTES)
      throw new Error(
        'Native text/metadata exceeds its existing 8 MiB budget; no image allowance applies.',
      )
    if (lineBytes || (endBytes !== undefined && total !== endBytes))
      throw new Error('Native transcript has an incomplete or non-record byte boundary.')
    if (
      !stable(before, await handle.stat({ bigint: true })) ||
      !stable(before, await lstat(path, { bigint: true })) ||
      (await realpath(path)) !== canonical
    )
      throw new Error('Native transcript changed during inspection.')
    return {
      entries,
      rawHash: digest.digest('hex'),
      rawBytes: total,
      imageBytes,
      rawRecords: entries.length,
      lineEnds,
      lineHashes,
      identity: before,
      canonicalPath: canonical,
      originalPath: path,
    }
  } finally {
    await handle.close()
  }
}
function claudeRoot(): string {
  const configurationRoot = process.env['CLAUDE_CONFIG_DIR']?.trim() || join(homedir(), '.claude')
  if (!isAbsolute(configurationRoot))
    throw new Error(
      'The configured Claude native storage root is not absolute; its scope cannot be verified.',
    )
  return join(configurationRoot, 'projects')
}
function normalized(
  entries: RecordValue[],
  nativeSessionId: string,
  idMap: Array<[string, string]>,
): RecordValue[] {
  const inverse = new Map(idMap.map(([source, target]) => [target, source]))
  const reference = (value: unknown): unknown =>
    typeof value === 'string' ? (inverse.get(value) ?? value) : value
  const fields = (value: unknown, names: readonly string[]): unknown => {
    if (!isObject(value)) return value
    const result = { ...value }
    for (const name of names)
      if (name in result)
        result[name] = Array.isArray(result[name])
          ? result[name].map(reference)
          : reference(result[name])
    return result
  }
  return entries
    .filter((entry) => entry.type !== 'custom-title')
    .map((entry) => {
      const result = Object.fromEntries(Object.entries(entry))
      for (const key of [
        'forkedFrom',
        'teamName',
        'agentName',
        'sessionKind',
        'slug',
        'sourceToolAssistantUUID',
      ])
        delete result[key]
      const chainRecord = ['user', 'assistant', 'system', 'attachment'].includes(
        String(result.type),
      )
      if (!chainRecord || result.uuid === idMap.at(-1)?.[1]) delete result.timestamp
      if (!chainRecord) delete result.uuid
      for (const key of ['uuid', 'parentUuid', 'logicalParentUuid'])
        if (key in result) result[key] = reference(result[key])
      if (result.sessionId === nativeSessionId) result.sessionId = '$session'
      if (result.type === 'attachment' && isObject(result.attachment)) {
        const attachment = { ...result.attachment }
        if ('source_uuid' in attachment) attachment.source_uuid = reference(attachment.source_uuid)
        if (
          attachment.type === 'deferred_tools_record' &&
          Array.isArray(attachment.nameOnlyAnnouncements)
        )
          attachment.nameOnlyAnnouncements = attachment.nameOnlyAnnouncements.map(reference)
        result.attachment = attachment
      }
      if (result.type === 'system' && isObject(result.compactMetadata)) {
        const metadata = { ...result.compactMetadata }
        if ('preservedMessages' in metadata)
          metadata.preservedMessages = fields(metadata.preservedMessages, [
            'anchorUuid',
            'uuids',
            'allUuids',
          ])
        if ('preservedSegment' in metadata)
          metadata.preservedSegment = fields(metadata.preservedSegment, [
            'headUuid',
            'anchorUuid',
            'tailUuid',
          ])
        result.compactMetadata = metadata
      }
      // Message/tool/reasoning bodies stay byte-for-byte semantic values. Never
      // remap arbitrary strings merely because they equal a transcript UUID.
      return result
    })
}
async function claude(
  input: NativeForkFileInput,
): Promise<NativeForkFileResult | NativeForkAnswerResult> {
  const { forkSession, getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk')
  if (!uuid.test(input.nativeSessionId)) throw new Error('Invalid Claude Native Session UUID.')
  const root = claudeRoot()
  // SDK asks its store for the exact sanitized project key, including its portable long-path hash.
  let projectDirectory: string | undefined
  const load: SessionStore['load'] = async (key) => {
    if (key.subpath || !/^[a-z0-9-]+$/iu.test(key.projectKey) || !uuid.test(key.sessionId))
      throw new Error('Unsupported Native Session store key.')
    projectDirectory = join(root, key.projectKey)
    if (
      input.witness?.nativeStorageRoot &&
      (await realpath(root)) !== input.witness.nativeStorageRoot
    )
      throw new Error('The effective Claude native storage root changed.')
    if (
      input.witness?.nativePath &&
      join(await realpath(projectDirectory), `${key.sessionId}.jsonl`) !== input.witness.nativePath
    )
      throw new Error('The recorded Claude native Fork path changed.')
    const nativePath = join(projectDirectory, `${key.sessionId}.jsonl`)
    if (
      input.action === 'read-answer' &&
      ((input.storageRoot && (await realpath(root)) !== input.storageRoot) ||
        (input.path && (await realpath(nativePath)) !== input.path))
    )
      throw new Error('The confirmed Claude native answer storage identity changed.')
    if (
      input.action === 'inspect' &&
      input.lastDispatchedPhase === 'fork' &&
      input.source &&
      input.witness?.nativeProjectKey &&
      input.witness.nativeProjectDevice &&
      input.witness.nativeProjectInode &&
      input.witness.nativePath &&
      input.witness.nativeStorageRoot
    ) {
      const originalDirectory = await realpath(projectDirectory),
        directory = await lstat(originalDirectory, { bigint: true })
      if (
        key.projectKey !== input.witness.nativeProjectKey ||
        !directory.isDirectory() ||
        directory.dev === 0n ||
        directory.ino === 0n ||
        directory.dev.toString() !== input.witness.nativeProjectDevice ||
        directory.ino.toString() !== input.witness.nativeProjectInode
      )
        throw new Error('The original native Fork store directory identity changed.')
      const absent = async (): Promise<boolean> => {
        try {
          await lstat(nativePath)
          return false
        } catch (error) {
          if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return true
          throw error
        }
      }
      if (await absent()) {
        // The same provider algorithm checks this exact original source cut in
        // memory only. No native write, resume, directory scan or guessed ID.
        await claude({
          provider: 'claude',
          action: 'read',
          cwd: input.cwd,
          nativeSessionId: input.source.nativeSessionId,
          nativeTurnId: input.source.nativeTurnId,
          ...(input.source.answerFormat ? { answerFormat: input.source.answerFormat } : {}),
          source: input.source,
        })
        const after = await lstat(originalDirectory, { bigint: true })
        if (
          (await realpath(root)) !== input.witness.nativeStorageRoot ||
          (await realpath(projectDirectory)) !== originalDirectory ||
          after.dev !== directory.dev ||
          after.ino !== directory.ino ||
          !(await absent())
        )
          throw new Error('The exact native Fork key changed during absence verification.')
        throw Object.assign(
          new Error(
            'The recorded file Fork candidate is absent from its verified original SDK store; the original native source cut is still available.',
          ),
          { code: 'native_file_fork_candidate_missing' },
        )
      }
    }
    return (
      await records(nativePath, root, undefined, MAX_RECORDS, false, Boolean(input.answerFormat))
    ).entries.map(nativeEntry)
  }
  let sourceEntries: RecordValue[] = []
  const reading: SessionStore = {
    load: async (key) => {
      const value = await load(key)
      sourceEntries = value ?? []
      return value
    },
    append: async () => {
      throw new Error('Read-only Native store.')
    },
  }
  // Use the SDK's own chain selection; system messages keep compact boundaries intact.
  await getSessionMessages(input.nativeSessionId, {
    dir: input.cwd,
    includeSystemMessages: true,
    sessionStore: reading,
  })
  const raw = await records(
    join(projectDirectory!, `${input.nativeSessionId}.jsonl`),
    root,
    undefined,
    MAX_RECORDS,
    false,
    Boolean(input.answerFormat),
  )
  if (hash(raw.entries) !== hash(sourceEntries))
    throw new Error('Native transcript changed between source reads.')
  if (input.action === 'inspect') {
    const witness = input.witness
    if (!witness || witness.nativeSessionId !== input.nativeSessionId || !witness.idMap.length)
      throw new Error('Native Fork witness is missing.')
    const forkRecords = sourceEntries.filter((entry) => Boolean(entry.forkedFrom))
    const actualMap = forkRecords.map((entry): [string, string] => {
      const lineage = object(entry.forkedFrom)
      if (
        lineage.sessionId !== witness.sourceNativeSessionId ||
        typeof lineage.messageUuid !== 'string' ||
        typeof entry.uuid !== 'string'
      )
        throw new Error('Native Fork lineage mismatch.')
      return [lineage.messageUuid, entry.uuid]
    })
    if (JSON.stringify(actualMap) !== JSON.stringify(witness.idMap))
      throw new Error('Native Fork UUID map mismatch.')
    const last = sourceEntries.findIndex((entry) => entry.uuid === witness.idMap.at(-1)?.[1])
    const end = witness.candidatePrefixRecords
    if (!end || end > sourceEntries.length || end <= last)
      throw new Error('Native Fork prefix record boundary is missing.')
    for (const entry of sourceEntries.slice(end)) {
      const type = entry.type
      const harmlessMetadata = ['custom-title', 'ai-title', 'tag', 'atis-latch', 'mode'].includes(
        String(type),
      )
      const hookSystem =
        type === 'system' &&
        ['hook_started', 'hook_response', 'hook_progress'].includes(String(entry.subtype)) &&
        !entry.compactMetadata
      const hookProgress =
        type === 'progress' && isObject(entry.data) && entry.data.type === 'hook_progress'
      const hookAttachment =
        type === 'attachment' &&
        isObject(entry.attachment) &&
        ['hook_success', 'hook_additional_context', 'hook_stderr', 'hook_blocking_error'].includes(
          String(entry.attachment.type),
        )
      const windowsAccounting =
        process.platform === 'win32' &&
        type === 'cost-state' &&
        isClaudeCostState(entry, input.nativeSessionId)
      if (
        !harmlessMetadata &&
        !hookSystem &&
        !hookProgress &&
        !hookAttachment &&
        !windowsAccounting
      )
        throw new Error(
          'The Native Fork candidate contains an additional turn or unsupported context change after its frozen cutoff.',
        )
    }
    const prefix = normalized(sourceEntries.slice(0, end), input.nativeSessionId, actualMap)
    const prefixHash = hash(prefix)
    if (prefixHash !== witness.candidatePrefixHash || prefixHash !== witness.sourcePrefixHash)
      throw new Error('Native Fork prefix changed or is incomplete.')
    const initializedVerified =
      Boolean(witness.initializedAt) &&
      raw.rawHash === witness.initializedPrefixHash &&
      raw.rawBytes === witness.initializedPrefixBytes &&
      raw.rawRecords === witness.initializedPrefixRecords
    return {
      initializedVerified,
      nativeSessionId: input.nativeSessionId,
      nativeCutId: witness.sourceCutId,
      prefixHash,
      prefixBytes: Buffer.byteLength(JSON.stringify(prefix)),
      prefixRecords: prefix.length,
      idMap: actualMap,
      rawHash: raw.rawHash,
      rawBytes: raw.rawBytes,
      rawRecords: raw.rawRecords,
      nativeStorageRoot: await realpath(root),
      nativePath: join(await realpath(projectDirectory!), `${input.nativeSessionId}.jsonl`),
    }
  }
  // The public current-chain projection can omit older messages after compaction.
  // Exact historical turns are selected from bounded native records; the SDK below
  // still owns the actual native prefix/compaction selection and UUID remapping.
  const main = sourceEntries.filter(
    (entry) =>
      ['user', 'assistant', 'system', 'attachment'].includes(String(entry.type)) &&
      !entry.isSidechain,
  )
  const start = main.findIndex(
    (entry) => entry.uuid === input.nativeTurnId && entry.type === 'user',
  )
  if (start < 0) throw new Error('The complete Claude turn source is missing.')
  let next = main.length
  for (let index = start + 1; index < main.length; index++) {
    const entry = main[index]!
    if (entry.type !== 'user') continue
    const content = object(entry.message).content
    const toolResult =
      Array.isArray(content) &&
      content.length > 0 &&
      content.every((block) => object(block).type === 'tool_result')
    if (!toolResult && !entry.isMeta) {
      next = index
      break
    }
  }
  const selected = main.slice(start + 1, next)
  // A formal output attachment must belong to this exact User-root chain, rather
  // than a similarly shaped body or a disconnected transcript branch.
  let structuredOutput: unknown
  let belongsToRoot: ((entry: RecordValue) => boolean) | undefined
  if (input.answerFormat) {
    const chain = new Map(
      main
        .slice(start, next)
        .flatMap((entry) => (typeof entry.uuid === 'string' ? [[entry.uuid, entry] as const] : [])),
    )
    const ancestry = new Map<string, boolean>([[input.nativeTurnId!, true]])
    belongsToRoot = (entry: RecordValue): boolean => {
      const visited = new Set<string>()
      let cursor: RecordValue | undefined = entry
      let belongs = false
      while (cursor) {
        if (typeof cursor.uuid !== 'string' || visited.has(cursor.uuid)) break
        const known = ancestry.get(cursor.uuid)
        if (known !== undefined) {
          belongs = known
          break
        }
        visited.add(cursor.uuid)
        cursor = typeof cursor.parentUuid === 'string' ? chain.get(cursor.parentUuid) : undefined
      }
      for (const id of visited) ancestry.set(id, belongs)
      return belongs
    }
    structuredOutput = selected.findLast(
      (entry) =>
        entry.type === 'attachment' &&
        isObject(entry.attachment) &&
        entry.attachment.type === 'structured_output' &&
        belongsToRoot?.(entry),
    )?.attachment
    structuredOutput = isObject(structuredOutput) ? structuredOutput.data : undefined
  }
  const answerItems = new Map<string, string>()
  for (const entry of selected) {
    if (
      entry.type !== 'assistant' ||
      entry.isCompactSummary ||
      (input.answerFormat && !belongsToRoot?.(entry))
    )
      continue
    const messageValue = object(entry.message),
      content = messageValue.content
    if (typeof messageValue.id !== 'string' || !Array.isArray(content))
      throw new Error('Incomplete native answer.')
    const text = content
      .filter((block) => object(block).type === 'text')
      .map((block) => {
        const blockText = object(block).text
        if (typeof blockText !== 'string') throw new Error('Claude native text is incomplete.')
        return blockText
      })
      .join('')
    if (text) answerItems.set(messageValue.id, text)
  }
  const answer = projectCollaborationAnswer(
    [...answerItems].map(([id, text]) => ({ id, text })),
    input.answerFormat,
    structuredOutput ?? null,
  )
  if (input.action === 'read-answer') {
    const submittedReport = readSubmittedCollaborationReport(structuredOutput, input.answerFormat)
    return {
      nativeSessionId: input.nativeSessionId,
      nativeTurnId: input.nativeTurnId!,
      ...(answer ? { answer } : {}),
      ...(submittedReport ? { submittedReport } : {}),
      nativeStorageRoot: await realpath(root),
      nativePath: join(await realpath(projectDirectory!), `${input.nativeSessionId}.jsonl`),
    }
  }
  if (
    input.action === 'prepare' &&
    (!answer || createHash('sha256').update(answer).digest('hex') !== input.responseHash)
  )
    throw new Error('Claude native answer does not match the complete selected Pact answer.')
  const rawStart = sourceEntries.findIndex((entry) => entry.uuid === input.nativeTurnId)
  const rawEnd =
    next < main.length
      ? sourceEntries.findIndex((entry) => entry.uuid === main[next]!.uuid)
      : sourceEntries.length
  if (rawStart < 0 || rawEnd <= rawStart)
    throw new Error('Claude native turn boundary is incomplete.')
  const throughTurn = sourceEntries.slice(0, rawEnd)
  const cut = throughTurn.findLast(
    (entry) =>
      ['user', 'assistant', 'system', 'attachment'].includes(String(entry.type)) &&
      typeof entry.uuid === 'string' &&
      !entry.isSidechain,
  )?.uuid
  if (typeof cut !== 'string') throw new Error('No complete Claude native chain cutoff.')
  const frozen = sourceEntries.slice(0, sourceEntries.findIndex((entry) => entry.uuid === cut) + 1)
  let result: NativeForkFileResult | undefined
  const store: SessionStore = {
    load: async () => frozen.map(nativeEntry),
    append: async (key, entries) => {
      const values: RecordValue[] = entries
      const directory = await realpath(projectDirectory!),
        directoryIdentity = await lstat(directory, { bigint: true })
      if (!directoryIdentity.isDirectory())
        throw new Error('The native Fork project store is not an ordinary directory.')
      const idMap = values
        .filter((entry) => Boolean(entry.forkedFrom))
        .map((entry): [string, string] => [
          String(object(entry.forkedFrom).messageUuid),
          String(entry.uuid),
        ])
      const prefix = normalized(values, key.sessionId, idMap)
      result = {
        nativeSessionId: key.sessionId,
        nativeCutId: cut,
        prefixHash: hash(prefix),
        prefixBytes: Buffer.byteLength(JSON.stringify(prefix)),
        prefixRecords: prefix.length,
        idMap,
        rawHash: '',
        rawBytes: 0,
        rawRecords: values.length,
        nativeStorageRoot: await realpath(root),
        nativePath: join(directory, `${key.sessionId}.jsonl`),
        nativeProjectKey: key.projectKey,
        nativeProjectDevice: directoryIdentity.dev.toString(),
        nativeProjectInode: directoryIdentity.ino.toString(),
      }
      if (
        input.source &&
        (input.source.nativeCutId !== cut || input.source.prefixHash !== result.prefixHash)
      )
        throw new Error('Prepared Claude native prefix changed before Fork.')
      if (input.action !== 'fork') return
      if (!projectDirectory || !uuid.test(key.sessionId) || values.length > MAX_RECORDS)
        throw new Error('Invalid native Fork candidate.')
      parentPort!.postMessage({ type: 'candidate', result })
      await new Promise<void>((resolve, reject) =>
        parentPort!.once('message', (message) =>
          message?.type === 'candidate_committed'
            ? resolve()
            : reject(new Error('Candidate persistence was not acknowledged.')),
        ),
      )
      if (!inside(await realpath(root), directory))
        throw new Error('Native Fork directory escaped its storage root.')
      const writeDirectory = await lstat(directory, { bigint: true })
      if (
        (await realpath(projectDirectory)) !== directory ||
        writeDirectory.dev !== directoryIdentity.dev ||
        writeDirectory.ino !== directoryIdentity.ino ||
        (await realpath(root)) !== result.nativeStorageRoot
      )
        throw new Error('Native Fork store identity changed before its exclusive write.')
      const text = values.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
      const outputBytes = Buffer.byteLength(text)
      if (
        outputBytes > MAX_BYTES ||
        (!input.answerFormat &&
          outputBytes - values.reduce((sum, entry) => sum + nativeHistoryImageBytes(entry), 0) >
            TEXT_BYTES)
      )
        throw new Error('Native Fork output exceeds its text/image byte budget.')
      const handle = await open(
        join(directory, `${key.sessionId}.jsonl`),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      try {
        await handle.writeFile(text)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (process.platform !== 'win32') {
        const dir = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
        try {
          await dir.sync()
        } finally {
          await dir.close()
        }
      }
      const readback = await records(
        join(directory, `${key.sessionId}.jsonl`),
        root,
        undefined,
        MAX_RECORDS,
        false,
        Boolean(input.answerFormat),
      )
      Object.assign(result, {
        rawHash: readback.rawHash,
        rawBytes: readback.rawBytes,
        rawRecords: readback.rawRecords,
      })
    },
  }
  await forkSession(input.nativeSessionId, {
    dir: input.cwd,
    upToMessageId: cut,
    sessionStore: store,
  })
  if (!result) throw new Error('Native SDK returned no Fork prefix.')
  return result
}

async function historyReference(nativeSessionId: string): Promise<NativeForkHistoryReference> {
  if (!parentPort || !uuid.test(nativeSessionId))
    throw new Error('Invalid native history parent identity.')
  return new Promise((resolve, reject) => {
    parentPort!.once('message', (message: unknown) => {
      if (!isObject(message) || message.type !== 'history_reference_resolved') {
        reject(new Error('Native history parent resolution was not acknowledged.'))
        return
      }
      const reference = message.reference
      if (
        !isObject(reference) ||
        reference.nativeSessionId !== nativeSessionId ||
        typeof reference.path !== 'string' ||
        !reference.path ||
        reference.path.length > 4096 ||
        reference.historyMode !== 'paginated' ||
        Buffer.byteLength(JSON.stringify(reference)) > 8192
      ) {
        reject(new Error('Native history parent resolution is invalid or unsupported.'))
        return
      }
      resolve({
        nativeSessionId,
        path: reference.path,
        historyMode: reference.historyMode,
      })
    })
    parentPort!.postMessage({ type: 'history_reference', nativeSessionId })
  })
}

async function paginatedCodex(
  input: NativeForkFileInput,
  raw: Awaited<ReturnType<typeof records>>,
  nativePath: string,
  storageRoot: string,
): Promise<NativeForkFileResult> {
  type Segment = {
    nativeSessionId: string
    start: number
    read: Awaited<ReturnType<typeof records>>
  }
  const seen = new Set<string>()
  let rawBytes = 0,
    rawRecords = 0,
    imageBytes = 0
  const resolve = async (
    id: string,
    path: string,
    depth: number,
    boundary?: { bytes: number; ordinal: number },
    initial?: Awaited<ReturnType<typeof records>>,
  ): Promise<{ entries: RecordValue[]; segments: Segment[] }> => {
    if (depth >= 32 || seen.has(id))
      throw new Error('Native history has a cycle or exceeds its 32-parent depth limit.')
    seen.add(id)
    if (boundary && boundary.bytes > MAX_BYTES - rawBytes)
      throw new Error('Native history reference exceeds the remaining aggregate byte budget.')
    const read =
      initial ??
      (await records(
        path,
        storageRoot,
        boundary?.bytes,
        MAX_RECORDS - rawRecords,
        true,
        Boolean(input.answerFormat),
      ))
    rawBytes += read.rawBytes
    rawRecords += read.rawRecords
    imageBytes += read.imageBytes
    if (!input.answerFormat && rawBytes - imageBytes > TEXT_BYTES)
      throw new Error('Resolved Native text exceeds its existing 8 MiB budget.')
    if (rawBytes > MAX_BYTES || rawRecords > MAX_RECORDS)
      throw new Error('Resolved native history exceeds its aggregate 32 MiB/10,000-record budget.')
    const first = read.entries[0],
      header = first && object(first.payload)
    if (
      first?.type !== 'session_meta' ||
      !header ||
      header.id !== id ||
      (header.session_id !== undefined && header.session_id !== id) ||
      header.history_mode !== 'paginated' ||
      header.historyMode !== undefined ||
      typeof first.ordinal !== 'number' ||
      !Number.isSafeInteger(first.ordinal) ||
      first.ordinal < 0
    )
      throw new Error('Native paginated history has no exact header identity/mode/ordinal.')
    const start = first.ordinal
    if (read.entries.slice(1).some((entry) => entry.type === 'session_meta'))
      throw new Error('Native paginated file contains another unverified history header.')
    if (read.entries.some((entry, index) => entry.ordinal !== start + index))
      throw new Error('Native history has missing, duplicate or unordered original ordinals.')
    if (boundary && boundary.ordinal !== start + read.entries.length)
      throw new Error('Native history byte and exclusive ordinal bounds disagree.')
    let prior: { entries: RecordValue[]; segments: Segment[] } = { entries: [], segments: [] }
    if (header.history_base != null) {
      const base = object(header.history_base)
      if (
        Object.keys(base).some(
          (key) => !['thread_id', 'end_ordinal_exclusive', 'end_byte_offset'].includes(key),
        ) ||
        typeof base.thread_id !== 'string' ||
        !uuid.test(base.thread_id) ||
        typeof base.end_ordinal_exclusive !== 'number' ||
        !Number.isSafeInteger(base.end_ordinal_exclusive) ||
        base.end_ordinal_exclusive <= 0 ||
        base.end_ordinal_exclusive !== start ||
        header.forked_from_ordinal_exclusive !== start ||
        typeof base.end_byte_offset !== 'number' ||
        !Number.isSafeInteger(base.end_byte_offset) ||
        base.end_byte_offset <= 0 ||
        base.end_byte_offset > MAX_BYTES
      )
        throw new Error('Native history reference has an unprovable byte/ordinal boundary.')
      const parent = await historyReference(base.thread_id)
      prior = await resolve(parent.nativeSessionId, parent.path, depth + 1, {
        bytes: base.end_byte_offset,
        ordinal: base.end_ordinal_exclusive,
      })
      if (prior.entries.length !== start)
        throw new Error('Native inherited history has an ordinal gap or overlap.')
    } else if (start !== 0)
      throw new Error('Native history begins after ordinal zero without a complete parent.')
    return {
      entries: [...prior.entries, ...read.entries],
      segments: [...prior.segments, { nativeSessionId: id, start, read }],
    }
  }
  const resolved = await resolve(input.nativeSessionId, nativePath, 0, undefined, raw),
    entries = resolved.entries
  // Every earlier file must remain the same through the last reference read.
  // Per-file stability alone misses a target append while its parent RPC waits.
  for (const segment of resolved.segments) {
    // oxlint-disable-next-line no-await-in-loop -- Recheck the bounded closure in order, with the target last.
    const current = await lstat(segment.read.originalPath, { bigint: true })
    if (
      !stable(segment.read.identity, current) ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      // oxlint-disable-next-line no-await-in-loop -- Canonical identity is part of the same closure recheck.
      (await realpath(segment.read.originalPath)) !== segment.read.canonicalPath
    )
      throw new Error('Native history changed while its reference closure was inspected.')
  }
  if ((await realpath(input.storageRoot!)) !== storageRoot)
    throw new Error('Native history storage root changed during reference inspection.')
  const identity = object(raw.entries[0]!.payload)
  if (input.witness && identity.forked_from_id !== input.witness.sourceNativeSessionId)
    throw new Error('Codex Fork immediate native lineage mismatch.')
  let active: string | undefined,
    selectedStart = -1,
    selectedEnd = -1
  const started = new Set<string>(),
    terminals: string[] = []
  const allowed = new Set([
    'session_meta',
    'response_item',
    'event_msg',
    'world_state',
    'turn_context',
    'token_usage_record',
    'compacted',
  ])
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!,
      payload = object(entry.payload)
    if (!allowed.has(String(entry.type)))
      throw new Error('Native paginated history contains an unsupported context record type.')
    if (
      entry.type === 'world_state' &&
      (typeof payload.full !== 'boolean' || !isObject(payload.state))
    )
      throw new Error('Native world state is incomplete.')
    if (entry.type !== 'event_msg') continue
    if (['task_started', 'turn_started'].includes(String(payload.type))) {
      if (
        typeof payload.turn_id !== 'string' ||
        !payload.turn_id ||
        payload.turn_id.length > 1024 ||
        started.has(payload.turn_id) ||
        active
      )
        throw new Error('Native paginated history has an unpaired canonical Turn start.')
      started.add(payload.turn_id)
      active = payload.turn_id
      if (active === input.nativeTurnId) selectedStart = index
    } else if (['task_complete', 'turn_complete', 'turn_aborted'].includes(String(payload.type))) {
      if (
        typeof payload.turn_id !== 'string' ||
        active !== payload.turn_id ||
        payload.error != null ||
        (payload.status != null && payload.status !== 'completed') ||
        (payload.turn_id === input.nativeTurnId && payload.type === 'turn_aborted')
      )
        throw new Error('Native paginated history has an unmatched or unsuccessful terminal.')
      terminals.push(payload.turn_id)
      active = undefined
      if (payload.turn_id === input.nativeTurnId) {
        selectedEnd = index + 1
        break
      }
    } else if (['task_aborted', 'task_failed', 'turn_failed'].includes(String(payload.type)))
      throw new Error('Native paginated history has an unsupported terminal marker.')
  }
  if (selectedStart < 0 || selectedEnd <= selectedStart || active)
    throw new Error('Codex has no exact completed paginated native Turn boundary.')
  if (input.witness) {
    if (
      raw.entries[0]!.ordinal !== selectedEnd ||
      identity.forked_from_ordinal_exclusive !== selectedEnd
    )
      throw new Error('The Native Fork reference does not end at its frozen completed Turn.')
    for (const entry of entries.slice(selectedEnd)) {
      const payload = object(entry.payload)
      if (entry === raw.entries[0]) continue
      if (
        entry.type !== 'event_msg' ||
        payload.type !== 'thread_settings_applied' ||
        payload.thread_id !== input.nativeSessionId ||
        !isObject(payload.thread_settings)
      )
        throw new Error('The Native Fork candidate contains an extra Turn or unknown setup record.')
    }
  }
  if (input.responseHash)
    validateCodexAnswer(
      entries,
      selectedStart,
      selectedEnd - 1,
      input.responseHash,
      input.answerFormat,
    )
  const prefixSegments: Array<{
    nativeSessionId: string
    endOrdinalExclusive: number
    endByteOffset: number
    rawHash: string
  }> = []
  let prefixBytes = 0
  for (const segment of resolved.segments) {
    const count = Math.min(segment.read.entries.length, Math.max(0, selectedEnd - segment.start))
    if (!count) continue
    const bytes = segment.read.lineEnds[count - 1],
      digest = segment.read.lineHashes[count - 1]
    if (!bytes || !digest)
      throw new Error('Native history has no exact original byte-cut evidence.')
    prefixBytes += bytes
    prefixSegments.push({
      nativeSessionId: segment.nativeSessionId,
      endOrdinalExclusive: segment.start + count,
      endByteOffset: bytes,
      rawHash: digest,
    })
  }
  const prefix = { domain: 'codex-paginated-native-bytes-prefix-v1', segments: prefixSegments }
  const prefixHash = hash(prefix),
    idMap: Array<[string, string]> = terminals.map((id) => [id, id])
  if (prefixBytes > MAX_BYTES)
    throw new Error('Native paginated prefix exceeds its serialized byte budget.')
  if (
    input.witness &&
    (prefixHash !== input.witness.sourcePrefixHash ||
      prefixHash !== input.witness.candidatePrefixHash ||
      JSON.stringify(idMap) !== JSON.stringify(input.witness.idMap))
  )
    throw new Error(
      'Native paginated opaque history or Turn identities differ from the frozen source.',
    )
  const rawHash = hash({
    domain: 'codex-paginated-resolved-native-bytes-v1',
    segments: resolved.segments.map((segment) => ({
      nativeSessionId: segment.nativeSessionId,
      endOrdinalExclusive: segment.start + segment.read.rawRecords,
      endByteOffset: segment.read.rawBytes,
      rawHash: segment.read.rawHash,
    })),
  })
  return {
    nativeSessionId: input.nativeSessionId,
    nativeCutId: input.nativeTurnId!,
    prefixHash,
    prefixBytes,
    prefixRecords: selectedEnd,
    idMap,
    rawHash,
    rawBytes,
    rawRecords,
    nativeStorageRoot: storageRoot,
    nativePath,
    initializedVerified:
      Boolean(input.witness?.initializedAt) &&
      rawHash === input.witness?.initializedPrefixHash &&
      rawBytes === input.witness?.initializedPrefixBytes &&
      rawRecords === input.witness?.initializedPrefixRecords,
  }
}

function validateCodexAnswer(
  entries: RecordValue[],
  selectedStart: number,
  selectedComplete: number,
  responseHash: string,
  answerFormat?: NativeForkFileInput['answerFormat'],
): void {
  const answerItems = new Map<string, { id: string; text: string; phase?: unknown }>()
  for (let index = selectedStart + 1; index <= selectedComplete; index++) {
    const entry = entries[index]!,
      payload = object(entry.payload)
    if (
      entry.type !== 'response_item' ||
      payload.type !== 'message' ||
      payload.role !== 'assistant'
    )
      continue
    if (answerFormat && payload.parent_tool_call_id != null) continue
    if (!Array.isArray(payload.content))
      throw new Error('Codex native answer content is incomplete.')
    const text = payload.content
      .filter((block) => object(block).type === 'output_text')
      .map((block) => {
        const value = object(block).text
        if (typeof value !== 'string') throw new Error('Codex native text is incomplete.')
        return value
      })
      .join('')
    if (text) {
      const id = typeof payload.id === 'string' ? payload.id : `record:${index}`
      answerItems.set(id, { id, text, phase: payload.phase })
    }
  }
  const text = projectCollaborationAnswer([...answerItems.values()], answerFormat)
  if (!text || createHash('sha256').update(text).digest('hex') !== responseHash)
    throw new Error('Codex complete native answer does not match the selected Pact answer.')
}

async function codex(input: NativeForkFileInput): Promise<NativeForkFileResult> {
  if (!input.path || !input.storageRoot)
    throw new Error('The native Codex rollout path is missing.')
  const storageRoot = await realpath(input.storageRoot),
    nativePath = await realpath(input.path)
  if (input.witness?.nativeStorageRoot && storageRoot !== input.witness.nativeStorageRoot)
    throw new Error('The effective Codex native storage root changed.')
  if (input.witness?.nativePath && nativePath !== input.witness.nativePath)
    throw new Error('The recorded Codex native Fork path changed.')
  const raw = await records(
    input.path,
    input.storageRoot,
    undefined,
    MAX_RECORDS,
    input.historyMode === 'paginated',
    Boolean(input.answerFormat),
  )
  const meta = raw.entries[0]
  if (meta?.type !== 'session_meta')
    throw new Error('Codex native rollout has no authoritative first session header.')
  const mode = object(meta.payload).history_mode ?? 'legacy'
  if (input.historyMode !== undefined && input.historyMode !== mode)
    throw new Error('Codex native RPC and physical history modes disagree.')
  if (mode === 'paginated') return paginatedCodex(input, raw, nativePath, storageRoot)
  // Validate the physical root again after RPC observation: a referenced/paginated
  // root can change between reads, and one local file is not its complete context.
  for (const header of raw.entries.filter((entry) => entry.type === 'session_meta')) {
    const payload = object(header.payload)
    if (
      (payload.history_mode !== undefined && payload.history_mode !== 'legacy') ||
      payload.history_base != null ||
      payload.historyMode !== undefined
    )
      throw new Error(
        'Codex Fork requires legacy self-contained history without a native history-base reference.',
      )
  }
  const identity = object(meta.payload)
  if (!identity || identity.id !== input.nativeSessionId)
    throw new Error('Codex native rollout identity mismatch.')
  if (input.witness && identity.forked_from_id !== input.witness.sourceNativeSessionId)
    throw new Error('Codex Fork lineage mismatch.')
  let selectedStart = -1,
    selectedComplete = -1
  const starts = new Set<string>(),
    completed = new Set<string>()
  const turnIdentityEvidence: Array<{ type: string; turnId: string; status: string }> = []
  const terminalTurns: string[] = []
  let activeTurn: string | undefined,
    prefixEnd = raw.entries.length
  for (let index = 0; index < raw.entries.length; index++) {
    const entry = raw.entries[index]!,
      payload = object(entry.payload)
    if (entry.type !== 'event_msg') continue
    if (['task_started', 'turn_started'].includes(String(payload.type))) {
      if (selectedComplete >= 0) {
        prefixEnd = index
        break
      }
      if (
        typeof payload.turn_id !== 'string' ||
        !payload.turn_id ||
        payload.turn_id.length > 1024 ||
        starts.has(payload.turn_id) ||
        activeTurn
      )
        throw new Error(
          'Native Fork has duplicate, missing or unpaired canonical TurnStarted identity.',
        )
      starts.add(payload.turn_id)
      activeTurn = payload.turn_id
      turnIdentityEvidence.push({
        type: 'task_started',
        turnId: payload.turn_id,
        status: 'started',
      })
      if (payload.turn_id === input.nativeTurnId) selectedStart = index
    } else if (['task_complete', 'turn_complete'].includes(String(payload.type))) {
      if (
        typeof payload.turn_id !== 'string' ||
        activeTurn !== payload.turn_id ||
        completed.has(payload.turn_id) ||
        payload.error != null ||
        (payload.status != null && payload.status !== 'completed')
      )
        throw new Error(
          'Native Fork has an unmatched or unsuccessful canonical completion identity.',
        )
      completed.add(payload.turn_id)
      terminalTurns.push(payload.turn_id)
      activeTurn = undefined
      turnIdentityEvidence.push({
        type: 'task_complete',
        turnId: payload.turn_id,
        status: 'completed',
      })
      if (payload.turn_id === input.nativeTurnId) selectedComplete = index
    } else if (payload.type === 'turn_aborted') {
      if (
        typeof payload.turn_id !== 'string' ||
        activeTurn !== payload.turn_id ||
        payload.turn_id === input.nativeTurnId
      )
        throw new Error('Native Fork has an unmatched or selected unsuccessful terminal identity.')
      terminalTurns.push(payload.turn_id)
      activeTurn = undefined
      turnIdentityEvidence.push({
        type: payload.type,
        turnId: payload.turn_id,
        status: 'aborted',
      })
    } else if (['task_aborted', 'turn_failed', 'task_failed'].includes(String(payload.type)))
      throw new Error('Unsupported native terminal marker; no canonical retention proof exists.')
  }
  if (selectedStart < 0 || selectedComplete < selectedStart || activeTurn)
    throw new Error('Codex has no exact paired completed-turn native boundary.')
  if (input.witness && prefixEnd !== raw.entries.length)
    throw new Error(
      'The Native Fork candidate contains another canonical turn after its frozen cutoff.',
    )
  const opaqueRecords: RecordValue[] = []
  const metadata = (value: unknown): RecordValue | undefined => {
    if (value == null) return undefined
    const result = object(value)
    if (result.client_authored !== undefined && typeof result.client_authored !== 'boolean')
      throw new Error('Native harness metadata has an invalid client-authored flag.')
    return { ...result, client_authored: result.client_authored ?? false }
  }
  for (let index = 0; index < prefixEnd; index++) {
    const entry = raw.entries[index]!,
      payload = object(entry.payload)
    if (entry.type === 'response_item') {
      const value = { ...payload }
      if (value.type === 'message') delete value.id // Only this top-level ID is provider-assigned.
      const harness = metadata(entry.metadata)
      opaqueRecords.push({
        type: entry.type,
        payload: value,
        ...(harness ? { metadata: harness } : {}),
      })
    } else if (entry.type === 'compacted') {
      if (typeof payload.message !== 'string')
        throw new Error('Native compaction message is missing.')
      const value = { ...payload }
      for (const key of ['compaction_response_id', 'latest_token_usage_record']) value[key] ??= null
      for (const key of [
        'replacement_history',
        'replacement_history_metadata',
        'guardian_history',
        'retained_context',
        'mcp_resource_origins',
        'window_number',
        'first_window_id',
        'previous_window_id',
        'window_id',
        'resume_metadata',
      ])
        if (value[key] == null) delete value[key]
      if (value.replacement_history != null && !Array.isArray(value.replacement_history))
        throw new Error('Native replacement history is not a complete array.')
      if (value.replacement_history_metadata != null) {
        if (
          !Array.isArray(value.replacement_history_metadata) ||
          !Array.isArray(value.replacement_history) ||
          value.replacement_history_metadata.length !== value.replacement_history.length
        )
          throw new Error(
            'Native replacement history metadata does not match its complete history.',
          )
        value.replacement_history_metadata = value.replacement_history_metadata.map((item) =>
          metadata(object(item)),
        )
      }
      opaqueRecords.push({ type: entry.type, payload: value })
    } else if (entry.type === 'event_msg') {
      if (payload.type === 'error') {
        if (
          typeof payload.message !== 'string' ||
          Object.keys(payload).some((key) => !['type', 'message', 'codex_error_info'].includes(key))
        )
          throw new Error('Unsupported fields in a native error control record.')
        // Fixed-version replay and fork both exclude this standalone diagnostic.
        // Terminal error/status evidence is validated above and is never dropped.
        continue
      }
      if (
        ['task_started', 'turn_started', 'task_complete', 'turn_complete'].includes(
          String(payload.type),
        )
      )
        continue
      if (payload.type === 'thread_settings_applied') {
        if (input.witness && payload.thread_id !== input.nativeSessionId)
          throw new Error('Native Fork setup settings belong to another thread.')
        continue
      }
      if (payload.type === 'thread_rolled_back')
        throw new Error(
          'Native rollback context changes are not supported by this prefix verifier.',
        )
      // Canonical events are retained in full rather than guessed to be inert.
      opaqueRecords.push({ type: entry.type, payload })
    } else if (entry.type !== 'session_meta' && entry.type !== 'turn_context') {
      throw new Error(
        `Unsupported native context record type: ${typeof entry.type === 'string' ? entry.type.slice(0, 128) : 'invalid'}. It was not ignored.`,
      )
    }
  }
  if (!opaqueRecords.length) throw new Error('Codex native prefix is empty.')
  if (input.responseHash)
    validateCodexAnswer(
      raw.entries,
      selectedStart,
      selectedComplete,
      input.responseHash,
      input.answerFormat,
    )
  const prefix = { domain: 'codex-native-prefix-v2', opaqueRecords, turnIdentityEvidence }
  const prefixHash = hash(prefix)
  if (
    input.witness &&
    (prefixHash !== input.witness.sourcePrefixHash ||
      prefixHash !== input.witness.candidatePrefixHash)
  )
    throw new Error(
      'Codex Fork complete native context or ordered turn identity evidence differs from the frozen prefix.',
    )
  const idMap = terminalTurns.map((turnId): [string, string] => [turnId, turnId])
  if (input.witness && JSON.stringify(input.witness.idMap) !== JSON.stringify(idMap))
    throw new Error('Codex retained canonical Turn identity map differs from its witness.')
  const initializedVerified =
    Boolean(input.witness?.initializedAt) &&
    raw.rawHash === input.witness?.initializedPrefixHash &&
    raw.rawBytes === input.witness?.initializedPrefixBytes &&
    raw.rawRecords === input.witness?.initializedPrefixRecords
  return {
    initializedVerified,
    nativeSessionId: input.nativeSessionId,
    nativeCutId: input.nativeTurnId!,
    prefixHash,
    prefixBytes: Buffer.byteLength(JSON.stringify(prefix)),
    prefixRecords: opaqueRecords.length,
    idMap,
    rawHash: raw.rawHash,
    rawBytes: raw.rawBytes,
    rawRecords: raw.rawRecords,
    nativeStorageRoot: storageRoot,
    nativePath,
  }
}

if (parentPort) {
  const input: unknown = workerData
  if (!isInput(input)) throw new Error('Invalid native Fork worker input.')
  void (input.provider === 'claude' ? claude(input) : codex(input)).then(
    (result) => parentPort!.postMessage({ type: 'result', result }),
    (error: unknown) =>
      parentPort!.postMessage({
        type: 'error',
        error: error instanceof Error ? error.message : 'Native Fork file inspection failed.',
        code: error instanceof Error ? Reflect.get(error, 'code') : undefined,
      }),
  )
}
