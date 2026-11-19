// @vitest-environment jsdom

import type { Virtualizer } from '@tanstack/react-virtual'
import type { ComponentProps } from 'react'

import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CollaborationSession,
  DesktopBridge,
  Project,
  RpcResult,
  RuntimePreparation,
  SessionIssues,
  SessionSettingsEditorState,
  SideChatSummary,
  SideChatSyncMainReceipt,
} from '@pact/contracts'

import { OPENAI_DECISION_MODEL } from '@pact/contracts'

import type { ConversationViewProjection } from './components/conversation/conversation-window'
import type { WorkspaceView } from './components/workspace/WorkspaceView'

import App, { requiredAgentsForSession } from './App'
import { composerBridgeFixture } from './components/conversation/composer.test-helper'
import { initialSessionSettings } from './components/settings/session/SessionSettingsFields'
import { createRendererQueryClient } from './query-client'

const conversationState = vi.hoisted(() => ({
  mainSnapshot: undefined as ConversationViewProjection | undefined,
  sideSnapshot: undefined as ConversationViewProjection | undefined,
  sideComposer: '',
  sendMock: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  syncToMainMock: vi.fn<() => Promise<SideChatSyncMainReceipt | undefined>>(),
}))

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>()
  return {
    ...actual,
    useVirtualizer: (
      options: Parameters<typeof actual.useVirtualizer>[0],
    ): Virtualizer<Element, Element> =>
      actual.useVirtualizer({
        ...options,
        initialRect: { width: 900, height: 600 },
        observeElementRect: (_instance, callback) => {
          callback({ width: 900, height: 600 })
          return () => undefined
        },
        observeElementOffset: (_owner, callback) => {
          callback(0, false)
          return () => undefined
        },
        measureElement: () => 120,
      }),
  }
})

vi.mock('./components/conversation/useConversation', () => ({
  useConversation: (sessionId?: string) => {
    const isSide = Boolean(
      sessionId &&
      conversationState.sideSnapshot &&
      conversationState.sideSnapshot.sessionId === sessionId,
    )
    const snapshot = isSide ? conversationState.sideSnapshot : conversationState.mainSnapshot
    return {
      snapshot,
      loading: false,
      sending: false,
      stopping: false,
      error: undefined,
      composer: isSide ? conversationState.sideComposer : '',
      composerImages: [],
      choosingImages: false,
      addComposerImages: vi.fn<() => Promise<void>>(),
      chooseComposerImages: vi.fn<() => Promise<void>>(),
      removeComposerImage: vi.fn<() => void>(),
      setComposer: (text: string) => {
        if (isSide) conversationState.sideComposer = text
      },
      setComposerDocument: (doc: { text: string }) => {
        if (isSide) conversationState.sideComposer = doc.text
      },
      composerSkills: [],
      setComposerSkills: vi.fn<() => void>(),
      composerMention: undefined,
      setComposerMention: vi.fn<() => void>(),
      composerRoute: undefined,
      composerReturnedInputOperationId: undefined,
      composerUserInformation: undefined,
      composerRevision: 1,
      clearSubmittedComposerDraft: vi.fn<() => void>(),
      seedComposerDraft: vi.fn<() => boolean>(() => true),
      syncToMain: conversationState.syncToMainMock,
      send: conversationState.sendMock,
      saveCommentDraft: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      removeCommentDraft: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      stop: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      rebuildNativeContext: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      checkNativeContext: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      acceptPeerProposal: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      dismissPeerProposal: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      undoWorkspaceChanges: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      respondNativePermission: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      respondNativeInput: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      nativeInputDrafts: {},
      setNativeInputDraft: vi.fn<() => void>(),
      history: {
        window: snapshot
          ? {
              view: snapshot,
              messageMeta: {},
              activityMeta: {},
              activityBodyResync: {},
              sentCommentsByMessage: {},
              loadedCommentMessageIds: {},
              hasOlder: false,
              hasNewer: false,
            }
          : undefined,
        retryRead: vi.fn<() => void>(),
        draftsLoading: false,
        restoringInput: false,
      },
    }
  },
  commentDraftSaveSucceeded: vi.fn<() => void>(),
}))

