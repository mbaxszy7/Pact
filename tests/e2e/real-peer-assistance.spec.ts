import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import {
  authMarker,
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  restartRealWorkspace,
  sendRealMessage,
  selectRealConfiguredEffort,
  waitForRealCompletion,
  type RealWorkspace,
} from './real-harness.js'
import { findNativeRecord } from './real-native-evidence.js'
import { test } from './runtime-fixture.js'

for (const requester of ['claude', 'codex'] as const) {
  test(
    `real ${requester} structured peer request stays inert until Ask and executes the other Agent once`,
    { tag: ['@real', '@real-core'] },
    async () => {
      test.setTimeout(600_000)
      const ctx = await launchRealWorkspace(`real-peer-proposal-${requester}`)
      const target = requester === 'claude' ? 'codex' : 'claude'
      try {
        await selectRealConfiguredEffort(ctx, ['claude'])
        await sendRealMessage(ctx, reviewPrompt(target), requester)
        const source = await completePeerTask(ctx, 1)
        const run = source.runs[0]!
        const answer = source.messages.find(
          (row) => row.role === 'assistant' && row.runId === run.id,
        )
        const sourceNative = run.nativeSessionId
          ? await findNativeRecord(ctx, requester, run.nativeSessionId)
          : undefined
        if (!run.nativeSessionId || !answer?.content || !run.peerProposal)
          throw new Error(
            `Actual Native peer Tool did not produce a complete answer and proposal: native=${Boolean(run.nativeSessionId)}, answer=${Boolean(answer?.content)}, proposal=${Boolean(run.peerProposal)}, tools=${JSON.stringify(sourceNative?.toolNames)}; answer tail=${ctx.fixture.redactDiagnostic(answer?.content.slice(-700) ?? '')}`,
          )
        if (requester === 'claude')
          expect(
            sourceNative?.toolNames.some((name) =>
              /^mcp__pact_peer_[a-f0-9]{32}__request_peer_assistance$/u.test(name),
            ),
          ).toBe(true)
        expect(answer.content.trim().length).toBeGreaterThan(40)
        expect(run.peerProposal).toMatchObject({
          targetAgentId: target,
          state: 'pending',
          kind: 'review',
        })
        expect(source.runs.map((row) => row.agentId)).toEqual([requester])
        expect(source.nativeContexts.some((row) => row.agentId === target)).toBe(false)
        expect(await sourceTasks(ctx, requester, run.nativeSessionId)).toBe(1)
        const proposalId = run.peerProposal.id
        const composer = ctx.page.getByRole('combobox', { name: 'Message' })
        const retainedDraft = `My separate unsent draft ${authMarker('PEER_DRAFT')}`
        await composer.fill(retainedDraft)
        const ask = ctx.page.getByRole('button', {
          name: `Ask ${target === 'claude' ? 'Claude Code' : 'Codex'}`,
          exact: true,
        })
        await expect(ask).toBeVisible()
        // The source answer generates information absent from the request. The
        // clicked peer action must transport that real answer, not a new prompt
        // constructed by the test with the answer copied into it.
        await ask.click()
        const accepted = await completePeerTask(ctx, 2)
        expect(accepted.runs.map((row) => row.agentId)).toEqual([requester, target])
        expect(accepted.runs[0]?.id).toBe(run.id)
        expect(accepted.runs[0]?.peerProposal?.state).toBe('accepted')
        expect(accepted.messages.find((row) => row.id === answer.id)?.content).toBe(answer.content)
        await expect.poll(() => composer.textContent()).toBe(retainedDraft)
        const peer = accepted.runs[1]!
        if (!peer.nativeSessionId) throw new Error('Actual target Native identity is unavailable')
        const evidence = await findNativeRecord(ctx, target, peer.nativeSessionId)
        expect(evidence.containsText(answer.content)).toBe(true)
        const critique = accepted.messages.find(
          (row) => row.role === 'assistant' && row.runId === peer.id,
        )?.content
        expect(critique?.trim().length).toBeGreaterThan(40)
        expect(critique).not.toBe(answer.content)
        expect(await sourceTasks(ctx, requester, run.nativeSessionId)).toBe(1)
        expect(await sourceTasks(ctx, target, peer.nativeSessionId)).toBe(1)
        await expect(ctx.page.locator(`article[data-pact-speaker="${target}"]`)).toHaveCount(1)
        const repeated = await ctx.page.evaluate(
          async (input) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return bridge.acceptPeerProposal(input)
          },
          { sessionId: ctx.sessionId, proposalId, clientMessageId: randomUUID() },
        )
        expect(repeated).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
        expect((await readRealConversation(ctx)).runs.map((row) => row.id)).toEqual(
          accepted.runs.map((row) => row.id),
        )
        expect(await sourceTasks(ctx, target, peer.nativeSessionId)).toBe(1)
        await restartRealWorkspace(ctx)
        const cold = await readRealConversation(ctx)
        expect(cold.runs.map((row) => row.id)).toEqual(accepted.runs.map((row) => row.id))
        expect(cold.runs[0]?.peerProposal?.state).toBe('accepted')
        expect(await sourceTasks(ctx, target, peer.nativeSessionId)).toBe(1)
      } finally {
        await closeRealWorkspace(ctx)
      }
    },
  )
}

