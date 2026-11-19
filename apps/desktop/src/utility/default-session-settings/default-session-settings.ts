import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'

import { rm } from 'node:fs/promises'

import type {
  AgentModelCatalog,
  AgentModelOption,
  DefaultSessionSettings as DefaultSessionSettingsValue,
  DefaultSessionSettingsEditorState,
  DefaultSessionSettingsSaveInput,
  DefaultSessionSettingsState,
  RpcResult,
  RuntimeAgentId,
  RuntimeAgentReadiness,
  RuntimePreparation as RuntimePreparationSnapshot,
} from '@pact/contracts'
import type { DiagnosticEvent } from '@pact/contracts/diagnostics'

import { DefaultSessionSettingsRepository } from '@pact/persistence'

import { recordDiagnostic } from '../../diagnostics/utility-log'
import { runClaudeInfoProbe, runCodexInfoProbe } from '../native-info-probe'
import { OwnedProcessGroup, OwnedProcessIdentityError } from '../owned-process-group'
import { isAgyProbeSettled, runAgyAcpProbe } from '../runtime-preparation/agy-acp-probe'
import {
  runtimeAgentDisplayName,
  RuntimePreparation,
} from '../runtime-preparation/runtime-preparation'

const ALL_RUNTIME_AGENTS: readonly RuntimeAgentId[] = ['claude', 'codex', 'agy']
const CATALOG_TIMEOUT_MS = 15_000
const MAX_CODEX_MESSAGE_BYTES = 1024 * 1024
const MAX_AGY_FRAME_BYTES = 256 * 1024
const MAX_AGY_TOTAL_BYTES = 2 * 1024 * 1024
const MAX_DISCOVERED_MODELS = 200
const MAX_DISCOVERED_CATALOG_BYTES = 256 * 1024
const OPERATION_TIMEOUT_MS = 24_000
const CLEANUP_RESERVE_MS = 4_000

export interface ActiveAgentPair {
  readonly primaryAgentId: RuntimeAgentId
  readonly secondaryAgentId: RuntimeAgentId
}

type CatalogOperation = { controller: AbortController; done: Promise<void> }

interface InFlightCatalogRead {
  readonly key: string
  readonly subscribers: Set<string>
  readonly operation: CatalogOperation
  readonly promise: Promise<CollectedEditorState>
}

interface ScopedCatalogState {
  pairKey: string
  generation: number
  generationController: AbortController
  subscription: { readonly read: InFlightCatalogRead; readonly token: string } | undefined
  waiters: number
}

interface CodexEffort {
  reasoningEffort: string
}

interface CodexModel {
  id: string
  displayName: string
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: CodexEffort[]
  serviceTiers?: { id: string; name: string; description: string }[]
}

interface AgyModelInfo {
  readonly modelId: string
  readonly name: string
  readonly description?: string
}

interface AgyConfigOptionValue {
  readonly value: string
  readonly name: string
  readonly description?: string
}

interface AgyConfigOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly category?: string
  readonly type: string
  readonly currentValue: string
  readonly options?: readonly AgyConfigOptionValue[]
}

interface CollectedEditorState {
  readonly editorState: DefaultSessionSettingsEditorState
  readonly preparation: RuntimePreparationSnapshot
  readonly activePair: ActiveAgentPair
}

interface CachedEditorStateEntry {
  readonly expiresAtMs: number
  readonly state: CollectedEditorState
  readonly isAuto?: boolean
}

const CATALOG_CACHE_TTL_MS = 30_000

function normalizePairKey(pair: ActiveAgentPair): string {
  return [pair.primaryAgentId, pair.secondaryAgentId].toSorted().join(':')
}

