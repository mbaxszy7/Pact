import { expect, type Locator } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  AgentModelCatalog,
  AgentModelSelection,
  AgentRun,
  DefaultSessionSettings,
  DesktopBridge,
  RuntimeAgentId,
  SessionSettingsEditorState,
} from '../../packages/contracts/src/index.js'

import {
  addRealSession,
  authMarker,
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  restartRealWorkspace,
  selectRealAskPermission,
  selectRealSession,
  sendRealMessage,
  waitForRealCompletion,
  type RealWorkspace,
} from './real-harness.js'
import { resolveRealConfiguredModel } from './real-model-selection.js'
import {
  findNativeRecord,
  readCodexNativeDefaults,
  type NativeEvidence,
} from './real-native-evidence.js'
import { test } from './runtime-fixture.js'
import { windowsTextCommand } from './windows-test-command.js'

interface Selections {
  model: string
  firstEffort: string
  nextEffort: string
}

test(
  'real defaults and Session overrides preserve frozen native settings, next-task routing and cold copies',
  { tag: '@real' },
  async () => {
    // Six explicit user tasks: CLI default, then E1/E2 for each actual Agent.
    test.setTimeout(840_000)
    const ctx = await launchRealWorkspace('real-settings')
    const originalSessionId = ctx.sessionId
    try {
      const originalSettings = await sessionSettings(ctx)
      expect(originalSettings.session.settings.agents).toEqual({
        claude: { model: null, effort: null },
        codex: { model: null, effort: null },
      })
      const originalDefault = await appDefaults(ctx)
      const configuredModels = ctx.fixture.readConfigurationModels()

      await askBothAgents(ctx)
      // This independent, zero-Turn client reads the real project defaults.
      // A nullable config field and an omitted rollout field are distinct facts;
      // neither proves a backend's otherwise unreported inference effort.
      const nativeDefaultsClient = await ctx.fixture.openCodexClient()
      const nativeCodexDefaults = await (async () => {
        try {
          return readCodexNativeDefaults(
            await nativeDefaultsClient.request('config/read', {
              cwd: ctx.projectDirectory,
              includeLayers: false,
            }),
          )
        } finally {
          await nativeDefaultsClient.close()
        }
      })()
      const defaultCodexMarker = authMarker('CODEX_CLI_DEFAULT')
      await sendRealMessage(
        ctx,
        `Briefly acknowledge ${defaultCodexMarker}. Do not use tools, read files or write files.`,
      )
      const defaultCodex = await waitForRealCompletion(ctx, 1)
      const codexDefaultRun = requireRun(defaultCodex.runs, 0, 'codex')
      expect((await sessionSettings(ctx)).session.settings.agents.codex).toEqual({
        model: null,
        effort: null,
      })
      const codexDefaultEvidence = await findNativeRecord(
        ctx,
        'codex',
        requireNativeId(codexDefaultRun),
      )
      const codexEffectiveDefault = requireCodexTurn(codexDefaultEvidence, codexDefaultRun)
      await test.info().attach('actual-codex-default-settings', {
        body: ctx.fixture.redactDiagnostic(
          JSON.stringify({
            configRead: nativeCodexDefaults,
            turnContext: codexEffectiveDefault,
            frozenRun: { model: codexDefaultRun.model, effort: codexDefaultRun.effort },
            nativeModelStarts: codexDefaultEvidence.codexModelStarts,
          }),
        ),
        contentType: 'application/json',
      })
      expect(codexDefaultEvidence.codexModelStarts).toBe(1)
      expect(codexEffectiveDefault.model).toBeTruthy()
      expect(codexDefaultRun.model).toBe(codexEffectiveDefault.model)
      if (nativeCodexDefaults.model !== null)
        expect(codexEffectiveDefault.model).toBe(nativeCodexDefaults.model)
      expect(codexEffectiveDefault.effort).toBe(nativeCodexDefaults.effort.value)
      if (nativeCodexDefaults.effort.value === null) {
        // The pinned rollout serializer omits Option::None, rather than
        // manufacturing a catalog-derived concrete default.
        expect(codexEffectiveDefault.effortSource).toBe('omitted')
        expect(codexEffectiveDefault.effortFields).toEqual({
          effort: { present: false },
          reasoning_effort: { present: false },
        })
      } else {
        expect(codexEffectiveDefault.effortSource).not.toBe('omitted')
      }
      expect(codexDefaultRun.effort).toBe(codexEffectiveDefault.effort)
      if (configuredModels.codex) expect(codexEffectiveDefault.model).toBe(configuredModels.codex)
      expect(codexDefaultEvidence.containsText(defaultCodexMarker)).toBe(true)

      const claudeDefaultMarker = authMarker('CLAUDE_CLI_DEFAULT')
      const claudeDefaultFile = 'claude-default-effort.txt'
      const claudeDefaultCommand = effortCommand(claudeDefaultMarker, claudeDefaultFile)
      await sendRealMessage(ctx, toolPrompt(claudeDefaultCommand), 'claude')
      await approveActualCommand(ctx, 'claude', claudeDefaultCommand)
      const defaultsCompleted = await waitForRealCompletion(ctx, 2)
      const claudeDefaultRun = requireRun(defaultsCompleted.runs, 1, 'claude')
      expect((await sessionSettings(ctx)).session.settings.agents.claude).toEqual({
        model: null,
        effort: null,
      })
      const claudeDefaultEvidence = await findNativeRecord(
        ctx,
        'claude',
        requireNativeId(claudeDefaultRun),
      )
      requireActualShellCommand(ctx, claudeDefaultEvidence, claudeDefaultCommand)
      const claudeEffectiveDefault = await readEffortProof(
        ctx,
        claudeDefaultFile,
        claudeDefaultMarker,
      )
      expect(claudeDefaultEvidence.assistantModels).toContain(claudeDefaultRun.model)
      expect(claudeEffectiveDefault).toBeTruthy()

      // Choices are derived from the genuine CLI catalogs and the configured
      // model metadata, never a hard-coded Model/Effort table.
      const catalogState = await sessionSettings(ctx)
      const choices = {
        codex: supportedSelections(catalogState.modelCatalogs.codex, configuredModels.codex),
        claude: supportedSelections(catalogState.modelCatalogs.claude, configuredModels.claude),
      }
      const templateOne: DefaultSessionSettings = {
        ...originalDefault,
        primaryAgentId: 'codex',
        agents: {
          codex: selection(choices.codex, 'first'),
          claude: selection(choices.claude, 'first'),
        },
        maxDiscussionRounds: 4,
        maxReviewCycles: 2,
        maxRepairAttempts: 2,
      }
      await saveAppSettingsUI(ctx, templateOne)
      expect((await sessionSettings(ctx, originalSessionId)).session.settings.agents).toEqual(
        originalSettings.session.settings.agents,
      )
      const workingSessionId = await addRealSession(ctx, 'Frozen real settings')
      await selectRealSession(ctx, workingSessionId)
      ctx.sessionId = workingSessionId
      expect((await sessionSettings(ctx)).session.settings).toMatchObject(templateOne)

      const templateTwo: DefaultSessionSettings = {
        ...templateOne,
        primaryAgentId: 'claude',
        agents: {
          codex: selection(choices.codex, 'next'),
          claude: selection(choices.claude, 'next'),
        },
        maxDiscussionRounds: 5,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      }
      await saveAppSettingsUI(ctx, templateTwo)
      expect((await sessionSettings(ctx)).session.settings).toMatchObject(templateOne)
      const futureSessionId = await addRealSession(ctx, 'New default copy')
      expect((await sessionSettings(ctx, futureSessionId)).session.settings).toMatchObject(
        templateTwo,
      )
      const sessionOverride = { ...templateOne, maxDiscussionRounds: 6 }
      await saveSessionSettingsUI(ctx, sessionOverride)
      expect(await appDefaults(ctx)).toEqual(templateTwo)
      expect((await sessionSettings(ctx, futureSessionId)).session.settings).toMatchObject(
        templateTwo,
      )
      await askBothAgents(ctx)
      await restartRealWorkspace(ctx)
      expect((await sessionSettings(ctx)).session.settings).toMatchObject(sessionOverride)
      expect(await appDefaults(ctx)).toEqual(templateTwo)
      expect(
        (await readRealConversation(ctx, originalSessionId)).runs.map((run) => run.id),
      ).toEqual(defaultsCompleted.runs.map((run) => run.id))
      expect((await readRealConversation(ctx, futureSessionId)).runs).toHaveLength(0)

      const codexOld = await sessionSettings(ctx)
      const codexMarker = authMarker('CODEX_FROZEN_SETTINGS')
      const codexFile = 'codex-settings-gate.txt'
      const codexCommand =
        process.platform === 'win32'
          ? windowsTextCommand(codexMarker, codexFile, { newline: true, replace: true })
          : `printf '%s\\n' '${codexMarker}' > ../${codexFile}`
      await sendRealMessage(ctx, toolPrompt(codexCommand))
      const codexCard = await pendingActualCommand(ctx, 'codex', codexCommand)
      const codexCardId = await codexCard.getAttribute('data-pact-native-permission')
      const codexPending = await readRealConversation(ctx)
      const codexPendingRun = requireRun(codexPending.runs, 0, 'codex')
      expect(codexPendingRun).toMatchObject({
        status: 'running',
        settingsRevision: codexOld.session.settingsRevision,
        effort: choices.codex.firstEffort,
      })
      const codexNext: DefaultSessionSettings = {
        ...sessionOverride,
        agents: { ...sessionOverride.agents, codex: selection(choices.codex, 'next') },
        maxReviewCycles: 4,
      }
      await saveSessionSettingsUI(ctx, codexNext)
      await requireFrozenPending(ctx, codexPendingRun, codexCard, codexCardId)
      expect(await appDefaults(ctx)).toEqual(templateTwo)
      await codexCard.getByRole('button', { name: 'Allow this command', exact: true }).click()
      const firstCodex = await waitForRealCompletion(ctx, 1)
      const firstCodexRun = requireRun(firstCodex.runs, 0, 'codex')
      const firstCodexEvidence = await findNativeRecord(
        ctx,
        'codex',
        requireNativeId(firstCodexRun),
      )
      expect(requireCodexTurn(firstCodexEvidence, firstCodexRun)).toMatchObject({
        model: choices.codex.model,
        effort: choices.codex.firstEffort,
      })
      requireActualShellCommand(ctx, firstCodexEvidence, codexCommand)
      expect(await readBoundedScalar(join(ctx.fixture.directory, codexFile))).toBe(
        codexMarker + '\n',
      )

      const codexNextMarker = authMarker('CODEX_NEXT_SETTINGS')
      await sendRealMessage(
        ctx,
        `Briefly acknowledge ${codexNextMarker}. Do not use tools, read files or write files.`,
      )
      const secondCodex = await waitForRealCompletion(ctx, 2)
      const secondCodexRun = requireRun(secondCodex.runs, 1, 'codex')
      expect(secondCodexRun.settingsRevision).toBeGreaterThan(firstCodexRun.settingsRevision)
      expect(secondCodexRun.nativeSessionId).toBe(firstCodexRun.nativeSessionId)
      const secondCodexEvidence = await findNativeRecord(
        ctx,
        'codex',
        requireNativeId(secondCodexRun),
      )
      expect(requireCodexTurn(secondCodexEvidence, secondCodexRun)).toMatchObject({
        model: choices.codex.model,
        effort: choices.codex.nextEffort,
      })
      expect(secondCodexEvidence.codexModelStarts).toBe(2)
      expect(secondCodexEvidence.containsText(codexNextMarker)).toBe(true)

      const claudeOld: DefaultSessionSettings = { ...codexNext, primaryAgentId: 'claude' }
      await saveSessionSettingsUI(ctx, claudeOld)
      const claudeOldState = await sessionSettings(ctx)
      expect(claudeOldState.session.settings.agents).toEqual(codexNext.agents)
      const claudeMarker = authMarker('CLAUDE_FROZEN_SETTINGS')
      const claudeFile = 'claude-frozen-effort.txt'
      const claudeCommand = effortCommand(claudeMarker, claudeFile)
      await sendRealMessage(ctx, toolPrompt(claudeCommand))
      const claudeCard = await pendingActualCommand(ctx, 'claude', claudeCommand)
      const claudeCardId = await claudeCard.getAttribute('data-pact-native-permission')
      const claudePending = await readRealConversation(ctx)
      const claudePendingRun = requireRun(claudePending.runs, 2, 'claude')
      expect(claudePendingRun).toMatchObject({
        status: 'running',
        settingsRevision: claudeOldState.session.settingsRevision,
        effort: choices.claude.firstEffort,
      })
      const claudeNext: DefaultSessionSettings = {
        ...claudeOld,
        agents: { ...claudeOld.agents, claude: selection(choices.claude, 'next') },
        maxRepairAttempts: 4,
      }
      await saveSessionSettingsUI(ctx, claudeNext)
      await requireFrozenPending(ctx, claudePendingRun, claudeCard, claudeCardId)
      await claudeCard.getByRole('button', { name: 'Allow this tool call', exact: true }).click()
      const firstClaude = await waitForRealCompletion(ctx, 3)
      const firstClaudeRun = requireRun(firstClaude.runs, 2, 'claude')
      expect(await readEffortProof(ctx, claudeFile, claudeMarker)).toBe(choices.claude.firstEffort)
      const firstClaudeEvidence = await findNativeRecord(
        ctx,
        'claude',
        requireNativeId(firstClaudeRun),
      )
      requireActualShellCommand(ctx, firstClaudeEvidence, claudeCommand)
      expect(firstClaudeEvidence.assistantModels).toContain(firstClaudeRun.model)
      expect(new Set(firstClaudeEvidence.assistantModels)).toEqual(
        new Set(claudeDefaultEvidence.assistantModels),
      )

      const claudeNextMarker = authMarker('CLAUDE_NEXT_SETTINGS')
      const claudeNextFile = 'claude-next-effort.txt'
      const claudeNextCommand = effortCommand(claudeNextMarker, claudeNextFile)
      await sendRealMessage(ctx, toolPrompt(claudeNextCommand))
      await approveActualCommand(ctx, 'claude', claudeNextCommand)
      const completed = await waitForRealCompletion(ctx, 4)
      const secondClaudeRun = requireRun(completed.runs, 3, 'claude')
      expect(secondClaudeRun.settingsRevision).toBeGreaterThan(firstClaudeRun.settingsRevision)
      expect(secondClaudeRun.nativeSessionId).toBe(firstClaudeRun.nativeSessionId)
      expect(await readEffortProof(ctx, claudeNextFile, claudeNextMarker)).toBe(
        choices.claude.nextEffort,
      )
      const secondClaudeEvidence = await findNativeRecord(
        ctx,
        'claude',
        requireNativeId(secondClaudeRun),
      )
      requireActualShellCommand(ctx, secondClaudeEvidence, claudeNextCommand)
      expect(secondClaudeEvidence.assistantModels).toContain(secondClaudeRun.model)
      expect(new Set(secondClaudeEvidence.assistantModels)).toEqual(
        new Set(claudeDefaultEvidence.assistantModels),
      )
      expect(secondClaudeEvidence.claudeUserInputs).toBe(2)
      expect(completed.runs.map((run) => run.agentId)).toEqual([
        'codex',
        'codex',
        'claude',
        'claude',
      ])
      expect(completed.runs.every((run) => run.status === 'completed')).toBe(true)
      expect(completed.messages.filter((row) => row.role === 'assistant')).toHaveLength(4)
      expect((await readRealConversation(ctx, originalSessionId)).runs).toHaveLength(2)
      expect((await readRealConversation(ctx, futureSessionId)).runs).toHaveLength(0)
      expect(await appDefaults(ctx)).toEqual(templateTwo)

      await restartRealWorkspace(ctx)
      const cold = await readRealConversation(ctx)
      expect(cold.runs.map((run) => run.id)).toEqual(completed.runs.map((run) => run.id))
      expect(cold.nativeContexts.map((binding) => binding.nativeSessionId)).toEqual(
        completed.nativeContexts.map((binding) => binding.nativeSessionId),
      )
      expect((await sessionSettings(ctx)).session.settings).toMatchObject(claudeNext)
      expect((await sessionSettings(ctx, futureSessionId)).session.settings).toMatchObject(
        templateTwo,
      )
      expect(await appDefaults(ctx)).toEqual(templateTwo)
      expect((await findNativeRecord(ctx, 'codex', requireNativeId(secondCodexRun))).sha256).toBe(
        secondCodexEvidence.sha256,
      )
      expect((await findNativeRecord(ctx, 'claude', requireNativeId(secondClaudeRun))).sha256).toBe(
        secondClaudeEvidence.sha256,
      )
      await test.info().attach('actual-native-settings', {
        body: ctx.fixture.redactDiagnostic(
          JSON.stringify({
            cliDefaults: {
              codex: {
                configRead: nativeCodexDefaults,
                turnContext: codexEffectiveDefault,
                frozenRun: { model: codexDefaultRun.model, effort: codexDefaultRun.effort },
                nativeEffortSelection:
                  nativeCodexDefaults.effort.value === null ? 'unspecified' : 'named',
              },
              claude: {
                models: claudeDefaultEvidence.assistantModels,
                effort: claudeEffectiveDefault,
              },
            },
            explicitSelections: choices,
            runs: completed.runs.map((run) => ({
              id: run.id,
              agentId: run.agentId,
              settingsRevision: run.settingsRevision,
              nativeSessionId: run.nativeSessionId,
              nativeTurnId: run.nativeTurnId,
            })),
            codexTurnSettings: secondCodexEvidence.codexTurnSettings,
            claudeObservedEfforts: [choices.claude.firstEffort, choices.claude.nextEffort],
            sourceConfigurationUnchanged: true,
            savedCollaborationLimitsAreMetadataOnly: true,
          }),
        ),
        contentType: 'application/json',
      })
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)

function supportedSelections(
  catalog: AgentModelCatalog,
  configuredModel: string | null,
): Selections {
  if (catalog.status !== 'available')
    throw new Error(`${catalog.agentId} actual CLI catalog is unavailable`)
  const configured = resolveRealConfiguredModel(catalog, configuredModel)
  if (configured.supportedEfforts.length < 2)
    throw new Error(
      `${catalog.agentId} configured model has fewer than two native-supported effort options`,
    )
  const efforts = [...new Set(configured.supportedEfforts)]
  if (efforts.length < 2)
    throw new Error(`${catalog.agentId} lacks two distinct native effort options`)
  return {
    model: configured.id,
    firstEffort: efforts[0]!,
    nextEffort: efforts[Math.max(1, Math.floor(efforts.length / 2))]!,
  }
}

function selection(options: Selections, phase: 'first' | 'next'): AgentModelSelection {
  return {
    model: options.model,
    effort: phase === 'first' ? options.firstEffort : options.nextEffort,
  }
}

async function sessionSettings(
  ctx: RealWorkspace,
  sessionId = ctx.sessionId,
): Promise<SessionSettingsEditorState> {
  return ctx.page.evaluate(async (id) => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    const result = await bridge.getSessionSettings(id)
    if (!result.ok) throw new Error('Actual Session settings could not be read')
    return result.value
  }, sessionId)
}

async function appDefaults(ctx: RealWorkspace): Promise<DefaultSessionSettings> {
  return ctx.page.evaluate(async () => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    const result = await bridge.getDefaultSessionSettingsEditorState()
    if (!result.ok || !result.value.current)
      throw new Error('App default settings could not be read')
    return result.value.current.settings
  })
}

