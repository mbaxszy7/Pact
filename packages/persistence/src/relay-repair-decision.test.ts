import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { advanceAutomaticCollaboration, type CollaborationAction } from '@pact/contracts'

import {
  configureDecisionFixtureCredential,
  decisionHttpOwnerFixture,
} from './decision-fixture.test-support.js'
import { PactDatabase } from './pact-database.js'
import { planRevisionFixture } from './plan-revision-guidance.test-support.js'
import {
  agentRuns,
  collaborationTasks,
  relayDecisions,
  schedulingBudgetReservations,
  schedulingEvaluations,
  workflowTurns,
} from './schema/index.js'

const databases = new Set<PactDatabase>()
const fixtures: Awaited<ReturnType<typeof planRevisionFixture>>[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.db.close()
  for (const database of databases) database.close()
  databases.clear()
})

type Workflow = Awaited<ReturnType<typeof planRevisionFixture>>
function startAction(f: Workflow, action: CollaborationAction | 'plan_auto') {
  const current = f.repo.collaboration(f.sessionId)!,
    settings = f.db.sessionRepository.find(f.sessionId)!.settings,
    clientMessageId = randomUUID(),
    prepared =
      action === 'plan_auto'
        ? undefined
        : f.repo.prepareCollaborationAction(
            {
              sessionId: f.sessionId,
              taskId: current.id,
              revision: current.revision,
              clientMessageId,
              action,
            },
            settings,
          ),
    next = prepared?.next ?? advanceAutomaticCollaboration(current, settings)
  return f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId,
    content: 'Continue authorized work.',
    commentIds: [],
    expectedCommentsRevision: 0,
    settingsRevision: f.db.sessionRepository.find(f.sessionId)!.settingsRevision,
    agentId: next.actor,
    model: null,
    effort: null,
    preserveDraftComments: true,
    expectedCollaborationRevision: current.revision,
    collaboration: next,
    schedulingHandoff: prepared?.handoff ?? f.repo.workflowHandoff(current, next.actor),
    ...(prepared ? { collaborationActionReceiptId: prepared.receipt.id } : {}),
  }).run
}

async function limitWorkflow() {
  const f = await planRevisionFixture({ maxDiscussionRounds: 2 })
  databases.add(f.db)
  const revision = startAction(f, 'plan_auto')
  f.finish(revision.id, { plan: 'First revised Plan.' })
  const review = startAction(f, 'plan_auto')
  f.finish(review.id, {
    verdict: 'changes_requested',
    answer: 'Clarify cancellation before accepting the Plan.',
  })
  const revised = startAction(f, 'plan_auto')
  f.finish(revised.id, { plan: 'Revised Plan at the discussion limit.' })
  const task = f.repo.collaboration(f.sessionId)!
  const handoff = f.repo.workflowHandoff(task, task.owner)
  return { ...f, task, producer: revised, handoff }
}

