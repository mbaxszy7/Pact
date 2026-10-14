import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  ConversationSnapshot,
  DesktopBridge,
  NativeAgentContext,
} from '../../packages/contracts/src/index.js'

import {
  authMarker,
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  restartRealWorkspace,
  selectRealSession,
  sendRealMessage,
  waitForRealCompletion,
  type RealWorkspace,
} from './real-harness.js'
import {
  findNativeRecord,
  readNativeEvidence,
  nativeByteLimit,
  type NativeEvidence,
} from './real-native-evidence.js'
import { test } from './runtime-fixture.js'

test(
  'real Fork preserves both Native histories and the source draft through cold initialization without a Model task',
  { tag: ['@real', '@real-core'] },
  async () => {
    test.setTimeout(600_000)
    const ctx = await launchRealWorkspace('real-fork-recovery')
    try {
      const sourceId = ctx.sessionId
      const sourceMarker = authMarker('FORK_SOURCE')
      await sendRealMessage(
        ctx,
        `Briefly acknowledge ${sourceMarker}. Do not use tools, read files or write files.`,
        'all',
      )
      const source = await waitForRealCompletion(ctx, 2)
      expect(source.runs.every((run) => run.status === 'completed')).toBe(true)
      expect(
        source.messages
          .filter((message) => message.role === 'assistant')
          .every((message) => message.content.includes(sourceMarker)),
      ).toBe(true)
      expect(source.nativeContexts.map((binding) => binding.agentId).toSorted()).toEqual([
        'claude',
        'codex',
      ])
      const sourceEvidence = await observeNativeEvidence(ctx, source)
      const sourceTasks = nativeInputs(sourceEvidence)
      expect(sourceTasks).toEqual({ claude: 1, codex: 1 })
      for (const agentId of ['claude', 'codex'] as const) {
        expect(sourceEvidence[agentId].containsText(sourceMarker)).toBe(true)
      }
      const lastAnswer = source.messages
        .filter((message) => message.role === 'assistant')
        .toSorted((left, right) => left.sequence - right.sequence)
        .at(-1)
      if (!lastAnswer) throw new Error('Real Fork source has no completed Agent reply')
      const sourceDraft = authMarker('UNSENT_SOURCE_DRAFT')
      const composer = ctx.page.getByRole('combobox', { name: 'Message', exact: true })
      await composer.fill(sourceDraft)
      const answer = ctx.page.locator(`[data-pact-message-id="${lastAnswer.id}"]`)
      await answer.hover()
      await answer.getByRole('button', { name: 'Fork conversation from this reply' }).click()
      const dialog = ctx.page.getByRole('dialog')
      await expect(dialog.getByRole('button', { name: 'Create fork', exact: true })).toBeEnabled({
        timeout: 45_000,
      })
      await dialog.getByRole('button', { name: 'Create fork', exact: true }).click()
      await expect(dialog).toHaveCount(0, { timeout: 120_000 })
      await expect(composer).toBeEnabled({ timeout: 120_000 })
      try {
        await expect.poll(() => composer.textContent()).toBe('')
      } catch (error) {
        if (process.platform === 'win32') {
          const boundary = await ctx.page.evaluate(
            async ({ projectId, sourceId: requestedSourceId }) => {
              const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
              const catalog = await bridge.getSessionCatalog(projectId)
              const child = catalog.ok
                ? catalog.value.sessions.find((row) => row.id !== requestedSourceId)
                : undefined
              return {
                selected: document
                  .querySelector('[data-session-menu]:has(button[data-selected="true"])')
                  ?.getAttribute('data-session-menu'),
                childId: child?.id,
                operation: child
                  ? await bridge.forkSession({ action: 'read', sessionId: child.id })
                  : null,
              }
            },
            { projectId: ctx.projectId, sourceId },
          )
          const path = test.info().outputPath('windows-fork-selection-boundary.json')
          await writeFile(path, ctx.fixture.redactDiagnostic(JSON.stringify(boundary)))
          await test.info().attach('windows-fork-selection-boundary', {
            path,
            contentType: 'application/json',
          })
        }
        throw error
      }
      await expect(ctx.page.getByRole('region', { name: 'Native fork confirmation' })).toHaveCount(
        0,
      )
      const childId = await ctx.page.evaluate(
        async ({ projectId, sourceSessionId }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const catalog = await bridge.getSessionCatalog(projectId)
          if (!catalog.ok || catalog.value.sessions.length !== 2) {
            throw new Error('Real Fork did not publish exactly one child Session')
          }
          const child = catalog.value.sessions.find((session) => session.id !== sourceSessionId)
          if (!child) throw new Error('Real Fork child is unavailable')
          return child.id
        },
        { projectId: ctx.projectId, sourceSessionId: sourceId },
      )
      const child = await readRealConversation(ctx, childId)
      expect(child.forkOperation).toMatchObject({
        sourceSessionId: sourceId,
        sourceMessageId: lastAnswer.id,
        ready: true,
      })
      expect(child.runs).toHaveLength(source.runs.length)
      expect(child.runs.every((run) => Boolean(run.forkSourceRunId))).toBe(true)
      expect(historyContent(child)).toEqual(historyContent(source))
      for (const agentId of ['claude', 'codex'] as const) {
        const childBinding = nativeBinding(child, agentId)
        expect(childBinding.nativeSessionId).not.toBe(
          nativeBinding(source, agentId).nativeSessionId,
        )
        expect(childBinding.continuationState).toBe('ready')
      }
      const childEvidence = await observeNativeEvidence(ctx, child)
      const childInputs = nativeInputs(childEvidence)
      // Codex's physical fork inherits history without copying task_started bookkeeping.
      // The private history must contain the real source reply while initialization adds no task.
      expect(childInputs).toEqual({ claude: sourceTasks.claude, codex: 0 })
      const nativeReader = await ctx.fixture.openCodexClient()
      const nativeRead = await nativeReader.request('thread/read', {
        threadId: nativeBinding(child, 'codex').nativeSessionId,
        includeTurns: true,
      })
      expect(nativeRead.error).toBeUndefined()
      const effectiveCodexHistory = JSON.stringify(nativeRead.result)
      expect(Buffer.byteLength(effectiveCodexHistory)).toBeLessThanOrEqual(nativeByteLimit)
      await nativeReader.close()
      for (const agentId of ['claude', 'codex'] as const) {
        const sourceAnswer = source.messages.find(
          (message) => message.role === 'assistant' && message.agentId === agentId,
        )
        if (!sourceAnswer) throw new Error('Completed real Native source reply is unavailable')
        expect(
          agentId === 'codex'
            ? effectiveCodexHistory.includes(sourceMarker)
            : childEvidence[agentId].containsText(sourceMarker),
          `Actual ${agentId} Native fork must contain its source marker`,
        ).toBe(true)
        // One visible reply can join several native assistant items. Each complete paragraph
        // must survive, while native record boundaries remain intact.
        const paragraphs = sourceAnswer.content.split('\n\n').filter(Boolean)
        expect(paragraphs.length).toBeGreaterThan(0)
        for (const paragraph of paragraphs)
          expect(
            agentId === 'codex'
              ? effectiveCodexHistory.includes(JSON.stringify(paragraph).slice(1, -1))
              : childEvidence[agentId].containsText(paragraph),
          ).toBe(true)
        expect(childEvidence[agentId].containsText(sourceDraft)).toBe(false)
      }
      const sourceAfterFork = await observeNativeEvidence(
        ctx,
        await readRealConversation(ctx, sourceId),
      )
      expect(nativeInputs(sourceAfterFork)).toEqual(sourceTasks)
      expect(nativeHashes(sourceAfterFork)).toEqual(nativeHashes(sourceEvidence))
      await selectRealSession(ctx, sourceId)
      await expect.poll(() => composer.textContent()).toBe(sourceDraft)
      await selectRealSession(ctx, childId)
      ctx.sessionId = childId
      await restartRealWorkspace(ctx)
      await expect(ctx.page.getByRole('combobox', { name: 'Message', exact: true })).toBeEnabled({
        timeout: 30_000,
      })
      const coldChild = await readRealConversation(ctx)
      expect(coldChild.forkOperation?.ready).toBe(true)
      for (const agentId of ['claude', 'codex'] as const) {
        expect(nativeBinding(coldChild, agentId)).toMatchObject({
          nativeSessionId: nativeBinding(child, agentId).nativeSessionId,
          continuationState: 'ready',
        })
      }
      expect(historyContent(coldChild)).toEqual(historyContent(source))
      expect(coldChild.runs.map((run) => run.id)).toEqual(child.runs.map((run) => run.id))
      expect(nativeInputs(await observeNativeEvidence(ctx, coldChild))).toEqual(childInputs)
      const branchMarker = authMarker('AUTHORIZED_FORK_TASK')
      await sendRealMessage(
        ctx,
        `Briefly acknowledge the new branch task ${branchMarker}. Do not use tools, read files or write files.`,
        'codex',
      )
      const completedChild = await waitForRealCompletion(ctx, 3)
      const newRun = completedChild.runs.find((run) => !run.forkSourceRunId)
      expect(newRun).toMatchObject({ agentId: 'codex', status: 'completed' })
      expect(answerFor(completedChild, newRun?.id)).toContain(branchMarker)
      expect(nativeInputs(await observeNativeEvidence(ctx, completedChild))).toEqual({
        claude: childInputs.claude,
        codex: childInputs.codex + 1,
      })
      const untouchedSource = await readRealConversation(ctx, sourceId)
      expect(historyContent(untouchedSource)).toEqual(historyContent(source))
      expect(untouchedSource.runs.map((run) => run.id)).toEqual(source.runs.map((run) => run.id))
      expect(
        untouchedSource.messages.some((message) => message.content.includes(branchMarker)),
      ).toBe(false)
      const sourceAfterBranch = await observeNativeEvidence(ctx, untouchedSource)
      expect(nativeInputs(sourceAfterBranch)).toEqual(sourceTasks)
      expect(nativeHashes(sourceAfterBranch)).toEqual(nativeHashes(sourceEvidence))
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

test(
  'real Retry inspection of a moved Native record keeps the draft read-only and rebuilds once without replay',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(600_000)
    const ctx = await launchRealWorkspace('real-missing-native-record')
    try {
      const marker = authMarker('COMPLETED_BEFORE_NATIVE_LOSS')
      await sendRealMessage(
        ctx,
        `Briefly acknowledge ${marker}. Do not use tools, read files or write files.`,
        'codex',
      )
      const completed = await waitForRealCompletion(ctx, 1)
      expect(answerFor(completed, completed.runs[0]?.id)).toContain(marker)
      const oldBinding = nativeBinding(completed, 'codex')
      const oldRun = completed.runs[0]
      if (!oldRun) throw new Error('Completed real Native Run is unavailable')
      await ctx.app.close()
      const original = await findNativeRecord(ctx, 'codex', oldBinding.nativeSessionId)
      const backupDirectory = join(ctx.fixture.directory, 'native-recovery-evidence')
      await mkdir(backupDirectory, { mode: 0o700 })
      const backup = join(backupDirectory, `${oldBinding.nativeSessionId}.jsonl`)
      await rename(original.path, backup)
      expect((await readNativeEvidence(backup)).sha256).toBe(original.sha256)
      ctx.app = await ctx.fixture.launch()
      ctx.page = await ctx.app.firstWindow()
      await selectRealSession(ctx, ctx.sessionId)
      const composer = ctx.page.getByRole('combobox', { name: 'Message', exact: true })
      const draft = authMarker('PRESERVED_RECOVERY_DRAFT')
      await expect(composer).toBeEnabled()
      await composer.fill(draft)
      // A healthy persisted binding is not polled on startup. The explicit Retry inspection
      // asks the real CLI to establish loss before testing the read-only Send gate.
      const inspected = await ctx.page.evaluate(
        async ({ sessionId, runId }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.retryConversationRun(runId, {
            sessionId,
            agentId: 'codex',
            intent: 'inspect',
          })
        },
        { sessionId: ctx.sessionId, runId: oldRun.id },
      )
      // Missing is a negative RPC result carrying the published recovery projection;
      // it confirms that the real CLI could not resume this identity, not a Model failure.
      expect(inspected).toMatchObject({
        ok: false,
        error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
      })
      const recovery = ctx.page.getByRole('region', { name: 'Session recovery' })
      await expect(recovery.getByRole('button', { name: 'Rebuild…', exact: true })).toBeVisible({
        timeout: 30_000,
      })
      await expect(composer).toBeDisabled()
      await expect.poll(() => composer.textContent()).toBe(draft)
      await expect(
        ctx.page.getByRole('button', { name: 'Send message', exact: true }),
      ).toBeDisabled()
      const refused = await ctx.page.evaluate(
        async ({ sessionId, content, clientMessageId }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.sendConversationMessage({
            sessionId,
            content,
            clientMessageId,
            commentIds: [],
            expectedCommentsRevision: 0,
            route: { type: 'agent', agentId: 'codex' },
          })
        },
        { sessionId: ctx.sessionId, content: draft, clientMessageId: randomUUID() },
      )
      expect(refused).toMatchObject({
        ok: false,
        error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
      })
      const missing = await readRealConversation(ctx)
      expect(missing.runs.map((run) => run.id)).toEqual(completed.runs.map((run) => run.id))
      expect(nativeBinding(missing, 'codex')).toMatchObject({
        nativeSessionId: oldBinding.nativeSessionId,
        continuationState: 'recovery_required',
      })
      await recovery.getByRole('button', { name: 'Rebuild…', exact: true }).click()
      await expect(
        recovery.getByRole('button', { name: 'Confirm rebuild', exact: true }),
      ).toBeEnabled()
      expect((await readRealConversation(ctx)).runs.map((run) => run.id)).toEqual(
        completed.runs.map((run) => run.id),
      )
      await recovery.getByRole('button', { name: 'Confirm rebuild', exact: true }).click()
      await expect(ctx.page.getByText('Codex native session rebuilt', { exact: true })).toBeVisible(
        {
          timeout: 120_000,
        },
      )
      await expect(composer).toBeEnabled()
      await expect.poll(() => composer.textContent()).toBe(draft)
      const rebuilt = await readRealConversation(ctx)
      const binding = nativeBinding(rebuilt, 'codex')
      expect(binding.nativeSessionId).not.toBe(oldBinding.nativeSessionId)
      expect(binding.bindingGeneration).toBe((oldBinding.bindingGeneration ?? 1) + 1)
      expect(binding.continuationState).toBe('ready')
      expect(binding.rebuildMessageCount).toBe(completed.messages.length)
      expect(rebuilt.runs.map((run) => run.id)).toEqual(completed.runs.map((run) => run.id))
      expect(
        rebuilt.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.content),
      ).toEqual(
        completed.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.content),
      )
      expect(
        rebuilt.messages.filter((message) => message.content === 'Codex native session rebuilt'),
      ).toHaveLength(1)
      const newEvidence = await findNativeRecord(ctx, 'codex', binding.nativeSessionId)
      expect(newEvidence.codexModelStarts).toBe(0)
      const operation = binding.rebuildOperation
      if (!operation || operation.stage !== 'completed')
        throw new Error('Completed real rebuild receipt is unavailable')
      const nonce = {
        sessionId: ctx.sessionId,
        agentId: 'codex' as const,
        intent: 'create' as const,
        clientOperationId: operation.id,
        expectedGeneration: operation.oldGeneration,
      }
      const duplicate = await ctx.page.evaluate(async (input) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.rebuildNativeContext(input)
      }, nonce)
      expect(duplicate.ok).toBe(true)
      await restartRealWorkspace(ctx)
      const cold = await readRealConversation(ctx)
      expect(nativeBinding(cold, 'codex')).toMatchObject({
        nativeSessionId: binding.nativeSessionId,
        bindingGeneration: binding.bindingGeneration,
        continuationState: 'ready',
      })
      expect(cold.runs.map((run) => run.id)).toEqual(completed.runs.map((run) => run.id))
      const coldDuplicate = await ctx.page.evaluate(async (input) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.rebuildNativeContext(input)
      }, nonce)
      expect(coldDuplicate.ok).toBe(true)
      expect(nativeBinding(await readRealConversation(ctx), 'codex').nativeSessionId).toBe(
        binding.nativeSessionId,
      )
      expect((await findNativeRecord(ctx, 'codex', binding.nativeSessionId)).codexModelStarts).toBe(
        0,
      )
      await expect(ctx.page.getByText('Codex native session rebuilt', { exact: true })).toHaveCount(
        1,
      )
      const authorizedMarker = authMarker('POST_REBUILD')
      await sendRealMessage(
        ctx,
        `Reply with this identifier exactly on one line: ${authorizedMarker}. Do not use tools, read files or write files.`,
        'codex',
      )
      const continued = await waitForRealCompletion(ctx, 2)
      expect(answerFor(continued, continued.runs.at(-1)?.id).replace(/\p{Cf}/gu, '')).toContain(
        authorizedMarker,
      )
      expect(continued.runs.at(-1)?.nativeSessionId).toBe(binding.nativeSessionId)
      expect(
        continued.messages.filter(
          (message) => message.role === 'user' && message.content.includes(marker),
        ),
      ).toHaveLength(1)
      expect((await findNativeRecord(ctx, 'codex', binding.nativeSessionId)).codexModelStarts).toBe(
        1,
      )
      expect((await readNativeEvidence(backup)).sha256).toBe(original.sha256)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

function nativeBinding(
  snapshot: ConversationSnapshot,
  agentId: 'claude' | 'codex',
): NativeAgentContext {
  const binding = snapshot.nativeContexts.find((entry) => entry.agentId === agentId)
  if (!binding) throw new Error(`Real ${agentId} Native binding is unavailable`)
  return binding
}

function historyContent(snapshot: ConversationSnapshot) {
  return snapshot.messages.map(({ role, agentId, content, state }) => ({
    role,
    agentId,
    content,
    state,
  }))
}

function answerFor(snapshot: ConversationSnapshot, runId: string | undefined): string {
  const answer = snapshot.messages.find(
    (message) => message.role === 'assistant' && message.runId === runId,
  )
  if (!runId || !answer || answer.state !== 'complete')
    throw new Error('Completed real Agent reply is unavailable')
  return answer.content
}

async function observeNativeEvidence(ctx: RealWorkspace, snapshot: ConversationSnapshot) {
  const [claude, codex] = await Promise.all([
    findNativeRecord(ctx, 'claude', nativeBinding(snapshot, 'claude').nativeSessionId),
    findNativeRecord(ctx, 'codex', nativeBinding(snapshot, 'codex').nativeSessionId),
  ])
  return { claude, codex }
}

function nativeInputs(evidence: { claude: NativeEvidence; codex: NativeEvidence }) {
  return { claude: evidence.claude.claudeUserInputs, codex: evidence.codex.codexModelStarts }
}

function nativeHashes(evidence: { claude: NativeEvidence; codex: NativeEvidence }) {
  return { claude: evidence.claude.sha256, codex: evidence.codex.sha256 }
}
