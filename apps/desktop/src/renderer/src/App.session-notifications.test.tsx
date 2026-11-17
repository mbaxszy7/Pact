// @vitest-environment jsdom

import type { ComponentProps } from 'react'

import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CollaborationSession,
  DesktopBridge,
  Project,
  SessionReminder as SessionReminderModel,
  SessionReminderState,
  UpdateState,
} from '@pact/contracts'

import { OPENAI_DECISION_MODEL } from '@pact/contracts'

import type { WorkspaceView } from './components/workspace/WorkspaceView'

import App from './App'
import { createRendererQueryClient } from './query-client'

vi.mock('./components/conversation/useConversation', () => ({
  useConversation: () => ({ snapshot: undefined, composer: '', composerSkills: [] }),
  commentDraftSaveSucceeded: vi.fn<() => void>(),
}))
vi.mock('./components/workspace/WorkspaceView', () => ({
  WorkspaceView: (props: ComponentProps<typeof WorkspaceView>) => (
    <main>
      <button
        type="button"
        ref={props.settingsButtonRef}
        onClick={() => props.onOpenSettings('appearance')}
      >
        Open settings
      </button>
      <button type="button" onClick={() => props.onBackToApp()}>
        Back to app
      </button>
      <output aria-label="Settings Page">{props.settingsPage ?? 'none'}</output>
      <output aria-label="Selected Session">{props.selectedSessionId ?? 'none'}</output>
      <nav aria-label="Sessions">
        {props.sessions.map((session) => (
          <button key={session.id} type="button" onClick={() => props.onSelectSession(session.id)}>
            Open Session {session.title}
          </button>
        ))}
      </nav>
      {props.sessionReminderNotice}
      {props.toastNotice}
    </main>
  ),
}))

