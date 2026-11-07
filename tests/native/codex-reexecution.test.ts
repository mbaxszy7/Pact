/* oxlint-disable vitest/no-conditional-expect -- Materialized and fresh real native Sessions have different supported boundaries. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { randomUUID } from 'node:crypto'
import { join, resolve as resolvePath } from 'node:path'
import { expect, it } from 'vitest'

import type { AgentRunInput } from '../../packages/agent-runtime/src/index.js'
import type {
  ConfirmedUnsentBoundary,
  FrozenExecutionEnvelope,
  RunEffectiveExecutionSettings,
} from '../../packages/contracts/src/index.js'

import { restoreExecutionInput } from '../../apps/desktop/src/utility/conversation/execution-input.js'
import { serializeAgentPromptEnvelope } from '../../packages/agent-runtime/src/index.js'
import { PactDatabase } from '../../packages/persistence/src/pact-database.js'
import {
  agentRuns,
  conversationMessages,
  runReexecutionOperations,
} from '../../packages/persistence/src/schema/index.js'
import {
  buildAdapters,
  cleanupNativeFixture,
  executable,
  isolatedEnv,
  LoopbackProvider,
  ownedRoot,
  type NativeAdapter,
} from './native-harness.js'

type Identity = { executorId: string; nativeSessionId: string }
type RootFrame = {
  id: number
  params: Record<string, unknown>
}

/** Observe the real pipe, forwarding every byte and overload argument unchanged. */
function observeRootWrites(child: ChildProcessWithoutNullStreams, roots: RootFrame[]): void {
  const write = child.stdin.write.bind(child.stdin),
    decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = '',
    bytes = 0,
    frames = 0
  child.stdin.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const encoded = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    bytes += encoded.byteLength
    if (bytes > 1024 * 1024) throw new Error('Owned RPC observation exceeds 1 MiB')
    pending += decoder.decode(encoded, { stream: true })
    if (pending.length > 256 * 1024) throw new Error('Owned RPC frame exceeds 256 KiB')
    for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (++frames > 128) throw new Error('Owned RPC observation exceeds 128 frames')
      const frame: unknown = JSON.parse(line)
      if (!frame || typeof frame !== 'object' || Reflect.get(frame, 'method') !== 'turn/start')
        continue
      const id: unknown = Reflect.get(frame, 'id'),
        params: unknown = Reflect.get(frame, 'params')
      if (typeof id !== 'number' || !params || typeof params !== 'object' || Array.isArray(params))
        throw new Error('The observed native root frame has no exact request identity')
      if (roots.length >= 2) throw new Error('Owned root write observation exceeds two attempts')
      roots.push({ id, params: Object.fromEntries(Object.entries(params)) })
    }
    return typeof encodingOrCallback === 'string'
      ? write(chunk, encodingOrCallback, callback)
      : write(chunk, encodingOrCallback)
  }
}

async function* executionBytes(envelope: FrozenExecutionEnvelope) {
  yield new TextEncoder().encode(JSON.stringify(envelope))
}

