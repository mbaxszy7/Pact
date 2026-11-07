import Database from 'better-sqlite3'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { DefaultSessionSettings, NativeProbeResult, RuntimeAgentId } from '@pact/contracts'

import { ConversationRepository } from './conversation-repository.js'
import { seedHistoricalAnswerAttempt } from './legacy-database.test-support.js'
import { PactDatabase } from './pact-database.js'
import {
  agentEventJournal,
  agentRuns,
  conversationMessages,
  nativeAgentContexts,
  nativeRebuildOperations,
  schema,
} from './schema/index.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: {
    claude: { model: null, effort: null },
    codex: { model: 'frozen-model', effort: 'high' },
  },
  maxDiscussionRounds: 6,

  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}

async function fixture(filePath = ':memory:') {
  const db = await PactDatabase.open({ filePath, migrationsFolder })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Recovery',
    kind: 'directory',
    directoryPath: '/recovery-fixture',
    createdAt,
  })
  db.sessionRepository.create({ id: sessionId, projectId, title: 'Recovery', createdAt }, settings)
  return { db, repo: db.conversationRepository, sessionId, projectId }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function start(f: Fixture, agentId: RuntimeAgentId = 'codex') {
  const current = f.db.sessionRepository.find(f.sessionId)!
  const drafts = f.repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
  if (drafts.scope !== 'drafts') throw new Error('Fixture draft page')
  return f.repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: randomUUID(),
    content: 'Original task',
    expectedCommentsRevision: drafts.commentsRevision,
    commentIds: [],
    agentId,
    settingsRevision: current.settingsRevision,
    model: 'frozen-model',
    effort: 'high',
  })
}
function seed(f: Fixture, agentId: RuntimeAgentId = 'codex', abandon = false) {
  const id = randomUUID(),
    nativeSessionId = randomUUID()
  const generation = f.repo.nativeContext(f.sessionId, agentId)?.bindingGeneration ?? 1
  f.repo.beginNativeRebuild({
    id,
    sessionId: f.sessionId,
    agentId,
    expectedGeneration: generation,
    abandon,
  })
  const sourceHash = f.repo.freezeNativeRebuildSource(id, [])
  f.repo.markNativeRebuildDispatched(id)
  f.repo.recordNativeRebuildIdentity(id, nativeSessionId)
  const witness = {
    kind: 'codex_rollout_v1' as const,
    nativeSessionId,
    verifiedPrefixBytes: 1024,
    verifiedPrefixSha256: 'a'.repeat(64),
    recordCount: 2,
  }
  return { id, nativeSessionId, sourceHash, generation, witness }
}
function bindingEvidence(f: Fixture, candidate: ReturnType<typeof seed>): NativeProbeResult {
  return {
    kind: 'binding_ready',
    source: 'completed_initialization_readback',
    rebuildId: candidate.id,
    sourceHash: candidate.sourceHash,
    witness: candidate.witness,
    identity: {
      sessionId: f.sessionId,
      agentId: 'codex',
      requestId: candidate.id,
      nativeSessionId: candidate.nativeSessionId,
      bindingGeneration: candidate.generation + 1,
    },
  }
}
function evidenceFor(
  f: Fixture,
  runId: string,
  kind: 'ended' | 'missing' | 'no_evidence',
): NativeProbeResult {
  const run = f.repo.findRun(runId)!
  const identity = {
    sessionId: f.sessionId,
    agentId: run.agentId,
    runId,
    requestId: runId,
    nativeSessionId: run.nativeSessionId!,
    bindingGeneration: run.bindingGeneration!,
    ...(run.nativeTurnId ? { nativeTurnId: run.nativeTurnId } : {}),
  }
  if (kind === 'ended') return { kind, identity, source: 'stored_terminal', outcome: 'completed' }
  if (kind === 'missing') return { kind, identity, source: 'native_error' }
  return { kind, identity, reason: 'The native read did not confirm this request.' }
}

async function nativeCursorFixture() {
  const f = await fixture()
  const cursor = start(f).run
  f.repo.applyEvent(f.sessionId, cursor.id, {
    type: 'session.started',
    agentId: 'codex',
    nativeSessionId: 'cursor-native',
  })
  f.repo.recordDispatch(cursor.id, 'accepted', 'cursor-native', randomUUID())
  f.repo.applyEvent(f.sessionId, cursor.id, {
    type: 'turn.started',
    agentId: 'codex',
    turnId: 'cursor-turn',
  })
  f.repo.applyEvent(f.sessionId, cursor.id, {
    type: 'text.completed',
    agentId: 'codex',
    turnId: 'cursor-turn',
    outputId: 'cursor-output',
    text: 'Saved native response',
  })
  f.repo.observationUnavailable(cursor.id, 'Pact lost the native terminal notification.')
  return { ...f, cursor }
}
function failBeforeNativeStart(f: Fixture) {
  const rejected = start(f).run
  f.repo.recordDispatch(rejected.id, 'rejected')
  f.repo.failRun(
    rejected.id,
    'runtime_incompatible',
    'Local startup was rejected before dispatch.',
    false,
  )
  return rejected
}

