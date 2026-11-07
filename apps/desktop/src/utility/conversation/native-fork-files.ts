import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type {
  AgentNativeForkBoundary,
  AgentNativeForkWitness,
  ClaudePlanCheckpointSource,
} from '@pact/agent-runtime'

import {
  collaborationRetainedPlanSchema,
  type CollaborationRetainedPlan,
  ipcTrafficMeasurementSchema,
  claudePlanCheckpointSchema,
  claudePlanCheckpointRequestSchema,
  claudePlanCheckpointWorkingBytes,
  type ClaudePlanCheckpoint,
} from '@pact/contracts'
import {
  collaborationReviewObservationSchema,
  type CollaborationReviewObservation,
} from '@pact/contracts'

import { LogicalIpcWorkerTraffic, observeWorkerTraffic } from '../../shared/logical-ipc-traffic'
import { AgentExecutionError } from './agent-execution-error'
import {
  isClaudePlanState,
  type ClaudePlanBinding,
  type ClaudePlanState,
} from './claude-native-plan'
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
  action: 'prepare' | 'fork' | 'inspect' | 'read' | 'read-answer' | 'verify-seed' | 'exists'
  expectedSeed?: Array<{ id: string; hash: string; images: number }>
  rejectAdditionalWork?: boolean
  /** Exact live Hook cutoff; the prefix excludes this operation. */
  planHook?: { id: string; inputFingerprint: string }
  /** One full-root proof after native termination; never a live prefix. */
  terminalPlanSubmission?: { id: string; promptId: string; inputFingerprint: string }
  /** Exact successful host-tool intent, authenticated only after root drain. */
  terminalPlanRetention?: {
    id: string
    promptId: string
    toolName: string
    inputFingerprint: string
  }
  includePlan?: boolean
  planCheckpoint?: ClaudePlanCheckpoint
  lastDispatchedPhase?: 'fork' | 'initialize'
  cwd: string
  nativeSessionId: string
  nativeTurnId?: string
  /** Private exact ordered provider input identities, including the root. */
  nativeInputIds?: readonly string[]
  responseHash?: string
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
  plan?: { nativeId: string; text: string }
  planBinding?: ClaudePlanBinding
  planState?: ClaudePlanState
  terminalPlanSubmission?: NonNullable<NativeForkFileInput['terminalPlanSubmission']>
  terminalPlanRetention?: NonNullable<NativeForkFileInput['terminalPlanRetention']>
  retainedPlan?: CollaborationRetainedPlan
  planUnavailable?: true
  reviewResult?: CollaborationReviewObservation
  nativeStorageRoot: string
  nativePath: string
}

export interface NativeSeedVerificationResult {
  nativeSessionId: string
  seedVerified: true
}

export interface NativeSessionExistenceResult {
  nativeSessionId: string
  exists: boolean
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
    (value.plan !== undefined &&
      (!isObject(value.plan) ||
        typeof value.plan.nativeId !== 'string' ||
        !value.plan.nativeId ||
        value.plan.nativeId.length > 1024 ||
        typeof value.plan.text !== 'string')) ||
    (value.retainedPlan !== undefined &&
      !collaborationRetainedPlanSchema.safeParse(value.retainedPlan).success) ||
    (value.terminalPlanSubmission !== undefined &&
      (!isObject(value.terminalPlanSubmission) ||
        typeof value.terminalPlanSubmission.id !== 'string' ||
        !value.terminalPlanSubmission.id ||
        value.terminalPlanSubmission.id.length > 1024 ||
        typeof value.terminalPlanSubmission.promptId !== 'string' ||
        !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(
          value.terminalPlanSubmission.promptId,
        ) ||
        !digest(value.terminalPlanSubmission.inputFingerprint) ||
        value.planState !== undefined ||
        value.planUnavailable !== undefined ||
        (value.plan === undefined) === (value.retainedPlan === undefined))) ||
    (value.terminalPlanRetention !== undefined &&
      (!isObject(value.terminalPlanRetention) ||
        typeof value.terminalPlanRetention.id !== 'string' ||
        !value.terminalPlanRetention.id ||
        value.terminalPlanRetention.id.length > 1024 ||
        typeof value.terminalPlanRetention.promptId !== 'string' ||
        !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(
          value.terminalPlanRetention.promptId,
        ) ||
        typeof value.terminalPlanRetention.toolName !== 'string' ||
        !/^mcp__.+__retain_current_plan$/u.test(value.terminalPlanRetention.toolName) ||
        value.terminalPlanRetention.toolName.length > 1024 ||
        !digest(value.terminalPlanRetention.inputFingerprint) ||
        value.plan !== undefined ||
        value.retainedPlan !== undefined ||
        value.planState !== undefined ||
        value.planUnavailable !== undefined ||
        value.terminalPlanSubmission !== undefined)) ||
    (value.planState !== undefined && !isClaudePlanState(value.planState)) ||
    (value.planUnavailable !== undefined && value.planUnavailable !== true) ||
    (value.planBinding !== undefined &&
      (!isObject(value.planBinding) ||
        typeof value.planBinding.promptId !== 'string' ||
        !value.planBinding.promptId ||
        value.planBinding.promptId.length > 1024 ||
        typeof value.planBinding.path !== 'string' ||
        !value.planBinding.path ||
        value.planBinding.path.length > 4096)) ||
    (value.reviewResult !== undefined &&
      !collaborationReviewObservationSchema.safeParse(value.reviewResult).success)
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
  private terminateWorker: (() => Promise<void>) | undefined