async function saveAppSettingsUI(
  ctx: RealWorkspace,
  settings: DefaultSessionSettings,
): Promise<void> {
  await ctx.page.getByRole('button', { name: /^(Open settings|Settings)$/u }).click()
  await ctx.page.getByRole('button', { name: 'Default session', exact: true }).click()
  await expect(
    ctx.page.getByRole('heading', { name: 'Default session settings', exact: true }),
  ).toBeVisible()
  await changeSettingsFields(ctx.page.locator('form'), settings)
  await ctx.page.getByRole('button', { name: 'Save defaults', exact: true }).click()
  await expect(ctx.page.getByRole('button', { name: 'Save defaults', exact: true })).toBeDisabled()
  expect(await appDefaults(ctx)).toEqual(settings)
  await ctx.page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await selectRealSession(ctx, ctx.sessionId)
}

async function saveSessionSettingsUI(
  ctx: RealWorkspace,
  settings: DefaultSessionSettings,
): Promise<void> {
  const before = await sessionSettings(ctx)
  await ctx.page.getByRole('button', { name: 'Session settings', exact: true }).click()
  const panel = ctx.page.getByRole('region', { name: 'Session settings', exact: true })
  await expect(panel).toBeVisible()
  await changeSettingsFields(panel, settings)
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  const after = await sessionSettings(ctx)
  expect(after.session.settings).toMatchObject(settings)
  expect(after.session.settingsRevision).toBeGreaterThan(before.session.settingsRevision)
  await panel.getByRole('button', { name: 'Close Session settings', exact: true }).click()
}