describe('Native cursor health after local NoStart failures', () => {
  it('recovers the real cursor after two rejected starts without granting historical event control or fabricated outcomes', async () => {
    const f = await nativeCursorFixture()
    try {
      const first = failBeforeNativeStart(f),
        second = failBeforeNativeStart(f)
      f.repo.setContinuation(f.sessionId, 'codex', 'checking')
      expect(f.repo.ownsNativeControl(f.cursor.id)).toBe(false)
      f.repo.recordNativeEvidence(evidenceFor(f, f.cursor.id, 'ended'))
      f.repo.settleKnownNativeEnding(f.cursor.id)
      expect(f.repo.nativeContext(f.sessionId, 'codex')).toMatchObject({
        lastRunId: f.cursor.id,
        nativeSessionId: 'cursor-native',
        continuationState: 'ready',
      })
      for (const rejected of [first, second]) {
        expect(f.repo.findRun(rejected.id)).toMatchObject({
          status: 'failed',
          dispatchPhase: 'rejected',
        })
        expect(f.repo.findRun(rejected.id)).not.toHaveProperty('nativeOutcome')
        expect(f.repo.findRun(rejected.id)).not.toHaveProperty('nativeTurnId')
      }
      const title = f.db.sessionRepository.find(f.sessionId)?.title
      f.repo.applyEvent(f.sessionId, f.cursor.id, {
        type: 'session.title.updated',
        agentId: 'codex',
        title: 'Historical title must not win',
      })
      expect(f.db.sessionRepository.find(f.sessionId)?.title).toBe(title)
      expect(() =>
        f.repo.applyEvent(f.sessionId, f.cursor.id, {
          type: 'peer.assistance.requested',
          agentId: 'codex',
          turnId: 'cursor-turn',
          proposalId: randomUUID(),
          targetAgentId: 'claude',
          kind: 'review',
        }),
      ).toThrow(/no longer owns/iu)
      expect(() =>
        f.repo.applyEvent(f.sessionId, f.cursor.id, {
          type: 'text.completed',
          agentId: 'codex',
          turnId: 'cursor-turn',
          outputId: 'late-output',
          text: 'Late historical mutation',
        }),
      ).toThrow(/no longer owns/iu)
      expect(f.repo.findRun(f.cursor.id)?.peerProposal).toBeUndefined()
      expect(f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({
            kind: 'complete',
            message: expect.objectContaining({ content: 'Saved native response' }),
          }),
        ]),
      })
    } finally {
      f.db.close()
    }
  })

  it.each(['possibly_sent', 'active', 'generation_changed', 'pending_rebuild'] as const)(
    'does not release the binding when %s invalidates the old cursor',
    async (blocker) => {
      const f = await nativeCursorFixture()
      try {
        if (blocker === 'possibly_sent') {
          const uncertain = start(f).run
          f.repo.recordDispatch(uncertain.id, 'possibly_sent')
          f.repo.failRun(
            uncertain.id,
            'unknown_delivery',
            'Native acceptance was not confirmed.',
            true,
          )
          failBeforeNativeStart(f)
        } else if (blocker === 'active') start(f)
        else if (blocker === 'generation_changed') {
          failBeforeNativeStart(f)
          f.db.drizzle
            .update(nativeAgentContexts)
            .set({ bindingGeneration: 2 })
            .where(eq(nativeAgentContexts.sessionId, f.sessionId))
            .run()
        } else {
          failBeforeNativeStart(f)
          f.repo.beginNativeRebuild({
            id: randomUUID(),
            sessionId: f.sessionId,
            agentId: 'codex',
            expectedGeneration: 1,
            abandon: true,
          })
        }
        f.repo.setContinuation(f.sessionId, 'codex', 'checking')
        const context = f.repo.nativeContext(f.sessionId, 'codex')
        f.repo.recordNativeEvidence(evidenceFor(f, f.cursor.id, 'ended'))
        f.repo.settleKnownNativeEnding(f.cursor.id)
        expect(f.repo.nativeContext(f.sessionId, 'codex')).toEqual(context)
        expect(f.repo.ownsNativeControl(f.cursor.id)).toBe(false)
      } finally {
        f.db.close()
      }
    },
  )

  it('uses an Agent/generation-scoped indexed blocker lookup amid unrelated session history', async () => {
    const f = await nativeCursorFixture()
    try {
      const createdAt = new Date().toISOString()
      const unrelated = Array.from({ length: 1000 }, (_, index) => ({
        id: randomUUID(),
        sessionId: f.sessionId,
        userMessageId: f.cursor.userMessageId,
        agentId: index % 2 ? ('claude' as const) : ('codex' as const),
        bindingGeneration: index + 2,
        status: 'failed' as const,
        dispatchPhase: 'rejected' as const,
        attemptCount: 1,
        settingsRevision: 1,
        createdAt,
        updatedAt: createdAt,
      }))
      for (let offset = 0; offset < unrelated.length; offset += 50)
        f.db.drizzle
          .insert(agentRuns)
          .values(unrelated.slice(offset, offset + 50))
          .run()
      const plan = f.db.drizzle
        .all<{ detail: string }>(
          sql`EXPLAIN QUERY PLAN SELECT id FROM agent_runs WHERE session_id=${f.sessionId} AND agent_id='codex' AND binding_generation=1 AND rowid>(SELECT rowid FROM agent_runs WHERE id=${f.cursor.id}) AND (status NOT IN ('failed','interrupted') OR dispatch_phase NOT IN ('not_sent','rejected')) LIMIT 1`,
        )
        .map((row) => row.detail)
        .join('\n')
      expect(plan).toMatch(/session_id=\? AND agent_id=\? AND binding_generation=\?/u)
      expect(plan).not.toContain('SCAN agent_runs')
      f.repo.setContinuation(f.sessionId, 'codex', 'checking')
      f.repo.recordNativeEvidence(evidenceFor(f, f.cursor.id, 'ended'))
      expect(f.repo.nativeContext(f.sessionId, 'codex')?.continuationState).toBe('ready')
    } finally {
      f.db.close()
    }
  })

  it('persists unavailable recording diagnostics without changing native execution evidence or continuation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-recording-diagnostic-'))
    let db: PactDatabase | undefined
    try {
      const filePath = join(directory, 'pact.sqlite'),
        f = await fixture(filePath)
      db = f.db
      const run = start(f).run
      f.repo.applyEvent(f.sessionId, run.id, {
        type: 'session.started',
        agentId: 'codex',
        nativeSessionId: 'diagnostic-native',
      })
      f.repo.recordDispatch(run.id, 'accepted', 'diagnostic-native', randomUUID())
      const nativeBefore = f.repo.nativeContext(f.sessionId, 'codex'),
        runBefore = f.repo.findRun(run.id)
      const reason = 'Native changes could not be safely recorded. '.repeat(10)
      const patch = f.repo.recordWorkspaceRecordingUnavailable(run.id, reason)
      expect(patch.runs).toMatchObject([
        { id: run.id, workspaceRecordingUnavailableReason: reason.slice(0, 240) },
      ])
      expect(f.repo.nativeContext(f.sessionId, 'codex')).toEqual(nativeBefore)
      expect(f.repo.findRun(run.id)).toMatchObject({
        status: runBefore!.status,
        dispatchPhase: runBefore!.dispatchPhase,
      })
      expect(f.repo.findRun(run.id)).not.toHaveProperty('nativeOutcome')
      const fact = db.drizzle
        .select()
        .from(agentEventJournal)
        .all()
        .filter((row) => row.eventType === 'workspace.recording_unavailable')
      expect(fact).toHaveLength(1)
      expect(JSON.parse(fact[0]!.payload)).toEqual({ reason: reason.slice(0, 240) })
      db.close()
      db = await PactDatabase.open({ filePath, migrationsFolder })
      expect(db.conversationRepository.findRun(run.id)?.workspaceRecordingUnavailableReason).toBe(
        reason.slice(0, 240),
      )
    } finally {
      db?.close()
      await rm(directory, { recursive: true })
    }
  })
})

