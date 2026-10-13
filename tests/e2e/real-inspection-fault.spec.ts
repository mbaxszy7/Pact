import { expect } from '@playwright/test'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import {
  authMarker,
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  restartRealWorkspace,
  sendRealMessage,
  type RealWorkspace,
} from './real-harness.js'
import { test } from './runtime-fixture.js'

test(
  'real silent Retry reads actual evidence without authorizing generation',
  { tag: '@real' },
  async () => {
    test.setTimeout(360_000)
    const ctx = await launchRealWorkspace('real-silent-inspection', {
      transportFault: 'drop-ack-and-block-inspection',
    })
    try {
      await sendRealMessage(
        ctx,
        `Briefly acknowledge ${authMarker('SILENT')}. Do not use tools.`,
        'codex',
      )
      await expect
        .poll(
          async () =>
            (await ctx.fixture.readTransportFacts()).reduce((n, row) => n + row.droppedAcks, 0),
          { timeout: 90_000 },
        )
        .toBe(1)
      await expect(
        ctx.page.getByRole('button', { name: 'Check session', exact: true }),
      ).toBeVisible({
        timeout: 60_000,
      })
      const original = await readRealConversation(ctx)
      const checking = ctx.page.evaluate(
        async ({ sessionId, runId }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.retryConversationRun(runId, {
            sessionId,
            agentId: 'codex',
            intent: 'inspect',
          })
        },
        { sessionId: ctx.sessionId, runId: original.runs[0]!.id },
      )
      await expect
        .poll(
          async () =>
            (await ctx.fixture.readTransportFacts()).some(
              (row) => row.faultPhase === 'held-after-native',
            ),
          { timeout: 30_000 },
        )
        .toBe(true)
      const result = await checking
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
      })
      await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeDisabled()
      await expect(ctx.page.getByRole('button', { name: 'Rebuild…', exact: true })).toBeVisible()
      const after = await readRealConversation(ctx)
      expect(after.runs.map((run) => run.id)).toEqual(original.runs.map((run) => run.id))
      expect(await forwarded(ctx)).toBe(1)
      await ctx.fixture.controlTransportFault('release')
      await restartRealWorkspace(ctx)
      expect((await readRealConversation(ctx)).runs.map((run) => run.id)).toEqual(
        original.runs.map((run) => run.id),
      )
      expect(await forwarded(ctx)).toBe(1)
      await test.info().attach('actual-silent-read-traffic', {
        body: JSON.stringify(await ctx.fixture.readTransportFacts()),
        contentType: 'application/json',
      })
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

async function forwarded(ctx: RealWorkspace): Promise<number> {
  return (await ctx.fixture.readTransportFacts()).reduce((n, row) => n + row.forwardedTurns, 0)
}
