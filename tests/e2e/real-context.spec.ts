import { expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'

import type { ConversationSnapshot, DesktopBridge } from '../../packages/contracts/src/index.js'

import {
  MAX_COMMENTS_PER_MESSAGE,
  MESSAGE_ANCHOR_TEXT_BASIS,
} from '../../packages/contracts/src/index.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import {
  addRealSession,
  authMarker,
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  selectRealSession,
  sendRealMessage,
  waitForRealCompletion,
  type RealWorkspace,
} from './real-harness.js'
import { findNativeRecord, nativeByteLimit } from './real-native-evidence.js'
import { test } from './runtime-fixture.js'
import {
  findWindowsOwnedAgentProcess,
  stopWindowsOwnedAgentProcess,
} from './windows-process-observation.js'

const executeFile = promisify(execFile)
const caseDeadlineMs = 600_000
const runItems = 8
const processItems = 32
const processDepth = 3
const processProbeDeadlineMs = 2_000

// CONTEXT_UNAVAILABLE remains a separate required obligation. Current Send
// maps only HandoffSourceUnavailableError to it: deadline/nonadvancing pages or
// a metadata-to-hydration revision race. Native file loss uses Native recovery;
// an ordinary SQLite I/O error maps to INTERNAL. No fabricated IPC refusal is
// used here to pretend that the unavailable-source obligation is complete.
test.describe('real evidence', { tag: '@real' }, () => {
  test('real explicit Claude request after peer failure never reruns Codex', async () => {
    test.setTimeout(caseDeadlineMs)
    const ctx = await launchRealWorkspace('real-failed-peer')
    try {
      const marker = authMarker('REAL_PEER_SOURCE')
      await sendRealMessage(
        ctx,
        `Acknowledge ${marker}, then write 160 numbered short lines about typed boundaries without abbreviating the list. Do not use tools, read files or write files.`,
        'all',
      )
      const started = await waitForNativeText(ctx, 'claude').catch(async (error) => {
        const current = await readRealConversation(ctx)
        throw new Error(
          ctx.fixture.redactDiagnostic(
            JSON.stringify({
              observation:
                'The original peer response did not expose the required live-text window.',
              runs: current.runs.map((run) => ({
                agentId: run.agentId,
                status: run.status,
                dispatchPhase: run.dispatchPhase,
                nativeOutcome: run.nativeOutcome,
                nativeSessionId: run.nativeSessionId,
                nativeTurnId: run.nativeTurnId,
                failureKind: run.failureKind,
                failureMessage: run.failureMessage,
              })),
              answers: current.messages
                .filter((message) => message.role === 'assistant')
                .map((message) => ({
                  agentId: message.agentId,
                  content: message.content.slice(0, 2000),
                })),
            }),
          ),
          { cause: error },
        )
      })
      const owned = await findOwnedAgentProcess(ctx, 'claude')
      await terminateOwnedAgent(ctx, owned)
      const failed = await waitForFailure(ctx, 'claude', 2)
      const primary = failed.runs.find((run) => run.agentId === 'codex')
      const peer = failed.runs.find((run) => run.id === started.id)
      expect(primary).toMatchObject({ agentId: 'codex', status: 'completed' })
      expect(peer).toMatchObject({
        agentId: 'claude',
        status: 'interrupted',
        failureKind: 'transient_transport',
      })
      if (!primary?.nativeSessionId || !peer?.nativeSessionId)
        throw new Error('Authentic primary/failed-peer identities are unavailable')
      expect(answerFor(failed, primary.id)).toContain(marker)
      expect((await findNativeRecord(ctx, 'codex', primary.nativeSessionId)).codexModelStarts).toBe(
        1,
      )
      await expect(ctx.page.getByRole('button', { name: 'Reexecute…', exact: true })).toHaveCount(0)
      await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeDisabled()

      // SIGKILL does not prove a Native Turn ending. Preserve the actual Native
      // file, close every owned executor, then let real Retry establish that the
      // old identity is unavailable before an explicit confirmed Rebuild.
      await ctx.app.close()
      const preserved = await preserveOwnedClaudeHistory(ctx, peer.nativeSessionId)
      ctx.app = await ctx.fixture.launch()
      ctx.page = await ctx.app.firstWindow()
      await selectRealSession(ctx, ctx.sessionId)
      const inspected = await ctx.page.evaluate(
        async ({ sessionId, runId }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.retryConversationRun(runId, {
            sessionId,
            agentId: 'claude',
            intent: 'inspect',
          })
        },
        { sessionId: ctx.sessionId, runId: peer.id },
      )
      expect(inspected).toMatchObject({
        ok: false,
        error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
      })
      const recovery = ctx.page.getByRole('region', { name: 'Session recovery' })
      await expect(recovery.getByRole('button', { name: 'Rebuild…', exact: true })).toBeVisible({
        timeout: 30_000,
      })
      await recovery.getByRole('button', { name: 'Rebuild…', exact: true }).click()
      await expect(recovery).toContainText('previous task won’t be repeated')
      await recovery.getByRole('button', { name: 'Confirm rebuild', exact: true }).click()
      await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeEnabled({
        timeout: 120_000,
      })
      const rebuilt = await readRealConversation(ctx)
      expect(rebuilt.runs.map((run) => run.id)).toEqual(failed.runs.map((run) => run.id))
      expect(rebuilt.runs.find((run) => run.id === peer.id)?.failureKind).toBe(
        'transient_transport',
      )
      expect(
        rebuilt.nativeContexts.find((binding) => binding.agentId === 'codex')?.nativeSessionId,
      ).toBe(primary.nativeSessionId)
      const newClaude = rebuilt.nativeContexts.find((binding) => binding.agentId === 'claude')
      expect(newClaude?.continuationState).toBe('ready')
      expect(newClaude?.nativeSessionId).not.toBe(peer.nativeSessionId)
      if (!newClaude) throw new Error('Confirmed real Claude rebuild identity is missing')
      const beforeNewTask = await findNativeRecord(ctx, 'claude', newClaude.nativeSessionId)
      expect((await findNativeRecord(ctx, 'codex', primary.nativeSessionId)).codexModelStarts).toBe(
        1,
      )

      const newMarker = authMarker('ONLY_NEW_CLAUDE_TASK')
      await sendRealMessage(
        ctx,
        `Reply briefly acknowledging ${newMarker}. Do not use tools, read files or write files.`,
        'claude',
      )
      const completed = await waitForRealCompletion(ctx, 3, ctx.sessionId, [peer.id])
      expect(completed.runs.filter((run) => run.agentId === 'codex').map((run) => run.id)).toEqual([
        primary.id,
      ])
      const claudeRuns = completed.runs.filter((run) => run.agentId === 'claude')
      expect(claudeRuns).toHaveLength(2)
      const actualNew = claudeRuns.find((run) => run.id !== peer.id)
      expect(actualNew).toMatchObject({
        status: 'completed',
        nativeSessionId: newClaude.nativeSessionId,
      })
      expect(answerFor(completed, actualNew?.id)).toContain(newMarker)
      expect(completed.messages.filter((message) => message.role === 'user')).toHaveLength(2)
      expect((await findNativeRecord(ctx, 'codex', primary.nativeSessionId)).codexModelStarts).toBe(
        1,
      )
      expect(
        (await findNativeRecord(ctx, 'claude', newClaude.nativeSessionId)).claudeUserInputs,
      ).toBe(beforeNewTask.claudeUserInputs + 1)
      expect(await fileHash(preserved.path)).toBe(preserved.hash)
      await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeEnabled()
    } finally {
      await closeRealWorkspace(ctx)
    }
  })

  test('real large text exceeds the old Composer ceiling and preserves original Comments', async () => {
    test.setTimeout(caseDeadlineMs)
    const ctx = await launchRealWorkspace('real-context-size')
    try {
      const marker = authMarker('REAL_COMMENT_SOURCE')
      await sendRealMessage(
        ctx,
        `Reply briefly acknowledging ${marker}. Do not use tools, read files or write files.`,
        'codex',
      )
      const source = await waitForRealCompletion(ctx, 1)
      const user = source.messages.find((message) => message.role === 'user')
      if (!user) throw new Error('Actual accepted User Message source is missing')
      expect(user.content).toContain(marker)
      const offset = user.content.indexOf(marker)
      const contentHash = createHash('sha256').update(user.content).digest('hex')
      for (let index = 0; index < MAX_COMMENTS_PER_MESSAGE; index += 1) {
        // Ordinary retained prose, not an artificial control-character payload.
        // Native/frame working overflow remains covered at its direct Interface.
        const body =
          `Saved note ${index}: ` + 'Preserve the original discussion context. '.repeat(160)
        // oxlint-disable-next-line no-await-in-loop -- Each real saved draft advances the required Comments revision.
        const saved = await ctx.page.evaluate(
          async (input) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return bridge.saveCommentDraft(input)
          },
          {
            mode: 'create' as const,
            sessionId: ctx.sessionId,
            commentId: randomUUID(),
            expectedCommentsRevision: source.commentsRevision + index,
            body,
            anchor: {
              type: 'message' as const,
              messageId: user.id,
              contentHash,
              textBasis: MESSAGE_ANCHOR_TEXT_BASIS,
              startOffset: offset,
              endOffset: offset + marker.length,
              quote: marker,
            },
          },
        )
        expect(saved.ok).toBe(true)
      }
      const before = await readRealConversation(ctx)
      expect(before.comments.filter((comment) => comment.status === 'draft')).toHaveLength(
        MAX_COMMENTS_PER_MESSAGE,
      )
      const taskMarker = authMarker('LARGE_CONTEXT_ACCEPTED')
      const sample = Array.from(
        { length: 700 },
        (_, index) =>
          `Record ${index}: ` +
          'The saved document keeps its input, Comments and one explicit task. '.repeat(3),
      ).join('\n')
      const draft = `${sample}\nThis document is a transport fixture and needs no analysis. Reply only ${taskMarker}. Do not use tools, read files or write files.`
      expect(draft.length).toBeGreaterThan(100_000)
      const composer = ctx.page.getByRole('combobox', { name: 'Message' })
      await composer.fill(draft)
      await ctx.page.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect.poll(() => composer.textContent()).toBe('')
      const admitted = await readRealConversation(ctx)
      expect(admitted.runs).toHaveLength(2)
      expect(
        admitted.messages.some((message) => message.role === 'user' && message.content === draft),
      ).toBe(true)
      const after = await waitForRealCompletion(ctx, 2)
      expect(after.runs).toHaveLength(2)
      expect(after.runs[0]?.id).toBe(before.runs[0]?.id)
      expect(
        after.messages
          .filter((message) => message.role === 'user')
          .map((message) => message.content),
      ).toEqual([user.content, draft])
      expect(commentFacts(after)).toEqual(commentFacts(before))
      expect(after.comments.every((comment) => comment.status === 'sent')).toBe(true)
      expect(after.commentsRevision).toBe(before.commentsRevision + 1)
      const nativeId = source.runs[0]?.nativeSessionId
      if (!nativeId) throw new Error('Authentic source Native identity is missing')
      expect((await findNativeRecord(ctx, 'codex', nativeId)).codexModelStarts).toBe(2)
      await expect(
        ctx.page.getByRole('button', { name: 'Remove Comment draft', exact: true }),
      ).toHaveCount(0)
    } finally {
      await closeRealWorkspace(ctx)
    }
  })

  test('real background model failure remains attached to its Session Run', async () => {
    test.setTimeout(caseDeadlineMs)
    const ctx = await launchRealWorkspace('real-background-failure')
    try {
      const readingId = await addRealSession(ctx, 'Reading unaffected Session')
      await selectRealSession(ctx, ctx.sessionId)
      const marker = authMarker('REAL_BACKGROUND_REQUEST')
      await sendRealMessage(
        ctx,
        `Acknowledge ${marker}, then write 240 numbered short lines about software boundaries. Do not abbreviate the list or use tools.`,
        'codex',
      )
      const started = await waitForNativeText(ctx, 'codex')
      const owned = await findOwnedAgentProcess(ctx, 'codex')
      await selectRealSession(ctx, readingId)
      await expect(
        ctx.page.getByRole('heading', { name: 'Reading unaffected Session', exact: true }),
      ).toBeVisible()
      await terminateOwnedAgent(ctx, owned)
      const failed = await waitForFailure(ctx, 'codex', 1)
      expect(failed.runs[0]).toMatchObject({
        id: started.id,
        sessionId: ctx.sessionId,
        agentId: 'codex',
        status: 'interrupted',
        failureKind: 'transient_transport',
      })
      expect(failed.runs[0]?.nativeSessionId).toBe(started.nativeSessionId)
      expect(failed.session.activity.state).toBe('interrupted')
      expect(failed.messages.filter((message) => message.role === 'user')).toHaveLength(1)
      expect(failed.messages.find((message) => message.role === 'user')?.content).toContain(marker)
      const reading = await readRealConversation(ctx, readingId)
      expect(reading.runs).toHaveLength(0)
      expect(reading.messages).toHaveLength(0)
      await expect(
        ctx.page.getByRole('heading', { name: 'Reading unaffected Session', exact: true }),
      ).toBeVisible()
      await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeEnabled()
      await expect(
        ctx.page.locator(
          `[data-session-menu="${ctx.sessionId}"] output[aria-label$="was interrupted"]`,
        ),
      ).toHaveCount(1)
      await selectRealSession(ctx, ctx.sessionId)
      expect((await readRealConversation(ctx)).runs.map((run) => run.id)).toEqual([started.id])
      await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeDisabled()
      // The exact context_limit classification/one-toast contract remains the
      // deterministic refusal case. A real process failure does not prove that
      // a configured provider emits context_limit for a bounded request.
    } finally {
      await closeRealWorkspace(ctx)
    }
  })

  test('real Fork refuses a source without peer Native history', async () => {
    test.setTimeout(caseDeadlineMs)
    const ctx = await launchRealWorkspace('real-missing-fork-peer')
    try {
      const marker = authMarker('CLAUDE_ONLY_FORK_SOURCE')
      await sendRealMessage(
        ctx,
        `Reply briefly acknowledging ${marker}. Do not use tools, read files or write files.`,
        'claude',
      )
      const source = await waitForRealCompletion(ctx, 1)
      expect(source.nativeContexts.map((binding) => binding.agentId)).toEqual(['claude'])
      const reply = source.messages.find((message) => message.role === 'assistant')
      if (!reply || reply.agentId !== 'claude')
        throw new Error('Authentic Claude-only Fork source is missing')
      expect(reply.content).toContain(marker)
      await expect(
        ctx.page
          .locator('article[data-pact-speaker="user"]')
          .getByRole('button', { name: 'Fork conversation from this reply' }),
      ).toHaveCount(0)
      const answer = ctx.page.locator(`[data-pact-message-id="${reply.id}"]`)
      await answer.hover()
      const copy = await answer
        .getByRole('button', { name: 'Copy Claude Code message' })
        .boundingBox()
      const fork = await answer
        .getByRole('button', { name: 'Fork conversation from this reply' })
        .boundingBox()
      expect(copy).not.toBeNull()
      expect(fork).not.toBeNull()
      if (!copy || !fork) throw new Error('Authentic assistant Fork action is not mounted')
      expect(fork.x).toBeGreaterThan(copy.x)
      await answer.getByRole('button', { name: 'Fork conversation from this reply' }).click()
      await expect(ctx.page.getByRole('dialog')).toContainText(/codex.*(?:history|source)/iu)
      await expect(
        ctx.page.getByRole('button', { name: 'Create fork', exact: true }),
      ).toBeDisabled()
      await ctx.page.getByRole('button', { name: 'Cancel', exact: true }).click()
      const after = await readRealConversation(ctx)
      expect(after.runs.map((run) => run.id)).toEqual(source.runs.map((run) => run.id))
      expect(after.nativeContexts.map((binding) => binding.nativeSessionId)).toEqual(
        source.nativeContexts.map((binding) => binding.nativeSessionId),
      )
      const catalog = await ctx.page.evaluate(async (projectId) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.getSessionCatalog(projectId)
      }, ctx.projectId)
      expect(catalog.ok && catalog.value.sessions.map((session) => session.id)).toEqual([
        ctx.sessionId,
      ])
      expect(after.forkOperation).toBeUndefined()
    } finally {
      await closeRealWorkspace(ctx)
    }
  })
})