describe('Durable Native recovery ownership', () => {
  it('requires a Codex initialization witness before committing binding or divider', async () => {
    const f = await fixture()
    try {
      const candidate = seed(f)
      expect(() => f.repo.completeNativeRebuild(candidate.id, candidate.nativeSessionId)).toThrow(
        'readback witness',
      )
      expect(() =>
        f.repo.completeNativeRebuild(candidate.id, candidate.nativeSessionId, undefined, {
          ...candidate.witness,
          nativeSessionId: randomUUID(),
        }),
      ).toThrow('another Native Session')
      expect(f.repo.nativeContext(f.sessionId, 'codex')).toBeUndefined()
      expect(f.repo.nativeRebuildOperation(candidate.id)?.stage).toBe('seeding')
      expect(f.db.drizzle.select().from(conversationMessages).all()).toEqual([])
      expect(f.db.drizzle.select().from(agentEventJournal).all()).toEqual([])
    } finally {
      f.db.close()
    }
  })
  it('persists completed initialization across reopen and restores ready without inventing a Run or ending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-native-reopen-'))
    let db: PactDatabase | undefined
    try {
      const path = join(directory, 'pact.sqlite'),
        f = await fixture(path)
      db = f.db
      const candidate = seed(f)
      const completed = f.repo.completeNativeRebuild(
        candidate.id,
        candidate.nativeSessionId,
        undefined,
        candidate.witness,
      )
      expect(completed.messages).toMatchObject([
        { mode: 'replace', text: 'Codex native session rebuilt' },
      ])
      f.repo.setContinuation(f.sessionId, 'codex', 'checking')
      db.close()
      db = await PactDatabase.open({ filePath: path, migrationsFolder })
      db.conversationRepository.recoverInterruptedRuns()
      const reopened = { ...f, db, repo: db.conversationRepository }
      expect(reopened.repo.confirmedNativeInitialization(f.sessionId, 'codex')).toMatchObject({
        rebuildId: candidate.id,
        sourceHash: candidate.sourceHash,
        witness: candidate.witness,
      })
      reopened.repo.recordNativeEvidence(bindingEvidence(reopened, candidate))
      expect(reopened.repo.nativeContext(f.sessionId, 'codex')).toMatchObject({
        nativeSessionId: candidate.nativeSessionId,
        bindingGeneration: 2,
        continuationState: 'ready',
      })
      expect(db.drizzle.select().from(agentRuns).all()).toEqual([])
      const facts = db.drizzle.select().from(agentEventJournal).all()
      expect(facts.map((row) => row.eventType)).toEqual([
        'native.rebuild_completed',
        'native.initialization_checked',
      ])
      expect(facts.some((row) => row.payload.includes('ended'))).toBe(false)
    } finally {
      db?.close()
      await rm(directory, { recursive: true })
    }
  })

  it('requires the completed receipt and fences every initialization identity field', async () => {
    const f = await fixture()
    try {
      const candidate = seed(f),
        evidence = bindingEvidence(f, candidate)
      expect(() => f.repo.recordNativeEvidence(evidence)).toThrow('no longer owns')
      f.repo.completeNativeRebuild(
        candidate.id,
        candidate.nativeSessionId,
        undefined,
        candidate.witness,
      )
      f.repo.setContinuation(f.sessionId, 'codex', 'checking')
      if (evidence.kind !== 'binding_ready') throw Error('Fixture kind')
      const invalid = [
        { ...evidence, sourceHash: 'f'.repeat(64) },
        { ...evidence, rebuildId: randomUUID() },
        { ...evidence, witness: { ...candidate.witness, verifiedPrefixSha256: 'b'.repeat(64) } },
        { ...evidence, witness: undefined },
        ...[
          { nativeSessionId: randomUUID() },
          { bindingGeneration: 3 },
          { requestId: randomUUID() },
          { runId: randomUUID() },
          { nativeTurnId: 'invented-turn' },
          { executorId: randomUUID() },
        ].map((identity) =>
          Object.assign({}, evidence, {
            identity: Object.assign({}, evidence.identity, identity),
          }),
        ),
      ]
      for (const value of invalid)
        expect(() => f.repo.recordNativeEvidence(value)).toThrow('no longer owns')
      expect(f.repo.nativeContext(f.sessionId, 'codex')?.continuationState).toBe('checking')
      expect(f.db.drizzle.select().from(agentRuns).all()).toEqual([])
    } finally {
      f.db.close()
    }
  })

  it('rejects delayed binding-ready evidence once a real task owns the new generation', async () => {
    const f = await fixture()
    try {
      const candidate = seed(f)
      f.repo.completeNativeRebuild(
        candidate.id,
        candidate.nativeSessionId,
        undefined,
        candidate.witness,
      )
      const run = start(f).run
      expect(f.repo.confirmedNativeInitialization(f.sessionId, 'codex')).toBeUndefined()
      expect(() => f.repo.recordNativeEvidence(bindingEvidence(f, candidate))).toThrow(
        'no longer owns',
      )
      expect(f.repo.findRun(run.id)?.dispatchPhase).toBe('not_sent')
    } finally {
      f.db.close()
    }
  })

  it('keeps old-generation checks historical after explicit rebuild, without locking or settling the new binding', async () => {
    const f = await fixture()
    try {
      const run = start(f).run
      f.repo.applyEvent(f.sessionId, run.id, {
        type: 'session.started',
        agentId: 'codex',
        nativeSessionId: 'old-native',
      })
      f.repo.recordDispatch(run.id, 'accepted', 'old-native', randomUUID())
      f.repo.applyEvent(f.sessionId, run.id, {
        type: 'turn.started',
        agentId: 'codex',
        turnId: 'old-turn',
      })
      f.repo.observationUnavailable(run.id, 'Pact crashed before terminal evidence.')
      expect(() => seed(f)).toThrow('confirm rebuilding')
      const candidate = seed(f, 'codex', true)
      f.repo.completeNativeRebuild(
        candidate.id,
        candidate.nativeSessionId,
        undefined,
        candidate.witness,
      )
      const before = f.repo.nativeContext(f.sessionId, 'codex')
      for (const kind of ['missing', 'no_evidence', 'ended'] as const)
        f.repo.recordNativeEvidence(evidenceFor(f, run.id, kind))
      f.repo.settleKnownNativeEnding(run.id)
      expect(f.repo.nativeContext(f.sessionId, 'codex')).toEqual(before)
      expect(f.repo.findRun(run.id)).toMatchObject({
        controlDisposition: 'abandoned',
        nativeOutcome: 'completed',
        dispatchPhase: 'ended',
      })
      expect(f.repo.nativeRecoveryBlocksInput(f.sessionId)).toBe(false)
    } finally {
      f.db.close()
    }
  })

  it('writes exactly one durable divider and journal fact for repeated completion acknowledgements', async () => {
    const f = await fixture()
    try {
      const candidate = seed(f)
      f.repo.completeNativeRebuild(
        candidate.id,
        candidate.nativeSessionId,
        undefined,
        candidate.witness,
      )
      f.repo.completeNativeRebuild(
        candidate.id,
        candidate.nativeSessionId,
        undefined,
        candidate.witness,
      )
      f.repo.beginNativeRebuild({
        id: candidate.id,
        sessionId: f.sessionId,
        agentId: 'codex',
        expectedGeneration: 1,
        abandon: false,
      })
      expect(f.db.drizzle.select().from(conversationMessages).all()).toMatchObject([
        { role: 'system', content: 'Codex native session rebuilt' },
      ])
      expect(f.db.drizzle.select().from(agentEventJournal).all()).toHaveLength(1)
      expect(f.repo.nativeContext(f.sessionId, 'codex')?.bindingGeneration).toBe(2)
    } finally {
      f.db.close()
    }
  })

  it('rolls back binding, receipt and divider together if durable journal insertion fails', async () => {
    const f = await fixture()
    try {
      const candidate = seed(f)
      f.db.drizzle.run(
        sql`CREATE TRIGGER reject_rebuild_fact BEFORE INSERT ON agent_event_journal WHEN NEW.event_type = 'native.rebuild_completed' BEGIN SELECT RAISE(ABORT, 'fixture journal failure'); END`,
      )
      expect(() =>
        f.repo.completeNativeRebuild(
          candidate.id,
          candidate.nativeSessionId,
          undefined,
          candidate.witness,
        ),
      ).toThrow('fixture journal failure')
      expect(f.repo.nativeContext(f.sessionId, 'codex')).toBeUndefined()
      expect(f.repo.nativeRebuildOperation(candidate.id)?.stage).toBe('seeding')
      expect(f.db.drizzle.select().from(conversationMessages).all()).toEqual([])
      expect(f.db.drizzle.select().from(agentEventJournal).all()).toEqual([])
    } finally {
      f.db.close()
    }
  })

  it('rejects a malformed initializer executor before mutating the completed binding or divider', async () => {
    const f = await fixture()
    try {
      const candidate = seed(f)
      expect(() =>
        f.repo.completeNativeRebuild(candidate.id, candidate.nativeSessionId, 'not-a-uuid'),
      ).toThrow(/uuid/iu)
      expect(f.repo.nativeContext(f.sessionId, 'codex')).toBeUndefined()
      expect(f.repo.nativeRebuildOperation(candidate.id)?.stage).toBe('seeding')
      expect(f.db.drizzle.select().from(conversationMessages).all()).toEqual([])
      expect(f.db.drizzle.select().from(agentEventJournal).all()).toEqual([])
    } finally {
      f.db.close()
    }
  })

  it.each(['', 'x'.repeat(1025)])(
    'rejects malformed native initialization identities without recording them',
    async (nativeSessionId) => {
      const f = await fixture()
      try {
        const id = randomUUID()
        f.repo.beginNativeRebuild({
          id,
          sessionId: f.sessionId,
          agentId: 'codex',
          expectedGeneration: 1,
          abandon: false,
        })
        f.repo.freezeNativeRebuildSource(id, [])
        f.repo.markNativeRebuildDispatched(id)
        expect(() => f.repo.recordNativeRebuildIdentity(id, nativeSessionId)).toThrow(/string/iu)
        expect(f.repo.nativeRebuildOperation(id)).toMatchObject({ stage: 'creating' })
        expect(f.repo.nativeRebuildOperation(id)).not.toHaveProperty('provisionalNativeSessionId')
        expect(f.repo.nativeContext(f.sessionId, 'codex')).toBeUndefined()
      } finally {
        f.db.close()
      }
    },
  )

  it('exposes rebuilds with no binding independently and classifies restart by dispatch evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-native-operations-'))
    let db: PactDatabase | undefined
    try {
      const path = join(directory, 'pact.sqlite'),
        f = await fixture(path)
      db = f.db
      const pending = randomUUID()
      f.repo.beginNativeRebuild({
        id: pending,
        sessionId: f.sessionId,
        agentId: 'claude',
        expectedGeneration: 1,
        abandon: false,
      })
      const dispatched = seed(f)
      const snapshot = f.repo.readPage({ scope: 'messages', sessionId: f.sessionId })
      expect(snapshot.scope).toBe('messages')
      if (snapshot.scope !== 'messages') throw Error('Fixture page')
      expect(snapshot.header.rebuildOperations).toHaveLength(2)
      expect(snapshot.header.rebuildOperations).toEqual(
        expect.arrayContaining([
          {
            agentId: 'claude',
            operation: expect.objectContaining({ id: pending, stage: 'preparing' }),
          },
          {
            agentId: 'codex',
            operation: expect.objectContaining({ id: dispatched.id, stage: 'seeding' }),
          },
        ]),
      )
      db.close()
      db = await PactDatabase.open({ filePath: path, migrationsFolder })
      db.conversationRepository.recoverInterruptedRuns()
      expect(db.conversationRepository.nativeRebuildOperation(pending)?.stage).toBe('failed')
      expect(db.conversationRepository.nativeRebuildOperation(dispatched.id)?.stage).toBe(
        'unconfirmed',
      )
      expect(db.drizzle.select().from(nativeAgentContexts).all()).toEqual([])
    } finally {
      db?.close()
      await rm(directory, { recursive: true })
    }
  })

  it('binds the startup executor before delivery without inventing possibly-sent status', async () => {
    const f = await fixture()
    try {
      const run = start(f).run,
        executorId = randomUUID()
      const patch = f.repo.recordExecutor(run.id, executorId)
      expect(patch.runs).toMatchObject([{ id: run.id, executorId, dispatchPhase: 'not_sent' }])
      f.repo.recordDispatch(run.id, 'accepted', 'native', executorId)
      expect(() => f.repo.recordExecutor(run.id, randomUUID())).toThrow('no longer owns')
    } finally {
      f.db.close()
    }
  })

  it('keeps an accepted task blocked after restart until native terminal evidence arrives', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-native-accepted-'))
    let db: PactDatabase | undefined
    try {
      const path = join(directory, 'pact.sqlite'),
        f = await fixture(path)
      db = f.db
      const run = start(f).run
      const executorId = randomUUID()
      f.repo.recordExecutor(run.id, executorId)
      f.repo.applyEvent(f.sessionId, run.id, {
        type: 'session.started',
        agentId: 'codex',
        nativeSessionId: 'accepted-native',
      })
      f.repo.recordDispatch(run.id, 'accepted', 'accepted-native', executorId)
      f.repo.applyEvent(f.sessionId, run.id, {
        type: 'turn.started',
        agentId: 'codex',
        turnId: 'accepted-turn',
      })
      db.close()
      db = await PactDatabase.open({ filePath: path, migrationsFolder })
      db.conversationRepository.recoverInterruptedRuns()
      const reopened = { ...f, db, repo: db.conversationRepository }
      expect(reopened.repo.findRun(run.id)).toMatchObject({
        status: 'interrupted',
        dispatchPhase: 'accepted',
      })
      expect(reopened.repo.findRun(run.id)).not.toHaveProperty('nativeOutcome')
      expect(reopened.repo.nativeRecoveryBlocksInput(f.sessionId)).toBe(true)
      reopened.repo.recordNativeEvidence(evidenceFor(reopened, run.id, 'no_evidence'))
      expect(reopened.repo.nativeRecoveryBlocksInput(f.sessionId)).toBe(true)
      reopened.repo.recordNativeEvidence(evidenceFor(reopened, run.id, 'ended'))
      reopened.repo.settleKnownNativeEnding(run.id)
      expect(reopened.repo.nativeRecoveryBlocksInput(f.sessionId)).toBe(false)
      expect(reopened.repo.findRun(run.id)).toMatchObject({
        status: 'completed',
        nativeOutcome: 'completed',
        dispatchPhase: 'ended',
      })
      expect(db.drizzle.select().from(agentRuns).all()).toHaveLength(1)
    } finally {
      db?.close()
      await rm(directory, { recursive: true })
    }
  })

  it('records confirmed native deletion without inventing a successful or ended task', async () => {
    const f = await fixture()
    try {
      const run = start(f).run
      f.repo.applyEvent(f.sessionId, run.id, {
        type: 'session.started',
        agentId: 'codex',
        nativeSessionId: 'deleted-native',
      })
      f.repo.recordDispatch(run.id, 'accepted', 'deleted-native', randomUUID())
      f.repo.observationUnavailable(run.id, 'Native process became unavailable.')
      const evidence = evidenceFor(f, run.id, 'missing')
      expect(() =>
        f.repo.recordNativeEvidence({
          ...evidence,
          identity: { ...evidence.identity, nativeSessionId: 'foreign-native' },
        }),
      ).toThrow('identity does not match')
      f.repo.recordNativeEvidence(evidence)
      expect(f.repo.nativeContext(f.sessionId, 'codex')).toMatchObject({
        state: 'missing',
        continuationState: 'recovery_required',
      })
      expect(f.repo.findRun(run.id)).toMatchObject({
        status: 'interrupted',
        dispatchPhase: 'accepted',
      })
      expect(f.repo.findRun(run.id)).not.toHaveProperty('nativeOutcome')
      expect(f.repo.nativeRecoveryBlocksInput(f.sessionId)).toBe(true)
    } finally {
      f.db.close()
    }
  })
})

