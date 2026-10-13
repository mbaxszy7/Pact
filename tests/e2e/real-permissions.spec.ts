import { expect } from '@playwright/test'
import { open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'

import type { ConversationSnapshot, DesktopBridge } from '../../packages/contracts/src/index.js'

import {
  addRealSession,
  authMarker,
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  selectRealAskPermission,
  selectRealSession,
  sendRealMessage,
  waitForRealCompletion,
  type RealWorkspace,
} from './real-harness.js'
import { findNativeRecord } from './real-native-evidence.js'
import { test } from './runtime-fixture.js'
import { matchesWindowsCommandApproval, windowsTextCommand } from './windows-test-command.js'

for (const choice of ['once', 'session'] as const) {
  test(
    `real ${choice} permission executes its actual command and does not grant a new Session`,
    { tag: '@real' },
    async () => {
      test.setTimeout(600_000)
      const context = await launchRealWorkspace(`real-permission-${choice}`)
      const agentId = 'codex'
      const allowLabel = choice === 'session' ? 'Allow for this turn' : 'Allow this command'
      let activeSessionId = context.sessionId
      try {
        if (choice === 'session') {
          // This Native tool is disabled by default in CLI 0.159.2. Enable only
          // its capability in the owned copy; original auth/model files stay exact.
          await context.app.close()
          const path = join(context.fixture.codexHome, 'config.toml')
          const original = await readFile(path, 'utf8')
          const configuration = parse(original)
          const features = configuration['features']
          if (
            features != null &&
            (typeof features !== 'object' || Array.isArray(features) || features instanceof Date)
          )
            throw new Error('Native feature configuration is not a table')
          const owned = stringify({
            ...configuration,
            features: Object.assign({}, features, { request_permissions_tool: true }),
          })
          await writeFile(path, owned, { mode: 0o600 })
          context.app = await context.fixture.launch()
          context.page = await context.app.firstWindow()
          await selectRealSession(context, context.sessionId)
          await test.info().attach('owned-native-capability', {
            body: JSON.stringify({
              request_permissions_tool: true,
              sourceConfigurationUnchanged: true,
            }),
            contentType: 'application/json',
          })
        }
        await askMode(context, context.sessionId, agentId)
        const marker = authMarker('PERMISSION')
        const filename = `permission-${choice}.txt`
        const command =
          process.platform === 'win32'
            ? windowsTextCommand(marker, filename, { newline: true })
            : `printf '%s\\n' '${marker}' >> ../${filename}`
        const prompt =
          choice === 'session'
            ? `Use the request_permissions tool to ask for write access to exactly ${join(context.fixture.directory, filename)} in this session. Do not ask for any other filesystem or network access. After the user approves those requested permissions, execute exactly this shell command once: ${command}. Do not read any other files or alter permissions. After successful execution reply with ${marker}.`
            : `Execute exactly this shell command once: ${command}. The destination is outside the project but inside my isolated test directory. Request sandbox escalation with justification if required. Do not read any other files or alter permissions. After successful execution reply with ${marker}.`
        await sendRealMessage(context, prompt, agentId)
        const card = context.page.getByRole('region', {
          name: 'Codex permission request',
          exact: true,
        })
        await expect(card.getByRole('button', { name: allowLabel, exact: true })).toBeVisible({
          timeout: 120_000,
        })
        if (choice === 'session')
          await expect(
            card.getByRole('button', { name: 'Allow for this session…', exact: true }),
          ).toBeVisible()
        await expect(
          card.getByRole('button', { name: /command rule|host rule|permission changes/iu }),
        ).toHaveCount(0)
        const firstApproval =
          process.platform === 'win32'
            ? (await readRealConversation(context)).nativeContexts
                .flatMap((binding) => binding.permissionRequests ?? [])
                .map((request) => request.id)
            : []
        if (choice === 'session') {
          await card.getByRole('button', { name: 'Allow for this session…', exact: true }).click()
          await expect(
            card.getByRole('group', { name: 'Confirm native permission scope' }),
          ).toBeVisible()
          await card.getByRole('button', { name: 'Confirm native action', exact: true }).click()
        } else await card.getByRole('button', { name: allowLabel, exact: true }).click()
        const completed =
          process.platform === 'win32'
            ? await completeApprovedWindowsRun(context, context.sessionId, command, firstApproval, {
                path: join(context.fixture.directory, filename),
                before: '',
              })
            : await waitForRealCompletion(context, 1)
        expect(completed.runs[0]?.permissionMode).toBe('ask')
        expect(completed.messages.find((row) => row.role === 'assistant')?.content).toContain(
          marker,
        )
        expect(await readFile(join(context.fixture.directory, filename), 'utf8')).toBe(
          marker + '\n',
        )
        await expect(card).toHaveCount(0)
        const settings = await context.page.evaluate(async (id) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.getSessionSettings(id)
        }, context.sessionId)
        expect(settings.ok && settings.value.session.settings.permissionModes?.[agentId]).toBe(
          'ask',
        )
        const second = await addRealSession(context, `New permission Session ${choice}`)
        activeSessionId = second
        await selectRealSession(context, second)
        await askMode(context, second, agentId)
        await sendRealMessage(context, prompt, agentId)
        await expect(card.getByRole('button', { name: allowLabel, exact: true })).toBeVisible({
          timeout: 120_000,
        })
        // A different Native Session must ask again; never borrow the earlier grant.
        const secondApproval =
          process.platform === 'win32'
            ? (await readRealConversation(context, second)).nativeContexts
                .flatMap((binding) => binding.permissionRequests ?? [])
                .map((request) => request.id)
            : []
        await card.getByRole('button', { name: allowLabel, exact: true }).click()
        const next =
          process.platform === 'win32'
            ? await completeApprovedWindowsRun(context, second, command, secondApproval, {
                path: join(context.fixture.directory, filename),
                before: marker + '\n',
              })
            : await waitForRealCompletion(context, 1, second)
        expect(next.runs[0]?.nativeSessionId).not.toBe(completed.runs[0]?.nativeSessionId)
        expect(await readFile(join(context.fixture.directory, filename), 'utf8')).toBe(
          marker + '\n' + marker + '\n',
        )
        expect((await readRealConversation(context)).runs).toHaveLength(1)
      } catch (error) {
        if (process.platform === 'win32') {
          try {
            const snapshot = await readRealConversation(context, activeSessionId)
            const binding = snapshot.nativeContexts.find((row) => row.agentId === 'codex')
            const native = binding
              ? await findNativeRecord(context, 'codex', binding.nativeSessionId).catch(
                  () => undefined,
                )
              : undefined
            const data = context.fixture.redactDiagnostic(
              JSON.stringify({
                activeSessionId,
                runs: snapshot.runs,
                nativeContexts: snapshot.nativeContexts,
                native: native
                  ? {
                      toolNames: native.toolNames,
                      commandCalls: native.commandCalls,
                      commandResults: native.commandResults,
                      modelStarts: native.codexModelStarts,
                    }
                  : null,
              }),
            )
            if (Buffer.byteLength(data) > 64 * 1024)
              throw new Error('Permission diagnostic exceeds 64 KiB', { cause: error })
            const path = test.info().outputPath(`windows-permission-${choice}.json`)
            await writeFile(path, data)
            await test
              .info()
              .attach(`windows-permission-${choice}`, { path, contentType: 'application/json' })
          } catch {
            // Keep the actual assertion even when Native evidence is unavailable.
          }
        }
        throw error
      } finally {
        await closeRealWorkspace(context)
      }
    },
  )
}

