import { expect } from '@playwright/test'

import {
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  restartRealWorkspace,
  waitForWindowsRuntimeReady,
} from './real-harness.js'
import { test } from './runtime-fixture.js'

test(
  'real Session startup closes its native catalog processes without a Model Turn',
  { tag: ['@real', '@real-extended'] },
  async () => {
    const ctx = await launchRealWorkspace('real-zero-turn-startup', {
      transportFault: 'hold-initialization',
    })
    try {
      const session = await readRealConversation(ctx)
      expect(session.runs).toEqual([])
      expect(session.nativeContexts).toEqual([])
      if (process.platform === 'win32') {
        await restartRealWorkspace(ctx)
        await waitForWindowsRuntimeReady(ctx.page, ctx.fixture)
        const restarted = await readRealConversation(ctx)
        expect(restarted.runs).toEqual([])
        expect(restarted.nativeContexts).toEqual([])
      }
      expect(
        (await ctx.fixture.readTransportFacts()).every((fact) => fact.forwardedTurns === 0),
      ).toBe(true)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)