async function changeSettingsFields(
  scope: Locator,
  settings: DefaultSessionSettings,
): Promise<void> {
  const primary = settings.primaryAgentId === 'codex' ? /^Codex /u : /^Claude Code /u
  await scope.getByRole('radio', { name: primary }).check()
  for (const agentId of ['codex', 'claude'] as const) {
    const region = scope.getByRole('region', {
      name: agentId === 'codex' ? 'Codex' : 'Claude Code',
      exact: true,
    })
    const wanted = settings.agents[agentId]
    // oxlint-disable-next-line no-await-in-loop -- Native model selection resets this Agent's dependent effort field.
    await region
      .getByRole('combobox', { name: 'Model', exact: true })
      .selectOption(wanted.model ?? '')
    // oxlint-disable-next-line no-await-in-loop -- Select only after the current genuine CLI model options have rendered.
    await region
      .getByRole('combobox', { name: 'Effort', exact: true })
      .selectOption(wanted.effort ?? '')
  }
  await scope
    .getByRole('spinbutton', { name: 'Maximum discussion rounds', exact: true })
    .fill(String(settings.maxDiscussionRounds))
  await scope
    .getByRole('combobox', { name: 'Messages sent during a run', exact: true })
    .selectOption(settings.runningMessagePolicy)
  await scope
    .getByRole('spinbutton', { name: 'Maximum review cycles', exact: true })
    .fill(String(settings.maxReviewCycles))
  await scope
    .getByRole('spinbutton', { name: 'Repair attempts per task', exact: true })
    .fill(String(settings.maxRepairAttempts))
}

