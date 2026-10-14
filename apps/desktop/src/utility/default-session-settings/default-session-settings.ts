import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { query, type ModelInfo, type Query } from '@anthropic-ai/claude-agent-sdk'
import { createInterface } from 'node:readline'

import type {
  AgentModelCatalog,
  AgentModelOption,
  DefaultSessionSettings as DefaultSessionSettingsValue,
  DefaultSessionSettingsEditorState,
  DefaultSessionSettingsSaveInput,
  DefaultSessionSettingsState,
  RpcResult,
  RuntimeAgentId,
} from '@pact/contracts'

import { DefaultSessionSettingsRepository } from '@pact/persistence'

import { OwnedProcessGroup } from '../owned-process-group'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation'

const CATALOG_TIMEOUT_MS = 15_000
const MAX_CODEX_MESSAGE_BYTES = 1024 * 1024
const OPERATION_TIMEOUT_MS = 24_000
const CLEANUP_RESERVE_MS = 4_000
type CatalogOperation = { controller: AbortController; done: Promise<void> }

interface CodexEffort {
  reasoningEffort: string
}

interface CodexModel {
  id: string
  displayName: string
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: CodexEffort[]
}

interface CollectedEditorState {
  editorState: DefaultSessionSettingsEditorState
  allAgentsReady: boolean
}

export class DefaultSessionSettings {
  private readonly operations = new Set<CatalogOperation>()
  private readonly probes = new Set<OwnedProcessGroup>()
  private disposed = false
  private disposal: Promise<void> | undefined
  constructor(
    private readonly runtimePreparation: RuntimePreparation,
    private readonly repository: DefaultSessionSettingsRepository,
  ) {}

