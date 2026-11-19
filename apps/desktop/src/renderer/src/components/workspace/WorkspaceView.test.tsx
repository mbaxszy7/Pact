// @vitest-environment jsdom

import type { ComponentProps } from 'react'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type {
  CollaborationSession,
  Project,
  RpcResult,
  SessionPage,
  SessionPageInput,
} from '@pact/contracts'

import { SESSION_CATALOG_PAGE_ITEMS } from '@pact/contracts'

import type { DecisionAnswerDraft } from '../conversation/useConversation'
import type { SessionWorkspaceFlow } from './useSessionWorkspace'

import { CollaborationQuestionCard } from '../conversation/CollaborationQuestionCard'
import { InputReplacement } from '../ui/InputReplacement'
import { useSessionWorkspace } from './useSessionWorkspace'
import { WorkspaceView } from './WorkspaceView'

type Props = Omit<ComponentProps<typeof WorkspaceView>, 'sessionWorkspace'>

function WorkspaceFixture(props: Props) {
  const workspace = useSessionWorkspace(false, props.projects, props.onRetry)
  return <WorkspaceView {...props} sessionWorkspace={workspace} />
}

vi.mock('./ProjectNavigation', () => ({ ProjectNavigation: () => <nav>Projects</nav> }))
vi.mock('./SessionHeader', () => ({ SessionHeader: () => <header>Session</header> }))
// Keep the real replacement surfaces and question card at WorkspaceView's visibility boundary.
// Conversation loading and backend projections are unrelated to switching settings pages.
vi.mock('../conversation/ConversationView', () => ({ ConversationView: ConversationFixture }))

