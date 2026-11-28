// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ActiveAgentPairInput,
  AgentModelCatalog,
  CollaborationSession,
  DefaultSessionSettings,
  DefaultSessionSettingsEditorState,
  DesktopBridge,
  Project,
  RpcResult,
  RuntimePreparation,
  SessionSettingsEditorState,
} from '@pact/contracts'

import { PermissionMenu } from '../../conversation/PermissionMenu'
import { SpeedMenu } from '../../conversation/SpeedMenu'
import {
  RuntimeDegradedNotice,
  RuntimePreparationView,
} from '../../runtime-preparation/RuntimePreparationView'
import { SessionCreationView } from '../../workspace/SessionCreationView'
import {
  DefaultSessionOnboardingView,
  DefaultSessionSettingsView,
} from './DefaultSessionSettingsView'
import { initialSessionSettings, SessionSettingsFields } from './SessionSettingsFields'
import { SessionSettingsPanel } from './SessionSettingsPanel'

const checkedAt = '2026-11-19T06:00:00.000Z'

function makeCatalog(agentId: 'claude' | 'codex' | 'agy'): AgentModelCatalog {
  return {
    agentId,
    status: 'available',
    cliVersion: `${agentId}-1.0.0`,
    models: [
      {
        id: `${agentId}-pro`,
        displayName: `${agentId.toUpperCase()} Pro`,
        supportedEfforts: ['medium', 'high'],
        defaultEffort: 'medium',
      },
    ],
    checkedAt,
  }
}

