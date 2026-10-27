import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, vi } from 'vitest'

import type { AgentRunInput } from '@pact/agent-runtime'
import type {
  CollaborationAction,
  CollaborationReviewObservation,
  DecisionInput,
  DecisionOutcome,
  NormalizedAgentEvent,
  RuntimeAgentId,
} from '@pact/contracts'

import {
  advanceCollaboration,
  collaborationTaskSchema,
  collaborationDocumentSchema,
  collaborationInputBatchReferenceSchema,
} from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import type { CodexDecisionRuntime } from './codex-decision-runtime.js'
import type { DecisionInputLoader } from './codex-decision-runtime.js'
import type { Conversation } from './conversation.js'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { AgentExecutionError } from './agent-execution-error.js'
import { collaborationPlanMode } from './collaboration-prompt.js'
import { DecisionMemoryLease } from './native-working-memory.js'

export interface WorkflowNativeState {
  inputs: AgentRunInput[]
  reviews: CollaborationReviewObservation[]
  decisions: DecisionInput[]
  candidate: string | null | undefined
  interruptNextWrite: boolean
  loseObservation: boolean
  rebuilds: string[]
  sourceReads: WorkflowSourceRead[]
  unselectedPlan?: string | undefined
  forbiddenDocuments?: import('@pact/contracts').CollaborationDocument[]
  information?: import('@pact/contracts').DecisionInformation | undefined
}

export interface WorkflowSourceRead {
  runId: string
  documents: Array<{ id: string; sha256: string; text: string }>
  inputBodies: string[]
  comments: Array<{ id: string; text: string }>
  rejectedDocumentIds: string[]
}
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid source page object')
  return Reflect.get(value, key)
}
function items(value: unknown, key: string): unknown[] {
  const result = field(value, key)
  if (!Array.isArray(result)) throw Error('Invalid source page items')
  return result
}
function readWorkflowSources(
  input: AgentRunInput,
  forbidden: import('@pact/contracts').CollaborationDocument[] = [],
): WorkflowSourceRead {
  const read = input.readCollaborationSourcePart!,
    grant = input.promptEnvelope.sourceGrant
  const result: WorkflowSourceRead = {
    runId: input.runId,
    documents: [],
    inputBodies: [],
    comments: [],
    rejectedDocumentIds: [],
  }
  const documentText = (raw: unknown) => {
    const document = collaborationDocumentSchema.parse(raw)
    let text = '',
      offset = 0
    for (;;) {
      const page = read({ ...grant, source: 'document', document, offset })
      text += page.text
      if (page.nextOffset === null) break
      offset = page.nextOffset
    }
    if (createHash('sha256').update(text).digest('hex') !== document.sha256)
      throw Error('Incomplete frozen source at native seam')
    result.documents.push({ id: document.id, sha256: document.sha256, text })
    return text
  }
  const readBatch = (raw: unknown) => {
    const batch = collaborationInputBatchReferenceSchema.parse({
      id: field(raw, 'id'),
      revision: field(raw, 'revision'),
      memberCount: field(raw, 'memberCount'),
    })
    let offset = 0
    for (;;) {
      const page = read({ ...grant, source: 'batch', batchId: batch.id, offset }),
        value: unknown = JSON.parse(page.text)
      const body = field(value, 'body')
      if (body !== undefined) result.inputBodies.push(documentText(body))
      for (const member of items(value, 'members')) {
        const id = field(member, 'commentId')
        if (typeof id !== 'string') throw Error('Invalid frozen Comment identity')
        documentText(field(member, 'anchorDocument'))
        result.comments.push({ id, text: documentText(field(member, 'body')) })
      }
      if (page.nextOffset === null) break
      offset = page.nextOffset
    }
  }
  for (const document of [
    input.promptEnvelope.collaboration?.taskDocument,
    input.promptEnvelope.collaboration?.planReference?.document,
    input.promptEnvelope.collaboration?.reviewScopeRef,
    input.promptEnvelope.collaborationAuthorization?.sourceManifestRef,
  ].filter((value) => value !== undefined))
    documentText(document)
  for (const source of ['inputs', 'handoff_sources'] as const) {
    let offset = 0
    for (;;) {
      const page = read({ ...grant, source, offset }),
        value: unknown = JSON.parse(page.text)
      for (const entry of items(value, 'items')) {
        if (source === 'inputs') {
          const body = field(entry, 'body')
          if (body !== undefined) result.inputBodies.push(documentText(body))
          readBatch(field(entry, 'batch'))
        } else {
          for (const document of items(entry, 'documents')) documentText(field(document, 'source'))
          const batch = field(entry, 'inputBatchRef')
          if (batch !== undefined) readBatch(batch)
        }
      }
      if (page.nextOffset === null) break
      offset = page.nextOffset
    }
  }
  for (const document of forbidden) {
    let rejected = false
    try {
      read({ ...grant, source: 'document', document, offset: 0 })
    } catch {
      rejected = true
    }
    if (!rejected) throw Error('An unselected sibling document escaped its frozen source scope')
    result.rejectedDocumentIds.push(document.id)
  }
  return result
}