function ConversationFixture() {
  const [decision] = useState(() => ({
    reference: {
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      decisionInputSequence: 1,
      expectedInputSequence: 1,
    },
    questions: [],
  }))
  const [draft, setDraft] = useState<DecisionAnswerDraft>()
  return (
    <InputReplacement
      replacement={{
        key: decision.reference.taskId,
        // Active input panes explicitly reset visibility in production CSS.
        // Vitest stubs CSS, so retain that load-bearing declaration in this fixture.
        content: (
          <div style={{ visibility: 'visible' }}>
            <CollaborationQuestionCard
              sessionId="session"
              runId={decision.reference.runId}
              actor="codex"
              disabled={false}
              decision={decision}
              draft={draft}
              onDraftChange={(value) => {
                setDraft(value)
                return true
              }}
              onOpenProjectFile={() => {}}
              onSubmit={() => {}}
              canSubmit
            />
          </div>
        ),
      }}
    >
      <textarea aria-label="Message" defaultValue="Ordinary message draft" />
    </InputReplacement>
  )
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn<() => void>(),
    removeEventListener: vi.fn<() => void>(),
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function fixture(): Props {
  const noop = vi.fn<() => void>()
  const succeeds = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  const completes = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const projectId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const timestamp = '2026-10-23T00:00:00.000Z'
  return {
    projects: [
      {
        id: projectId,
        name: 'Project',
        directoryPath: '/project',
        kind: 'directory',
        createdAt: timestamp,
      },
    ],
    sessions: [
      {
        id: sessionId,
        projectId,
        title: 'Session',
        titleSource: 'local',
        status: 'idle',
        activity: { state: 'idle' },
        hasUnread: false,
        settings: {
          primaryAgentId: 'codex',
          secondaryAgentId: 'claude',
          agents: {
            claude: { model: null, effort: null },
            codex: { model: null, effort: null },
            agy: { model: null, effort: null },
          },
          maxDiscussionRounds: 3,
          maxReviewCycles: 3,
          maxRepairAttempts: 3,
        },
        settingsRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    selectedSessionId: sessionId,
    selectedProjectId: projectId,
    loading: false,
    sessionsLoading: false,
    adding: false,
    creatingSession: false,
    savingSessionSettings: false,
    settingsPage: null,
    agentActionsEnabled: true,
    settingsButtonRef: { current: null },
    creationLoading: false,
    sessionSettingsLoading: false,
    sessionSettingsOpen: false,
    projectFilePanelExpanded: false,
    conversationVisible: true,
    conversationHistory: {
      protectReading: noop,
      readingPositionLost: false,
      retryRead: noop,
      loadingPage: false,
      gapRecoveryPending: false,
      draftLimitExceeded: false,
      draftsLoading: false,
      draftError: false,
      retryDrafts: noop,
      retryComments: noop,
      oversizedActivities: {},
      loadOlder: completes,
      loadLatest: completes,
      recoverFromGap: completes,
      historyResyncToken: 0,
      ensureMessage: completes,
      loadActivities: completes,
      loadRunArtifacts: completes,
      closeRunArtifacts: noop,
      loadMoreActivityBody: vi.fn<Props['conversationHistory']['loadMoreActivityBody']>(),
    },
    conversationComposer: '',
    conversationLoading: false,
    sendingMessage: false,
    stoppingMessage: false,
    conversationComposerSkills: [],
    nativeInputDrafts: {},
    onForkSessionCreated: noop,
    onSaveSessionPermission: succeeds,
    onSaveSessionSpeed: succeeds,
    onAddProject: noop,
    onArchiveProject: noop,
    onRenameProject: vi.fn<Props['onRenameProject']>(),
    onRetry: noop,
    onRetrySessions: noop,
    onOpenSettings: noop,
    onBackToApp: noop,
    onStartSession: noop,
    onCancelSessionCreation: noop,
    onCreateSession: noop,
    onSelectSession: noop,
    onOpenSessionSettings: noop,
    onSessionSettingsOpenChange: noop,
    onRetrySessionSettings: noop,
    onSaveSessionSettings: noop,
    onArchiveSession: noop,
    onRenameSession: succeeds,
    onSendMessage: succeeds,
    onSaveCommentDraft: vi.fn<Props['onSaveCommentDraft']>(),
    onRemoveCommentDraft: succeeds,
    onOpenComment: noop,
    onNotice: noop,
    onConversationComposerChange: noop,
    onConversationComposerDocumentChange: noop,
    onOpenSkillDocument: noop,
    onRetrySkillDocument: noop,
    onConversationComposerSkillsChange: noop,
    onConversationComposerMentionChange: noop,
    onCreateFileComment: succeeds,
    onStopRun: succeeds,
    onRebuildNativeContext: succeeds,
    onCheckNativeContext: succeeds,
    onAcceptPeerProposal: succeeds,
    onDismissPeerProposal: succeeds,
    onUndoWorkspaceChanges: succeeds,
    onRespondNativeInput: succeeds,
    onNativeInputDraftChange: noop,
    onRespondNativePermission: succeeds,
    onOpenWorkspaceChanges: noop,
    onPrepareWorkspaceChanges: vi.fn<() => number>().mockReturnValue(1),
    onOpenProjectFile: noop,
    onProjectFilePanelExpandedChange: noop,
    onRetryProjectFile: noop,
  }
}

function isPainted(element: HTMLElement): boolean {
  // A descendant can override inherited visibility. Checking every ancestor's
  // visibility would incorrectly treat the original leaking card as hidden.
  if (['hidden', 'collapse'].includes(getComputedStyle(element).visibility)) return false
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    if (style.display === 'none' || style.opacity === '0') return false
  }
  return true
}

it('hides pending input on every settings page and preserves both drafts when returning', () => {
  const props = fixture()
  const client = new QueryClient()
  const view = render(<WorkspaceFixture {...props} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
  const reply = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Your answer' })
  const message = screen.getByLabelText<HTMLTextAreaElement>('Message')
  const replyPane = reply.closest<HTMLElement>('[style]')!
  const messagePane = message.closest<HTMLElement>('.input-replacement-pane')!
  fireEvent.change(reply, { target: { value: 'Unsent reply' } })
  expect(isPainted(replyPane)).toBe(true)
  for (const settingsPage of [
    'decision-scheduling',
    'appearance',
    'session-defaults',
    'updates',
  ] as const) {
    view.rerender(
      <WorkspaceFixture
        {...props}
        settingsPage={settingsPage}
        conversationVisible={false}
        settingsView={<h1>{settingsPage}</h1>}
      />,
    )
    expect(isPainted(screen.getByRole('heading', { name: settingsPage }))).toBe(true)
    expect(isPainted(replyPane)).toBe(false)
    expect(isPainted(messagePane)).toBe(false)
    expect(view.container.contains(reply)).toBe(true)
    view.rerender(<WorkspaceFixture {...props} />)
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toBe(reply)
    expect(isPainted(replyPane)).toBe(true)
    expect(reply.value).toBe('Unsent reply')
    expect(message.value).toBe('Ordinary message draft')
  }
  expect(props.onSendMessage).not.toHaveBeenCalled()
})

it('renders Add project and preserves keyboard focus across ProjectNavigation virtual scroll', async () => {
  const rect = {
    top: 0,
    left: 0,
    right: 240,
    bottom: 200,
    width: 240,
    height: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      observe(target: Element) {
        this.callback(
          [
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test ResizeObserver entry shape in jsdom.
            {
              target,
              contentRect: rect,
              borderBoxSize: [{ inlineSize: 240, blockSize: 200 }],
            } as unknown as ResizeObserverEntry,
          ],
          this,
        )
      }
      unobserve() {}
      disconnect() {}
    },
  )

  const { ProjectNavigation } =
    await vi.importActual<typeof import('./ProjectNavigation')>('./ProjectNavigation')
  const projects: Project[] = Array.from({ length: 60 }, (_, index) => ({
    id: crypto.randomUUID(),
    name: `Project ${String(index).padStart(2, '0')}`,
    directoryPath: `/tmp/project-${index}`,
    kind: 'directory',
    createdAt: new Date(Date.parse('2026-10-23T00:00:00.000Z') + index).toISOString(),
  }))
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Controlled workspace stub for ProjectNavigation virtual scroll verification.
  const workspace = {
    catalog: {
      navigation: {
        projects: Object.fromEntries(
          projects.map((project) => [
            project.id,
            {
              hasGroups: false,
              revision: 0,
              windows: {
                ungrouped: {
                  kind: 'page' as const,
                  projectId: project.id,
                  scope: { kind: 'ungrouped' as const },
                  groupRevision: 0,
                  revision: 0,
                  ids: [],
                  hasGroups: false,
                  touched: 0,
                },
              },
            },
          ]),
        ),
      },
      sessions: [],
    },
    creating: false,
    writingOrganization: false,
    checkingWrite: false,
    setVisibleWindows: vi.fn<() => void>(),
    loadPage: vi.fn<SessionWorkspaceFlow['loadPage']>().mockResolvedValue(true),
    loadGroups: vi.fn<SessionWorkspaceFlow['loadGroups']>().mockResolvedValue(true),
  } as unknown as SessionWorkspaceFlow
  const base = fixture()
  render(
    <ProjectNavigation
      projects={projects}
      sessions={[]}
      workspace={workspace}
      loading={false}
      adding={false}
      navigationVisible={false}
      settingsButtonRef={base.settingsButtonRef}
      onAddProject={base.onAddProject}
      onArchiveProject={base.onArchiveProject}
      onRenameProject={base.onRenameProject}
      onOpenSettings={base.onOpenSettings}
      onRetrySessions={base.onRetrySessions}
      onStartSession={base.onStartSession}
      onSelectSession={base.onSelectSession}
      onArchiveSession={base.onArchiveSession}
    />,
  )

  try {
    expect(screen.getByRole('button', { name: /^Add project$/u })).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: 'Projects and Sessions' })
    Object.defineProperty(nav, 'clientHeight', { value: 200, configurable: true })
    Object.defineProperty(nav, 'scrollHeight', { value: 2400, configurable: true })

    const firstProjectButton = screen.getByRole('button', {
      name: /^Rename Project Project 00$/u,
    })
    firstProjectButton.focus()
    expect(nav.contains(document.activeElement)).toBe(true)

    nav.scrollTop = 1400
    fireEvent.scroll(nav)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Rename Project Project 00$/u })).toBeNull(),
    )
    expect(nav.contains(document.activeElement)).toBe(true)
  } finally {
    vi.restoreAllMocks()
  }
})