async function askBothAgents(ctx: RealWorkspace): Promise<void> {
  if (process.platform === 'win32') {
    await selectRealAskPermission(ctx, 'codex')
    await selectRealAskPermission(ctx, 'claude')
    return
  }
  const outcomes = await ctx.page.evaluate(async (sessionId) => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    const results = []
    for (const agentId of ['codex', 'claude'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- Each Agent permission save observes the preceding committed revision.
      const before = await bridge.getSessionSettings(sessionId)
      if (!before.ok) throw new Error('Owned permission revision unavailable')
      results.push(
        // oxlint-disable-next-line no-await-in-loop -- Preserve the product's permission revision contract.
        await bridge.saveSessionPermission({
          sessionId,
          agentId,
          mode: 'ask',
          expectedRevision: before.value.session.settingsRevision,
          confirmedFullAccess: false,
        }),
      )
    }
    return results
  }, ctx.sessionId)
  expect(outcomes.every((result) => result.ok)).toBe(true)
}

function effortCommand(marker: string, filename: string): string {
  return `printf '%s\\n' '${marker}' "\${CLAUDE_EFFORT:?Native effort is missing}" > ../${filename}`
}

function toolPrompt(command: string): string {
  if (process.platform === 'win32')
    return `Execute exactly the shell command below once, without adding punctuation:\n\n\`\`\`\n${command}\n\`\`\`\n\nThe destination is outside the project and inside my isolated test directory. Request sandbox escalation with justification when required. Use the Bash/shell tool; do not write a guessed value with a file-edit tool, rewrite the command, inspect other files, or change permissions. After successful execution reply briefly. Do not ask another Agent for help.`
  return `Execute exactly this shell command once: ${command}. The destination is outside the project and inside my isolated test directory. Request sandbox escalation with justification when required. Use the Bash/shell tool; do not write a guessed value with a file-edit tool, rewrite the command, inspect other files, or change permissions. After successful execution reply briefly. Do not ask another Agent for help.`
}

