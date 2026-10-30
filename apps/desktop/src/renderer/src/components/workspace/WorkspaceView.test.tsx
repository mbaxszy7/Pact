// @vitest-environment jsdom

import type { ComponentProps } from 'react'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { DecisionAnswerDraft } from '../conversation/useConversation'

import { CollaborationQuestionCard } from '../conversation/CollaborationQuestionCard'
import { InputReplacement } from '../ui/InputReplacement'
import { WorkspaceView } from './WorkspaceView'

type Props = ComponentProps<typeof WorkspaceView>

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
          agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
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
    sessionProjectPages: {},
    loading: false,
    sessionsLoading: false,
    loadMoreErrors: {},
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
    onLoadMoreSessions: vi.fn<Props['onLoadMoreSessions']>(),
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
  const view = render(<WorkspaceView {...props} />)
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
      <WorkspaceView
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
    view.rerender(<WorkspaceView {...props} />)
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toBe(reply)
    expect(isPainted(replyPane)).toBe(true)
    expect(reply.value).toBe('Unsent reply')
    expect(message.value).toBe('Ordinary message draft')
  }
  expect(props.onSendMessage).not.toHaveBeenCalled()
})
