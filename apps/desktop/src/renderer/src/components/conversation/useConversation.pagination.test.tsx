// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import type {
  AgentActivity,
  AgentRun,
  ConversationPage,
  ConversationPatch,
  DesktopBridge,
} from '@pact/contracts'

import { createRendererQueryClient } from '../../query-client'
import { NativeInputCard } from './NativeInputCard'
import { useConversation } from './useConversation'

type MessagePage = Extract<ConversationPage, { scope: 'messages' }>
type FixturePage = MessagePage & {
  messages: Extract<MessagePage['messages'][number], { kind: 'complete' }>[]
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function historyFixture(header: Partial<MessagePage['header']> = {}) {
  const sessionId = crypto.randomUUID()
  const incarnation = crypto.randomUUID()
  const timestamp = new Date().toISOString()
  const firstId = crypto.randomUUID()
  const page = (
    id: string = firstId,
    sequence = 100,
    observation = 1,
    revision = 0,
    content = 'Original',
  ): FixturePage => ({
    scope: 'messages',
    sessionId,
    observation: { incarnation, sequence: observation },
    header: {
      session: {
        id: sessionId,
        title: 'Fixture',
        titleSource: 'local',
        status: 'idle',
        activity: { state: 'idle' },
        hasUnread: false,
        updatedAt: timestamp,
      },
      commentsRevision: 0,
      ...header,
    },
    messages: [
      {
        kind: 'complete',
        message: {
          id,
          sessionId,
          role: 'user',
          content,
          contentRevision: revision,
          state: 'complete',
          sequence,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        hasActivities: false,
        hasComments: false,
      },
    ],
    runs: [],
    hasOlder: true,
    hasNewer: false,
  })
  const getConversation = vi.fn<DesktopBridge['getConversation']>(async (input) => {
    if (input.scope === 'drafts')
      return {
        ok: true,
        value: {
          scope: 'drafts',
          sessionId,
          observation: { incarnation, sequence: 1 },
          commentsRevision: 0,
          comments: [],
          hasMore: false,
        },
      }
    if (input.scope !== 'messages') throw new Error('Unexpected scope')
    return { ok: true, value: page(input.aroundMessageId ?? firstId) }
  })
  let listener: ((patch: ConversationPatch) => void) | undefined
  vi.stubGlobal('pact', {
    getConversation,
    setConversationInterest: vi
      .fn<DesktopBridge['setConversationInterest']>()
      .mockResolvedValue({ ok: true, value: { ready: true } }),
    onConversationChanged: (callback: (patch: ConversationPatch) => void) => {
      listener = callback
      return () => {
        listener = undefined
      }
    },
  })
  const client = createRendererQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  const onNotice = vi.fn<(message: string) => void>()
  const initialProps: { selected: string | undefined } = { selected: sessionId }
  const hook = renderHook(
    ({ selected }: typeof initialProps) => useConversation(selected, onNotice),
    { wrapper, initialProps },
  )
  const deliver = (
    sequence: number,
    messages: ConversationPatch['messages'] = [],
    extra: Partial<ConversationPatch> = {},
  ) => {
    listener?.({
      version: 'conversation-patch-v1',
      sessionId,
      observation: { incarnation, sequence },
      session: page().header.session,
      messages,
      activities: [],
      runs: [],
      activityStates: [],
      ...extra,
    })
  }
  const change = (revision: number, mode: 'invalidate' | 'metadata') => {
    const { content: _content, ...message } = page(firstId, 100, 1, revision).messages[0]!.message
    return { message, mode, hasActivities: false, hasComments: false }
  }
  const defer = () => {
    let resolve!: (page: MessagePage) => void
    getConversation.mockImplementationOnce(async () => ({
      ok: true,
      value: await new Promise<MessagePage>((done) => {
        resolve = done
      }),
    }))
    return (value: MessagePage) => resolve(value)
  }
  return { ...hook, page, firstId, getConversation, deliver, change, defer, client }
}

it.each(['new-selection', 'collapse'] as const)(
  'settles old activity reads without overwriting %s and coalesces resync through one owner',
  async (mode) => {
    const f = historyFixture()
    await waitFor(() => expect(f.result.current.snapshot).toBeDefined())
    const initial = f.page(),
      now = new Date().toISOString()
    const run = (agentId: 'codex' | 'claude', status: AgentRun['status']): AgentRun => ({
      id: crypto.randomUUID(),
      sessionId: initial.sessionId,
      userMessageId: f.firstId,
      agentId,
      status,
      attemptCount: 1,
      settingsRevision: 1,
      model: null,
      effort: null,
      createdAt: now,
      updatedAt: now,
    })
    const a = run('codex', 'completed'),
      b = run('claude', 'running')
    act(() =>
      f.deliver(
        2,
        [
          {
            message: { ...initial.messages[0]!.message, runId: a.id },
            mode: 'metadata',
            hasActivities: true,
            hasComments: false,
          },
        ],
        { runs: [a, b], latestRunId: b.id },
      ),
    )
    type ActivityPage = Extract<ConversationPage, { scope: 'activities' }>
    const requests: Array<{ runId: string; resolve: (page: ActivityPage) => void }> = []
    f.getConversation.mockImplementation(async (input) => {
      if (input.scope !== 'activities') throw new Error('Unexpected regression read')
      return {
        ok: true,
        value: await new Promise<ActivityPage>((resolve) =>
          requests.push({ runId: input.runId, resolve }),
        ),
      }
    })
    const activity = (r: AgentRun): AgentActivity => ({
      id: crypto.randomUUID(),
      sessionId: initial.sessionId,
      runId: r.id,
      agentId: r.agentId,
      kind: 'tool',
      title: 'Already stored step',
      nativeId: 'stored-step',
      detailRevision: 0,
      status: 'completed',
      sequence: 0,
      createdAt: now,
      updatedAt: now,
    })
    const old = activity(a),
      live = activity(b)
    const activityPage = (r: AgentRun, item: AgentActivity): ActivityPage => ({
      scope: 'activities',
      sessionId: initial.sessionId,
      runId: r.id,
      observation: { ...initial.observation, sequence: 3 },
      activities: [{ kind: 'complete', activity: item }],
      truncated: false,
    })
    act(() => void f.result.current.history.loadActivities(a.id))
    await waitFor(() => expect(requests).toHaveLength(1))
    act(() => {
      if (mode === 'new-selection') void f.result.current.history.loadActivities(b.id)
      else f.result.current.history.setActivityReading?.(a.id, false)
      f.deliver(3, [], { resync: { messages: false, drafts: false, activityRunIds: [b.id] } })
    })
    expect(requests).toHaveLength(1)
    await act(async () => requests[0]!.resolve(activityPage(a, old)))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.runId).toBe(b.id)
    await act(async () => requests[1]!.resolve(activityPage(b, live)))
    await waitFor(() => expect(f.result.current.snapshot?.activities).toEqual([live]))
    expect(f.result.current.history.window?.activityView?.runId).toBe(b.id)
    expect(f.result.current.history.window?.activityView?.manual).toBe(
      mode === 'new-selection' ? true : undefined,
    )
    expect(f.result.current.history.loadingActivityRunId).toBeUndefined()
  },
)

it('shows an activity read error and permits Retry when the current selection returns a new incarnation', async () => {
  const f = historyFixture()
  await waitFor(() => expect(f.result.current.snapshot).toBeDefined())
  const initial = f.page(),
    now = new Date().toISOString()
  const run: AgentRun = {
    id: crypto.randomUUID(),
    sessionId: initial.sessionId,
    userMessageId: f.firstId,
    agentId: 'codex',
    status: 'completed',
    attemptCount: 1,
    settingsRevision: 1,
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
  }
  act(() =>
    f.deliver(
      2,
      [
        {
          message: { ...initial.messages[0]!.message, runId: run.id },
          mode: 'metadata',
          hasActivities: true,
          hasComments: false,
        },
      ],
      { runs: [run], latestRunId: run.id },
    ),
  )
  f.getConversation.mockResolvedValueOnce({
    ok: true,
    value: {
      scope: 'activities',
      sessionId: initial.sessionId,
      runId: run.id,
      observation: { incarnation: crypto.randomUUID(), sequence: 1 },
      activities: [],
      truncated: false,
    },
  })
  await act(async () => f.result.current.history.loadActivities(run.id))
  expect(f.result.current.history.activityError).toMatchObject({
    runId: run.id,
    message: 'The Work log changed. Open it again.',
  })
  expect(f.result.current.history.loadingActivityRunId).toBeUndefined()
})

it('checks the initialized current binding without routing to an old-generation Run', async () => {
  const fixture = historyFixture()
  await waitFor(() => expect(fixture.result.current.snapshot).toBeDefined())
  const sessionId = fixture.page().sessionId
  const timestamp = new Date().toISOString()
  const oldRun: AgentRun = {
    id: crypto.randomUUID(),
    sessionId,
    userMessageId: fixture.firstId,
    agentId: 'claude',
    status: 'failed',
    attemptCount: 1,
    settingsRevision: 1,
    model: null,
    effort: null,
    nativeSessionId: 'old-native',
    bindingGeneration: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const context = {
    sessionId,
    agentId: 'claude' as const,
    nativeSessionId: 'rebuilt-native',
    bindingGeneration: 2,
    state: 'active' as const,
    continuationState: 'recovery_required' as const,
    updatedAt: timestamp,
    rebuildOperation: { id: crypto.randomUUID(), oldGeneration: 1, stage: 'completed' as const },
  }
  const retryConversationRun = vi
    .fn<DesktopBridge['retryConversationRun']>()
    .mockResolvedValue({ ok: false, error: { code: 'CONFLICT', message: 'Fixture probe result' } })
  vi.stubGlobal('pact', { ...window.pact, retryConversationRun })
  act(() => fixture.deliver(2, [], { nativeContexts: [context], runs: [oldRun] }))
  await act(async () => {
    await expect(fixture.result.current.checkNativeContext('claude')).rejects.toThrow(
      'Fixture probe result',
    )
  })
  expect(retryConversationRun).toHaveBeenLastCalledWith(sessionId, {
    intent: 'inspect',
    sessionId,
    agentId: 'claude',
  })
  // Even a stale lastRunId must not redirect a current-binding check into history.
  act(() => fixture.deliver(3, [], { nativeContexts: [{ ...context, lastRunId: oldRun.id }] }))
  await act(async () => {
    await expect(fixture.result.current.checkNativeContext('claude')).rejects.toThrow(
      'Fixture probe result',
    )
  })
  expect(retryConversationRun).toHaveBeenLastCalledWith(sessionId, {
    intent: 'inspect',
    sessionId,
    agentId: 'claude',
  })
  const currentRun = {
    ...oldRun,
    id: crypto.randomUUID(),
    nativeSessionId: context.nativeSessionId,
    bindingGeneration: 2,
  }
  act(() => fixture.deliver(4, [], { runs: [currentRun], latestRunId: currentRun.id }))
  await act(async () => {
    await expect(fixture.result.current.checkNativeContext('claude')).rejects.toThrow(
      'Fixture probe result',
    )
  })
  expect(retryConversationRun).toHaveBeenLastCalledWith(currentRun.id, {
    intent: 'inspect',
    sessionId,
    agentId: 'claude',
  })
  fixture.client.clear()
})

it('keeps startup form drafts through patches and clears them on exact native scope changes', async () => {
  const request = {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    kind: 'form' as const,
    createdAt: new Date().toISOString(),
    title: 'Provide input',
    detail: 'Form',
  }
  const interaction = {
    agentId: 'claude' as const,
    bindingGeneration: 1,
    executorId: crypto.randomUUID(),
    request,
  }
  const fixture = historyFixture({ pendingNativeInteractions: [interaction] })
  await waitFor(() => expect(fixture.result.current.history.window).toBeDefined())
  act(() =>
    fixture.result.current.setNativeInputDraft(request, {
      values: { project: 'private draft' },
      page: 1,
    }),
  )
  expect(fixture.result.current.nativeInputDrafts[request.id]?.values).toEqual({
    project: 'private draft',
  })
  expect(fixture.result.current.nativeInputDrafts[request.id]?.page).toBe(1)
  act(() => fixture.deliver(2))
  expect(fixture.result.current.nativeInputDrafts[request.id]?.page).toBe(1)
  act(() =>
    fixture.deliver(3, [], {
      pendingNativeInteractions: [{ ...interaction, executorId: crypto.randomUUID() }],
    }),
  )
  expect(fixture.result.current.nativeInputDrafts).toEqual({})
  act(() =>
    fixture.result.current.setNativeInputDraft(request, {
      values: { project: 'new draft' },
      page: 0,
    }),
  )
  expect(fixture.result.current.nativeInputDrafts[request.id]?.values).toEqual({
    project: 'new draft',
  })
  act(() =>
    fixture.deliver(4, [], {
      pendingNativeInteractions: [{ ...interaction, bindingGeneration: 2 }],
    }),
  )
  expect(fixture.result.current.nativeInputDrafts).toEqual({})
  act(() => fixture.result.current.setNativeInputDraft(request, { values: {}, page: 0 }))
  act(() => fixture.deliver(5, [], { pendingNativeInteractions: [] }))
  expect(fixture.result.current.nativeInputDrafts).toEqual({})
  fixture.client.clear()
})

it('lets the real startup form page, edit, retain its draft through a patch, and submit once', async () => {
  const request = {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    kind: 'form' as const,
    createdAt: new Date().toISOString(),
    title: 'Startup form',
    detail: 'Provide input',
  }
  const fixture = historyFixture({
    pendingNativeInteractions: [
      { agentId: 'claude', bindingGeneration: 1, executorId: crypto.randomUUID(), request },
    ],
  })
  await waitFor(() => expect(fixture.result.current.snapshot).toBeDefined())
  const source = fixture.page()
  let finish!: () => void
  const respondNativeInput = vi.fn<DesktopBridge['respondNativeInput']>(
    () =>
      new Promise((done) => {
        finish = () =>
          done({
            ok: true,
            value: {
              version: 'conversation-patch-v1',
              sessionId: source.sessionId,
              observation: { ...source.observation, sequence: 3 },
              session: source.header.session,
              messages: [],
              activities: [],
              runs: [],
              activityStates: [],
              pendingNativeInteractions: [],
            },
          })
      }),
  )
  vi.stubGlobal('pact', {
    ...window.pact,
    readNativeInput: vi.fn<DesktopBridge['readNativeInput']>().mockResolvedValue({
      ok: true,
      value: {
        kind: 'form',
        title: 'Startup form',
        message: '',
        fields: Array.from({ length: 5 }, (_, index) => ({
          id: `field-${index}`,
          label: `Field ${index}`,
          type: 'text' as const,
          required: false,
        })),
      },
    }),
    respondNativeInput,
  })
  const card = () =>
    createElement(NativeInputCard, {
      request,
      agentId: 'claude',
      draft: fixture.result.current.nativeInputDrafts[request.id],
      onDraftChange: fixture.result.current.setNativeInputDraft,
      onRespond: (input) => fixture.result.current.respondNativeInput(input),
    })
  const mounted = render(card())
  await screen.findByRole('textbox', { name: 'Field 0' })
  mounted.rerender(card())
  fireEvent.change(screen.getByRole('textbox', { name: 'Field 0' }), {
    target: { value: 'private answer' },
  })
  mounted.rerender(card())
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  mounted.rerender(card())
  expect(fixture.result.current.nativeInputDrafts[request.id]?.page).toBe(1)
  expect(screen.getByRole('textbox', { name: 'Field 4' })).toBeDefined()
  act(() => fixture.deliver(2))
  mounted.rerender(card())
  expect(fixture.result.current.nativeInputDrafts[request.id]?.values).toEqual({
    'field-0': 'private answer',
  })
  fireEvent.click(screen.getByRole('button', { name: 'Submit details' }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit details' }))
  expect(respondNativeInput).toHaveBeenCalledTimes(1)
  expect(respondNativeInput).toHaveBeenCalledWith({
    requestId: request.id,
    operationId: request.operationId,
    action: 'accept',
    values: { 'field-0': 'private answer' },
  })
  await act(async () => finish())
  expect(fixture.result.current.nativeInputDrafts).toEqual({})
  expect(fixture.result.current.snapshot?.pendingNativeInteractions).toEqual([])
  fixture.client.clear()
})

it('queues only the latest Comment target and cancels it on Session change', async () => {
  const fixture = historyFixture()
  const { result, getConversation, page } = fixture
  await waitFor(() => expect(result.current.history.window).toBeDefined())
  let release = fixture.defer()
  let loading!: Promise<void>
  act(() => {
    loading = result.current.history.loadOlder()
  })
  const targets = [crypto.randomUUID(), crypto.randomUUID()]
  await act(async () => {
    await result.current.history.ensureMessage(targets[0]!)
    await result.current.history.ensureMessage(targets[1]!)
  })
  expect(
    getConversation.mock.calls.filter(
      ([input]) => input.scope === 'messages' && input.aroundMessageId,
    ),
  ).toHaveLength(0)
  await act(async () => {
    release(page(crypto.randomUUID(), 75))
    await loading
  })
  await waitFor(() => expect(result.current.history.window?.view.messages[0]?.id).toBe(targets[1]))
  expect(
    getConversation.mock.calls.filter(
      ([input]) => input.scope === 'messages' && input.aroundMessageId,
    ),
  ).toHaveLength(1)
  release = fixture.defer()
  act(() => {
    loading = result.current.history.loadOlder()
  })
  await act(async () => {
    await result.current.history.ensureMessage(targets[0]!)
  })
  fixture.rerender({ selected: undefined })
  await act(async () => {
    release(page())
    await loading
  })
  expect(result.current.history.window).toBeUndefined()
  expect(
    getConversation.mock.calls.filter(
      ([input]) => input.scope === 'messages' && input.aroundMessageId,
    ),
  ).toHaveLength(1)
  fixture.client.clear()
})

it('bounds unsuccessful recovery, supports same-anchor Retry and fences a second in-flight gap', async () => {
  const fixture = historyFixture()
  const { result, getConversation, page, firstId } = fixture
  await waitFor(() => expect(result.current.history.window).toBeDefined())
  act(() => fixture.deliver(2, [fixture.change(1, 'invalidate')]))
  const before = getConversation.mock.calls.length
  await act(async () => {
    await result.current.history.recoverFromGap(firstId)
  })
  expect(getConversation.mock.calls.length - before).toBe(3)
  expect(result.current.history.gapRecoveryPending).toBe(true)
  expect(result.current.history.loadingPage).toBe(false)
  expect(result.current.history.pageError).toBeDefined()
  getConversation.mockResolvedValueOnce({ ok: true, value: page(firstId, 100, 2, 1, 'Correct') })
  await act(async () => {
    await result.current.history.recoverFromGap(firstId)
  })
  expect(result.current.history.window?.view.messages[0]?.content).toBe('Correct')
  expect(result.current.history.gapRecoveryPending).toBe(false)
  expect(result.current.history.pageError).toBeUndefined()

  act(() => fixture.deliver(3, [fixture.change(2, 'invalidate')]))
  const release = fixture.defer()
  let recovering!: Promise<void>
  act(() => {
    recovering = result.current.history.recoverFromGap(firstId)
  })
  act(() => fixture.deliver(5))
  getConversation.mockResolvedValueOnce({ ok: true, value: page(firstId, 100, 5, 2, 'Newest') })
  await act(async () => {
    release(page(firstId, 100, 3, 2, 'Interim'))
    await recovering
  })
  expect(result.current.history.window?.view.messages[0]?.content).toBe('Newest')
  expect(result.current.history.gapRecoveryPending).toBe(false)

  act(() => fixture.deliver(7))
  const cancel = fixture.defer()
  act(() => {
    recovering = result.current.history.recoverFromGap(firstId)
  })
  const callsBeforeSwitch = getConversation.mock.calls.length
  fixture.rerender({ selected: undefined })
  await act(async () => {
    cancel(page())
    await recovering
  })
  expect(result.current.history.window).toBeUndefined()
  expect(getConversation.mock.calls).toHaveLength(callsBeforeSwitch)
  fixture.client.clear()
})

it('does not erase a new interrupted partial reply when an older around-page settles', async () => {
  const fixture = historyFixture()
  const { result, page, firstId } = fixture
  await waitFor(() => expect(result.current.history.window).toBeDefined())
  const release = fixture.defer()
  let pending!: Promise<void>
  act(() => {
    pending = result.current.history.recoverFromGap(firstId)
  })
  const { content: _content, ...source } = page().messages[0]!.message
  const partial = {
    ...source,
    id: crypto.randomUUID(),
    sequence: 101,
    role: 'assistant' as const,
    agentId: 'codex' as const,
    state: 'streaming' as const,
  }
  act(() =>
    fixture.deliver(2, [
      {
        message: partial,
        mode: 'replace',
        text: 'Partial answer',
        hasActivities: false,
        hasComments: false,
      },
    ]),
  )
  act(() =>
    fixture.deliver(3, [
      {
        message: { ...partial, state: 'incomplete' },
        mode: 'metadata',
        hasActivities: false,
        hasComments: false,
      },
    ]),
  )
  await act(async () => {
    release(page())
    await pending
  })
  expect(result.current.history.window?.view.messages).toHaveLength(2)
  expect(result.current.history.window?.view.messages[1]).toMatchObject({
    content: 'Partial answer',
    state: 'incomplete',
  })
  fixture.client.clear()
})
