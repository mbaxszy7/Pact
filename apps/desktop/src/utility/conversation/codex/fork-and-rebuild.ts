import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type {
  AgentNativeCheckContext,
  AgentNativeCheckOperation,
  AgentNativeContextRebuildInput,
  AgentNativeContextRebuildResult,
  AgentNativeForkBoundary,
  AgentNativeForkInput,
  AgentNativeForkInspection,
  AgentNativeForkResult,
  AgentNativeForkSourceInput,
  AgentNativeForkWitness,
  AgentNativeInitializedBindingProbeInput,
  AgentNativeInputProbeInput,
  AgentNativeProbeInput,
  AgentTitleEnrichmentInput,
} from '@pact/agent-runtime'
import type {
  NativeContextRebuildChunk,
  NativeEvidenceIdentity,
  NativeInitializationWitness,
  NativeProbeResult,
} from '@pact/contracts'

import { nativeCodexSkillListSchema } from '@pact/contracts'

import {
  AgentExecutionError,
  classifyAgentError,
  NativeCapacityError,
  PermissionModeRejectedError,
} from '../agent-execution-error'
import { CodexAppServerConnection } from '../codex-app-server-connection'
import { readCodexInitializationRollout } from '../codex-native-rollout'
import { codexProcessEnvironment } from '../codex-process-environment'
import { type NativeForkFileResult } from '../native-fork-files'
import {
  nativeImageBlock,
  nativeImagePreparationBytes,
  requireNativeImageReference,
} from '../native-image-content'
import { safeNativePermissionText } from '../native-permission-wait'
import { nativeSkillCatalog } from '../native-skill-catalog'
import {
  CODEX_INJECT_TARGET_BYTES,
  CODEX_THREAD_RPC_TIMEOUT_MS,
  CODEX_TITLE_TIMEOUT_MS,
  MAX_LOADED_THREADS,
  confirmPermissionMode,
  historicalOutput,
  matchingTurn,
  observeThreadTitle,
  probeIdentity,
  storedTurnOutcome,
  threadTitle,
  type ApprovalItem,
  type CodexAdapterRuntime,
  type CodexLifecycleCoordinatorPort,
  type CodexNativeForkOwner,
  type CodexRunConfiguration,
  type NativeRebuildReceipt,
} from './types'

/**
 * Deep lifecycle coordinator for Codex native Fork, Context Rebuild,
 * rollout verification, cold status/input probing, skills, and title sync.
 */
export class CodexLifecycleCoordinator implements CodexLifecycleCoordinatorPort {
  constructor(private readonly runtime: CodexAdapterRuntime) {}

