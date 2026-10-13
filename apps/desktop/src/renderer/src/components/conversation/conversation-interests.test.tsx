import type { ReactNode } from 'react'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConversationPage, ConversationPatch, DesktopBridge, RpcResult } from '@pact/contracts'

import { conversationQueryKeys } from '../../query-client'
import { useConversation } from './useConversation'

const randomUUID = (): string => crypto.randomUUID()
const timestamp = new Date().toISOString(),
  incarnation = randomUUID()
const disposers: Array<() => void> = []
afterEach(() => {
  cleanup()
  for (const dispose of disposers.splice(0).toReversed()) dispose()
})
function page(sessionId: string, sequence = 1): Extract<ConversationPage, { scope: 'messages' }> {
  return {
    scope: 'messages',
    sessionId,
    observation: { incarnation, sequence },
    header: {
      session: {
        id: sessionId,
        title: 'Session',
        titleSource: 'local',
        status: 'idle',
        activity: { state: 'idle' },
        hasUnread: false,
        updatedAt: timestamp,
      },
      commentsRevision: 0,
    },
    messages: [],
    runs: [],
    hasOlder: false,
    hasNewer: false,
  }
}
function replyPage(
  sessionId: string,
  runId: string,
  messageId: string,
  text = 'Stored answer',
  epoch = incarnation,
) {
  const value = page(sessionId)
  value.observation.incarnation = epoch
  value.header.latestRun = {
    id: runId,
    sessionId,
    userMessageId: randomUUID(),
    agentId: 'codex',
    status: 'completed',
    attemptCount: 1,
    settingsRevision: 1,
    model: null,
    effort: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  value.runs = [value.header.latestRun]
  value.messages = [
    {
      kind: 'complete',
      message: {
        id: messageId,
        sessionId,
        runId,
        role: 'assistant',
        agentId: 'codex',
        content: text,
        contentRevision: 0,
        state: 'complete',
        sequence: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      hasActivities: false,
      hasComments: false,
    },
  ]
  return value
}
function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } })
  const listeners = new Set<(patch: ConversationPatch) => void>()
  const get = vi.fn<DesktopBridge['getConversation']>().mockImplementation(async (input) => {
    if (input.scope === 'messages') return { ok: true, value: page(input.sessionId) }
    if (input.scope === 'drafts')
      return {
        ok: true,
        value: {
          scope: 'drafts',
          sessionId: input.sessionId,
          observation: { incarnation, sequence: 1 },
          commentsRevision: 0,
          comments: [],
          hasMore: false,
        },
      }
    return { ok: false, error: { code: 'VALIDATION', message: 'Unused fixture scope' } }
  })
  const interest = vi
    .fn<DesktopBridge['setConversationInterest']>()
    .mockResolvedValue({ ok: true, value: { ready: true } })
  const send = vi.fn<DesktopBridge['sendConversationMessage']>().mockResolvedValue({
    ok: false,
    error: { code: 'UNCERTAIN', message: 'Awaiting acknowledgement' },
  })
  const bridge = {
    getConversation: get,
    setConversationInterest: interest,
    sendConversationMessage: send,
    onConversationChanged: (listener: (patch: ConversationPatch) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const previous = Object.getOwnPropertyDescriptor(window, 'pact')
  Object.defineProperty(window, 'pact', { configurable: true, value: bridge })
  disposers.push(() => {
    client.clear()
    if (previous) Object.defineProperty(window, 'pact', previous)
    else Reflect.deleteProperty(window, 'pact')
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const notice = vi.fn<(message: string) => void>()
  return {
    client,
    get,
    interest,
    send,
    notice,
    wrapper,
    emit: (patch: ConversationPatch) => {
      for (const listener of listeners) listener(patch)
    },
  }
}
describe('Selected Session synchronization', () => {
  it('settles a silent initial read deadline and prevents a late ACK from dispatching', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const f = fixture(),
        id = randomUUID(),
        ack = Promise.withResolvers<RpcResult<{ ready: true }>>()
      f.interest.mockReturnValueOnce(ack.promise)
      const hook = renderHook(() => useConversation(id, f.notice), { wrapper: f.wrapper })
      await act(async () => {
        await Promise.resolve()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000)
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(hook.result.current.history.readError).toMatch(/timed out/)
      expect(hook.result.current.loading).toBe(false)
      await act(async () => ack.resolve({ ok: true, value: { ready: true } }))
      expect(f.get).not.toHaveBeenCalled()
      hook.unmount()
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('falls back from an unavailable reading anchor once and retries only the read', async () => {
    const f = fixture(),
      id = randomUUID(),
      runId = randomUUID(),
      messageId = randomUUID()
    const original = f.get.getMockImplementation()
    if (!original) throw new Error('Reader missing')
    let phase: 'initial' | 'fail' | 'recovered' = 'initial'
    f.get.mockImplementation(async (input) => {
      if (input.scope !== 'messages') return original(input)
      if (phase === 'fail')
        return {
          ok: false,
          error: {
            code: input.aroundMessageId ? 'VALIDATION' : 'TIMEOUT',
            message: 'Read unavailable',
          },
        }
      return {
        ok: true,
        value: replyPage(
          id,
          runId,
          messageId,
          phase === 'initial' ? 'Stored answer' : 'Latest answer',
        ),
      }
    })
    const hook = renderHook(({ visible }) => useConversation(id, f.notice, visible), {
      initialProps: { visible: true },
      wrapper: f.wrapper,
    })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => hook.result.current.history.protectReading(messageId))
    hook.rerender({ visible: false })
    phase = 'fail'
    const before = f.get.mock.calls.length
    hook.rerender({ visible: true })
    await waitFor(() => expect(hook.result.current.history.readError).toBe('Read unavailable'))
    expect(
      f.get.mock.calls
        .slice(before)
        .filter(([input]) => input.scope === 'messages')
        .map(([input]) => (input.scope === 'messages' ? input.aroundMessageId : undefined)),
    ).toEqual([messageId, undefined])
    expect(hook.result.current.snapshot?.messages[0]?.content).toBe('Stored answer')
    expect(hook.result.current.history.readingPositionLost).toBe(true)
    phase = 'recovered'
    act(() => hook.result.current.history.retryRead())
    await waitFor(() =>
      expect(hook.result.current.snapshot?.messages[0]?.content).toBe('Latest answer'),
    )
    expect(hook.result.current.history.readError).toBeUndefined()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.notice).not.toHaveBeenCalled()
  })
  it('installs a new incarnation and reloads same-revision drafts after resume', async () => {
    const f = fixture(),
      id = randomUUID(),
      runId = randomUUID(),
      messageId = randomUUID(),
      nextEpoch = randomUUID(),
      commentId = randomUUID()
    let epoch = incarnation
    const delayed = Promise.withResolvers<RpcResult<ConversationPage>>()
    let resume = false
    f.get.mockImplementation(async (input) => {
      if (input.scope === 'messages')
        return resume ? delayed.promise : { ok: true, value: replyPage(id, runId, messageId) }
      if (input.scope === 'drafts')
        return {
          ok: true,
          value: {
            scope: 'drafts',
            sessionId: id,
            observation: { incarnation: epoch, sequence: 1 },
            commentsRevision: 0,
            hasMore: false,
            comments: [
              {
                id: commentId,
                sessionId: id,
                body: 'Saved draft',
                anchor: {
                  type: 'message',
                  messageId,
                  contentHash: 'a'.repeat(64),
                  textBasis: 'markdown-visible-v2',
                  startOffset: 0,
                  endOffset: 4,
                  quote: 'text',
                },
                status: 'draft',
                position: 0,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ],
          },
        }
      return { ok: false, error: { code: 'VALIDATION', message: 'Unused scope' } }
    })
    const hook = renderHook(({ visible }) => useConversation(id, f.notice, visible), {
      initialProps: { visible: true },
      wrapper: f.wrapper,
    })
    await waitFor(() => expect(hook.result.current.snapshot?.draftComments).toHaveLength(1))
    act(() => hook.result.current.history.protectReading(messageId))
    hook.rerender({ visible: false })
    epoch = nextEpoch
    resume = true
    hook.rerender({ visible: true })
    await waitFor(() =>
      expect(f.get.mock.calls.filter(([input]) => input.scope === 'drafts')).toHaveLength(2),
    )
    await act(async () =>
      delayed.resolve({
        ok: true,
        value: replyPage(id, runId, messageId, 'New incarnation body', epoch),
      }),
    )
    await waitFor(() =>
      expect(hook.result.current.snapshot?.observation.incarnation).toBe(nextEpoch),
    )
    await waitFor(() => expect(hook.result.current.snapshot?.draftComments).toHaveLength(1))
    expect(hook.result.current.snapshot?.messages[0]?.content).toBe('New incarnation body')
    expect(hook.result.current.history.draftsLoading).toBe(false)
    expect(
      f.get.mock.calls.filter(([input]) => input.scope === 'drafts').length,
    ).toBeGreaterThanOrEqual(3)
  })
  it('settles a cancelled detail expansion and retains an already completed expansion', async () => {
    const f = fixture(),
      id = randomUUID(),
      runId = randomUUID(),
      messageId = randomUUID(),
      activityId = randomUUID()
    const original = f.get.getMockImplementation()
    if (!original) throw new Error('Reader missing')
    const pending = Promise.withResolvers<RpcResult<ConversationPage>>()
    const detail = 'old' + 'x'.repeat(139_997)
    let first = true
    const bodyPage = (offset: number): Extract<ConversationPage, { scope: 'activity-body' }> => ({
      scope: 'activity-body',
      sessionId: id,
      observation: { incarnation, sequence: 1 },
      activityId,
      detailRevision: 0,
      offset,
      text: detail.slice(offset, offset + 50_000),
      ...(offset + 50_000 < detail.length ? { nextOffset: offset + 50_000 } : {}),
    })
    f.get.mockImplementation(async (input) => {
      if (input.scope === 'messages') return { ok: true, value: replyPage(id, runId, messageId) }
      if (input.scope === 'activities')
        return {
          ok: true,
          value: {
            scope: 'activities',
            sessionId: id,
            runId,
            observation: { incarnation, sequence: 1 },
            truncated: false,
            activities: [
              {
                kind: 'oversized',
                activity: {
                  id: activityId,
                  sessionId: id,
                  runId,
                  agentId: 'codex',
                  nativeId: 'detail',
                  kind: 'reasoning',
                  title: 'Reasoning',
                  status: 'completed',
                  sequence: 1,
                  detailRevision: 0,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
                detailBytes: detail.length,
                preview: 'old',
                previewChars: 3,
              },
            ],
          },
        }
      if (input.scope === 'activity-body') {
        if (first) {
          first = false
          return pending.promise
        }
        return { ok: true, value: bodyPage(input.offset) }
      }
      return original(input)
    })
    const hook = renderHook(({ visible }) => useConversation(id, f.notice, visible), {
      initialProps: { visible: true },
      wrapper: f.wrapper,
    })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    await act(async () => hook.result.current.history.loadActivities(runId))
    const source = {
      activityId,
      revision: 0,
      bodyBytes: detail.length,
      preview: 'old',
      previewChars: 3,
    }
    act(() => hook.result.current.history.loadMoreActivityBody(source))
    await waitFor(() =>
      expect(hook.result.current.history.expandedActivityBody?.loading).toBe(true),
    )
    hook.rerender({ visible: false })
    await waitFor(() => expect(hook.result.current.history.expandedActivityBody).toBeUndefined())
    hook.rerender({ visible: true })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    await act(async () => pending.resolve({ ok: true, value: bodyPage(3) }))
    expect(hook.result.current.history.expandedActivityBody).toBeUndefined()
    act(() => hook.result.current.history.loadMoreActivityBody(source))
    await waitFor(() =>
      expect(hook.result.current.history.expandedActivityBody?.loading).toBe(false),
    )
    expect(hook.result.current.history.expandedActivityBody?.text).toBe(detail)
    hook.rerender({ visible: false })
    hook.rerender({ visible: true })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.history.expandedActivityBody?.text).toBe(detail)
  })
  it('settles an interrupted gap only after the resumed page repairs its body', async () => {
    const f = fixture(),
      id = randomUUID(),
      runId = randomUUID(),
      messageId = randomUUID()
    const original = f.get.getMockImplementation()
    if (!original) throw new Error('Reader missing')
    const delayed = Promise.withResolvers<RpcResult<ConversationPage>>()
    let delaying = false,
      latest = false
    f.get.mockImplementation(async (input) => {
      if (input.scope === 'messages') {
        const resumed = replyPage(
          id,
          runId,
          messageId,
          latest ? 'Repaired answer' : 'Stored answer',
        )
        // A resumed read must be at or after the missed sequence to certify body recovery.
        if (latest) resumed.observation.sequence = 3
        return delaying
          ? delayed.promise
          : {
              ok: true,
              value: resumed,
            }
      }
      return original(input)
    })
    const hook = renderHook(({ visible }) => useConversation(id, f.notice, visible), {
      initialProps: { visible: true },
      wrapper: f.wrapper,
    })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    const current = replyPage(id, runId, messageId)
    act(() =>
      f.emit({
        version: 'conversation-patch-v1',
        sessionId: id,
        observation: { incarnation, sequence: 3 },
        session: current.header.session,
        messages: [],
        runs: [],
        activities: [],
        activityStates: [],
      }),
    )
    await waitFor(() => expect(hook.result.current.history.gapRecoveryPending).toBe(true))
    delaying = true
    let recovery: Promise<void> | undefined
    act(() => {
      recovery = hook.result.current.history.recoverFromGap(messageId)
    })
    hook.rerender({ visible: false })
    delaying = false
    latest = true
    hook.rerender({ visible: true })
    await waitFor(() =>
      expect(hook.result.current.snapshot?.messages[0]?.content).toBe('Repaired answer'),
    )
    expect(hook.result.current.history.gapRecoveryPending).toBe(false)
    await act(async () => {
      delayed.resolve({ ok: true, value: current })
      await recovery
    })
    expect(hook.result.current.snapshot?.messages[0]?.content).toBe('Repaired answer')
  })
  it('restores the latest body and durable Work log on return without sending again', async () => {
    const f = fixture(),
      a = randomUUID(),
      b = randomUUID(),
      runId = randomUUID()
    const initial = page(a)
    initial.header.latestRun = {
      id: runId,
      sessionId: a,
      userMessageId: randomUUID(),
      agentId: 'codex',
      status: 'running',
      attemptCount: 1,
      settingsRevision: 1,
      model: null,
      effort: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const messageId = randomUUID(),
      activityId = randomUUID()
    initial.messages = [
      {
        kind: 'complete',
        message: {
          id: messageId,
          sessionId: a,
          runId,
          role: 'assistant',
          agentId: 'codex',
          content: 'Already generated answer',
          contentRevision: 1,
          state: 'streaming',
          sequence: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        hasActivities: true,
        hasComments: false,
      },
    ]
    const original = f.get.getMockImplementation()
    if (!original) throw new Error('Fixture reader missing')
    let detail = 'Stored progress before switching'
    f.get.mockImplementation(async (input) => {
      if (input.scope === 'messages' && input.sessionId === a) return { ok: true, value: initial }
      if (input.scope === 'activities')
        return {
          ok: true,
          value: {
            scope: 'activities',
            sessionId: a,
            runId,
            observation: initial.observation,
            truncated: false,
            activities: [
              {
                kind: 'complete',
                activity: {
                  id: activityId,
                  sessionId: a,
                  runId,
                  agentId: 'codex',
                  nativeId: 'reasoning-fixture',
                  kind: 'reasoning',
                  title: 'Reasoning',
                  detail,
                  detailRevision: 1,
                  status: 'running',
                  sequence: 1,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              },
            ],
          },
        }
      return original(input)
    })
    const hook = renderHook(({ id }) => useConversation(id, f.notice), {
      initialProps: { id: a },
      wrapper: f.wrapper,
    })
    await waitFor(() => expect(hook.result.current.snapshot?.activities[0]?.detail).toBe(detail))
    hook.rerender({ id: b })
    await waitFor(() => expect(hook.result.current.snapshot?.sessionId).toBe(b))
    detail = 'Progress continued while reading B'
    const reply = initial.messages[0]
    if (!reply || reply.kind !== 'complete') throw new Error('Fixture reply missing')
    reply.message.content = 'Latest generated answer'
    hook.rerender({ id: a })
    await waitFor(() => expect(hook.result.current.snapshot?.activities[0]?.detail).toBe(detail))
    expect(hook.result.current.snapshot?.messages[0]?.content).toBe('Latest generated answer')
    expect(f.get.mock.calls.filter(([input]) => input.scope === 'activities')).toHaveLength(2)
    expect(f.send).not.toHaveBeenCalled()
    hook.rerender({ id: a })
    expect(f.get.mock.calls.filter(([input]) => input.scope === 'activities')).toHaveLength(2)
  })
  it.each(['items', 'bytes'] as const)(
    'requires bounded resync when initial buffering exceeds %s instead of applying incomplete history',
    async (budget) => {
      const f = fixture(),
        sessionId = randomUUID(),
        delayed = Promise.withResolvers<RpcResult<ConversationPage>>()
      f.get.mockImplementationOnce(() => delayed.promise)
      const hook = renderHook(() => useConversation(sessionId, f.notice), { wrapper: f.wrapper })
      await waitFor(() => expect(f.get).toHaveBeenCalledOnce())
      const snapshot = page(sessionId)
      await act(async () => {
        for (let index = 0; index < (budget === 'items' ? 65 : 64); index++)
          f.emit({
            version: 'conversation-patch-v1',
            sessionId,
            observation: { incarnation, sequence: index + 2 },
            session: snapshot.header.session,
            messages: [
              {
                mode: 'replace',
                text: budget === 'bytes' ? 'x'.repeat(16_000) : 'Small body',
                hasActivities: false,
                hasComments: false,
                message: {
                  id: crypto.randomUUID(),
                  sessionId,
                  role: 'assistant',
                  agentId: 'codex',
                  state: 'streaming',
                  contentRevision: 0,
                  sequence: index,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              },
            ],
            runs: [],
            activities: [],
            activityStates: [],
          })
        delayed.resolve({ ok: true, value: snapshot })
      })
      await waitFor(() => expect(hook.result.current.history.gapRecoveryPending).toBe(true))
      expect(hook.result.current.snapshot?.messages).toEqual([])
    },
  )
  it('reestablishes A after A→B→A even when cached A remains indefinitely fresh', async () => {
    const f = fixture(),
      a = randomUUID(),
      b = randomUUID()
    f.client.setQueryData(conversationQueryKeys.session(a), page(a))
    const hook = renderHook(({ id }) => useConversation(id, f.notice), {
      initialProps: { id: a },
      wrapper: f.wrapper,
    })
    await waitFor(() => expect(f.interest.mock.calls.at(-1)?.[0]).toBe(a))
    // Full-suite worker contention can delay the mocked draft page beyond
    // Testing Library's 1s default; this is not a product request deadline.
    await waitFor(() => expect(hook.result.current.history.draftsLoading).toBe(false), {
      timeout: 3_000,
    })
    hook.rerender({ id: b })
    await waitFor(() => expect(hook.result.current.snapshot?.sessionId).toBe(b))
    expect(f.client.getQueryData(conversationQueryKeys.session(a))).toBeDefined()
    hook.rerender({ id: a })
    await waitFor(() => expect(f.interest.mock.calls.at(-1)?.[0]).toBe(a))
    await waitFor(() =>
      expect(
        f.get.mock.calls.filter(([input]) => input.scope === 'messages' && input.sessionId === a)
          .length,
      ).toBe(2),
    )
    expect(f.interest.mock.invocationCallOrder.at(-1)).toBeLessThan(
      f.get.mock.invocationCallOrder.at(-1)!,
    )
  })
  it('applies a Patch received before the initial page response instead of losing its final body', async () => {
    const f = fixture(),
      sessionId = randomUUID()
    const delayed = Promise.withResolvers<RpcResult<ConversationPage>>()
    f.get.mockImplementationOnce(() => delayed.promise)
    const hook = renderHook(() => useConversation(sessionId, f.notice), { wrapper: f.wrapper })
    await waitFor(() => expect(f.get).toHaveBeenCalledOnce())
    const snapshot = page(sessionId)
    const patch: ConversationPatch = {
      version: 'conversation-patch-v1',
      sessionId,
      observation: { incarnation, sequence: 2 },
      session: snapshot.header.session,
      messages: [
        {
          mode: 'replace',
          text: 'Final body before page install',
          hasActivities: false,
          hasComments: false,
          message: {
            id: randomUUID(),
            sessionId,
            role: 'assistant',
            agentId: 'codex',
            contentRevision: 0,
            state: 'complete',
            sequence: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
      ],
      runs: [],
      activities: [],
      activityStates: [],
    }
    await act(async () => {
      f.emit(patch)
      delayed.resolve({ ok: true, value: snapshot })
    })
    await waitFor(() =>
      expect(hook.result.current.snapshot?.messages[0]?.content).toBe(
        'Final body before page install',
      ),
    )
    expect(hook.result.current.snapshot?.observation.sequence).toBe(2)
  })
  it('settles an uncertain A send from its body-free late ACK while B is selected', async () => {
    const f = fixture(),
      a = randomUUID(),
      b = randomUUID()
    const hook = renderHook(({ id }) => useConversation(id, f.notice), {
      initialProps: { id: a },
      wrapper: f.wrapper,
    })
    await waitFor(() => expect(hook.result.current.history.draftsLoading).toBe(false))
    await act(async () => hook.result.current.setComposer('Original message'))
    await act(async () => {
      await hook.result.current.send('Original message', [])
    })
    const input = f.send.mock.calls[0]![0]
    hook.rerender({ id: b })
    await waitFor(() => expect(hook.result.current.snapshot?.sessionId).toBe(b))
    await act(async () =>
      f.emit({
        version: 'conversation-patch-v1',
        sessionId: a,
        observation: { incarnation, sequence: 2 },
        session: page(a).header.session,
        messages: [
          {
            mode: 'metadata',
            hasActivities: false,
            hasComments: false,
            message: {
              id: input.clientMessageId,
              sessionId: a,
              role: 'user',
              contentRevision: 0,
              state: 'complete',
              sequence: 0,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          },
        ],
        runs: [],
        activities: [],
        activityStates: [],
      }),
    )
    hook.rerender({ id: a })
    await waitFor(() => expect(hook.result.current.history.draftsLoading).toBe(false))
    expect(hook.result.current.composer).toBe('')
    expect(hook.result.current.error).toBeUndefined()
    await act(async () => {
      await hook.result.current.send('Different content', [])
    })
    expect(f.send.mock.calls[1]?.[0].content).toBe('Different content')
  })
})
