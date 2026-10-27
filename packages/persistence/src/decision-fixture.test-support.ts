import { sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { decisionInputSchema } from '@pact/contracts'

import { PactDatabase } from './pact-database.js'

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
  repo.saveSchedulingSettings({
    expectedRevision: 0,
    enabled: true,
    selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
  })
  return { db, repo, projectId, sessionId, first, input }
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