describe('Session-scoped permission revisions', () => {
  it('freezes existing tasks, revokes full access for retry and keeps model settings frozen', async () => {
    const f = await fixture()
    try {
      const grant = {
        sessionId: f.sessionId,
        agentId: 'codex' as const,
        mode: 'full' as const,
        expectedRevision: 1,
        confirmedFullAccess: true,
      }
      expect(() =>
        f.db.sessionRepository.savePermission({ ...grant, confirmedFullAccess: false }),
      ).toThrow('explicit confirmation')
      f.db.sessionRepository.savePermission(grant)
      const run = start(f).run
      expect(run.permissionMode).toBe('full')
      f.db.sessionRepository.savePermission({
        ...grant,
        mode: 'ask',
        expectedRevision: 2,
        confirmedFullAccess: false,
      })
      expect(f.repo.findRun(run.id)?.permissionMode).toBe('full')
      f.repo.failRun(run.id, 'runtime_incompatible', 'Mode rejected before native delivery', false)
      const retry = seedHistoricalAnswerAttempt(f.db, run.id).run
      expect(retry).toMatchObject({
        permissionMode: 'ask',
        model: 'frozen-model',
        effort: 'high',
        settingsRevision: 2,
      })
      expect(f.db.sessionRepository.find(f.sessionId)?.settings.permissionModes).toEqual({
        claude: 'ask',
        codex: 'ask',
      })
    } finally {
      f.db.close()
    }
  })

  it('fences stale saves, explicit grants and archived sessions without advancing revisions', async () => {
    const f = await fixture()
    try {
      const save = {
        sessionId: f.sessionId,
        agentId: 'codex' as const,
        mode: 'auto' as const,
        expectedRevision: 1,
        confirmedFullAccess: false,
      }
      f.db.sessionRepository.savePermission(save)
      expect(() => f.db.sessionRepository.savePermission({ ...save, mode: 'ask' })).toThrow(
        'settings changed',
      )
      expect(f.db.sessionRepository.find(f.sessionId)?.settingsRevision).toBe(2)
      expect(() =>
        f.db.sessionRepository.savePermission({ ...save, mode: 'full', expectedRevision: 2 }),
      ).toThrow('Full access requires explicit confirmation')
      expect(f.db.sessionRepository.find(f.sessionId)?.settingsRevision).toBe(2)
      f.db.sessionRepository.savePermission({
        ...save,
        agentId: 'claude',
        mode: 'native',
        expectedRevision: 2,
      })
      expect(f.db.sessionRepository.find(f.sessionId)?.settings.permissionModes?.claude).toBe(
        'native',
      )
      expect(f.db.sessionRepository.find(f.sessionId)?.settingsRevision).toBe(3)
      f.db.sessionRepository.archive(f.sessionId)
      expect(() =>
        f.db.sessionRepository.savePermission({
          ...save,
          mode: 'full',
          expectedRevision: 3,
          confirmedFullAccess: true,
        }),
      ).toThrow('settings changed')
    } finally {
      f.db.close()
    }
  })

  it('persists independent Agent choices and does not leak them to new sessions or global defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-permissions-reopen-'))
    let db: PactDatabase | undefined
    try {
      const path = join(directory, 'pact.sqlite'),
        f = await fixture(path)
      db = f.db
      const global = db.defaultSessionSettingsRepository.read()
      db.sessionRepository.savePermission({
        sessionId: f.sessionId,
        agentId: 'claude',
        mode: 'full',
        expectedRevision: 1,
        confirmedFullAccess: true,
      })
      db.sessionRepository.savePermission({
        sessionId: f.sessionId,
        agentId: 'codex',
        mode: 'auto',
        expectedRevision: 2,
        confirmedFullAccess: false,
      })
      db.close()
      db = await PactDatabase.open({ filePath: path, migrationsFolder })
      expect(db.sessionRepository.find(f.sessionId)?.settings.permissionModes).toEqual({
        claude: 'full',
        codex: 'auto',
      })
      const id = randomUUID()
      db.sessionRepository.create(
        {
          id,
          projectId: f.projectId,
          title: 'Unrelated session',
          createdAt: new Date().toISOString(),
        },
        settings,
      )
      expect(db.sessionRepository.find(id)?.settings.permissionModes).toEqual({
        claude: 'ask',
        codex: 'native',
      })
      expect(db.defaultSessionSettingsRepository.read()).toEqual(global)
    } finally {
      db?.close()
      await rm(directory, { recursive: true })
    }
  })
})

