// @vitest-environment jsdom

import type { ComponentProps } from 'react'

import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CollaborationSession,
  DesktopBridge,
  Project,
  RpcResult,
  SessionCatalogChange,
  WorkspaceArchivePreview,
  WorkspaceArchiveReceipt,
} from '@pact/contracts'

import type { WorkspaceView } from './components/workspace/WorkspaceView'

import App from './App'
import { createRendererQueryClient } from './query-client'

// Exercise App's public workspace callbacks, real catalog hooks, and named Bridge operations.
// Conversation rendering and navigation visuals have their own tests and are unrelated to archiving.
vi.mock('./components/conversation/useConversation', () => ({
  useConversation: () => ({ snapshot: undefined, composer: '', composerSkills: [] }),
  commentDraftSaveSucceeded: vi.fn<() => void>(),
}))
vi.mock('./components/workspace/WorkspaceView', () => ({
  WorkspaceView: (props: ComponentProps<typeof WorkspaceView>) => (
    <main>
      <button type="button" ref={props.settingsButtonRef}>
        Settings
      </button>
      <output aria-label="Selected Session">{props.selectedSessionId ?? 'none'}</output>
      <output aria-label="Selected Project">{props.selectedProjectId ?? 'none'}</output>
      <nav aria-label="Projects">
        {props.projects.map((project) => (
          <button key={project.id} type="button" onClick={() => props.onArchiveProject(project.id)}>
            Archive Project {project.name}
          </button>
        ))}
      </nav>
      <nav aria-label="Sessions">
        {props.sessions.map((session) => (
          <div key={session.id}>
            <button type="button" onClick={() => props.onSelectSession(session.id)}>
              Open Session {session.title}
            </button>
            <button type="button" onClick={() => props.onArchiveSession(session.id)}>
              Archive Session {session.title}
            </button>
          </div>
        ))}
      </nav>
      {props.archiveNotice}
      {props.toastNotice}
    </main>
  ),
}))

const timestamp = '2026-10-14T05:00:00.000Z'
const showDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
const clients: ReturnType<typeof createRendererQueryClient>[] = []
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false
    },
  })
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
  for (const [name, descriptor] of [
    ['showModal', showDescriptor],
    ['close', closeDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  }
})

