import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { AgentNativeForkBoundary, AgentNativeForkWitness } from '@pact/agent-runtime'

import { ipcTrafficMeasurementSchema } from '@pact/contracts'
import {
  collaborationResultSchema,
  collaborationAnswerFormatSchema,
  type CollaborationResult,
  type CollaborationAnswerFormat,
} from '@pact/contracts'

import { LogicalIpcWorkerTraffic, observeWorkerTraffic } from '../../shared/logical-ipc-traffic'
import { AgentExecutionError } from './agent-execution-error'
import { NativeWorkingMemory, NATIVE_OWNER_WORKING_BYTES } from './native-working-memory'

function digest(hash: unknown): boolean {
  return typeof hash === 'string' && /^[a-f\d]{64}$/u.test(hash)
}
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function isResult(value: unknown): value is NativeForkFileResult {
  if (!isObject(value)) return false
  const item = value
  if (
    !item ||
    typeof item !== 'object' ||
    ![item.nativeSessionId, item.nativeCutId].every(
      (id) => typeof id === 'string' && id.length > 0 && id.length <= 1024,
    ) ||
    (item.initializedVerified != null && typeof item.initializedVerified !== 'boolean') ||
    !digest(item.prefixHash) ||
    (item.rawHash !== '' && !digest(item.rawHash)) ||
    typeof item.prefixBytes !== 'number' ||
    !Number.isSafeInteger(item.prefixBytes) ||
    item.prefixBytes <= 0 ||
    item.prefixBytes > 32 * 1024 * 1024 ||
    typeof item.prefixRecords !== 'number' ||
    !Number.isSafeInteger(item.prefixRecords) ||
    item.prefixRecords <= 0 ||
    item.prefixRecords > 10_000 ||
    typeof item.rawBytes !== 'number' ||
    !Number.isSafeInteger(item.rawBytes) ||
    item.rawBytes < 0 ||
    item.rawBytes > 32 * 1024 * 1024 ||
    typeof item.rawRecords !== 'number' ||
    !Number.isSafeInteger(item.rawRecords) ||
    item.rawRecords < 0 ||
    item.rawRecords > 10_000 ||
    !Array.isArray(item.idMap) ||
    item.idMap.length > 10_000 ||
    !item.idMap.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 1024),
    ) ||
    (item.nativeStorageRoot != null &&
      (typeof item.nativeStorageRoot !== 'string' || item.nativeStorageRoot.length > 4096)) ||
    (item.nativePath != null &&
      (typeof item.nativePath !== 'string' || item.nativePath.length > 4096)) ||
    (item.nativeProjectKey != null &&
      (typeof item.nativeProjectKey !== 'string' || item.nativeProjectKey.length > 256)) ||
    (item.nativeProjectDevice != null &&
      (typeof item.nativeProjectDevice !== 'string' || item.nativeProjectDevice.length > 64)) ||
    (item.nativeProjectInode != null &&
      (typeof item.nativeProjectInode !== 'string' || item.nativeProjectInode.length > 64)) ||
    new Set(item.idMap.map(([id]) => id)).size !== item.idMap.length ||
    new Set(item.idMap.map(([, id]) => id)).size !== item.idMap.length ||
    Buffer.byteLength(JSON.stringify(item)) > 1024 * 1024
  )
    return false
  return true
}
function result(value: unknown): NativeForkFileResult {
  if (!isResult(value)) throw new Error('Invalid or oversized native Fork worker result.')
  return value
}

export interface NativeForkFileInput {
  provider: 'claude' | 'codex'
  action: 'prepare' | 'fork' | 'inspect' | 'read' | 'read-answer'
  lastDispatchedPhase?: 'fork' | 'initialize'
  cwd: string
  nativeSessionId: string
  nativeTurnId?: string
  responseHash?: string
  answerFormat?: CollaborationAnswerFormat
  source?: AgentNativeForkBoundary
  witness?: AgentNativeForkWitness
  storageRoot?: string
  path?: string
  historyMode?: 'legacy' | 'paginated'
}

export interface NativeForkHistoryReference {
  nativeSessionId: string
  path: string
  historyMode: 'legacy' | 'paginated'
}

