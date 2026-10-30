import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AgentRunInput } from '@pact/agent-runtime'
import type { CollaborationReviewObservation, DecisionInput } from '@pact/contracts'

import type { WorkflowSourceRead } from './relay-workflow-fixture.test-support.js'

import { Conversation } from './conversation.js'
import { nativeWorkerFixture } from './native-workers-fixture.test-support.js'
import { decisionWorkingMemoryDiagnostics } from './native-working-memory.js'
import {
  proposeWorkflowPlanOn,
  workflowConversation,
} from './relay-workflow-fixture.test-support.js'

const native = vi.hoisted(() => ({
  inputs: [] as AgentRunInput[],
  reviews: [] as CollaborationReviewObservation[],
  decisions: [] as DecisionInput[],
  candidate: undefined as string | null | undefined,
  interruptNextWrite: false,
  loseObservation: false,
  rebuilds: [] as string[],
  sourceReads: [] as WorkflowSourceRead[],
  workerPath: '',
}))
vi.mock('./codex-agent-adapter.js', async () => {
  const { workflowAdapter } = await import('./relay-workflow-fixture.test-support.js')
  return { CodexAgentAdapter: workflowAdapter('codex', native) }
})
vi.mock('./claude-agent-adapter.js', async () => {
  const { workflowAdapter } = await import('./relay-workflow-fixture.test-support.js')
  return { ClaudeAgentAdapter: workflowAdapter('claude', native) }
})
vi.mock('./codex-decision-runtime.js', async () => {
  const { workflowDecisionRuntime } = await import('./relay-workflow-fixture.test-support.js')
  return { CodexDecisionRuntime: workflowDecisionRuntime(native) }
})
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(
        filename: ConstructorParameters<typeof actual.Worker>[0],
        options?: ConstructorParameters<typeof actual.Worker>[1],
      ) {
        super(
          String(filename).endsWith('markdown-projection-worker.js') ? native.workerPath : filename,
          options,
        )
      }
    },
  }
})
let workers: Awaited<ReturnType<typeof nativeWorkerFixture>>
const owned: Array<Awaited<ReturnType<typeof workflowConversation>>> = []
beforeAll(async () => {
  workers = await nativeWorkerFixture(['markdown-projection-worker'])
  native.workerPath = workers.paths['markdown-projection-worker']!
}, 20_000)
afterAll(async () => {
  await workers?.dispose()
})
afterEach(async () => {
  await Promise.all(owned.splice(0).map((f) => f.dispose()))
  native.inputs = []
  native.reviews = []
  native.decisions = []
  native.candidate = undefined
  native.interruptNextWrite = false
  native.loseObservation = false
  native.rebuilds = []
  native.sourceReads = []
  vi.restoreAllMocks()
})
async function fixture(primary: 'codex' | 'claude' = 'codex') {
  const f = await workflowConversation(Conversation, primary)
  owned.push(f)
  return f
}