const timestamp = '2026-11-16T10:00:00.000Z'
const clients: ReturnType<typeof createRendererQueryClient>[] = []

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function setup(options?: { updateAvailable?: boolean }) {
  const projectId = crypto.randomUUID()
  const projects: Project[] = [
    {
      id: projectId,
      name: 'Project',
      directoryPath: '/tmp/project',
      kind: 'directory',
      createdAt: timestamp,
    },
  ]
  const sessions: CollaborationSession[] = ['Session A', 'Session B'].map((title) => ({
    id: crypto.randomUUID(),
    projectId,
    title,
    titleSource: 'local',
    status: 'idle',
    activity: { state: 'idle' },
    hasUnread: false,
    settings: {
      primaryAgentId: 'codex',
      agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
      maxDiscussionRounds: 3,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
    settingsRevision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }))

  let reminderListener: ((state: SessionReminderState) => void) | undefined
  let updateListener: ((state: UpdateState) => void) | undefined
  const updateState: UpdateState = {
    enabled: true,
    preferencesReady: true,
    currentVersion: '0.4.0',
    autoCheck: true,
    revision: 1,
    latest: options?.updateAvailable
      ? {
          version: '0.5.0',
          publishedAt: timestamp,
          url: 'https://github.com/mbaxszy7/Pact/releases/tag/v0.5.0',
        }
      : null,
    checkedAt: timestamp,
    retryAt: null,
    noticePending: Boolean(options?.updateAvailable),
    checking: false,
    error: null,
    updateAvailable: Boolean(options?.updateAvailable),
    stateVersion: 1,
    settingsRequest: 0,
  }

  const claimUpdateNotice = vi.fn<DesktopBridge['claimUpdateNotice']>(async () => ({
    ok: true,
    value: { claimed: true },
  }))
  const viewSessionReminder = vi.fn<DesktopBridge['viewSessionReminder']>(async () => ({
    ok: true,
    value: { accepted: true },
  }))
  const dismissSessionReminder = vi.fn<DesktopBridge['dismissSessionReminder']>(async () => ({
    ok: true,
    value: { accepted: true },
  }))

  const bridge = {
    onSchedulingChanged: vi.fn<DesktopBridge['onSchedulingChanged']>(() => () => undefined),
    getSchedulingState: vi.fn<DesktopBridge['getSchedulingState']>(async (input) => ({
      ok: true,
      value: {
        settings: {
          enabled: false,
          provider: 'openai',
          model: OPENAI_DECISION_MODEL,
          credential: { configured: false, revision: 0 },
          showIndicator: true,
          revision: 0,
          updatedAt: timestamp,
        },
        configurationGeneration: 0,
        connection: { status: 'unconfirmed', checkedAt: null, expiresAt: null },
        context: input?.sessionId ? { sessionId: input.sessionId, eligibility: 'disabled' } : null,
        activity: { decision: { status: 'idle' }, check: { status: 'idle' } },
      },
    })),
    getUpdateState: vi.fn<DesktopBridge['getUpdateState']>(async () => ({
      ok: true,
      value: updateState,
    })),
    claimUpdateNotice,
    onUpdateStateChanged: vi.fn<DesktopBridge['onUpdateStateChanged']>((listener) => {
      updateListener = listener
      return () => {
        updateListener = undefined
      }
    }),
    onNativePresenceChanged: vi.fn<DesktopBridge['onNativePresenceChanged']>(() => () => undefined),
    onSessionReminderChanged: vi.fn<NonNullable<DesktopBridge['onSessionReminderChanged']>>(
      (listener) => {
        reminderListener = listener
        return () => {
          reminderListener = undefined
        }
      },
    ),
    viewSessionReminder,
    dismissSessionReminder,
    getAppInfo: vi.fn<DesktopBridge['getAppInfo']>(async () => ({
      ok: true,
      value: { name: 'Pact', version: '0.4.0', platform: 'darwin', arch: 'arm64', packaged: false },
    })),
    getRuntimePreparation: vi.fn<DesktopBridge['getRuntimePreparation']>(async () => ({
      ok: true,
      value: {
        firstUse: false,
        agents: [
          { agentId: 'claude', state: 'ready', checkedAt: timestamp },
          { agentId: 'codex', state: 'ready', checkedAt: timestamp },
        ],
      },
    })),
    getAppearanceSettings: vi.fn<DesktopBridge['getAppearanceSettings']>(async () => ({
      ok: true,
      value: {
        requested: { theme: 'light', windowMaterial: 'solid', materialOpacity: 85, revision: 1 },
        effective: { theme: 'light', windowMaterial: 'solid', revision: 1 },
        projectionVersion: 1,
      },
    })),
    onAppearanceSettingsChanged: vi.fn<DesktopBridge['onAppearanceSettingsChanged']>(
      () => () => undefined,
    ),
    onNativeNavigationChanged: vi.fn<DesktopBridge['onNativeNavigationChanged']>(
      () => () => undefined,
    ),
    getNativeNavigation: vi.fn<DesktopBridge['getNativeNavigation']>(async () => ({
      ok: true,
      value: null,
    })),
    onNativeQuitStateChanged: vi.fn<DesktopBridge['onNativeQuitStateChanged']>(
      () => () => undefined,
    ),
    getNativeQuitState: vi.fn<DesktopBridge['getNativeQuitState']>(async () => ({
      ok: true,
      value: null,
    })),
    recordNativeSessionOpened: vi.fn<DesktopBridge['recordNativeSessionOpened']>(async () => ({
      ok: true,
      value: { recorded: true },
    })),
    getProjectCatalog: vi.fn<DesktopBridge['getProjectCatalog']>(async () => ({
      ok: true,
      value: { projects },
    })),
    getSessionPage: vi.fn<DesktopBridge['getSessionPage']>(async ({ projectId: id, scope }) => ({
      ok: true,
      value: {
        kind: 'page',
        projectId: id,
        scope,
        groupRevision: 0,
        revision: 1,
        sessions,
        hasGroups: false,
      },
    })),
  }

  vi.stubGlobal('pact', bridge)
  const client = createRendererQueryClient()
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )

  return {
    sessions,
    claimUpdateNotice,
    viewSessionReminder,
    dismissSessionReminder,
    pushReminder(current: SessionReminderModel | null, pending = current ? 1 : 0, revision = 1) {
      act(() => {
        reminderListener?.({ revision, current, pending })
      })
    },
    pushUpdateAvailable(version = '0.5.0') {
      act(() => {
        updateListener?.({
          ...updateState,
          latest: {
            version,
            publishedAt: timestamp,
            url: `https://github.com/mbaxszy7/Pact/releases/tag/v${version}`,
          },
          noticePending: true,
          updateAvailable: true,
          stateVersion: 2,
        })
      })
    },
  }
}