async function waitForNativeText(
  ctx: RealWorkspace,
  agentId: 'claude' | 'codex',
): Promise<{ id: string; nativeSessionId: string }> {
  const database = ReadonlyFixtureDatabase.open(ctx.fixture)
  let observed: { id: string; nativeSessionId: string } | undefined
  try {
    await expect
      .poll(
        () => {
          const rows = database.drizzle.query.agentRuns
            .findMany({
              where: (fields, { and, eq, sql }) =>
                and(
                  eq(fields.sessionId, ctx.sessionId),
                  eq(fields.agentId, agentId),
                  sql`EXISTS (SELECT 1 FROM conversation_messages AS reply WHERE reply.run_id = ${fields.id} AND reply.role = 'assistant' AND length(CAST(reply.content AS BLOB)) > 64)`,
                ),
              columns: { id: true, status: true, nativeSessionId: true, nativeTurnId: true },
              limit: runItems + 1,
            })
            .sync()
          if (rows.length > runItems)
            throw new Error('Real context Run observation exceeds its bound')
          const live = rows.find(
            (row) => row.status === 'running' && row.nativeSessionId && row.nativeTurnId,
          )
          if (live?.nativeSessionId)
            observed = { id: live.id, nativeSessionId: live.nativeSessionId }
          return Boolean(observed)
        },
        { timeout: 300_000, intervals: [100, 250, 500] },
      )
      .toBe(true)
  } finally {
    database.close()
  }
  if (!observed)
    throw new Error(
      'Actual provider did not expose live text before completion; no replacement task is authorized',
    )
  return observed
}

