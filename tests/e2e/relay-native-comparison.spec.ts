import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import {
  closeRealWorkspace,
  launchRealWorkspace,
  sendRealMessage,
  waitForRealCompletion,
} from './real-harness.js'
import { findNativeRecord } from './real-native-evidence.js'
import { test } from './runtime-fixture.js'

test(
  'real ordinary Pact Session completes one exact Codex Luna task',
  { tag: ['@real', '@real-extended'] },
  async ({ browserName: _browserName }, testInfo) => {
    test.setTimeout(120_000)
    const ctx = await launchRealWorkspace('real-luna-native-comparison')
    try {
      const settings = await ctx.page.evaluate(async (sessionId) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const state = await bridge.getSessionSettings(sessionId)
        if (!state.ok) throw Error('Actual Session settings unavailable')
        const model = state.value.modelCatalogs.codex.models.find(
          (entry) => entry.id === 'gpt-6-luna',
        )
        if (
          !model ||
          (model.resolvedModel && model.resolvedModel !== 'gpt-6-luna') ||
          !model.supportedEfforts.includes('low')
        )
          throw Error('Exact native Luna/low catalog entry unavailable')
        const prior = state.value.session.settings
        return bridge.saveSessionSettings({
          sessionId,
          settings: {
            primaryAgentId: 'codex',
            agents: { ...prior.agents, codex: { model: 'gpt-6-luna', effort: 'low' } },
            maxDiscussionRounds: prior.maxDiscussionRounds,
            maxReviewCycles: prior.maxReviewCycles,
            maxRepairAttempts: prior.maxRepairAttempts,
          },
        })
      }, ctx.sessionId)
      expect(settings.ok).toBe(true)
      const marker = `LUNA_NATIVE_${randomUUID()}`
      await sendRealMessage(
        ctx,
        `Reply briefly acknowledging ${marker}. Do not use tools, read files or write files.`,
        'codex',
      )
      const completed = await waitForRealCompletion(
        ctx,
        1,
        ctx.sessionId,
        [],
        AbortSignal.timeout(45_000),
      )
      expect(completed.runs).toHaveLength(1)
      const run = completed.runs[0]!
      expect(run).toMatchObject({
        agentId: 'codex',
        status: 'completed',
        model: 'gpt-6-luna',
        effort: 'low',
      })
      const answer = completed.messages.find(
        (message) => message.role === 'assistant' && message.runId === run.id,
      )
      expect(answer?.state).toBe('complete')
      if (!run.nativeSessionId) throw Error('Authentic native identity unavailable')
      const native = await findNativeRecord(ctx, 'codex', run.nativeSessionId)
      expect(native.codexModelStarts).toBe(1)
      await testInfo.attach('luna-native-comparison', {
        contentType: 'application/json',
        body: Buffer.from(
          JSON.stringify({
            businessRuns: 1,
            nativeTurns: native.codexModelStarts,
            model: run.model,
            effort: run.effort,
            completed: true,
            markerReceived: native.containsText(marker),
            authenticAnswer: Boolean(answer?.content.trim()),
            answerChars: answer?.content.length ?? 0,
            nativeTurnModels: native.codexTurnSettings.map((entry) => entry.model),
            nativeRecordSha256: native.sha256,
          }),
        ),
      })
      // A brief acknowledgement need not echo its nonce. Native history must
      // retain the exact sent marker and a complete nonempty authentic answer.
      expect(native.containsText(marker)).toBe(true)
      expect(Boolean(answer?.content.trim())).toBe(true)
      expect(native.codexTurnSettings.length).toBeGreaterThan(0)
      expect(native.codexTurnSettings.every((entry) => entry.model === 'gpt-6-luna')).toBe(true)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)
