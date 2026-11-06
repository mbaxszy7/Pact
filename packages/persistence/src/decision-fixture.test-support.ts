import { sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type { DecisionHttpOwner, DecisionInput, DecisionPhysicalWitness } from '@pact/contracts'

import { decisionInputSchema } from '@pact/contracts'

import { ensureHandoff } from './conversation-scheduling.js'
import { PactDatabase } from './pact-database.js'
import {
  schedulingBudgetCounters,
  schedulingEvaluations,
  schedulingRuntimeOwners,
} from './schema/index.js'

/** Authoritative existing Run -> stable recovery handoff, without dispatching any recovery policy. */
export async function decisionFixture(filePath = ':memory:', directoryPath = '/decision-fixture') {
  const db = await PactDatabase.open({
    filePath,
    migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
  })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    now = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Decision fixture',
    directoryPath,
    kind: 'directory',
    createdAt: now,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Decision fixture', createdAt: now },
    {
      primaryAgentId: 'codex',
      agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  const repo = db.conversationRepository
  const first = repo.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'Original ordinary input.',
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
  })
  repo.applyEvent(sessionId, first.run.id, {
    agentId: 'codex',
    type: 'turn.completed',
    turnId: 'owned-original-turn',
    outcome: 'failed',
  })
  const text = 'Complete authoritative source.'
  const input = decisionInputSchema.parse({
    version: 1,
    objective: 'Assess supplied candidates.',
    handoff: repo.recoveryHandoff({ kind: 'run', id: first.run.id }),
    candidates: [{ id: 'wait', description: 'Keep the original wait.' }],
    sources: [{ id: 'source:1', digest: createHash('sha256').update(text).digest('hex'), text }],
  })
  repo.saveSchedulingSettings({ expectedRevision: 0, enabled: true })
  repo.writeRelayCredential({
    operation: 'save',
    nonce: randomUUID(),
    expectedRevision: 0,
    deadlineAt: Date.now() + 5000,
    ciphertext: Buffer.from('synthetic fixture ciphertext').toString('base64'),
  })
  return { db, repo, projectId, sessionId, first, input }
}

/** Historical native decision left physically unconfirmed before the Decisions cutover. */
export function seedHistoricalDecisionEvaluation(
  db: PactDatabase,
  input: DecisionInput,
  witness: DecisionPhysicalWitness | null,
): string {
  const id = randomUUID(),
    createdAt = new Date().toISOString(),
    deadline = new Date(Date.now() + 15000).toISOString(),
    configurationFingerprint = 'a'.repeat(64),
    physicalWitnessJson = witness === null ? null : JSON.stringify(witness)
  db.drizzle.transaction(() => {
    ensureHandoff(db.drizzle, input.handoff)
    db.drizzle
      .insert(schedulingEvaluations)
      .values({
        id,
        sessionId: input.handoff.sessionId,
        handoffId: input.handoff.id,
        budgetSubjectId: input.handoff.budgetSubjectId,
        factFingerprint: input.handoff.factFingerprint,
        provider: 'codex',
        model: 'gpt-6-luna',
        configurationFingerprint,
        handoffJson: JSON.stringify(input.handoff),
        active: true,
        called: true,
        outcome: 'failed',
        usageJson: JSON.stringify({ inputTokens: 17, outputTokens: 5 }),
        physicalWitnessJson,
        createdAt,
        deadline,
      })
      .run()
    db.drizzle
      .insert(schedulingRuntimeOwners)
      .values({
        id,
        kind: 'evaluation',
        sessionId: input.handoff.sessionId,
        evaluationId: id,
        provider: 'codex',
        model: 'gpt-6-luna',
        configurationFingerprint,
        physicalWitnessJson,
        nativeGeneration: 0,
        active: true,
        phase: 'cleanup_unconfirmed',
        createdAt,
        deadline,
      })
      .run()
    db.drizzle
      .insert(schedulingBudgetCounters)
      .values({
        subjectId: input.handoff.budgetSubjectId,
        sessionId: input.handoff.sessionId,
        evaluationCalls: 1,
      })
      .onConflictDoUpdate({
        target: schedulingBudgetCounters.subjectId,
        set: { evaluationCalls: sql`${schedulingBudgetCounters.evaluationCalls} + 1` },
      })
      .run()
  })
  return id
}

export function decisionEvaluationFacts(db: PactDatabase) {
  const result = db.drizzle.get<{
    called: number
    active: number
    usage_json: string
    physical_witness_json: string
  }>(sql`SELECT * FROM scheduling_evaluations`)
  if (!result) throw Error('Missing decision evaluation')
  return result
}

const fixtureUtilityEpoch = randomUUID()

export function decisionHttpOwnerFixture(): DecisionHttpOwner {
  return {
    version: 1,
    kind: 'http',
    utilityEpoch: fixtureUtilityEpoch,
    utilityPid: process.pid,
    requestId: randomUUID(),
  }
}

export function configureDecisionFixtureCredential(
  repo: PactDatabase['conversationRepository'],
): void {
  const receipt = repo.writeRelayCredential({
    operation: 'save',
    nonce: randomUUID(),
    expectedRevision: repo.readRelayCredential().revision,
    deadlineAt: Date.now() + 5000,
    ciphertext: Buffer.from('synthetic fixture ciphertext').toString('base64'),
  })
  if (!receipt.configured)
    throw Error('Expected the synthetic decision credential to be configured')
}
