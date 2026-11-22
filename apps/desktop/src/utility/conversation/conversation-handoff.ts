import { randomUUID } from 'node:crypto'

import type { AgentAdapter, AgentPromptEnvelope } from '@pact/agent-runtime'
import type {
  AgentRun,
  AnchoredComment,
  CollaborationTask,
  ConversationPatch,
  DefaultSessionSettings,
  RpcResult,
  RuntimeAgentId,
  SkillBinding,
} from '@pact/contracts'
import type { ConversationRepository, SessionRepository } from '@pact/persistence'

import { agentDisplayName } from '@pact/contracts'
import { RunOperationConflictError } from '@pact/persistence'

import type { ConversationImages } from './conversation-images'
import type { CrossAgentContextBroker } from './cross-agent-context-broker'

import { AgentExecutionError } from './agent-execution-error'

export interface PendingRoutedContinuation {
  sessionId: string
  userMessageId: string
  agentId: RuntimeAgentId
}

export interface RoutedContinuationExecution {
  run: AgentRun
  protectedAgentId?: RuntimeAgentId | undefined
  abortController: AbortController
}

export interface PreparingRoutedContinuationHandle {
  sessionId: string
  userMessageId: string
  protectedAgentId: RuntimeAgentId
  controller: AbortController
  completion?: Promise<void> | undefined
}

export interface PreparedSessionForHandoff {
  projectDirectory: string
  executablePaths: Record<RuntimeAgentId, string>
}

export interface ConversationHandoffHost<
  TExecution extends RoutedContinuationExecution = RoutedContinuationExecution,
> {
  readonly conversations: ConversationRepository
  readonly sessions: SessionRepository
  readonly images?: ConversationImages | undefined
  readonly contextBroker: CrossAgentContextBroker
  readonly preparingContinuations: Map<string, PreparingRoutedContinuationHandle>
  isDisposed(): boolean
  adapterFor(
    sessionId: string,
    agentId: RuntimeAgentId,
    executablePath: string,
    signal: AbortSignal,
    cwd: string,
  ): Promise<AgentAdapter>
  skillBindings(
    sessionId: string,
    agentId: RuntimeAgentId,
    signal: AbortSignal,
    refresh: boolean,
    bypassCache: boolean,
  ): Promise<SkillBinding[]>
  hasBlockingBackgroundWork(sessionId: string): boolean
  prepareSession(
    sessionId: string,
    signal?: AbortSignal,
    extraRequiredAgents?: readonly RuntimeAgentId[],
  ): Promise<RpcResult<PreparedSessionForHandoff>>
  publish(patch: ConversationPatch, progress?: boolean): void
  trackExecution(run: AgentRun, work: (execution: TExecution) => Promise<void>): Promise<void>
  executeAttempts(
    execution: TExecution,
    run: AgentRun,
    promptEnvelope: AgentPromptEnvelope,
    cwd: string,
    settings: DefaultSessionSettings,
    executablePaths: Record<RuntimeAgentId, string>,
  ): Promise<void>
  schedulePendingRoutedContinuations(continueWorkflowScan?: boolean): void
}

export function pendingContinuationFailureCopy(agentId: RuntimeAgentId, error: unknown): string {
  const name = agentDisplayName(agentId)
  const detail = error instanceof Error ? error.message.trim() : ''
  return `${name} could not start the second @all response.${detail ? ` ${detail.slice(0, 300)}` : ''}`
}

export async function loadCollaborationBasis(
  conversations: ConversationRepository,
  images: ConversationImages | undefined,
  task: CollaborationTask,
  currentMessageId: string,
  signal: AbortSignal,
): Promise<AgentPromptEnvelope['collaborationBasis']> {
  const read = async (id: string | undefined) => {
    if (!id || id === currentMessageId) return undefined
    const source = await conversations.readCollaborationSource(task.sessionId, id, signal)
    const resolvedImages = (source.images ?? []).map((image) => {
      if (!images) throw new Error('Task images are unavailable.')
      return images.resolve(task.sessionId, image)
    })
    return {
      id,
      content: source.content,
      inputBatchRef: conversations.inputBatchForMessage(task.sessionId, id) ?? undefined,
      comments: source.comments.map(({ id: commentId, body, anchor }) => ({
        id: commentId,
        body,
        anchor,
      })),
      ...(resolvedImages.length ? { images: resolvedImages } : {}),
    }
  }
  const original = await read(task.taskMessageId)
  const latest =
    task.latestUserMessageId !== task.taskMessageId
      ? await read(task.latestUserMessageId)
      : undefined
  return { ...(original ? { original } : {}), ...(latest ? { latest } : {}) }
}

export async function beginPendingRoutedContinuation<
  TExecution extends RoutedContinuationExecution,
>(
  host: ConversationHandoffHost<TExecution>,
  pending: PendingRoutedContinuation,
  context: {
    cwd: string
    settings: DefaultSessionSettings
    settingsRevision: number
    executablePaths: Record<RuntimeAgentId, string>
  },
  signal: AbortSignal,
): Promise<
  | {
      started: ReturnType<ConversationRepository['beginRoutedContinuation']>
      prompt: AgentPromptEnvelope
    }
  | undefined