it('rebases loadPage after CONFLICT on explicit older page to load five unseen sessions', async () => {
  const projectId = crypto.randomUUID()
  const project: Project = {
    id: projectId,
    name: 'Catalog scale',
    directoryPath: '/tmp/catalog-scale',
    kind: 'git',
    createdAt: '2026-10-23T00:00:00.000Z',
  }
  const baseSettings: CollaborationSession['settings'] = {
    primaryAgentId: 'codex',
    secondaryAgentId: 'claude',
    agents: {
      claude: { model: null, effort: null },
      codex: { model: null, effort: null },
      agy: { model: null, effort: null },
    },
    maxDiscussionRounds: 6,
    maxReviewCycles: 3,
    maxRepairAttempts: 3,
  }
  const makeSession = (index: number): CollaborationSession => {
    const createdAt = new Date(Date.parse('2026-10-23T00:00:00.000Z') + index).toISOString()
    return {
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      projectId,
      title: `Session ${index}`,
      titleSource: 'user',
      status: 'idle',
      activity: { state: 'idle' },
      hasUnread: false,
      settings: baseSettings,
      settingsRevision: 1,
      createdAt,
      updatedAt: createdAt,
    }
  }
  const firstBatch = [990, 980, 970, 960, 950].map(makeSession)
  const secondBatch = [940, 930, 920, 910, 900].map(makeSession)
  const pageCursor = (last: CollaborationSession, revision: number): SessionPage['nextCursor'] => ({
    projectId,
    scope: { kind: 'ungrouped' },
    revision,
    direction: 'older',
    createdAt: last.createdAt,
    id: last.id,
  })
  const firstCursor = pageCursor(firstBatch.at(-1)!, 1)
  const rebasedCursor1 = pageCursor(firstBatch.at(-1)!, 2)
  const rebasedCursor2 = pageCursor(secondBatch.at(-1)!, 2)

  const getSessionPage = vi.fn<(input: SessionPageInput) => Promise<RpcResult<SessionPage>>>(
    async (input: SessionPageInput) => {
      if (!input.cursor && getSessionPage.mock.calls.length === 1) {
        return {
          ok: true as const,
          value: {
            kind: 'page' as const,
            projectId,
            scope: { kind: 'ungrouped' as const },
            groupRevision: 0,
            revision: 1,
            sessions: firstBatch,
            nextCursor: firstCursor,
            hasGroups: false,
          },
        }
      }
      if (input.cursor?.revision === 1) {
        return {
          ok: false as const,
          error: { code: 'CONFLICT' as const, message: 'Revision changed.' },
        }
      }
      if (!input.cursor) {
        return {
          ok: true as const,
          value: {
            kind: 'page' as const,
            projectId,
            scope: { kind: 'ungrouped' as const },
            groupRevision: 0,
            revision: 2,
            sessions: firstBatch,
            nextCursor: rebasedCursor1,
            hasGroups: false,
          },
        }
      }
      return {
        ok: true as const,
        value: {
          kind: 'page' as const,
          projectId,
          scope: { kind: 'ungrouped' as const },
          groupRevision: 0,
          revision: 2,
          sessions: secondBatch,
          nextCursor: rebasedCursor2,
          hasGroups: false,
        },
      }
    },
  )

  vi.stubGlobal('pact', { getSessionPage })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Harness() {
    const workspace = useSessionWorkspace(true, [project], () => {})
    const [loadedState, setLoadedState] = useState('idle')
    const ids = workspace.catalog?.navigation?.projects[projectId]?.windows.ungrouped?.ids ?? []
    return (
      <>
        <button
          type="button"
          onClick={() => {
            void workspace
              .loadPage({
                projectId,
                scope: { kind: 'ungrouped' },
                cursor: firstCursor,
              })
              .then((result) => setLoadedState(String(result)))
          }}
        >
          Load older
        </button>
        <output aria-label="Loaded state">{loadedState}</output>
        <output aria-label="Window ids">{JSON.stringify(ids)}</output>
      </>
    )
  }
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  )

  await waitFor(() =>
    expect(JSON.parse(screen.getByLabelText('Window ids').textContent ?? '[]')).toEqual(
      firstBatch.map((item) => item.id),
    ),
  )

  fireEvent.click(screen.getByRole('button', { name: 'Load older' }))
  await waitFor(() => expect(screen.getByLabelText('Loaded state').textContent).toBe('true'))
  expect(getSessionPage).toHaveBeenCalledTimes(4)
  await waitFor(() =>
    expect(JSON.parse(screen.getByLabelText('Window ids').textContent ?? '[]')).toEqual(
      [...firstBatch, ...secondBatch].map((item) => item.id),
    ),
  )
  expect(secondBatch).toHaveLength(SESSION_CATALOG_PAGE_ITEMS)
})