it('queries only the target Project and retains old-generation work through abandonment and restart', async () => {
  const f = await fixture()
  try {
    const run = start(f).run
    expect(f.repo.projectHasNativeWork(f.projectId)).toBe(true)
    expect(f.repo.projectHasNativeWork(randomUUID())).toBe(false)
    f.repo.recordNativeEffects(run.id, 'pending')
    f.repo.failRun(run.id, 'unknown_delivery', 'Observer closed', false)
    const candidate = seed(f, 'codex', true)
    f.repo.completeNativeRebuild(
      candidate.id,
      candidate.nativeSessionId,
      undefined,
      candidate.witness,
    )
    expect(f.repo.projectHasNativeWork(f.projectId)).toBe(true)
    f.repo.recoverInterruptedRuns()
    expect(f.repo.findRun(run.id)?.nativeEffectsState).toBe('unknown')
    expect(f.repo.projectHasNativeWork(f.projectId)).toBe(true)
    f.repo.recordNativeEffects(run.id, 'settled')
    expect(f.repo.projectHasNativeWork(f.projectId)).toBe(false)
    expect(f.repo.projectHasNativeWork(randomUUID())).toBe(false)
    expect(f.repo.diagnostics().completeReads).toBe(0)
  } finally {
    f.db.close()
  }
})