async function waitForFailure(
  ctx: RealWorkspace,
  agentId: 'claude' | 'codex',
  count: number,
): Promise<ConversationSnapshot> {
  const database = ReadonlyFixtureDatabase.open(ctx.fixture)
  try {
    await expect
      .poll(
        () => {
          const rows = database.drizzle.query.agentRuns
            .findMany({
              where: (fields, { eq }) => eq(fields.sessionId, ctx.sessionId),
              columns: { id: true, agentId: true, status: true },
              limit: runItems + 1,
            })
            .sync()
          if (rows.length > runItems)
            throw new Error('Real context Run observation exceeds its bound')
          return (
            rows.length === count &&
            rows.some(
              (row) => row.agentId === agentId && ['failed', 'interrupted'].includes(row.status),
            )
          )
        },
        { timeout: 30_000, intervals: [100, 250, 500] },
      )
      .toBe(true)
  } finally {
    database.close()
  }
  return readRealConversation(ctx)
}

interface OwnedAgentProcess {
  pid: number
  utilityPid: number
  utilityStarted?: string
  chain: Array<{ pid: number; parentPid: number; executable: string; started?: string }>
}

/** PID-only discovery; never inspect or log argv, environment or credentials. */
async function findOwnedAgentProcess(
  ctx: RealWorkspace,
  agentId: 'claude' | 'codex',
): Promise<OwnedAgentProcess> {
  const utilityPid = await ctx.page.evaluate(async () => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    const health = await bridge.getRuntimeHealth()
    if (!health.ok) throw new Error('Actual Utility process identity is unavailable')
    return health.value.pid
  })
  // Read the already selected real executable; avoid new readiness/auth probes
  // during the short live-response window being deliberately interrupted.
  const database = ReadonlyFixtureDatabase.open(ctx.fixture)
  let executable: string | undefined
  try {
    executable = database.runtimePreparationRepository.readSelectedExecutablePath(agentId)
  } finally {
    database.close()
  }
  if (!executable) throw new Error('Selected actual Agent executable is unavailable')
  if (process.platform === 'win32')
    return findWindowsOwnedAgentProcess(utilityPid, executable, agentId)
  const owner = { pid: utilityPid, executable }
  const pending = [{ pid: owner.pid, chain: [] as OwnedAgentProcess['chain'] }]
  const matches: OwnedAgentProcess[] = []
  let inspected = 0
  while (pending.length) {
    const parent = pending.shift()!
    if (parent.chain.length >= processDepth) continue
    let listed: string
    try {
      {
        // oxlint-disable-next-line no-await-in-loop -- Preserve bounded POSIX parent discovery.
        const response = await executeFile('/usr/bin/pgrep', ['-P', String(parent.pid)], {
          timeout: processProbeDeadlineMs,
          maxBuffer: 2048,
          encoding: 'utf8',
        })
        listed = response.stdout
      }
    } catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === 1) continue
      throw new Error('Owned process discovery is unavailable on this platform', { cause: error })
    }
    const ids = listed.trim().split(/\s+/u).filter(Boolean).map(Number)
    if (ids.length > processItems || ids.some((pid) => !Number.isSafeInteger(pid) || pid < 2))
      throw new Error('Owned process PID discovery exceeds its bound')
    for (const pid of ids) {
      if (++inspected > processItems) throw new Error('Owned Agent process tree exceeds its bound')
      // oxlint-disable-next-line no-await-in-loop -- Recheck each child relation before admitting it to the owned tree.
      const child = await processIdentity(pid)
      if (!child || child.parentPid !== parent.pid) continue
      const chain = [...parent.chain, child]
      if (
        basename(child.executable) === basename(owner.executable) ||
        basename(child.executable) === agentId
      )
        matches.push({
          pid,
          utilityPid: owner.pid,
          chain,
        })
      pending.push({ pid, chain })
    }
  }
  if (matches.length !== 1)
    throw new Error(
      'Cannot identify exactly one owned actual Agent executable; no process was terminated',
    )
  return matches[0]!
}