describe('Relay repair retirement and Phase 1 tamper guards', () => {
  it('completes open-mode execute -> review_code -> fix -> review_code directly without Relay decisions or extra-turn budgets', async () => {
    const f = await planRevisionFixture()
    databases.add(f.db)
    const owner = decisionHttpOwnerFixture()
    configureDecisionFixtureCredential(f.repo)
    expect(owner.utilityPid).toBe(process.pid)

    const revised = startAction(f, 'plan_auto')
    f.finish(revised.id, { plan: 'Current Plan for implementation.' })
    const planReview = startAction(f, 'plan_auto')
    f.finish(planReview.id, { verdict: 'accepted' })

    const impl = startAction(f, 'execute')
    f.recordCodeChange(impl.id, 'src/impl.ts')
    f.finish(impl.id, { answer: 'Implemented the accepted Plan.' })

    const firstCodeReview = startAction(f, 'review_code')
    f.finish(firstCodeReview.id, {
      verdict: 'changes_requested',
      answer: 'Tighten error cleanup before merging.',
    })

    const taskAfterReview = f.repo.collaboration(f.sessionId)!
    expect(taskAfterReview).toMatchObject({
      openMode: true,
      status: 'waiting',
      stage: 'code_review',
      review: { verdict: 'changes_requested' },
    })
    expect(
      f.repo.relayWorkflowAlternatives(
        f.repo.workflowHandoff(taskAfterReview, taskAfterReview.owner),
      ),
    ).toBeUndefined()

    const fix = startAction(f, 'fix')
    f.recordCodeChange(fix.id, 'src/fix.ts')
    f.finish(fix.id, { answer: 'Cleaned up error handling within the original scope.' })

    const secondCodeReview = startAction(f, 'review_code')
    f.finish(secondCodeReview.id, {
      verdict: 'accepted',
      answer: 'The updated implementation passes review.',
    })

    expect(f.repo.collaboration(f.sessionId)).toMatchObject({
      openMode: true,
      status: 'waiting',
      repairAttempts: 1,
      reviewCycles: 2,
      review: { verdict: 'accepted' },
    })
    expect(f.db.drizzle.select().from(relayDecisions).all()).toEqual([])
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
    expect(f.db.drizzle.select().from(schedulingBudgetReservations).all()).toEqual([])
    expect(f.db.drizzle.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  })

  it('keeps the normal first Plan revision without an alternative', async () => {
    const f = await planRevisionFixture()
    fixtures.push(f)
    expect(f.repo.relayWorkflowAlternatives(f.handoff)).toBeUndefined()
    expect(f.db.drizzle.select().from(relayDecisions).all()).toEqual([])
    expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
  })

  it.each([
    'running',
    'pending_effects',
    'foreign_actor',
    'corrupt_actor',
    'paused',
    'plan_mismatch',
  ] as const)(
    'rejects a no-longer-current Phase 1 limit producer when tampered (%s)',
    async (tamper) => {
      const f = await limitWorkflow(),
        task = f.repo.collaboration(f.sessionId)!
      expect(f.repo.relayWorkflowAlternatives(f.handoff)?.snapshot.node).toBe('plan_review_limit')
      if (tamper === 'paused') {
        f.repo.setCollaborationState({
          ...task,
          revision: task.revision + 1,
          automation: 'paused',
          pauseReason: 'user',
        })
      } else if (tamper === 'plan_mismatch') {
        f.repo.setCollaborationState({
          ...task,
          revision: task.revision + 1,
          planReference: { ...task.planReference!, document: task.taskDocument! },
        })
      } else if (tamper === 'corrupt_actor') {
        const row = f.db.drizzle
          .select()
          .from(workflowTurns)
          .where(eq(workflowTurns.runId, f.producer.id))
          .get()!
        const auth = JSON.parse(row.authorizationJson)
        auth.actor = 'bogus_actor'
        f.db.drizzle
          .update(workflowTurns)
          .set({ authorizationJson: JSON.stringify(auth) })
          .where(eq(workflowTurns.runId, row.runId))
          .run()
      } else if (tamper === 'running') {
        f.db.drizzle
          .update(agentRuns)
          .set({ status: 'running' })
          .where(eq(agentRuns.id, f.producer.id))
          .run()
      } else if (tamper === 'pending_effects') {
        f.db.drizzle
          .update(agentRuns)
          .set({ nativeEffectsState: 'unknown' })
          .where(eq(agentRuns.id, f.producer.id))
          .run()
      } else {
        f.db.drizzle
          .update(agentRuns)
          .set({ agentId: task.reviewer })
          .where(eq(agentRuns.id, f.producer.id))
          .run()
      }
      const current = f.repo.collaboration(f.sessionId)!,
        handoff = f.repo.workflowHandoff(current, current.owner)
      expect(f.repo.relayWorkflowAlternatives(handoff)).toBeUndefined()
      expect(f.db.drizzle.select().from(relayDecisions).all()).toEqual([])
      expect(f.db.drizzle.select().from(schedulingEvaluations).all()).toEqual([])
    },
  )

  it('rejects an offer for a legacy task whose owner and reviewer are the same actor', async () => {
    const f = await limitWorkflow(),
      task = f.repo.collaboration(f.sessionId)!
    const row = f.db.drizzle
      .select()
      .from(collaborationTasks)
      .where(eq(collaborationTasks.id, task.id))
      .get()!
    const state = JSON.parse(row.stateJson)
    state.owner = task.reviewer
    delete state.rolePolicy
    f.db.drizzle
      .update(collaborationTasks)
      .set({ stateJson: JSON.stringify(state) })
      .where(eq(collaborationTasks.id, task.id))
      .run()
    const current = f.repo.collaboration(f.sessionId)!,
      handoff = f.repo.workflowHandoff(current, current.owner)
    expect(f.repo.relayWorkflowAlternatives(handoff)).toBeUndefined()
    expect(f.db.drizzle.select().from(relayDecisions).all()).toEqual([])
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
  })
})