function fixture(projectCount = 2) {
  const projects: Project[] = Array.from({ length: projectCount }, (_, index) => ({
    id: crypto.randomUUID(),
    name: `Project ${index + 1}`,
    directoryPath: `C:\\archive-test\\project-${index + 1}`,
    kind: 'directory',
    createdAt: timestamp,
  }))
  const sessions: CollaborationSession[] = ['A', 'B', 'C'].map((title, index) => ({
    id: crypto.randomUUID(),
    projectId: projects[index === 2 ? 1 : 0]!.id,
    title,
    titleSource: 'local',
    status: 'idle',
    activity: { state: 'idle' },
    hasUnread: false,
    settings: {
      primaryAgentId: 'claude',
      agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
      runningMessagePolicy: 'next_round',
      maxDiscussionRounds: 3,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
    settingsRevision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }))
  let revision = 1
  const archivedSessions = new Set<string>()
  const archivedProjects = new Set<string>()
  const active = new Set<string>()
  const operations = new Map<string, WorkspaceArchiveReceipt>()
  const change = (sessionId: string, archived: boolean): RpcResult<SessionCatalogChange> => {
    const session = sessions.find((item) => item.id === sessionId)!
    if (archived) archivedSessions.add(sessionId)
    else archivedSessions.delete(sessionId)
    return {
      ok: true,
      value: {
        kind: 'change',
        revision: ++revision,
        session: {
          ...session,
          status: archived ? 'archived' : 'idle',
          ...(archived ? { archivedAt: timestamp } : {}),
        },
      },
    }
  }
  const catalog = () => ({
    projects: projects.filter((project) => !archivedProjects.has(project.id)),
  })
  const bridge = {
    getUpdateState: vi.fn<DesktopBridge['getUpdateState']>(async () => ({
      ok: true,
      value: {
        enabled: false,
        preferencesReady: true,
        currentVersion: '0.0.0',
        autoCheck: true,
        revision: 0,
        latest: null,
        checkedAt: null,
        retryAt: null,
        noticePending: false,
        checking: false,
        error: null,
        updateAvailable: false,
        stateVersion: 0,
        settingsRequest: 0,
      },
    })),
    onUpdateStateChanged: vi.fn<DesktopBridge['onUpdateStateChanged']>(() => () => undefined),
    onNativePresenceChanged: vi.fn<DesktopBridge['onNativePresenceChanged']>(() => () => undefined),
    getAppInfo: vi.fn<DesktopBridge['getAppInfo']>(async () => ({
      ok: true,
      value: { name: 'Pact', version: '0.0.0', platform: 'win32', arch: 'x64', packaged: false },
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
      value: catalog(),
    })),
    getSessionCatalog: vi.fn<DesktopBridge['getSessionCatalog']>(async (projectId) => ({
      ok: true,
      value: {
        kind: 'page',
        projectId,
        revision,
        sessions: sessions
          .filter((session) => session.projectId === projectId && !archivedSessions.has(session.id))
          .toSorted((left, right) => right.id.localeCompare(left.id)),
      },
    })),
    prepareWorkspaceArchive: vi.fn<DesktopBridge['prepareWorkspaceArchive']>(
      async ({ scope, operationId }) => {
        const session =
          scope.kind === 'session'
            ? sessions.find((item) => item.id === scope.sessionId)!
            : undefined
        const projectId = scope.kind === 'project' ? scope.projectId : session!.projectId
        const tasks = sessions.filter(
          (item) =>
            active.has(item.id) &&
            (scope.kind === 'session' ? item.id === scope.sessionId : item.projectId === projectId),
        )
        const preview: WorkspaceArchivePreview = {
          scope,
          operationId,
          projectId,
          title: session?.title ?? projects.find((project) => project.id === projectId)!.name,
          tasks: tasks.map((task) => ({
            sessionId: task.id,
            title: task.title,
            state: 'running',
            identity: crypto.randomUUID(),
          })),
          expiresAt: '2026-10-14T05:02:00.000Z',
        }
        operations.set(operationId, { preview, state: 'prepared', tasks: [] })
        return { ok: true, value: preview }
      },
    ),
    readWorkspaceArchive: vi.fn<DesktopBridge['readWorkspaceArchive']>(async ({ operationId }) => ({
      ok: true,
      value: operations.get(operationId)!,
    })),
    cancelWorkspaceArchive: vi.fn<DesktopBridge['cancelWorkspaceArchive']>(
      async ({ operationId }) => {
        const previous = operations.get(operationId)!
        const receipt: WorkspaceArchiveReceipt = { ...previous, state: 'cancelled' }
        operations.set(operationId, receipt)
        return { ok: true, value: receipt }
      },
    ),
    archiveSession: vi.fn<DesktopBridge['archiveSession']>(async (sessionId, operationId) => {
      const previous = operations.get(operationId!)!
      operations.set(operationId!, { ...previous, state: 'archived' })
      return change(sessionId, true)
    }),
    archiveProject: vi.fn<DesktopBridge['archiveProject']>(async (projectId, operationId) => {
      const previous = operations.get(operationId!)!
      operations.set(operationId!, { ...previous, state: 'archived' })
      archivedProjects.add(projectId)
      return { ok: true, value: catalog() }
    }),
    restoreSession: vi.fn<DesktopBridge['restoreSession']>(async (sessionId) =>
      change(sessionId, false),
    ),
    restoreProject: vi.fn<DesktopBridge['restoreProject']>(async (projectId) => {
      archivedProjects.delete(projectId)
      return { ok: true, value: catalog() }
    }),
  } satisfies Pick<
    DesktopBridge,
    | 'getUpdateState'
    | 'onUpdateStateChanged'
    | 'onNativePresenceChanged'
    | 'getAppInfo'
    | 'getRuntimePreparation'
    | 'getAppearanceSettings'
    | 'onAppearanceSettingsChanged'
    | 'onNativeNavigationChanged'
    | 'getNativeNavigation'
    | 'onNativeQuitStateChanged'
    | 'getNativeQuitState'
    | 'recordNativeSessionOpened'
    | 'getProjectCatalog'
    | 'getSessionCatalog'
    | 'prepareWorkspaceArchive'
    | 'readWorkspaceArchive'
    | 'cancelWorkspaceArchive'
    | 'archiveSession'
    | 'archiveProject'
    | 'restoreSession'
    | 'restoreProject'
  >
  vi.stubGlobal('pact', bridge)
  const client = createRendererQueryClient()
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
  return { bridge, sessions, projects, active, operations, change }
}

async function archiveSession(title: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: `Archive Session ${title}` }))
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: `Archive Session ${title}` })).toBeNull(),
  )
}