async function processIdentity(
  pid: number,
): Promise<{ pid: number; parentPid: number; executable: string; started?: string } | null> {
  const result = await executeFile('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,comm='], {
    timeout: processProbeDeadlineMs,
    maxBuffer: 4096,
    encoding: 'utf8',
  })
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u)
  return match
    ? { pid: Number(match[1]), parentPid: Number(match[2]), executable: match[3]!.trim() }
    : null
}

async function terminateOwnedAgent(ctx: RealWorkspace, owned: OwnedAgentProcess): Promise<void> {
  const utilityPid = await ctx.page.evaluate(async () => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    const health = await bridge.getRuntimeHealth()
    return health.ok ? health.value.pid : null
  })
  expect(utilityPid).toBe(owned.utilityPid)
  if (process.platform === 'win32') {
    if (!owned.utilityStarted) throw new Error('Owned Utility birth identity is unavailable')
    const chain = owned.chain.map((node) => {
      if (!node.started) throw new Error('Owned process birth identity is unavailable')
      return { ...node, started: node.started }
    })
    await stopWindowsOwnedAgentProcess({ ...owned, utilityStarted: owned.utilityStarted, chain })
    return
  }
  let parentPid = owned.utilityPid
  for (const node of owned.chain) {
    // oxlint-disable-next-line no-await-in-loop -- Every ancestor must still connect the selected child to this Utility before signalling.
    const current = await processIdentity(node.pid)
    if (!current || current.parentPid !== parentPid || current.executable !== node.executable)
      throw new Error('Owned process identity changed; no process was terminated')
    parentPid = node.pid
  }
  if (parentPid !== owned.pid)
    throw new Error('Owned process ancestry did not end at its selected child')
  process.kill(owned.pid, 'SIGKILL')
}