  async prepareNativeFork(
    input: AgentNativeForkSourceInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkBoundary> {
    const live = await this.runtime.connections.ensureConnection(input.cwd)
    await this.runtime.connections.initializeConnection(live, signal)
    return this.withNativeInspectionConnection(
      live,
      input.cwd,
      signal,
      async (reader, readSignal) => {
        const prefix = await this.readForkRollout(
          reader,
          input.nativeSessionId,
          input.nativeTurnId,
          input.cwd,
          readSignal,
          undefined,
          input.responseHash,
        )
        const turns = await this.readNativeTurns(
          reader,
          input.nativeSessionId,
          readSignal,
          input.nativeTurnId,
        )
        const turn = turns.find((value) => Reflect.get(value, 'id') === input.nativeTurnId)
        if (
          !turn ||
          Reflect.get(turn, 'status') !== 'completed' ||
          Reflect.get(turn, 'error') != null
        )
          throw new AgentExecutionError(
            'runtime_incompatible',
            'Codex Fork requires the exact completed native Turn.',
            false,
          )
        return {
          nativeSessionId: input.nativeSessionId,
          nativeTurnId: input.nativeTurnId,
          nativeCutId: input.nativeTurnId,
          bindingGeneration: input.bindingGeneration,
          throughSequence: input.throughSequence,
          deliveryCursor: input.deliveryCursor,
          prefixHash: prefix.prefixHash,
          prefixRecords: prefix.prefixRecords,
          prefixBytes: prefix.prefixBytes,
        }
      },
    )
  }

  private async readForkRollout(
    connection: CodexAppServerConnection,
    nativeSessionId: string,
    nativeTurnId: string,
    cwd: string,
    signal: AbortSignal,
    witness?: AgentNativeForkWitness,
    responseHash?: string,
  ): Promise<NativeForkFileResult> {
    const read = await connection.request(
      'thread/read',
      { threadId: nativeSessionId, includeTurns: false },
      { timeoutMs: 10_000, signal },
    )
    const thread = Reflect.get(Reflect.get(read, 'result') ?? {}, 'thread')
    if (
      Reflect.get(read, 'error') ||
      thread?.id !== nativeSessionId ||
      typeof thread.path !== 'string' ||
      !this.runtime.processStorageRoot
    )
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Codex did not provide the exact native Fork rollout identity.',
        false,
      )
    // The omitted fixed-wire default is legacy. Paginated forks retain an exact
    // parent byte/ordinal prefix; the Worker resolves it through this reader.
    if (
      thread.historyMode !== undefined &&
      thread.historyMode !== 'legacy' &&
      thread.historyMode !== 'paginated'
    )
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Codex returned an unknown native history format for Fork.',
        false,
      )
    if (witness && thread.forkedFromId !== witness.sourceNativeSessionId)
      throw new Error('Codex native Fork thread lineage mismatch.')
    return this.runtime.nativeForkFiles.execute(
      {
        provider: 'codex',
        action: 'read',
        cwd,
        nativeSessionId,
        nativeTurnId,
        path: thread.path,
        storageRoot: this.runtime.processStorageRoot,
        historyMode: thread.historyMode ?? 'legacy',
        ...(witness ? { witness } : {}),
        ...(responseHash ? { responseHash } : {}),
      },
      signal,
      undefined,
      async (id, referenceSignal) => {
        const response = await connection.request(
          'thread/read',
          { threadId: id, includeTurns: false },
          { timeoutMs: 10_000, signal: referenceSignal },
        )
        const parent = Reflect.get(Reflect.get(response, 'result') ?? {}, 'thread')
        if (
          Reflect.get(response, 'error') ||
          parent?.id !== id ||
          typeof parent.path !== 'string' ||
          (parent.historyMode !== 'legacy' && parent.historyMode !== 'paginated')
        )
          throw new Error('Codex could not resolve the exact native history parent.')
        return { nativeSessionId: id, path: parent.path, historyMode: parent.historyMode }
      },
    )
  }

  async inspectNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkInspection> {
    if (!input.nativeSessionId || !input.witness)
      return {
        kind: 'unconfirmed',
        reason: 'Codex Fork candidate identity or native witness is unconfirmed.',
      }
    const witness = input.witness
    if (
      witness.nativeSessionId !== input.nativeSessionId ||
      witness.sourceNativeSessionId !== input.source.nativeSessionId ||
      witness.sourceCutId !== input.source.nativeCutId ||
      witness.sourcePrefixHash !== input.source.prefixHash
    )
      return {
        kind: 'unconfirmed',
        reason: 'Codex Fork witness belongs to another source or settings revision.',
      }
    try {
      const live = await this.runtime.connections.ensureConnection(input.cwd)
      await this.runtime.connections.initializeConnection(live, signal)
      const prefix = await this.withNativeInspectionConnection(
        live,
        input.cwd,
        signal,
        (reader, readSignal) =>
          this.readForkRollout(
            reader,
            input.nativeSessionId!,
            input.source.nativeTurnId,
            input.cwd,
            readSignal,
            witness,
          ),
      )
      const owner = this.runtime.nativeForkOwners.get(input.operationId)
      const ownerSettled =
        owner?.nativeSessionId === input.nativeSessionId ? await owner.settle() : false
      return {
        kind: 'verified',
        ready:
          Boolean(prefix.initializedVerified) &&
          witness.model === input.model &&
          witness.effort === input.effort &&
          witness.permissionMode === input.permissionMode,
        workSettled: Boolean(prefix.initializedVerified) || ownerSettled,
        result: { nativeSessionId: input.nativeSessionId, witness },
      }
    } catch (error) {
      // RPC access failures and non-authoritative discovery are never absence proof.
      return {
        kind: 'unconfirmed',
        reason: error instanceof Error ? error.message : 'Codex Fork inspection failed.',
      }
    }
  }

  async forkNativeContext(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    if (input.nativeSessionId) return this.initializeNativeFork(input, signal)
    return this.createOrInitializeFork(input, signal, false)
  }

  async initializeNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    const inspected = await this.inspectNativeFork(input, signal)
    if (inspected.kind !== 'verified')
      throw new AgentExecutionError('runtime_incompatible', inspected.reason, false)
    if (inspected.ready) return inspected.result
    return this.createOrInitializeFork(input, signal, true)
  }

  private async resolveForkConfiguration(
    connection: CodexAppServerConnection,
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<CodexRunConfiguration> {
    if (input.model && input.effort) return { model: input.model, effort: input.effort }
    const read = await connection.request(
      'config/read',
      { cwd: input.cwd, includeLayers: false },
      { timeoutMs: 10_000, signal },
    )
    const config = Reflect.get(Reflect.get(read, 'result') ?? {}, 'config')
    if (Reflect.get(read, 'error') || !config || typeof config !== 'object')
      throw new Error('Native defaults could not be read for this Fork.')
    let model = input.model ?? Reflect.get(config, 'model')
    let effort = input.effort ?? Reflect.get(config, 'model_reasoning_effort')
    if (typeof model === 'string' && model && typeof effort === 'string' && effort)
      return { model, effort }
    // One uncached, bounded catalog scan resolves actual native defaults. Null
    // settings-update/resume fields mean "unchanged", not "use defaults".
    let cursor: string | undefined,
      items = 0,
      bytes = 0
    const controller = new AbortController(),
      observed = AbortSignal.any([signal, controller.signal])
    const deadline = setTimeout(() => controller.abort(), 10_000)
    try {
      do {
        // oxlint-disable-next-line no-await-in-loop -- Native catalog cursor pages are ordered.
        const page = await connection.request(
          'model/list',
          { limit: 25, includeHidden: true, ...(cursor ? { cursor } : {}) },
          { timeoutMs: 10_000, signal: observed },
        )
        const result = Reflect.get(page, 'result'),
          data = result && Reflect.get(result, 'data'),
          next = result && Reflect.get(result, 'nextCursor')
        if (
          Reflect.get(page, 'error') ||
          !Array.isArray(data) ||
          data.length > 25 ||
          (next != null && (typeof next !== 'string' || next.length > 8192 || next === cursor))
        )
          throw new Error('Invalid native defaults catalog page.')
        for (const entry of data) {
          bytes += Buffer.byteLength(JSON.stringify(entry))
          if (++items > 200 || bytes > 256 * 1024 || !entry || typeof entry !== 'object')
            throw new Error('Native defaults catalog exceeded its bounded read.')
          const name = Reflect.get(entry, 'model'),
            id = Reflect.get(entry, 'id')
          if (
            !model &&
            Reflect.get(entry, 'isDefault') === true &&
            typeof name === 'string' &&
            name
          )
            model = name
          if (model && (name === model || id === model) && !effort)
            effort = Reflect.get(entry, 'defaultReasoningEffort')
        }
        if (typeof model === 'string' && model && typeof effort === 'string' && effort)
          return { model, effort }
        cursor = next ?? undefined
      } while (cursor)
      throw new Error(
        'The effective native model/effort defaults could not be resolved; no prior explicit values were reused.',
      )
    } finally {
      clearTimeout(deadline)
      controller.abort()
    }
  }

  private async applyForkModelSettings(
    connection: CodexAppServerConnection,
    threadId: string,
    configuration: CodexRunConfiguration,
    signal: AbortSignal,
  ): Promise<void> {
    const read = await connection.request(
      'thread/read',
      { threadId, includeTurns: false },
      { timeoutMs: 10_000, signal },
    )
    const thread = Reflect.get(Reflect.get(read, 'result') ?? {}, 'thread')
    if (Reflect.get(read, 'error') || thread?.id !== threadId)
      throw new Error('Native Fork model settings could not be read.')
    if (thread.model === configuration.model && thread.reasoningEffort === configuration.effort)
      return
    const controller = new AbortController(),
      observed = AbortSignal.any([signal, controller.signal])
    const deadline = setTimeout(() => controller.abort(), 10_000)
    let resolve: ((settings: unknown) => void) | undefined
    const acknowledged = new Promise<unknown>((settle) => {
      resolve = settle
    })
    const aborted = () => resolve?.(undefined)
    observed.addEventListener('abort', aborted, { once: true })
    const release = connection.subscribeBackground((event) => {
      const params = Reflect.get(event, 'params')
      if (
        Reflect.get(event, 'method') !== 'thread/settings/updated' ||
        !params ||
        typeof params !== 'object' ||
        Reflect.get(params, 'threadId') !== threadId
      )
        return false
      resolve?.(Reflect.get(params, 'threadSettings'))
      return true
    })
    try {
      const updated = await connection.request(
        'thread/settings/update',
        { threadId, model: configuration.model, effort: configuration.effort },
        { timeoutMs: 10_000, signal: observed },
      )
      if (Reflect.get(updated, 'error'))
        throw new Error('Native Fork model/effort settings update was rejected.')
      const actual = await acknowledged
      if (
        observed.aborted ||
        !actual ||
        typeof actual !== 'object' ||
        Reflect.get(actual, 'model') !== configuration.model ||
        Reflect.get(actual, 'effort') !== configuration.effort
      )
        throw new Error('Native Fork did not acknowledge the requested model/effort defaults.')
      const after = await connection.request(
        'thread/read',
        { threadId, includeTurns: false },
        { timeoutMs: 10_000, signal: observed },
      )
      const current = Reflect.get(Reflect.get(after, 'result') ?? {}, 'thread')
      if (
        Reflect.get(after, 'error') ||
        current?.id !== threadId ||
        current.model !== configuration.model ||
        current.reasoningEffort !== configuration.effort
      )
        throw new Error('Native Fork model/effort settings readback changed after acknowledgement.')
    } finally {
      release()
      clearTimeout(deadline)
      observed.removeEventListener('abort', aborted)
      controller.abort()
      resolve?.(undefined)
    }
  }

  private async createOrInitializeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
    resume: boolean,
  ): Promise<AgentNativeForkResult> {
    if (
      this.runtime.running ||
      this.runtime.nativeForkOwners.has(input.operationId) ||
      this.runtime.nativeBackground.size +
        [...this.runtime.nativeRebuildReceipts.values()].filter((receipt) => receipt.pending)
          .length +
        this.runtime.nativeForkOwners.size >=
        MAX_LOADED_THREADS
    )
      throw new NativeCapacityError(
        'Codex native context capacity is unavailable; no new Fork work was dispatched.',
      )
    this.runtime.running = true
    let owner: CodexNativeForkOwner | undefined
    let threadId = input.nativeSessionId,
      provisional: string | undefined,
      dispatched = false
    const observation = new AbortController(),
      interactions = new Set<Promise<void>>(),
      hooks = new Set<string>(),
      handled = new Set<string>(),
      approvalItems = new Map<string, ApprovalItem>()
    let unconfirmed = false,
      settling = false,
      foregroundFinished = false
    try {
      if (resume && input.witness && input.nativeSessionId) {
        const {
          initializedAt: _initializedAt,
          initializedPrefixHash: _initializedPrefixHash,
          initializedPrefixBytes: _initializedPrefixBytes,
          initializedPrefixRecords: _initializedPrefixRecords,
          ...originalWitness
        } = input.witness
        const freshWitness = {
          ...originalWitness,
          model: input.model,
          effort: input.effort,
          permissionMode: input.permissionMode,
        }
        await input.onCandidate(input.nativeSessionId, freshWitness)
        input = { ...input, witness: freshWitness }
      }
      const connection = await this.runtime.connections.ensureConnection(input.cwd)
      await this.runtime.connections.initializeConnection(connection, signal)
      const toolConfig = await this.runtime.connections.pactToolConfig(
        connection,
        await this.runtime.peerToolServer.start(),
        input.cwd,
        signal,
        input.permissionMode,
      )
      const forkConfiguration = await this.resolveForkConfiguration(connection, input, signal)
      const sourcePrefix = !resume
        ? await this.withNativeInspectionConnection(
            connection,
            input.cwd,
            signal,
            (reader, readSignal) =>
              this.readForkRollout(
                reader,
                input.source.nativeSessionId,
                input.source.nativeTurnId,
                input.cwd,
                readSignal,
                undefined,
                undefined,
              ),
          )
        : undefined
      if (sourcePrefix && sourcePrefix.prefixHash !== input.source.prefixHash)
        throw new Error('The complete native source context changed before Fork dispatch.')
      // Native config/read serializes an absent legacy workspace policy as null.
      // Forward only its actual structured value, preserving all other native config.
      const forkConfig = Object.fromEntries(
        Object.entries(toolConfig.config).filter(
          ([key, value]) =>
            key !== 'sandbox_workspace_write' ||
            (value !== null && typeof value === 'object' && !Array.isArray(value)),
        ),
      )
      const releaseEvents = connection.subscribeBackground((event) => {
        const params = Reflect.get(event, 'params'),
          method = Reflect.get(event, 'method')
        if (
          !dispatched ||
          !params ||
          typeof params !== 'object' ||
          !['hook/started', 'hook/completed'].includes(String(method))
        )
          return false
        const nativeThread = Reflect.get(params, 'threadId')
        if (
          typeof nativeThread !== 'string' ||
          ((threadId ?? provisional) && nativeThread !== (threadId ?? provisional))
        )
          return false
        provisional ??= nativeThread
        const run = Reflect.get(params, 'run'),
          hookId = run && typeof run === 'object' ? Reflect.get(run, 'id') : undefined
        if (typeof hookId !== 'string' || hookId.length > 1024) unconfirmed = true
        else if (method === 'hook/started') {
          if (hooks.size >= 64) unconfirmed = true
          else hooks.add(hookId)
        } else if (
          ['completed', 'failed', 'blocked', 'stopped'].includes(String(Reflect.get(run, 'status')))
        )
          hooks.delete(hookId)
        if (foregroundFinished) void owner?.settle().catch(() => undefined)
        return true
      })
      const releaseRequests = connection.subscribeServerRequests((request) => {
        const params = Reflect.get(request, 'params'),
          method = Reflect.get(request, 'method')
        if (!dispatched || typeof method !== 'string' || !params || typeof params !== 'object')
          return false
        const nativeThread = Reflect.get(params, 'threadId'),
          turnId = Reflect.get(params, 'turnId')
        if (
          typeof nativeThread !== 'string' ||
          ((threadId ?? provisional) && nativeThread !== (threadId ?? provisional))
        )
          return false
        provisional ??= nativeThread
        if (interactions.size >= 8) {
          unconfirmed = true
          return false
        }
        const work = this.runtime.connections
          .relayPermission(
            connection,
            request,
            method,
            params,
            input,
            nativeThread,
            typeof turnId === 'string' ? turnId : undefined,
            observation.signal,
            handled,
            approvalItems,
          )
          .catch(() => {
            unconfirmed = true
          })
        interactions.add(work)
        void work.finally(() => {
          interactions.delete(work)
          if (foregroundFinished) void owner?.settle().catch(() => undefined)
        })
        return true
      })
      owner = {
        executorId: connection.executorId,
        ...(threadId ? { nativeSessionId: threadId } : {}),
        pending: true,
        observation,
        settle: async () => {
          if (
            !foregroundFinished ||
            !threadId ||
            settling ||
            hooks.size ||
            interactions.size ||
            unconfirmed ||
            observation.signal.aborted ||
            !owner?.pending
          )
            return false
          settling = true
          try {
            const read = await connection.request(
              'thread/read',
              { threadId, includeTurns: false },
              { timeoutMs: 10_000, signal: observation.signal },
            )
            const thread = Reflect.get(Reflect.get(read, 'result') ?? {}, 'thread')
            if (
              Reflect.get(read, 'error') ||
              thread?.id !== threadId ||
              thread.status?.type !== 'idle' ||
              hooks.size ||
              interactions.size ||
              unconfirmed
            )
              return false
            input.reportNativeWork({ executorId: connection.executorId, state: 'settled' })
            owner.pending = false
            owner.release()
            if (this.runtime.nativeForkOwners.get(input.operationId) === owner)
              this.runtime.nativeForkOwners.delete(input.operationId)
            this.runtime.connections.scheduleIdleDisconnect()
            return true
          } finally {
            settling = false
          }
        },
        release: () => {
          releaseEvents()
          releaseRequests()
          observation.abort()
        },
      }
      this.runtime.nativeForkOwners.set(input.operationId, owner)
      await input.onDispatched(connection.executorId)
      const response = await connection.request(
        resume ? 'thread/resume' : 'thread/fork',
        {
          threadId: resume ? threadId : input.source.nativeSessionId,
          ...(!resume ? { lastTurnId: input.source.nativeCutId, deferGoalContinuation: true } : {}),
          cwd: input.cwd,
          excludeTurns: true,
          config: {
            ...forkConfig,
            model_reasoning_effort: forkConfiguration.effort,
          },
          ...toolConfig.nativePolicy,
          model: forkConfiguration.model,
        },
        {
          timeoutMs: 10_000,
          signal,
          onDispatch: () => {
            dispatched = true
            input.reportNativeWork({ executorId: connection.executorId, state: 'unknown' })
          },
        },
      )
      if (Reflect.get(response, 'error'))
        throw classifyAgentError(new Error(JSON.stringify(Reflect.get(response, 'error'))))
      const result = Reflect.get(response, 'result'),
        thread = result && Reflect.get(result, 'thread')
      if (
        !thread ||
        typeof thread.id !== 'string' ||
        (resume && thread.id !== input.nativeSessionId) ||
        thread.forkedFromId !== input.source.nativeSessionId ||
        (provisional && provisional !== thread.id)
      )
        throw new Error('Codex Fork acknowledgement did not match its exact lineage.')
      threadId = thread.id
      owner.nativeSessionId = threadId!
      let witness: AgentNativeForkWitness = input.witness ?? {
        version: 'pact-native-fork-v1',
        nativeSessionId: threadId!,
        sourceNativeSessionId: input.source.nativeSessionId,
        sourceCutId: input.source.nativeCutId,
        sourcePrefixHash: input.source.prefixHash,
        candidatePrefixHash: input.source.prefixHash,
        idMap: sourcePrefix?.idMap ?? [],
        model: input.model,
        effort: input.effort,
        permissionMode: input.permissionMode,
      }
      await input.onCandidate(threadId!, witness)
      await this.runtime.connections.applyPermissionSettings(
        connection,
        threadId!,
        toolConfig.settingsPolicy,
        signal,
        response,
      )
      await this.applyForkModelSettings(connection, threadId!, forkConfiguration, signal)
      if (thread.status?.type !== 'idle' || hooks.size || interactions.size || unconfirmed)
        throw new Error(
          'Codex Fork startup work is not confirmed settled; the candidate was preserved.',
        )
      const prefix = await this.withNativeInspectionConnection(
        connection,
        input.cwd,
        signal,
        (reader, readSignal) =>
          this.readForkRollout(
            reader,
            threadId!,
            input.source.nativeTurnId,
            input.cwd,
            readSignal,
            witness,
          ),
      )
      const finalRead = await connection.request(
        'thread/read',
        { threadId, includeTurns: false },
        { timeoutMs: 10_000, signal },
      )
      const finalThread = Reflect.get(Reflect.get(finalRead, 'result') ?? {}, 'thread')
      if (
        Reflect.get(finalRead, 'error') ||
        finalThread?.id !== threadId ||
        finalThread.status?.type !== 'idle' ||
        hooks.size ||
        interactions.size ||
        unconfirmed
      )
        throw new Error('Codex Fork startup work changed during native readback.')
      witness = {
        ...witness,
        idMap: prefix.idMap,
        ...(prefix.nativeStorageRoot ? { nativeStorageRoot: prefix.nativeStorageRoot } : {}),
        ...(prefix.nativePath ? { nativePath: prefix.nativePath } : {}),
        initializedAt: new Date().toISOString(),
        initializedPrefixHash: prefix.rawHash,
        initializedPrefixBytes: prefix.rawBytes,
        initializedPrefixRecords: prefix.rawRecords,
      }
      await input.onCandidate(threadId!, witness)
      input.reportNativeWork({ executorId: connection.executorId, state: 'settled' })
      owner.pending = false
      this.runtime.connections.rememberThread(threadId!, {
        model: forkConfiguration.model,
        effort: forkConfiguration.effort,
      })
      return { nativeSessionId: threadId!, witness }
    } finally {
      foregroundFinished = true
      this.runtime.running = false
      if (owner?.pending && dispatched) void owner.settle().catch(() => undefined)
      if (owner && (!dispatched || !owner.pending)) {
        owner.release()
        this.runtime.nativeForkOwners.delete(input.operationId)
      }
      this.runtime.connections.scheduleIdleDisconnect()
    }
  }

  probeNativeInputs(input: AgentNativeInputProbeInput, signal: AbortSignal): Promise<void> {
    return this.beginNativeInputsCheck(input, signal).result
  }

  beginNativeInputsCheck(
    input: AgentNativeInputProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<void> {
    return this.runtime.beginNativeCheck(
      signal,
      (checkSignal) => this.readNativeInputs(input, checkSignal),
      context,
    )
  }

  private async readNativeInputs(
    input: AgentNativeInputProbeInput,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      !input.nativeTurnId ||
      input.unresolvedInputIds.length > 64 ||
      input.unresolvedInputIds.some((id) => !/^[a-f\d-]{36}$/iu.test(id))
    )
      throw new AgentExecutionError('protocol_error', 'Invalid native input receipt scope.', false)
    const pending = new Set(input.unresolvedInputIds)
    if (!pending.size) return
    clearTimeout(this.runtime.idleTimer)
    this.runtime.idleTimer = undefined
    try {
      const connection = await this.runtime.connections.ensureConnection(input.cwd)
      this.runtime.nativeCheck.recordPhysicalOwner(signal, { kind: 'shared_rpc' })
      await this.runtime.connections.initializeConnection(connection, signal)
      await this.withNativeInspectionConnection(
        connection,
        input.cwd,
        signal,
        async (reader, readSignal) => {
          for await (const entry of this.readNativeItems(
            reader,
            input.nativeSessionId,
            input.nativeTurnId,
            readSignal,
            10_000,
            8 * 1024 * 1024,
          )) {
            const item = Reflect.get(entry, 'item')
            if (
              Reflect.get(entry, 'turnId') !== input.nativeTurnId ||
              !item ||
              typeof item !== 'object' ||
              Reflect.get(item, 'type') !== 'userMessage'
            )
              continue
            const id = Reflect.get(item, 'clientId')
            if (typeof id !== 'string' || !pending.has(id)) continue
            input.recordConsumption(id)
            pending.delete(id)
            if (!pending.size) break
          }
        },
      )
    } finally {
      this.runtime.connections.scheduleIdleDisconnect()
    }
  }

  probeNativeStatus(input: AgentNativeProbeInput, signal: AbortSignal): Promise<NativeProbeResult> {
    return this.beginNativeStatusCheck(input, signal).result
  }

  beginNativeStatusCheck(
    input: AgentNativeProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<NativeProbeResult> {
    return this.runtime.beginNativeCheck(
      signal,
      (checkSignal) => this.readNativeStatus(input, checkSignal),
      context,
    )
  }

  private async readNativeStatus(
    input: AgentNativeProbeInput,
    signal: AbortSignal,
  ): Promise<NativeProbeResult> {
    if (input.target === 'initialized_binding') return this.probeInitializedBinding(input, signal)
    const identity = probeIdentity(input)
    const owner = [...this.runtime.nativeBackground].find(
      (candidate) =>
        candidate.input.runId === input.requestId &&
        candidate.primaryThreadId === input.nativeSessionId &&
        candidate.input.bindingGeneration === input.bindingGeneration,
    )
    clearTimeout(this.runtime.idleTimer)
    this.runtime.idleTimer = undefined
    try {
      const connection = await this.runtime.connections.ensureConnection(input.cwd)
      this.runtime.nativeCheck.recordPhysicalOwner(signal, { kind: 'shared_rpc' })
      await this.runtime.connections.initializeConnection(connection, signal)
      const response = await connection.request(
        'thread/read',
        { threadId: input.nativeSessionId, includeTurns: false },
        { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
      )
      const error = Reflect.get(response, 'error')
      if (error) {
        const detail = JSON.stringify(error)
        if (/not found|does not exist|unknown thread|missing thread/iu.test(detail))
          return { kind: 'missing', identity, source: 'native_error' }
        throw classifyAgentError(new Error(detail))
      }
      const result = Reflect.get(response, 'result')
      const thread =
        result && typeof result === 'object' ? Reflect.get(result, 'thread') : undefined
      const threadId = thread && typeof thread === 'object' ? Reflect.get(thread, 'id') : undefined
      if (threadId !== input.nativeSessionId)
        throw new AgentExecutionError(
          'protocol_error',
          'Codex returned an unexpected Native Session.',
          false,
        )
      observeThreadTitle(thread, input.observeNativeTitle)
      const terminal = this.runtime.terminalEvidence.get(input.requestId)
      if (terminal) {
        this.runtime.terminalEvidence.delete(input.requestId)
        this.runtime.terminalEvidence.set(input.requestId, terminal)
      }
      if (
        terminal &&
        terminal.identity.nativeSessionId === input.nativeSessionId &&
        terminal.identity.bindingGeneration === input.bindingGeneration &&
        (!input.nativeTurnId || terminal.identity.nativeTurnId === input.nativeTurnId)
      ) {
        const confirmed = {
          ...terminal,
          source:
            terminal.identity.executorId === connection.executorId
              ? ('live_terminal' as const)
              : ('stored_terminal' as const),
          identity: {
            ...terminal.identity,
            ...identity,
            ...(terminal.identity.executorId ? { executorId: terminal.identity.executorId } : {}),
          },
        }
        if (confirmed.output?.completeness === 'complete' || !confirmed.identity.nativeTurnId)
          return confirmed
        try {
          const output = await this.readNativeOutput(
            connection,
            input.nativeSessionId,
            confirmed.identity.nativeTurnId,
            { ...input, nativeTurnId: confirmed.identity.nativeTurnId },
            signal,
            confirmed.outcome === 'completed',
          )
          return { ...confirmed, ...(output ? { output } : {}) }
        } catch {
          return confirmed
        }
      }
      // A fresh App Server's historical interrupted/notLoaded projection is not
      // evidence that another executor stopped. Preserve text independently.
      // The unknown-delivery case may have no Turn ACK. Match the original
      // client request through bounded item pages, never a guessed latest Turn.
      let matchedNativeTurnId = input.nativeTurnId
      if (!matchedNativeTurnId) {
        matchedNativeTurnId = await this.withNativeInspectionConnection(
          connection,
          input.cwd,
          signal,
          async (reader, readSignal) => {
            const matches = new Set<string>()
            for await (const entry of this.readNativeItems(
              reader,
              input.nativeSessionId,
              undefined,
              readSignal,
              10_000,
              8 * 1024 * 1024,
            )) {
              const item = Reflect.get(entry, 'item')
              if (
                item &&
                typeof item === 'object' &&
                Reflect.get(item, 'type') === 'userMessage' &&
                Reflect.get(item, 'clientId') === input.requestId &&
                typeof Reflect.get(entry, 'turnId') === 'string'
              )
                matches.add(Reflect.get(entry, 'turnId'))
            }
            return matches.size === 1 ? [...matches][0] : undefined
          },
        )
      }
      const matchedInput = { ...input, nativeTurnId: matchedNativeTurnId }
      const turns = await this.readNativeTurns(
        connection,
        input.nativeSessionId,
        signal,
        matchedNativeTurnId,
      )
      if (
        owner?.connection === connection &&
        input.executorId === owner.connection.executorId &&
        Array.isArray(turns)
      ) {
        const matched = matchingTurn(turns, matchedInput)
        const matchedId = matched ? Reflect.get(matched, 'id') : undefined
        if (
          typeof matchedId === 'string' &&
          (!owner.primaryTurnId || owner.primaryTurnId === matchedId)
        ) {
          owner.primaryTurnId = matchedId
          connection.replayBackgroundNotifications()
          const observedTerminal = this.runtime.terminalEvidence.get(input.requestId)
          if (observedTerminal) {
            this.runtime.terminalEvidence.delete(input.requestId)
            this.runtime.terminalEvidence.set(input.requestId, observedTerminal)
          }
          if (observedTerminal) return observedTerminal
        }
        if (
          matched &&
          typeof matchedId === 'string' &&
          Reflect.get(matched, 'status') === 'inProgress'
        )
          return {
            kind: owner.interactions.size ? 'waiting_user' : 'running',
            identity: {
              ...identity,
              nativeTurnId: matchedId,
              executorId: this.runtime.executorId,
            },
            source: 'live_runtime',
          }
      }
      const matched = Array.isArray(turns) ? matchingTurn(turns, matchedInput) : undefined
      const matchedId = matched ? Reflect.get(matched, 'id') : undefined
      const outcome = matched ? storedTurnOutcome(matched) : undefined
      const matchedIndex = Array.isArray(turns) && matched ? turns.indexOf(matched) : -1
      const threadStatus =
        thread && typeof thread === 'object' ? Reflect.get(thread, 'status') : undefined
      const active =
        threadStatus &&
        typeof threadStatus === 'object' &&
        Reflect.get(threadStatus, 'type') === 'active'
      const historyReady =
        threadStatus &&
        typeof threadStatus === 'object' &&
        !Array.isArray(threadStatus) &&
        ['idle', 'notLoaded'].includes(Reflect.get(threadStatus, 'type'))
      if (
        outcome &&
        typeof matchedId === 'string' &&
        matchedIndex >= 0 &&
        historyReady &&
        Array.isArray(turns) &&
        turns
          .slice(matchedIndex + 1)
          .every(
            (turn) => turn && typeof turn === 'object' && storedTurnOutcome(turn) !== undefined,
          )
      ) {
        // Completion metadata is projected from a persisted native terminal
        // event, unlike default Completed/Interrupted or this process's notLoaded.
        // Body recovery has its own limits and cannot undo known termination.
        let recovered: Extract<NativeProbeResult, { kind: 'ended' }>['output']
        try {
          recovered = await this.readNativeOutput(
            connection,
            input.nativeSessionId,
            matchedId,
            matchedInput,
            signal,
            outcome === 'completed',
          )
        } catch {
          /* Known ending remains usable if its body cannot be read safely. */
        }
        return {
          kind: 'ended',
          source: 'stored_terminal',
          outcome,
          identity: { ...identity, nativeTurnId: matchedId },
          ...(recovered ? { output: recovered } : {}),
        }
      }
      let output: Extract<NativeProbeResult, { kind: 'no_evidence' }>['output']
      try {
        if (typeof matchedId === 'string')
          output = await this.readNativeOutput(
            connection,
            input.nativeSessionId,
            matchedId,
            matchedInput,
            signal,
          )
      } catch {
        // An unavailable answer does not change the native-state evidence.
      }
      return {
        kind: 'no_evidence',
        identity:
          typeof matchedId === 'string' ? { ...identity, nativeTurnId: matchedId } : identity,
        reason: active
          ? 'The native session still reports active work.'
          : !historyReady
            ? 'The native check returned an unsupported Thread status.'
            : outcome
              ? 'The native session has a later Turn without reliable terminal metadata.'
              : 'Native history has no explicit terminal metadata for this Turn.',
        ...(output ? { output } : {}),
      }
    } catch (error) {
      return {
        kind: 'no_evidence',
        identity,
        reason: safeNativePermissionText(
          `Native status check failed: ${error instanceof Error ? error.message : 'No reliable response was received.'}`,
          240,
        ),
      }
    } finally {
      this.runtime.connections.scheduleIdleDisconnect()
    }
  }

  async rebuildNativeContext(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult> {
    if (this.runtime.running)
      throw new AgentExecutionError('protocol_error', 'Codex already has an active Run.', false)
    if (
      this.runtime.nativeBackground.size +
        this.runtime.nativeForkOwners.size +
        [...this.runtime.nativeRebuildReceipts.values()].filter((receipt) => receipt.pending)
          .length >=
      8
    )
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Codex has too many owned native contexts. No new bootstrap was created.',
        false,
      )
    this.runtime.running = true
    clearTimeout(this.runtime.idleTimer)
    this.runtime.idleTimer = undefined
    let threadId: string | undefined
    let provisionalThreadId: string | undefined
    let releaseNativeRequests: (() => void) | undefined
    let releaseHookObservation: (() => void) | undefined
    const observation = new AbortController()
    let nativeCreationDispatched = false
    let creationExecutorId: string | undefined
    let creationNotStarted = false
    const startupHooks = { pending: new Set<string>(), unconfirmed: false }
    const interactions = new Set<Promise<void>>()
    const handledRequests = new Set<string>()
    const approvalItems = new Map<string, ApprovalItem>()
    let permissionRejected = false
    let inspectRejectedIdle: (() => Promise<void>) | undefined
    try {
      const connection = await this.runtime.connections.ensureConnection(input.cwd)
      await this.runtime.connections.initializeConnection(connection, signal)
      const peerToolUrl = await this.runtime.peerToolServer.start()
      const toolConfig = await this.runtime.connections.pactToolConfig(
        connection,
        peerToolUrl,
        input.cwd,
        signal,
        input.permissionMode,
      )
      let rejectionCheckPending = false
      inspectRejectedIdle = async () => {
        if (
          !permissionRejected ||
          !threadId ||
          interactions.size ||
          startupHooks.pending.size ||
          startupHooks.unconfirmed ||
          rejectionCheckPending ||
          observation.signal.aborted
        )
          return
        rejectionCheckPending = true
        try {
          const read = await connection.request(
            'thread/read',
            { threadId, includeTurns: false },
            { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal: observation.signal },
          )
          const thread = Reflect.get(Reflect.get(read, 'result') ?? {}, 'thread')
          if (
            !Reflect.get(read, 'error') &&
            thread?.id === threadId &&
            thread.status?.type === 'idle' &&
            interactions.size === 0 &&
            !startupHooks.pending.size &&
            !startupHooks.unconfirmed
          ) {
            input.reportNativeWork?.({
              executorId: connection.executorId,
              nativeSessionId: threadId,
              state: 'settled',
            })
            this.settleNativeRebuild(input.rebuildId)
          }
        } catch {
          /* No proof of idle: keep the actual native owner. */
        } finally {
          rejectionCheckPending = false
        }
      }
      releaseHookObservation = connection.subscribeBackground((event) => {
        const method = Reflect.get(event, 'method'),
          params = Reflect.get(event, 'params')
        if (
          !nativeCreationDispatched ||
          !['hook/started', 'hook/completed'].includes(String(method)) ||
          !params ||
          typeof params !== 'object'
        )
          return false
        const nativeThread = Reflect.get(params, 'threadId'),
          turn = Reflect.get(params, 'turnId')
        if (
          typeof nativeThread !== 'string' ||
          !nativeThread ||
          nativeThread.length > 1024 ||
          ((threadId ?? provisionalThreadId) && nativeThread !== (threadId ?? provisionalThreadId))
        )
          return false
        provisionalThreadId ??= nativeThread
        const hook = Reflect.get(params, 'run'),
          id = hook && typeof hook === 'object' ? Reflect.get(hook, 'id') : undefined
        if (
          typeof id !== 'string' ||
          !id ||
          id.length > 1024 ||
          (turn != null && (typeof turn !== 'string' || turn.length > 1024))
        )
          startupHooks.unconfirmed = true
        else {
          const key = JSON.stringify([connection.executorId, nativeThread, turn ?? null, id])
          if (method === 'hook/started') {
            const bytes = [...startupHooks.pending].reduce(
              (sum, value) => sum + Buffer.byteLength(value),
              0,
            )
            if (
              startupHooks.pending.has(key) ||
              (startupHooks.pending.size < 64 && bytes + Buffer.byteLength(key) <= 64 * 1024)
            )
              startupHooks.pending.add(key)
            else startupHooks.unconfirmed = true
          } else if (
            ['completed', 'failed', 'blocked', 'stopped'].includes(
              String(Reflect.get(hook, 'status')),
            )
          )
            startupHooks.pending.delete(key)
        }
        void inspectRejectedIdle?.()
        return true
      })
      releaseNativeRequests = connection.subscribeServerRequests((request) => {
        const method = Reflect.get(request, 'method'),
          params = Reflect.get(request, 'params')
        if (typeof method !== 'string' || !params || typeof params !== 'object') return false
        if (method !== 'mcpServer/elicitation/request') return false
        const nativeThread = Reflect.get(params, 'threadId')
        if (typeof nativeThread !== 'string' || !nativeThread || nativeThread.length > 1024)
          return false
        if ((threadId ?? provisionalThreadId) && nativeThread !== (threadId ?? provisionalThreadId))
          return false
        // A startup MCP interaction can precede thread/start's ACK. Its sole
        // foreground request owner is verified against that ACK below.
        provisionalThreadId ??= nativeThread
        const nativeTurn = Reflect.get(params, 'turnId')
        if (interactions.size >= 8) {
          const id = Reflect.get(request, 'id')
          if (typeof id === 'string' || typeof id === 'number')
            void connection
              .respondError(
                id,
                'Pact cannot display another native initialization interaction within its bounded owner.',
              )
              .catch(() => undefined)
          return true
        }
        const interaction = this.runtime.connections
          .relayPermission(
            connection,
            request,
            method,
            params,
            input,
            nativeThread,
            typeof nativeTurn === 'string' ? nativeTurn : undefined,
            observation.signal,
            handledRequests,
            approvalItems,
          )
          .catch(() => undefined)
        interactions.add(interaction)
        void interaction.finally(() => {
          interactions.delete(interaction)
          void inspectRejectedIdle?.()
        })
        return true
      })
      const releaseRequests = releaseNativeRequests
      releaseNativeRequests = () => {
        releaseRequests()
        releaseHookObservation?.()
      }
      this.rememberNativeRebuild(input.rebuildId, {
        nativeSessionId: '',
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        executorId: connection.executorId,
        cwd: input.cwd,
        allSeedAcknowledged: false,
        pending: true,
        observation,
        release: releaseNativeRequests,
        interactions,
        startupHooks,
      })
      await input.onNativeCreationDispatched?.(connection.executorId)
      creationExecutorId = connection.executorId

      const started = await connection.request(
        'thread/start',
        {
          cwd: input.cwd,
          ephemeral: false,
          allowProviderModelFallback: false,
          config: toolConfig.config,
          ...(input.permissionMode && input.permissionMode !== 'native'
            ? toolConfig.nativePolicy
            : {}),
          ...(input.model ? { model: input.model } : {}),
        },
        {
          timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS,
          signal,
          onDispatch: () => {
            nativeCreationDispatched = true
          },
        },
      )
      const startError = Reflect.get(started, 'error')
      if (startError) {
        // Only an exact invalid-params response proves routing rejected this
        // creation before native startup. Other RPC failures may follow startup.
        creationNotStarted =
          typeof startError === 'object' &&
          Reflect.get(startError, 'code') === -32602 &&
          !provisionalThreadId &&
          !interactions.size &&
          !startupHooks.pending.size &&
          !startupHooks.unconfirmed
        throw classifyAgentError(new Error(JSON.stringify(startError)))
      }
      const result = Reflect.get(started, 'result')
      const thread =
        result && typeof result === 'object' ? Reflect.get(result, 'thread') : undefined
      const resolvedId =
        thread && typeof thread === 'object' ? Reflect.get(thread, 'id') : undefined
      if (typeof resolvedId !== 'string')
        throw new AgentExecutionError('protocol_error', 'Codex returned no Thread ID.', false)
      if (provisionalThreadId && provisionalThreadId !== resolvedId)
        throw new AgentExecutionError(
          'protocol_error',
          'Codex returned a Thread different from its startup interaction.',
          false,
        )
      threadId = resolvedId
      this.rememberNativeRebuild(input.rebuildId, {
        nativeSessionId: threadId,
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        executorId: connection.executorId,
        cwd: input.cwd,
        allSeedAcknowledged: false,
        pending: true,
      })
      await input.onNativeSessionCreated?.(threadId)

      try {
        confirmPermissionMode(started, input.permissionMode)
      } catch (error) {
        permissionRejected = true
        await inspectRejectedIdle()
        throw error
      }
      const items: object[] = []
      let bytes = 0
      let chunkIndex = 0
      const seedHash = createHash('sha256')
      const expectedSeed: string[] = []
      const flush = async (): Promise<void> => {
        if (items.length === 0) return
        const response = await connection.request(
          'thread/inject_items',
          { threadId, items: items.splice(0) },
          { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
        )
        bytes = 0
        const error = Reflect.get(response, 'error')
        if (error) throw classifyAgentError(new Error(JSON.stringify(error)))
        if (!Reflect.has(response, 'result'))
          throw new AgentExecutionError(
            'protocol_error',
            'Codex did not acknowledge the transcript append.',
            false,
          )
      }
      for await (const text of this.nativeSeedTexts(input, source, signal)) {
        chunkIndex += 1
        seedHash.update(text)
        expectedSeed.push(createHash('sha256').update(text).digest('hex'))
        const marker: NativeContextRebuildChunk = JSON.parse(text)
        if (marker.kind === 'image') {
          await flush()
          if (!input.resolveImage)
            throw new AgentExecutionError(
              'protocol_error',
              'The Pact image source is unavailable.',
              false,
            )
          const image = await input.resolveImage(marker.image.id, signal)
          requireNativeImageReference(image, marker.image)
          const reservation = connection.reserveWorkingMemory(nativeImagePreparationBytes([image]))
          try {
            const block = await nativeImageBlock(image, signal)
            const response = await connection.request(
              'thread/inject_items',
              {
                threadId,
                items: [
                  {
                    type: 'message',
                    role: 'user',
                    content: [
                      { type: 'input_text', text },
                      {
                        type: 'input_image',
                        image_url: `data:${block.source.media_type};base64,${block.source.data}`,
                      },
                    ],
                  },
                ],
              },
              { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
            )
            if (Reflect.get(response, 'error'))
              throw classifyAgentError(new Error(JSON.stringify(Reflect.get(response, 'error'))))
            if (!Reflect.has(response, 'result'))
              throw new AgentExecutionError(
                'protocol_error',
                'Codex did not acknowledge the image append.',
                false,
              )
          } finally {
            reservation.release()
          }
          continue
        }
        const item = {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        }
        const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8')
        if (items.length > 0 && bytes + itemBytes > CODEX_INJECT_TARGET_BYTES) await flush()
        items.push(item)
        bytes += itemBytes
      }
      const completeHash = seedHash.digest('hex')
      this.rememberNativeRebuild(input.rebuildId, {
        nativeSessionId: threadId,
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        seedHash: completeHash,
        chunkCount: chunkIndex,
        executorId: connection.executorId,
        cwd: input.cwd,
        allSeedAcknowledged: false,
        pending: true,
      })
      await flush()
      this.rememberNativeRebuild(input.rebuildId, {
        nativeSessionId: threadId,
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        seedHash: completeHash,
        chunkCount: chunkIndex,
        executorId: connection.executorId,
        cwd: input.cwd,
        allSeedAcknowledged: true,
        pending: true,
      })
      const initializationWitness = await this.verifyNativeSeed(
        connection,
        input,
        threadId,
        expectedSeed,
        completeHash,
        signal,
      )
      if (!initializationWitness)
        throw new AgentExecutionError(
          'runtime_incompatible',
          'The rebuilt Codex context was not confirmed idle by its creating executor. Its native Thread was preserved.',
          false,
        )
      input.reportNativeWork?.({
        executorId: connection.executorId,
        nativeSessionId: threadId,
        state: 'settled',
      })
      this.settleNativeRebuild(input.rebuildId)
      return { nativeSessionId: threadId, initializationWitness }
    } finally {
      if (
        creationExecutorId &&
        (!nativeCreationDispatched || creationNotStarted) &&
        !provisionalThreadId &&
        !interactions.size &&
        !startupHooks.pending.size &&
        !startupHooks.unconfirmed
      ) {
        input.reportNativeWork?.({ executorId: creationExecutorId, state: 'settled' })
        this.settleNativeRebuild(input.rebuildId)
      }
      if (!threadId && !provisionalThreadId) {
        // Durable unknown work still reserves its receipt. This ended owner
        // has no identity with which to claim a later creation's events.
        releaseNativeRequests?.()
        releaseHookObservation?.()
      }
      if (!nativeCreationDispatched || creationNotStarted)
        this.runtime.nativeRebuildReceipts.delete(input.rebuildId)
      if (
        !this.runtime.nativeRebuildReceipts.get(input.rebuildId)?.pending &&
        !observation.signal.aborted
      ) {
        releaseNativeRequests?.()
        releaseHookObservation?.()
        observation.abort()
      }
      this.runtime.running = false
      this.runtime.connections.scheduleIdleDisconnect()
    }
  }

  inspectNativeRebuild(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult | undefined> {
    return this.beginNativeRebuildCheck(input, source, signal).result
  }

  beginNativeRebuildCheck(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<AgentNativeContextRebuildResult | undefined> {
    return this.runtime.beginNativeCheck(
      signal,
      (checkSignal) => this.readNativeRebuild(input, source, checkSignal),
      context,
    )
  }

  private async readNativeRebuild(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult | undefined> {
    if (this.runtime.disposed || signal.aborted || !input.nativeSessionId) return undefined

    const { expected, seedHash: expectedHash } = await this.nativeSeedExpectation(
      input,
      source,
      signal,
    )
    clearTimeout(this.runtime.idleTimer)
    this.runtime.idleTimer = undefined
    try {
      const connection = await this.runtime.connections.ensureConnection(input.cwd)
      this.runtime.nativeCheck.recordPhysicalOwner(signal, { kind: 'shared_rpc' })
      await this.runtime.connections.initializeConnection(connection, signal)
      const initializationWitness = await this.verifyNativeSeed(
        connection,
        input,
        input.nativeSessionId,
        expected,
        expectedHash,
        signal,
      )
      if (!initializationWitness) return undefined
      this.settleNativeRebuild(input.rebuildId)
      return { nativeSessionId: input.nativeSessionId, initializationWitness }
    } catch {
      return undefined
    } finally {
      this.runtime.connections.scheduleIdleDisconnect()
    }
  }

  private async probeInitializedBinding(
    input: AgentNativeInitializedBindingProbeInput,
    signal: AbortSignal,
  ): Promise<NativeProbeResult> {
    const identity: NativeEvidenceIdentity = {
      sessionId: input.sessionId,
      agentId: input.agentId,
      requestId: input.requestId,
      nativeSessionId: input.nativeSessionId,
      bindingGeneration: input.bindingGeneration,
    }
    const unavailable = (): NativeProbeResult => ({
      kind: 'no_evidence',
      identity,
      reason: 'The completed native initialization could not be confirmed by full readback.',
    })
    const unsettledOwner = (): boolean =>
      [...this.runtime.nativeBackground].some(
        (owner) =>
          !owner.closed &&
          (owner.primaryThreadId === input.nativeSessionId ||
            owner.threads.has(input.nativeSessionId)),
      ) ||
      [...this.runtime.nativeRebuildReceipts.values()].some(
        (receipt) => receipt.pending && receipt.nativeSessionId === input.nativeSessionId,
      )
    if (
      this.runtime.disposed ||
      signal.aborted ||
      input.agentId !== this.runtime.id ||
      input.runId !== undefined ||
      input.nativeTurnId !== undefined ||
      input.executorId !== undefined ||
      !input.confirmedInitialization.witness ||
      unsettledOwner()
    )
      return unavailable()
    clearTimeout(this.runtime.idleTimer)
    this.runtime.idleTimer = undefined
    try {
      const connection = await this.runtime.connections.ensureConnection(input.cwd)
      this.runtime.nativeCheck.recordPhysicalOwner(signal, { kind: 'shared_rpc' })
      await this.runtime.connections.initializeConnection(connection, signal)

      const response = await connection.request(
        'thread/read',
        { threadId: input.nativeSessionId, includeTurns: false },
        { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
      )
      const error = Reflect.get(response, 'error')
      if (error) {
        if (
          /not found|does not exist|unknown thread|missing thread|no rollout found/iu.test(
            JSON.stringify(error),
          )
        )
          return { kind: 'missing', identity, source: 'native_error' }
        return unavailable()
      }
      const result = Reflect.get(response, 'result')
      const thread =
        result && typeof result === 'object' ? Reflect.get(result, 'thread') : undefined
      if (
        !thread ||
        typeof thread !== 'object' ||
        Reflect.get(thread, 'id') !== input.nativeSessionId ||
        !['idle', 'notLoaded'].includes(Reflect.get(thread, 'status')?.type)
      )
        return unavailable()
      const { expected, seedHash } = await this.nativeSeedExpectation(
        input.confirmedInitialization,
        input.source,
        signal,
      )
      if (
        !(await this.readNativeSeed(
          connection,
          input.confirmedInitialization,
          input.nativeSessionId,
          expected,
          seedHash,
          signal,
          input.confirmedInitialization.witness,
        )) ||
        unsettledOwner()
      )
        return unavailable()
      observeThreadTitle(thread, input.observeNativeTitle)
      return {
        kind: 'binding_ready',
        source: 'completed_initialization_readback',
        identity,
        ...input.confirmedInitialization,
        witness: input.confirmedInitialization.witness,
      }
    } catch {
      return unavailable()
    } finally {
      this.runtime.connections.scheduleIdleDisconnect()
    }
  }

  private async nativeSeedExpectation(
    input: Pick<AgentNativeContextRebuildInput, 'rebuildId' | 'sourceHash'>,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<{ expected: string[]; seedHash: string }> {
    const expected: string[] = []
    const digest = createHash('sha256')
    for await (const text of this.nativeSeedTexts(input, source, signal)) {
      digest.update(text)
      expected.push(createHash('sha256').update(text).digest('hex'))
    }
    return { expected, seedHash: digest.digest('hex') }
  }

  /** Creation and cold verification must serialize exactly the same seed evidence. */
  private async *nativeSeedTexts(
    input: Pick<AgentNativeContextRebuildInput, 'rebuildId' | 'sourceHash'>,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    let count = 0
    let sourceBytes = 0
    for await (const chunk of source) {
      if (signal.aborted)
        throw new AgentExecutionError(
          'user_stopped',
          'Native source inspection was cancelled.',
          false,
        )
      sourceBytes += Buffer.byteLength(JSON.stringify(chunk), 'utf8')
      if (count >= 4096 || sourceBytes > 8 * 1024 * 1024)
        throw new AgentExecutionError(
          'response_too_large',
          'The complete native source exceeded its technical budget; it was not truncated.',
          false,
        )
      yield JSON.stringify({
        pactContext: true,
        pactRebuildId: input.rebuildId,
        pactSourceHash: input.sourceHash,
        chunkIndex: count++,
        ...(chunk.kind === 'image' ? { formatVersion: 'pact-native-context-v2' } : {}),
        ...chunk,
      })
    }
    if (signal.aborted)
      throw new AgentExecutionError(
        'user_stopped',
        'Native source preparation was cancelled.',
        false,
      )
    if (count === 0)
      yield JSON.stringify({
        pactContext: true,
        pactRebuildId: input.rebuildId,
        pactSourceHash: input.sourceHash,
        chunkIndex: 0,
        formatVersion: 'pact-native-context-v1',
        chunks: [],
      })
  }

  /** Cold native reads retain their complete-history work budget and never hydrate a full Thread. */
  private async *nativePages(
    connection: CodexAppServerConnection,
    method: 'thread/turns/list' | 'thread/items/list',
    params: object,
    signal: AbortSignal,
    maxItems: number,
    maxBytes: number,
  ): AsyncGenerator<object> {
    let cursor: string | undefined
    let count = 0
    let bytes = 0
    do {
      // oxlint-disable-next-line no-await-in-loop -- Native opaque cursor pages are ordered.
      const response = await connection.request(
        method,
        { limit: 25, sortDirection: 'asc', ...params, ...(cursor ? { cursor } : {}) },
        { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
      )
      const result = Reflect.get(response, 'result')
      const data = result && typeof result === 'object' ? Reflect.get(result, 'data') : undefined
      const next =
        result && typeof result === 'object' ? Reflect.get(result, 'nextCursor') : undefined
      if (
        Reflect.get(response, 'error') ||
        !Array.isArray(data) ||
        data.length > (Reflect.get(params, 'limit') ?? 25) ||
        (next != null && (typeof next !== 'string' || !next || next.length > 8192)) ||
        (next != null && (next === cursor || !data.length))
      )
        throw new AgentExecutionError('protocol_error', 'Invalid native history page.', false)
      for (const entry of data) {
        bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8')
        if (++count > maxItems || bytes > maxBytes)
          throw new AgentExecutionError(
            'response_too_large',
            'The complete native read exceeded its technical budget; it was not truncated.',
            false,
          )
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw new AgentExecutionError('protocol_error', 'Invalid native history entry.', false)
        yield entry
      }
      cursor = next ?? undefined
    } while (cursor)
  }

  private async readNativeTurns(
    connection: CodexAppServerConnection,
    threadId: string,
    signal: AbortSignal,
    targetTurnId?: string,
  ): Promise<object[]> {
    const turns: object[] = []
    const identities = new Set<string>()
    for await (const turn of this.nativePages(
      connection,
      'thread/turns/list',
      { threadId, itemsView: 'notLoaded', sortDirection: 'desc' },
      signal,
      1000,
      1024 * 1024,
    )) {
      const id = Reflect.get(turn, 'id')
      if (typeof id !== 'string' || !id || id.length > 1024 || identities.has(id))
        throw new AgentExecutionError('protocol_error', 'Invalid native Turn identity.', false)
      identities.add(id)
      turns.push(turn)
      // Older Turns cannot affect this request's terminal safety. Long native
      // histories therefore do not force Rebuild just to check a recent Turn.
      if (id === targetTurnId) break
    }
    return turns.toReversed()
  }

  private readNativeItems(
    connection: CodexAppServerConnection,
    threadId: string,
    turnId: string | undefined,
    signal: AbortSignal,
    maxItems: number,
    maxBytes: number,
  ): AsyncGenerator<object> {
    return this.nativePages(
      connection,
      'thread/items/list',
      { threadId, limit: 1, ...(turnId ? { turnId } : {}) },
      signal,
      maxItems,
      maxBytes,
    )
  }

  private async readNativeOutput(
    connection: CodexAppServerConnection,
    threadId: string,
    turnId: string,
    input: AgentNativeProbeInput,
    signal: AbortSignal,
    complete = false,
  ): Promise<Extract<NativeProbeResult, { kind: 'no_evidence' }>['output']> {
    return this.withNativeInspectionConnection(
      connection,
      input.cwd,
      signal,
      async (reader, readSignal) => {
        const items: object[] = []
        for await (const entry of this.readNativeItems(
          reader,
          threadId,
          turnId,
          readSignal,
          128,
          8 * 1024 * 1024,
        )) {
          const item = Reflect.get(entry, 'item')
          if (Reflect.get(entry, 'turnId') !== turnId || !item || typeof item !== 'object')
            throw new AgentExecutionError(
              'protocol_error',
              'Native answer ownership mismatch.',
              false,
            )
          items.push(item)
        }
        return historicalOutput([{ id: turnId, items, itemsView: 'full' }], input, complete)
      },
    )
  }

  private async withNativeInspectionConnection<T>(
    live: CodexAppServerConnection,
    cwd: string,
    signal: AbortSignal,
    read: (reader: CodexAppServerConnection, readSignal: AbortSignal) => Promise<T>,
    options: {
      nativeIdentity?: boolean
      beforeInitialize?: (reader: CodexAppServerConnection) => void
    } = {},
  ): Promise<T> {
    if (
      this.runtime.nativeInspection ||
      this.runtime.disposed ||
      !this.runtime.processStorageRoot ||
      this.runtime.connection !== live
    )
      throw new AgentExecutionError(
        'runtime_incompatible',
        'The bounded native history reader is unavailable.',
        false,
      )
    const controller = new AbortController()
    const readSignal = AbortSignal.any([signal, controller.signal])
    const deadline = setTimeout(() => controller.abort(), 10_000)
    this.runtime.nativeCheck.recordPhysicalOwner(signal, { kind: 'inspection_pending' })
    const owner: NonNullable<CodexAdapterRuntime['nativeInspection']> = {
      controller,
      connection: undefined,
      task: Promise.resolve(undefined),
    }
    const physical = Promise.withResolvers<void>()
    this.runtime.nativeCheck.observeRequest(signal, physical.promise)
    this.runtime.nativeInspection = owner
    // Install the entire lifecycle task before invoking a possibly asynchronous factory.
    const task = Promise.resolve().then(async () => {
      try {
        if (readSignal.aborted || this.runtime.disposed || this.runtime.connection !== live)
          throw new AgentExecutionError(
            'agent_process_crash',
            'The native history reader was cancelled before preparation.',
            false,
          )
        const owned = this.runtime.processFactory
          ? await this.runtime.connections.injectedProcess(cwd)
          : await this.runtime.connections.startProcess(cwd, this.runtime.processStorageRoot)
        if (owned.child === this.runtime.connectionProcess)
          throw new AgentExecutionError(
            'protocol_error',
            'The read-only process factory reused the live executor.',
            false,
          )
        const connection = new CodexAppServerConnection(
          owned.child,
          undefined,
          owned.close,
          this.runtime.ipcTraffic,
          () =>
            !this.runtime.disposed &&
            !readSignal.aborted &&
            this.runtime.nativeInspection === owner &&
            this.runtime.connection === live,
        )
        if (this.runtime.shutdownDeadlineAt !== undefined)
          connection.capShutdownDeadline(this.runtime.shutdownDeadlineAt)
        owner.connection = connection
        const checkContext = this.runtime.nativeCheck.contextFor(signal)
        if (checkContext && owned.physicalWitness) {
          try {
            const witness = await owned.physicalWitness(checkContext.operationId)
            checkContext.recordPhysicalOwner({ kind: 'inspection_group', witness })
          } catch {
            // Missing/oversized identity proof stays pending across restart; normal close is still required.
          }
        }
        if (readSignal.aborted || this.runtime.disposed || this.runtime.connection !== live)
          throw new AgentExecutionError(
            'agent_process_crash',
            'The native history reader was cancelled before initialization.',
            false,
          )
        options.beforeInitialize?.(connection)
        const initialized = await connection.request(
          'initialize',
          {
            clientInfo: options.nativeIdentity
              ? { name: 'pact', title: 'Pact', version: '0.0.0' }
              : {
                  name: 'pact-native-reader',
                  title: 'Pact native history reader',
                  version: '0.0.0',
                },
            capabilities: { experimentalApi: true },
          },
          { timeoutMs: 10_000, signal: readSignal },
        )
        if (!Reflect.has(initialized, 'result') || Reflect.get(initialized, 'error'))
          throw new AgentExecutionError(
            'protocol_error',
            'The native history reader did not initialize.',
            false,
          )
        if (readSignal.aborted || this.runtime.disposed || this.runtime.connection !== live)
          throw new AgentExecutionError(
            'agent_process_crash',
            'The native history reader was cancelled before its initialization acknowledgement.',
            false,
          )
        await connection.notify('initialized', {}, { signal: readSignal })
        return await read(connection, readSignal)
      } finally {
        clearTimeout(deadline)
        controller.abort()
        // A failed physical close keeps this same inspection owner reserved.
        await owner.connection?.close(new Error('Read-only native history inspection finished.'))
        if (this.runtime.nativeInspection === owner) this.runtime.nativeInspection = undefined
        this.runtime.nativeCheck.recordPhysicalOwner(signal, { kind: 'shared_rpc' })
        physical.resolve()
      }
    })
    owner.task = task
    return await task
  }

  /** Resolve only implicit Windows readonly defaults; never inherit an old Thread's grant. */
  async readWindowsDefaultPermissionSettings(
    live: CodexAppServerConnection,
    targetThreadId: string,
    signal: AbortSignal,
  ): Promise<object> {
    const cwd = this.runtime.processCwd,
      storageRoot = this.runtime.processStorageRoot,
      environmentKey = this.runtime.processEnvironmentKey
    const refusal = new PermissionModeRejectedError(
      'Native default permissions could not be safely resolved. Choose Ask for approval or configure a native permissions profile; no task was submitted.',
    )
    if (!cwd || !storageRoot || !environmentKey || this.runtime.connection !== live) throw refusal
    const current = (): boolean =>
      !signal.aborted &&
      !this.runtime.disposed &&
      live.isOpen &&
      this.runtime.connection === live &&
      this.runtime.processCwd === cwd &&
      this.runtime.processStorageRoot === storageRoot &&
      this.runtime.processEnvironmentKey === environmentKey &&
      createHash('sha256')
        .update(
          JSON.stringify({
            executable: this.runtime.executablePath,
            cwd,
            env: codexProcessEnvironment(storageRoot),
          }),
        )
        .digest('hex') === environmentKey
    let unexpected = false,
      releaseEvents: (() => void) | undefined,
      releaseRequests: (() => void) | undefined
    try {
      const policy = await this.withNativeInspectionConnection(
        live,
        cwd,
        signal,
        async (reader, readSignal) => {
          const readConfig = async (connection: CodexAppServerConnection): Promise<object> => {
            if (!current() || unexpected) throw refusal
            const response = await connection.request(
              'config/read',
              { cwd, includeLayers: false },
              { timeoutMs: 10_000, signal: readSignal },
            )
            const result = Reflect.get(response, 'result')
            if (
              Reflect.get(response, 'error') ||
              !result ||
              typeof result !== 'object' ||
              Array.isArray(result) ||
              Buffer.byteLength(JSON.stringify(result)) > 64 * 1024
            )
              throw refusal
            return result
          }
          const before = await readConfig(reader)
          if (!isDeepStrictEqual(before, await readConfig(live))) throw refusal
          const config = Reflect.get(before, 'config')
          if (!config || typeof config !== 'object' || Array.isArray(config)) throw refusal
          for (const key of ['hooks', 'mcp_servers', 'plugins']) {
            const value = Reflect.get(config, key)
            if (key === 'hooks') {
              if (!Object.hasOwn(config, key)) throw refusal
              if (value === null) continue
            }
            if (
              !value ||
              typeof value !== 'object' ||
              Array.isArray(value) ||
              Object.keys(value).length
            )
              throw refusal
          }
          const hookReply = await reader.request(
            'hooks/list',
            { cwds: [cwd] },
            { timeoutMs: 10_000, signal: readSignal },
          )
          const hooks = Reflect.get(Reflect.get(hookReply, 'result') ?? {}, 'data')
          if (
            Reflect.get(hookReply, 'error') ||
            !Array.isArray(hooks) ||
            hooks.length !== 1 ||
            hooks[0]?.cwd !== cwd ||
            !['hooks', 'warnings', 'errors'].every(
              (key) => Array.isArray(hooks[0][key]) && hooks[0][key].length === 0,
            )
          )
            throw refusal
          if (!current() || unexpected) throw refusal
          const response = await reader.request(
            'thread/start',
            { cwd, ephemeral: true, allowProviderModelFallback: false },
            { timeoutMs: 10_000, signal: readSignal },
          )
          const result = Reflect.get(response, 'result'),
            thread = result && typeof result === 'object' && Reflect.get(result, 'thread'),
            sandbox = result && Reflect.get(result, 'sandbox'),
            profile = result && Reflect.get(result, 'activePermissionProfile')
          if (
            Reflect.get(response, 'error') ||
            !thread ||
            typeof thread.id !== 'string' ||
            !thread.id ||
            thread.id.length > 1024 ||
            thread.id === targetThreadId ||
            this.runtime.loadedThreadIds.has(thread.id) ||
            thread.ephemeral !== true ||
            thread.cwd !== cwd ||
            !['untrusted', 'on-failure', 'on-request', 'never'].includes(result.approvalPolicy) ||
            !['user', 'auto_review'].includes(result.approvalsReviewer) ||
            sandbox?.type !== 'readOnly' ||
            sandbox.networkAccess !== false ||
            Object.keys(sandbox).length !== 2 ||
            profile?.id !== ':read-only' ||
            profile.extends !== null ||
            !isDeepStrictEqual(before, await readConfig(reader)) ||
            !isDeepStrictEqual(before, await readConfig(live)) ||
            !current() ||
            unexpected
          )
            throw refusal
          // One <=64-KiB result is owned by this permission installation, with no cache.
          return {
            approvalPolicy: result.approvalPolicy,
            approvalsReviewer: result.approvalsReviewer,
            sandboxPolicy: { ...sandbox },
          }
        },
        {
          nativeIdentity: true,
          beforeInitialize: (reader) => {
            const retire = (): void => {
              unexpected = true
              void reader.close(refusal).catch(() => undefined)
            }
            releaseEvents = reader.subscribeBackground((message) => {
              if (/^(?:hook|turn)\//u.test(String(Reflect.get(message, 'method')))) retire()
              return false
            })
            releaseRequests = reader.subscribeServerRequests(() => {
              retire()
              return true
            })
          },
        },
      )
      // The inspection's finally has already physically closed its independent process.
      if (!current() || unexpected) throw refusal
      return policy
    } catch {
      if (signal.aborted)
        throw new AgentExecutionError(
          'user_stopped',
          'Permission update was cancelled. No task was submitted.',
          false,
        )
      throw refusal
    } finally {
      releaseEvents?.()
      releaseRequests?.()
    }
  }

  private async verifyNativeSeed(
    connection: CodexAppServerConnection,
    input: AgentNativeContextRebuildInput,
    nativeSessionId: string,
    expected: readonly string[],
    seedHash: string,
    signal: AbortSignal,
  ): Promise<NativeInitializationWitness | undefined> {
    const receipt = this.runtime.nativeRebuildReceipts.get(input.rebuildId)
    if (
      !receipt ||
      receipt.executorId !== connection.executorId ||
      receipt.nativeSessionId !== nativeSessionId ||
      receipt.cwd !== input.cwd ||
      receipt.sourceHash !== input.sourceHash ||
      receipt.seedHash !== seedHash ||
      receipt.chunkCount !== expected.length ||
      !expected.length ||
      receipt.interactions?.size ||
      receipt.startupHooks?.pending.size ||
      receipt.startupHooks?.unconfirmed
    )
      return undefined
    const witness = await this.readNativeSeed(
      connection,
      input,
      nativeSessionId,
      expected,
      seedHash,
      signal,
    )
    return receipt.interactions?.size ||
      receipt.startupHooks?.pending.size ||
      receipt.startupHooks?.unconfirmed
      ? undefined
      : witness
  }

  /** Injected bootstrap seeds are response_items in the official rollout, not timeline Turns. */
  private async readNativeSeed(
    connection: CodexAppServerConnection,
    input: Pick<AgentNativeContextRebuildInput, 'rebuildId' | 'sourceHash'>,
    nativeSessionId: string,
    expected: readonly string[],
    seedHash: string,
    signal: AbortSignal,
    witness?: NativeInitializationWitness,
  ): Promise<NativeInitializationWitness | undefined> {
    const metadata = async (): Promise<object | undefined> => {
      const response = await connection.request(
        'thread/read',
        { threadId: nativeSessionId, includeTurns: false },
        { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
      )
      const result = Reflect.get(response, 'result')
      const thread =
        result && typeof result === 'object' ? Reflect.get(result, 'thread') : undefined
      if (
        Reflect.get(response, 'error') ||
        !thread ||
        typeof thread !== 'object' ||
        Reflect.get(thread, 'id') !== nativeSessionId ||
        !(witness ? ['idle', 'notLoaded'] : ['idle']).includes(Reflect.get(thread, 'status')?.type)
      )
        return undefined
      return thread
    }
    const thread = await metadata()
    const path = thread && Reflect.get(thread, 'path')
    if (!thread || typeof path !== 'string' || !this.runtime.processStorageRoot) return undefined
    const verified = await readCodexInitializationRollout(
      {
        storageRoot: this.runtime.processStorageRoot,
        path,
        nativeSessionId,
        rebuildId: input.rebuildId,
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        expectedSeedHashes: expected,
        seedHash,
        ...(witness ? { witness } : {}),
      },
      signal,
      (physicalCompletion) => this.runtime.nativeCheck.observeRequest(signal, physicalCompletion),
    )
    const after = await metadata()
    return after && Reflect.get(after, 'path') === path ? verified : undefined
  }

  async discoverSkills(
    cwd: string,
    signal: AbortSignal,
  ): Promise<import('@pact/contracts').SkillBinding[]> {
    signal.throwIfAborted()
    const connection = await this.runtime.connections.ensureConnection(cwd)
    await this.runtime.connections.initializeConnection(connection, signal)
    const reply = await connection.request(
      'skills/list',
      { cwds: [cwd], forceReload: true },
      { timeoutMs: 10_000, signal },
    )
    const error = Reflect.get(reply, 'error')
    if (error) throw new Error('Codex could not provide its native Skill catalog.')
    const result = nativeCodexSkillListSchema.parse(Reflect.get(reply, 'result'))
    const entry = result?.data?.find((value) => value.cwd === cwd)
    if (!entry || entry.errors.length)
      throw new Error(
        'Codex reported incomplete Skill discovery. Refresh after correcting its native configuration.',
      )
    return nativeSkillCatalog('codex', cwd, this.runtime.executablePath, entry.skills)
  }

  async enrichTitle(
    input: AgentTitleEnrichmentInput,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (this.runtime.disposed || signal.aborted) return undefined
    try {
      const connection = this.runtime.connection
      if (!connection?.isOpen || this.runtime.processCwd !== input.cwd) return undefined
      const response = await connection.request(
        'thread/read',
        { threadId: input.nativeSessionId, includeTurns: false },
        { timeoutMs: CODEX_TITLE_TIMEOUT_MS, signal },
      )
      const result = Reflect.get(response, 'result')
      const thread = result && typeof result === 'object' ? Reflect.get(result, 'thread') : null
      if (
        Reflect.get(response, 'error') ||
        !thread ||
        Reflect.get(thread, 'id') !== input.nativeSessionId ||
        this.runtime.connection !== connection ||
        signal.aborted
      )
        return undefined
      observeThreadTitle(thread, input.observeNativeTitle)
      return threadTitle(thread)
    } catch {
      return undefined
    }
  }

  async setNativeTitle(
    input: import('@pact/agent-runtime').AgentNativeTitleInput,
    signal: AbortSignal,
  ): Promise<'synchronized' | 'unavailable' | 'unknown_delivery'> {
    const connection = this.runtime.connection
    if (
      this.runtime.disposed ||
      signal.aborted ||
      !this.runtime.initialized ||
      !connection?.isOpen ||
      this.runtime.processCwd !== input.cwd ||
      !input.isCurrent() ||
      Buffer.byteLength(JSON.stringify({ threadId: input.nativeSessionId, name: input.title })) >
        8192
    )
      return 'unavailable'
    // A lost metadata ACK may still finish in this executor. Do not race it with
    // another write; the next normal connection reconciles the latest Pact value.
    if (this.runtime.uncertainTitleExecutor === connection.executorId) return 'unknown_delivery'
    let dispatched = false
    const request = async (method: string, params: object, write = false): Promise<object> => {
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), CODEX_TITLE_TIMEOUT_MS)
      try {
        return await connection.request(method, params, {
          timeoutMs: CODEX_TITLE_TIMEOUT_MS,
          signal: AbortSignal.any([signal, deadline.signal]),
          ...(write
            ? {
                canDispatch: () =>
                  this.runtime.connection === connection &&
                  connection.isOpen &&
                  !signal.aborted &&
                  input.isCurrent(),
                onDispatch: () => {
                  dispatched = true
                },
              }
            : {}),
        })
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      const read = await request('thread/read', {
        threadId: input.nativeSessionId,
        includeTurns: false,
      })
      const thread = Reflect.get(Reflect.get(read, 'result') ?? {}, 'thread')
      if (
        Reflect.get(read, 'error') ||
        !thread ||
        Reflect.get(thread, 'id') !== input.nativeSessionId ||
        this.runtime.connection !== connection ||
        !connection.isOpen ||
        signal.aborted ||
        !input.isCurrent()
      )
        return 'unavailable'
      if (Reflect.get(thread, 'name') === input.title) return 'synchronized'
      const response = await request(
        'thread/name/set',
        { threadId: input.nativeSessionId, name: input.title },
        true,
      )
      if (Reflect.get(response, 'error')) return 'unavailable'
      if (!Reflect.has(response, 'result')) {
        this.runtime.uncertainTitleExecutor = connection.executorId
        return 'unknown_delivery'
      }
      return 'synchronized'
    } catch {
      if (dispatched) {
        this.runtime.uncertainTitleExecutor = connection.executorId
        return 'unknown_delivery'
      }
      return 'unavailable'
    }
  }

  rememberNativeRebuild(id: string, value: NativeRebuildReceipt): void {
    const previous = this.runtime.nativeRebuildReceipts.get(id)
    this.runtime.nativeRebuildReceipts.delete(id)
    this.runtime.nativeRebuildReceipts.set(id, { ...previous, ...value })
    while (
      this.runtime.nativeRebuildReceipts.size > 8 ||
      Buffer.byteLength(JSON.stringify([...this.runtime.nativeRebuildReceipts]), 'utf8') > 64 * 1024
    ) {
      const oldest = [...this.runtime.nativeRebuildReceipts].find(
        ([, receipt]) => !receipt.pending,
      )?.[0]
      if (!oldest)
        throw new AgentExecutionError(
          'runtime_incompatible',
          'Native bootstrap metadata exceeded its bounded owner; live work was not terminated.',
          false,
        )
      this.runtime.nativeRebuildReceipts.delete(oldest)
    }
  }

  settleNativeRebuild(id: string): void {
    const receipt = this.runtime.nativeRebuildReceipts.get(id)
    if (!receipt) return
    receipt.pending = false
    receipt.release?.()
    receipt.observation?.abort()
    delete receipt.release
    delete receipt.observation
    delete receipt.interactions
    delete receipt.startupHooks
  }
}