async function pendingActualCommand(
  ctx: RealWorkspace,
  agentId: RuntimeAgentId,
  command: string,
): Promise<Locator> {
  const card = ctx.page.getByRole('region', {
    name: `${agentId === 'codex' ? 'Codex' : 'Claude Code'} permission request`,
    exact: true,
  })
  const label = agentId === 'codex' ? 'Allow this command' : 'Allow this tool call'
  try {
    await expect(card.getByRole('button', { name: label, exact: true })).toBeVisible({
      timeout: 120_000,
    })
  } catch (error) {
    const snapshot = await readRealConversation(ctx)
    const run = snapshot.runs.at(-1)
    const native = run?.nativeSessionId
      ? await findNativeRecord(ctx, agentId, run.nativeSessionId).catch(() => undefined)
      : undefined
    await test.info().attach('permission-wait-boundary', {
      body: ctx.fixture.redactDiagnostic(
        JSON.stringify({
          agentId,
          run: run && {
            status: run.status,
            dispatchPhase: run.dispatchPhase,
            failureKind: run.failureKind,
            nativeOutcome: run.nativeOutcome,
            nativeEffectsState: run.nativeEffectsState,
          },
          pendingPermissions: snapshot.pendingNativeInteractions?.length ?? 0,
          activities: snapshot.activities
            .map((item) => ({ kind: item.kind, status: item.status }))
            .slice(-16),
          native: native && {
            inputCount: agentId === 'claude' ? native.claudeUserInputs : native.codexModelStarts,
            toolNames: native.toolNames.slice(-16),
            commandCount: native.shellCommands.length,
            modelCount: native.assistantModels.length,
          },
        }),
      ),
      contentType: 'application/json',
    })
    throw error
  }
  // The card's details came from an actual CLI approval, not the User Message.
  const destination =
    process.platform === 'win32' && agentId === 'codex'
      ? command.match(/'\.\.\/([A-Za-z0-9_.-]+)'/u)?.[1]
      : command.split(' > ')[1]
  if (!destination) throw new Error('Owned command destination is unavailable')
  await expect(card.locator('pre')).toContainText(destination)
  if (agentId === 'claude') await expect(card.locator('pre')).toContainText('CLAUDE_EFFORT')
  expect(await card.getAttribute('data-pact-native-permission')).toBeTruthy()
  return card
}