it('keeps creation-work identity independent of superseded recovery stages and late failures', async () => {
  const f = await fixture()
  try {
    const first = seed(f),
      oldActor = randomUUID()
    f.db.drizzle
      .update(nativeRebuildOperations)
      .set({ creationExecutorId: oldActor })
      .where(eq(nativeRebuildOperations.id, first.id))
      .run()
    f.repo.failNativeRebuild(first.id, 'Reply lost')
    const next = seed(f, 'codex', true),
      newActor = randomUUID()
    f.db.drizzle
      .update(nativeRebuildOperations)
      .set({ creationExecutorId: newActor })
      .where(eq(nativeRebuildOperations.id, next.id))
      .run()
    f.repo.recordNativeRebuildWork(first.id, oldActor, first.nativeSessionId, 'settled')
    expect(f.repo.projectHasNativeWork(f.projectId)).toBe(true)
    expect(() =>
      f.repo.recordNativeRebuildWork(next.id, oldActor, next.nativeSessionId, 'settled'),
    ).toThrow('another creation actor')
    expect(() =>
      f.repo.recordNativeRebuildWork(next.id, newActor, 'wrong-candidate', 'settled'),
    ).toThrow('another creation actor')
    f.repo.recoverInterruptedRuns()
    expect(f.repo.projectHasNativeWork(f.projectId)).toBe(true)
    f.repo.recordNativeRebuildWork(next.id, newActor, next.nativeSessionId, 'settled')
    f.repo.failNativeRebuild(next.id, 'Late failure after natural ending')
    expect(f.repo.projectHasNativeWork(f.projectId)).toBe(false)
    expect(f.repo.nativeRebuildOperation(first.id)?.stage).toBe('superseded')
    expect(f.repo.nativeRebuildOperation(next.id)?.stage).toBe('unconfirmed')
  } finally {
    f.db.close()
  }
})