  async loadEditorState(
    workingDirectory = process.cwd(),
  ): Promise<RpcResult<DefaultSessionSettingsEditorState>> {
    try {
      const { editorState } = await this.collectEditorState(workingDirectory)
      return { ok: true, value: editorState }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Default Session settings could not be loaded.' },
      }
    }
  }

  async saveDefaults(
    input: DefaultSessionSettingsSaveInput,
  ): Promise<RpcResult<DefaultSessionSettingsState>> {
    try {
      const { editorState, allAgentsReady } = await this.collectEditorState(process.cwd())
      if (!allAgentsReady) {
        return {
          ok: false,
          error: {
            code: 'RUNTIME_UNAVAILABLE',
            message: 'Both Agents must be ready before saving.',
          },
        }
      }

      const validationError =
        DefaultSessionSettings.validateAgentSelection(
          'claude',
          input.settings,
          editorState.modelCatalogs.claude,
        ) ??
        DefaultSessionSettings.validateAgentSelection(
          'codex',
          input.settings,
          editorState.modelCatalogs.codex,
        )
      if (validationError) {
        return { ok: false, error: { code: 'VALIDATION', message: validationError } }
      }
      if (this.disposed) throw new Error('Settings are shutting down.')
      return { ok: true, value: this.repository.save(input.settings) }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Default Session settings could not be saved.' },
      }
    }
  }

  async validateSettings(
    settings: DefaultSessionSettingsValue,
    workingDirectory: string,
  ): Promise<RpcResult<DefaultSessionSettingsEditorState>> {
    try {
      const { editorState, allAgentsReady } = await this.collectEditorState(workingDirectory)
      if (!allAgentsReady) {
        return {
          ok: false,
          error: { code: 'RUNTIME_UNAVAILABLE', message: 'Both Agents must be ready.' },
        }
      }

      const validationError =
        DefaultSessionSettings.validateAgentSelection(
          'claude',
          settings,
          editorState.modelCatalogs.claude,
        ) ??
        DefaultSessionSettings.validateAgentSelection(
          'codex',
          settings,
          editorState.modelCatalogs.codex,
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

  private async collectEditorState(workingDirectory: string): Promise<CollectedEditorState> {
    if (this.disposed || this.operations.size >= 4)
      throw new Error('The settings catalog capacity is unavailable.')
    const controller = new AbortController()
    const deadline = Date.now() + OPERATION_TIMEOUT_MS
    let resolveDone!: () => void
    const operation: CatalogOperation = {
      controller,
      done: new Promise((resolve) => {
        resolveDone = resolve
      }),
    }
    this.operations.add(operation)
    const timeout = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS)
    try {
      // Runtime Preparation remains the single source of truth for executable selection and
      // readiness. This Module consumes that result instead of rediscovering either CLI.
      const preparation = await this.runtimePreparation.inspectReadiness(controller.signal)
      controller.signal.throwIfAborted()
      if (!preparation.ok) throw new Error(preparation.error.message)

      const byId = new Map(preparation.value.agents.map((agent) => [agent.agentId, agent]))
      const claude = byId.get('claude')
      const codex = byId.get('codex')
      const catalogTimeout = Math.min(
        CATALOG_TIMEOUT_MS,
        deadline - Date.now() - CLEANUP_RESERVE_MS,
      )
      if (catalogTimeout <= 0) throw new Error('The settings catalog deadline was reached.')
      const catalogs = await Promise.allSettled(
        [
          claude?.state === 'ready' && claude.executablePath
            ? this.inspectClaudeModels(
                claude.executablePath,
                workingDirectory,
                claude.version,
                controller.signal,
                catalogTimeout,
              )
            : DefaultSessionSettings.unavailableCatalog(
                'claude',
                'Claude Code must be ready before models can be loaded.',
                claude?.version,
              ),
          codex?.state === 'ready' && codex.executablePath
            ? this.inspectCodexModels(
                codex.executablePath,
                workingDirectory,
                codex.version,
                controller.signal,
                catalogTimeout,
              )
            : DefaultSessionSettings.unavailableCatalog(
                'codex',
                'Codex must be ready before models can be loaded.',
                codex?.version,
              ),
        ].map((work) =>
          Promise.resolve(work).catch((error: unknown) => {
            controller.abort()
            throw error
          }),
        ),
      )
      const claudeResult = catalogs[0]!,
        codexResult = catalogs[1]!
      if (claudeResult.status !== 'fulfilled' || codexResult.status !== 'fulfilled')
        throw new Error('The settings catalog cleanup did not settle.')
      const claudeCatalog = claudeResult.value,
        codexCatalog = codexResult.value
      controller.signal.throwIfAborted()
      if (this.disposed) throw new Error('Settings are shutting down.')
      const current = this.repository.read()
      return {
        editorState: {
          modelCatalogs: { claude: claudeCatalog, codex: codexCatalog },
          ...(current ? { current } : {}),
        },
        allAgentsReady: claude?.state === 'ready' && codex?.state === 'ready',
      }
    } finally {
      clearTimeout(timeout)
      this.operations.delete(operation)
      resolveDone()
    }
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.disposal ??= (async () => {
      for (const operation of this.operations) operation.controller.abort()
      const results = await Promise.allSettled([
        ...[...this.operations].map((operation) => operation.done),
        ...[...this.probes].map((probe) => probe.close()),
      ])
      for (const probe of this.probes) if (probe.released) this.probes.delete(probe)
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
    const abortController = new AbortController()
    let session: Query | undefined
    const probe = this.ownProbe(signal, async () => {
      abortController.abort()
      session?.close()
      await session?.return(undefined).catch(() => undefined)
    })
    try {
      session = query({
        prompt: DefaultSessionSettings.idleClaudeInput(abortController.signal),
        options: {
          abortController,
          cwd: workingDirectory,
          pathToClaudeCodeExecutable: executablePath,
          permissionMode: 'dontAsk',
          permissionPrompts: 'none',
          persistSession: false,
          settingSources: ['user'],
          spawnClaudeCodeProcess: (specification) => {
            const child = probe.spawn(specification.command, specification.args, {
              cwd: specification.cwd,
              env: specification.env,
              signal: specification.signal,
            })
            child.stderr.resume()
            return child
          },
        },
      })
      const models = await DefaultSessionSettings.withTimeout(session.supportedModels(), timeoutMs)
      return {
        agentId: 'claude',
        status: 'available',
        ...(cliVersion ? { cliVersion } : {}),
        models: models
          .filter((model) => model.value !== 'default')
          .map((model) => DefaultSessionSettings.toClaudeModelOption(model)),
        checkedAt: new Date().toISOString(),
      }
    } catch {
      return DefaultSessionSettings.unavailableCatalog(
        'claude',
        'Claude Code did not provide its model list. CLI default remains available.',
        cliVersion,
      )
    } finally {
      await probe.close()
      if (probe.released) this.probes.delete(probe)
    }
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
    let child: ChildProcessWithoutNullStreams | undefined
    const probe = this.ownProbe(signal, () => {
      child?.stdin.end()
    })
    let lineReader: ReturnType<typeof createInterface> | undefined
    try {
      const runningChild = DefaultSessionSettings.startCodexAppServer(
        executablePath,
        workingDirectory,
        probe,
      )
      child = runningChild
      runningChild.stderr.resume()
      const lines = createInterface({ input: runningChild.stdout })
      lineReader = lines
      const send = (message: unknown): void => {
        runningChild.stdin.write(`${JSON.stringify(message)}\n`)
      }

      const models = await DefaultSessionSettings.withTimeout(
        new Promise<CodexModel[]>((resolve, reject) => {
          runningChild.once('error', reject)
          runningChild.once('exit', (code) =>
            reject(new Error(`Codex App Server exited (${code}).`)),
          )
          lines.on('line', (line) => {
            if (line.length > MAX_CODEX_MESSAGE_BYTES) {
              reject(new Error('Codex App Server returned an oversized message.'))
              return
            }
            let message: unknown
            try {
              message = JSON.parse(line)
            } catch {
              return
            }

            if (
              typeof message === 'object' &&
              message !== null &&
              Reflect.get(message, 'id') === 0
            ) {
              if (!Reflect.has(message, 'result')) {
                reject(new Error('Codex App Server initialization failed.'))
                return
              }
              send({ method: 'initialized', params: {} })
              send({ method: 'model/list', id: 1, params: { limit: 100, includeHidden: false } })
              return
            }

            const listed = DefaultSessionSettings.parseCodexModelListResponse(message)
            if (listed) resolve(listed)
          })
          send({
            method: 'initialize',
            id: 0,
            params: { clientInfo: { name: 'pact', title: 'Pact', version: '0.0.0' } },
          })
        }),
        timeoutMs,
      )
      return {
        agentId: 'codex',
        status: 'available',
        ...(cliVersion ? { cliVersion } : {}),
        models: models.map((model) => DefaultSessionSettings.toCodexModelOption(model)),
        checkedAt: new Date().toISOString(),
      }
    } catch {
      return DefaultSessionSettings.unavailableCatalog(
        'codex',
        'Codex did not provide its model list. CLI default remains available.',
        cliVersion,
      )
    } finally {
      lineReader?.close()
      await probe.close()
      if (probe.released) this.probes.delete(probe)
    }
  }

  private static validateAgentSelection(
    agentId: RuntimeAgentId,
    settings: DefaultSessionSettingsValue,
    catalog: AgentModelCatalog,
  ): string | undefined {
    const selection = settings.agents[agentId]
    if (selection.model === null) return undefined
    const model = catalog.models.find((option) => option.id === selection.model)
    if (!model) return `${agentId === 'claude' ? 'Claude Code' : 'Codex'} model is unavailable.`
    if (selection.effort !== null && !model.supportedEfforts.includes(selection.effort)) {
      return `${agentId === 'claude' ? 'Claude Code' : 'Codex'} effort is unavailable for this model.`
    }
    return undefined
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
    return option
  }

  private static parseCodexModelListResponse(message: unknown): CodexModel[] | undefined {
    if (typeof message !== 'object' || message === null || Reflect.get(message, 'id') !== 1) {
      return undefined
    }
    const result = Reflect.get(message, 'result')
    if (typeof result !== 'object' || result === null) return undefined
    const data = Reflect.get(result, 'data')
    return Array.isArray(data) && data.every((model) => DefaultSessionSettings.isCodexModel(model))
      ? data
      : undefined
  }

  private static isCodexModel(value: unknown): value is CodexModel {
    if (typeof value !== 'object' || value === null) return false
    return (
      typeof Reflect.get(value, 'id') === 'string' &&
      typeof Reflect.get(value, 'displayName') === 'string'
    )
  }

  private static startCodexAppServer(
    executablePath: string,
    workingDirectory: string,
    probe: OwnedProcessGroup,
  ): ChildProcessWithoutNullStreams {
    const isWindowsCommand = process.platform === 'win32' && /\.cmd$/iu.test(executablePath)
    if (isWindowsCommand && /[&|<>^%!"\r\n]/u.test(executablePath)) {
      throw new Error('Unsafe Windows executable path.')
    }
    const target = isWindowsCommand ? (process.env.ComSpec ?? 'cmd.exe') : executablePath
    const args = isWindowsCommand
      ? ['/d', '/s', '/c', `""${executablePath}" app-server"`]
      : ['app-server']
    return probe.spawn(target, args, {
      cwd: workingDirectory,
      windowsHide: true,
      windowsVerbatimArguments: isWindowsCommand,
    })
  }

  private static async withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Model catalog timed out.')), timeoutMs)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private static async *idleClaudeInput(signal: AbortSignal): AsyncGenerator<never, void> {
    if (signal.aborted) return
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    )
    yield* []
  }
}