export interface NativeForkFileResult {
  nativeSessionId: string
  nativeCutId: string
  prefixHash: string
  prefixBytes: number
  prefixRecords: number
  idMap: Array<[string, string]>
  rawHash: string
  rawBytes: number
  rawRecords: number
  nativeStorageRoot?: string
  nativePath?: string
  initializedVerified?: boolean
  nativeProjectKey?: string
  nativeProjectDevice?: string
  nativeProjectInode?: string
}

export interface NativeForkAnswerResult {
  nativeSessionId: string
  nativeTurnId: string
  answer?: string
  submittedReport?: CollaborationResult
  nativeStorageRoot: string
  nativePath: string
}

function isAnswerResult(value: unknown): value is NativeForkAnswerResult {
  if (
    !isObject(value) ||
    ![value.nativeSessionId, value.nativeTurnId].every(
      (id) => typeof id === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(id),
    ) ||
    ![value.nativeStorageRoot, value.nativePath].every(
      (path) => typeof path === 'string' && path.length > 0 && path.length <= 4096,
    ) ||
    (value.answer !== undefined && typeof value.answer !== 'string') ||
    (value.submittedReport !== undefined &&
      !collaborationResultSchema.safeParse(value.submittedReport).success)
  )
    return false
  return true
}

function answerResult(value: unknown): NativeForkAnswerResult {
  if (!isAnswerResult(value)) throw new Error('Invalid or oversized native collaboration answer.')
  return value
}

/** One bounded off-event-loop reader per Adapter. No native process or transcript cache. */
export class NativeForkFiles {
  private worker: Worker | undefined

  constructor(private readonly ipcTraffic?: LogicalIpcWorkerTraffic) {}

  async execute(
    input: NativeForkFileInput,
    signal: AbortSignal,
    candidate?: (result: NativeForkFileResult) => Promise<void>,
    resolveReference?: (
      nativeSessionId: string,
      signal: AbortSignal,
    ) => Promise<NativeForkHistoryReference>,
  ): Promise<NativeForkFileResult> {
    if (input.action === 'read-answer')
      throw new Error('Native collaboration answers must use the readAnswer interface.')
    return this.run(input, signal, result, candidate, resolveReference)
  }

  async readAnswer(
    input: Pick<
      NativeForkFileInput,
      'cwd' | 'nativeSessionId' | 'storageRoot' | 'path' | 'answerFormat'
    > & {
      nativeTurnId: string
    },
    signal: AbortSignal,
  ): Promise<NativeForkAnswerResult> {
    const answer = await this.run(
      {
        ...input,
        provider: 'claude',
        action: 'read-answer',
        answerFormat: input.answerFormat ?? collaborationAnswerFormatSchema.value,
      },
      signal,
      answerResult,
    )
    if (
      answer.nativeSessionId !== input.nativeSessionId ||
      answer.nativeTurnId !== input.nativeTurnId
    )
      throw new Error('Native collaboration answer belongs to another Session or root input.')
    return answer
  }