// oxlint-disable vitest/no-conditional-expect -- Materialized and fresh real native Sessions have different supported boundaries.
async function verifyNativeReplacement(materialized: boolean): Promise<void> {
  const owned = await ownedRoot(),
    provider = new LoopbackProvider([
      ...(materialized ? ['NATIVE_PRIOR_COMPLETED_BASELINE_REPLY'] : []),
      'NATIVE_CONFIRMED_UNSENT_REPLACEMENT_REPLY',
    ]),
    adapters: NativeAdapter[] = [],
    roots: RootFrame[] = [],
    effectiveReceipts: Array<{
      runId: string
      settings: RunEffectiveExecutionSettings
      identity: Identity
    }> = [],
    unsentReceipts: Array<{
      runId: string
      boundary: ConfirmedUnsentBoundary
      identity: Identity
    }> = []
  const controller = new AbortController(),
    deadlineAt = performance.now() + 45_000,
    deadline = setTimeout(() => controller.abort(), 45_000)
  let db: PactDatabase | undefined,
    spawns = 0,
    nativeClosed = false,
    originalDispatchAttempts = 0,
    replacementDispatchAttempts = 0
  try {
    await provider.start()
    await provider.configureCodex(owned.home)
    const binary = await executable('codex', owned, deadlineAt),
      bundle = await buildAdapters(owned.root),
      env = isolatedEnv(owned.root, owned.home)
    const adapter = new bundle.CodexAgentAdapter(
      binary,
      async (cwd) => {
        if (++spawns !== 1)
          throw new Error('Replacement attempted to create another native executor')
        const handle = await owned.processes.spawnOwnedAsync(
          binary,
          ['app-server'],
          { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
          deadlineAt,
        )
        observeRootWrites(handle.child, roots)
        handle.child.once('close', () => {
          nativeClosed = true
        })
        return handle
      },
      { storageRoot: owned.home },
    )
    adapters.push(adapter)
    db = await PactDatabase.open({
      filePath: join(owned.root, 'confirmed-unsent.sqlite'),
      migrationsFolder: resolvePath(import.meta.dirname, '../../packages/persistence/drizzle'),
    })
    const repo = db.conversationRepository,
      sessionId = randomUUID(),
      projectId = randomUUID(),
      nativeGeneration = randomUUID(),
      createdAt = new Date().toISOString()
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Owned native unsent fixture',
      directoryPath: owned.cwd,
      kind: 'directory',
      createdAt,
    })
    db.sessionRepository.create(
      { id: sessionId, projectId, title: 'Owned native unsent fixture', createdAt },
      {
        primaryAgentId: 'codex',
        agents: {
          codex: { model: null, effort: null, speed: 'standard' },
          claude: { model: null, effort: null },
        },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      },
    )
    db.sessionRepository.savePermission({
      sessionId,
      agentId: 'codex',
      mode: 'full',
      expectedRevision: 1,
      confirmedFullAccess: true,
    })
    db.sessionRepository.saveSpeed({
      sessionId,
      agentId: 'codex',
      speed: 'standard',
      expectedRevision: 2,
    })
    repo.saveSchedulingSettings({ expectedRevision: 0, enabled: true })
    repo.writeRelayCredential({
      operation: 'save',
      nonce: randomUUID(),
      expectedRevision: 0,
      deadlineAt: Date.now() + 5000,
      ciphertext: Buffer.from('synthetic fixture ciphertext').toString('base64'),
    })
    repo.beginSchedulingRecoveryEpoch(randomUUID())
    const settingsRevision = db.sessionRepository.find(sessionId)!.settingsRevision,
      baselineTurns = materialized ? 1 : 0
    if (materialized) {
      const prior = repo.beginRun({
          sessionId,
          clientMessageId: randomUUID(),
          content: 'Materialize this owned baseline Session. Do not use tools.',
          commentIds: [],
          expectedCommentsRevision: 0,
          agentId: 'codex',
          settingsRevision,
          model: null,
          effort: null,
        }).run,
        priorGeneration = randomUUID()
      for await (const event of adapter.run(
        {
          runId: prior.id,
          sessionId,
          cwd: owned.cwd,
          model: null,
          effort: null,
          speed: 'standard',
          permissionMode: 'full',
          nativeGeneration: priorGeneration,
          bindingGeneration: prior.bindingGeneration ?? 1,
          peerAssistanceAllowed: false,
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId,
            message: {
              id: prior.userMessageId,
              content: 'Materialize this owned baseline Session. Do not use tools.',
            },
            comments: [],
          },
          recordExecutor: (executorId) => repo.recordExecutor(prior.id, executorId),
          recordDispatch: (phase, nativeSessionId, executorId) =>
            repo.recordDispatch(prior.id, phase, nativeSessionId, executorId),
          recordNativeEvidence: (evidence) => repo.recordNativeEvidence(evidence),
          reportNativeEffects: (report) =>
            repo.recordNativeEffects(prior.id, report.state, report.reason),
        },
        controller.signal,
      ))
        repo.applyEvent(sessionId, prior.id, event)
      expect(repo.findRun(prior.id)).toMatchObject({
        status: 'completed',
        nativeEffectsState: 'settled',
      })
      expect(repo.nativeContext(sessionId, 'codex')?.continuationState).toBe('ready')
      expect(roots).toHaveLength(1)
      expect(provider.requests).toHaveLength(1)
      expect(adapter.hasActiveBackgroundWork()).toBe(false)
    }
    const originalNativeSessionId = repo.nativeContext(sessionId, 'codex')?.nativeSessionId,
      drafts = repo.readPage({ scope: 'drafts', sessionId })
    if (drafts.scope !== 'drafts') throw new Error('Expected authoritative draft revision')
    const content =
        'Exact frozen user input 🧭\nReturn only the owned fixture answer. Do not use tools.',
      original = repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content,
        commentIds: [],
        expectedCommentsRevision: drafts.commentsRevision,
        agentId: 'codex',
        settingsRevision,
        model: null,
        effort: null,
      }).run,
      envelope: FrozenExecutionEnvelope = {
        version: 'pact-agent-prompt-v1',
        sessionId,
        message: { id: original.userMessageId, content },
        comments: [],
        inputBatchRef: repo.inputBatchForRun(original.id)!,
      },
      captured = await repo.captureExecutionInput({
        runId: original.id,
        nativeGeneration,
        requested: {
          provider: 'codex',
          model: null,
          effort: null,
          permissionMode: 'full',
          speed: 'standard',
        },
        source: executionBytes(envelope),
        signal: controller.signal,
      })
    if (!captured) throw new Error('The authoritative immutable input was not admitted')

    const recovery = (runId: string): NonNullable<AgentRunInput['recovery']> => ({
      inputSha256: captured.inputSha256,
      recordEffectiveSettings: (settings, identity) => {
        effectiveReceipts.push({ runId, settings, identity })
        // A replacement compares against the original immutable receipt. It does
        // not capture a second mutable description of that original input.
        if (runId === original.id)
          repo.recordEffectiveExecutionSettings(runId, nativeGeneration, settings, identity)
      },
      recordConfirmedUnsent: (boundary, identity) => {
        unsentReceipts.push({ runId, boundary, identity })
        repo.recordConfirmedUnsent(runId, nativeGeneration, boundary, identity)
      },
    })
    const input = (runId: string): AgentRunInput => ({
      runId,
      sessionId,
      cwd: owned.cwd,
      model: null,
      effort: null,
      permissionMode: 'full',
      speed: 'standard',
      nativeGeneration,
      bindingGeneration: original.bindingGeneration ?? 1,
      ...(originalNativeSessionId ? { nativeSessionId: originalNativeSessionId } : {}),
      peerAssistanceAllowed: false,
      promptEnvelope: restoreExecutionInput(
        repo.frozenExecutionEnvelope(original.id),
        () => {
          throw new Error('This ordinary native fixture contains no image capability')
        },
        undefined,
      ),
      recordExecutor: (executorId) => repo.recordExecutor(runId, executorId),
      recordNativeEvidence: (evidence) => repo.recordNativeEvidence(evidence),
      reportNativeEffects: (report) => {
        expect(report.runId).toBe(runId)
        expect(report.generation).toBe(nativeGeneration)
        repo.recordNativeEffects(runId, report.state, report.reason)
      },
    })
    const run = async (value: AgentRunInput) => {
      for await (const event of adapter.run(value, controller.signal))
        repo.applyEvent(sessionId, value.runId, event)
    }
    await expect(
      run({
        ...input(original.id),
        recovery: recovery(original.id),
        recordDispatch: (phase, nativeSessionId, executorId) => {
          repo.recordDispatch(original.id, phase, nativeSessionId, executorId)
          if (phase !== 'possibly_sent') return
          originalDispatchAttempts++
          expect(roots).toHaveLength(baselineTurns)
          expect(provider.requests).toHaveLength(baselineTurns)
          // The genuine writer invokes this durable callback before sink.write.
          // No native reply or native file is changed by this controlled fault.
          repo.recordDispatch(original.id, 'rejected', nativeSessionId, executorId)
          throw new Error('Injected owned pre-write transport interruption')
        },
      }),
    ).rejects.toMatchObject({ kind: 'protocol_error' })
    expect(effectiveReceipts).toHaveLength(1)
    const actual = effectiveReceipts[0]!
    expect(actual.settings).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.4',
      effort: { known: true, value: 'high' },
      permissionMode: 'full',
      speed: 'standard',
      provenance: 'codex_thread_configuration',
    })
    expect(unsentReceipts).toHaveLength(1)
    expect(unsentReceipts[0]).toMatchObject({
      runId: original.id,
      boundary: { kind: 'codex_root_frame_not_written', requestId: expect.any(Number) },
      identity: actual.identity,
    })
    expect(repo.executionInput(original.id)?.proof).toMatchObject({
      ...actual.identity,
      inputSha256: captured.inputSha256,
      boundary: unsentReceipts[0]!.boundary,
    })
    expect(roots).toHaveLength(baselineTurns)
    expect(provider.requests).toHaveLength(baselineTurns)
    expect(adapter.hasActiveBackgroundWork()).toBe(false)
    expect(nativeClosed).toBe(false)
    expect(repo.findRun(original.id)).toMatchObject({
      dispatchPhase: 'rejected',
      nativeEffectsState: 'settled',
    })
    repo.failRun(original.id, 'protocol_error', 'Injected owned pre-write transport interruption')
    repo.setContinuation(sessionId, 'codex', 'ready', undefined, original.bindingGeneration ?? 1)
    repo.armSchedulingRecoveryFaults(sessionId)
    const candidate = repo
      .takeSchedulingRecoveryFaults()
      .find((row) => row.fault.runId === original.id)
    if (!candidate) throw new Error('The physical-unsent original fault was not retained')
    const operation = {
        operationId: randomUUID(),
        faultId: candidate.fault.id,
        handoff: repo.recoveryHandoff({ kind: 'run', id: original.id }),
      },
      admitted = repo.beginConfirmedUnsentReexecution(operation),
      replacement = admitted.run
    expect(admitted.created).toBe(true)
    expect(replacement.id).not.toBe(original.id)
    expect(replacement).toMatchObject({
      userMessageId: original.userMessageId,
      reexecutedFromRunId: original.id,
      nativeSessionId: actual.identity.nativeSessionId,
      permissionMode: 'full',
      speed: 'standard',
    })
    expect(repo.beginConfirmedUnsentReexecution(operation)).toMatchObject({
      created: false,
      run: { id: replacement.id },
    })
    expect(repo.schedulingBudget(`input:${original.userMessageId}`)?.automaticResends).toBe(1)
    expect(repo.canDispatchReexecution(replacement.id)).toBe(true)
    const replacementAttempt = run({
      ...input(replacement.id),
      nativeSessionId: actual.identity.nativeSessionId,
      recovery: {
        ...recovery(replacement.id),
        expected: { settings: actual.settings, ...actual.identity },
        canDispatch: () => repo.canDispatchReexecution(replacement.id),
      },
      recordDispatch: (phase, nativeSessionId, executorId) => {
        if (phase === 'possibly_sent') replacementDispatchAttempts++
        repo.recordDispatch(replacement.id, phase, nativeSessionId, executorId)
      },
    })
    if (!materialized) {
      await expect(replacementAttempt).rejects.toMatchObject({
        kind: 'context_resume_failed',
        message: expect.stringContaining('no rollout found for thread id'),
      })
      repo.failRun(
        replacement.id,
        'context_resume_failed',
        'The genuine fresh native Thread has no rollout',
      )
      expect(effectiveReceipts).toHaveLength(1)
      expect(roots).toHaveLength(0)
      expect(provider.requests).toHaveLength(0)
      expect(provider.errors).toEqual([])
      expect(replacementDispatchAttempts).toBe(0)
      expect(originalDispatchAttempts).toBe(1)
      expect(unsentReceipts).toHaveLength(1)
      expect(spawns).toBe(1)
      expect(nativeClosed).toBe(false)
      expect(adapter.hasActiveBackgroundWork()).toBe(false)
      expect(repo.findRun(replacement.id)).toMatchObject({
        status: 'failed',
        failureKind: 'context_resume_failed',
        dispatchPhase: 'rejected',
      })
      expect(repo.canDispatchReexecution(replacement.id)).toBe(false)
      expect(repo.schedulingBudget(`input:${original.userMessageId}`)?.automaticResends).toBe(1)
      expect(() =>
        repo.beginConfirmedUnsentReexecution({ ...operation, operationId: randomUUID() }),
      ).toThrow(/one replacement/u)
      console.info(
        '[native fresh-thread limitation]',
        JSON.stringify({
          originalRootWrites: 0,
          replacementRootWrites: 0,
          modelRequests: 0,
          nativeRejection: 'no rollout found',
          executorCount: spawns,
          automaticResends: 1,
        }),
      )
      return
    }
    await replacementAttempt
    expect(effectiveReceipts).toHaveLength(2)
    expect(effectiveReceipts[1]).toEqual({
      runId: replacement.id,
      settings: actual.settings,
      identity: actual.identity,
    })
    expect(roots).toHaveLength(baselineTurns + 1)
    const boundary = unsentReceipts[0]!.boundary
    if (boundary.kind !== 'codex_root_frame_not_written')
      throw new Error('Expected genuine Codex root proof')
    expect(roots[baselineTurns]!.id).not.toBe(boundary.requestId)
    expect(roots[baselineTurns]!.params).toMatchObject({
      threadId: actual.identity.nativeSessionId,
      clientUserMessageId: replacement.id,
      input: [
        {
          type: 'text',
          text: serializeAgentPromptEnvelope(input(original.id).promptEnvelope),
          text_elements: [],
        },
      ],
      serviceTierForTurn: 'default',
      collaborationMode: {
        mode: 'default',
        settings: { model: 'gpt-5.4', reasoning_effort: 'high' },
      },
    })
    expect(provider.requests).toHaveLength(baselineTurns + 1)
    expect(provider.requests[baselineTurns]).toMatchObject({
      method: 'POST',
      path: '/v1/responses',
    })
    expect(provider.errors).toEqual([])
    expect(originalDispatchAttempts).toBe(1)
    expect(replacementDispatchAttempts).toBe(1)
    expect(unsentReceipts).toHaveLength(1)
    expect(spawns).toBe(1)
    expect(nativeClosed).toBe(false)
    expect(adapter.hasActiveBackgroundWork()).toBe(false)
    expect(repo.findRun(replacement.id)).toMatchObject({
      status: 'completed',
      dispatchPhase: 'ended',
      nativeEffectsState: 'settled',
      executorId: actual.identity.executorId,
      nativeSessionId: actual.identity.nativeSessionId,
      userMessageId: original.userMessageId,
    })
    expect(repo.frozenExecutionEnvelope(original.id)).toEqual(envelope)
    expect(db.drizzle.select().from(agentRuns).all()).toHaveLength(baselineTurns + 2)
    expect(
      db.drizzle
        .select()
        .from(conversationMessages)
        .all()
        .filter((row) => row.role === 'user'),
    ).toHaveLength(baselineTurns + 1)
    expect(db.drizzle.select().from(runReexecutionOperations).all()).toHaveLength(1)
    expect(repo.schedulingBudget(`input:${original.userMessageId}`)?.automaticResends).toBe(1)
    expect(() =>
      repo.beginConfirmedUnsentReexecution({ ...operation, operationId: randomUUID() }),
    ).toThrow(/one replacement/u)
    console.info(
      '[native confirmed-unsent]',
      JSON.stringify({
        originalRootWrites: 0,
        originalModelRequests: 0,
        priorCompletedNativeTurns: baselineTurns,
        replacementRootWrites: roots.length - baselineTurns,
        replacementModelRequests: provider.requests.length - baselineTurns,
        sameExecutor: true,
        sameNativeSession: true,
        sameFrozenInput: true,
        sameEffectiveSettings: true,
        automaticResends: 1,
        fault: 'controlled_host_writer_callback_before_first_byte',
      }),
    )
  } finally {
    controller.abort()
    clearTimeout(deadline)
    try {
      for (const adapter of adapters) {
        // oxlint-disable-next-line no-await-in-loop -- SQLite stays open through actual native callback settlement.
        await adapter.dispose()
      }
    } finally {
      db?.close()
      await cleanupNativeFixture(owned, { adapters, provider })
    }
  }
}
// oxlint-enable vitest/no-conditional-expect

it('real Codex preserves one executor and exact frozen settings across one physically unsent replacement of an existing Session', async () => {
  await expect(verifyNativeReplacement(true)).resolves.toBeUndefined()
}, 60_000)

it('real Codex withholds a fresh unmaterialized Thread replacement after native resume rejection without a second executor or model call', async () => {
  await expect(verifyNativeReplacement(false)).resolves.toBeUndefined()
}, 60_000)