vi.mock('./components/workspace/WorkspaceView', () => ({
  WorkspaceView: (props: ComponentProps<typeof WorkspaceView>) => (
    <main>
      <output aria-label="Main Actions Enabled">{String(props.agentActionsEnabled)}</output>
      <div data-testid="runtime-notice">{props.runtimeNotice ?? null}</div>
      {props.sessions.map((session) => (
        <button key={session.id} type="button" onClick={() => props.onSelectSession(session.id)}>
          Open Session {session.title}
        </button>
      ))}
      {props.onOpenSideChats ? (
        <button type="button" onClick={() => props.onOpenSideChats?.()}>
          Open side chats
        </button>
      ) : null}
      {props.sideChatsOpen ? props.sideChatsPanel : null}
    </main>
  ),
}))

const timestamp = '2026-11-19T08:00:00.000Z'
const clients: ReturnType<typeof createRendererQueryClient>[] = []

beforeEach(() => {
  conversationState.mainSnapshot = undefined
  conversationState.sideSnapshot = undefined
  conversationState.sideComposer = ''
  conversationState.sendMock.mockClear()
  conversationState.syncToMainMock.mockReset()
  Object.defineProperty(HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value: vi.fn<(this: HTMLElement) => void>(function (this: HTMLElement) {
      this.style.display = 'block'
    }),
  })
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value: vi.fn<() => void>(),
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn<() => void>(),
    removeEventListener: vi.fn<() => void>(),
  }))
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn<() => void>(),
  })
})

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function setupAppFixture(options: {
  preparation: RuntimePreparation
  mainIssues?: SessionIssues | undefined
  sideChatItems?: SideChatSummary[] | undefined
  getSessionSettings: DesktopBridge['getSessionSettings']
}) {
  const projectId = crypto.randomUUID()
  const mainSessionId = crypto.randomUUID()
  const projects: Project[] = [
    {
      id: projectId,
      name: 'Parity Project',
      directoryPath: '/tmp/parity-project',
      kind: 'directory',
      createdAt: timestamp,
    },
  ]
  const mainSession: CollaborationSession = {
    id: mainSessionId,
    projectId,
    title: 'Main Session',
    titleSource: 'local',
    status: 'idle',
    activity: { state: 'idle' },
    hasUnread: false,
    settings: {
      ...initialSessionSettings,
      primaryAgentId: 'claude',
      secondaryAgentId: 'codex',
    },
    settingsRevision: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  conversationState.mainSnapshot = {
    observation: { incarnation: crypto.randomUUID(), sequence: 1 },
    sessionId: mainSessionId,
    session: {
      id: mainSessionId,
      title: mainSession.title,
      titleSource: mainSession.titleSource,
      status: 'idle',
      activity: { state: 'idle' },
      hasUnread: false,
      updatedAt: timestamp,
    },
    messages: [],
    draftComments: [],
    commentsRevision: 0,
    activities: [],
    runs: [],
    nativeContexts: [],
    ...(options.mainIssues ? { sessionIssues: options.mainIssues } : {}),
  }

  const sideChatItems = (options.sideChatItems ?? []).map((item) =>
    Object.assign({}, item, {
      projectId,
      parentSessionId: mainSessionId,
    }),
  )

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
      value: {
        enabled: true,
        preferencesReady: true,
        currentVersion: '0.4.0',
        autoCheck: true,
        revision: 0,
        latest: null,
        checkedAt: timestamp,
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
    onSessionReminderChanged: vi.fn<NonNullable<DesktopBridge['onSessionReminderChanged']>>(
      () => () => undefined,
    ),
    setConversationInterest: vi.fn<DesktopBridge['setConversationInterest']>(async () => ({
      ok: true,
      value: { ready: true },
    })),
    listSideChats: vi.fn<DesktopBridge['listSideChats']>(async ({ parentSessionId }) => ({
      ok: true,
      value: {
        parentSessionId,
        items: sideChatItems,
        nextCursor: null,
        prevCursor: null,
        hasMoreOlder: false,
        hasMoreNewer: false,
        activeCount: 0,
        attentionCount: 0,
        unreadCount: 0,
      },
    })),
    ...composerBridgeFixture(),
    getConversation: vi.fn<DesktopBridge['getConversation']>(async (input) => {
      if (input.scope === 'collaboration') {
        return {
          ok: true,
          value: {
            scope: 'collaboration',
            sessionId: input.sessionId,
            view: {
              task: null,
              availableActions: [],
              reportAvailable: false,
              accepted: false,
              actionable: false,
            },
          },
        }
      }
      throw new Error(`Unexpected scope ${input.scope}`)
    }),
    getSessionSettings: options.getSessionSettings,
    getAppInfo: vi.fn<DesktopBridge['getAppInfo']>(async () => ({
      ok: true,
      value: { name: 'Pact', version: '0.4.0', platform: 'darwin', arch: 'arm64', packaged: false },
    })),
    getRuntimePreparation: vi.fn<DesktopBridge['getRuntimePreparation']>(async () => ({
      ok: true,
      value: options.preparation,
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
      value: { projects, archivedProjects: [], revision: 1 },
    })),
    getSessionPage: vi.fn<DesktopBridge['getSessionPage']>(async ({ projectId: pid, scope }) => ({
      ok: true,
      value: {
        kind: 'page',
        projectId: pid,
        scope,
        groupRevision: 0,
        revision: 1,
        sessions: scope.kind === 'ungrouped' ? [mainSession] : [],
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
  return { projectId, mainSessionId, bridge }
}

describe('App 3-agent active-pair & Side Chat parity', () => {
  it('excludes settled warnings on retired 3rd CLIs from requiredAgentsForSession while including blocking phases', async () => {
    const session: CollaborationSession = {
      id: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      title: 'Pair Check',
      titleSource: 'local',
      status: 'idle',
      activity: { state: 'idle' },
      hasUnread: false,
      settings: {
        ...initialSessionSettings,
        primaryAgentId: 'claude',
        secondaryAgentId: 'codex',
      },
      settingsRevision: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    const withSettledRetiredWarning: SessionIssues = {
      sessionId: session.id,
      inputGate: 'open',
      agents: [
        {
          agentId: 'agy',
          generation: 1,
          phase: 'warning',
          title: 'Antigravity quota exhausted',
          reason: 'Quota reached.',
          inputDisposition: 'submitted',
          resultDisposition: 'unavailable',
          action: 'retry_check',
          abandon: false,
          previousCreationUnconfirmed: false,
        },
      ],
    }
    expect(requiredAgentsForSession(session, withSettledRetiredWarning)).toEqual([
      'claude',
      'codex',
    ])

    const withBlockingRetiredIssue: SessionIssues = {
      sessionId: session.id,
      inputGate: 'read_only',
      agents: [
        {
          agentId: 'agy',
          generation: 1,
          phase: 'rebuild_offer',
          title: 'Antigravity session not confirmed',
          reason: 'Rebuild required.',
          inputDisposition: 'possibly_submitted',
          resultDisposition: 'unavailable',
          action: 'rebuild',
          abandon: false,
          previousCreationUnconfirmed: false,
        },
      ],
    }
    expect(requiredAgentsForSession(session, withBlockingRetiredIssue)).toEqual([
      'claude',
      'codex',
      'agy',
    ])

    // Also verify live <App /> keeps mainActionsEnabled === true and no RuntimeDegradedNotice
    // when offline retired agy only has a historical warning!
    setupAppFixture({
      preparation: {
        firstUse: false,
        agents: [
          {
            agentId: 'claude',
            state: 'ready',
            executablePath: '/bin/claude',
            version: '2.1.272',
            checkedAt: timestamp,
          },
          {
            agentId: 'codex',
            state: 'ready',
            executablePath: '/bin/codex',
            version: '0.159.2',
            checkedAt: timestamp,
          },
          {
            agentId: 'agy',
            state: 'authentication_required',
            executablePath: '/bin/agy',
            version: '1.5.12',
            checkedAt: timestamp,
          },
        ],
      },
      mainIssues: withSettledRetiredWarning,
      getSessionSettings: vi.fn<DesktopBridge['getSessionSettings']>(),
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Open Session Main Session' }))
    expect(screen.getByLabelText('Main Actions Enabled').textContent).toBe('true')
    expect(screen.getByTestId('runtime-notice').textContent).toBe('')
  })

  it('cold-opening a Side Chat shows transcript while getSessionSettings loads, disables send without inheriting parent settings, and retries after error', async () => {
    const sideChatId = crypto.randomUUID()
    const sideMsgId = crypto.randomUUID()
    conversationState.sideSnapshot = {
      observation: { incarnation: crypto.randomUUID(), sequence: 1 },
      sessionId: sideChatId,
      session: {
        id: sideChatId,
        title: 'Locked Agy Side Chat',
        titleSource: 'local',
        status: 'idle',
        activity: { state: 'idle' },
        hasUnread: false,
        updatedAt: timestamp,
      },
      messages: [
        {
          id: sideMsgId,
          sessionId: sideChatId,
          role: 'assistant',
          agentId: 'agy',
          content: 'Historical side chat answer.',
          contentRevision: 0,
          state: 'complete',
          sequence: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      draftComments: [],
      commentsRevision: 0,
      activities: [],
      runs: [],
      nativeContexts: [],
      sessionIssues: { sessionId: sideChatId, inputGate: 'open', agents: [] },
    }
    conversationState.sideComposer = 'Follow up inside side chat'

    let resolveFirstAttempt!: (result: RpcResult<SessionSettingsEditorState>) => void
    let callCount = 0
    let capturedProjectId = ''
    let capturedParentId = ''

    const getSessionSettings = vi.fn<DesktopBridge['getSessionSettings']>((id) => {
      callCount += 1
      if (callCount === 1) {
        return new Promise<RpcResult<SessionSettingsEditorState>>((resolve) => {
          resolveFirstAttempt = resolve
        })
      }
      return Promise.resolve({
        ok: true,
        value: {
          session: {
            id,
            projectId: capturedProjectId,
            parentSessionId: capturedParentId,
            title: 'Locked Agy Side Chat',
            titleSource: 'local',
            status: 'idle',
            activity: { state: 'idle' },
            hasUnread: false,
            settings: {
              ...initialSessionSettings,
              primaryAgentId: 'claude',
              secondaryAgentId: 'agy',
            },
            settingsRevision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
            sideChatOrigin: 'btw',
          },
          modelCatalogs: {
            claude: { agentId: 'claude', status: 'available', models: [], checkedAt: timestamp },
            codex: { agentId: 'codex', status: 'available', models: [], checkedAt: timestamp },
            agy: { agentId: 'agy', status: 'available', models: [], checkedAt: timestamp },
          },
        },
      })
    })

    const { projectId, mainSessionId } = setupAppFixture({
      preparation: {
        firstUse: false,
        agents: [
          {
            agentId: 'claude',
            state: 'ready',
            executablePath: '/bin/claude',
            version: '2.1.272',
            checkedAt: timestamp,
          },
          {
            agentId: 'codex',
            state: 'ready',
            executablePath: '/bin/codex',
            version: '0.159.2',
            checkedAt: timestamp,
          },
          {
            agentId: 'agy',
            state: 'ready',
            executablePath: '/bin/agy',
            version: '1.5.12',
            checkedAt: timestamp,
          },
        ],
      },
      sideChatItems: [
        {
          id: sideChatId,
          projectId: crypto.randomUUID(),
          parentSessionId: crypto.randomUUID(),
          origin: 'btw',
          anchorQuotePreview: null,
          title: 'Locked Agy Side Chat',
          status: 'idle',
          isRunning: false,
          needsAttention: false,
          hasUnread: false,
          previewText: 'Historical side chat answer.',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      getSessionSettings,
    })
    capturedProjectId = projectId
    capturedParentId = mainSessionId

    expect(await screen.findByRole('button', { name: 'Open Session Main Session' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Session Main Session' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open side chats' }))
    fireEvent.click(await screen.findByText('Locked Agy Side Chat'))

    // 1. While getSessionSettings is pending, transcript history is readable, AND Send is disabled!
    expect(await screen.findByText('Historical side chat answer.')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' }).disabled).toBe(
      true,
    )

    // 2. Simulate getSessionSettings failing -> alert banner + Try again button appears, Send stays disabled!
    resolveFirstAttempt({
      ok: false,
      error: { code: 'INTERNAL', message: 'Side chat settings read timed out.' },
    })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Side chat settings read timed out.')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' }).disabled).toBe(
      true,
    )

    // 3. Click Try again -> locked settings load and unlock Send!
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => {
      expect(screen.queryByText('Side chat settings read timed out.')).toBeNull()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' }).disabled).toBe(
        false,
      )
    })
  })

  it('keeps @Main sync enabled in a Side Chat whose locked 3rd CLI is offline while parent pair is ready', async () => {
    const sideChatId = crypto.randomUUID()
    conversationState.sideSnapshot = {
      observation: { incarnation: crypto.randomUUID(), sequence: 1 },
      sessionId: sideChatId,
      session: {
        id: sideChatId,
        title: 'Offline Agy Side Chat',
        titleSource: 'local',
        status: 'idle',
        activity: { state: 'idle' },
        hasUnread: false,
        updatedAt: timestamp,
      },
      messages: [],
      draftComments: [],
      commentsRevision: 0,
      activities: [],
      runs: [],
      nativeContexts: [],
      sessionIssues: { sessionId: sideChatId, inputGate: 'open', agents: [] },
    }
    conversationState.sideComposer = '@Main Sync takeaway to ready parent'

    let capturedProjectId = ''
    let capturedParentId = ''
    conversationState.syncToMainMock.mockImplementation(async () => ({
      operationId: crypto.randomUUID(),
      sideChatId,
      parentSessionId: capturedParentId,
      cutoffId: crypto.randomUUID(),
      disposition: 'sent',
      mainMessageId: crypto.randomUUID(),
      queuedOperationId: null,
    }))

    const { projectId, mainSessionId } = setupAppFixture({
      preparation: {
        firstUse: false,
        agents: [
          {
            agentId: 'claude',
            state: 'ready',
            executablePath: '/bin/claude',
            version: '2.1.272',
            checkedAt: timestamp,
          },
          {
            agentId: 'codex',
            state: 'ready',
            executablePath: '/bin/codex',
            version: '0.159.2',
            checkedAt: timestamp,
          },
          {
            agentId: 'agy',
            state: 'authentication_required',
            executablePath: '/bin/agy',
            version: '1.5.12',
            checkedAt: timestamp,
          },
        ],
      },
      sideChatItems: [
        {
          id: sideChatId,
          projectId: crypto.randomUUID(),
          parentSessionId: crypto.randomUUID(),
          origin: 'btw',
          anchorQuotePreview: null,
          title: 'Offline Agy Side Chat',
          status: 'idle',
          isRunning: false,
          needsAttention: false,
          hasUnread: false,
          previewText: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      getSessionSettings: vi.fn<DesktopBridge['getSessionSettings']>(async (id) => ({
        ok: true,
        value: {
          session: {
            id,
            projectId: capturedProjectId,
            parentSessionId: capturedParentId,
            title: 'Offline Agy Side Chat',
            titleSource: 'local',
            status: 'idle',
            activity: { state: 'idle' },
            hasUnread: false,
            settings: {
              ...initialSessionSettings,
              primaryAgentId: 'claude',
              secondaryAgentId: 'agy',
            },
            settingsRevision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
            sideChatOrigin: 'btw',
          },
          modelCatalogs: {
            claude: { agentId: 'claude', status: 'available', models: [], checkedAt: timestamp },
            codex: { agentId: 'codex', status: 'available', models: [], checkedAt: timestamp },
            agy: { agentId: 'agy', status: 'unavailable', models: [], checkedAt: timestamp },
          },
        },
      })),
    })
    capturedProjectId = projectId
    capturedParentId = mainSessionId

    expect(await screen.findByRole('button', { name: 'Open Session Main Session' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Session Main Session' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open side chats' }))
    fireEvent.click(await screen.findByText('Offline Agy Side Chat'))

    const sendToMain = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Send to main',
    })
    await waitFor(() => expect(sendToMain.disabled).toBe(false))
    fireEvent.click(sendToMain)
    await waitFor(() => expect(conversationState.syncToMainMock).toHaveBeenCalledTimes(1))
    expect(conversationState.syncToMainMock).toHaveBeenCalledWith(
      'Sync takeaway to ready parent',
      [],
      [],
    )
  })

  it('includes retired members with abandon === true warnings in requiredAgentsForSession and renders neutral empty copy for cold-opened Side Chats before settings resolve', async () => {
    const baseSession: CollaborationSession = {
      id: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      title: 'Session Issue Gate',
      titleSource: 'local',
      status: 'idle',
      activity: { state: 'idle' },
      hasUnread: false,
      settings: {
        ...initialSessionSettings,
        primaryAgentId: 'claude',
        secondaryAgentId: 'codex',
      },
      settingsRevision: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    // Settled warning (abandon: false) on retired agy is excluded, whereas abandon: true (unknown effects) is included!
    expect(
      requiredAgentsForSession(baseSession, {
        sessionId: baseSession.id,
        inputGate: 'open',
        agents: [
          {
            agentId: 'agy',
            generation: 1,
            phase: 'warning',
            title: 'Quota exceeded',
            reason: 'Settled quota warning',
            inputDisposition: 'not_submitted',
            resultDisposition: 'unavailable',
            action: 'none',
            abandon: false,
            previousCreationUnconfirmed: false,
          },
        ],
      }),
    ).toEqual(['claude', 'codex'])

    expect(
      requiredAgentsForSession(baseSession, {
        sessionId: baseSession.id,
        inputGate: 'open',
        agents: [
          {
            agentId: 'agy',
            generation: 1,
            phase: 'warning',
            title: 'Unsettled effects',
            reason: 'Retired member still has unknown workspace effects',
            inputDisposition: 'submitted',
            resultDisposition: 'complete',
            action: 'none',
            abandon: true,
            previousCreationUnconfirmed: false,
          },
        ],
      }),
    ).toEqual(['claude', 'codex', 'agy'])

    // Cold-opened empty Side Chat: verify neutral copy while loading and on error (never guessing 'Ask Claude Code'!)
    const sideChatId = crypto.randomUUID()
    conversationState.sideSnapshot = {
      observation: { incarnation: crypto.randomUUID(), sequence: 1 },
      sessionId: sideChatId,
      session: {
        id: sideChatId,
        title: 'Empty Cold Side Chat',
        titleSource: 'local',
        status: 'idle',
        activity: { state: 'idle' },
        hasUnread: false,
        updatedAt: timestamp,
      },
      messages: [],
      draftComments: [],
      commentsRevision: 0,
      activities: [],
      runs: [],
      nativeContexts: [],
      sessionIssues: { sessionId: sideChatId, inputGate: 'open', agents: [] },
    }
    conversationState.sideComposer = ''

    let resolveSideSettings: ((res: RpcResult<SessionSettingsEditorState>) => void) | undefined
    let attempt = 0
    let capturedProjectId = ''
    let capturedParentId = ''

    const { projectId, mainSessionId } = setupAppFixture({
      preparation: {
        firstUse: false,
        agents: [
          {
            agentId: 'claude',
            state: 'ready',
            executablePath: '/bin/claude',
            version: '2.1.272',
            checkedAt: timestamp,
          },
          {
            agentId: 'codex',
            state: 'ready',
            executablePath: '/bin/codex',
            version: '0.159.2',
            checkedAt: timestamp,
          },
          {
            agentId: 'agy',
            state: 'ready',
            executablePath: '/bin/agy',
            version: '1.5.12',
            checkedAt: timestamp,
          },
        ],
      },
      sideChatItems: [
        {
          id: sideChatId,
          projectId: crypto.randomUUID(),
          parentSessionId: crypto.randomUUID(),
          origin: 'btw',
          anchorQuotePreview: null,
          title: 'Empty Cold Side Chat',
          status: 'idle',
          isRunning: false,
          needsAttention: false,
          hasUnread: false,
          previewText: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      getSessionSettings: vi.fn<DesktopBridge['getSessionSettings']>(
        () =>
          new Promise<RpcResult<SessionSettingsEditorState>>((resolve) => {
            attempt += 1
            resolveSideSettings = resolve
          }),
      ),
    })
    capturedProjectId = projectId
    capturedParentId = mainSessionId

    expect(await screen.findByRole('button', { name: 'Open Session Main Session' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Session Main Session' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open side chats' }))
    fireEvent.click(await screen.findByText('Empty Cold Side Chat'))

    // While loading: renders 'Loading side chat settings…', NEVER 'Ask Claude Code'!
    expect(await screen.findByRole('heading', { name: 'Loading side chat settings…' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Ask Claude Code' })).toBeNull()
    expect(attempt).toBe(1)

    // On failure: renders 'Ask in this side chat', still NEVER 'Ask Claude Code'!
    resolveSideSettings?.({
      ok: false,
      error: { code: 'INTERNAL', message: 'Settings storage busy.' },
    })
    expect(await screen.findByRole('heading', { name: 'Ask in this side chat' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Ask Claude Code' })).toBeNull()

    // On retry resolving locked (codex, agy): renders 'Ask Codex'!
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(attempt).toBe(2))
    resolveSideSettings?.({
      ok: true,
      value: {
        session: {
          id: sideChatId,
          projectId: capturedProjectId,
          parentSessionId: capturedParentId,
          title: 'Empty Cold Side Chat',
          titleSource: 'local',
          status: 'idle',
          activity: { state: 'idle' },
          hasUnread: false,
          settings: {
            ...initialSessionSettings,
            primaryAgentId: 'codex',
            secondaryAgentId: 'agy',
          },
          settingsRevision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          sideChatOrigin: 'btw',
        },
        modelCatalogs: {
          claude: { agentId: 'claude', status: 'available', models: [], checkedAt: timestamp },
          codex: { agentId: 'codex', status: 'available', models: [], checkedAt: timestamp },
          agy: { agentId: 'agy', status: 'available', models: [], checkedAt: timestamp },
        },
      },
    })
    expect(await screen.findByRole('heading', { name: 'Ask Codex' })).toBeTruthy()
  })
})