> {
  const message = host.conversations.internalMessage(pending.userMessageId, pending.sessionId)
  if (message?.route?.type !== 'all') return undefined
  const agentId = pending.agentId
  const adapter = await host.adapterFor(
    pending.sessionId,
    agentId,
    context.executablePaths[agentId],
    signal,
    context.cwd,
  )
  const nativeContext = host.conversations.nativeContext(pending.sessionId, agentId)
  if (nativeContext && nativeContext.continuationState !== 'ready') {
    return undefined
  }
  const frozen = host.conversations.skillInvocation(pending.userMessageId)
  if (frozen) {
    const current = await host.skillBindings(pending.sessionId, agentId, signal, true, true)
    if (
      frozen.bindings
        .filter((entry) => entry.agentId === agentId)
        .some((entry) => !current.some((item) => item.id === entry.id))
    )
      throw new RunOperationConflictError(
        'The secondary Agent Skill catalog changed. Its stage was not sent; the first answer is preserved.',
      )
  }
  const comments: AnchoredComment[] = []
  const handoff = await host.contextBroker.collectHandoff({
    sessionId: pending.sessionId,
    targetAgentId: agentId,
    signal,
    excludeMessageId: pending.userMessageId,
    throughSequence: message.sequence - 1,
  })
  const prompt = host.contextBroker.buildPromptEnvelope({
    sessionId: pending.sessionId,
    message: { id: message.id, content: message.content },
    comments,
    handoff,
  })
  host.contextBroker.assertPromptFitsBudget(prompt)
  adapter.preflightPrompt?.({
    runId: randomUUID(),
    sessionId: pending.sessionId,
    ...(nativeContext ? { nativeSessionId: nativeContext.nativeSessionId } : {}),
    peerAssistanceAllowed: false,
    cwd: context.cwd,
    promptEnvelope: prompt,
    model: context.settings.agents[agentId].model,
    effort: context.settings.agents[agentId].effort,
  })
  if (host.hasBlockingBackgroundWork(pending.sessionId)) return undefined
  return {
    started: host.conversations.beginRoutedContinuation({
      sessionId: pending.sessionId,
      userMessageId: pending.userMessageId,
      agentId,
      settingsRevision: context.settingsRevision,
      model: context.settings.agents[agentId].model,
      effort: context.settings.agents[agentId].effort,
      handoffSourceRefs: handoff.sourceRefs,
    }),
    prompt,
  }
}

export async function executeRoutedContinuation<TExecution extends RoutedContinuationExecution>(
  host: ConversationHandoffHost<TExecution>,
  execution: TExecution,
  userMessageId: string,
  cwd: string,
  settings: DefaultSessionSettings,
  executablePaths: Record<RuntimeAgentId, string>,
): Promise<void> {
  const message = host.conversations.internalMessage(userMessageId, execution.run.sessionId)
  if (message?.route?.type !== 'all') return
  const pending = host.conversations
    .pendingRoutedContinuations()
    .find((entry) => entry.userMessageId === userMessageId)
  if (!pending) {
    execution.protectedAgentId = undefined
    return
  }
  execution.protectedAgentId = pending.agentId
  const prepared = await beginPendingRoutedContinuation(
    host,
    pending,
    {
      cwd,
      settings,
      settingsRevision: execution.run.settingsRevision,
      executablePaths,
    },
    execution.abortController.signal,
  )
  if (!prepared) return
  const { started, prompt } = prepared
  execution.run = started.run
  execution.protectedAgentId = started.run.agentId
  host.publish(started.patch)
  await host.executeAttempts(execution, started.run, prompt, cwd, settings, executablePaths)
}

export async function preparePendingRoutedContinuation<
  TExecution extends RoutedContinuationExecution,
>(
  host: ConversationHandoffHost<TExecution>,
  pending: PendingRoutedContinuation,
  continuation: PreparingRoutedContinuationHandle,
): Promise<void> {
  try {
    const preparedSession = await host.prepareSession(
      pending.sessionId,
      continuation.controller.signal,
      [pending.agentId],
    )
    if (!preparedSession.ok)
      throw new AgentExecutionError('runtime_incompatible', preparedSession.error.message, false)
    if (
      host.isDisposed() ||
      continuation.controller.signal.aborted ||
      host.preparingContinuations.get(pending.sessionId) !== continuation
    )
      return
    const context = preparedSession.value
    const source = host.conversations.internalMessage(pending.userMessageId, pending.sessionId)
    const firstRun = source?.runId ? host.conversations.findRun(source.runId) : undefined
    const frozenSettings =
      firstRun && host.sessions.findSettingsRevision(pending.sessionId, firstRun.settingsRevision)
    if (!firstRun || !frozenSettings)
      throw new RunOperationConflictError('The original routed task settings are unavailable.')
    const prepared = await beginPendingRoutedContinuation(
      host,
      pending,
      {
        cwd: context.projectDirectory,
        settings: frozenSettings,
        settingsRevision: firstRun.settingsRevision,
        executablePaths: context.executablePaths,
      },
      continuation.controller.signal,
    )
    if (
      !prepared ||
      host.isDisposed() ||
      continuation.controller.signal.aborted ||
      host.preparingContinuations.get(pending.sessionId) !== continuation
    )
      return
    host.preparingContinuations.delete(pending.sessionId)
    host.publish(prepared.started.patch)
    void host.trackExecution(prepared.started.run, (execution) =>
      host.executeAttempts(
        execution,
        prepared.started.run,
        prepared.prompt,
        context.projectDirectory,
        frozenSettings,
        context.executablePaths,
      ),
    )
  } catch (error) {
    if (
      !host.isDisposed() &&
      !continuation.controller.signal.aborted &&
      host.preparingContinuations.get(pending.sessionId) === continuation
    )
      host.publish(
        host.conversations.failPendingRoutedContinuation(
          pending.sessionId,
          pending.userMessageId,
          pending.agentId,
          pendingContinuationFailureCopy(pending.agentId, error),
        ),
      )
  } finally {
    if (host.preparingContinuations.get(pending.sessionId) === continuation)
      host.preparingContinuations.delete(pending.sessionId)
    if (!host.isDisposed()) host.publish(host.conversations.metadataPatch(pending.sessionId))
    host.schedulePendingRoutedContinuations()
  }
}
