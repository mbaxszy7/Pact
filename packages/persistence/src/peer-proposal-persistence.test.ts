import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { DefaultSessionSettings } from '@pact/contracts'

import { PactDatabase } from './pact-database.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const temporaryDirectories: string[] = []

const proposalEvent = (kind: 'review' | 'fact_check') => ({
  agentId: 'codex' as const,
  type: 'peer.assistance.requested' as const,
  turnId: `turn-${kind}`,
  proposalId: randomUUID(),
  targetAgentId: 'claude' as const,
  kind,
})

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('Peer proposal persistence', () => {
  const settings: DefaultSessionSettings = {
    primaryAgentId: 'codex',
    agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
    maxDiscussionRounds: 6,

    maxReviewCycles: 3,
    maxRepairAttempts: 3,
  }

  async function fixture(filePath = ':memory:') {
    const db = await PactDatabase.open({ filePath, migrationsFolder })
    const projectId = randomUUID()
    const sessionId = randomUUID()
    const createdAt = new Date().toISOString()
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Probe',
      kind: 'git',
      directoryPath: '/probe',
      createdAt,
    })
    db.sessionRepository.create({ id: sessionId, projectId, title: 'Probe', createdAt }, settings)
    const repo = db.conversationRepository
    const runStart = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Probe',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    })
    return { db, repo, sessionId, runId: runStart.run.id }
  }

  it('supersedes the pending proposal on retry and replaces it on the next Turn', async () => {
    const f = await fixture()
    try {
      f.repo.applyEvent(f.sessionId, f.runId, proposalEvent('review'))
      const first = f.repo.findRun(f.runId)!.peerProposal
      expect(first).toMatchObject({ state: 'pending', kind: 'review' })
      f.repo.updateAttempt(f.runId, 2, true)
      expect(f.repo.findRun(f.runId)!.peerProposal).toMatchObject({
        id: first!.id,
        state: 'superseded',
      })
      const second = proposalEvent('fact_check')
      f.repo.applyEvent(f.sessionId, f.runId, second)
      expect(f.repo.findRun(f.runId)!.peerProposal).toMatchObject({
        id: second.proposalId,
        state: 'pending',
        kind: 'fact_check',
      })
    } finally {
      f.db.close()
    }
  })

  it('persists pending, superseded and replacement proposals across database reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-peer-proposal-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'pact.sqlite')
    const f = await fixture(filePath)
    let db = f.db
    try {
      const first = proposalEvent('review')
      db.conversationRepository.applyEvent(f.sessionId, f.runId, first)
      db.close()
      db = await PactDatabase.open({ filePath, migrationsFolder })
      expect(db.conversationRepository.findRun(f.runId)?.peerProposal).toMatchObject({
        id: first.proposalId,
        state: 'pending',
        kind: 'review',
      })
      db.conversationRepository.updateAttempt(f.runId, 2, true)
      db.close()
      db = await PactDatabase.open({ filePath, migrationsFolder })
      expect(db.conversationRepository.findRun(f.runId)?.peerProposal).toMatchObject({
        id: first.proposalId,
        state: 'superseded',
      })
      const second = proposalEvent('fact_check')
      db.conversationRepository.applyEvent(f.sessionId, f.runId, second)
      db.close()
      db = await PactDatabase.open({ filePath, migrationsFolder })
      expect(db.conversationRepository.findRun(f.runId)?.peerProposal).toMatchObject({
        id: second.proposalId,
        state: 'pending',
        kind: 'fact_check',
        targetAgentId: 'claude',
      })
    } finally {
      if (db.isHealthy()) db.close()
    }
  })
})
