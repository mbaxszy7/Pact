import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type { ConversationSendInput } from '../../packages/contracts/src/index.js'

import { evaluateRelayPolicy } from '../../apps/desktop/src/utility/conversation/relay-policy.js'
import { decisionJsonBytes } from '../../packages/contracts/src/index.js'
import { PactDatabase } from '../../packages/persistence/src/pact-database.js'
import { nativeAgentContexts } from '../../packages/persistence/src/schema/index.js'

export const routingScenario = Object.freeze({
  version: 2,
  primary: 'claude' as const,
  sourceActor: 'codex' as const,
  correctRecipient: 'codex' as const,
  report:
    'Codex report: I assumed cancellation is signalled once by its owning operation, and resources are released only after that operation joins. I did not assume that cancellation immediately ends native work.',
  comment:
    'Ask the original report author to explain the assumptions in this complete report, rather than asking another author to reinterpret it.',
  question:
    'Please have the original author of the attached Codex report explain the original assumptions in their own report. This request is to that original author, not to a different author interpreting the report. First use only the Pact read_collaboration_source tool with the current sourceGrant to read the current inputBatchRef from offset 0 through every nextOffset until null, then read each attached Comment body document from offset 0 through every nextOffset until null. The complete original report is also quoted below. Reply briefly in text only. Do not delegate, use any other tool, inspect or write files, change permissions, publish metadata, or start a workflow.',
  correction:
    'I am making a new explicit request to Codex, the original report author, to correct the recipient of my completed earlier request. First use only the Pact read_collaboration_source tool with the current sourceGrant to read the current inputBatchRef from offset 0 through every nextOffset until null, then read each attached Comment body document from offset 0 through every nextOffset until null. The complete original report is also quoted below. Explain your own original assumptions briefly in text only. Do not delegate, use any other tool, inspect or write files, change permissions, publish metadata, or start a workflow.',
  onExpectedBusinessTurns: 1,
  offExpectedBusinessTurns: 2,
  onExpectedManualCorrections: 0,
  offExpectedManualCorrections: 1,
})
export const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export const implicitQuestion = `${routingScenario.question}\n\nComplete original report:\n${routingScenario.report}`
export const correctionQuestion = `${routingScenario.correction}\n\nComplete original report:\n${routingScenario.report}`
export const preregisteredRoutingMetrics = Object.freeze({
  version: routingScenario.version,
  primary: routingScenario.primary,
  hostVerifiedSourceActor: routingScenario.sourceActor,
  correctRecipient: routingScenario.correctRecipient,
  reportSha256: hash(routingScenario.report),
  commentSha256: hash(routingScenario.comment),
  implicitQuestionSha256: hash(implicitQuestion),
  correctionQuestionSha256: hash(correctionQuestion),
  expectedOn: {
    decisionCalls: 1,
    selection: 'route_codex',
    realBusinessTurns: 1,
    manualRouteCorrections: 0,
  },
  acceptedNullAdvice: {
    decisionCalls: 1,
    selection: null,
    firstRecipient: 'claude',
    finalRecipientAfterNewExplicitUserCorrection: 'codex',
    realBusinessTurns: 2,
    manualRouteCorrections: 1,
    adoptedRoutingEvents: 0,
    savedBusinessTurns: 0,
    savedManualCorrections: 0,
    benefitStatus: 'Unverified',
  },
  expectedOff: {
    decisionCalls: 0,
    defaultRecipient: 'claude',
    realBusinessTurns: 2,
    manualRouteCorrections: 1,
  },
  score: 'Actual host-verified recipient identity, never subjective answer quality.',
  retries: 0,
  acceptanceAmendment:
    'A completed valid null recommendation retains the legal default, followed only by a new explicit user correction to the source author. Record zero savings and Unverified benefit; never count this branch as a routing improvement. A positive recommendation still must select the source author and save exactly one correction/Turn. All current source, native completion, permission, settings, physical-release and immutable baseline obligations remain.',
  sourceAccess:
    'Only the current Run Pact frozen-source reader; complete Batch and Comment body pages are required.',
  accessAmendment:
    'Version 1 prohibited all tools but native prompts intentionally supply lazy frozen Comment references. Version 2 corrects access before either On decision attempt; recipient and benefit expectations are unchanged.',
})