it('uses partial unsettled-work indexes without scanning a thousand ended historical Runs', async () => {
  const f = await fixture()
  try {
    const original = start(f).run
    f.repo.failRun(original.id, 'agent_process_crash', 'Never dispatched', false)
    const seedSettled = (count: number) =>
      f.db.drizzle
        .insert(agentRuns)
        .values(
          Array.from({ length: count }, () => ({
            id: randomUUID(),
            sessionId: f.sessionId,
            userMessageId: original.userMessageId,
            agentId: 'codex' as const,
            status: 'completed' as const,
            nativeEffectsState: 'settled' as const,
            settingsRevision: 1,
            attemptCount: 1,
            createdAt: original.createdAt,
            updatedAt: original.updatedAt,
          })),
        )
        .run()
    seedSettled(100)
    expect(f.repo.projectHasNativeWork(f.projectId)).toBe(false)
    const sqlite: unknown = Reflect.get(f.db.drizzle, '$client')
    if (!(sqlite instanceof Database)) throw new Error('Missing fixture SQLite client.')
    const queries: { query: string; params: unknown[] }[] = []
    const traced = drizzle(sqlite, {
      schema,
      logger: {
        logQuery: (query, params) => {
          if (queries.length >= 8) throw new Error('Native-work query capture exceeds its bound.')
          queries.push({ query, params })
        },
      },
    })
    const production = new ConversationRepository(traced)
    queries.length = 0
    expect(production.projectHasNativeWork(f.projectId)).toBe(false)
    const explain = (table: string) => {
      const query = queries.find((item) => item.query.includes(`EXISTS (SELECT 1 FROM "${table}"`))
      if (!query) throw new Error('Production native-work query was not observed.')
      return sqlite.prepare(`EXPLAIN QUERY PLAN ${query.query}`).all(...query.params)
    }
    const runPlan = explain('agent_runs')
    const creationPlan = explain('native_rebuild_operations')
    expect(production.sessionHasNativeWork(f.sessionId)).toBe(false)
    const capturePlans = () =>
      queries
        .filter(
          (item) =>
            item.query.includes('agent_runs') || item.query.includes('native_rebuild_operations'),
        )
        .map((item) => ({
          query: item.query,
          plan: sqlite.prepare(`EXPLAIN QUERY PLAN ${item.query}`).all(...item.params),
          rows: sqlite.prepare(item.query).all(...item.params).length,
        }))
    const partialStats = () =>
      sqlite
        .prepare<unknown[], { name: string; cells: number; bytes: number }>(
          `SELECT name, sum(ncell) AS cells, sum(pgsize) AS bytes FROM dbstat WHERE name IN ('agent_runs_session_unsettled_work_idx','native_rebuild_operations_unsettled_work_idx','agent_runs_native_generation_latest_idx') GROUP BY name ORDER BY name`,
        )
        .all()
    const before = capturePlans(),
      beforeStats = partialStats()
    seedSettled(900)
    queries.length = 0
    expect(production.projectHasNativeWork(f.projectId)).toBe(false)
    expect(production.sessionHasNativeWork(f.sessionId)).toBe(false)
    const after = capturePlans(),
      afterStats = partialStats()
    expect(after).toEqual(before)
    expect(
      after.every(
        (item) =>
          !JSON.stringify(item.plan).match(/SCAN (agent_runs|native_rebuild_operations)\b/u),
      ),
    ).toBe(true)
    expect(
      after
        .filter((item) => item.query.includes('FROM "agent_runs"'))
        .every((item) =>
          JSON.stringify(item.plan).includes('agent_runs_session_unsettled_work_idx'),
        ),
    ).toBe(true)
    expect(
      after
        .filter((item) => item.query.includes('FROM "native_rebuild_operations"'))
        .every((item) =>
          JSON.stringify(item.plan).includes('native_rebuild_operations_unsettled_work_idx'),
        ),
    ).toBe(true)
    expect(afterStats.filter((item) => item.name.endsWith('_unsettled_work_idx'))).toEqual(
      beforeStats.filter((item) => item.name.endsWith('_unsettled_work_idx')),
    )
    expect(
      afterStats.find((item) => item.name === 'agent_runs_native_generation_latest_idx')!.cells,
    ).toBeGreaterThan(
      beforeStats.find((item) => item.name === 'agent_runs_native_generation_latest_idx')!.cells,
    )
    expect(JSON.stringify(runPlan)).toContain('agent_runs_session_unsettled_work_idx')
    expect(JSON.stringify(creationPlan)).toContain('native_rebuild_operations_unsettled_work_idx')
    expect(JSON.stringify(runPlan)).toContain('sessions_project_native_work_idx')
    expect(JSON.stringify(creationPlan)).toContain('sessions_project_native_work_idx')
    expect(JSON.stringify(runPlan)).not.toContain('SCAN r')
    expect(JSON.stringify(creationPlan)).not.toContain('SCAN r')
    expect(f.repo.diagnostics().completeReads).toBe(0)
  } finally {
    f.db.close()
  }
})

