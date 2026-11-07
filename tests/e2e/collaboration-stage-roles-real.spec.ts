import { expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import {
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  restartRealWorkspace,
  selectRealConfiguredEffort,
  sendRealMessage,
} from './real-harness.js'
import { test } from './runtime-fixture.js'
import { stageRoleApprovalLabel } from './stage-role-approval.js'

for (const primary of ['codex', 'claude'] as const)
  test(
    `real Primary ${primary} plans and reviews code while Secondary reviews the plan and implements`,
    { tag: ['@real', '@real-extended'] },
    async () => {
      test.setTimeout(300_000)
      const deadline = Date.now() + 300_000
      const ctx = await launchRealWorkspace(`real-stage-roles-${primary}`)
      const secondary = primary === 'codex' ? 'claude' : 'codex'
      const code = 'export function clamp(value, min, max) { return value; }\n'
      const checks = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './clamp.mjs';
test('clamps both bounds and preserves values inside the interval', () => {
  assert.equal(clamp(-3, 0, 5), 0);
  assert.equal(clamp(8, 0, 5), 5);
  assert.equal(clamp(3, 0, 5), 3);
  assert.equal(clamp(0, 0, 5), 0);
  assert.equal(clamp(5, 0, 5), 5);
  assert.equal(clamp(8, 2, 2), 2);
});\n`
      const verify = () =>
        new Promise<boolean>((done) => {
          execFile(
            process.execPath,
            ['--test', 'clamp.test.mjs'],
            {
              cwd: ctx.projectDirectory,
              timeout: 10_000,
              maxBuffer: 64 * 1024,
            },
            (error) => done(error === null),
          )
        })
      const view = () =>
        ctx.page.evaluate(async (sessionId) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const result = await bridge.getConversation({ scope: 'collaboration', sessionId })
          if (!result.ok || result.value.scope !== 'collaboration')
            throw new Error('Workflow view unavailable')
          return result.value.view
        }, ctx.sessionId)
      try {
        await writeFile(join(ctx.projectDirectory, 'clamp.mjs'), code)
        await writeFile(join(ctx.projectDirectory, 'clamp.test.mjs'), checks)
        expect(await verify()).toBe(false)
        await selectRealConfiguredEffort(ctx, ['codex', 'claude'], primary)
        await sendRealMessage(
          ctx,
          '/plan Fix only clamp.mjs so clamp(value, min, max) returns min below the lower bound, max above the upper bound, and otherwise value. Inputs are finite numbers with min <= max; no additional validation or dependencies. The supplied clamp.test.mjs is immutable acceptance evidence and must not be edited. Use the native file-edit operation for the one-file change; run exactly node --test clamp.test.mjs from the project directory for verification. Plan this change and verification; do not implement until explicitly authorized. Do not delegate. All scope and choices are specified. Publish the complete plan through the native plan mechanism.',
          primary,
        )
        await expect
          .poll(
            async () => {
              const current = await view()
              if (current.task?.status === 'failed')
                throw new Error('Real plan or plan review failed')
              return current.accepted && current.task?.status === 'ready'
            },
            { timeout: Math.max(1, deadline - Date.now()), intervals: [250, 500, 1000] },
          )
          .toBe(true)
        const ready = (await view()).task!
        expect(ready).toMatchObject({
          rolePolicy: 'split-stages-v1',
          owner: primary,
          reviewer: secondary,
          review: { actor: secondary, stage: 'plan_review', verdict: 'accepted' },
        })
        expect(
          (await readRealConversation(ctx)).runs
            .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map((run) => [run.collaboration?.stage, run.agentId]),
        ).toEqual([
          ['plan', primary],
          ['plan_review', secondary],
        ])
        expect(await readFile(join(ctx.projectDirectory, 'clamp.mjs'), 'utf8')).toBe(code)
        const plan = ready.planReference
        await restartRealWorkspace(ctx)
        await ctx.page.getByRole('button', { name: 'Continue collaboration', exact: true }).click()
        const implement = ctx.page.getByRole('button', {
          name: `Implement plan · ${secondary === 'claude' ? 'Claude Code' : 'Codex'}`,
          exact: true,
        })
        await expect(implement).toBeEnabled()
        expect((await readRealConversation(ctx)).runs).toHaveLength(2)
        expect((await view()).task?.planReference).toEqual(plan)
        const approved = new Set<string>()
        await implement.click()
        await expect
          .poll(
            async () => {
              const current = await view()
              if (current.task?.status === 'failed')
                throw new Error('Real implementation or code review failed')
              const requests = await ctx.page.evaluate(async (sessionId) => {
                const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
                const page = await bridge.getConversation({ scope: 'messages', sessionId })
                if (!page.ok || page.value.scope !== 'messages')
                  throw new Error('Native approval state unavailable')
                const pending = page.value.header.pendingNativeInteractions ?? []
                if (pending.length > 8)
                  throw new Error('Native approvals exceed the existing interaction bound')
                return Promise.all(
                  pending.map(async ({ agentId, request }) => {
                    if (!request.operationId)
                      throw new Error('Native approval has no owned operation identity')
                    const details = await bridge.readNativeInput({
                      operationId: request.operationId,
                      requestId: request.id,
                    })
                    return {
                      agentId,
                      id: request.id,
                      details: details.ok ? details.value : undefined,
                    }
                  }),
                )
              }, ctx.sessionId)
              for (const request of requests) {
                if (!request.details || approved.has(request.id)) continue
                const details = request.details
                if (details.kind !== 'approval' || approved.size >= 8)
                  throw new Error('Unexpected native input; no decision was supplied')
                const label = stageRoleApprovalLabel(details, {
                  directory: ctx.projectDirectory,
                  stage: current.task?.stage,
                  actor: current.task?.actor,
                  secondary,
                  requestedAgent: request.agentId,
                })
                if (!label)
                  throw new Error(
                    'Native approval exceeded the exact owned file or verification command scope',
                  )
                approved.add(request.id)
                // oxlint-disable-next-line no-await-in-loop -- Inspect and approve one exact live request; never persist a Session rule or change permission settings.
                await ctx.page
                  .locator(`[data-pact-native-permission=${JSON.stringify(request.id)}]`)
                  .getByRole('button', { name: label, exact: true })
                  .click()
              }
              return current.task?.status
            },
            { timeout: Math.max(1, deadline - Date.now()), intervals: [250, 500, 1000] },
          )
          .toBe('complete')
        const completed = await view()
        expect(completed.task?.review).toMatchObject({
          actor: primary,
          stage: 'code_review',
          verdict: 'accepted',
        })
        expect(completed.task?.planReference).toEqual(plan)
        const runs = (await readRealConversation(ctx)).runs.toSorted((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        )
        expect(runs.map((run) => [run.collaboration?.stage, run.agentId])).toEqual([
          ['plan', primary],
          ['plan_review', secondary],
          ['implement', secondary],
          ['code_review', primary],
        ])
        expect(
          runs.every(
            (run) => run.nativeOutcome === 'completed' && run.nativeEffectsState === 'settled',
          ),
        ).toBe(true)
        expect(await readFile(join(ctx.projectDirectory, 'clamp.test.mjs'), 'utf8')).toBe(checks)
        expect(await verify()).toBe(true)
        expect(completed.availableActions).not.toContain('execute')
      } finally {
        await closeRealWorkspace(ctx)
      }
    },
  )