describe('App Session notification visibility & Settings toggle', () => {
  it('shows reminder when Settings is open over a hidden selected Session and auto-clears upon returning to that Session', async () => {
    const context = setup()
    const [sessionA, sessionB] = context.sessions

    // Open Session A, then toggle Settings open (Session A remains selected in hidden DOM).
    fireEvent.click(await screen.findByRole('button', { name: 'Open Session Session A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(screen.getByRole('status', { name: 'Settings Page' }).textContent).toBe('appearance')

    // Reminder for Session A MUST be visible while Settings is open!
    const reminderForA: SessionReminderModel = {
      id: 'rem-a',
      sessionId: sessionA!.id,
      sessionTitle: 'Session A',
      agentId: 'codex',
      category: 'completed',
      priority: 1,
      createdAt: timestamp,
    }
    context.pushReminder(reminderForA, 2, 1)
    expect(screen.getByText('Codex · Finished')).not.toBeNull()
    expect(screen.getByLabelText('1 more pending').textContent).toBe('+1')
    expect(context.dismissSessionReminder).not.toHaveBeenCalled()

    // Returning from Settings makes Session A visible & focused -> auto-clears the reminder!
    fireEvent.click(screen.getByRole('button', { name: 'Back to app' }))
    await waitFor(() =>
      expect(context.dismissSessionReminder).toHaveBeenCalledWith({ id: 'rem-a' }),
    )
    context.pushReminder(null, 0, 2)
    expect(screen.queryByRole('button', { name: 'View Session' })).toBeNull()

    // While viewing Session A, reminder for Session B stays visible and clicking View Session invokes IPC.
    context.pushReminder(
      {
        id: 'rem-b',
        sessionId: sessionB!.id,
        sessionTitle: 'Session B',
        agentId: 'claude',
        category: 'needs_input',
        priority: 3,
        createdAt: timestamp,
      },
      1,
      3,
    )
    fireEvent.click(screen.getByRole('button', { name: 'View Session' }))
    expect(context.viewSessionReminder).toHaveBeenCalledExactlyOnceWith({ id: 'rem-b' })
  })

  it('defers update-ready notice while a Session reminder is active and claims once cleared', async () => {
    const context = setup({ updateAvailable: false })
    await screen.findByRole('button', { name: 'Open Session Session A' })

    context.pushReminder(
      {
        id: 'rem-guard',
        sessionId: context.sessions[0]!.id,
        sessionTitle: 'Session A',
        agentId: 'codex',
        category: 'failure',
        priority: 2,
        createdAt: timestamp,
      },
      1,
      1,
    )
    context.pushUpdateAvailable('0.5.0')
    expect(screen.getByText('Codex · Failed')).not.toBeNull()
    expect(context.claimUpdateNotice).not.toHaveBeenCalled()

    // Clearing the reminder unblocks update notice claim.
    context.pushReminder(null, 0, 2)
    await waitFor(() =>
      expect(context.claimUpdateNotice).toHaveBeenCalledExactlyOnceWith({ version: '0.5.0' }),
    )
    await screen.findByText('Pact 0.5.0 is available. See About & updates.')
  })
})