it.each([
  { status: 'running', control: 'retained', effects: 'settled', expected: true },
  { status: 'running', control: 'abandoned', effects: 'settled', expected: false },
  { status: 'failed', control: 'abandoned', effects: 'unknown', expected: true },
  { status: 'completed', control: 'retained', effects: 'pending', expected: true },
  { status: 'completed', control: 'retained', effects: 'settled', expected: false },
] as const)(
  'keeps native-work gate semantics for $status/$control/$effects',
  async ({ status, control, effects, expected }) => {
    const f = await fixture()
    try {
      const run = start(f).run
      f.db.drizzle
        .update(agentRuns)
        .set({ status, controlDisposition: control, nativeEffectsState: effects })
        .where(eq(agentRuns.id, run.id))
        .run()
      expect(f.repo.sessionHasNativeWork(f.sessionId)).toBe(expected)
      expect(f.repo.projectHasNativeWork(f.projectId)).toBe(expected)
    } finally {
      f.db.close()
    }
  },
)

it('excludes inherited Fork Runs from both native-work gates even when their historical state is active', async () => {
  const f = await fixture()
  try {
    const source = start(f).run
    f.repo.failRun(source.id, 'agent_process_crash', 'Never dispatched', false)
    f.db.drizzle
      .insert(agentRuns)
      .values({
        id: randomUUID(),
        sessionId: f.sessionId,
        userMessageId: source.userMessageId,
        agentId: 'codex',
        forkSourceRunId: source.id,
        status: 'running',
        nativeEffectsState: 'unknown',
        settingsRevision: 1,
        attemptCount: 1,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      })
      .run()
    expect(f.repo.sessionHasNativeWork(f.sessionId)).toBe(false)
    expect(f.repo.projectHasNativeWork(f.projectId)).toBe(false)
  } finally {
    f.db.close()
  }
})

it.each(['pending', 'unknown', 'settled'] as const)(
  'retains the Rebuild native-work branch for %s work',
  async (state) => {
    const f = await fixture()
    try {
      const creation = seed(f)
      f.db.drizzle
        .update(nativeRebuildOperations)
        .set({ nativeWorkState: state })
        .where(eq(nativeRebuildOperations.id, creation.id))
        .run()
      expect(f.repo.sessionHasNativeWork(f.sessionId)).toBe(state !== 'settled')
      expect(f.repo.projectHasNativeWork(f.projectId)).toBe(state !== 'settled')
    } finally {
      f.db.close()
    }
  },
)

it('offers a first Retry after observation loss and upgrades only an unsuccessful explicit check', async () => {
  const f = await fixture()
  try {
    const run = start(f).run
    f.repo.applyEvent(f.sessionId, run.id, {
      type: 'session.started',
      agentId: 'codex',
      nativeSessionId: 'native-lost-ack',
    })
    f.repo.recordDispatch(run.id, 'possibly_sent', 'native-lost-ack', randomUUID())
    f.repo.recordNativeEvidence(evidenceFor(f, run.id, 'no_evidence'), 'retry')
    f.repo.observationUnavailable(run.id, 'Transport lost')
    expect(f.repo.nativeContext(f.sessionId, 'codex')?.recoveryAction).toBe('retry')
    f.repo.recordNativeEvidence(evidenceFor(f, run.id, 'no_evidence'))
    expect(f.repo.nativeContext(f.sessionId, 'codex')?.recoveryAction).toBe('rebuild')
    f.repo.recordNativeEvidence(evidenceFor(f, run.id, 'no_evidence'), 'retry')
    expect(f.repo.nativeContext(f.sessionId, 'codex')?.recoveryAction).toBe('rebuild')
    expect(f.repo.findRun(run.id)?.dispatchPhase).toBe('possibly_sent')
    expect(f.repo.findRun(run.id)?.nativeOutcome).toBeUndefined()
  } finally {
    f.db.close()
  }
})
