import { expect } from '@playwright/test'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { markdownVisibleProjection } from '../../apps/desktop/src/shared/message-anchor-text.js'
import {
  closeRealWorkspace,
  launchRealWorkspace,
  selectRealConfiguredEffort,
  sendRealMessage,
  waitForRealCompletion,
  readRealConversation,
} from './real-harness.js'
import { test } from './runtime-fixture.js'

for (const actor of ['codex', 'claude'] as const)
  test(
    `real ${actor} submits a required plan in its first authorized root Turn @real`,
    { tag: '@real-core' },
    async () => {
      test.setTimeout(300_000)
      const ctx = await launchRealWorkspace(`real-required-plan-${actor}`)
      try {
        await selectRealConfiguredEffort(ctx, [actor])
        await sendRealMessage(
          ctx,
          '/plan Draft a small conceptual plan for documenting cancellation ownership. Scope: explain which owner cancels a pending request and releases its resources. Acceptance: document normal completion, cancellation and disposal in three concrete steps. This is planning only; do not inspect or modify files, run commands or delegate. The scope is fully specified.',
          actor,
        )
        const snapshot = await waitForRealCompletion(ctx, 1).catch(async () => {
            const saved = await readRealConversation(ctx)
            let nativeErrors: unknown
            if (actor === 'codex' && saved.runs[0]?.nativeSessionId) {
              const native = await ctx.fixture.openCodexClient()
              try {
                const turns = await native.request('thread/turns/list', {
                  threadId: saved.runs[0].nativeSessionId,
                  itemsView: 'notLoaded',
                  limit: 1,
                  sortDirection: 'desc',
                })
                nativeErrors = turns.result
              } finally {
                await native.close()
              }
            }
            throw new Error(
              ctx.fixture.redactDiagnostic(
                JSON.stringify({
                  runs: saved.runs.map((run) => ({
                    id: run.id,
                    status: run.status,
                    nativeOutcome: run.nativeOutcome,
                    failureKind: run.failureKind,
                    failureMessage: run.failureMessage,
                  })),
                  nativeErrors,
                  answers: saved.messages
                    .filter((message) => message.role === 'assistant')
                    .map((message) => message.content.slice(0, 6000)),
                }),
              ),
            )
          }),
          run = snapshot.runs[0]!
        expect(run).toMatchObject({
          agentId: actor,
          status: 'completed',
          answerFormat: 'collaboration_envelope_v5',
        })
        const response = await ctx.page.evaluate(
          async ({ sessionId, runId }) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return bridge.getConversation({ scope: 'collaboration', sessionId, runId })
          },
          { sessionId: ctx.sessionId, runId: run.id },
        )
        expect(response.ok).toBe(true)
        if (!response.ok || response.value.scope !== 'collaboration')
          throw new Error('The real plan result is unavailable.')
        const task = response.value.view.task!
        let sourceToolEvidence: unknown
        if (
          actor === 'codex' &&
          !['waiting', 'questions'].includes(task.status) &&
          run.nativeSessionId
        ) {
          const client = await ctx.fixture.openCodexClient()
          try {
            const native = await client.request('thread/turns/list', {
              threadId: run.nativeSessionId,
              itemsView: 'full',
              limit: 1,
              sortDirection: 'desc',
            })
            const queue: unknown[] = [native.result]
            const items: object[] = []
            let nodes = 0
            while (queue.length) {
              if (++nodes > 10_000)
                throw new Error('Source failure evidence exceeds its structural bound')
              const value = queue.pop()
              if (!value || typeof value !== 'object') continue
              if (Array.isArray(value)) {
                if (queue.length + value.length > 10_000)
                  throw new Error('Source failure evidence exceeds its queue bound')
                queue.push(...value)
                continue
              }
              const type = Reflect.get(value, 'type')
              if (typeof type === 'string' && /tool|execution/iu.test(type)) {
                if (items.length === 64)
                  throw new Error('Source failure evidence exceeds its item bound')
                const record: Record<string, unknown> = {}
                for (const key of [
                  'type',
                  'name',
                  'server',
                  'status',
                  'error',
                  'output',
                  'result',
                  'content',
                ]) {
                  if (Reflect.has(value, key)) record[key] = Reflect.get(value, key)
                }
                items.push(record)
              }
              const children = Object.values(value)
              if (queue.length + children.length > 10_000)
                throw new Error('Source failure evidence exceeds its queue bound')
              queue.push(...children)
            }
            const safe = ctx.fixture
              .redactDiagnostic(JSON.stringify(items))
              .replace(
                /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/giu,
                '[private-id]',
              )
              .replace(/[a-f0-9]{32,64}/giu, '[private-id]')
            sourceToolEvidence = safe.slice(0, 12_000)
          } finally {
            await client.close()
          }
        }
        expect(
          ['waiting', 'questions'],
          JSON.stringify({
            status: task.status,
            notice: task.notice,
            reportFailure: task.reportFailure,
            planVersion: task.planVersion,
            sourceToolEvidence,
            answer: ctx.fixture
              .redactDiagnostic(
                snapshot.messages.find((message) => message.role === 'assistant')?.content ?? '',
              )
              .slice(0, 6000),
          }),
        ).toContain(task.status)
        expect(task.reportFailure).toBeUndefined()
        expect(task.planDocument).toBeDefined()
        const plan = await ctx.page.evaluate(
          async ({ sessionId, runId, document }) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            let offset = 0,
              text = ''
            for (;;) {
              // oxlint-disable-next-line no-await-in-loop -- Each immutable source page supplies the next cursor.
              const page = await bridge.getConversation({
                scope: 'collaboration-text',
                sessionId,
                runId,
                document,
                offset,
              })
              if (!page.ok || page.value.scope !== 'collaboration-text')
                throw Error('Complete plan source unavailable')
              text += page.value.text
              if (page.value.nextOffset === null) return text
              offset = page.value.nextOffset
            }
          },
          {
            sessionId: ctx.sessionId,
            runId: task.planReference!.sourceRunId,
            document: task.planDocument!,
          },
        )
        expect(plan.trim().length).toBeGreaterThan(0)
        expect(task.planVersion).toBe(1)
        expect(task.planAuthor).toBe(actor)
        const card = ctx.page.getByRole('region', { name: 'Pact collaboration result' })
        await expect(card).toHaveCount(1)
        await ctx.page
          .getByRole('navigation', { name: 'Task context' })
          .getByRole('button', { name: 'Plan', exact: true })
          .click()
        const panel = ctx.page.getByRole('region', { name: 'Current plan', exact: true })
        await expect(panel).toBeVisible()
        await expect(panel.locator('[data-pact-plan-run-id]')).toContainText(
          markdownVisibleProjection(plan).trim().slice(0, 40),
        )
        await expect(panel).toContainText('Select text to add a Comment')
        await expect(card.locator('[data-pact-plan-run-id]')).toHaveCount(0)
        expect(snapshot.runs).toHaveLength(1)
      } finally {
        await closeRealWorkspace(ctx)
      }
    },
  )
