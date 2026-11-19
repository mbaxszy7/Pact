// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CollaborationSession, SideChatSummary } from '@pact/contracts'

import type { useSideChats } from './useSideChats'

import { SessionHeader } from './SessionHeader'
import { SideChatsPanel } from './SideChatsPanel'
import { SideChatStage } from './SideChatStage'

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>()
  return {
    ...actual,
    useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) =>
      actual.useVirtualizer({
        ...options,
        initialRect: { width: 380, height: 672 },
        observeElementRect: (_instance, callback) => {
          callback({ width: 380, height: 672 })
          return () => undefined
        },
        observeElementOffset: (_owner, callback) => {
          callback(0, false)
          return () => undefined
        },
      }),
  }
})

type SideChatsController = ReturnType<typeof useSideChats>

const parentSessionId = '10000000-0000-4000-8000-000000000001'
const projectId = '20000000-0000-4000-8000-000000000001'
const baseTimestamp = '2026-11-19T05:00:00.000Z'

function makeSummary(overrides: Partial<SideChatSummary> = {}): SideChatSummary {
  return {
    id: crypto.randomUUID(),
    parentSessionId,
    projectId,
    title: 'Side chat title',
    origin: 'btw',
    anchorQuotePreview: null,
    previewText: null,
    status: 'idle',
    isRunning: false,
    needsAttention: false,
    hasUnread: false,
    createdAt: baseTimestamp,
    updatedAt: baseTimestamp,
    ...overrides,
  }
}

function makeController(overrides: Partial<SideChatsController> = {}): SideChatsController {
  return {
    items: [],
    residentBytes: 2,
    hasMoreOlder: false,
    hasMoreNewer: false,
    activeCount: 0,
    attentionCount: 0,
    unreadCount: 0,
    initialized: true,
    loadingInitial: false,
    loadingMoreOlder: false,
    loadingMoreNewer: false,
    initialError: undefined,
    olderError: undefined,
    newerError: undefined,
    loadOlder: vi.fn<() => void>(),
    loadNewer: vi.fn<() => void>(),
    retryInitial: vi.fn<() => void>(),
    refresh: vi.fn<() => void>(),
    applyCreatedSideChat: vi.fn<(summary: SideChatSummary) => void>(),
    removeSideChat: vi.fn<(sideChatId: string) => void>(),
    updateSideChatFromSession: vi.fn<SideChatsController['updateSideChatFromSession']>(),
    consumeHeadDelta: vi.fn<() => number>(() => 0),
    ...overrides,
  }
}

function makeSession(overrides: Partial<CollaborationSession> = {}): CollaborationSession {
  return {
    id: parentSessionId,
    projectId,
    title: 'Main session',
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
    createdAt: baseTimestamp,
    updatedAt: baseTimestamp,
    ...overrides,
  }
}