export const routingMigrations = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
export interface RoutingSeed {
  sessionId: string
  projectId: string
  projectDirectory: string
  sourceRunId: string
  sourceMessageId: string
  commentId: string
  sourceActor: 'codex'
  reportSha256: string
  commentSha256: string
}

/** A complete stored report is fixture prerequisite data, not real native/model evidence. */
export function seedRoutingScenario(
  db: PactDatabase,
  projectDirectory: string,
  claudeModel: string,
  label: string,
): RoutingSeed {
  const repo = db.conversationRepository,
    projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: `Routing ${label}`,
    directoryPath: projectDirectory,
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: `Routing ${label}`, createdAt },
    {
      primaryAgentId: 'claude',
      agents: {
        codex: { model: 'gpt-6-luna', effort: 'low' },
        claude: { model: claudeModel, effort: null },
      },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  db.sessionRepository.savePermission({
    sessionId,
    agentId: 'codex',
    mode: 'ask',
    expectedRevision: db.sessionRepository.find(sessionId)!.settingsRevision,
    confirmedFullAccess: false,
  })
  const original = repo.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'Provide the short report that will be quoted in the later explanation request.',
    commentIds: [],
    expectedCommentsRevision: 0,
    agentId: 'codex',
    settingsRevision: db.sessionRepository.find(sessionId)!.settingsRevision,
    model: null,
    effort: null,
  }).run
  const nativeSessionId = `fixture-${original.id}`,
    turnId = `fixture-turn-${original.id}`
  repo.applyEvent(sessionId, original.id, {
    type: 'session.started',
    agentId: 'codex',
    nativeSessionId,
  })
  repo.applyEvent(sessionId, original.id, { type: 'turn.started', agentId: 'codex', turnId })
  repo.applyEvent(sessionId, original.id, {
    type: 'text.completed',
    agentId: 'codex',
    turnId,
    outputId: 'fixture-report',
    text: routingScenario.report,
  })
  repo.recordNativeEvidence({
    kind: 'ended',
    source: 'stored_terminal',
    outcome: 'completed',
    identity: {
      sessionId,
      agentId: 'codex',
      requestId: original.id,
      runId: original.id,
      nativeSessionId,
      nativeTurnId: turnId,
      bindingGeneration: original.bindingGeneration ?? 1,
    },
  })
  repo.recordNativeEffects(original.id, 'settled')
  repo.applyEvent(sessionId, original.id, {
    type: 'turn.completed',
    agentId: 'codex',
    turnId,
    outcome: 'completed',
  })
  repo.recordNativeEffects(original.id, 'settled')
  const source = repo.findRun(original.id)!,
    commentId = randomUUID(),
    quote = 'I assumed cancellation'
  const draftPage = repo.readPage({ scope: 'drafts', sessionId })
  if (draftPage.scope !== 'drafts') throw Error('Missing source draft revision')
  repo.saveCommentDraft({
    mode: 'create',
    sessionId,
    commentId,
    expectedCommentsRevision: draftPage.commentsRevision,
    body: routingScenario.comment,
    anchor: {
      type: 'message',
      messageId: source.responseMessageId!,
      contentHash: hash(routingScenario.report),
      textBasis: 'markdown-visible-v2',
      startOffset: routingScenario.report.indexOf(quote),
      endOffset: routingScenario.report.indexOf(quote) + quote.length,
      quote,
    },
  })
  return {
    sessionId,
    projectId,
    projectDirectory,
    sourceRunId: source.id,
    sourceMessageId: source.responseMessageId!,
    commentId,
    sourceActor: 'codex',
    reportSha256: hash(routingScenario.report),
    commentSha256: hash(routingScenario.comment),
  }
}