  constructor(
    private readonly ipcTraffic?: LogicalIpcWorkerTraffic,
    private readonly observePhysicalOperation?: (
      signal: AbortSignal,
      completion: Promise<void>,
    ) => void,
  ) {}

  get active(): boolean {
    return this.worker !== undefined
  }

  async execute(
    input: NativeForkFileInput,
    signal: AbortSignal,
    candidate?: (result: NativeForkFileResult) => Promise<void>,
    resolveReference?: (
      nativeSessionId: string,
      signal: AbortSignal,
    ) => Promise<NativeForkHistoryReference>,
  ): Promise<NativeForkFileResult> {
    if (
      input.action === 'read-answer' ||
      input.action === 'verify-seed' ||
      input.action === 'exists'
    )
      throw new Error('Native answers and seeds must use their typed readback interfaces.')
    return this.run(input, signal, result, candidate, resolveReference)
  }

  async readAnswer(
    input: Pick<
      NativeForkFileInput,
      | 'cwd'
      | 'nativeSessionId'
      | 'nativeInputIds'
      | 'storageRoot'
      | 'path'
      | 'planHook'
      | 'terminalPlanSubmission'
      | 'terminalPlanRetention'
      | 'includePlan'
    > & {
      nativeTurnId: string
      planCheckpoint?: ClaudePlanCheckpointSource | undefined
    },
    signal: AbortSignal,
  ): Promise<NativeForkAnswerResult> {
    const { planCheckpoint, ...request } = input
    if (planCheckpoint) claudePlanCheckpointSchema.parse(planCheckpoint.checkpoint)
    const answer = await this.run(
      {
        ...request,
        ...(planCheckpoint ? { planCheckpoint: planCheckpoint.checkpoint } : {}),
        provider: 'claude',
        action: 'read-answer',
      },
      signal,
      answerResult,
      undefined,
      undefined,
      planCheckpoint,
    )
    if (
      answer.nativeSessionId !== input.nativeSessionId ||
      answer.nativeTurnId !== input.nativeTurnId
    )
      throw new Error('Native collaboration answer belongs to another Session or root input.')
    if (
      input.terminalPlanSubmission &&
      (answer.terminalPlanSubmission?.id !== input.terminalPlanSubmission.id ||
        answer.terminalPlanSubmission.promptId !== input.terminalPlanSubmission.promptId ||
        answer.terminalPlanSubmission.inputFingerprint !==
          input.terminalPlanSubmission.inputFingerprint)
    )
      throw new Error('The terminal plan proof does not match the exact permission intent.')
    if (
      input.terminalPlanRetention &&
      (!answer.terminalPlanRetention ||
        ['id', 'promptId', 'toolName', 'inputFingerprint'].some(
          (key) =>
            Reflect.get(answer.terminalPlanRetention!, key) !==
            Reflect.get(input.terminalPlanRetention!, key),
        ))
    )
      throw new Error('The terminal retention proof differs from its exact host-tool intent.')
    return answer
  }