  private async run<T>(
    input: NativeForkFileInput,
    signal: AbortSignal,
    validate: (value: unknown) => T,
    candidate?: (result: NativeForkFileResult) => Promise<void>,
    resolveReference?: (
      nativeSessionId: string,
      signal: AbortSignal,
    ) => Promise<NativeForkHistoryReference>,
  ): Promise<T> {
    signal.throwIfAborted()
    if (this.worker)
      throw new AgentExecutionError(
        'runtime_incompatible',
        'A native Fork file operation is already active.',
        false,
      )
    const reservation = new NativeWorkingMemory().reserve(NATIVE_OWNER_WORKING_BYTES)
    const traffic = this.ipcTraffic?.collector('utility-native-fork')
    const initialization = traffic ? { input, measure: true } : input
    let worker: Worker
    try {
      worker = new Worker(join(__dirname, 'native-fork-worker.js'), {
        workerData: initialization,
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 8,
          stackSizeMb: 4,
        },
      })
    } catch (error) {
      reservation.release()
      throw error
    }
    traffic?.record('utility-native-fork.init', 'business', initialization)
    observeWorkerTraffic(
      worker,
      traffic,
      'utility-native-fork.control',
      'native-fork-utility.reply',
      'business',
      false,
    )
    this.worker = worker
    let active = true
    let referencePending = false
    const references = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      return await new Promise<T>((resolve, reject) => {
        abort = () =>
          reject(
            new AgentExecutionError(
              'runtime_incompatible',
              input.action === 'read-answer'
                ? 'Native answer inspection was cancelled.'
                : 'Native Fork file inspection was cancelled; possible writes remain unconfirmed.',
              false,
            ),
          )
        timer = setTimeout(
          () =>
            reject(
              new AgentExecutionError(
                'runtime_incompatible',
                input.action === 'read-answer'
                  ? 'Native answer inspection exceeded its ten-second deadline.'
                  : 'Native Fork file operation exceeded its ten-second deadline; possible writes remain unconfirmed.',
                false,
              ),
            ),
          10_000,
        )
        signal.addEventListener('abort', abort, { once: true })
        worker.on(
          'message',
          (message: {
            type: string
            result?: unknown
            error?: string
            code?: string
            nativeSessionId?: string
          }) => {
            if (traffic) {
              const measured = ipcTrafficMeasurementSchema.safeParse(
                Reflect.get(message, 'ipcMeasurement'),
              )
              if (measured.success)
                traffic.recordMeasurement('native-fork-utility.reply', 'business', measured.data)
              else traffic.invalidate('unvalidated_message')
            }
            if (message.type === 'history_reference') {
              const id = message.nativeSessionId
              if (
                input.provider !== 'codex' ||
                !resolveReference ||
                referencePending ||
                typeof id !== 'string' ||
                !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(id)
              ) {
                reject(new Error('Invalid Native Fork history reference request.'))
                return
              }
              referencePending = true
              void resolveReference(id, AbortSignal.any([signal, references.signal]))
                .then((reference) => {
                  if (
                    reference.nativeSessionId !== id ||
                    typeof reference.path !== 'string' ||
                    !reference.path ||
                    reference.path.length > 4096 ||
                    !['legacy', 'paginated'].includes(reference.historyMode) ||
                    Buffer.byteLength(JSON.stringify(reference)) > 8192
                  )
                    throw new Error('Invalid Native Fork history reference resolution.')
                  referencePending = false
                  if (active && !references.signal.aborted && !signal.aborted)
                    worker.postMessage({ type: 'history_reference_resolved', reference })
                  return undefined
                })
                .catch(reject)
            } else if (message.type === 'candidate' && message.result) {
              if (!candidate) {
                reject(new Error('Native candidate persistence callback is missing.'))
                return
              }
              let validated: NativeForkFileResult
              try {
                validated = result(message.result)
              } catch (error) {
                reject(error)
                return
              }
              void candidate(validated)
                .then(() => {
                  if (active && !signal.aborted) worker.postMessage({ type: 'candidate_committed' })
                  return undefined
                })
                .catch(reject)
            } else if (message.type === 'result' && message.result) {
              try {
                resolve(validate(message.result))
              } catch (error) {
                reject(error)
              }
            } else if (message.type === 'error')
              reject(
                Object.assign(
                  new AgentExecutionError(
                    'protocol_error',
                    message.error ?? 'Native Fork file inspection failed.',
                    false,
                  ),
                  { code: message.code },
                ),
              )
            else reject(new Error('Invalid Native Fork worker response.'))
          },
        )
        worker.once('error', reject)
        worker.once('exit', (code) =>
          reject(new Error(`Native Fork worker ended without a result (${code}).`)),
        )
      })
    } finally {
      active = false
      references.abort()
      clearTimeout(timer)
      if (abort) signal.removeEventListener('abort', abort)
      try {
        await worker.terminate()
      } finally {
        reservation.release()
        if (this.worker === worker) this.worker = undefined
      }
    }
  }

  async dispose(): Promise<void> {
    const worker = this.worker
    if (worker) await worker.terminate()
    if (this.worker === worker) this.worker = undefined
  }
}