export class DefaultSessionSettings {
  private readonly operations = new Set<CatalogOperation>()
  private readonly activeScopeStates = new Map<string, ScopedCatalogState>()
  private readonly probes = new Set<OwnedProcessGroup>()
  private readonly unconfirmedAgyDirs = new Map<OwnedProcessGroup, string>()
  private readonly catalogReads = new Map<string, InFlightCatalogRead>()
  private readonly completedCatalogs = new Map<string, CachedEditorStateEntry>()
  private nextSubscriberSeq = 1
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly runtimePreparation: RuntimePreparation,
    private readonly repository: DefaultSessionSettingsRepository,
    private readonly options: { env?: NodeJS.ProcessEnv } = {},
  ) {}

  static selectInitialPair(
    agents: readonly Pick<RuntimeAgentReadiness, 'agentId' | 'state'>[],
  ): ActiveAgentPair {
    const byId = new Map(agents.map((agent) => [agent.agentId, agent]))
    const ready = ALL_RUNTIME_AGENTS.filter((agentId) => byId.get(agentId)?.state === 'ready')
    const remaining = ALL_RUNTIME_AGENTS.filter((agentId) => byId.get(agentId)?.state !== 'ready')
    const ordered = [...ready, ...remaining]
    return {
      primaryAgentId: ordered[0] ?? 'claude',
      secondaryAgentId: ordered[1] ?? 'codex',
    }
  }

  static createInitialSettings(
    agents: readonly Pick<RuntimeAgentReadiness, 'agentId' | 'state'>[],
  ): DefaultSessionSettingsValue {
    const { primaryAgentId, secondaryAgentId } = DefaultSessionSettings.selectInitialPair(agents)
    return {
      primaryAgentId,
      secondaryAgentId,
      agents: {
        claude: { model: null, effort: null, speed: 'native' },
        codex: { model: null, effort: null, speed: 'native' },
        agy: { model: null, effort: null, speed: 'native' },
      },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    }
  }

  async loadEditorState(
    workingDirectory = process.cwd(),
    activePair?: ActiveAgentPair,
  ): Promise<RpcResult<DefaultSessionSettingsEditorState>> {
    return this.loadScopedEditorState(workingDirectory, workingDirectory, activePair)
  }

  async loadSessionEditorState(
    sessionId: string,
    workingDirectory: string,
    activePair?: ActiveAgentPair,
  ): Promise<RpcResult<DefaultSessionSettingsEditorState>> {
    return this.loadScopedEditorState(`session:${sessionId}`, workingDirectory, activePair)
  }

  private async loadScopedEditorState(
    scopeKey: string,
    workingDirectory: string,
    activePair?: ActiveAgentPair,
  ): Promise<RpcResult<DefaultSessionSettingsEditorState>> {
    if (activePair && activePair.primaryAgentId === activePair.secondaryAgentId) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: 'Primary and secondary Agents must be different.',
        },
      }
    }
    try {
      const { editorState } = await this.collectEditorState(workingDirectory, activePair, {
        scopeKey,
        allowCache: true,
      })
      return { ok: true, value: editorState }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Default session settings could not be loaded.' },
      }
    }
  }

  async saveDefaults(
    input: DefaultSessionSettingsSaveInput,
  ): Promise<RpcResult<DefaultSessionSettingsState>> {
    if (input.settings.primaryAgentId === input.settings.secondaryAgentId) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: 'Primary and secondary Agents must be different.',
        },
      }
    }
    try {
      const pair: ActiveAgentPair = {
        primaryAgentId: input.settings.primaryAgentId,
        secondaryAgentId: input.settings.secondaryAgentId,
      }
      const { editorState, preparation } = await this.collectEditorState(process.cwd(), pair, {
        allowCache: false,
      })
      const readinessCheck = RuntimePreparation.validateActivePairReadiness(
        preparation,
        pair.primaryAgentId,
        pair.secondaryAgentId,
      )
      if (!readinessCheck.ok) {
        return {
          ok: false,
          error: {
            code: readinessCheck.code,
            message: readinessCheck.message,
          },
        }
      }

      const validationError =
        DefaultSessionSettings.validateAgentSelection(
          pair.primaryAgentId,
          input.settings,
          editorState.modelCatalogs[pair.primaryAgentId],
        ) ??
        DefaultSessionSettings.validateAgentSelection(
          pair.secondaryAgentId,
          input.settings,
          editorState.modelCatalogs[pair.secondaryAgentId],
        )
      if (validationError) {
        return { ok: false, error: { code: 'VALIDATION', message: validationError } }
      }
      if (this.disposed) throw new Error('Settings are shutting down.')

      const existing = this.repository.read()?.settings
      const unselectedAgentId = ALL_RUNTIME_AGENTS.find(
        (agentId) => agentId !== pair.primaryAgentId && agentId !== pair.secondaryAgentId,
      )
      const settingsToSave: DefaultSessionSettingsValue =
        existing && unselectedAgentId
          ? {
              ...input.settings,
              agents: {
                ...input.settings.agents,
                [unselectedAgentId]: existing.agents[unselectedAgentId],
              },
            }
          : input.settings

      const savedState = this.repository.save(settingsToSave)
      for (const [cacheKey, entry] of this.completedCatalogs) {
        if (entry.isAuto) {
          this.completedCatalogs.delete(cacheKey)
        }
      }
      return { ok: true, value: savedState }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Default session settings could not be saved.' },
      }
    }
  }

  async validateSettings(
    settings: DefaultSessionSettingsValue,
    workingDirectory: string,
  ): Promise<RpcResult<DefaultSessionSettingsEditorState>> {
    if (settings.primaryAgentId === settings.secondaryAgentId) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: 'Primary and secondary Agents must be different.',
        },
      }
    }
    try {
      const pair: ActiveAgentPair = {
        primaryAgentId: settings.primaryAgentId,
        secondaryAgentId: settings.secondaryAgentId,
      }
      const { editorState, preparation } = await this.collectEditorState(workingDirectory, pair, {
        allowCache: false,
      })
      const byId = new Map(preparation.agents.map((agent) => [agent.agentId, agent]))
      if (
        byId.get(pair.primaryAgentId)?.state !== 'ready' ||
        byId.get(pair.secondaryAgentId)?.state !== 'ready'
      ) {
        return {
          ok: false,
          error: { code: 'RUNTIME_UNAVAILABLE', message: 'Both selected Agents must be ready.' },
        }
      }

      const validationError =
        DefaultSessionSettings.validateAgentSelection(
          pair.primaryAgentId,
          settings,
          editorState.modelCatalogs[pair.primaryAgentId],
        ) ??
        DefaultSessionSettings.validateAgentSelection(
          pair.secondaryAgentId,
          settings,
          editorState.modelCatalogs[pair.secondaryAgentId],
        )
      return validationError
        ? { ok: false, error: { code: 'VALIDATION', message: validationError } }
        : { ok: true, value: editorState }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Session settings could not be validated.' },
      }
    }
  }

  readCachedOrFallbackModelCatalogs(
    workingDirectory: string,
    activePair: ActiveAgentPair,
  ): DefaultSessionSettingsEditorState['modelCatalogs'] {
    const key = this.runtimePreparation.catalogIdentity(
      workingDirectory,
      normalizePairKey(activePair),
    )
    const cached = this.readCompletedCatalogCache(key, activePair)
    if (cached) {
      return cached.editorState.modelCatalogs
    }
    const activeMembers = new Set<RuntimeAgentId>([
      activePair.primaryAgentId,
      activePair.secondaryAgentId,
    ])
    const buildCatalog = (agentId: RuntimeAgentId): AgentModelCatalog =>
      activeMembers.has(agentId)
        ? DefaultSessionSettings.unavailableCatalog(
            agentId,
            'Model list was not reloaded during role swap. Saved model selection is preserved.',
          )
        : DefaultSessionSettings.unavailableCatalog(
            agentId,
            `Select ${runtimeAgentDisplayName(agentId)} in the active pair to load its models.`,
          )
    return {
      claude: buildCatalog('claude'),
      codex: buildCatalog('codex'),
      agy: buildCatalog('agy'),
    }
  }

  async loadModelCatalogs(
    activePair?: ActiveAgentPair,
  ): Promise<DefaultSessionSettingsEditorState['modelCatalogs']> {
    return (await this.collectEditorState(process.cwd(), activePair, { allowCache: true }))
      .editorState.modelCatalogs
  }

  private resolveEffectivePairKey(requestedPair?: ActiveAgentPair): {
    pairKey: string
    effectivePair: ActiveAgentPair | undefined
  } {
    if (requestedPair) {
      return { pairKey: normalizePairKey(requestedPair), effectivePair: requestedPair }
    }
    const saved = this.repository.read()
    if (saved) {
      const pair: ActiveAgentPair = {
        primaryAgentId: saved.settings.primaryAgentId,
        secondaryAgentId: saved.settings.secondaryAgentId,
      }
      return {
        pairKey: `auto:${normalizePairKey(pair)}:at:${saved.updatedAt}`,
        effectivePair: pair,
      }
    }
    return { pairKey: 'auto:first-use', effectivePair: undefined }
  }

  private unsubscribeScopeFromRead(scopeState: ScopedCatalogState): CatalogOperation | undefined {
    const currentSub = scopeState.subscription
    if (!currentSub) return undefined
    scopeState.subscription = undefined
    currentSub.read.subscribers.delete(currentSub.token)
    if (currentSub.read.subscribers.size === 0) {
      if (this.catalogReads.get(currentSub.read.key) === currentSub.read) {
        this.catalogReads.delete(currentSub.read.key)
      }
      currentSub.read.operation.controller.abort()
      return currentSub.read.operation
    }
    return undefined
  }

  private async collectEditorState(
    workingDirectory: string,
    requestedPair?: ActiveAgentPair,
    options?: { scopeKey?: string; allowCache?: boolean },
  ): Promise<CollectedEditorState> {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS
    if (this.disposed) throw new Error('Settings are shutting down.')

    const scopeKey = options?.scopeKey ?? workingDirectory
    const { pairKey, effectivePair } = this.resolveEffectivePairKey(requestedPair)
    let scopeState = this.activeScopeStates.get(scopeKey)
    let expectedGeneration: number

    // Claim or supersede scopeState BEFORE awaiting prepareEnvironment or checking caches so a
    // newer pair request detaches its subscription immediately (and aborts the physical probe iff
    // zero subscribers remain).
    if (!scopeState) {
      if (this.activeScopeStates.size >= 4) {
        throw new Error('Catalog capacity is unavailable.')
      }
      scopeState = {
        pairKey,
        generation: 1,
        generationController: new AbortController(),
        subscription: undefined,
        waiters: 0,
      }
      this.activeScopeStates.set(scopeKey, scopeState)
      expectedGeneration = 1
    } else if (scopeState.pairKey !== pairKey) {
      scopeState.pairKey = pairKey
      scopeState.generation += 1
      scopeState.generationController.abort()
      scopeState.generationController = new AbortController()
      expectedGeneration = scopeState.generation
      const orphanedOperation = this.unsubscribeScopeFromRead(scopeState)
      if (orphanedOperation) {
        scopeState.waiters += 1
        try {
          await Promise.race([
            orphanedOperation.done,
            new Promise<void>((resolve) =>
              setTimeout(resolve, Math.max(0, deadline - Date.now() - CLEANUP_RESERVE_MS)),
            ),
          ])
        } finally {
          scopeState.waiters -= 1
        }
      }
      if (this.disposed) throw new Error('Settings are shutting down.')
      if (scopeState.generation !== expectedGeneration) {
        this.pruneScopeState(scopeKey, scopeState)
        const aborted = new Error('The settings pair selection was superseded.')
        aborted.name = 'AbortError'
        throw aborted
      }
    } else {
      expectedGeneration = scopeState.generation
    }

    try {
      await this.runtimePreparation.prepareEnvironment()
    } catch (error) {
      this.pruneScopeState(scopeKey, scopeState)
      throw error
    }
    if (this.disposed) {
      this.pruneScopeState(scopeKey, scopeState)
      throw new Error('Settings are shutting down.')
    }
    if (scopeState.generation !== expectedGeneration) {
      this.pruneScopeState(scopeKey, scopeState)
      const aborted = new Error('The settings pair selection was superseded.')
      aborted.name = 'AbortError'
      throw aborted
    }

    const key = this.runtimePreparation.catalogIdentity(workingDirectory, pairKey)
    if (options?.allowCache) {
      const cached = this.readCompletedCatalogCache(key, effectivePair)
      if (cached) {
        this.pruneScopeState(scopeKey, scopeState)
        return cached
      }
    }

    let inFlight = this.catalogReads.get(key)
    const token = `${scopeKey}#${expectedGeneration}:${this.nextSubscriberSeq++}`

    if (inFlight) {
      inFlight.subscribers.add(token)
    } else {
      if (this.disposed || this.operations.size >= 4 || this.catalogReads.size >= 4) {
        if (this.operations.size >= 4 || this.catalogReads.size >= 4) {
          DefaultSessionSettings.recordFailure(
            'admission',
            new Error('Catalog capacity is unavailable.'),
            'capacity',
          )
        }
        this.pruneScopeState(scopeKey, scopeState)
        throw new Error('Catalog capacity is unavailable.')
      }
      const controller = new AbortController()
      let resolveDone!: () => void
      const operation: CatalogOperation = {
        controller,
        done: new Promise((resolve) => {
          resolveDone = resolve
        }),
      }
      this.operations.add(operation)
      const subscribers = new Set<string>([token])
      const promise = this.collectEditorStateOnce(
        workingDirectory,
        deadline,
        operation,
        resolveDone,
        effectivePair,
      ).then((result) => {
        if (this.runtimePreparation.catalogIdentity(workingDirectory, pairKey) !== key) {
          throw new Error('The native model catalog configuration changed during discovery.')
        }
        this.writeCompletedCatalogCache(key, result, requestedPair === undefined)
        return result
      })
      const createdRead: InFlightCatalogRead = {
        key,
        subscribers,
        operation,
        promise,
      }
      this.catalogReads.set(key, createdRead)
      const clearRead = (): void => {
        if (this.catalogReads.get(key) === createdRead) {
          this.catalogReads.delete(key)
        }
      }
      void promise.then(clearRead, clearRead)
      inFlight = createdRead
    }

    // Detach any stale subscription on the same pairKey before attaching this generation's token.
    const staleOrphan = this.unsubscribeScopeFromRead(scopeState)
    void staleOrphan
    const generationSignal = scopeState.generationController.signal
    scopeState.subscription = { read: inFlight, token }
    scopeState.waiters += 1
    let onGenAbort: (() => void) | undefined
    try {
      const shared = await Promise.race([
        inFlight.promise,
        new Promise<never>((_, reject) => {
          onGenAbort = () => {
            const aborted = new Error('The settings pair selection was superseded.')
            aborted.name = 'AbortError'
            reject(aborted)
          }
          generationSignal.addEventListener('abort', onGenAbort, { once: true })
          if (generationSignal.aborted) onGenAbort()
        }),
      ])
      if (scopeState.generation !== expectedGeneration) {
        const aborted = new Error('The settings pair selection was superseded.')
        aborted.name = 'AbortError'
        throw aborted
      }
      return this.rebindCollectedState(shared, effectivePair)
    } finally {
      if (onGenAbort) generationSignal.removeEventListener('abort', onGenAbort)
      inFlight.subscribers.delete(token)
      if (scopeState.subscription?.token === token) {
        scopeState.subscription = undefined
      }
      if (inFlight.subscribers.size === 0 && this.catalogReads.get(key) === inFlight) {
        this.catalogReads.delete(key)
        inFlight.operation.controller.abort()
      }
      scopeState.waiters -= 1
      this.pruneScopeState(scopeKey, scopeState)
    }
  }

  private rebindCollectedState(
    source: CollectedEditorState,
    requestedPair?: ActiveAgentPair,
  ): CollectedEditorState {
    const current = this.repository.read()
    const effectivePair = requestedPair ?? source.activePair
    const { current: _previousCurrent, ...restEditorState } = source.editorState
    return {
      ...source,
      activePair: effectivePair,
      editorState: {
        ...restEditorState,
        recommendedPair: {
          primaryAgentId: effectivePair.primaryAgentId,
          secondaryAgentId: effectivePair.secondaryAgentId,
        },
        ...(current ? { current } : {}),
      },
    }
  }

  private readCompletedCatalogCache(
    key: string,
    requestedPair?: ActiveAgentPair,
  ): CollectedEditorState | undefined {
    const nowMs = Date.now()
    for (const [entryKey, entry] of this.completedCatalogs) {
      if (entry.expiresAtMs <= nowMs) this.completedCatalogs.delete(entryKey)
    }
    const hit = this.completedCatalogs.get(key)
    if (!hit) return undefined
    // Refresh LRU order.
    this.completedCatalogs.delete(key)
    this.completedCatalogs.set(key, hit)
    return this.rebindCollectedState(hit.state, requestedPair)
  }

  private writeCompletedCatalogCache(
    key: string,
    state: CollectedEditorState,
    isAuto = false,
  ): void {
    const primaryCatalog = state.editorState.modelCatalogs[state.activePair.primaryAgentId]
    const secondaryCatalog = state.editorState.modelCatalogs[state.activePair.secondaryAgentId]
    if (primaryCatalog.status !== 'available' || secondaryCatalog.status !== 'available') {
      return
    }
    this.completedCatalogs.delete(key)
    this.completedCatalogs.set(key, {
      expiresAtMs: Date.now() + CATALOG_CACHE_TTL_MS,
      state,
      ...(isAuto ? { isAuto: true } : {}),
    })
    while (this.completedCatalogs.size > 4) {
      const oldestKey = this.completedCatalogs.keys().next().value
      if (!oldestKey) break
      this.completedCatalogs.delete(oldestKey)
    }
  }

  private pruneScopeState(scopeKey: string, scopeState: ScopedCatalogState): void {
    if (
      scopeState.subscription === undefined &&
      scopeState.waiters === 0 &&
      this.activeScopeStates.get(scopeKey) === scopeState
    ) {
      this.activeScopeStates.delete(scopeKey)
    }
  }

  private async collectEditorStateOnce(
    workingDirectory: string,
    deadline: number,
    operation: CatalogOperation,
    resolveDone: () => void,
    requestedPair?: ActiveAgentPair,
  ): Promise<CollectedEditorState> {
    if (this.disposed) {
      this.operations.delete(operation)
      resolveDone()
      const error = new Error('Settings are shutting down.')
      DefaultSessionSettings.recordFailure('admission', error, 'disposed')
      throw error
    }
    const { controller } = operation
    const timeout = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()))
    let phase: DiagnosticEvent['settingsCatalogPhase'] = 'readiness'
    try {
      // Runtime Preparation remains the single source of truth for executable selection and
      // readiness. This Module consumes that result instead of rediscovering any CLI.
      const preparation = await this.runtimePreparation.inspectReadiness(controller.signal)
      controller.signal.throwIfAborted()
      if (!preparation.ok) {
        DefaultSessionSettings.recordFailure('readiness', undefined, 'readiness_failed')
        throw new Error(preparation.error.message)
      }

      const savedBefore = this.repository.read()
      const activePair: ActiveAgentPair =
        requestedPair ??
        (savedBefore
          ? {
              primaryAgentId: savedBefore.settings.primaryAgentId,
              secondaryAgentId: savedBefore.settings.secondaryAgentId,
            }
          : DefaultSessionSettings.selectInitialPair(preparation.value.agents))
      const activeMembers = new Set<RuntimeAgentId>([
        activePair.primaryAgentId,
        activePair.secondaryAgentId,
      ])

      const byId = new Map(preparation.value.agents.map((agent) => [agent.agentId, agent]))
      const catalogTimeout = Math.min(
        CATALOG_TIMEOUT_MS,
        deadline - Date.now() - CLEANUP_RESERVE_MS,
      )
      if (catalogTimeout <= 0) throw new Error('The settings catalog deadline was reached.')
      phase = 'catalogs'

      const loadForAgent = (agentId: RuntimeAgentId): Promise<AgentModelCatalog> => {
        const agent = byId.get(agentId)
        if (!activeMembers.has(agentId)) {
          return Promise.resolve(DefaultSessionSettings.unselectedCatalog(agentId, agent))
        }
        if (agent?.state !== 'ready' || !agent.executablePath) {
          return Promise.resolve(
            DefaultSessionSettings.unavailableCatalog(
              agentId,
              `${runtimeAgentDisplayName(agentId)} must be ready before models can be loaded.`,
              agent?.version,
            ),
          )
        }
        if (agentId === 'claude') {
          return this.inspectClaudeModels(
            agent.executablePath,
            workingDirectory,
            agent.version,
            controller.signal,
            catalogTimeout,
          )
        }
        if (agentId === 'codex') {
          return this.inspectCodexModels(
            agent.executablePath,
            workingDirectory,
            agent.version,
            controller.signal,
            catalogTimeout,
          )
        }
        return this.inspectAgyModels(
          agent.executablePath,
          agent.version,
          controller.signal,
          catalogTimeout,
        )
      }

      const catalogs = await Promise.allSettled(
        ALL_RUNTIME_AGENTS.map((agentId) =>
          Promise.resolve(loadForAgent(agentId)).catch((error: unknown) => {
            DefaultSessionSettings.recordFailure('catalogs', error)
            controller.abort()
            throw error
          }),
        ),
      )
      const claudeResult = catalogs[0]!,
        codexResult = catalogs[1]!,
        agyResult = catalogs[2]!
      if (
        claudeResult.status !== 'fulfilled' ||
        codexResult.status !== 'fulfilled' ||
        agyResult.status !== 'fulfilled'
      ) {
        throw new Error('The settings catalog cleanup did not settle.')
      }

      phase = 'post_catalog'
      controller.signal.throwIfAborted()
      if (this.disposed) throw new Error('Settings are shutting down.')
      phase = 'repository_read'
      const current = this.repository.read()
      return {
        editorState: {
          modelCatalogs: {
            claude: claudeResult.value,
            codex: codexResult.value,
            agy: agyResult.value,
          },
          recommendedPair: {
            primaryAgentId: activePair.primaryAgentId,
            secondaryAgentId: activePair.secondaryAgentId,
          },
          ...(current ? { current } : {}),
        },
        preparation: preparation.value,
        activePair,
      }
    } catch (error) {
      DefaultSessionSettings.recordFailure(phase, error)
      throw error
    } finally {
      clearTimeout(timeout)
      this.operations.delete(operation)
      resolveDone()
    }
  }

  /** Only fixed enums leave this boundary; native errors and their causes stay private. */
  private static recordFailure(
    phase: DiagnosticEvent['settingsCatalogPhase'],
    error: unknown,
    failure?: DiagnosticEvent['settingsCatalogFailure'],
  ): void {
    try {
      const names: Record<string, NonNullable<DiagnosticEvent['settingsCatalogFailure']>> = {
        'Catalog process capacity is unavailable.': 'capacity',
        'The owned process did not establish its owned group.': 'root_identity',
        'The owned group lost its verified process identity.': 'anchor_lost',
        'The owned group identity changed.': 'identity_changed',
        'Process group identities could not be checked.': 'os_observation',
        'Process group observation was invalid.': 'invalid_observation',
        'Process group identity was invalid.': 'invalid_observation',
        'Process group observation exceeded its limit.': 'capacity',
        'Process group ownership exceeded its identity limit.': 'capacity',
        'The owned process scope did not release before its deadline.': 'physical_cleanup_deadline',
        'Process input cleanup did not settle.': 'input_cleanup_deadline',
        'The settings catalog deadline was reached.': 'catalog_deadline',
        'Settings are shutting down.': 'disposed',
      }
      let current = error
      let identity: DiagnosticEvent['settingsCatalogIdentity']
      for (let depth = 0; !failure && depth < 8 && current instanceof Error; depth += 1) {
        if (current instanceof OwnedProcessIdentityError) identity = current.diagnostic
        const message = Object.getOwnPropertyDescriptor(current, 'message')?.value
        failure =
          current.name === 'AbortError'
            ? 'cancelled'
            : typeof message === 'string' && Object.hasOwn(names, message)
              ? names[message]
              : undefined
        current = Object.getOwnPropertyDescriptor(current, 'cause')?.value
      }
      recordDiagnostic({
        operation: 'ipc',
        phase: 'failed',
        level: 'error',
        code: 'INTERNAL',
        settingsCatalogPhase: phase,
        settingsCatalogFailure: failure ?? 'other',
        ...(failure === 'root_identity' && identity ? { settingsCatalogIdentity: identity } : {}),
      })
    } catch {
      // Optional diagnostics cannot replace the original catalog/cleanup exception.
    }
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.completedCatalogs.clear()
    this.disposal ??= (async () => {
      for (const operation of this.operations) operation.controller.abort()
      const results = await Promise.allSettled([
        ...[...this.operations].map((operation) => operation.done),
        ...[...this.probes].map((probe) => probe.close()),
      ])
      const settledDirs: string[] = []
      for (const [probe, dir] of this.unconfirmedAgyDirs.entries()) {
        if (isAgyProbeSettled(probe)) {
          this.unconfirmedAgyDirs.delete(probe)
          settledDirs.push(dir)
        }
      }
      await Promise.allSettled(settledDirs.map((dir) => rm(dir, { recursive: true, force: true })))
      for (const probe of this.probes) {
        if (isAgyProbeSettled(probe)) this.probes.delete(probe)
      }
      if (results.some((result) => result.status === 'rejected') || this.probes.size)
        throw new Error('Settings catalog processes did not finish their cleanup.')
    })()
    return this.disposal
  }

  private ownProbe(
    signal: AbortSignal,
    onCloseInput: () => void | Promise<void>,
  ): OwnedProcessGroup {
    signal.throwIfAborted()
    for (const [candidate, dir] of this.unconfirmedAgyDirs.entries()) {
      if (isAgyProbeSettled(candidate)) {
        this.unconfirmedAgyDirs.delete(candidate)
        void rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    for (const candidate of this.probes) {
      if (isAgyProbeSettled(candidate)) this.probes.delete(candidate)
    }
    if (this.disposed || this.probes.size >= 8)
      throw new Error('Catalog process capacity is unavailable.')
    const probe = new OwnedProcessGroup({ signal, onCloseInput })
    this.probes.add(probe)
    return probe
  }

  private async inspectClaudeModels(
    executablePath: string,
    workingDirectory: string,
    cliVersion: string | undefined,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<AgentModelCatalog> {
    // supportedModels() still requires an SDK session. Keep its input stream idle so discovery
    // cannot submit a model prompt, then abort and close the session after the catalog resolves.
    return runClaudeInfoProbe<AgentModelCatalog>({
      executablePath,
      workingDirectory,
      signal,
      timeoutMs,
      timeoutMessage: 'Model catalog timed out.',
      queryOptions: {
        permissionMode: 'dontAsk',
        permissionPrompts: 'none',
        persistSession: false,
        settingSources: ['user'],
      },
      ownProbe: (probeSignal, onCloseInput) => this.ownProbe(probeSignal, onCloseInput),
      inspect: async (session) => {
        const models = await session.supportedModels()
        if (
          models.length > MAX_DISCOVERED_MODELS ||
          Buffer.byteLength(JSON.stringify(models)) > MAX_DISCOVERED_CATALOG_BYTES
        ) {
          throw new Error('The Claude model catalog exceeds its discovery capacity.')
        }
        return {
          agentId: 'claude',
          status: 'available',
          ...(cliVersion ? { cliVersion } : {}),
          models: models
            .filter((model) => model.value !== 'default')
            .map((model) => DefaultSessionSettings.toClaudeModelOption(model)),
          checkedAt: new Date().toISOString(),
        }
      },
      onFailure: () =>
        DefaultSessionSettings.unavailableCatalog(
          'claude',
          'Claude Code did not provide its model list. CLI default remains available.',
          cliVersion,
        ),
      onCloseError: (error) => {
        DefaultSessionSettings.recordFailure('claude_close', error)
      },
      onProbeSettled: (probe) => {
        if (probe.released) this.probes.delete(probe)
      },
    })
  }

  private async inspectCodexModels(
    executablePath: string,
    workingDirectory: string,
    cliVersion: string | undefined,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<AgentModelCatalog> {
    // App Server exposes the catalog over JSONL. Only initialize the connection and request
    // model/list; do not create a Thread or start a Turn while opening Settings.
    return runCodexInfoProbe<AgentModelCatalog>({
      executablePath,
      workingDirectory,
      signal,
      timeoutMs,
      timeoutMessage: 'Model catalog timed out.',
      maxFrameBytes: MAX_CODEX_MESSAGE_BYTES,
      maxTotalBytes: 2 * MAX_CODEX_MESSAGE_BYTES,
      initializeParams: { clientInfo: { name: 'pact', title: 'Pact', version: '0.0.0' } },
      ownProbe: (probeSignal, onCloseInput) => this.ownProbe(probeSignal, onCloseInput),
      inspect: async (transport) => {
        const collected: CodexModel[] = []
        const cursors = new Set<string>()
        const collectPages = async (cursor?: string): Promise<void> => {
          const result = await transport.request('model/list', {
            limit: 25,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          })
          const listed = DefaultSessionSettings.parseCodexModelListResult(result)
          if (!listed) throw new Error('Codex App Server returned an invalid model catalog.')
          collected.push(...listed)
          if (
            collected.length > MAX_DISCOVERED_MODELS ||
            Buffer.byteLength(JSON.stringify(collected)) > MAX_DISCOVERED_CATALOG_BYTES
          ) {
            throw new Error('The Codex model catalog exceeds its discovery capacity.')
          }
          const nextCursor =
            result && typeof result === 'object' ? Reflect.get(result, 'nextCursor') : undefined
          if (nextCursor === null || nextCursor === undefined) return
          if (
            typeof nextCursor !== 'string' ||
            nextCursor.length > 1024 ||
            cursors.has(nextCursor) ||
            cursors.size >= 8
          ) {
            throw new Error('The Codex model cursor is invalid.')
          }
          cursors.add(nextCursor)
          await collectPages(nextCursor)
        }
        await collectPages()
        return {
          agentId: 'codex',
          status: 'available',
          ...(cliVersion ? { cliVersion } : {}),
          models: collected.map((model) => DefaultSessionSettings.toCodexModelOption(model)),
          checkedAt: new Date().toISOString(),
        }
      },
      onFailure: () =>
        DefaultSessionSettings.unavailableCatalog(
          'codex',
          'Codex did not provide its model list. CLI default remains available.',
          cliVersion,
        ),
      onCloseError: (error) => {
        DefaultSessionSettings.recordFailure('codex_close', error)
      },
      onProbeSettled: (probe) => {
        if (probe.released) this.probes.delete(probe)
      },
    })
  }

  private async inspectAgyModels(
    executablePath: string,
    cliVersion: string | undefined,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<AgentModelCatalog> {
    let latestNotifiedConfigOptions: AgyConfigOption[] | undefined
    let closeFailedError: unknown

    try {
      return await runAgyAcpProbe<AgentModelCatalog>({
        executablePath,
        ...(this.options.env ? { env: this.options.env } : {}),
        signal,
        timeoutMs,
        maxFrameBytes: MAX_AGY_FRAME_BYTES,
        maxTotalBytes: MAX_AGY_TOTAL_BYTES,
        // Clean up ONLY the single probe sessionId via session/close without ever scanning or
        // deleting files inside user conversation DB directories.
        deleteProbeSessionDb: false,
        ownProbe: (probeSignal, onCloseInput) => this.ownProbe(probeSignal, onCloseInput),
        onNotification: (method, params) => {
          if (method !== 'session/update' || !params || typeof params !== 'object') return
          const update = Reflect.get(params, 'update')
          if (!update || typeof update !== 'object') return
          const parsedOptions = DefaultSessionSettings.parseAgyConfigOptions(
            Reflect.get(update, 'configOptions'),
          )
          if (parsedOptions) {
            latestNotifiedConfigOptions = parsedOptions
          }
        },
        inspectSession: async ({ sessionId, newSessionResult, transport }) => {
          const parsedModels = DefaultSessionSettings.parseAgySessionModels(
            Reflect.get(newSessionResult, 'models'),
          )
          const initialConfigOptions = DefaultSessionSettings.parseAgyConfigOptions(
            Reflect.get(newSessionResult, 'configOptions'),
          )
          const modelConfigOption = initialConfigOptions?.find(
            (option) => option.id === 'model' || option.category === 'model',
          )
          if (!parsedModels && !modelConfigOption?.options?.length) {
            throw new Error('Antigravity ACP returned an invalid model catalog.')
          }
          if (
            parsedModels &&
            (parsedModels.availableModels.length > MAX_DISCOVERED_MODELS ||
              Buffer.byteLength(JSON.stringify(parsedModels.availableModels)) >
                MAX_DISCOVERED_CATALOG_BYTES)
          ) {
            throw new Error('The Antigravity model catalog exceeds its discovery capacity.')
          }
          if (
            modelConfigOption?.options &&
            (modelConfigOption.options.length > MAX_DISCOVERED_MODELS ||
              Buffer.byteLength(JSON.stringify(modelConfigOption.options)) >
                MAX_DISCOVERED_CATALOG_BYTES)
          ) {
            throw new Error('The Antigravity model catalog exceeds its discovery capacity.')
          }

          const modelConfigId = modelConfigOption?.id ?? 'model'
          let activeModelId =
            modelConfigOption && modelConfigOption.currentValue.length > 0
              ? modelConfigOption.currentValue
              : parsedModels?.currentModelId
          let activeConfigOptions: readonly AgyConfigOption[] | undefined = initialConfigOptions
          let setConfigUnsupported = false
          const resolvedOptions: AgentModelOption[] = []
          const selectableModelIds = new Set<string>()
          const configOptionValues = new Set<string>(
            (modelConfigOption?.options ?? []).map((option) => option.value),
          )

          const probeModelThoughtLevel = async (
            targetModelId: string,
            forcePreferSetModel = false,
          ): Promise<{ supportedEfforts: string[]; defaultEffort?: string }> => {
            let modelConfigOptions: readonly AgyConfigOption[] | undefined
            if (activeModelId === targetModelId && activeConfigOptions !== undefined) {
              modelConfigOptions = activeConfigOptions
            } else {
              latestNotifiedConfigOptions = undefined
              modelConfigOptions = await DefaultSessionSettings.resolveAgyModelConfigOptions({
                sessionId,
                modelId: targetModelId,
                modelConfigId,
                transport,
                preferSetModel: setConfigUnsupported || forcePreferSetModel,
                readLatestNotified: () => latestNotifiedConfigOptions,
                onSetConfigUnsupported: () => {
                  setConfigUnsupported = true
                },
              })
              if (modelConfigOptions !== undefined) {
                activeModelId = targetModelId
                activeConfigOptions = modelConfigOptions
              } else {
                activeModelId = undefined
                activeConfigOptions = undefined
              }
            }
            return DefaultSessionSettings.extractAgyThoughtLevel(modelConfigOptions)
          }

          if (modelConfigOption?.options?.length) {
            for (const option of modelConfigOption.options) {
              selectableModelIds.add(option.value)
              // oxlint-disable-next-line no-await-in-loop -- Each selectable model sequentially inspects configOptions on the single open zero-Turn probe session.
              const effortMeta = await probeModelThoughtLevel(option.value)
              resolvedOptions.push({
                id: option.value,
                displayName: option.name,
                supportedEfforts: effortMeta.supportedEfforts,
                ...(effortMeta.defaultEffort ? { defaultEffort: effortMeta.defaultEffort } : {}),
              })
            }
          }

          const knownPreExpandedVariants = new Set<string>()
          for (const resolved of resolvedOptions) {
            for (const effort of resolved.supportedEfforts) {
              knownPreExpandedVariants.add(`${resolved.id}-${effort}`)
            }
          }

          // Pass through ALL real availableModels entries unchanged (without hiding entries via coveredVariantIds).
          for (const model of parsedModels?.availableModels ?? []) {
            if (selectableModelIds.has(model.modelId)) {
              continue
            }
            selectableModelIds.add(model.modelId)
            if (knownPreExpandedVariants.has(model.modelId)) {
              resolvedOptions.push({
                id: model.modelId,
                displayName: model.name,
                supportedEfforts: [],
              })
              continue
            }
            // oxlint-disable-next-line no-await-in-loop -- Standalone availableModels entries sequentially inspect configOptions on the single open zero-Turn probe session.
            const effortMeta = await probeModelThoughtLevel(
              model.modelId,
              configOptionValues.size > 0 && !configOptionValues.has(model.modelId),
            )
            resolvedOptions.push({
              id: model.modelId,
              displayName: model.name,
              supportedEfforts: effortMeta.supportedEfforts,
              ...(effortMeta.defaultEffort ? { defaultEffort: effortMeta.defaultEffort } : {}),
            })
          }

          if (
            resolvedOptions.length > MAX_DISCOVERED_MODELS ||
            Buffer.byteLength(JSON.stringify(resolvedOptions)) > MAX_DISCOVERED_CATALOG_BYTES
          ) {
            throw new Error('The Antigravity model catalog exceeds its discovery capacity.')
          }

          return {
            agentId: 'agy',
            status: 'available',
            ...(cliVersion ? { cliVersion } : {}),
            models: resolvedOptions,
            checkedAt: new Date().toISOString(),
          }
        },
        onCloseError: (error, probe, probeCwd) => {
          closeFailedError = error
          if (!isAgyProbeSettled(probe)) {
            this.unconfirmedAgyDirs.set(probe, probeCwd)
          }
          DefaultSessionSettings.recordFailure('catalogs', error)
        },
        onProbeSettled: (probe) => {
          if (isAgyProbeSettled(probe)) {
            this.unconfirmedAgyDirs.delete(probe)
            this.probes.delete(probe)
          }
        },
      })
    } catch (error) {
      if (closeFailedError !== undefined) throw error
      if (signal.aborted && this.disposed) throw error
      if (error instanceof Error && error.message === 'Catalog process capacity is unavailable.') {
        throw error
      }
      return DefaultSessionSettings.unavailableCatalog(
        'agy',
        'Antigravity did not provide its model list. CLI default remains available.',
        cliVersion,
      )
    }
  }

  private static async resolveAgyModelConfigOptions(input: {
    sessionId: string
    modelId: string
    modelConfigId: string
    transport: { request: (method: string, params: Record<string, unknown>) => Promise<unknown> }
    preferSetModel: boolean
    readLatestNotified: () => AgyConfigOption[] | undefined
    onSetConfigUnsupported: () => void
  }): Promise<readonly AgyConfigOption[] | undefined> {
    if (!input.preferSetModel) {
      try {
        const reply = await input.transport.request('session/set_config_option', {
          sessionId: input.sessionId,
          configId: input.modelConfigId,
          value: input.modelId,
        })
        const fromReply =
          reply && typeof reply === 'object'
            ? DefaultSessionSettings.parseAgyConfigOptions(Reflect.get(reply, 'configOptions'))
            : undefined
        return fromReply ?? input.readLatestNotified()
      } catch (error) {
        const rpcCode =
          error && typeof error === 'object' && 'rpcCode' in error ? error.rpcCode : undefined
        if (rpcCode === -32601) {
          input.onSetConfigUnsupported()
        }
        // Fall through to session/set_model on any error (e.g. standalone availableModels entry
        // rejected as an invalid configOptions.model value, or -32601 unsupported method).
      }
    }

    try {
      const reply = await input.transport.request('session/set_model', {
        sessionId: input.sessionId,
        modelId: input.modelId,
      })
      const fromReply =
        reply && typeof reply === 'object'
          ? DefaultSessionSettings.parseAgyConfigOptions(Reflect.get(reply, 'configOptions'))
          : undefined
      return fromReply ?? input.readLatestNotified()
    } catch {
      return undefined
    }
  }

  private static parseAgySessionModels(value: unknown):
    | {
        readonly availableModels: readonly AgyModelInfo[]
        readonly currentModelId: string | undefined
      }
    | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const rawAvailable = Reflect.get(value, 'availableModels')
    if (!Array.isArray(rawAvailable)) return undefined
    const availableModels: AgyModelInfo[] = []
    for (const entry of rawAvailable) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
      const modelId = Reflect.get(entry, 'modelId')
      const name = Reflect.get(entry, 'name')
      const description = Reflect.get(entry, 'description')
      if (typeof modelId !== 'string' || modelId.length === 0) return undefined
      if (typeof name !== 'string' || name.length === 0) return undefined
      availableModels.push({
        modelId,
        name,
        ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
      })
    }
    const rawCurrent = Reflect.get(value, 'currentModelId')
    return {
      availableModels,
      currentModelId:
        typeof rawCurrent === 'string' && rawCurrent.length > 0 ? rawCurrent : undefined,
    }
  }

  private static parseAgyConfigOptions(value: unknown): AgyConfigOption[] | undefined {
    if (!Array.isArray(value)) return undefined
    const options: AgyConfigOption[] = []
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const id = Reflect.get(item, 'id')
      const name = Reflect.get(item, 'name')
      const type = Reflect.get(item, 'type')
      const currentValue = Reflect.get(item, 'currentValue')
      if (typeof id !== 'string' || id.length === 0) continue
      const category = Reflect.get(item, 'category')
      const rawValues = Reflect.get(item, 'options')
      let values: AgyConfigOptionValue[] | undefined
      if (Array.isArray(rawValues)) {
        values = []
        for (const choice of rawValues) {
          if (!choice || typeof choice !== 'object' || Array.isArray(choice)) continue
          const choiceVal = Reflect.get(choice, 'value')
          const choiceName = Reflect.get(choice, 'name')
          if (typeof choiceVal === 'string' && choiceVal.length > 0) {
            values.push({
              value: choiceVal,
              name:
                typeof choiceName === 'string' && choiceName.length > 0 ? choiceName : choiceVal,
            })
          }
        }
      }
      options.push({
        id,
        name: typeof name === 'string' ? name : id,
        ...(typeof category === 'string' ? { category } : {}),
        type: typeof type === 'string' ? type : 'select',
        currentValue: typeof currentValue === 'string' ? currentValue : '',
        ...(values ? { options: values } : {}),
      })
    }
    return options
  }

  private static extractAgyThoughtLevel(configOptions: readonly AgyConfigOption[] | undefined): {
    supportedEfforts: string[]
    defaultEffort?: string
  } {
    if (!configOptions) return { supportedEfforts: [] }
    const thoughtOption = configOptions.find(
      (option) => option.id === 'thought_level' || option.category === 'thought_level',
    )
    if (!thoughtOption || !thoughtOption.options || thoughtOption.options.length === 0) {
      return { supportedEfforts: [] }
    }
    const supportedEfforts: string[] = []
    for (const option of thoughtOption.options) {
      if (option.value.length > 0 && !supportedEfforts.includes(option.value)) {
        supportedEfforts.push(option.value)
      }
    }
    if (supportedEfforts.length === 0) return { supportedEfforts: [] }
    const defaultEffort =
      thoughtOption.currentValue.length > 0 && supportedEfforts.includes(thoughtOption.currentValue)
        ? thoughtOption.currentValue
        : undefined
    return {
      supportedEfforts,
      ...(defaultEffort ? { defaultEffort } : {}),
    }
  }

  private static validateAgentSelection(
    agentId: RuntimeAgentId,
    settings: DefaultSessionSettingsValue,
    catalog: AgentModelCatalog,
  ): string | undefined {
    const selection = settings.agents[agentId]
    if (selection.model === null) return undefined
    const agentName = runtimeAgentDisplayName(agentId)
    const model = catalog.models.find((option) => option.id === selection.model)
    if (!model) {
      return `${agentName} model is unavailable.`
    }
    if (selection.effort !== null && !model.supportedEfforts.includes(selection.effort)) {
      return `${agentName} effort is unavailable for this model.`
    }
    return undefined
  }

  private static unselectedCatalog(
    agentId: RuntimeAgentId,
    readiness: RuntimeAgentReadiness | undefined,
  ): AgentModelCatalog {
    const agentName = runtimeAgentDisplayName(agentId)
    const detail =
      readiness?.state === 'ready'
        ? `Select ${agentName} in the active pair to load its models.`
        : `${agentName} must be ready before models can be loaded.`
    return DefaultSessionSettings.unavailableCatalog(agentId, detail, readiness?.version)
  }

  private static unavailableCatalog(
    agentId: RuntimeAgentId,
    detail: string,
    cliVersion?: string,
  ): AgentModelCatalog {
    return {
      agentId,
      status: 'unavailable',
      ...(cliVersion ? { cliVersion } : {}),
      models: [],
      detail,
      checkedAt: new Date().toISOString(),
    }
  }

  private static toClaudeModelOption(model: ModelInfo): AgentModelOption {
    return {
      id: model.value,
      ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
      displayName: model.displayName,
      supportedEfforts: model.supportedEffortLevels ?? [],
      ...(typeof model.supportsFastMode === 'boolean'
        ? { supportsFastMode: model.supportsFastMode }
        : {}),
    }
  }

  private static toCodexModelOption(model: CodexModel): AgentModelOption {
    const option: AgentModelOption = {
      id: model.id,
      displayName: model.displayName,
      supportedEfforts:
        model.supportedReasoningEfforts?.map((effort) => effort.reasoningEffort) ?? [],
    }
    if (model.defaultReasoningEffort) option.defaultEffort = model.defaultReasoningEffort
    if (Array.isArray(model.serviceTiers))
      option.supportsFastMode = model.serviceTiers.some(
        (tier) => tier.id === 'priority' && tier.name === 'Fast',
      )
    return option
  }

  private static parseCodexModelListResult(result: unknown): CodexModel[] | undefined {
    if (typeof result !== 'object' || result === null) return undefined
    const data = Reflect.get(result, 'data')
    return Array.isArray(data) && data.every((model) => DefaultSessionSettings.isCodexModel(model))
      ? data
      : undefined
  }

  private static isCodexModel(value: unknown): value is CodexModel {
    if (typeof value !== 'object' || value === null) return false
    const tiers = Reflect.get(value, 'serviceTiers')
    return (
      typeof Reflect.get(value, 'id') === 'string' &&
      typeof Reflect.get(value, 'displayName') === 'string' &&
      (tiers === undefined ||
        (Array.isArray(tiers) &&
          tiers.length <= 16 &&
          tiers.every(
            (tier) =>
              tier &&
              typeof tier === 'object' &&
              typeof Reflect.get(tier, 'id') === 'string' &&
              typeof Reflect.get(tier, 'name') === 'string' &&
              typeof Reflect.get(tier, 'description') === 'string',
          )))
    )
  }
}
