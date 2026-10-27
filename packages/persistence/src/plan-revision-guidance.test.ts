import { eq, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  collaborationDocumentSchema,
  planRevisionGuidanceSchema,
  type PlanRevisionGuidanceProposal,
} from '@pact/contracts'

import { PactDatabase } from './pact-database.js'
import { planRevisionFixture } from './plan-revision-guidance.test-support.js'
import {
  agentEventJournal,
  agentRuns,
  conversationBodyInputs,
  conversationBodyParts,
  conversationInputBatchMembers,
  conversationInputBatches,
  conversationMessageImages,
  conversationImageAssets,
  conversationMessages,
  conversationRebuildSourceRefs,
  schedulingEvaluations,
} from './schema/index.js'

const fixtures: Awaited<ReturnType<typeof planRevisionFixture>>[] = []
const reopened: PactDatabase[] = [],
  directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  fixtures.splice(0).forEach(({ db }) => db.close())
  reopened.splice(0).forEach((db) => db.close())
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
async function fixture(options: Parameters<typeof planRevisionFixture>[0] = {}) {
  const value = await planRevisionFixture(options)
  fixtures.push(value)
  return value
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function proposal(f: Awaited<ReturnType<typeof fixture>>) {
  const deadlineAt = Date.now() + 15_000
  const material = await f.repo.readPlanRevisionDecisionSources(f.handoff, {
    signal: new AbortController().signal,
    deadlineAt,
  })
  const reserved = f.repo.reserveEvaluation({
    handoff: f.handoff,
    provider: 'codex',
    model: 'gpt-6-luna',
    configurationFingerprint: 'a'.repeat(64),
    deadlineAt,
  })
  if (reserved.status !== 'reserved') throw Error('Missing evaluation reservation')
  f.repo.dispatchEvaluation(reserved.evaluation.id)
  f.repo.settleEvaluation(reserved.evaluation.id, { outcome: 'completed', physicalReleased: true })
  const value: PlanRevisionGuidanceProposal = {
    guidance: {
      version: 'plan-revision-guidance-v1',
      evaluationId: reserved.evaluation.id,
      handoffId: f.handoff.id,
      inputSha256: material.inputSha256,
      sourceFingerprint: material.sourceFingerprint,
      taskId: material.taskId,
      inputSequence: material.inputSequence,
      planVersion: material.planVersion,
      candidateId: 'continue_plan_revision',
      sources: material.sources,
      highlights: [
        {
          text: 'Keep the cancellation boundary explicit.',
          sourceIds: [material.sources.find((source) => source.roles.includes('review'))!.id],
        },
      ],
    },
    configurationGeneration: f.repo.schedulingConfigurationGeneration(),
    configurationFingerprint: 'a'.repeat(64),
    deadlineAt,
  }
  return { material, value }
}

describe('Plan revision advice persistence', () => {
  it('skips a single review followed by explicit Plan retention before loading advice', async () => {
    const f = await fixture(),
      response = f.repo.beginRun(f.admission()).run,
      plan = f.repo.collaboration(f.sessionId)!.planReference!.document
    f.repo.recordWorkflowPlanRetained(response.id, {
      nativeId: `retained-${response.id}`,
      sha256: plan.sha256,
      bytes: plan.bytes,
      chars: plan.chars,
    })
    f.finish(response.id)
    const current = f.repo.collaboration(f.sessionId)!,
      handoff = f.repo.workflowHandoff(current, current.reviewer)
    expect(f.repo.relayWorkflowWorthConsulting(handoff)).toBe(false)
    expect(f.repo.relayWorkflowSnapshot(handoff)).toBeUndefined()
    expect(f.repo.findRun(response.id)?.status).toBe('completed')
    expect(f.admission().agentId).toBe(current.reviewer)
  })

  it.each(['retained', 'revised'] as const)(
    'projects the complete repeated review chain after the owner %s the Plan',
    async (outcome) => {
      const f = await fixture(),
        firstResponse = f.repo.beginRun(f.admission()).run
      f.finish(firstResponse.id, {
        plan: 'Preserve the original scope and address the first review.',
      })
      const secondReview = f.repo.beginRun(f.admission()).run
      f.finish(secondReview.id, { verdict: 'changes_requested', answer: 'Verify the same scope.' })
      const response = f.repo.beginRun(f.admission()).run,
        plan = f.repo.collaboration(f.sessionId)!.planReference!.document
      if (outcome === 'retained')
        f.repo.recordWorkflowPlanRetained(response.id, {
          nativeId: `retained-${response.id}`,
          sha256: plan.sha256,
          bytes: plan.bytes,
          chars: plan.chars,
        })
      f.finish(
        response.id,
        outcome === 'revised' ? { plan: 'Complete final scope and verification.' } : {},
      )
      const current = f.repo.collaboration(f.sessionId)!,
        handoff = f.repo.workflowHandoff(current, current.reviewer)
      expect(f.repo.relayWorkflowWorthConsulting(handoff)).toBe(true)
      const material = await f.repo.readRelayWorkflowDecisionSources(
        handoff,
        [{ id: 'continue_plan_review', description: 'Keep the fixed independent review.' }],
        { signal: new AbortController().signal, deadlineAt: Date.now() + 15_000 },
      )
      expect(material.snapshot.node).toBe('owner_to_review')
      expect(material.snapshot.producer.runId).toBe(response.id)
      expect(material.snapshot.reviews.map((review) => review.runId)).toEqual([
        secondReview.id,
        f.reviewRun.id,
      ])
      expect(material.snapshot.responses.map((reply) => reply.runId)).toEqual([firstResponse.id])
      expect(
        material.input.sources.every(
          (source) => source.digest === createHash('sha256').update(source.text).digest('hex'),
        ),
      ).toBe(true)
      expect(f.admission().agentId).toBe(current.reviewer)
    },
  )

  it.each(['reserved', 'completed', 'not_sent'] as const)(
    'reads only the indexed durable identity for an existing %s evaluation',
    async (outcome) => {
      const f = await fixture()
      const read = vi.spyOn(f.repo, 'readPage')
      expect(f.repo.decisionEvaluationReceipt(f.handoff)).toBeUndefined()
      const reserved = f.repo.reserveEvaluation({
        handoff: f.handoff,
        provider: 'codex',
        model: 'gpt-6-luna',
        configurationFingerprint: 'a'.repeat(64),
      })
      if (reserved.status !== 'reserved') throw Error('Missing reservation')
      if (outcome === 'completed') f.repo.dispatchEvaluation(reserved.evaluation.id)
      if (outcome !== 'reserved')
        f.repo.settleEvaluation(reserved.evaluation.id, { outcome, physicalReleased: true })
      expect(f.repo.decisionEvaluationReceipt(f.handoff)).toEqual({ id: reserved.evaluation.id })
      if (!f.handoff.freshnessGuard.runId) throw Error('Expected workflow freshness')
      expect(
        f.repo.decisionEvaluationReceipt({
          ...f.handoff,
          freshnessGuard: {
            ...f.handoff.freshnessGuard,
            taskRevision: f.task.revision + 1,
          },
        }),
      ).toEqual({ id: reserved.evaluation.id })
      expect(
        f.repo.decisionEvaluationReceipt({ ...f.handoff, factFingerprint: 'b'.repeat(64) }),
      ).toBeUndefined()
      expect(read).not.toHaveBeenCalled()
      const query = f.db.drizzle.all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN SELECT id FROM scheduling_evaluations WHERE budget_subject_id=${f.handoff.budgetSubjectId} AND fact_fingerprint=${f.handoff.factFingerprint}`,
      )
      expect(
        query.some((row) =>
          row.detail.includes(
            'SEARCH scheduling_evaluations USING INDEX scheduling_evaluations_fact',
          ),
        ),
      ).toBe(true)
    },
  )

  it('collects complete later pages, the original input and frozen Comment/anchor sources', async () => {
    const plan = `Start ${'p'.repeat(22_000)} complete Plan tail.`,
      review = `Review ${'r'.repeat(22_000)} final cancellation requirement.`
    const earlier = `Earlier ${'e'.repeat(18_000)} original input tail.`,
      later = `Later ${'l'.repeat(18_000)} newest input tail.`
    const f = await fixture({ plan, review, commentCount: 2, inputs: [earlier, later] })
    const material = await f.repo.readPlanRevisionDecisionSources(f.handoff, {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 15_000,
    })
    expect(material.input.sources.find((source) => source.text === plan)).toBeDefined()
    expect(material.input.sources.find((source) => source.text === review)).toBeDefined()
    expect(material.input.sources.find((source) => source.text === earlier)).toBeDefined()
    expect(material.input.sources.find((source) => source.text === later)).toBeDefined()
    expect(material.sources.filter((source) => source.roles.includes('comment'))).toHaveLength(2)
    expect(material.sources.filter((source) => source.roles.includes('anchor'))).toHaveLength(2)
    expect(material.sources[0]!.roles).toEqual(['task', 'input'])
    expect(material.input.sources[0]!.text).toBe('/plan Review cancellation.')
    expect(material.inputSha256).toBe(hash(material.input))
    expect(material.sourceFingerprint).toBe(
      hash({
        version: 'plan-revision-guidance-v1',
        taskId: material.taskId,
        inputSequence: material.inputSequence,
        planVersion: material.planVersion,
        sources: material.sources,
      }),
    )
    expect(
      material.sources.filter((source) => source.roles.includes('anchor_target')),
    ).toHaveLength(2)
    expect(
      new Set(
        material.sources
          .filter((source) => source.roles.includes('anchor_target'))
          .map((source) => source.memberId),
      ).size,
    ).toBe(2)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(0)
  })

  it('rejects a frozen v1 Plan anchor target before consulting while the owner can revise v2 without that grant', async () => {
    const oldPlan = 'Frozen original v1 Plan with historical-only context.'
    const f = await fixture({
      plan: oldPlan,
      replyPlan: 'Current v2 Plan for the same original task.',
      commentCount: 1,
      planComments: true,
    })
    expect(f.originalPlan.version).toBe(1)
    expect(f.task.planReference!.version).toBe(2)
    expect(f.task.review).toMatchObject({
      verdict: 'changes_requested',
      planReference: f.task.planReference,
    })
    expect(f.readDocument(f.originalPlan.document)).toBe(oldPlan)
    expect(f.repo.sourceDocumentAuthorized(f.reviewRun.id, f.originalPlan.document)).toBe(false)
    expect(f.repo.sourceDocumentAuthorized(f.reviewRun.id, f.task.planReference!.document)).toBe(
      true,
    )
    const reserve = vi.spyOn(f.repo, 'reserveEvaluation')
    await expect(
      f.repo.readPlanRevisionDecisionSources(f.handoff, {
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 15_000,
      }),
    ).rejects.toThrow(/authoriz|permission|source/iu)
    expect(reserve).not.toHaveBeenCalled()
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(0)
    const revision = f.repo.beginRun(f.admission())
    expect(revision.created).toBe(true)
    expect(revision.run.agentId).toBe(f.task.owner)
    expect(
      f.repo.collaborationTurnAuthorization(revision.run.id)!.sourceManifestRef,
    ).toBeUndefined()
    expect(f.repo.sourceDocumentAuthorized(revision.run.id, f.originalPlan.document)).toBe(false)
    expect(f.repo.sourceDocumentAuthorized(revision.run.id, f.task.planReference!.document)).toBe(
      true,
    )
    expect(f.readDocument(f.originalPlan.document)).toBe(oldPlan)
  })

  it.each([
    'source-count',
    'source-bytes',
    'escaped-json-budget',
    'image',
    'unknown-anchor',
    'file-anchor',
  ] as const)(
    'refuses complete unsupported %s material before any evaluation while business can continue',
    async (kind) => {
      const f = await fixture(
        kind === 'source-count'
          ? { commentCount: 5 }
          : kind === 'source-bytes'
            ? { plan: 'p'.repeat(128 * 1024) }
            : kind === 'escaped-json-budget'
              ? { plan: '\u0001'.repeat(30_000) }
              : kind === 'file-anchor'
                ? { commentCount: 1, fileComments: true }
                : kind === 'unknown-anchor'
                  ? { commentCount: 1 }
                  : {},
      )
      if (kind === 'image') {
        const imageId = randomUUID()
        f.db.drizzle
          .insert(conversationImageAssets)
          .values({
            id: imageId,
            ownerSessionId: f.sessionId,
            ownerKey: 'fixture',
            name: 'fixture.png',
            ready: true,
            committed: true,
            mediaType: 'image/png',
            sha256: 'b'.repeat(64),
            bytes: 1,
            width: 1,
            height: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .run()
        f.db.drizzle
          .insert(conversationMessageImages)
          .values({ messageId: f.first.run.userMessageId, ordinal: 0, imageId })
          .run()
      }
      if (kind === 'unknown-anchor') {
        const member = f.db.drizzle.select().from(conversationInputBatchMembers).get()!
        const original = collaborationDocumentSchema.parse(JSON.parse(member.anchorDocumentJson!))
        const text = JSON.stringify({ type: 'future_anchor', quote: 'x' })
        const document = {
          id: original.id,
          sha256: createHash('sha256').update(text).digest('hex'),
          bytes: Buffer.byteLength(text),
          chars: text.length,
        }
        f.db.drizzle
          .update(conversationBodyParts)
          .set({ text, endBytes: document.bytes })
          .where(eq(conversationBodyParts.inputId, original.id))
          .run()
        f.db.drizzle
          .update(conversationBodyInputs)
          .set({ hash: document.sha256, bytes: document.bytes, chars: document.chars })
          .where(eq(conversationBodyInputs.id, original.id))
          .run()
        f.db.drizzle
          .update(conversationInputBatchMembers)
          .set({ anchorDocumentJson: JSON.stringify(document) })
          .where(eq(conversationInputBatchMembers.memberId, member.memberId))
          .run()
      }
      await expect(
        f.repo.readPlanRevisionDecisionSources(f.handoff, {
          signal: new AbortController().signal,
          deadlineAt: Date.now() + 15_000,
        }),
      ).rejects.toThrow(/budget|images|Comment|anchor|source|Invalid input/iu)
      expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(0)
      expect(f.repo.beginRun(f.admission()).created).toBe(true)
    },
  )

  it('adopts one immutable manifest in the Run transaction and keeps original submitted/handoff receipts', async () => {
    const f = await fixture({ commentCount: 1 })
    const { value } = await proposal(f)
    const input = f.admission(value)
    const result = f.repo.beginRun(input)
    const auth = f.repo.collaborationTurnAuthorization(result.run.id)!
    expect(auth.sourceManifestRef).toBeDefined()
    expect(
      planRevisionGuidanceSchema.parse(JSON.parse(f.readDocument(auth.sourceManifestRef!))),
    ).toEqual(value.guidance)
    expect(
      value.guidance.sources.every((source) =>
        f.repo.sourceDocumentAuthorized(result.run.id, source.document),
      ),
    ).toBe(true)
    expect(f.repo.beginRun({ ...input, planRevisionGuidance: undefined }).run.id).toBe(
      result.run.id,
    )
    expect(
      f.repo.beginRun({ ...input, clientMessageId: randomUUID(), planRevisionGuidance: undefined })
        .run.id,
    ).toBe(result.run.id)
    expect(
      f.db.drizzle
        .select()
        .from(agentEventJournal)
        .where(eq(agentEventJournal.eventType, 'scheduling.plan_revision_guidance_adopted'))
        .all(),
    ).toHaveLength(1)
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(1)
  })

  it('matches full validated JSON hashing across UTF-16 source and part cut points with escaped text', async () => {
    const plan =
      'a'.repeat(2047) +
      '😀' +
      'b'.repeat(8191 - 2049) +
      '🧭' +
      '\n"quoted"\\path\n' +
      'tail'.repeat(2500)
    const f = await fixture({ plan })
    const { material, value } = await proposal(f)
    expect(material.input.sources.find((source) => source.text === plan)).toBeDefined()
    expect(material.inputSha256).toBe(hash(material.input))
    const source = material.sources.find((entry) => entry.roles.includes('plan'))!
    const parts = f.db.drizzle
      .select()
      .from(conversationBodyParts)
      .where(eq(conversationBodyParts.inputId, source.document.id))
      .all()
    expect(parts.some((part) => part.offset === 8191)).toBe(true)
    const admitted = f.repo.beginRun(f.admission(value))
    expect(f.repo.collaborationTurnAuthorization(admitted.run.id)!.sourceManifestRef).toBeDefined()
  })

  it.each(['input-hash', 'source-map', 'generation', 'evaluation', 'deadline'] as const)(
    'ignores stale or invalid guidance %s without changing default business admission',
    async (kind) => {
      const f = await fixture()
      const { value } = await proposal(f)
      if (kind === 'input-hash') value.guidance.inputSha256 = '0'.repeat(64)
      if (kind === 'source-map') value.guidance.sources[0]!.document.chars++
      if (kind === 'generation') value.configurationGeneration++
      if (kind === 'evaluation') value.guidance.evaluationId = randomUUID()
      if (kind === 'deadline') value.deadlineAt = Date.now() - 1
      const result = f.repo.beginRun(f.admission(value))
      expect(result.created).toBe(true)
      expect(
        f.repo.collaborationTurnAuthorization(result.run.id)!.sourceManifestRef,
      ).toBeUndefined()
    },
  )

  it('rolls manifest, authorization, handoff and event back together on a late transaction failure', async () => {
    const f = await fixture()
    const { value } = await proposal(f)
    const beforeBodies = f.db.drizzle
      .select({ id: conversationBodyInputs.id })
      .from(conversationBodyInputs)
      .all()
    f.db.drizzle.run(
      sql`CREATE TEMP TRIGGER reject_guidance_claim BEFORE UPDATE ON scheduling_handoffs WHEN new.action IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture late admission failure'); END`,
    )
    expect(() => f.repo.beginRun(f.admission(value))).toThrow(/fixture late admission failure/)
    expect(
      f.db.drizzle.select({ id: conversationBodyInputs.id }).from(conversationBodyInputs).all(),
    ).toEqual(beforeBodies)
    expect(f.repo.handoffReceipt(f.handoff.id)!.runId).toBeNull()
    expect(f.repo.collaboration(f.sessionId)!.runId).toBe(f.reviewRun.id)
    expect(f.db.drizzle.select().from(agentRuns).all()).toHaveLength(2)
    expect(
      f.db.drizzle
        .select()
        .from(agentEventJournal)
        .where(eq(agentEventJournal.eventType, 'scheduling.plan_revision_guidance_adopted'))
        .all(),
    ).toHaveLength(0)
  })

  it('retains the existing business conflict when the handoff changes after evaluation', async () => {
    const f = await fixture()
    const { value } = await proposal(f)
    const input = f.admission(value)
    f.repo.pauseCollaboration(f.sessionId)
    expect(() => f.repo.beginRun(input)).toThrow(/handoff facts changed/iu)
    expect(f.repo.handoffReceipt(f.handoff.id)!.runId).toBeNull()
    expect(f.db.drizzle.select().from(agentRuns).all()).toHaveLength(2)
  })

  it('preserves the absolute invocation deadline and rejects abort before source reading', async () => {
    const f = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(
      f.repo.readPlanRevisionDecisionSources(f.handoff, {
        signal: controller.signal,
        deadlineAt: Date.now() + 15_000,
      }),
    ).rejects.toThrow(/abort/iu)
    const deadlineAt = Date.now() + 4_000
    const reserved = f.repo.reserveEvaluation({
      handoff: f.handoff,
      provider: 'codex',
      model: 'gpt-6-luna',
      configurationFingerprint: 'a'.repeat(64),
      deadlineAt,
    })
    if (reserved.status !== 'reserved') throw Error('Missing reservation')
    expect(Date.parse(reserved.evaluation.deadline)).toBe(deadlineAt)
    const batches = f.db.drizzle.all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN SELECT id,sequence,body_document_json FROM conversation_input_batches WHERE task_id=${f.task.id} AND sequence>0 AND sequence<=${f.task.inputSequence} AND body_state<>'withdrawn' ORDER BY sequence LIMIT 24`,
    )
    expect(
      batches.some((row) => row.detail.includes('conversation_input_batches_task_sequence_idx')),
    ).toBe(true)
    const batch = f.db.drizzle.select().from(conversationInputBatches).get()!
    const members = f.db.drizzle.all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN SELECT member_id,ordinal,body_document_json,anchor_document_json FROM conversation_input_batch_members WHERE batch_id=${batch.id} AND ordinal>-1 ORDER BY ordinal LIMIT 24`,
    )
    expect(
      members.some((row) => row.detail.includes('conversation_input_batch_members_ordinal_idx')),
    ).toBe(true)
  })

  it('preserves the adopted immutable refs through completed Plan Handoff, quoting and Rebuild', async () => {
    const f = await fixture({ commentCount: 1 })
    const { value } = await proposal(f)
    const adopted = f.repo.beginRun(f.admission(value)).run
    f.finish(adopted.id, {
      plan: 'Revised cancellation boundary.',
      answer: 'The Plan now covers cancellation.',
    })
    const auth = f.repo.collaborationTurnAuthorization(adopted.id)!
    const answer = f.db.drizzle
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, f.repo.findRun(adopted.id)!.responseMessageId!))
      .get()!
    const handoff = f.repo.readHandoffPage(f.sessionId, 'claude', -1, answer.sequence)
    expect(handoff.messages.find((message) => message.messageId === answer.id)!.content).toContain(
      auth.sourceManifestRef!.id,
    )
    const ordinary = f.repo.beginRun({
      sessionId: f.sessionId,
      clientMessageId: randomUUID(),
      content: 'Read these checked sources.',
      commentIds: [],
      expectedCommentsRevision: f.admission().expectedCommentsRevision,
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
      handoffSourceRefs: [
        {
          id: answer.id,
          revision: answer.contentRevision,
          digest: handoff.messages.find((message) => message.messageId === answer.id)!.digest,
        },
      ],
    }).run
    const frozen = f.repo.readRunSources(ordinary.id)
    expect(
      frozen.items[0]!.documents.some((entry) => entry.source.id === auth.sourceManifestRef!.id),
    ).toBe(true)
    expect(
      value.guidance.sources.every((source) =>
        f.repo.sourceDocumentAuthorized(ordinary.id, source.document),
      ),
    ).toBe(true)
    f.repo.failRun(ordinary.id, 'protocol_error', 'Fixture not dispatched', false)
    f.repo.markNativeContextsMissing(f.sessionId, ['codex'])
    const rebuildId = randomUUID()
    f.repo.beginNativeRebuild({
      id: rebuildId,
      sessionId: f.sessionId,
      agentId: 'codex',
      expectedGeneration: 1,
      abandon: false,
    })
    const chunks = []
    for await (const chunk of f.repo.nativeContextRebuildSource(
      f.sessionId,
      new AbortController().signal,
      rebuildId,
    ))
      chunks.push(chunk)
    expect(
      chunks.some(
        (chunk) => chunk.kind === 'message' && chunk.content.includes(auth.sourceManifestRef!.id),
      ),
    ).toBe(true)
    f.repo.freezeNativeRebuildSource(rebuildId, chunks)
    const saved = f.db.drizzle
      .select()
      .from(conversationRebuildSourceRefs)
      .where(eq(conversationRebuildSourceRefs.operationId, rebuildId))
      .all()
    expect(saved.some((row) => row.documentsJson.includes(auth.sourceManifestRef!.id))).toBe(true)
  })

  it('remaps only standard document/source identities in a Fork and retains historical evaluation digests', async () => {
    const f = await fixture({ commentCount: 1 })
    const { value } = await proposal(f)
    const adopted = f.repo.beginRun(f.admission(value)).run
    f.finish(adopted.id, { plan: 'Revised cancellation boundary.' })
    const source = f.db.sessionRepository.find(f.sessionId)!
    const selection = f.repo.selectForkSource(
      f.sessionId,
      f.repo.findRun(adopted.id)!.responseMessageId!,
      source.settings,
      source.settingsRevision,
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
        prefixHash: 'a'.repeat(64),
        prefixRecords: 2,
        prefixBytes: 100,
      }
    }
    const boundaries = { claude: boundary('claude'), codex: boundary('codex') }
    const fork = f.repo.commitFork(randomUUID(), selection, boundaries, [])
    const inherited = f.db.drizzle
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.sessionId, fork.sessionId))
      .all()
      .find((run) => run.forkSourceRunId === adopted.id)!
    const auth = f.repo.collaborationTurnAuthorization(inherited.id)!
    const manifest = planRevisionGuidanceSchema.parse(
      JSON.parse(f.readDocument(auth.sourceManifestRef!, fork.sessionId)),
    )
    expect(manifest.taskId).not.toBe(value.guidance.taskId)
    expect(manifest.evaluationId).toBe(value.guidance.evaluationId)
    expect(manifest.handoffId).toBe(value.guidance.handoffId)
    expect(manifest.inputSha256).toBe(value.guidance.inputSha256)
    expect(manifest.sourceFingerprint).toBe(value.guidance.sourceFingerprint)
    expect(manifest.sources.map((entry) => entry.evaluatedSha256)).toEqual(
      value.guidance.sources.map((entry) => entry.evaluatedSha256),
    )
    expect(
      manifest.sources.every(
        (entry, index) => entry.document.id !== value.guidance.sources[index]!.document.id,
      ),
    ).toBe(true)
    expect(
      manifest.sources.every((entry) =>
        f.repo.sourceDocumentAuthorized(inherited.id, entry.document),
      ),
    ).toBe(true)
    expect(f.repo.collaboration(fork.sessionId)).toBeUndefined()
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(1)
  })

  it('reopens exact adopted sources without evaluating or restoring advice authority after Restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-guidance-restart-'))
    directories.push(directory)
    const filePath = join(directory, 'pact.sqlite')
    const f = await fixture({ filePath, commentCount: 1 })
    const { value } = await proposal(f)
    const adopted = f.repo.beginRun(f.admission(value)).run
    f.finish(adopted.id, { plan: 'Revised cancellation boundary.' })
    const ref = f.repo.collaborationTurnAuthorization(adopted.id)!.sourceManifestRef!
    fixtures.splice(fixtures.indexOf(f), 1)
    f.db.close()
    const db = await PactDatabase.open({
      filePath,
      migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
    })
    reopened.push(db)
    const repo = db.conversationRepository
    expect(repo.collaborationTurnAuthorization(adopted.id)!.sourceManifestRef).toEqual(ref)
    expect(
      value.guidance.sources.every((source) =>
        repo.sourceDocumentAuthorized(adopted.id, source.document),
      ),
    ).toBe(true)
    expect(db.drizzle.select().from(schedulingEvaluations).all()).toHaveLength(1)
    await expect(
      repo.readPlanRevisionDecisionSources(f.handoff, {
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 15_000,
      }),
    ).rejects.toThrow(/handoff facts changed/iu)
  })
})