  async verifySeed(
    input: Pick<NativeForkFileInput, 'cwd' | 'nativeSessionId'> & {
      expected: ReadonlyMap<string, { hash: string; images: number }>
      rejectAdditionalWork: boolean
    },
    signal: AbortSignal,
  ): Promise<void> {
    await this.run(
      {
        provider: 'claude',
        action: 'verify-seed',
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId,
        expectedSeed: [...input.expected].map(([id, value]) => ({
          id,
          hash: value.hash,
          images: value.images,
        })),
        rejectAdditionalWork: input.rejectAdditionalWork,
      },
      signal,
      (value): NativeSeedVerificationResult => {
        if (
          !isObject(value) ||
          value.nativeSessionId !== input.nativeSessionId ||
          value.seedVerified !== true
        )
          throw new Error('The native seed verification belongs to another Session.')
        return { nativeSessionId: input.nativeSessionId, seedVerified: true }
      },
    )
  }

  async exists(
    input: Pick<NativeForkFileInput, 'cwd' | 'nativeSessionId'>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const existence = await this.run(
      { ...input, provider: 'claude', action: 'exists' },
      signal,
      (value): NativeSessionExistenceResult => {
        if (
          !isObject(value) ||
          value.nativeSessionId !== input.nativeSessionId ||
          typeof value.exists !== 'boolean'
        )
          throw new Error('The native existence verification belongs to another Session.')
        return { nativeSessionId: input.nativeSessionId, exists: value.exists }
      },
    )
    return existence.exists
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
    checkpointSource?: ClaudePlanCheckpointSource,
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
    let physicallySettled = false
    let workerExited = false
    let checkpointRequested = false
    let checkpointReading: Promise<void> | undefined
    const physical = Promise.withResolvers<void>()
    this.observePhysicalOperation?.(signal, physical.promise)
    let termination: Promise<void> | undefined
    const settlePhysical = (): void => {
      if (physicallySettled || !workerExited || checkpointReading) return
      physicallySettled = true
      reservation.release()
      if (this.worker === worker) {
        this.worker = undefined
        this.terminateWorker = undefined
      }
      physical.resolve()
    }
    const terminate = (): Promise<void> => {
      if (physicallySettled) return Promise.resolve()
      if (!termination) {
        try {
          termination = worker.terminate().then(() => {
            workerExited = true
            settlePhysical()
            return undefined
          })
        } catch (error) {
          return Promise.reject(error)
        }
        termination = termination.catch((error: unknown) => {
          termination = undefined
          throw error
        })
      }
      return termination
    }
    this.terminateWorker = async () => {
      references.abort()
      await terminate()
      await physical.promise
    }
    worker.once('exit', () => {
      workerExited = true
      settlePhysical()
    })
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
            if (!active) return
            if (message.type === 'plan_checkpoint_request') {
              const meta = input.planCheckpoint,
                request = { ...message }
              Reflect.deleteProperty(request, 'ipcMeasurement')
              if (
                !claudePlanCheckpointRequestSchema.safeParse(request).success ||
                !meta ||
                !checkpointSource ||
                checkpointRequested ||
                !Number.isSafeInteger(claudePlanCheckpointWorkingBytes(meta)) ||
                claudePlanCheckpointWorkingBytes(meta) > NATIVE_OWNER_WORKING_BYTES
              ) {
                reject(new Error('Invalid or oversized native plan checkpoint request.'))
                return
              }
              checkpointRequested = true
              checkpointReading = Promise.resolve()
                .then(async () => {
                  signal.throwIfAborted()
                  references.signal.throwIfAborted()
                  const text = await checkpointSource.read(
                    AbortSignal.any([signal, references.signal]),
                  )
                  const document = meta.basis.document
                  if (
                    text.length !== document.chars ||
                    Buffer.byteLength(text) !== document.bytes ||
                    createHash('sha256').update(text).digest('hex') !== document.sha256
                  )
                    throw new Error('The native plan checkpoint body does not match its source.')
                  if (active && !signal.aborted && !references.signal.aborted)
                    worker.postMessage({ type: 'plan_checkpoint_body', text })
                  return undefined
                })
                .catch(reject)
                .finally(() => {
                  checkpointReading = undefined
                  settlePhysical()
                })
            } else if (message.type === 'history_reference') {
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
        await terminate()
      } catch (error) {
        // Only this admitted terminal read joins its exact physical owner. Busy requests never queue.
        if (input.terminalPlanSubmission || input.terminalPlanRetention) await physical.promise
        // oxlint-disable-next-line no-unsafe-finally -- A failed physical termination must override a logical success; its exact Worker has now exited.
        throw error
      }
    }
  }

  async dispose(): Promise<void> {
    await this.terminateWorker?.()
  }
}