function expandResults(): HTMLElement {
  const view = screen.queryByRole('button', { name: 'View' })
  if (view) fireEvent.click(view)
  return screen.getByRole('list', { name: 'Individual archive results' })
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog')
}

describe('App archive flow through DesktopBridge', () => {
  it('keeps multiple success entries and removes only the independently restored item', async () => {
    const context = fixture()
    await archiveSession('A')
    await archiveSession('B')
    const list = expandResults()
    expect(within(list).getByText('A')).not.toBeNull()
    expect(within(list).getByText('B')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Undo archive of A' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Undo archive of A' })).toBeNull(),
    )
    expect(screen.getByRole('button', { name: 'Undo archive of B' })).not.toBeNull()
    expect(context.bridge.restoreSession).toHaveBeenCalledExactlyOnceWith(context.sessions[0]!.id)
    expect(screen.getByRole('status', { name: 'Selected Session' }).textContent).toBe(
      context.sessions[0]!.id,
    )
    expect(context.bridge.prepareWorkspaceArchive).toHaveBeenCalledTimes(2)
    expect(context.bridge.archiveSession).toHaveBeenCalledTimes(2)
  })

  it('keeps both Undo entries when one restore fails', async () => {
    const { bridge } = fixture()
    await archiveSession('A')
    await archiveSession('B')
    bridge.restoreSession.mockResolvedValueOnce({
      ok: false,
      error: { code: 'INTERNAL', message: 'Restore unavailable.' },
    })
    expandResults()
    fireEvent.click(screen.getByRole('button', { name: 'Undo archive of A' }))
    await screen.findByText(
      'Could not confirm the restore. Try Undo again to check its saved state.',
    )
    expect(screen.getByRole('button', { name: 'Undo archive of A' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Undo archive of B' })).not.toBeNull()
    expect(screen.getByRole('status', { name: 'Selected Session' }).textContent).toBe('none')
  })

  it('cancels active-task preflight without sending Stop or changing catalog and selection', async () => {
    const { bridge, active, sessions } = fixture()
    active.add(sessions[0]!.id)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Session A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive Session A' }))
    await screen.findByRole('dialog', { name: 'Stop and archive?' })
    expect(bridge.archiveSession).not.toHaveBeenCalled()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(bridge.cancelWorkspaceArchive).toHaveBeenCalledExactlyOnceWith({
      operationId: bridge.prepareWorkspaceArchive.mock.calls[0]![0].operationId,
    })
    expect(bridge.archiveSession).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Archive Session A' })).not.toBeNull()
    expect(screen.getByRole('status', { name: 'Selected Session' }).textContent).toBe(
      sessions[0]!.id,
    )
  })

  it('admits only one confirm while Stop is pending and changes selection only after success', async () => {
    const context = fixture()
    context.active.add(context.sessions[0]!.id)
    const pending = Promise.withResolvers<RpcResult<SessionCatalogChange>>()
    context.bridge.archiveSession.mockReturnValueOnce(pending.promise)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Session A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive Session A' }))
    const confirm = await screen.findByRole('button', { name: 'Stop and archive' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    fireEvent.click(screen.getByRole('button', { name: 'Archive Session B' }))
    expect(context.bridge.archiveSession).toHaveBeenCalledTimes(1)
    expect(context.bridge.prepareWorkspaceArchive).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status', { name: 'Selected Session' }).textContent).toBe(
      context.sessions[0]!.id,
    )
    expect(screen.getByRole('button', { name: 'Archive Session A' })).not.toBeNull()
    await act(async () => pending.resolve(context.change(context.sessions[0]!.id, true)))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('status', { name: 'Selected Session' }).textContent).toBe('none')
    expect(screen.queryByRole('button', { name: 'Archive Session A' })).toBeNull()
  })

  it('keeps success and failure together and re-prepares fresh task identities before retrying', async () => {
    const context = fixture()
    await archiveSession('C')
    context.active.add(context.sessions[0]!.id)
    context.active.add(context.sessions[1]!.id)
    context.bridge.archiveProject.mockImplementationOnce(async (_projectId, operationId) => {
      const receipt = context.operations.get(operationId!)!
      context.operations.set(operationId!, {
        ...receipt,
        state: 'not_archived',
        message: 'B could not be stopped.',
        tasks: receipt.preview.tasks.map((task, index) => ({
          sessionId: task.sessionId,
          outcome: index ? 'failed' : 'stopped',
        })),
      })
      return { ok: false, error: { code: 'CONFLICT', message: 'Partial stop.' } }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Archive Project Project 1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and archive' }))
    await screen.findByRole('dialog', { name: 'Archive not completed' })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
    const list = expandResults()
    expect(within(list).getByText('C')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View archive failure for Project 1' }))
    expect(screen.getByText('B could not be stopped.')).not.toBeNull()
    expect(screen.getByText('Stopped')).not.toBeNull()
    expect(screen.getByText('Needs checking')).not.toBeNull()
    const oldPreview = [...context.operations.values()].find(
      (operation) => operation.preview.scope.kind === 'project',
    )!.preview
    context.active.delete(context.sessions[0]!.id)
    fireEvent.click(screen.getByRole('button', { name: 'Review again' }))
    await screen.findByRole('dialog', { name: 'Stop and archive?' })
    expect(context.bridge.archiveProject).toHaveBeenCalledTimes(1)
    const newPreview = [...context.operations.values()].at(-1)!.preview
    expect(newPreview.operationId).not.toBe(oldPreview.operationId)
    expect(newPreview.tasks).toHaveLength(1)
    expect(newPreview.tasks[0]!.identity).not.toBe(oldPreview.tasks[1]!.identity)
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Stop and archive' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('button', { name: 'Undo archive of C' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Undo archive of Project 1' })).not.toBeNull()
  })

  it('uses read-only same-nonce checks after a lost receipt, including repeated check failures', async () => {
    const context = fixture()
    await archiveSession('C')
    context.active.add(context.sessions[0]!.id)
    context.bridge.archiveSession.mockResolvedValueOnce({
      ok: false,
      error: { code: 'UNCERTAIN', message: 'Reply lost.' },
    })
    context.bridge.readWorkspaceArchive.mockRejectedValue(new Error('Receipt unavailable.'))
    fireEvent.click(screen.getByRole('button', { name: 'Archive Session A' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and archive' }))
    await screen.findByRole('dialog', { name: 'Archive not completed' })
    const operationId = context.bridge.prepareWorkspaceArchive.mock.calls[1]![0].operationId
    expect(within(dialog()).queryByRole('button', { name: 'Review again' })).toBeNull()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Check status' }))
    await within(dialog()).findByText(
      'Could not check this archive. Try Check status again; its result is still unconfirmed.',
    )
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
    expandResults()
    const check = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Check archive status of A',
    })
    fireEvent.click(check)
    await waitFor(() => expect(check.disabled).toBe(false))
    expect(context.bridge.archiveSession).toHaveBeenCalledTimes(2)
    expect(context.bridge.prepareWorkspaceArchive).toHaveBeenCalledTimes(2)
    for (const [input] of context.bridge.readWorkspaceArchive.mock.calls)
      expect(input).toEqual({ operationId })
    expect(context.bridge.cancelWorkspaceArchive).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Undo archive of C' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Archive Session A' })).not.toBeNull()
  })

  it('shows all three result states and dismisses resolved entries while keeping uncertainty', async () => {
    const context = fixture()
    await archiveSession('A')
    context.bridge.prepareWorkspaceArchive.mockResolvedValueOnce({
      ok: false,
      error: { code: 'CONFLICT', message: 'Task ownership changed.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Archive Session B' }))
    await screen.findByText('1 archived · 1 failed')
    context.bridge.archiveSession.mockResolvedValueOnce({
      ok: false,
      error: { code: 'INTERNAL', message: 'Reply lost.' },
    })
    context.bridge.readWorkspaceArchive.mockRejectedValueOnce(new Error('No receipt.'))
    fireEvent.click(screen.getByRole('button', { name: 'Archive Session C' }))
    await screen.findByRole('dialog', { name: 'Archive not completed' })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
    expect(screen.getByText('1 archived · 1 failed · 1 to check')).not.toBeNull()
    expandResults()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss completed archive results' }))
    expect(screen.getByText('1 to check')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Check archive status of C' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Undo archive of A' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'View archive failure for B' })).toBeNull()
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Dismiss completed archive results' })
        .disabled,
    ).toBe(true)
  })

  it('checks an existing unresolved target instead of preparing or stopping it again', async () => {
    const context = fixture()
    context.bridge.archiveSession.mockResolvedValueOnce({
      ok: false,
      error: { code: 'INTERNAL', message: 'Unknown reply.' },
    })
    context.bridge.readWorkspaceArchive.mockRejectedValueOnce(new Error('Read lost.'))
    fireEvent.click(await screen.findByRole('button', { name: 'Archive Session A' }))
    await screen.findByRole('dialog', { name: 'Archive not completed' })
    const operationId = context.bridge.prepareWorkspaceArchive.mock.calls[0]![0].operationId
    const previous = context.operations.get(operationId)!
    context.operations.set(operationId, { ...previous, state: 'unresolved' })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive Session A' }))
    await waitFor(() => expect(context.bridge.readWorkspaceArchive).toHaveBeenCalledTimes(2))
    expect(context.bridge.readWorkspaceArchive).toHaveBeenLastCalledWith({ operationId })
    expect(context.bridge.prepareWorkspaceArchive).toHaveBeenCalledTimes(1)
    expect(context.bridge.archiveSession).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Archive Session A' })).not.toBeNull()
  })

  it('reconciles durable success using the same nonce before changing catalog and selection', async () => {
    const context = fixture()
    fireEvent.click(await screen.findByRole('button', { name: 'Open Session A' }))
    context.bridge.archiveSession.mockResolvedValueOnce({
      ok: false,
      error: { code: 'INTERNAL', message: 'Unknown reply.' },
    })
    context.bridge.readWorkspaceArchive.mockRejectedValueOnce(new Error('Read lost.'))
    fireEvent.click(screen.getByRole('button', { name: 'Archive Session A' }))
    await screen.findByRole('dialog', { name: 'Archive not completed' })
    const operationId = context.bridge.prepareWorkspaceArchive.mock.calls[0]![0].operationId
    context.operations.set(operationId, {
      ...context.operations.get(operationId)!,
      state: 'archived',
    })
    expect(screen.getByRole('status', { name: 'Selected Session' }).textContent).toBe(
      context.sessions[0]!.id,
    )
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Check status' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(context.bridge.archiveSession.mock.calls).toEqual([
      [context.sessions[0]!.id, operationId],
      [context.sessions[0]!.id, operationId],
    ])
    expect(context.bridge.prepareWorkspaceArchive).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Archive Session A' })).toBeNull()
    expect(screen.getByRole('status', { name: 'Selected Session' }).textContent).toBe('none')
    expandResults()
    expect(screen.getByRole('button', { name: 'Undo archive of A' })).not.toBeNull()
  })

  it('hides an expanded unresolved explanation after a successful status check and keeps other Undo entries', async () => {
    const context = fixture()
    await archiveSession('C')
    context.bridge.archiveSession.mockResolvedValueOnce({
      ok: false,
      error: { code: 'INTERNAL', message: 'The archive reply was lost.' },
    })
    context.bridge.readWorkspaceArchive.mockRejectedValueOnce(new Error('Receipt read was lost.'))
    fireEvent.click(screen.getByRole('button', { name: 'Archive Session A' }))
    await screen.findByRole('dialog', { name: 'Archive not completed' })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
    expandResults()
    const details = screen.getByRole('button', { name: 'View details' })
    fireEvent.click(details)
    const panel = document.getElementById(details.getAttribute('aria-controls')!)!
    expect(panel.hidden).toBe(false)
    expect(panel.textContent).toContain('The archive result could not be confirmed.')

    const operationId = context.bridge.prepareWorkspaceArchive.mock.calls[1]![0].operationId
    context.operations.set(operationId, {
      ...context.operations.get(operationId)!,
      state: 'archived',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check archive status of A' }))
    await screen.findByRole('button', { name: 'Undo archive of A' })

    expect(panel.isConnected).toBe(true)
    expect(panel.hidden).toBe(true)
    expect(screen.queryByRole('button', { name: 'Hide details' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Undo archive of C' })).not.toBeNull()
    expect(screen.getByText('2 archived')).not.toBeNull()
    expect(context.bridge.prepareWorkspaceArchive).toHaveBeenCalledTimes(2)
    expect(context.bridge.archiveSession.mock.calls.slice(1)).toEqual([
      [context.sessions[0]!.id, operationId],
      [context.sessions[0]!.id, operationId],
    ])
  })

  it('rejects a receipt for another operation without changing archived visibility', async () => {
    const context = fixture()
    context.bridge.archiveSession.mockResolvedValueOnce({
      ok: false,
      error: { code: 'INTERNAL', message: 'Unknown reply.' },
    })
    context.bridge.readWorkspaceArchive.mockImplementationOnce(async ({ operationId }) => ({
      ok: true,
      value: {
        ...context.operations.get(operationId)!,
        state: 'archived',
        preview: {
          ...context.operations.get(operationId)!.preview,
          operationId: crypto.randomUUID(),
        },
      },
    }))
    fireEvent.click(await screen.findByRole('button', { name: 'Archive Session A' }))
    await screen.findByRole('dialog', { name: 'Archive not completed' })
    expect(screen.getByRole('button', { name: 'Archive Session A' })).not.toBeNull()
    expect(context.bridge.archiveSession).toHaveBeenCalledTimes(1)
    expect(within(dialog()).getByRole('button', { name: 'Check status' })).not.toBeNull()
  })

  it('requires the Project to be restored before Undo of an independently archived Session', async () => {
    const context = fixture()
    await archiveSession('A')
    fireEvent.click(screen.getByRole('button', { name: 'Archive Project Project 1' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Archive Project Project 1' })).toBeNull(),
    )
    expandResults()
    fireEvent.click(screen.getByRole('button', { name: 'Undo archive of A' }))
    expect(
      screen.getByText('Restore or re-add its Project first, then undo this Session archive.'),
    ).not.toBeNull()
    expect(context.bridge.restoreSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Undo archive of Project 1' }))
    await screen.findByRole('button', { name: 'Archive Project Project 1' })
    expect(screen.getByRole('button', { name: 'Undo archive of A' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Archive Session A' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Undo archive of A' }))
    await screen.findByRole('button', { name: 'Archive Session A' })
    expect(context.bridge.restoreProject).toHaveBeenCalledExactlyOnceWith(context.projects[0]!.id)
    expect(context.bridge.restoreSession).toHaveBeenCalledExactlyOnceWith(context.sessions[0]!.id)
    expect(screen.queryByRole('region', { name: 'Archive results' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Settings' }))
  })

  it('serializes Undo and new archives so a late restore cannot discard another result', async () => {
    const context = fixture()
    await archiveSession('A')
    await archiveSession('B')
    const pending = Promise.withResolvers<RpcResult<SessionCatalogChange>>()
    context.bridge.restoreSession.mockReturnValueOnce(pending.promise)
    expandResults()
    const undoA = screen.getByRole('button', { name: 'Undo archive of A' })
    fireEvent.click(undoA)
    fireEvent.click(undoA)
    fireEvent.click(screen.getByRole('button', { name: 'Undo archive of B' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive Session C' }))
    expect(context.bridge.restoreSession).toHaveBeenCalledTimes(1)
    expect(context.bridge.prepareWorkspaceArchive).toHaveBeenCalledTimes(2)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Dismiss completed archive results' })
        .disabled,
    ).toBe(true)
    await act(async () => pending.resolve(context.change(context.sessions[0]!.id, false)))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Undo archive of A' })).toBeNull(),
    )
    expect(screen.getByRole('button', { name: 'Undo archive of B' })).not.toBeNull()
    await archiveSession('C')
    expect(screen.getByRole('button', { name: 'Undo archive of B' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Undo archive of C' })).not.toBeNull()
  })

  it('serializes readback with Undo and other readbacks without resending the archive', async () => {
    const context = fixture()
    await archiveSession('A')
    context.bridge.archiveSession.mockResolvedValueOnce({
      ok: false,
      error: { code: 'INTERNAL', message: 'Unknown reply.' },
    })
    context.bridge.readWorkspaceArchive.mockRejectedValueOnce(new Error('Read lost.'))
    fireEvent.click(screen.getByRole('button', { name: 'Archive Session B' }))
    await screen.findByRole('dialog', { name: 'Archive not completed' })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
    expandResults()
    const operationId = context.bridge.prepareWorkspaceArchive.mock.calls[1]![0].operationId
    const pending = Promise.withResolvers<RpcResult<WorkspaceArchiveReceipt>>()
    context.bridge.readWorkspaceArchive.mockReturnValueOnce(pending.promise)
    const check = screen.getByRole('button', { name: 'Check archive status of B' })
    fireEvent.click(check)
    fireEvent.click(check)
    fireEvent.click(screen.getByRole('button', { name: 'Undo archive of A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive Session C' }))
    expect(context.bridge.readWorkspaceArchive).toHaveBeenCalledTimes(2)
    expect(context.bridge.archiveSession).toHaveBeenCalledTimes(2)
    expect(context.bridge.prepareWorkspaceArchive).toHaveBeenCalledTimes(2)
    expect(context.bridge.restoreSession).not.toHaveBeenCalled()
    await act(async () =>
      pending.resolve({
        ok: true,
        value: { ...context.operations.get(operationId)!, state: 'unresolved' },
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Undo archive of A' }).disabled,
      ).toBe(false),
    )
    expect(screen.getByRole('button', { name: 'Check archive status of B' })).not.toBeNull()
  })

  it('reads a lost success ACK before requesting its idempotent same-nonce catalog result', async () => {
    const context = fixture()
    context.bridge.archiveSession.mockImplementationOnce(async (_sessionId, operationId) => {
      context.operations.set(operationId!, {
        ...context.operations.get(operationId!)!,
        state: 'archived',
      })
      return { ok: false, error: { code: 'UNCERTAIN', message: 'Success ACK lost.' } }
    })
    await archiveSession('A')
    const operationId = context.bridge.prepareWorkspaceArchive.mock.calls[0]![0].operationId
    expect(context.bridge.readWorkspaceArchive).toHaveBeenCalledExactlyOnceWith({ operationId })
    expect(context.bridge.archiveSession.mock.calls).toEqual([
      [context.sessions[0]!.id, operationId],
      [context.sessions[0]!.id, operationId],
    ])
    expect(context.bridge.readWorkspaceArchive.mock.invocationCallOrder[0]).toBeLessThan(
      context.bridge.archiveSession.mock.invocationCallOrder[1]!,
    )
    expandResults()
    expect(screen.getByRole('button', { name: 'Undo archive of A' })).not.toBeNull()
  })

  it('records a blocked preflight as a failure while preserving earlier success without Stop', async () => {
    const context = fixture()
    await archiveSession('A')
    context.bridge.prepareWorkspaceArchive.mockImplementationOnce(
      async ({ operationId, scope }) => ({
        ok: true,
        value: {
          operationId,
          scope,
          title: 'B',
          projectId: context.sessions[1]!.projectId,
          tasks: [],
          blockedReason: 'The detached native task cannot be stopped here.',
          expiresAt: '2026-10-14T05:02:00.000Z',
        },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Archive Session B' }))
    await screen.findByRole('dialog', { name: 'Cannot archive yet' })
    expect(context.bridge.archiveSession).toHaveBeenCalledTimes(1)
    expect(within(dialog()).queryByRole('button', { name: 'Stop and archive' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Archive Session B' })).not.toBeNull()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
    expandResults()
    expect(screen.getByRole('button', { name: 'Undo archive of A' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'View archive failure for B' })).not.toBeNull()
  })

  it('blocks the 51st result without evicting prior Undo entries and frees capacity after dismissal', async () => {
    const context = fixture(52)
    await screen.findByRole('button', { name: 'Archive Project Project 52' })
    for (const project of context.projects.slice(0, 50)) {
      const button = screen.getByRole('button', { name: `Archive Project ${project.name}` })
      fireEvent.click(button)
      // Each operation must settle before the next user action; admission is deliberately serialized.
      // oxlint-disable-next-line eslint/no-await-in-loop
      await waitFor(() => {
        // A still-mounted button cannot satisfy the original global absence assertion.
        expect(button.isConnected).toBe(false)
        expect(screen.queryByRole('button', { name: `Archive Project ${project.name}` })).toBeNull()
      })
    }
    expect(screen.getByText('50 archived')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Archive Project Project 51' }))
    await screen.findByText('Review or dismiss some archive results before archiving more items.')
    expect(context.bridge.prepareWorkspaceArchive).toHaveBeenCalledTimes(50)
    expect(context.bridge.archiveProject).toHaveBeenCalledTimes(50)
    expect(context.bridge.archiveProject.mock.calls.map(([projectId]) => projectId)).toEqual(
      context.projects.slice(0, 50).map((project) => project.id),
    )
    const list = expandResults()
    fireEvent.click(
      within(list).getByRole('button', { name: 'Dismiss archive result for Project 50' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Archive Project Project 51' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Archive Project Project 51' })).toBeNull(),
    )
    expect(context.bridge.prepareWorkspaceArchive).toHaveBeenCalledTimes(51)
    expect(screen.getByText('50 archived')).not.toBeNull()
    expect(context.bridge.archiveProject).toHaveBeenCalledTimes(51)
    expect(screen.getByRole('button', { name: 'Archive Project Project 52' })).not.toBeNull()
    const undoTitles: string[] = []
    for (let page = 0; page < 50; page++) {
      undoTitles.push(
        ...within(expandResults())
          .getAllByRole('button', { name: /^Undo archive of Project \d+$/u })
          .map((button) => button.getAttribute('aria-label') ?? ''),
      )
      const next = screen.queryByRole<HTMLButtonElement>('button', { name: 'Next' })
      if (!next || next.disabled) break
      fireEvent.click(next)
    }
    expect(undoTitles.toSorted()).toEqual(
      [...context.projects.slice(0, 49), context.projects[50]!]
        .map((project) => `Undo archive of ${project.name}`)
        .toSorted(),
    )
  }, 15_000)
})