/** A Windows file grant can be followed by a separate command approval; never wait past it silently. */
async function completeApprovedWindowsRun(
  context: RealWorkspace,
  sessionId: string,
  command: string,
  grantedIds: string[],
  output: { path: string; before: string },
): Promise<ConversationSnapshot> {
  const handled = new Set(grantedIds)
  let commandApprovals = 0
  let completed: ConversationSnapshot | undefined
  await expect
    .poll(
      async () => {
        const snapshot = await readRealConversation(context, sessionId)
        if (snapshot.runs.some((run) => ['failed', 'interrupted'].includes(run.status)))
          throw new Error('The approved Windows permission Run failed before completion')
        for (const request of snapshot.nativeContexts.flatMap(
          (binding) => binding.permissionRequests ?? [],
        )) {
          if (handled.has(request.id)) continue
          if (!request.operationId)
            throw new Error('Pending approval lacks its owned operation identity')
          // oxlint-disable-next-line no-await-in-loop -- Inspect each bounded native request before deciding its exact action.
          const details = await context.page.evaluate(
            async (input) => {
              const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
              return bridge.readNativeInput(input)
            },
            { operationId: request.operationId, requestId: request.id },
          )
          const path = test.info().outputPath(`windows-followup-approval-${sessionId}.json`)
          // oxlint-disable-next-line no-await-in-loop -- Persist only this bounded, redacted approval before acting.
          await writeFile(path, context.fixture.redactDiagnostic(JSON.stringify(details)))
          if (
            !details.ok ||
            details.value.kind !== 'approval' ||
            details.value.title !== 'Codex wants to run a command' ||
            !matchesWindowsCommandApproval(
              details.value.detail,
              command,
              context.projectDirectory,
              output.path,
            ) ||
            commandApprovals !== 0
          )
            throw new Error(
              `Unexpected follow-up approval; no action was approved. Diagnostic: ${path}`,
            )
          // Native may ask again after an unsuccessful sandbox attempt. Only approve
          // while this Run's exact destination remains at its original contents.
          // oxlint-disable-next-line no-await-in-loop -- Check the single owned destination before one further approval.
          const before = await (async () => {
            const file = await open(output.path, 'r')
            try {
              const info = await file.stat()
              if (!info.isFile() || info.size > 1024)
                throw new Error('Owned command destination exceeds its 1 KiB preimage bound')
              const bytes = Buffer.alloc(1025)
              const read = await file.read(bytes, 0, bytes.length, 0)
              if (read.bytesRead > 1024)
                throw new Error('Owned command destination grew beyond its preimage bound')
              return bytes.subarray(0, read.bytesRead).toString('utf8')
            } finally {
              await file.close()
            }
          })().catch((error: unknown) => {
            if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return ''
            throw error
          })
          if (before !== output.before)
            throw new Error(
              'The requested command already changed its destination; no repeat was approved',
            )
          handled.add(request.id)
          commandApprovals++
          // Only this already requested command, never a retained rule or a new permission grant.
          // oxlint-disable-next-line no-await-in-loop -- One exact native command approval is allowed after the file grant.
          await context.page
            .getByRole('region', { name: 'Codex permission request', exact: true })
            .getByRole('button', { name: 'Allow this command', exact: true })
            .click()
        }
        if (snapshot.runs.length === 1 && snapshot.runs[0]?.status === 'completed') {
          completed = snapshot
          return true
        }
        return false
      },
      { timeout: 300_000, intervals: [250, 500, 1000] },
    )
    .toBe(true)
  if (!completed) throw new Error('Approved Windows Run did not produce a completed snapshot')
  return completed
}

async function askMode(
  context: RealWorkspace,
  sessionId: string,
  agentId: 'claude' | 'codex',
): Promise<void> {
  if (process.platform === 'win32') {
    await selectRealAskPermission({ ...context, sessionId }, agentId)
    return
  }
  const result = await context.page.evaluate(
    async ({ id, agentId: selectedAgent }) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const settings = await bridge.getSessionSettings(id)
      if (!settings.ok) throw new Error('Session permission revision unavailable')
      return bridge.saveSessionPermission({
        sessionId: id,
        agentId: selectedAgent,
        mode: 'ask',
        expectedRevision: settings.value.session.settingsRevision,
        confirmedFullAccess: false,
      })
    },
    { id: sessionId, agentId },
  )
  expect(result.ok).toBe(true)
}
