// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ConversationPatch,
  DesktopBridge,
  ListSideChatsInput,
  ListSideChatsPage,
  SideChatSummary,
} from '@pact/contracts'

import { SIDE_CHAT_LIST_PAGE_ITEMS, SIDE_CHAT_LIST_RESIDENT_ITEMS } from '@pact/contracts'

import { useSideChats } from './useSideChats'

const parentSessionId = '10000000-0000-4000-8000-000000000001'
const projectId = '20000000-0000-4000-8000-000000000001'
const baseMs = Date.parse('2026-11-19T05:00:00.000Z')

function makeSummary(index: number, overrides: Partial<SideChatSummary> = {}): SideChatSummary {
  const iso = new Date(baseMs + index * 1_000).toISOString()
  return {
    id: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    parentSessionId,
    projectId,
    title: `Side chat ${index}`,
    origin: 'btw',
    anchorQuotePreview: null,
    previewText: `Preview ${index}`,
    status: 'idle',
    isRunning: false,
    needsAttention: false,
    hasUnread: false,
    createdAt: iso,
    updatedAt: iso,
    ...overrides,
  }
}

function sortSideChats(items: readonly SideChatSummary[]): SideChatSummary[] {
  return [...items].toSorted((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1
    return a.id > b.id ? -1 : a.id < b.id ? 1 : 0
  })
}