/** Controlled only at the native process seam; workflow state, grants and admission stay real. */
export function workflowAdapter(agentId: RuntimeAgentId, state: WorkflowNativeState) {
  return class {
    readonly id = agentId
    readonly executorId = randomUUID()
    async *run(input: AgentRunInput): AsyncGenerator<NormalizedAgentEvent> {
      state.inputs.push(input)
      const nativeSessionId = input.nativeSessionId ?? `${input.sessionId}-${agentId}`,
        phase = input.promptEnvelope.collaboration
      input.recordExecutor?.(this.executorId)
      input.recordDispatch?.('possibly_sent', nativeSessionId, this.executorId)
      yield { type: 'session.started', agentId, nativeSessionId }
      input.recordDispatch?.('accepted', nativeSessionId, this.executorId)
      yield { type: 'turn.started', agentId, turnId: input.runId }
      if (state.loseObservation)
        throw new AgentExecutionError(
          'transient_transport',
          'The native observer disconnected after accepted delivery.',
          true,
        )
      if (phase) state.sourceReads.push(readWorkflowSources(input, state.forbiddenDocuments))
      const interrupted =
        state.interruptNextWrite && (phase?.stage === 'implement' || phase?.stage === 'repair')
      if (interrupted) state.interruptNextWrite = false
      if (!interrupted && phase) {
        if (phase.stage === 'plan') {
          if (state.unselectedPlan)
            input.recordWorkflowPlan?.({
              nativeId: `unselected-${input.runId}`,
              text: state.unselectedPlan,
            })
          input.recordWorkflowPlan?.({
            nativeId: `plan-${input.runId}`,
            text: 'Complete accepted plan: preserve the original cancellation scope.',
          })
        } else if (
          phase.stage === 'reply' &&
          collaborationPlanMode(phase, input.promptEnvelope.collaborationAuthorization)
        ) {
          const document = phase.planReference?.document
          if (!document) throw Error('Missing retained original plan')
          input.recordWorkflowPlanRetained?.({
            nativeId: `retained-${input.runId}`,
            sha256: document.sha256,
            bytes: document.bytes,
            chars: document.chars,
          })
        } else if (phase.stage === 'reply')
          input.recordWorkflowInputResult?.({ outcome: 'processed' })
        else if (phase.stage === 'plan_review' || phase.stage === 'code_review')
          input.recordWorkflowReview?.(state.reviews.shift() ?? { verdict: 'accepted' })
      }
      yield {
        type: 'text.completed',
        agentId,
        turnId: input.runId,
        outputId: input.runId,
        text: `${phase?.stage ?? 'ordinary'} complete within the original scope.`,
      }
      yield {
        type: 'turn.completed',
        agentId,
        turnId: input.runId,
        outcome: interrupted ? 'interrupted' : 'completed',
      }
      input.reportNativeEffects?.({
        runId: input.runId,
        generation: input.nativeGeneration!,
        state: 'settled',
      })
    }
    async rebuildNativeContext(
      input: import('@pact/agent-runtime').AgentNativeContextRebuildInput,
      source: AsyncIterable<import('@pact/contracts').NativeContextRebuildChunk>,
    ) {
      for await (const chunk of source) void chunk
      state.rebuilds.push(input.rebuildId)
      await input.onNativeCreationDispatched?.(this.executorId)
      const nativeSessionId = `${agentId}:rebuilt:${input.sessionId}`
      await input.onNativeSessionCreated?.(nativeSessionId)
      input.reportNativeWork?.({ executorId: this.executorId, nativeSessionId, state: 'settled' })
      return {
        nativeSessionId,
        initializationWitness: {
          kind: 'codex_rollout_v1' as const,
          nativeSessionId,
          verifiedPrefixBytes: 1,
          verifiedPrefixSha256: 'a'.repeat(64),
          recordCount: 1,
        },
      }
    }
    async dispose() {}
  }
}