beforeEach(() => {
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SideChatsPanel', () => {
  it('renders the New side chat header button, disables it while creating, and omits it without handler', () => {
    const onNewSideChat = vi.fn<() => void>()
    const controller = makeController()
    const baseProps = {
      parentSessionId,
      sideChats: controller,
      panelOpen: true,
      onSelectSideChat: vi.fn<(id: string) => void>(),
      onBackToList: vi.fn<() => void>(),
      onClose: vi.fn<() => void>(),
      renderDetail: (id: string) => <div>Detail {id}</div>,
    }

    const view = render(
      <SideChatsPanel {...baseProps} onNewSideChat={onNewSideChat} creatingSideChat={false} />,
    )
    const addButton = screen.getByRole<HTMLButtonElement>('button', { name: 'New side chat' })
    expect(addButton.disabled).toBe(false)
    expect(addButton.title).toBe('New side chat')
    fireEvent.click(addButton)
    expect(onNewSideChat).toHaveBeenCalledTimes(1)

    view.rerender(
      <SideChatsPanel {...baseProps} onNewSideChat={onNewSideChat} creatingSideChat={true} />,
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'New side chat' }).disabled).toBe(
      true,
    )

    view.rerender(<SideChatsPanel {...baseProps} />)
    expect(screen.queryByRole('button', { name: 'New side chat' })).toBeNull()
  })

  it('renders continuous rows with preview fallback order and quiet unread dot suppressed by running or attention', () => {
    const onSelectSideChat = vi.fn<(id: string) => void>()
    const previewRow = makeSummary({
      id: '30000000-0000-4000-8000-000000000001',
      title: 'Has live preview',
      origin: 'selection',
      previewText: 'Latest reply preview',
      anchorQuotePreview: 'Quoted text',
      hasUnread: true,
    })
    const quoteFallbackRow = makeSummary({
      id: '30000000-0000-4000-8000-000000000002',
      title: 'Falls back to anchor quote',
      origin: 'selection',
      previewText: null,
      anchorQuotePreview: 'Selected anchor quote',
      isRunning: true,
      hasUnread: true,
    })
    const btwFallbackRow = makeSummary({
      id: '30000000-0000-4000-8000-000000000003',
      title: 'Falls back to /btw copy',
      origin: 'btw',
      previewText: null,
      anchorQuotePreview: null,
      needsAttention: true,
      isRunning: true,
      hasUnread: true,
    })

    const controller = makeController({
      items: [previewRow, quoteFallbackRow, btwFallbackRow],
      activeCount: 2,
      attentionCount: 1,
      unreadCount: 3,
    })

    render(
      <SideChatsPanel
        parentSessionId={parentSessionId}
        sideChats={controller}
        panelOpen
        onNewSideChat={vi.fn<() => void>()}
        onSelectSideChat={onSelectSideChat}
        onBackToList={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
        renderDetail={() => null}
      />,
    )

    const row1 = document.querySelector<HTMLElement>(`[data-side-chat-row="${previewRow.id}"]`)!
    expect(row1.textContent).toContain('Has live preview')
    expect(row1.textContent).toContain('Latest reply preview')
    expect(row1.textContent).toContain('Selection')
    expect(row1.querySelector('output[aria-label="New reply"]')?.getAttribute('title')).toBe(
      'New reply',
    )
    expect(row1.textContent).not.toContain('Running')
    expect(row1.textContent).not.toContain('Needs attention')

    const row2 = document.querySelector<HTMLElement>(
      `[data-side-chat-row="${quoteFallbackRow.id}"]`,
    )!
    expect(row2.textContent).toContain('Selected anchor quote')
    expect(row2.textContent).toContain('Running')
    expect(row2.querySelector('output[aria-label="New reply"]')).toBeNull()

    const row3 = document.querySelector<HTMLElement>(`[data-side-chat-row="${btwFallbackRow.id}"]`)!
    expect(row3.textContent).toContain('Started with /btw')
    expect(row3.textContent).toContain('/btw')
    expect(row3.textContent).toContain('Needs attention')
    expect(row3.textContent).not.toContain('Running')
    expect(row3.querySelector('output[aria-label="New reply"]')).toBeNull()

    fireEvent.click(row1.querySelector('button')!)
    expect(onSelectSideChat).toHaveBeenCalledWith(previewRow.id)
  })

  it('renders the empty state and inline Retry controls for initial and boundary errors', () => {
    const retryInitial = vi.fn<() => void>()
    const loadOlder = vi.fn<() => void>()
    const loadNewer = vi.fn<() => void>()

    const view = render(
      <SideChatsPanel
        parentSessionId={parentSessionId}
        sideChats={makeController({ initialized: true, items: [] })}
        panelOpen
        onSelectSideChat={vi.fn<(id: string) => void>()}
        onBackToList={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
        renderDetail={() => null}
      />,
    )

    expect(screen.getByText('No side chats yet')).toBeTruthy()
    expect(
      screen.getByText('Use /btw in the composer or select text in the main chat to start one.'),
    ).toBeTruthy()

    view.rerender(
      <SideChatsPanel
        parentSessionId={parentSessionId}
        sideChats={makeController({
          initialized: false,
          items: [],
          initialError: 'Couldn’t load side chats in time. Try again.',
          retryInitial,
        })}
        panelOpen
        onSelectSideChat={vi.fn<(id: string) => void>()}
        onBackToList={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
        renderDetail={() => null}
      />,
    )

    expect(screen.getByText('Couldn’t load side chats in time. Try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retryInitial).toHaveBeenCalledTimes(1)

    const item = makeSummary({ title: 'Loaded item', previewText: 'Hello' })
    view.rerender(
      <SideChatsPanel
        parentSessionId={parentSessionId}
        sideChats={makeController({
          initialized: true,
          items: [item],
          hasMoreNewer: true,
          hasMoreOlder: true,
          newerError: 'Newer page failed.',
          olderError: 'Older page failed.',
          loadNewer,
          loadOlder,
        })}
        panelOpen
        onSelectSideChat={vi.fn<(id: string) => void>()}
        onBackToList={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
        renderDetail={() => null}
      />,
    )

    const newerBoundary = document.querySelector<HTMLElement>('[data-side-chat-boundary="newer"]')!
    const olderBoundary = document.querySelector<HTMLElement>('[data-side-chat-boundary="older"]')!
    expect(newerBoundary.textContent).toContain('Newer page failed.')
    expect(olderBoundary.textContent).toContain('Older page failed.')
    fireEvent.click(newerBoundary.querySelector('button')!)
    fireEvent.click(olderBoundary.querySelector('button')!)
    expect(loadNewer).toHaveBeenCalledTimes(1)
    expect(loadOlder).toHaveBeenCalledTimes(1)
  })

  it('renders the locked detail header with back button, title, close button, and no settings gear', () => {
    const onBackToList = vi.fn<() => void>()
    const onClose = vi.fn<() => void>()
    const activeId = '30000000-0000-4000-8000-000000000010'

    const view = render(
      <SideChatsPanel
        parentSessionId={parentSessionId}
        activeSideChatId={activeId}
        activeSideChatTitle="Clarify auth flow"
        sideChats={makeController()}
        panelOpen
        onSelectSideChat={vi.fn<(id: string) => void>()}
        onBackToList={onBackToList}
        onClose={onClose}
        renderDetail={(id) => <div data-testid="side-chat-detail">Detail for {id}</div>}
      />,
    )

    const backButton = screen.getByRole('button', { name: 'Back to side chats' })
    expect(backButton.textContent).toContain('Side chats')
    const heading = screen.getByRole('heading', { level: 2, name: 'Clarify auth flow' })
    expect(heading.getAttribute('title')).toBe('Clarify auth flow')
    const closeButton = screen.getByRole('button', { name: 'Close side chats' })
    expect(screen.queryByRole('button', { name: /settings/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New side chat' })).toBeNull()
    expect(screen.getByTestId('side-chat-detail').textContent).toBe(`Detail for ${activeId}`)

    fireEvent.click(backButton)
    fireEvent.click(closeButton)
    expect(onBackToList).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)

    view.rerender(
      <SideChatsPanel
        parentSessionId={parentSessionId}
        activeSideChatId={activeId}
        sideChats={makeController()}
        panelOpen
        onSelectSideChat={vi.fn<(id: string) => void>()}
        onBackToList={onBackToList}
        onClose={onClose}
        renderDetail={(id) => <div data-testid="side-chat-detail">Detail for {id}</div>}
      />,
    )
    expect(screen.getByRole('heading', { level: 2, name: 'New side chat' })).toBeTruthy()
  })
})

describe('SideChatStage', () => {
  it('animates push/pop directions with an inert outgoing snapshot layer cleared on timer expiry', () => {
    vi.useFakeTimers()

    const view = render(
      <SideChatStage stageKey="list" depth={0}>
        <div>List view content</div>
      </SideChatStage>,
    )

    const outgoing = view.container.querySelector<HTMLDivElement>('[data-stage-state="outgoing"]')!
    const activeBefore = view.container.querySelector<HTMLDivElement>(
      '[data-stage-state="active"]',
    )!
    expect(outgoing.hidden).toBe(true)
    expect(outgoing.getAttribute('aria-hidden')).toBe('true')
    expect(outgoing.hasAttribute('inert') || outgoing.inert).toBe(true)
    expect(activeBefore.dataset.animate).toBe('false')

    // Push: depth 0 -> 1
    view.rerender(
      <SideChatStage stageKey="detail:sc-1" depth={1}>
        <div>Detail view content</div>
      </SideChatStage>,
    )

    const activePush = view.container.querySelector<HTMLDivElement>('[data-stage-state="active"]')!
    expect(activePush.dataset.direction).toBe('1')
    expect(activePush.dataset.animate).toBe('true')
    expect(activePush.textContent).toContain('Detail view content')
    expect(outgoing.hidden).toBe(false)
    expect(outgoing.hasAttribute('inert') || outgoing.inert).toBe(true)
    expect(outgoing.dataset.direction).toBe('-1')
    expect(outgoing.textContent).toContain('List view content')

    act(() => {
      vi.advanceTimersByTime(179)
    })
    expect(outgoing.hidden).toBe(false)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(outgoing.hidden).toBe(true)
    expect(outgoing.childNodes.length).toBe(0)

    // Pop: depth 1 -> 0
    view.rerender(
      <SideChatStage stageKey="list" depth={0}>
        <div>List view content</div>
      </SideChatStage>,
    )

    const activePop = view.container.querySelector<HTMLDivElement>('[data-stage-state="active"]')!
    expect(activePop.dataset.direction).toBe('-1')
    expect(activePop.dataset.animate).toBe('true')
    expect(outgoing.hidden).toBe(false)
    expect(outgoing.hasAttribute('inert') || outgoing.inert).toBe(true)
    expect(outgoing.dataset.direction).toBe('1')
    expect(outgoing.textContent).toContain('Detail view content')

    act(() => {
      vi.advanceTimersByTime(159)
    })
    expect(outgoing.hidden).toBe(false)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(outgoing.hidden).toBe(true)
    expect(outgoing.childNodes.length).toBe(0)
  })
})

describe('SessionHeader side-chat badge precedence', () => {
  it('prioritizes attentionCount over activeCount over unreadCount dot and hides button on side chats', () => {
    const session = makeSession()
    const baseProps = {
      session,
      saving: false,
      onSave: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
      onOpenSettings: vi.fn<() => void>(),
      onOpenSideChats: vi.fn<() => void>(),
    }

    const view = render(
      <SessionHeader
        {...baseProps}
        sideChatAttentionCount={2}
        sideChatActiveCount={3}
        sideChatUnreadCount={4}
      />,
    )

    const attentionBadge = screen.getByLabelText('2 side chats needing attention')
    expect(attentionBadge.textContent).toBe('2')
    expect(screen.queryByLabelText(/active side chat/i)).toBeNull()
    expect(screen.queryByLabelText(/unread side chat/i)).toBeNull()

    view.rerender(
      <SessionHeader
        {...baseProps}
        sideChatAttentionCount={0}
        sideChatActiveCount={1}
        sideChatUnreadCount={4}
      />,
    )
    const activeBadge = screen.getByLabelText('1 active side chat')
    expect(activeBadge.textContent).toBe('1')
    expect(screen.queryByLabelText(/needing attention/i)).toBeNull()
    expect(screen.queryByLabelText(/unread side chat/i)).toBeNull()

    view.rerender(
      <SessionHeader
        {...baseProps}
        sideChatAttentionCount={0}
        sideChatActiveCount={0}
        sideChatUnreadCount={1}
      />,
    )
    const unreadDot = screen.getByLabelText('1 unread side chat')
    expect(unreadDot.getAttribute('title')).toBe('1 unread side chat')
    expect(unreadDot.textContent).toBe('')
    expect(screen.queryByLabelText(/active side chat/i)).toBeNull()
    expect(screen.queryByLabelText(/needing attention/i)).toBeNull()

    view.rerender(
      <SessionHeader
        {...baseProps}
        sideChatAttentionCount={0}
        sideChatActiveCount={0}
        sideChatUnreadCount={0}
      />,
    )
    expect(screen.getByRole('button', { name: 'Side chats' })).toBeTruthy()
    expect(screen.queryByLabelText(/needing attention/i)).toBeNull()
    expect(screen.queryByLabelText(/active side chat/i)).toBeNull()
    expect(screen.queryByLabelText(/unread side chat/i)).toBeNull()

    view.rerender(
      <SessionHeader
        {...baseProps}
        session={makeSession({
          id: '30000000-0000-4000-8000-000000000099',
          parentSessionId,
        })}
        sideChatUnreadCount={1}
      />,
    )
    expect(screen.queryByRole('button', { name: /Side chats/i })).toBeNull()
  })
})