function makeDatasetBridge(initialItems: SideChatSummary[]) {
  // Store sorted descending by (createdAt, id), matching the backend keyset order.
  let dataset = sortSideChats(initialItems)
  let conversationListener: ((patch: ConversationPatch) => void) | undefined

  const counts = () => ({
    activeCount: dataset.filter((item) => item.isRunning || item.needsAttention).length,
    attentionCount: dataset.filter((item) => item.needsAttention).length,
    unreadCount: dataset.filter((item) => item.hasUnread).length,
  })

  const listSideChats = vi.fn<DesktopBridge['listSideChats']>(
    async (input: ListSideChatsInput): Promise<{ ok: true; value: ListSideChatsPage }> => {
      const limit = input.limit ?? SIDE_CHAT_LIST_PAGE_ITEMS
      const direction = input.direction ?? 'older'
      let matching: SideChatSummary[]
      let pageItems: SideChatSummary[]
      let hasMoreOlder = false
      let hasMoreNewer = false

      if (!input.cursor) {
        pageItems = dataset.slice(0, limit)
        hasMoreOlder = dataset.length > pageItems.length
        hasMoreNewer = false
      } else if (direction === 'older') {
        const cursor = input.cursor
        matching = dataset.filter(
          (item) =>
            item.createdAt < cursor.createdAt ||
            (item.createdAt === cursor.createdAt && item.id < cursor.id),
        )
        pageItems = matching.slice(0, limit)
        hasMoreOlder = matching.length > pageItems.length
        hasMoreNewer = true
      } else {
        const cursor = input.cursor
        matching = dataset.filter(
          (item) =>
            item.createdAt > cursor.createdAt ||
            (item.createdAt === cursor.createdAt && item.id > cursor.id),
        )
        // Return the `limit` items immediately newer than cursor, ordered newest-first.
        pageItems = matching.slice(Math.max(0, matching.length - limit))
        hasMoreNewer = matching.length > pageItems.length
        hasMoreOlder = true
      }

      const last = pageItems.at(-1)
      const first = pageItems[0]
      return {
        ok: true,
        value: {
          parentSessionId: input.parentSessionId,
          items: pageItems,
          nextCursor: hasMoreOlder && last ? { createdAt: last.createdAt, id: last.id } : null,
          prevCursor: hasMoreNewer && first ? { createdAt: first.createdAt, id: first.id } : null,
          hasMoreOlder,
          hasMoreNewer,
          ...counts(),
        },
      }
    },
  )

  vi.stubGlobal('pact', {
    listSideChats,
    onConversationChanged: vi.fn<DesktopBridge['onConversationChanged']>((listener) => {
      conversationListener = listener
      return () => {
        conversationListener = undefined
      }
    }),
    onNativePresenceChanged: vi.fn<DesktopBridge['onNativePresenceChanged']>(() => () => undefined),
  })

  return {
    listSideChats,
    setDataset(next: SideChatSummary[]) {
      dataset = sortSideChats(next)
    },
    emitConversationPatch(patch: ConversationPatch) {
      conversationListener?.(patch)
    },
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useSideChats', () => {
  it('pages with keyset cursors, trims resident window at 100 items on head/tail, and tracks head deltas', async () => {
    // 105 items: index 105 (newest) down to index 1 (oldest)
    const allItems = Array.from({ length: SIDE_CHAT_LIST_RESIDENT_ITEMS + 5 }, (_, offset) =>
      makeSummary(offset + 1),
    )
    const bridge = makeDatasetBridge(allItems)

    const { result } = renderHook(() => useSideChats({ parentSessionId, listOpen: true }))

    await waitFor(() => expect(result.current.initialized).toBe(true))
    expect(result.current.items).toHaveLength(SIDE_CHAT_LIST_PAGE_ITEMS)
    expect(result.current.items[0]?.id).toBe(makeSummary(105).id)
    expect(result.current.hasMoreOlder).toBe(true)
    expect(result.current.hasMoreNewer).toBe(false)

    // Load older pages until we exceed 100 items (19 more pages -> 100, then 20th -> 105 trimmed to 100)
    const loadOlderPages = async (remaining: number): Promise<void> => {
      if (remaining <= 0) return
      const previousCalls = bridge.listSideChats.mock.calls.length
      act(() => {
        result.current.loadOlder()
      })
      await waitFor(() =>
        expect(bridge.listSideChats.mock.calls.length).toBeGreaterThan(previousCalls),
      )
      await waitFor(() => expect(result.current.loadingMoreOlder).toBe(false))
      await loadOlderPages(remaining - 1)
    }
    await loadOlderPages(20)

    expect(result.current.items).toHaveLength(SIDE_CHAT_LIST_RESIDENT_ITEMS)
    expect(result.current.items[0]?.id).toBe(makeSummary(100).id)
    expect(result.current.items.at(-1)?.id).toBe(makeSummary(1).id)
    expect(result.current.hasMoreOlder).toBe(false)
    expect(result.current.hasMoreNewer).toBe(true)
    expect(result.current.consumeHeadDelta()).toBe(-5)
    expect(result.current.consumeHeadDelta()).toBe(0)

    // Load newer page -> inserts 5 newest items and trims 5 oldest from the tail.
    const callsBeforeNewer = bridge.listSideChats.mock.calls.length
    act(() => {
      result.current.loadNewer()
    })
    await waitFor(() =>
      expect(bridge.listSideChats.mock.calls.length).toBeGreaterThan(callsBeforeNewer),
    )
    await waitFor(() => expect(result.current.loadingMoreNewer).toBe(false))

    expect(bridge.listSideChats.mock.lastCall?.[0]).toMatchObject({
      parentSessionId,
      direction: 'newer',
      cursor: { createdAt: makeSummary(100).createdAt, id: makeSummary(100).id },
    })
    expect(result.current.items).toHaveLength(SIDE_CHAT_LIST_RESIDENT_ITEMS)
    expect(result.current.items[0]?.id).toBe(makeSummary(105).id)
    expect(result.current.items.at(-1)?.id).toBe(makeSummary(6).id)
    expect(result.current.hasMoreNewer).toBe(false)
    expect(result.current.hasMoreOlder).toBe(true)
    expect(result.current.consumeHeadDelta()).toBe(5)
  })

  it('tracks unreadCount and hasUnread deltas across create, session updates, and removeSideChat', async () => {
    const olderItems = Array.from({ length: 6 }, (_, offset) =>
      makeSummary(offset + 1, {
        hasUnread: offset === 5, // newest item (#6) starts unread
        isRunning: offset === 4, // #5 starts running
      }),
    )
    const bridge = makeDatasetBridge(olderItems)

    const { result } = renderHook(() => useSideChats({ parentSessionId, listOpen: true }))
    await waitFor(() => expect(result.current.initialized).toBe(true))

    expect(result.current.items).toHaveLength(5)
    expect(result.current.hasMoreOlder).toBe(true)
    expect(result.current.unreadCount).toBe(1)
    expect(result.current.activeCount).toBe(1)
    expect(result.current.attentionCount).toBe(0)

    // Create a new unread side chat -> increments unreadCount and prepends item.
    const created = makeSummary(7, { hasUnread: true, isRunning: false })
    act(() => {
      result.current.applyCreatedSideChat(created)
    })
    expect(result.current.items[0]?.id).toBe(created.id)
    expect(result.current.unreadCount).toBe(2)

    // Mark created side chat read via updateSideChatFromSession -> decrements unreadCount & clears hasUnread.
    act(() => {
      result.current.updateSideChatFromSession({
        id: created.id,
        parentSessionId,
        title: 'Renamed created',
        titleSource: 'user',
        status: 'waiting_for_user',
        activity: { state: 'waiting_for_user' },
        hasUnread: false,
        updatedAt: new Date(baseMs + 99_000).toISOString(),
      })
    })
    expect(result.current.items[0]?.hasUnread).toBe(false)
    expect(result.current.items[0]?.title).toBe('Renamed created')
    expect(result.current.items[0]?.needsAttention).toBe(true)
    expect(result.current.unreadCount).toBe(1)
    expect(result.current.attentionCount).toBe(1)
    expect(result.current.activeCount).toBe(2)

    // removeSideChat decrements attention/active counts and triggers a refresh_counts read because hasMoreOlder is true.
    const callsBeforeRemove = bridge.listSideChats.mock.calls.length
    // Update backing dataset to reflect removal so the refresh_counts read stays consistent.
    bridge.setDataset(olderItems.filter((item) => item.id !== created.id))
    act(() => {
      result.current.removeSideChat(created.id)
    })
    expect(result.current.items.some((item) => item.id === created.id)).toBe(false)
    expect(result.current.attentionCount).toBe(0)
    expect(result.current.activeCount).toBe(1)
    await waitFor(() =>
      expect(bridge.listSideChats.mock.calls.length).toBeGreaterThan(callsBeforeRemove),
    )

    // Removing an unread item decrements unreadCount cleanly.
    const unreadItem = result.current.items.find((item) => item.hasUnread)!
    expect(unreadItem).toBeDefined()
    bridge.setDataset(olderItems.filter((item) => item.id !== unreadItem.id))
    act(() => {
      result.current.removeSideChat(unreadItem.id)
    })
    expect(result.current.items.some((item) => item.id === unreadItem.id)).toBe(false)
    expect(result.current.unreadCount).toBe(0)
  })

  it('extracts live previewText on onConversationChanged, ignoring historicalBackgroundReport and trimming surrogate-safely at 240 units', async () => {
    const sideChat = makeSummary(1, { previewText: 'Initial preview', hasUnread: false })
    const bridge = makeDatasetBridge([sideChat])

    const { result } = renderHook(() => useSideChats({ parentSessionId, listOpen: true }))
    await waitFor(() => expect(result.current.initialized).toBe(true))

    const basePatchSession = {
      id: sideChat.id,
      title: sideChat.title,
      titleSource: 'local' as const,
      status: 'idle' as const,
      activity: { state: 'idle' as const },
      hasUnread: true,
      updatedAt: new Date(baseMs + 10_000).toISOString(),
    }

    // 1. Historical background report must be ignored; earlier non-historical replace message wins.
    act(() => {
      bridge.emitConversationPatch({
        version: 'conversation-patch-v1',
        sessionId: sideChat.id,
        observation: { incarnation: crypto.randomUUID(), sequence: 1 },
        session: basePatchSession,
        messages: [
          {
            mode: 'replace',
            text: '  Fresh   answer\nwith   spaces  ',
            message: {
              id: crypto.randomUUID(),
              sessionId: sideChat.id,
              role: 'assistant',
              contentRevision: 1,
              state: 'complete',
              sequence: 1,
              createdAt: basePatchSession.updatedAt,
              updatedAt: basePatchSession.updatedAt,
            },
            hasActivities: false,
            hasComments: false,
          },
          {
            mode: 'replace',
            text: 'Old background report that must be ignored',
            message: {
              id: crypto.randomUUID(),
              sessionId: sideChat.id,
              role: 'assistant',
              contentRevision: 1,
              state: 'complete',
              sequence: 2,
              historicalBackgroundReport: true,
              createdAt: basePatchSession.updatedAt,
              updatedAt: basePatchSession.updatedAt,
            },
            hasActivities: false,
            hasComments: false,
          },
        ],
        activities: [],
        runs: [],
        activityStates: [],
      })
    })

    expect(result.current.items[0]?.previewText).toBe('Fresh answer with spaces')
    expect(result.current.items[0]?.hasUnread).toBe(true)
    expect(result.current.unreadCount).toBe(1)

    // 2. Patch with ONLY a historicalBackgroundReport keeps the previous previewText.
    act(() => {
      bridge.emitConversationPatch({
        version: 'conversation-patch-v1',
        sessionId: sideChat.id,
        observation: { incarnation: crypto.randomUUID(), sequence: 2 },
        session: {
          ...basePatchSession,
          updatedAt: new Date(baseMs + 20_000).toISOString(),
        },
        messages: [
          {
            mode: 'replace',
            text: 'Another historical background report',
            message: {
              id: crypto.randomUUID(),
              sessionId: sideChat.id,
              role: 'assistant',
              contentRevision: 1,
              state: 'complete',
              sequence: 3,
              historicalBackgroundReport: true,
              createdAt: basePatchSession.updatedAt,
              updatedAt: basePatchSession.updatedAt,
            },
            hasActivities: false,
            hasComments: false,
          },
        ],
        activities: [],
        runs: [],
        activityStates: [],
      })
    })
    expect(result.current.items[0]?.previewText).toBe('Fresh answer with spaces')

    // 3. Surrogate pair straddling index 239/240 trims back to 239 units without leaving a lone high surrogate.
    const splitEmojiText = `${'a'.repeat(239)}😀tail`
    act(() => {
      bridge.emitConversationPatch({
        version: 'conversation-patch-v1',
        sessionId: sideChat.id,
        observation: { incarnation: crypto.randomUUID(), sequence: 3 },
        session: {
          ...basePatchSession,
          updatedAt: new Date(baseMs + 30_000).toISOString(),
        },
        messages: [
          {
            mode: 'replace',
            text: splitEmojiText,
            message: {
              id: crypto.randomUUID(),
              sessionId: sideChat.id,
              role: 'assistant',
              contentRevision: 1,
              state: 'complete',
              sequence: 4,
              createdAt: basePatchSession.updatedAt,
              updatedAt: basePatchSession.updatedAt,
            },
            hasActivities: false,
            hasComments: false,
          },
        ],
        activities: [],
        runs: [],
        activityStates: [],
      })
    })
    expect(result.current.items[0]?.previewText).toBe('a'.repeat(239))
    expect(result.current.items[0]?.previewText?.length).toBe(239)

    // 4. Surrogate pair ending exactly at unit 240 is preserved intact.
    const exactEmojiText = `${'b'.repeat(238)}😀tail`
    act(() => {
      bridge.emitConversationPatch({
        version: 'conversation-patch-v1',
        sessionId: sideChat.id,
        observation: { incarnation: crypto.randomUUID(), sequence: 4 },
        session: {
          ...basePatchSession,
          updatedAt: new Date(baseMs + 40_000).toISOString(),
        },
        messages: [
          {
            mode: 'replace',
            text: exactEmojiText,
            message: {
              id: crypto.randomUUID(),
              sessionId: sideChat.id,
              role: 'assistant',
              contentRevision: 1,
              state: 'complete',
              sequence: 5,
              createdAt: basePatchSession.updatedAt,
              updatedAt: basePatchSession.updatedAt,
            },
            hasActivities: false,
            hasComments: false,
          },
        ],
        activities: [],
        runs: [],
        activityStates: [],
      })
    })
    expect(result.current.items[0]?.previewText).toBe(`${'b'.repeat(238)}😀`)
    expect(result.current.items[0]?.previewText?.length).toBe(240)
  })
})
