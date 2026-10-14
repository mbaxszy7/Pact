import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import {
  authMarker,
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  sendRealMessage,
  waitForRealCompletion,
} from './real-harness.js'
import { findNativeRecord } from './real-native-evidence.js'
import { test } from './runtime-fixture.js'
import { windowsTextCommand } from './windows-test-command.js'

test(
  'real @all preserves distinct ordered rows while the second Agent waits for actual permission',
  { tag: ['@real', '@real-core'] },
  async () => {
    test.setTimeout(600_000)
    const ctx = await launchRealWorkspace('real-pending-peer')
    try {
      const configured = await ctx.page.evaluate(async (sessionId) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const results = []
        for (const agentId of ['codex', 'claude'] as const) {
          // oxlint-disable-next-line no-await-in-loop -- Each permission save requires the revision returned by the preceding save.
          const settings = await bridge.getSessionSettings(sessionId)
          if (!settings.ok) throw new Error('Session permission revision unavailable')
          results.push(
            // oxlint-disable-next-line no-await-in-loop -- Preserve the Session settings revision contract across the two user choices.
            await bridge.saveSessionPermission({
              sessionId,
              agentId,
              mode: 'ask',
              expectedRevision: settings.value.session.settingsRevision,
              confirmedFullAccess: false,
            }),
          )
        }
        return results
      }, ctx.sessionId)
      expect(configured.every((result) => result.ok)).toBe(true)
      const marker = authMarker('PENDING_PEER')
      const command =
        process.platform === 'win32'
          ? windowsTextCommand(marker, 'routing-permission.txt')
          : `printf '%s' '${marker}' >> ../routing-permission.txt`
      await sendRealMessage(
        ctx,
        `Execute exactly this shell command once: ${command}. The destination is outside the project and inside my isolated test directory. Request sandbox escalation with justification when necessary. Do not inspect other files or change permissions. Reply with ${marker} after execution.`,
        'all',
      )
      const first = ctx.page.getByRole('region', { name: 'Codex permission request', exact: true })
      await expect(
        first.getByRole('button', { name: 'Allow this command', exact: true }),
      ).toBeVisible({ timeout: 120_000 })
      await first.getByRole('button', { name: 'Allow this command', exact: true }).click()
      const second = ctx.page.getByRole('region', {
        name: 'Claude Code permission request',
        exact: true,
      })
      await expect(
        second.getByRole('button', { name: 'Allow this tool call', exact: true }),
      ).toBeVisible({ timeout: 120_000 })
      await expect(ctx.page.locator('article[data-pact-speaker="codex"]')).toContainText(marker)
      const pending = await readRealConversation(ctx)
      expect(pending.runs.map((run) => run.agentId)).toEqual(['codex', 'claude'])
      expect(pending.runs[0]?.status).toBe('completed')
      expect(pending.runs[1]?.status).toBe('running')
      const rows = await ctx.page
        .locator('[data-pact-row-key]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-pact-row-key') ?? ''))
      expect(rows.some((key) => key.endsWith(':codex'))).toBe(true)
      expect(rows.some((key) => key.endsWith(':claude'))).toBe(true)
      expect(new Set(rows).size).toBe(rows.length)
      expect(await readFile(join(ctx.fixture.directory, 'routing-permission.txt'), 'utf8')).toBe(
        marker,
      )
      await second.getByRole('button', { name: 'Allow this tool call', exact: true }).click()
      const completed = await waitForRealCompletion(ctx, 2)
      expect(completed.runs.map((run) => run.agentId)).toEqual(['codex', 'claude'])
      expect(
        completed.messages
          .filter((row) => row.role === 'assistant')
          .every((row) => row.content.includes(marker)),
      ).toBe(true)
      expect(await readFile(join(ctx.fixture.directory, 'routing-permission.txt'), 'utf8')).toBe(
        marker + marker,
      )
      const evidence = await Promise.all(
        completed.nativeContexts.map((binding) =>
          findNativeRecord(ctx, binding.agentId, binding.nativeSessionId),
        ),
      )
      expect(evidence.find((row) => row.codexModelStarts)?.codexModelStarts).toBe(1)
      expect(evidence.find((row) => row.claudeUserInputs)?.claudeUserInputs).toBe(1)
      await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeEnabled()
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)