async function approveActualCommand(
  ctx: RealWorkspace,
  agentId: RuntimeAgentId,
  command: string,
): Promise<void> {
  const card = await pendingActualCommand(ctx, agentId, command)
  await card
    .getByRole('button', {
      name: agentId === 'codex' ? 'Allow this command' : 'Allow this tool call',
      exact: true,
    })
    .click()
}

async function requireFrozenPending(
  ctx: RealWorkspace,
  run: AgentRun,
  card: Locator,
  cardId: string | null,
): Promise<void> {
  const after = await readRealConversation(ctx)
  const frozen = after.runs.find((candidate) => candidate.id === run.id)
  expect(frozen).toMatchObject({
    status: 'running',
    settingsRevision: run.settingsRevision,
    model: run.model,
    effort: run.effort,
  })
  expect(after.runs).toHaveLength(run.agentId === 'codex' ? 1 : 3)
  expect((await sessionSettings(ctx)).session.settingsRevision).toBeGreaterThan(
    run.settingsRevision,
  )
  await expect(card).toHaveAttribute('data-pact-native-permission', cardId!)
  await expect(
    card.getByRole('button', {
      name: run.agentId === 'codex' ? 'Allow this command' : 'Allow this tool call',
      exact: true,
    }),
  ).toBeEnabled()
}