export function initialRoutingInput(db: PactDatabase, seed: RoutingSeed): ConversationSendInput {
  const drafts = db.conversationRepository.readPage({ scope: 'drafts', sessionId: seed.sessionId })
  if (drafts.scope !== 'drafts') throw Error('Missing routing draft revision')
  return {
    sessionId: seed.sessionId,
    clientMessageId: randomUUID(),
    content: implicitQuestion,
    commentIds: [seed.commentId],
    expectedCommentsRevision: drafts.commentsRevision,
    route: { type: 'primary' },
    routeIntent: 'implicit',
    composerRevision: 1,
  }
}

/** Native compatibility is not asserted here; this only checks actual frozen source/policy facts. */
export async function verifyRoutingPreconditions() {
  const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder: routingMigrations })
  try {
    const seeded = seedRoutingScenario(
        db,
        '/fixture/routing-preflight',
        'claude-haiku-5-5',
        'Preflight',
      ),
      repo = db.conversationRepository
    db.drizzle.delete(nativeAgentContexts).run()
    repo.saveSchedulingSettings({
      expectedRevision: 0,
      enabled: true,
      selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
    })
    const input = initialRoutingInput(db, seeded)
    assert.equal(repo.ordinaryInputWorthConsulting(input, 'claude'), true)
    const prepared = repo.prepareInputDispatch(input, randomUUID(), ['codex', 'claude']),
      handoff = repo.preparedInputHandoff(prepared.batchId)
    const read = await repo.readPreparedInputDecisionSources(
      prepared,
      [
        { id: 'route_codex', description: 'Send the original request once to Codex.' },
        { id: 'route_claude', description: 'Send the original request once to Claude.' },
      ],
      { signal: new AbortController().signal, deadlineAt: Date.now() + 15_000 },
    )
    const referenced = read.sources.filter((source) => source.actor !== null)
    assert.ok(referenced.length > 0)
    assert.deepEqual([...new Set(referenced.map((source) => source.actor))], ['codex'])
    assert.ok(read.input.sources.some((source) => source.text === routingScenario.report))
    assert.ok(read.input.sources.some((source) => source.text === routingScenario.comment))
    assert.equal(prepared.metadata.defaultAgentId, 'claude')
    const policy = evaluateRelayPolicy({
      node: 'send',
      ordinary: true,
      handoffId: handoff.id,
      budgetSubjectId: handoff.budgetSubjectId,
      primary: 'claude',
      route: 'implicit',
      inputSourceId: 's0',
      referencedSourceIds: referenced.map((source) => source.id),
      materials: {
        complete: true,
        inputBytes: decisionJsonBytes(read.input),
        sources: read.sources.map((source) => ({
          id: source.id,
          sha256: source.sha256,
          bytes: source.bytes,
          roles: source.roles,
          actor: source.actor,
          complete: true,
          settled: true,
          frozen: true,
        })),
      },
      legalActions: prepared.metadata.allowedAgentIds.map((actor) => ({
        action: 'route_send',
        actor,
        authorizationId: handoff.id,
        authorizationCurrent: true,
        businessBudgetAvailable: true,
      })),
      admission: {
        enabled: true,
        modelSelected: true,
        runtimeAdmission: 'may_attempt',
        evaluationResourcesAvailable: true,
        factAlreadyEvaluated: false,
        pendingUserInput: false,
        nativeInteraction: false,
        newTaskDispatchProtected: false,
      },
    })
    assert.equal(policy.kind, 'eligible')
    if (policy.kind !== 'eligible')
      throw Error('Routing policy did not qualify the frozen scenario')
    assert.deepEqual(policy.candidates.map((candidate) => candidate.id).toSorted(), [
      'route_claude',
      'route_codex',
    ])
    repo.cancelPreparedInputDispatch(prepared, 'cancelled')
    return {
      ...preregisteredRoutingMetrics,
      zeroPaidPreflight: {
        ordinaryInputWorthConsulting: true,
        purePolicy: 'eligible',
        candidates: policy.candidates.map((candidate) => candidate.id).toSorted(),
        referencedActors: ['codex'],
        completeReportAndComment: true,
        nativeCompatibilityChecked: false,
      },
    }
  } finally {
    db.close()
  }
}