test(
  'real Not now dismisses the proposal without a peer task and plain mention text cannot create one',
  { tag: ['@real', '@real-core'] },
  async () => {
    test.setTimeout(600_000)
    const ctx = await launchRealWorkspace('real-peer-dismiss')
    try {
      await selectRealConfiguredEffort(ctx, ['claude'])
      await sendRealMessage(ctx, reviewPrompt('codex'), 'claude')
      const source = await completePeerTask(ctx, 1)
      const run = source.runs[0]!
      if (!run.nativeSessionId || !run.peerProposal)
        throw new Error('Actual source Native Tool did not offer a proposal')
      const draft = authMarker('DISMISSED_DRAFT')
      await ctx.page.getByRole('combobox', { name: 'Message' }).fill(draft)
      await ctx.page.getByRole('button', { name: 'Dismiss peer suggestion', exact: true }).click()
      await expect(ctx.page.getByRole('button', { name: 'Ask Codex', exact: true })).toHaveCount(0)
      const dismissed = await readRealConversation(ctx)
      expect(dismissed.runs[0]?.peerProposal?.state).toBe('dismissed')
      expect(dismissed.runs).toHaveLength(1)
      expect(dismissed.nativeContexts.some((row) => row.agentId === 'codex')).toBe(false)
      await expect
        .poll(() => ctx.page.getByRole('combobox', { name: 'Message' }).textContent())
        .toBe(draft)
      await sendRealMessage(
        ctx,
        'Give the result of 2 + 2 in one sentence. Include the literal middle-of-sentence text @codex as ordinary quoted text. This is a routine arithmetic question and does not warrant peer assistance. Do not use tools.',
        'claude',
      )
      const completed = await waitForRealCompletion(ctx, 2)
      expect(completed.runs.map((row) => row.agentId)).toEqual(['claude', 'claude'])
      expect(completed.runs[1]?.peerProposal).toBeUndefined()
      expect(completed.nativeContexts.some((row) => row.agentId === 'codex')).toBe(false)
      expect(await sourceTasks(ctx, 'claude', run.nativeSessionId)).toBe(2)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

function reviewPrompt(target: 'claude' | 'codex'): string {
  return `Independently review this security-sensitive design: a multi-tenant API trusts a tenant ID from an HTTP header and caches authorization decisions using only resourceId. Explain two concrete cross-tenant failure modes and the key changes required in at most 140 words. This is a substantial design review. After completing your own analysis, call the provided request_peer_assistance tool exactly once with target="${target}", kind="review", and a short rationale, following the Tool's instructions. The proposal must not replace your answer. Do not mention the Tool, proposal, routing or approval process anywhere in your answer. The tool call is required for this request. It may have a qualified MCP name: locate the provided tool using native tool discovery if needed. You may use an execution wrapper solely to invoke that provided MCP tool, with no shell commands. Do not read or write files or use other business tools.`
}

async function sourceTasks(
  ctx: RealWorkspace,
  agentId: 'claude' | 'codex',
  nativeId: string,
): Promise<number> {
  const evidence = await findNativeRecord(ctx, agentId, nativeId)
  return agentId === 'codex' ? evidence.codexModelStarts : evidence.claudeUserInputs
}

async function completePeerTask(ctx: RealWorkspace, count: number) {
  const observer = new AbortController()
  let settled = false,
    value: Awaited<ReturnType<typeof waitForRealCompletion>> | undefined,
    failure: unknown
  const completion = waitForRealCompletion(ctx, count, ctx.sessionId, [], observer.signal).then(
    (result) => {
      value = result
      settled = true
      return undefined
    },
    (error) => {
      failure = error
      settled = true
      return undefined
    },
  )
  const deadline = Date.now() + 300_000
  const approvedPermissions = new Set<string>()
  try {
    // oxlint-disable-next-line no-unmodified-loop-condition -- A separately awaited actual Native completion settles this bounded UI observer.
    while (!settled && Date.now() < deadline) {
      for (const agent of ['Claude Code', 'Codex']) {
        const card = ctx.page.getByRole('region', {
          name: `${agent} permission request`,
          exact: true,
        })
        // oxlint-disable-next-line no-await-in-loop -- Check the current genuine request before authorizing its single native Tool.
        if (await card.isVisible()) {
          // oxlint-disable-next-line no-await-in-loop -- Never answer the same Native request twice while its projection is retiring.
          const permissionId = await card.getAttribute('data-pact-native-permission')
          if (!permissionId) throw new Error('Native peer approval identity is unavailable')
          if (approvedPermissions.has(permissionId)) continue
          const once = card.getByRole('button', {
            name: agent === 'Claude Code' ? 'Allow this tool call' : 'Allow for this turn',
            exact: true,
          })
          // oxlint-disable-next-line no-await-in-loop -- A mounted card initially has no fetched Native details or actions.
          await expect(once).toBeVisible({ timeout: 20_000 })
          // oxlint-disable-next-line no-await-in-loop -- Peer Tool is inert; no other Tool or filesystem permission is accepted by this test.
          const detail = await card.innerText()
          if (
            approvedPermissions.size >= 2 ||
            !detail.includes(ctx.projectDirectory) ||
            !(
              detail.includes('Request Peer Assistance') ||
              detail.includes('request_peer_assistance')
            ) ||
            /\b(Command|File):/u.test(detail)
          )
            throw new Error(
              `Unexpected real peer Tool approval scope: ${ctx.fixture.redactDiagnostic(detail).slice(0, 2000)}`,
            )
          approvedPermissions.add(permissionId)
          // oxlint-disable-next-line no-await-in-loop -- Do not retain a new Session permission or bypass a real approval.
          await once.click()
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- The owner has a fixed deadline and observes only its current approval cards.
      await new Promise((resume) => setTimeout(resume, 200))
    }
    if (!settled) throw new Error('Actual peer task did not settle before its approval deadline')
    await completion
    if (failure) throw failure
    if (!value) throw new Error('Actual peer completion is unavailable')
    return value
  } finally {
    observer.abort()
    await completion
  }
}