function makePreparation(
  states: Record<'claude' | 'codex' | 'agy', 'ready' | 'missing' | 'authentication_required'>,
): RuntimePreparation {
  return {
    firstUse: true,
    agents: (['claude', 'codex', 'agy'] as const).map((agentId) =>
      states[agentId] !== 'missing'
        ? {
            agentId,
            state: states[agentId],
            executablePath: `/usr/local/bin/${agentId}`,
            version: '9.9.9',
            checkedAt,
          }
        : {
            agentId,
            state: states[agentId],
            checkedAt,
          },
    ),
  }
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value: vi.fn<() => void>(),
  })
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value: vi.fn<() => void>(),
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Module 9: 2-of-3 onboarding, active-pair settings, and Antigravity controls', () => {
  it('unlocks Continue in RuntimePreparationView at >=2 of 3 ready and scopes RuntimeDegradedNotice to relevant agents', () => {
    const onContinue = vi.fn<() => void>()
    const onRetry = vi.fn<() => void>()
    const twoOfThree = makePreparation({
      claude: 'ready',
      codex: 'missing',
      agy: 'ready',
    })

    const { rerender } = render(
      <RuntimePreparationView
        preparation={twoOfThree}
        loading={false}
        canReturnToWorkspace={false}
        onBack={vi.fn<() => void>()}
        onRetry={onRetry}
        onContinue={onContinue}
        onChooseExecutable={vi.fn<() => void>()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Codex' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Antigravity' })).toBeTruthy()
    expect(screen.getByText('2 of 3 ready · Minimum 2 required')).toBeTruthy()
    const continueBtn = screen.getByRole('button', { name: 'Continue' })
    fireEvent.click(continueBtn)
    expect(onContinue).toHaveBeenCalledTimes(1)

    const oneOfThree = makePreparation({
      claude: 'ready',
      codex: 'missing',
      agy: 'authentication_required',
    })
    rerender(
      <RuntimePreparationView
        preparation={oneOfThree}
        loading={false}
        canReturnToWorkspace={false}
        onBack={vi.fn<() => void>()}
        onRetry={onRetry}
        onContinue={onContinue}
        onChooseExecutable={vi.fn<() => void>()}
      />,
    )
    expect(screen.getByText('1 of 3 ready · Minimum 2 required')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()

    cleanup()
    const { container } = render(
      <RuntimeDegradedNotice
        preparation={twoOfThree}
        relevantAgentIds={['claude', 'agy']}
        onReview={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('auto-preselects the 2 ready CLIs on first-use onboarding and disables the unready 3rd CLI with its reason', () => {
    const twoOfThree = makePreparation({
      claude: 'ready',
      codex: 'authentication_required',
      agy: 'ready',
    })
    const editorState: DefaultSessionSettingsEditorState = {
      modelCatalogs: {
        claude: makeCatalog('claude'),
        codex: makeCatalog('codex'),
        agy: makeCatalog('agy'),
      },
      recommendedPair: { primaryAgentId: 'claude', secondaryAgentId: 'agy' },
    }
    const onSave = vi.fn<(settings: DefaultSessionSettings) => void>()

    render(
      <DefaultSessionOnboardingView
        editorState={editorState}
        runtimePreparation={twoOfThree}
        loading={false}
        saving={false}
        onRetry={vi.fn<() => void>()}
        onSave={onSave}
      />,
    )

    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'Claude Code Primary agent' }).checked,
    ).toBe(true)
    const codexRadio = screen.getByRole<HTMLInputElement>('radio', {
      name: 'Codex Sign-in required',
    })
    expect(codexRadio.disabled).toBe(true)

    const secondarySelect = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Secondary agent',
    })
    expect(secondarySelect.value).toBe('agy')
    const codexOption = within(secondarySelect).getByRole<HTMLOptionElement>('option', {
      name: /Codex — Sign-in required/u,
    })
    expect(codexOption.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Save and enter Pact' }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ primaryAgentId: 'claude', secondaryAgentId: 'agy' }),
    )
  })

  it('supports all 6 (Primary, Secondary) permutations in SessionSettingsFields and SessionCreationView', () => {
    const catalogs = {
      claude: makeCatalog('claude'),
      codex: makeCatalog('codex'),
      agy: makeCatalog('agy'),
    }
    const recorded: [string, string][] = []

    function PermutationHarness() {
      const [current, setCurrent] = useState<DefaultSessionSettings>(initialSessionSettings)
      return (
        <SessionSettingsFields
          idPrefix="perm"
          settings={current}
          modelCatalogs={catalogs}
          disabled={false}
          onChange={(next) => {
            recorded.push([next.primaryAgentId, next.secondaryAgentId])
            setCurrent(next)
          }}
        />
      )
    }

    render(<PermutationHarness />)
    // Starts at (claude, codex). Switch secondary -> agy => (claude, agy)
    fireEvent.change(screen.getByRole('combobox', { name: 'Secondary agent' }), {
      target: { value: 'agy' },
    })
    // Click Antigravity as primary (current secondary) => flips to (agy, claude)
    fireEvent.click(screen.getByRole('radio', { name: 'Antigravity Set as primary agent' }))
    // Switch secondary -> codex => (agy, codex)
    fireEvent.change(screen.getByRole('combobox', { name: 'Secondary agent' }), {
      target: { value: 'codex' },
    })
    // Click Codex as primary => flips to (codex, agy)
    fireEvent.click(screen.getByRole('radio', { name: 'Codex Set as primary agent' }))
    // Switch secondary -> claude => (codex, claude)
    fireEvent.change(screen.getByRole('combobox', { name: 'Secondary agent' }), {
      target: { value: 'claude' },
    })

    expect(recorded).toEqual([
      ['claude', 'agy'],
      ['agy', 'claude'],
      ['agy', 'codex'],
      ['codex', 'agy'],
      ['codex', 'claude'],
    ])

    cleanup()
    const project: Project = {
      id: crypto.randomUUID(),
      name: 'Pact Repo',
      directoryPath: '/tmp/pact',
      kind: 'git',
      createdAt: checkedAt,
    }
    const onCreate = vi.fn<(settings: DefaultSessionSettings) => void>()
    render(
      <SessionCreationView
        project={project}
        editorState={{
          modelCatalogs: catalogs,
          current: {
            settings: {
              ...initialSessionSettings,
              primaryAgentId: 'agy',
              secondaryAgentId: 'claude',
            },
            updatedAt: checkedAt,
          },
        }}
        runtimePreparation={makePreparation({ claude: 'ready', codex: 'ready', agy: 'ready' })}
        loading={false}
        creating={false}
        onCancel={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
        onCreate={onCreate}
        onOpenAppDefaults={vi.fn<() => void>()}
      />,
    )
    expect(screen.getByText('Antigravity')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create Session' }))
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ primaryAgentId: 'agy', secondaryAgentId: 'claude' }),
    )
  })

  it('allows Primary <-> Secondary swap anytime in SessionSettingsPanel, gates 3rd-agent swap during active work, and warns on Full access reset when idle', () => {
    const baseSession: CollaborationSession = {
      id: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      title: 'Session',
      titleSource: 'local',
      status: 'idle',
      activity: { state: 'agent_working', agentId: 'claude' },
      hasUnread: false,
      settings: {
        ...initialSessionSettings,
        primaryAgentId: 'claude',
        secondaryAgentId: 'codex',
        permissionModes: { claude: 'ask', codex: 'full', agy: 'ask' },
      },
      settingsRevision: 1,
      createdAt: checkedAt,
      updatedAt: checkedAt,
    }
    const editorState: SessionSettingsEditorState = {
      session: baseSession,
      modelCatalogs: {
        claude: makeCatalog('claude'),
        codex: makeCatalog('codex'),
        agy: makeCatalog('agy'),
      },
    }
    const onSave = vi.fn<(settings: DefaultSessionSettings) => void>()

    const { rerender } = render(
      <SessionSettingsPanel
        editorState={editorState}
        runtimePreparation={makePreparation({ claude: 'ready', codex: 'ready', agy: 'ready' })}
        loading={false}
        saving={false}
        onClose={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
        onSave={onSave}
      />,
    )

    // 3rd agent (Antigravity) is locked while session is active, with inline explanation.
    expect(
      screen.getByText(
        /Wait for active or recovering agent work to finish before bringing in the third agent/u,
      ),
    ).toBeTruthy()
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'Antigravity Active pair locked' })
        .disabled,
    ).toBe(true)

    // Primary <-> Secondary swap is STILL allowed anytime!
    fireEvent.click(screen.getByRole('radio', { name: 'Codex Set as primary agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ primaryAgentId: 'codex', secondaryAgentId: 'claude' }),
    )

    // Once idle, 3rd-agent swap unlocks and warns that retiring Codex Full access resets to Ask.
    rerender(
      <SessionSettingsPanel
        key="idle"
        editorState={{
          ...editorState,
          session: { ...baseSession, activity: { state: 'idle' } },
        }}
        runtimePreparation={makePreparation({ claude: 'ready', codex: 'ready', agy: 'ready' })}
        loading={false}
        saving={false}
        onClose={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
        onSave={onSave}
      />,
    )

    fireEvent.change(screen.getByRole('combobox', { name: 'Secondary agent' }), {
      target: { value: 'agy' },
    })
    expect(
      screen.getByText(
        'Codex Full access resets to Ask when removed from this session’s active pair.',
      ),
    ).toBeTruthy()
  })

  it('supports Antigravity in PermissionMenu and keeps SpeedMenu native-only for agy', () => {
    const session: CollaborationSession = {
      id: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      title: 'Agy Controls',
      titleSource: 'local',
      status: 'idle',
      activity: { state: 'idle' },
      hasUnread: false,
      settings: {
        ...initialSessionSettings,
        primaryAgentId: 'agy',
        secondaryAgentId: 'claude',
      },
      settingsRevision: 1,
      createdAt: checkedAt,
      updatedAt: checkedAt,
    }

    render(
      <div>
        <PermissionMenu
          session={session}
          agent="agy"
          onSave={vi.fn<() => Promise<boolean>>().mockResolvedValue(true)}
          onNotice={vi.fn<() => void>()}
        />
        <SpeedMenu
          session={session}
          agent="agy"
          visible
          onSave={vi.fn<() => Promise<boolean>>().mockResolvedValue(true)}
          onNotice={vi.fn<() => void>()}
        />
      </div>,
    )

    expect(
      screen.getByRole('button', {
        name: 'Antigravity permissions for the next task: Ask for approval',
      }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Antigravity speed: Native' })).toBeTruthy()
    expect(screen.getByText('Antigravity uses its native CLI speed.')).toBeTruthy()
    const fastItem = screen.getByRole<HTMLButtonElement>('menuitemradio', {
      name: /^Fast/u,
      hidden: true,
    })
    expect(fastItem.disabled).toBe(true)
  })

  it('loads the newly selected 3rd Agent model catalog on pair switch without losing draft edits across DefaultSessionSettingsView, SessionCreationView, and SessionSettingsPanel', async () => {
    const unselectedAgyCatalog: AgentModelCatalog = {
      agentId: 'agy',
      status: 'unavailable',
      cliVersion: 'agy-1.5.9',
      models: [],
      checkedAt,
      detail: 'Select Antigravity in the active pair to load its models.',
    }
    const unselectedCodexCatalog: AgentModelCatalog = {
      agentId: 'codex',
      status: 'unavailable',
      cliVersion: 'codex-1.0.0',
      models: [],
      checkedAt,
      detail: 'Select Codex in the active pair to load its models.',
    }
    const initialDefaultsState: DefaultSessionSettingsEditorState = {
      modelCatalogs: {
        claude: makeCatalog('claude'),
        codex: makeCatalog('codex'),
        agy: unselectedAgyCatalog,
      },
      current: {
        settings: {
          ...initialSessionSettings,
          primaryAgentId: 'claude',
          secondaryAgentId: 'codex',
          agents: {
            claude: { model: 'claude-pro', effort: 'medium', speed: 'native' },
            codex: { model: 'codex-pro', effort: 'medium', speed: 'native' },
            agy: { model: 'agy-pro', effort: 'medium', speed: 'native' },
          },
        },
        updatedAt: checkedAt,
      },
    }

    const getDefaultSessionSettingsEditorState = vi.fn<
      (activePair?: ActiveAgentPairInput) => Promise<RpcResult<DefaultSessionSettingsEditorState>>
    >(async (activePair) => ({
      ok: true,
      value: {
        ...initialDefaultsState,
        modelCatalogs: {
          claude: makeCatalog('claude'),
          codex:
            activePair?.primaryAgentId === 'codex' || activePair?.secondaryAgentId === 'codex'
              ? makeCatalog('codex')
              : unselectedCodexCatalog,
          agy:
            activePair?.primaryAgentId === 'agy' || activePair?.secondaryAgentId === 'agy'
              ? makeCatalog('agy')
              : unselectedAgyCatalog,
        },
      },
    }))
    const prepareSessionCreation = vi.fn<
      (
        projectId: string,
        activePair?: ActiveAgentPairInput,
      ) => Promise<RpcResult<DefaultSessionSettingsEditorState>>
    >(async (_projectId, activePair) => getDefaultSessionSettingsEditorState(activePair))

    const session: CollaborationSession = {
      id: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      title: 'Switchable Session',
      titleSource: 'local',
      status: 'idle',
      activity: { state: 'idle' },
      hasUnread: false,
      settings: initialDefaultsState.current!.settings,
      settingsRevision: 1,
      createdAt: checkedAt,
      updatedAt: checkedAt,
    }
    const getSessionSettings = vi.fn<
      (
        sessionId: string,
        activePair?: ActiveAgentPairInput,
      ) => Promise<RpcResult<SessionSettingsEditorState>>
    >(async (_sessionId, activePair) => ({
      ok: true,
      value: {
        session,
        modelCatalogs: {
          claude: makeCatalog('claude'),
          codex:
            activePair?.primaryAgentId === 'codex' || activePair?.secondaryAgentId === 'codex'
              ? makeCatalog('codex')
              : unselectedCodexCatalog,
          agy:
            activePair?.primaryAgentId === 'agy' || activePair?.secondaryAgentId === 'agy'
              ? makeCatalog('agy')
              : unselectedAgyCatalog,
        },
      },
    }))

    const previousPact = Reflect.get(window, 'pact')
    const partialBridge: Pick<
      DesktopBridge,
      'getDefaultSessionSettingsEditorState' | 'prepareSessionCreation' | 'getSessionSettings'
    > = {
      getDefaultSessionSettingsEditorState,
      prepareSessionCreation,
      getSessionSettings,
    }
    Reflect.set(window, 'pact', partialBridge)

    try {
      // 1. DefaultSessionSettingsView: edit draft limit, switch Secondary -> Antigravity, select AGY Pro, save
      const onSaveDefaults = vi.fn<(settings: DefaultSessionSettings) => void>()
      render(
        <DefaultSessionSettingsView
          editorState={initialDefaultsState}
          runtimePreparation={makePreparation({ claude: 'ready', codex: 'ready', agy: 'ready' })}
          loading={false}
          saving={false}
          firstUse={false}
          onRetry={vi.fn<() => void>()}
          onSave={onSaveDefaults}
        />,
      )
      expect(getDefaultSessionSettingsEditorState).not.toHaveBeenCalled()

      fireEvent.change(screen.getByRole('spinbutton', { name: /Plan reviews/u }), {
        target: { value: '9' },
      })
      fireEvent.change(screen.getByRole('combobox', { name: 'Secondary agent' }), {
        target: { value: 'agy' },
      })

      await waitFor(() => {
        expect(getDefaultSessionSettingsEditorState).toHaveBeenCalledWith({
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
        })
        expect(screen.getByRole('option', { name: 'AGY Pro' })).toBeTruthy()
      })

      // Draft limit edit (9) is preserved across catalog merge and manual Refresh options!
      fireEvent.click(screen.getByRole('button', { name: 'Refresh options' }))
      await waitFor(() => {
        expect(getDefaultSessionSettingsEditorState).toHaveBeenCalledTimes(2)
      })
      fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }))
      expect(onSaveDefaults).toHaveBeenCalledWith(
        expect.objectContaining({
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
          maxDiscussionRounds: 9,
          agents: expect.objectContaining({
            agy: expect.objectContaining({ model: 'agy-pro' }),
          }),
        }),
      )

      cleanup()

      // 2. SessionCreationView (Customize this Session): saved agy.model = 'agy-pro' becomes valid & Create Session enables!
      const project: Project = {
        id: crypto.randomUUID(),
        name: 'Catalog Project',
        directoryPath: '/tmp/catalog-project',
        kind: 'git',
        createdAt: checkedAt,
      }
      const onCreate = vi.fn<(settings: DefaultSessionSettings) => void>()
      render(
        <SessionCreationView
          project={project}
          editorState={initialDefaultsState}
          runtimePreparation={makePreparation({ claude: 'ready', codex: 'ready', agy: 'ready' })}
          loading={false}
          creating={false}
          onCancel={vi.fn<() => void>()}
          onRetry={vi.fn<() => void>()}
          onCreate={onCreate}
          onOpenAppDefaults={vi.fn<() => void>()}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: /Customize this Session/u }))
      fireEvent.change(screen.getByRole('spinbutton', { name: /Code reviews/u }), {
        target: { value: '5' },
      })
      fireEvent.change(screen.getByRole('combobox', { name: 'Secondary agent' }), {
        target: { value: 'agy' },
      })

      await waitFor(() => {
        expect(prepareSessionCreation).toHaveBeenCalledWith(project.id, {
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
        })
        expect(screen.getByRole('option', { name: 'AGY Pro' })).toBeTruthy()
        expect(
          screen.getByRole<HTMLButtonElement>('button', { name: 'Create Session' }).disabled,
        ).toBe(false)
      })
      fireEvent.click(screen.getByRole('button', { name: 'Create Session' }))
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
          maxReviewCycles: 5,
        }),
      )

      cleanup()

      // 3. SessionSettingsPanel: initial modelCatalogs.agy is undefined; switching Secondary -> Antigravity loads AGY Pro
      const onSaveSession = vi.fn<(settings: DefaultSessionSettings) => void>()
      render(
        <SessionSettingsPanel
          editorState={{
            session,
            modelCatalogs: {
              claude: makeCatalog('claude'),
              codex: makeCatalog('codex'),
            },
          }}
          runtimePreparation={makePreparation({ claude: 'ready', codex: 'ready', agy: 'ready' })}
          loading={false}
          saving={false}
          onClose={vi.fn<() => void>()}
          onRetry={vi.fn<() => void>()}
          onSave={onSaveSession}
        />,
      )
      fireEvent.change(screen.getByRole('spinbutton', { name: /Repair attempts/u }), {
        target: { value: '4' },
      })
      fireEvent.change(screen.getByRole('combobox', { name: 'Secondary agent' }), {
        target: { value: 'agy' },
      })

      await waitFor(() => {
        expect(getSessionSettings).toHaveBeenCalledWith(session.id, {
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
        })
        expect(screen.getByRole('option', { name: 'AGY Pro' })).toBeTruthy()
      })
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
      expect(onSaveSession).toHaveBeenCalledWith(
        expect.objectContaining({
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
          maxRepairAttempts: 4,
        }),
      )
    } finally {
      Reflect.set(window, 'pact', previousPact)
    }
  })

  it('unlocks 3rd-agent replacement on settled quota/auth warning in paused session, live run completion, and completed forkOperation, while blocking only an unsettled retiring member', () => {
    const sessionId = crypto.randomUUID()
    const baseSession: CollaborationSession = {
      id: sessionId,
      projectId: crypto.randomUUID(),
      title: 'Session Replacement Gates',
      titleSource: 'local',
      status: 'paused',
      activity: { state: 'idle' },
      hasUnread: false,
      settings: {
        ...initialSessionSettings,
        primaryAgentId: 'claude',
        secondaryAgentId: 'codex',
        permissionModes: { claude: 'ask', codex: 'ask', agy: 'ask' },
      },
      settingsRevision: 1,
      createdAt: checkedAt,
      updatedAt: checkedAt,
    }
    const editorState: SessionSettingsEditorState = {
      session: baseSession,
      modelCatalogs: {
        claude: makeCatalog('claude'),
        codex: makeCatalog('codex'),
        agy: makeCatalog('agy'),
      },
    }
    const allReady = makePreparation({ claude: 'ready', codex: 'ready', agy: 'ready' })
    const onSave = vi.fn<(settings: DefaultSessionSettings) => void>()

    const makeProjection = (
      overrides: Partial<NonNullable<Parameters<typeof SessionSettingsPanel>[0]['conversation']>>,
    ): NonNullable<Parameters<typeof SessionSettingsPanel>[0]['conversation']> => ({
      observation: { incarnation: crypto.randomUUID(), sequence: 1 },
      sessionId,
      session: {
        id: sessionId,
        title: baseSession.title,
        titleSource: baseSession.titleSource,
        status: baseSession.status,
        activity: { state: 'idle' },
        hasUnread: false,
        updatedAt: checkedAt,
      },
      messages: [],
      draftComments: [],
      commentsRevision: 0,
      activities: [],
      runs: [],
      nativeContexts: [],
      ...overrides,
    })

    // 1. Settled quota/auth failure on a paused session (phase === 'warning', no collaborationTask) unlocks replacement!
    const { rerender } = render(
      <SessionSettingsPanel
        editorState={editorState}
        runtimePreparation={allReady}
        conversation={makeProjection({
          runs: [
            {
              id: crypto.randomUUID(),
              sessionId,
              userMessageId: crypto.randomUUID(),
              agentId: 'claude',
              status: 'failed',
              attemptCount: 1,
              settingsRevision: 1,
              model: null,
              effort: null,
              dispatchPhase: 'ended',
              nativeOutcome: 'failed',
              nativeEffectsState: 'settled',
              failureKind: 'quota_or_rate_limit',
              failureMessage: 'Quota exhausted.',
              createdAt: checkedAt,
              updatedAt: checkedAt,
            },
          ],
          sessionIssues: {
            sessionId,
            inputGate: 'open',
            agents: [
              {
                agentId: 'claude',
                generation: 1,
                phase: 'warning',
                title: 'Claude Code session needs attention',
                reason: 'Quota exhausted.',
                inputDisposition: 'submitted',
                resultDisposition: 'unavailable',
                action: 'retry_check',
                abandon: false,
                previousCreationUnconfirmed: false,
              },
            ],
          },
          collaborationTask: null,
        })}
        loading={false}
        saving={false}
        onClose={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
        onSave={onSave}
      />,
    )
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'Antigravity Set as primary agent' })
        .disabled,
    ).toBe(false)

    // 2. Live run completion while panel is open (editorState still has agent_working, conversation updates to idle) unlocks replacement!
    const staleActiveEditorState: SessionSettingsEditorState = {
      ...editorState,
      session: {
        ...baseSession,
        status: 'idle',
        activity: { state: 'agent_working', agentId: 'claude' },
      },
    }
    const activeRunId = crypto.randomUUID()
    const activeUserMsgId = crypto.randomUUID()
    rerender(
      <SessionSettingsPanel
        editorState={staleActiveEditorState}
        runtimePreparation={allReady}
        conversation={makeProjection({
          session: {
            id: sessionId,
            title: baseSession.title,
            titleSource: baseSession.titleSource,
            status: 'idle',
            activity: { state: 'agent_working', agentId: 'claude' },
            hasUnread: false,
            updatedAt: checkedAt,
          },
          runs: [
            {
              id: activeRunId,
              sessionId,
              userMessageId: activeUserMsgId,
              agentId: 'claude',
              status: 'running',
              attemptCount: 1,
              settingsRevision: 1,
              model: null,
              effort: null,
              dispatchPhase: 'accepted',
              nativeEffectsState: 'pending',
              createdAt: checkedAt,
              updatedAt: checkedAt,
            },
          ],
        })}
        loading={false}
        saving={false}
        onClose={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
        onSave={onSave}
      />,
    )
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'Antigravity Active pair locked' })
        .disabled,
    ).toBe(true)

    // Live completion arrives in conversation without refetching editorState!
    rerender(
      <SessionSettingsPanel
        editorState={staleActiveEditorState}
        runtimePreparation={allReady}
        conversation={makeProjection({
          session: {
            id: sessionId,
            title: baseSession.title,
            titleSource: baseSession.titleSource,
            status: 'idle',
            activity: { state: 'idle' },
            hasUnread: false,
            updatedAt: checkedAt,
          },
          runs: [
            {
              id: activeRunId,
              sessionId,
              userMessageId: activeUserMsgId,
              agentId: 'claude',
              status: 'completed',
              attemptCount: 1,
              settingsRevision: 1,
              model: null,
              effort: null,
              dispatchPhase: 'ended',
              nativeOutcome: 'completed',
              nativeEffectsState: 'settled',
              createdAt: checkedAt,
              updatedAt: checkedAt,
            },
          ],
        })}
        loading={false}
        saving={false}
        onClose={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
        onSave={onSave}
      />,
    )
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'Antigravity Set as primary agent' })
        .disabled,
    ).toBe(false)

    // 3. Completed forkOperation (ready: true) unlocks replacement, whereas ready: false blocks replacement!
    const forkBase = {
      id: crypto.randomUUID(),
      sessionId,
      sourceSessionId: crypto.randomUUID(),
      sourceMessageId: crypto.randomUUID(),
      sourceSequence: 2,
      revision: 1,
      sides: [
        {
          agentId: 'claude' as const,
          state: 'ready' as const,
          nativeSessionId: 'c-1',
          canInitialize: false,
          canContinue: true,
        },
        {
          agentId: 'codex' as const,
          state: 'ready' as const,
          nativeSessionId: 'x-1',
          canInitialize: false,
          canContinue: true,
        },
      ],
    }
    rerender(
      <SessionSettingsPanel
        editorState={editorState}
        runtimePreparation={allReady}
        conversation={makeProjection({
          session: {
            id: sessionId,
            title: baseSession.title,
            titleSource: baseSession.titleSource,
            status: 'idle',
            activity: { state: 'idle' },
            hasUnread: false,
            updatedAt: checkedAt,
          },
          forkOperation: { ...forkBase, ready: false },
        })}
        loading={false}
        saving={false}
        onClose={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
        onSave={onSave}
      />,
    )
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'Antigravity Active pair locked' })
        .disabled,
    ).toBe(true)

    rerender(
      <SessionSettingsPanel
        editorState={editorState}
        runtimePreparation={allReady}
        conversation={makeProjection({
          session: {
            id: sessionId,
            title: baseSession.title,
            titleSource: baseSession.titleSource,
            status: 'idle',
            activity: { state: 'idle' },
            hasUnread: false,
            updatedAt: checkedAt,
          },
          forkOperation: { ...forkBase, ready: true },
        })}
        loading={false}
        saving={false}
        onClose={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
        onSave={onSave}
      />,
    )
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'Antigravity Set as primary agent' })
        .disabled,
    ).toBe(false)

    // 4. Even with forkBlocked: true on the projection, a retained member (codex) with nativeEffectsState: 'unknown'
    // ONLY blocks retiring codex via Secondary select, while allowing Primary <-> Secondary swap AND replacing settled claude with agy!
    rerender(
      <SessionSettingsPanel
        editorState={{
          ...editorState,
          session: { ...baseSession, status: 'idle' },
        }}
        runtimePreparation={allReady}
        conversation={makeProjection({
          session: {
            id: sessionId,
            title: baseSession.title,
            titleSource: baseSession.titleSource,
            status: 'idle',
            activity: { state: 'idle' },
            hasUnread: false,
            updatedAt: checkedAt,
          },
          forkBlocked: true,
          runs: [
            {
              id: crypto.randomUUID(),
              sessionId,
              userMessageId: crypto.randomUUID(),
              agentId: 'codex',
              status: 'completed',
              attemptCount: 1,
              settingsRevision: 1,
              model: null,
              effort: null,
              dispatchPhase: 'ended',
              nativeOutcome: 'completed',
              nativeEffectsState: 'unknown',
              createdAt: checkedAt,
              updatedAt: checkedAt,
            },
          ],
        })}
        loading={false}
        saving={false}
        onClose={vi.fn<() => void>()}
        onRetry={vi.fn<() => void>()}
        onSave={onSave}
      />,
    )
    const secondarySelect = screen.getByRole('combobox', { name: 'Secondary agent' })
    const agySecondaryOption = within(secondarySelect).getByRole<HTMLOptionElement>('option', {
      name: /Antigravity — active pair locked/u,
    })
    expect(agySecondaryOption.disabled).toBe(true)
    // Retiring settled claude (keeping codex) via Primary radio -> ('agy', 'codex') is allowed and saveable!
    const agyPrimaryRadio = screen.getByRole<HTMLInputElement>('radio', {
      name: 'Antigravity Set as primary agent',
    })
    expect(agyPrimaryRadio.disabled).toBe(false)
    fireEvent.click(agyPrimaryRadio)
    const saveAfterAgyPrimary = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save changes',
    })
    expect(saveAfterAgyPrimary.disabled).toBe(false)
  })

  it('allows pure Primary <-> Secondary role swap when existing Secondary is offline while blocking offline 3rd agent, and retries failed pair catalog fetches on pair switch or refresh without looping', async () => {
    const previousPact: unknown = Reflect.get(window, 'pact')
    try {
      const sessionId = crypto.randomUUID()
      const session: CollaborationSession = {
        id: sessionId,
        projectId: crypto.randomUUID(),
        title: 'Offline Swap & Retry',
        titleSource: 'local',
        status: 'idle',
        activity: { state: 'idle' },
        hasUnread: false,
        settings: {
          ...initialSessionSettings,
          primaryAgentId: 'claude',
          secondaryAgentId: 'codex',
        },
        settingsRevision: 1,
        createdAt: checkedAt,
        updatedAt: checkedAt,
      }
      const editorState: SessionSettingsEditorState = {
        session,
        modelCatalogs: {
          claude: makeCatalog('claude'),
          codex: makeCatalog('codex'),
          agy: {
            agentId: 'agy',
            status: 'unavailable',
            models: [],
            checkedAt,
            detail: 'Select Antigravity in the active pair to load its models.',
          },
        },
      }
      const onSave = vi.fn<(next: DefaultSessionSettings) => void>()

      // 1. Existing Secondary (codex) is offline & 3rd agent (agy) is offline:
      // codex Primary radio stays enabled for pure Primary <-> Secondary swap, while agy is disabled!
      const { rerender } = render(
        <SessionSettingsPanel
          editorState={editorState}
          runtimePreparation={makePreparation({
            claude: 'ready',
            codex: 'authentication_required',
            agy: 'authentication_required',
          })}
          loading={false}
          saving={false}
          onClose={vi.fn<() => void>()}
          onRetry={vi.fn<() => void>()}
          onSave={onSave}
        />,
      )

      const codexRadio = screen.getByRole<HTMLInputElement>('radio', {
        name: 'Codex Set as primary agent',
      })
      expect(codexRadio.disabled).toBe(false)
      const agyRadio = screen.getByRole<HTMLInputElement>('radio', {
        name: /Antigravity/u,
      })
      expect(agyRadio.disabled).toBe(true)

      fireEvent.click(codexRadio)
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          primaryAgentId: 'codex',
          secondaryAgentId: 'claude',
        }),
      )

      // 2. Now codex and agy become ready, and first loadForPair for (codex, agy) fails with ok: false:
      let shouldFailAgy = true
      const getSessionSettings = vi.fn<
        (
          id: string,
          activePair?: ActiveAgentPairInput,
        ) => Promise<RpcResult<SessionSettingsEditorState>>
      >(async (_id, activePair) => {
        if (
          shouldFailAgy &&
          (activePair?.primaryAgentId === 'agy' || activePair?.secondaryAgentId === 'agy')
        ) {
          return {
            ok: false,
            error: { code: 'RUNTIME_UNAVAILABLE', message: 'Temporary probe timeout' },
          }
        }
        return {
          ok: true,
          value: {
            session,
            modelCatalogs: {
              claude: makeCatalog('claude'),
              codex: makeCatalog('codex'),
              agy: makeCatalog('agy'),
            },
          },
        }
      })
      const bridgeStub: Pick<DesktopBridge, 'getSessionSettings'> = { getSessionSettings }
      Reflect.set(window, 'pact', bridgeStub)

      rerender(
        <SessionSettingsPanel
          editorState={editorState}
          runtimePreparation={makePreparation({
            claude: 'ready',
            codex: 'ready',
            agy: 'ready',
          })}
          loading={false}
          saving={false}
          onClose={vi.fn<() => void>()}
          onRetry={vi.fn<() => void>()}
          onSave={onSave}
        />,
      )

      // Select (codex, agy) -> fails once and stops (no infinite retry loop on same pair!)
      fireEvent.change(screen.getByRole('combobox', { name: 'Secondary agent' }), {
        target: { value: 'agy' },
      })
      await waitFor(() => expect(getSessionSettings).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(getSessionSettings).toHaveBeenCalledTimes(1)

      // Switch to another pair containing agy: (claude, agy) -> retries automatically because agy was NOT marked probed!
      shouldFailAgy = false
      fireEvent.click(screen.getByRole('radio', { name: 'Claude Code Set as primary agent' }))
      await waitFor(() =>
        expect(getSessionSettings).toHaveBeenCalledWith(sessionId, {
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
        }),
      )
      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'AGY Pro' })).toBeTruthy()
      })
    } finally {
      Reflect.set(window, 'pact', previousPact)
    }
  })

  it('auto-loads 3rd-agent models & effort after unready -> ready transition and aborts stale in-flight probes on cache-hit pair switch', async () => {
    const previousPact: unknown = Reflect.get(window, 'pact')
    try {
      const sessionId = crypto.randomUUID()
      const session: CollaborationSession = {
        id: sessionId,
        projectId: crypto.randomUUID(),
        title: 'Catalog Reactivity',
        titleSource: 'local',
        status: 'idle',
        activity: { state: 'idle' },
        hasUnread: false,
        settings: {
          ...initialSessionSettings,
          primaryAgentId: 'claude',
          secondaryAgentId: 'codex',
        },
        settingsRevision: 1,
        createdAt: checkedAt,
        updatedAt: checkedAt,
      }
      const editorState: SessionSettingsEditorState = {
        session,
        modelCatalogs: {
          claude: makeCatalog('claude'),
          codex: makeCatalog('codex'),
          agy: {
            agentId: 'agy',
            status: 'unavailable',
            models: [],
            checkedAt,
            detail: 'Antigravity must be ready before models can be loaded.',
          },
        },
      }

      let resolveAgyProbe: ((value: RpcResult<SessionSettingsEditorState>) => void) | undefined
      const getSessionSettings = vi.fn<
        (
          id: string,
          activePair?: ActiveAgentPairInput,
        ) => Promise<RpcResult<SessionSettingsEditorState>>
      >((_id, activePair) => {
        if (activePair?.primaryAgentId === 'agy' || activePair?.secondaryAgentId === 'agy') {
          return new Promise<RpcResult<SessionSettingsEditorState>>((resolve) => {
            resolveAgyProbe = resolve
          })
        }
        return Promise.resolve({
          ok: true,
          value: {
            session,
            modelCatalogs: {
              claude: makeCatalog('claude'),
              codex: makeCatalog('codex'),
            },
          },
        })
      })
      const bridgeStub: Pick<DesktopBridge, 'getSessionSettings'> = { getSessionSettings }
      Reflect.set(window, 'pact', bridgeStub)

      // Initially agy is authentication_required while SessionSettingsPanel opens.
      const { rerender } = render(
        <SessionSettingsPanel
          editorState={editorState}
          runtimePreparation={makePreparation({
            claude: 'ready',
            codex: 'ready',
            agy: 'authentication_required',
          })}
          loading={false}
          saving={false}
          onClose={vi.fn<() => void>()}
          onRetry={vi.fn<() => void>()}
          onSave={vi.fn<(settings: DefaultSessionSettings) => void>()}
        />,
      )
      expect(getSessionSettings).not.toHaveBeenCalled()

      // Antigravity becomes ready while SessionSettingsPanel stays open!
      rerender(
        <SessionSettingsPanel
          editorState={editorState}
          runtimePreparation={makePreparation({
            claude: 'ready',
            codex: 'ready',
            agy: 'ready',
          })}
          loading={false}
          saving={false}
          onClose={vi.fn<() => void>()}
          onRetry={vi.fn<() => void>()}
          onSave={vi.fn<(settings: DefaultSessionSettings) => void>()}
        />,
      )

      // Select Antigravity as Secondary -> triggers in-flight probe for (claude, agy)!
      fireEvent.change(screen.getByRole('combobox', { name: 'Secondary agent' }), {
        target: { value: 'agy' },
      })
      await waitFor(() => {
        expect(getSessionSettings).toHaveBeenCalledWith(sessionId, {
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
        })
      })

      // Before (claude, agy) resolves, switch back to cached (claude, codex) ->
      // immediately invokes getSessionSettings with (claude, codex) so Utility aborts the in-flight agy probe!
      fireEvent.change(screen.getByRole('combobox', { name: 'Secondary agent' }), {
        target: { value: 'codex' },
      })
      await waitFor(() => {
        expect(getSessionSettings).toHaveBeenCalledWith(sessionId, {
          primaryAgentId: 'claude',
          secondaryAgentId: 'codex',
        })
      })

      // Settle stale probe after cancellation, then switch again to (claude, agy) and verify models & effort load!
      resolveAgyProbe?.({
        ok: true,
        value: {
          session,
          modelCatalogs: {
            claude: makeCatalog('claude'),
            codex: makeCatalog('codex'),
            agy: makeCatalog('agy'),
          },
        },
      })
      fireEvent.change(screen.getByRole('combobox', { name: 'Secondary agent' }), {
        target: { value: 'agy' },
      })
      await waitFor(() => {
        expect(getSessionSettings).toHaveBeenCalledTimes(3)
      })
      resolveAgyProbe?.({
        ok: true,
        value: {
          session,
          modelCatalogs: {
            claude: makeCatalog('claude'),
            codex: makeCatalog('codex'),
            agy: makeCatalog('agy'),
          },
        },
      })
      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'AGY Pro' })).toBeTruthy()
      })
      const agySection = screen.getByRole('region', { name: 'Antigravity' })
      fireEvent.change(within(agySection).getByRole('combobox', { name: /Model/u }), {
        target: { value: 'agy-pro' },
      })
      const agyEffortSelect = within(agySection).getByRole('combobox', { name: /Effort/u })
      expect(
        within(agyEffortSelect).getByRole('option', { name: 'medium — recommended' }),
      ).toBeTruthy()
      expect(within(agyEffortSelect).getByRole('option', { name: 'high' })).toBeTruthy()
    } finally {
      Reflect.set(window, 'pact', previousPact)
    }
  })
})
