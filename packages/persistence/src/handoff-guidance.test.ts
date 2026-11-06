import { eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import {
  advanceCollaboration,
  collaborationDocumentSchema,
  handoffGuidanceV2Schema,
} from '@pact/contracts'

import {
  planRevisionFixture,
  seedHistoricalGuidance,
} from './plan-revision-guidance.test-support.js'
import { agentRuns, schedulingEvaluations } from './schema/index.js'

const fixtures: Awaited<ReturnType<typeof planRevisionFixture>>[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.db.close()
})

async function secondReview(unselectedPlan?: string) {
  const f = await planRevisionFixture({
    review: 'Original finding, including its final page.\n'.repeat(700),
  })
  fixtures.push(f)
  expect(f.repo.relayWorkflowAlternatives(f.handoff)).toBeUndefined()
  const response = f.repo.beginRun(f.admission()).run
  let unselectedDocument
  if (unselectedPlan !== undefined) {
    // A real earlier publication from this same author Run remains immutable after replacement.
    f.repo.recordWorkflowPlan(response.id, { nativeId: 'superseded-plan', text: unselectedPlan })
    const observed = f.db.drizzle.get<{
      source: string
    }>(sql`SELECT json_extract(payload, '$.source') AS source
      FROM agent_event_journal WHERE run_id=${response.id} AND event_type='workflow.plan_observed'
      ORDER BY sequence DESC LIMIT 1`)
    if (!observed) throw Error('The public plan publication did not retain its source receipt.')
    unselectedDocument = collaborationDocumentSchema.parse(JSON.parse(observed.source))
  }
  f.finish(response.id, {
    plan: 'Revised complete plan.',
    answer: 'Complete author response to the first review.\n'.repeat(300),
  })
  const nextReview = f.repo.beginRun(f.admission()).run
  f.finish(nextReview.id, {
    verdict: 'changes_requested',
    answer: 'The second review still requires a correction.',
  })
  const admission = f.admission(),
    handoff = admission.schedulingHandoff
  const material = await f.repo.readRelayWorkflowDecisionSources(
    handoff,
    [{ id: 'continue_plan_revision', description: 'Continue the original owner revision.' }],
    {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 15_000,
    },
  )
  return { ...f, response, nextReview, admission, handoff, material, unselectedDocument }
}

async function evaluated(unselectedPlan?: string) {
  const f = await secondReview(unselectedPlan)
  const guidance = handoffGuidanceV2Schema.parse({
    version: 'handoff-guidance-v2',
    evaluationId: randomUUID(),
    handoffId: f.handoff.id,
    inputSha256: f.material.inputSha256,
    sourceFingerprint: f.material.sourceFingerprint,
    basis: f.material.basis,
    sources: f.material.sources,
    candidateId: 'continue_plan_revision',
    highlights: [
      {
        text: 'Address the original finding and the complete intervening response.',
        sourceIds: [
          f.material.snapshot.reviews[0]!.sourceId,
          f.material.snapshot.responses[0]!.sourceId,
        ],
      },
    ],
  })
  return { ...f, guidance }
}

