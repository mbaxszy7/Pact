import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { DesktopBridge, WorkspaceChangesPage } from '../../packages/contracts/src/index.js'

import {
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  restartRealWorkspace,
  sendRealMessage,
  waitForRealCompletion,
  type RealWorkspace,
} from './real-harness.js'
import { findNativeRecord } from './real-native-evidence.js'
import { test } from './runtime-fixture.js'

const baseline = [
  'export const agent = "before";',
  '',
  ...Array.from({ length: 12 }, (_, i) => `// stable ${i}`),
  '',
  'export const user = "before";',
  '',
].join('\n')
const edited = baseline.replace('agent = "before"', 'agent = "after"')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

test(
  'real Claude edits preserve native versions and whole-card Undo rejects conflicts without partial writes',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(600_000)
    const ctx = await launchRealWorkspace('real-native-undo')
    try {
      for (const name of ['a.ts', 'z.ts']) {
        // oxlint-disable-next-line no-await-in-loop -- Establish both owned input files before asking the real Agent to edit them.
        await writeFile(join(ctx.projectDirectory, name), baseline, { mode: 0o644 })
      }
      await writeFile(join(ctx.projectDirectory, 'unrelated.txt'), 'user-owned file\n')
      await sendRealMessage(
        ctx,
        'Use the native Read and Edit tools to edit the existing a.ts and z.ts files. In each replace only agent = "before" with agent = "after". Keep every other byte unchanged. Do not use Bash, create files, or edit any other file. Reply briefly when finished.',
        'claude',
      )
      await finishWithOwnedApprovals(ctx, 1)
      const completed = await readRealConversation(ctx)
      const run = completed.runs[0]!
      if (!run.nativeSessionId) throw new Error('Actual Native editing identity is unavailable')
      const page = await settledChanges(ctx, run.id)
      expect(page.changeSet).toMatchObject({
        state: 'ready',
        fileCount: 2,
        undoUnavailableReason: null,
      })
      expect(page.files.map((file) => file.path).toSorted()).toEqual(['a.ts', 'z.ts'])
      for (const file of page.files) {
        expect(file).toMatchObject({
          beforeAvailable: true,
          afterAvailable: true,
          undoStrategy: 'three_way',
        })
        // oxlint-disable-next-line no-await-in-loop -- Read independent saved Native endpoints, never substitute the current disk content.
        const versions = await ctx.page.evaluate(
          async ({ id, path }) => {
            const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
            return {
              before: await bridge.readWorkspaceChangeFile({
                changeSetId: id,
                path,
                side: 'before',
              }),
              after: await bridge.readWorkspaceChangeFile({ changeSetId: id, path, side: 'after' }),
            }
          },
          { id: run.id, path: file.path },
        )
        expect(versions.before).toMatchObject({
          ok: true,
          value: { status: 'available', file: { content: baseline } },
        })
        expect(versions.after).toMatchObject({
          ok: true,
          value: { status: 'available', file: { content: edited } },
        })
        // oxlint-disable-next-line no-await-in-loop -- Every listed file's genuine native effect must match the requested edit.
        expect(await readFile(join(ctx.projectDirectory, file.path), 'utf8')).toBe(edited)
      }
      const card = ctx.page.locator(`[data-pact-workspace-changes="${run.id}"]`)
      await expect(card.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled()
      await card.getByRole('button', { name: 'View changes', exact: true }).click()
      await expect(ctx.page.getByRole('button', { name: 'Close changes preview' })).toBeVisible()
      await ctx.page.getByRole('button', { name: 'Close changes preview' }).click()
      await writeFile(
        join(ctx.projectDirectory, 'z.ts'),
        edited.replace('agent = "after"', 'agent = "external conflict"'),
      )
      const conflictBefore = await diskState(ctx)
      await card.getByRole('button', { name: 'Undo', exact: true }).click()
      await expect(ctx.page.locator('[data-pact-toast-tone="warning"]')).toContainText(
        /conflict|No files were changed/iu,
      )
      expect(await diskState(ctx)).toEqual(conflictBefore)
      expect((await settledChanges(ctx, run.id)).changeSet.state).toBe('ready')
      // Restore only the conflict deliberately created by this test, then prove
      // inverse merging preserves a later independent user edit and file mode.
      await writeFile(join(ctx.projectDirectory, 'z.ts'), edited)
      await writeFile(
        join(ctx.projectDirectory, 'a.ts'),
        edited.replace('user = "before"', 'user = "external edit"'),
      )
      await chmod(join(ctx.projectDirectory, 'a.ts'), 0o600)
      const currentMode = (await stat(join(ctx.projectDirectory, 'a.ts'))).mode & 0o777
      const historyBefore = digest(JSON.stringify(completed.messages))
      const nativeBefore = await findNativeRecord(ctx, 'claude', run.nativeSessionId)
      await card.getByRole('button', { name: 'Undo', exact: true }).click()
      await expect(card).toContainText('Undone')
      expect(await readFile(join(ctx.projectDirectory, 'a.ts'), 'utf8')).toBe(
        baseline.replace('user = "before"', 'user = "external edit"'),
      )
      expect((await stat(join(ctx.projectDirectory, 'a.ts'))).mode & 0o777).toBe(
        process.platform === 'win32' ? currentMode : 0o600,
      )
      expect(await readFile(join(ctx.projectDirectory, 'z.ts'), 'utf8')).toBe(baseline)
      expect(await readFile(join(ctx.projectDirectory, 'unrelated.txt'), 'utf8')).toBe(
        'user-owned file\n',
      )
      const after = await readRealConversation(ctx)
      expect(digest(JSON.stringify(after.messages))).toBe(historyBefore)
      expect(after.runs).toHaveLength(1)
      expect(after.runs[0]?.nativeSessionId).toBe(run.nativeSessionId)
      expect((await findNativeRecord(ctx, 'claude', run.nativeSessionId)).claudeUserInputs).toBe(
        nativeBefore.claudeUserInputs,
      )
      const diskAfter = await diskState(ctx)
      const repeated = await ctx.page.evaluate(async (id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.undoWorkspaceChanges({ changeSetId: id })
      }, run.id)
      expect(repeated).toMatchObject({ ok: false })
      expect(await diskState(ctx)).toEqual(diskAfter)
      await restartRealWorkspace(ctx)
      await expect(ctx.page.locator(`[data-pact-workspace-changes="${run.id}"]`)).toContainText(
        'Undone',
      )
      expect(await diskState(ctx)).toEqual(diskAfter)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

test(
  'real Codex applied patch remains reviewable while unavailable history disables Undo',
  { tag: ['@real', '@real-extended'] },
  async () => {
    test.setTimeout(600_000)
    const ctx = await launchRealWorkspace('real-native-patch-review')
    try {
      await writeFile(join(ctx.projectDirectory, 'a.ts'), baseline)
      if (process.platform === 'win32') {
        // This isolated Windows profile inherits readonly defaults; request the existing
        // Session-scoped Ask mode before exercising a project write.
        await ctx.page.getByRole('button', { name: 'Codex · Native settings', exact: true }).click()
        await ctx.page
          .getByLabel('Codex permissions', { exact: true })
          .getByRole('button', { name: /^Ask for approval/u })
          .click()
        await expect(
          ctx.page.getByRole('button', { name: 'Codex · Ask for approval', exact: true }),
        ).toBeVisible()
      }
      await sendRealMessage(
        ctx,
        process.platform === 'win32'
          ? 'Use only the native apply_patch tool to apply this exact patch to the existing a.ts. Do not use shell commands, read other files, create files, or change other bytes. The file contains the exact matching old line. Reply briefly when finished.\n*** Begin Patch\n*** Update File: a.ts\n@@\n-export const agent = "before";\n+export const agent = "after";\n*** End Patch'
          : 'Read a.ts and use the native apply_patch tool to replace only agent = "before" with agent = "after". Do not use shell commands to write files, create files, or change other bytes. Reply briefly when finished.',
        'codex',
      )
      if (process.platform === 'win32') await finishWithOwnedApprovals(ctx, 1, 'codex')
      else await waitForRealCompletion(ctx, 1)
      const run = (await readRealConversation(ctx)).runs[0]!
      const page = await settledChanges(ctx, run.id)
      expect(await readFile(join(ctx.projectDirectory, 'a.ts'), 'utf8')).toBe(edited)
      expect(page.files).toHaveLength(1)
      expect(page.files[0]).toMatchObject({
        path: 'a.ts',
        beforeAvailable: false,
        undoStrategy: 'unavailable',
      })
      expect(page.files[0]?.patchVersions?.length).toBeGreaterThan(0)
      const card = ctx.page.locator(`[data-pact-workspace-changes="${run.id}"]`)
      await expect(card.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
      await expect(card).toContainText(/complete|original|final|patch/iu)
      const patch = await ctx.page.evaluate(async (id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.readWorkspaceChangeFile({
          changeSetId: id,
          path: 'a.ts',
          side: 'patch',
          patchIndex: 0,
        })
      }, run.id)
      expect(patch.ok).toBe(true)
      expect(JSON.stringify(patch)).toContain('before')
      expect(JSON.stringify(patch)).toContain('after')
      await card.getByRole('button', { name: 'View changes', exact: true }).click()
      await expect(ctx.page.getByRole('button', { name: 'Close changes preview' })).toBeVisible()
      await ctx.page.getByRole('button', { name: 'Close changes preview' }).click()
      await restartRealWorkspace(ctx)
      await expect(
        ctx.page
          .locator(`[data-pact-workspace-changes="${run.id}"]`)
          .getByRole('button', { name: 'Undo', exact: true }),
      ).toBeDisabled()
      expect(await readFile(join(ctx.projectDirectory, 'a.ts'), 'utf8')).toBe(edited)
      expect((await readRealConversation(ctx)).runs).toHaveLength(1)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

async function settledChanges(ctx: RealWorkspace, id: string): Promise<WorkspaceChangesPage> {
  let value: WorkspaceChangesPage | undefined
  await expect
    .poll(
      async () => {
        const result = await ctx.page.evaluate(async (changeSetId) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.readWorkspaceChanges({ changeSetId })
        }, id)
        if (result.ok) value = result.value
        return result.ok && result.value.changeSet.state !== 'recording'
      },
      { timeout: 60_000, intervals: [250, 500] },
    )
    .toBe(true)
  if (!value) throw new Error('Actual Native file-change record is unavailable')
  return value
}

async function finishWithOwnedApprovals(
  ctx: RealWorkspace,
  count: number,
  agentId: 'claude' | 'codex' = 'claude',
): Promise<void> {
  const observer = new AbortController()
  let settled = false,
    failure: unknown
  const completion = waitForRealCompletion(ctx, count, ctx.sessionId, [], observer.signal).then(
    () => {
      settled = true
      return undefined
    },
    (error) => {
      failure = error
      settled = true
      return undefined
    },
  )
  const deadline = Date.now() + 180_000
  let approved = 0
  try {
    // oxlint-disable-next-line no-unmodified-loop-condition -- The independently observed real completion settles this bounded approval loop.
    while (!settled && Date.now() < deadline) {
      const card = ctx.page.getByRole('region', {
        name: `${agentId === 'claude' ? 'Claude Code' : 'Codex'} permission request`,
        exact: true,
      })
      // oxlint-disable-next-line no-await-in-loop -- Each current real approval must be inspected before answering it.
      if (await card.isVisible()) {
        const once = card.getByRole('button', {
          name: agentId === 'claude' ? 'Allow this tool call' : 'Allow these file changes',
          exact: true,
        })
        // oxlint-disable-next-line no-await-in-loop -- Wait for the current request's separately fetched Native actions.
        await expect(once).toBeVisible({ timeout: 20_000 })
        // oxlint-disable-next-line no-await-in-loop -- Grant only the two owned Edit operations, never a generic tool or global permission.
        const text = await card.innerText()
        const paths = [...text.matchAll(/^File: (.+)$/gmu)].map((match) => match[1]!)
        const ownedScope =
          agentId === 'claude'
            ? text.includes(ctx.projectDirectory) && text.includes('Edit')
            : paths.length === 1 &&
              resolve(ctx.projectDirectory, paths[0]!) === join(ctx.projectDirectory, 'a.ts')
        if (++approved > 4 || !ownedScope) throw new Error('Unexpected Native permission scope')
        // oxlint-disable-next-line no-await-in-loop -- One native tool action, no retained Session grant.
        await once.click()
      }
      // oxlint-disable-next-line no-await-in-loop -- Keep this bounded UI approval observer below streaming cadence.
      await new Promise((resume) => setTimeout(resume, 200))
    }
    if (!settled)
      throw new Error('Actual Native editing did not finish within its approval deadline')
    await completion
    if (failure) throw failure
  } finally {
    observer.abort()
    await completion
  }
}

async function diskState(
  ctx: RealWorkspace,
): Promise<Array<{ path: string; hash: string; mode: number }>> {
  return Promise.all(
    ['a.ts', 'z.ts', 'unrelated.txt'].map(async (path) => ({
      path,
      hash: digest(await readFile(join(ctx.projectDirectory, path), 'utf8')),
      mode: (await stat(join(ctx.projectDirectory, path))).mode & 0o777,
    })),
  )
}