it('keeps five Relay decisions waiting while an independent sixth Session completes its fixed review', async () => {
  const f = await fixture(),
    repo = f.db.conversationRepository
  await new Promise<void>((resolve) => setImmediate(resolve))
  const cards = []
  // oxlint-disable-next-line eslint/no-await-in-loop -- Join each single-App evaluation before admitting the next real proposal.
  for (let index = 0; index < 5; index++) cards.push(await proposeWorkflowPlanOn(f.db, index))
  expect(cards.every(({ sessionId }) => repo.hasRelayDecision(sessionId))).toBe(true)
  expect(native.inputs).toHaveLength(0)
  expect(
    await f.flow.send(
      f.input('/build Complete the independent sixth Session and its fixed code review.'),
    ),
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
  const complete = await f.settled()
  expect(complete).toMatchObject({ kind: 'build', status: 'complete', reviewer: 'claude' })
  expect(
    native.inputs.map((input) => ({
      sessionId: input.sessionId,
      stage: input.promptEnvelope.collaboration?.stage,
      actor: input.promptEnvelope.collaboration?.actor,
    })),
  ).toEqual([
    { sessionId: f.sessionId, stage: 'implement', actor: 'codex' },
    { sessionId: f.sessionId, stage: 'code_review', actor: 'claude' },
  ])
  for (const { sessionId, card } of cards) {
    expect(repo.relaySchedulingDecision(sessionId)).toEqual(card)
    expect(repo.collaboration(sessionId)).toMatchObject({ automation: 'active', status: 'waiting' })
  }
  expect(
    f.db.drizzle.get(
      sql`SELECT count(*) AS count FROM scheduling_budget_reservations WHERE budget IN ('extra_plan_turn','extra_code_turn')`,
    ),
  ).toEqual({ count: 0 })
  expect(decisionWorkingMemoryDiagnostics().chargedBytes).toBe(0)
})

describe.each([32, 100])('%i independently waiting Relay cards', (count) => {
  let representative: Awaited<ReturnType<typeof workflowConversation>>
  beforeAll(
    async () => {
      representative = await workflowConversation(Conversation)
      await new Promise<void>((resolve) => setImmediate(resolve))
      for (let index = 0; index < count; index++) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Genuine proposals share the single-App evaluation owner and must settle serially.
        await proposeWorkflowPlanOn(representative.db, index)
      }
    },
    count === 100 ? 30_000 : 20_000,
  )
  afterAll(async () => {
    await representative?.dispose()
  })

  it('keeps indexed five-row pages and advances independent work beyond every waiting card', async () => {
    const repo = representative.db.conversationRepository
    const seen = new Set<string>()
    let cursor: { updatedAt: string; id: string } | undefined
    let first: ReturnType<typeof repo.pendingWorkflowTasks>[number] | undefined
    for (;;) {
      const page = repo.pendingWorkflowTasks(cursor)
      expect(page.length).toBeLessThanOrEqual(5)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4 * 1024)
      if (!page.length) break
      first ??= page[0]
      for (const candidate of page) {
        expect(seen.has(candidate.sessionId)).toBe(false)
        expect(repo.hasRelayDecision(candidate.sessionId)).toBe(true)
        seen.add(candidate.sessionId)
      }
      cursor = page.at(-1)!
    }
    expect(seen.size).toBe(count)
    const queryPlan = representative.db.drizzle.all<{ detail: string }>(sql`
      EXPLAIN QUERY PLAN SELECT session_id,id,updated_at FROM collaboration_tasks
      WHERE active=1 AND json_extract(state_json,'$.protocol')='native-workflow-v1'
        AND json_extract(state_json,'$.automation')='active'
        AND json_extract(state_json,'$.status')='waiting'
        AND (updated_at,id)>(${first!.updatedAt},${first!.id})
      ORDER BY updated_at,id LIMIT 5`)
    const details = queryPlan.map((row) => row.detail).join('\n')
    expect(details).toContain('collaboration_tasks_pending_workflow')
    expect(details).not.toContain('USE TEMP B-TREE')
    expect(
      await representative.flow.send(
        representative.input('/build Review this independent task after every waiting card.'),
      ),
    ).toMatchObject({ ok: true })
    await vi.waitFor(
      () => expect(native.inputs).toHaveLength(2),
      count === 100 ? { timeout: 5_000 } : undefined,
    )
    expect(await representative.settled()).toMatchObject({ status: 'complete', reviewer: 'claude' })
    expect(native.inputs.map((input) => input.sessionId)).toEqual([
      representative.sessionId,
      representative.sessionId,
    ])
    for (const sessionId of seen) expect(repo.hasRelayDecision(sessionId)).toBe(true)
  })
})

it('rescans earlier candidates when Relay gates become stale while a later page is being visited', async () => {
  const f = await fixture(),
    repo = f.db.conversationRepository
  await new Promise<void>((resolve) => setImmediate(resolve))
  const cards = []
  for (let index = 0; index < 6; index++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each real evaluation must release before the next proposal is admitted.
    cards.push(await proposeWorkflowPlanOn(f.db, index))
  }
  const originalRead = repo.pendingWorkflowTasks.bind(repo)
  const pages: number[] = []
  let disabled: ReturnType<Conversation['saveSchedulingSettings']> | undefined
  // Observe the real selector without changing any result. The public settings mutation
  // occurs exactly between pages, after earlier valid gates have already been visited.
  vi.spyOn(repo, 'pendingWorkflowTasks').mockImplementation((after) => {
    const page = originalRead(after)
    pages.push(page.length)
    if (after && !disabled) {
      disabled = f.flow.saveSchedulingSettings({
        expectedRevision: repo.schedulingSettings().revision,
        enabled: false,
      })
    }
    return page
  })
  expect(
    await f.flow.send(
      f.input('/build Keep this independent task progressing while other waits change.'),
    ),
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(disabled).toBeDefined())
  expect(await disabled).toMatchObject({ ok: true, value: { enabled: false } })
  await vi.waitFor(() => expect(native.inputs).toHaveLength(8))
  expect(await f.settled()).toMatchObject({ status: 'complete' })
  for (const { sessionId } of cards) {
    expect(repo.relaySchedulingDecision(sessionId)).toBeNull()
    const task = repo.collaboration(sessionId)!
    expect(task.notice).toBeUndefined()
    expect({ status: task.status, automation: task.automation, notice: task.notice }).toMatchObject(
      { status: 'ready', automation: 'active' },
    )
    expect(native.inputs.filter((input) => input.sessionId === sessionId)).toHaveLength(1)
  }
  expect(pages.every((length) => length <= 5)).toBe(true)
  expect(native.decisions).toEqual([])
})