describe('current workflow sources and historical handoff guidance', () => {
  it('keeps the normal first revision and reads the complete earlier review, owner response and exact Plan versions for the second', async () => {
    const f = await secondReview()
    expect(f.material.snapshot.node).toBe('plan_review_to_owner')
    expect(
      f.material.input.sources.some((source) =>
        source.text.endsWith('Original finding, including its final page.\n'),
      ),
    ).toBe(true)
    expect(
      f.material.input.sources.some(
        (source) => source.text === 'Complete author response to the first review.\n'.repeat(300),
      ),
    ).toBe(true)
    expect(
      f.material.sources
        .filter((source) => source.roles.includes('plan'))
        .map((source) => source.document.sha256),
    ).toEqual(
      expect.arrayContaining([
        f.originalPlan.document.sha256,
        f.repo.collaboration(f.sessionId)!.planReference!.document.sha256,
      ]),
    )
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
    const plan = f.db.drizzle.all<{
      detail: string
    }>(sql`EXPLAIN QUERY PLAN SELECT * FROM workflow_turns
      WHERE task_id=${f.task.id} AND stage='plan_review' AND task_revision<100 ORDER BY task_revision DESC LIMIT 1`)
    expect(plan.some((row) => row.detail.includes('workflow_turns_task_stage_revision_idx'))).toBe(
      true,
    )
    expect(plan.some((row) => row.detail.includes('TEMP B-TREE'))).toBe(false)
  })

  it('reads a historical v2 manifest without granting an unselected sibling document', async () => {
    const text = 'Same task, but not a selected review source.'
    const f = await evaluated(text)
    const unrelated = collaborationDocumentSchema.parse(f.unselectedDocument)
    expect(f.readDocument(unrelated)).toBe(text)
    expect(f.repo.collaborationDocumentRow(f.sessionId, unrelated)).toMatchObject({
      sourceRunId: f.response.id,
      sealed: true,
    })
    expect(f.repo.findRun(f.response.id)?.collaboration?.taskId).toBe(f.task.id)
    expect(f.material.sources.some((source) => source.document.id === unrelated.id)).toBe(false)
    const adopted = f.repo.beginRun(f.admission)
    const manifest = seedHistoricalGuidance(
      f,
      adopted.run.id,
      f.handoff,
      f.guidance,
      f.material.snapshot.sourceGrants,
    )
    const auth = f.repo.collaborationTurnAuthorization(adopted.run.id)!
    expect(auth.sourceManifestRef).toEqual(manifest)
    const stored = handoffGuidanceV2Schema.parse(
      JSON.parse(f.readDocument(auth.sourceManifestRef!)),
    )
    expect(stored).toEqual(f.guidance)
    for (const source of stored.sources)
      expect(f.repo.sourceDocumentAuthorized(adopted.run.id, source.document)).toBe(true)
    expect(f.repo.sourceDocumentAuthorized(adopted.run.id, unrelated)).toBe(false)
    expect(f.repo.handoffReceipt(f.handoff.id)?.runId).toBe(adopted.run.id)
    expect(
      f.db.drizzle.all(
        sql`SELECT event_type FROM agent_event_journal WHERE run_id=${adopted.run.id} AND event_type='scheduling.handoff_guidance_adopted'`,
      ),
    ).toHaveLength(0)
  })

  it('refuses an ungranted source in a stored historical manifest', async () => {
    const text = 'Unselected document.'
    const f = await evaluated(text)
    const unrelated = collaborationDocumentSchema.parse(f.unselectedDocument)
    expect(f.readDocument(unrelated)).toBe(text)
    expect(f.repo.collaborationDocumentRow(f.sessionId, unrelated)).toMatchObject({
      sourceRunId: f.response.id,
      sealed: true,
    })
    expect(f.repo.findRun(f.response.id)?.collaboration?.taskId).toBe(f.task.id)
    expect(f.material.sources.some((source) => source.document.id === unrelated.id)).toBe(false)
    f.guidance.sources.push({
      id: 's11',
      roles: ['owner_response'],
      document: unrelated,
      evaluatedSha256: unrelated.sha256,
    })
    const adopted = f.repo.beginRun(f.admission)
    const manifest = seedHistoricalGuidance(
      f,
      adopted.run.id,
      f.handoff,
      f.guidance,
      f.material.snapshot.sourceGrants,
    )
    const auth = f.repo.collaborationTurnAuthorization(adopted.run.id)!
    expect(auth.sourceManifestRef).toEqual(manifest)
    expect(f.repo.sourceDocumentAuthorized(adopted.run.id, unrelated)).toBe(false)
    for (const grant of f.material.snapshot.sourceGrants)
      expect(f.repo.sourceDocumentAuthorized(adopted.run.id, grant.document)).toBe(true)
    expect(adopted.run.agentId).toBe(f.task.owner)
  })

  it('remaps v2 historical sources during Fork without replaying evaluation or changing evaluated digests', async () => {
    const f = await evaluated()
    const adopted = f.repo.beginRun(f.admission).run
    seedHistoricalGuidance(f, adopted.id, f.handoff, f.guidance, f.material.snapshot.sourceGrants)
    f.finish(adopted.id, { plan: 'Final revised Plan.' })
    const sourceSession = f.db.sessionRepository.find(f.sessionId)!
    const selection = f.repo.selectForkSource(
      f.sessionId,
      f.repo.findRun(adopted.id)!.responseMessageId!,
      sourceSession.settings,
      sourceSession.settingsRevision,
    )
    const boundary = (
      agentId: 'claude' | 'codex',
    ): import('@pact/contracts').AgentNativeForkBoundary => {
      const run = selection.runs[agentId],
        response = f.repo.forkResponse(run.id, selection.prepared.sequence)
      return {
        nativeSessionId: run.nativeSessionId!,
        nativeCutId: run.id,
        nativeTurnId: run.nativeTurnId!,
        bindingGeneration: run.bindingGeneration,
        throughSequence: response.sequence,
        deliveryCursor: response.deliveryCursor,
        prefixHash: 'b'.repeat(64),
        prefixRecords: 2,
        prefixBytes: 100,
      }
    }
    const fork = f.repo.commitFork(
      randomUUID(),
      selection,
      { claude: boundary('claude'), codex: boundary('codex') },
      [],
    )
    const inherited = f.db.drizzle
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.sessionId, fork.sessionId))
      .all()
      .find((run) => run.forkSourceRunId === adopted.id)!
    const auth = f.repo.collaborationTurnAuthorization(inherited.id)!
    const manifest = handoffGuidanceV2Schema.parse(
      JSON.parse(f.readDocument(auth.sourceManifestRef!, fork.sessionId)),
    )
    expect(manifest.basis.task.id).not.toBe(f.guidance.basis.task.id)
    expect(manifest.basis.producerRunId).not.toBe(f.guidance.basis.producerRunId)
    expect(manifest.inputSha256).toBe(f.guidance.inputSha256)
    expect(manifest.sources.map((source) => source.evaluatedSha256)).toEqual(
      f.guidance.sources.map((source) => source.evaluatedSha256),
    )
    expect(
      manifest.sources.every((source) =>
        f.repo.sourceDocumentAuthorized(inherited.id, source.document),
      ),
    ).toBe(true)
    expect(f.repo.collaboration(fork.sessionId)).toBeUndefined()
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(1)
  })
  it('remaps the Run and request identities inside a retained code-review scope after Fork', async () => {
    const f = await planRevisionFixture()
    fixtures.push(f)
    const settings = f.db.sessionRepository.find(f.sessionId)!.settings
    const admission = (action: import('@pact/contracts').CollaborationAction) => {
      const task = f.repo.collaboration(f.sessionId)!,
        clientMessageId = randomUUID(),
        prepared = ['execute', 'repair', 'respond'].includes(action)
          ? f.repo.prepareCollaborationAction(
              {
                sessionId: f.sessionId,
                taskId: task.id,
                revision: task.revision,
                clientMessageId,
                action,
              },
              settings,
            )
          : undefined,
        next = prepared?.next ?? advanceCollaboration(task, action, settings)
      const drafts = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
      if (drafts.scope !== 'drafts') throw Error('Missing drafts')
      return {
        sessionId: f.sessionId,
        clientMessageId,
        content: 'Continue the authorized workflow.',
        agentId: next.actor,
        settingsRevision: 1,
        model: null,
        effort: null,
        commentIds: [],
        expectedCommentsRevision: drafts.commentsRevision,
        preserveDraftComments: true,
        collaboration: next,
        expectedCollaborationRevision: task.revision,
        schedulingHandoff: prepared?.handoff ?? f.repo.workflowHandoff(task, next.actor),
        ...(prepared ? { collaborationActionReceiptId: prepared.receipt.id } : {}),
      }
    }
    let run = f.repo.beginRun(admission('continue')).run
    f.finish(run.id, { plan: 'Accepted implementation scope.' })
    run = f.repo.beginRun(admission('continue')).run
    f.finish(run.id, { verdict: 'accepted' })
    const implementation = f.repo.beginRun(admission('execute')).run
    f.finish(implementation.id, { answer: 'Implementation completed.' })
    run = f.repo.beginRun(admission('continue')).run
    f.finish(run.id, { verdict: 'changes_requested' })
    run = f.repo.beginRun(admission('respond')).run
    f.finish(run.id, { answer: 'Complete response to the first code review.' })
    run = f.repo.beginRun(admission('continue')).run
    f.finish(run.id, { verdict: 'changes_requested' })
    run = f.repo.beginRun(admission('repair')).run
    f.finish(run.id, { answer: 'Repair completed within the original scope.' })
    const input = admission('continue'),
      handoff = input.schedulingHandoff,
      deadlineAt = Date.now() + 15_000
    const material = await f.repo.readRelayWorkflowDecisionSources(
      handoff,
      [{ id: 'continue_code_review', description: 'Fixed independent review.' }],
      {
        signal: new AbortController().signal,
        deadlineAt,
      },
    )
    expect(material.snapshot.node).toBe('execution_to_review')
    const guidance = handoffGuidanceV2Schema.parse({
      version: 'handoff-guidance-v2',
      evaluationId: randomUUID(),
      handoffId: handoff.id,
      inputSha256: material.inputSha256,
      sourceFingerprint: material.sourceFingerprint,
      basis: material.basis,
      sources: material.sources,
      candidateId: 'continue_code_review',
      highlights: [
        { text: 'Verify the same repair scope.', sourceIds: [material.snapshot.scopeSourceId] },
      ],
    })
    const adopted = f.repo.beginRun(input).run
    seedHistoricalGuidance(f, adopted.id, handoff, guidance, material.snapshot.sourceGrants)
    f.finish(adopted.id, { verdict: 'accepted' })
    const session = f.db.sessionRepository.find(f.sessionId)!
    const selection = f.repo.selectForkSource(
      f.sessionId,
      f.repo.findRun(adopted.id)!.responseMessageId!,
      session.settings,
      session.settingsRevision,
    )
    const boundary = (
      agentId: 'claude' | 'codex',
    ): import('@pact/contracts').AgentNativeForkBoundary => {
      const nativeRun = selection.runs[agentId],
        response = f.repo.forkResponse(nativeRun.id, selection.prepared.sequence)
      return {
        nativeSessionId: nativeRun.nativeSessionId!,
        nativeCutId: nativeRun.id,
        nativeTurnId: nativeRun.nativeTurnId!,
        bindingGeneration: nativeRun.bindingGeneration,
        throughSequence: response.sequence,
        deliveryCursor: response.deliveryCursor,
        prefixHash: 'c'.repeat(64),
        prefixRecords: 2,
        prefixBytes: 100,
      }
    }
    const fork = f.repo.commitFork(
      randomUUID(),
      selection,
      { claude: boundary('claude'), codex: boundary('codex') },
      [],
    )
    const inherited = f.db.drizzle
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.sessionId, fork.sessionId))
      .all()
    const child = inherited.find((entry) => entry.forkSourceRunId === adopted.id)!
    const auth = f.repo.collaborationTurnAuthorization(child.id)!
    const manifest = handoffGuidanceV2Schema.parse(
      JSON.parse(f.readDocument(auth.sourceManifestRef!, fork.sessionId)),
    )
    const scope = manifest.sources.find((entry) => entry.roles.includes('review_scope'))!
    const text = f.readDocument(scope.document, fork.sessionId),
      body: unknown = JSON.parse(text)
    expect(body).toMatchObject({
      implementationRunId: inherited.find((entry) => entry.forkSourceRunId === implementation.id)!
        .id,
      requestMessageId: f.repo.collaboration(fork.sessionId, child.id)!.taskMessageId,
    })
    expect(createHash('sha256').update(text).digest('hex')).toBe(scope.document.sha256)
    expect(scope.evaluatedSha256).toBe(
      material.sources.find((entry) => entry.id === scope.id)!.evaluatedSha256,
    )
  })
})