export function workflowDecisionRuntime(state: WorkflowNativeState) {
  return class {
    invoked = false
    usage = { inputTokens: 31, outputTokens: 7 }
    private work: Promise<DecisionOutcome> | undefined
    private readonly memory = new DecisionMemoryLease()
    constructor(readonly context: ConstructorParameters<typeof CodexDecisionRuntime>[0]) {}
    evaluateDecision(load: DecisionInputLoader, signal: AbortSignal) {
      this.work = (async (): Promise<DecisionOutcome> => {
        const deadlineAt = this.context.deadlineAt ?? Date.now() + 15_000,
          input = await load({ signal, deadlineAt })
        const reserved = this.context.reserve!(input, { deadlineAt })
        if (reserved !== 'reserved') return { kind: 'unavailable', reason: reserved }
        signal.throwIfAborted()
        this.context.dispatch()
        this.invoked = true
        state.decisions.push(input)
        const requested = state.candidate,
          candidateId =
            requested === null
              ? null
              : (input.candidates.find((candidate) => candidate.id === requested)?.id ??
                input.candidates[0]?.id ??
                null)
        return {
          kind: 'recommendation',
          recommendation: {
            candidateId,
            ...(candidateId === 'clarify_prepared_input' && state.information
              ? { information: state.information }
              : {}),
            highlights:
              candidateId && candidateId !== 'clarify_prepared_input'
                ? [
                    {
                      text: 'Clarify the complete current scope once before fixed review.',
                      sourceIds: [input.sources.at(-1)!.id],
                    },
                  ]
                : [],
          },
        }
      })()
      return this.work
    }
    async settlement() {
      await this.work
      this.memory.release()
      return true
    }
    async dispose() {
      return this.settlement()
    }
  }
}