function requireRun(runs: readonly AgentRun[], index: number, agentId: RuntimeAgentId): AgentRun {
  const run = runs[index]
  expect(run?.agentId).toBe(agentId)
  if (!run || run.agentId !== agentId)
    throw new Error('The expected real native Run is unavailable')
  return run
}

function requireNativeId(run: AgentRun): string {
  if (!run.nativeSessionId) throw new Error('Actual Native Session identity is missing')
  return run.nativeSessionId
}

function requireCodexTurn(evidence: NativeEvidence, run: AgentRun) {
  expect(run.nativeTurnId).toBeTruthy()
  const context = evidence.codexTurnSettings.find((turn) => turn.turnId === run.nativeTurnId)
  expect(
    context,
    'The authentic Native turn_context must independently report applied settings',
  ).toBeDefined()
  if (!context) throw new Error('Actual Codex turn settings are unavailable')
  return context
}

function requireActualShellCommand(
  ctx: RealWorkspace,
  evidence: NativeEvidence,
  command: string,
): void {
  if (process.platform === 'win32' && !evidence.shellCommands.includes(command)) {
    const data = ctx.fixture.redactDiagnostic(
      JSON.stringify({
        expectedCommand: command,
        toolNames: evidence.toolNames,
        execScripts: evidence.execScripts,
        commandCalls: evidence.commandCalls,
        commandResults: evidence.commandResults,
      }),
    )
    writeFileSync(
      test.info().outputPath('windows-native-command-evidence.json'),
      Buffer.byteLength(data) <= 64 * 1024
        ? data
        : JSON.stringify({ error: 'Native command diagnostic exceeds 64 KiB' }),
    )
  }
  expect(
    evidence.shellCommands,
    `A genuine Native tool call must contain the exact shell command, independent of the quoted prompt; tool names=${JSON.stringify(evidence.toolNames)}`,
  ).toContain(command)
}

async function readEffortProof(
  ctx: RealWorkspace,
  filename: string,
  marker: string,
): Promise<string> {
  const output = await readBoundedScalar(join(ctx.fixture.directory, filename))
  const lines = output.trimEnd().split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toBe(marker)
  if (!lines[1] || !/^[A-Za-z0-9_-]{1,32}$/u.test(lines[1]))
    throw new Error('This real native Claude Query did not expose a supported applied effort')
  return lines[1]
}

async function readBoundedScalar(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 512)
      throw new Error('Owned native scalar evidence exceeds 512 bytes')
    const bytes = Buffer.alloc(513)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 512) throw new Error('Owned native scalar evidence exceeds 512 bytes')
    return bytes.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}