async function preserveOwnedClaudeHistory(
  ctx: RealWorkspace,
  nativeSessionId: string,
): Promise<{ path: string; hash: string }> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(nativeSessionId))
    throw new Error('Unexpected authentic Claude Native identity')
  const projectKey = (await realpath(ctx.projectDirectory)).replace(/[^a-zA-Z0-9]/gu, '-')
  const path = join(ctx.fixture.claudeHome, 'projects', projectKey, nativeSessionId + '.jsonl')
  const resolved = await realpath(path)
  const ownedRoot = await realpath(ctx.fixture.directory)
  const remainder = relative(ownedRoot, resolved)
  const info = await lstat(path)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    !remainder ||
    remainder.startsWith('..') ||
    isAbsolute(remainder)
  )
    throw new Error('Claude source file is not owned by this test')
  const hash = await fileHash(resolved)
  const directory = join(ctx.fixture.directory, 'context-native-evidence')
  await mkdir(directory, { mode: 0o700 })
  const preserved = join(directory, nativeSessionId + '.jsonl')
  await rename(resolved, preserved)
  expect(await fileHash(preserved)).toBe(hash)
  return { path: preserved, hash }
}

async function fileHash(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > nativeByteLimit)
      throw new Error('Owned Native evidence exceeds its 8 MiB bound')
    const bytes = Buffer.alloc(nativeByteLimit + 1)
    let length = 0
    while (length < bytes.length) {
      // oxlint-disable-next-line no-await-in-loop -- Read one bounded genuine file; a killed writer may have left an incomplete final JSON line.
      const part = await handle.read(bytes, length, bytes.length - length, length)
      if (!part.bytesRead) break
      length += part.bytesRead
    }
    if (length > nativeByteLimit) throw new Error('Owned Native evidence exceeds its 8 MiB bound')
    return createHash('sha256').update(bytes.subarray(0, length)).digest('hex')
  } finally {
    await handle.close()
  }
}

function answerFor(snapshot: ConversationSnapshot, runId: string | undefined): string {
  const reply = snapshot.messages.find(
    (message) => message.role === 'assistant' && message.runId === runId,
  )
  if (!reply || reply.state !== 'complete')
    throw new Error('Actual completed Agent reply is unavailable')
  return reply.content
}

function commentFacts(snapshot: ConversationSnapshot) {
  return snapshot.comments.map((comment) => ({
    id: comment.id,
    bodyHash: createHash('sha256').update(comment.body).digest('hex'),
    anchorHash: createHash('sha256').update(JSON.stringify(comment.anchor)).digest('hex'),
  }))
}