export async function workflowConversation(
  Owner: typeof Conversation,
  primaryAgentId: RuntimeAgentId = 'codex',
) {
  const directory = await mkdtemp(join(tmpdir(), 'pact-relay-workflow-'))
  const db = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
  })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Relay workflow',
    directoryPath: directory,
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Relay workflow', createdAt },
    {
      primaryAgentId,
      agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  const preparation = new RuntimePreparation(db.runtimePreparationRepository)
  vi.spyOn(preparation, 'findRecoveryExecutable').mockResolvedValue(process.execPath)
  vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
    ok: true,
    value: {
      firstUse: false,
      agents: [
        {
          agentId: 'codex',
          executablePath: process.execPath,
          state: 'ready',
          checkedAt: createdAt,
        },
        {
          agentId: 'claude',
          executablePath: process.execPath,
          state: 'ready',
          checkedAt: createdAt,
        },
      ],
    },
  })
  const flow = new Owner(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
  )
  const input = (content: string) => {
    const drafts = db.conversationRepository.readPage({ scope: 'drafts', sessionId })
    if (drafts.scope !== 'drafts') throw Error('Missing draft revision')
    return {
      sessionId,
      clientMessageId: randomUUID(),
      content,
      commentIds: [],
      expectedCommentsRevision: drafts.commentsRevision,
    }
  }
  const act = (action: CollaborationAction, clientMessageId = randomUUID()) => {
    const task = db.conversationRepository.collaboration(sessionId)!
    return flow.actOnCollaboration({
      sessionId,
      taskId: task.id,
      revision: task.revision,
      clientMessageId,
      action,
    })
  }
  const settled = async () => {
    await vi.waitFor(() => expect(flow.diagnostics().activeExecutions).toBe(0))
    await vi.waitFor(() =>
      expect(db.conversationRepository.collaboration(sessionId)?.status).not.toBe('running'),
    )
    return db.conversationRepository.collaboration(sessionId)!
  }
  return {
    db,
    flow,
    sessionId,
    input,
    act,
    settled,
    dispose: async () => {
      await flow.dispose()
      db.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export function enableWorkflowRelay(db: PactDatabase) {
  const repo = db.conversationRepository
  repo.saveSchedulingSettings({
    expectedRevision: repo.schedulingSettings().revision,
    enabled: true,
    selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
  })
}

/** Reuses genuine Run publication and review producers within one shared authoritative database. */
export async function proposeWorkflowPlanOn(db: PactDatabase, index: number) {
  const f = sharedPlanFixture(db, index)
  const response = f.repo.beginRun(f.admission()).run
  f.finish(response.id, { plan: 'Complete current scope.' })
  const review = f.repo.beginRun(f.admission()).run
  f.finish(review.id, { verdict: 'changes_requested' })
  const revised = f.repo.beginRun(f.admission()).run
  f.finish(revised.id, { plan: 'Complete response preserving the exact current scope.' })
  const handoff = f.admission().schedulingHandoff,
    deadlineAt = Date.now() + 15_000
  const material = await f.repo.readRelayWorkflowDecisionSources(
    handoff,
    [{ id: 'propose_supplement_plan', description: 'Request one exact read-only clarification.' }],
    { signal: new AbortController().signal, deadlineAt },
  )
  const reserved = f.repo.reserveEvaluation({
    handoff,
    provider: 'codex',
    model: 'gpt-6-luna',
    configurationFingerprint: 'a'.repeat(64),
    deadlineAt,
    inputSha256: material.inputSha256,
  })
  if (reserved.status !== 'reserved') throw Error('Expected the current real reservation')
  f.repo.dispatchEvaluation(reserved.evaluation.id)
  f.repo.settleEvaluation(reserved.evaluation.id, {
    outcome: 'completed',
    physicalReleased: true,
    selectedCandidateId: 'propose_supplement_plan',
  })
  const card = f.repo.proposeRelayWorkflowAction({
    handoff,
    kind: 'supplement_plan',
    evaluationId: reserved.evaluation.id,
    configurationGeneration: f.repo.schedulingConfigurationGeneration(),
    inputSha256: material.inputSha256,
    sourceFingerprint: material.sourceFingerprint,
    deadlineAt,
    reason: 'One specific read-only clarification before the fixed reviewer.',
    sourceIds: material.sources.map((source) => source.id),
  })
  return { sessionId: f.sessionId, card }
}

function sharedPlanFixture(db: PactDatabase, index: number) {
  const repo = db.conversationRepository,
    sessionId = randomUUID(),
    projectId = randomUUID(),
    messageId = randomUUID(),
    createdAt = new Date().toISOString()
  const settings = {
    primaryAgentId: 'codex',
    agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
    maxDiscussionRounds: 6,
    maxReviewCycles: 3,
    maxRepairAttempts: 3,
  } as const
  db.projectCatalogRepository.add({
    id: projectId,
    name: `Relay waiting ${index}`,
    directoryPath: `/fixture/relay-waiting-${index}`,
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: `Relay waiting ${index}`, createdAt },
    settings,
  )
  const initial = collaborationTaskSchema.parse({
    id: randomUUID(),
    sessionId,
    kind: 'plan',
    revision: 0,
    protocol: 'native-workflow-v1',
    owner: 'codex',
    reviewer: 'claude',
    automation: 'active',
    inputSequence: 0,
    handledInputSequence: 0,
    task: 'Review only the original bounded cancellation scope.',
    taskMessageId: messageId,
    stage: 'plan',
    actor: 'codex',
    status: 'running',
    runId: messageId,
    planVersion: 0,
    discussionRounds: 0,
    reviewCycles: 0,
    repairAttempts: 0,
  })
  const first = repo.beginRun({
    sessionId,
    clientMessageId: messageId,
    content: '/plan Review only the original bounded cancellation scope.',
    commentIds: [],
    expectedCommentsRevision: 0,
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
    collaboration: initial,
  }).run
  const finish = (runId: string, result: { plan?: string; verdict?: 'changes_requested' } = {}) => {
    const run = repo.findRun(runId)!,
      nativeSessionId = `fixture-${sessionId}-${run.agentId}`,
      turnId = `turn-${runId}`
    repo.applyEvent(sessionId, runId, {
      type: 'session.started',
      agentId: run.agentId,
      nativeSessionId,
    })
    repo.applyEvent(sessionId, runId, { type: 'turn.started', agentId: run.agentId, turnId })
    if (result.plan)
      repo.recordWorkflowPlan(runId, { nativeId: `plan-${runId}`, text: result.plan })
    if (result.verdict) repo.recordWorkflowReview(runId, { verdict: result.verdict })
    repo.applyEvent(sessionId, runId, {
      type: 'text.completed',
      agentId: run.agentId,
      turnId,
      outputId: `answer-${runId}`,
      text: 'Complete original review and response.',
    })
    repo.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: 'completed',
      identity: {
        sessionId,
        agentId: run.agentId,
        requestId: runId,
        runId,
        nativeSessionId,
        nativeTurnId: turnId,
        bindingGeneration: run.bindingGeneration ?? 1,
      },
    })
    repo.recordNativeEffects(runId, 'settled')
    repo.applyEvent(sessionId, runId, {
      type: 'turn.completed',
      agentId: run.agentId,
      turnId,
      outcome: 'completed',
    })
    repo.recordNativeEffects(runId, 'settled')
  }
  const admission = () => {
    const task = repo.collaboration(sessionId)!,
      next = advanceCollaboration(task, 'continue', settings)
    return {
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Continue within the original scope.',
      commentIds: [],
      expectedCommentsRevision: 0,
      agentId: next.actor,
      settingsRevision: 1,
      model: null,
      effort: null,
      preserveDraftComments: true,
      expectedCollaborationRevision: task.revision,
      collaboration: next,
      schedulingHandoff: repo.workflowHandoff(task, next.actor),
    }
  }
  finish(first.id, { plan: 'Original complete cancellation plan.' })
  const review = repo.beginRun(admission()).run
  finish(review.id, { verdict: 'changes_requested' })
  enableWorkflowRelay(db)
  return { repo, sessionId, finish, admission }
}
