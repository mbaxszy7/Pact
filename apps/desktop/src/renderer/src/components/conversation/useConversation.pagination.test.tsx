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

import { createQueueFixture } from '../../../../../../../packages/persistence/src/conversation-queue.test-helper.js'
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
          commentsRevision: header.commentsRevision ?? 0,
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
  return { ...hook, page, firstId, getConversation, deliver, change, defer, client, onNotice }
}

function snapshotRun(
  f: ReturnType<typeof historyFixture>,
  status: AgentRun['status'] = 'running',
): AgentRun {
  const source = f.page()
  return {
    id: crypto.randomUUID(),
    sessionId: source.sessionId,
    userMessageId: f.firstId,
    agentId: 'codex',
    status,
    attemptCount: 1,
    settingsRevision: 1,
    model: null,
    effort: null,
    outputSnapshots: {
      count: 1,
      lastInputMessageId: crypto.randomUUID(),
      lastInputSequence: 102,
      settled: status === 'completed',
    },
    createdAt: source.header.session.updatedAt,
    updatedAt: source.header.session.updatedAt,
  }
}

it('preserves a resident historical reading anchor outside latest25 when another Steer Run folds', async () => {
  const fixture = await createQueueFixture()
  const client = createRendererQueryClient()
  let unmount: (() => void) | undefined
  try {
    const a = fixture.root()
    fixture.finish(a)
    fixture.repo.recordNativeEffects(a.id, 'settled')
    const sourceId = fixture.repo.findRun(a.id)!.responseMessageId!
    for (let index = 0; index < 15; index += 1) {
      const filler = fixture.root()
      fixture.finish(filler)
      fixture.repo.recordNativeEffects(filler.id, 'settled')
    }
    const b = fixture.root()
    fixture.consume(b, 'Current Run supplement')
    fixture.repo.applyEvent(fixture.sessionId, b.id, {
      type: 'text.delta',
      agentId: 'codex',
      turnId: b.nativeTurnId,
      outputId: 'answer',
      text: 'Current response.',
    })
    let listener: ((patch: ConversationPatch) => void) | undefined
    const getConversation = vi.fn<DesktopBridge['getConversation']>(async (input) => ({
      ok: true,
      value: fixture.repo.readPage(input),
    }))
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
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children)
    const onNotice = vi.fn<(message: string) => void>()
    const hook = renderHook(() => useConversation(fixture.sessionId, onNotice), { wrapper })
    unmount = hook.unmount
    await waitFor(() => expect(hook.result.current.history.window).toBeDefined())
    expect(
      hook.result.current.history.window?.view.messages.some((message) => message.id === sourceId),
    ).toBe(false)
    await act(async () => hook.result.current.history.loadOlder())
    expect(hook.result.current.history.window!.view.messages.length).toBeGreaterThan(25)
    await act(async () => hook.result.current.history.ensureMessage(sourceId))
    act(() => {
      hook.result.current.history.protectReading(sourceId)
      hook.result.current.history.setSnapshotFoldGuard?.(() => true)
      listener?.(
        fixture.repo.applyEvent(fixture.sessionId, b.id, {
          type: 'text.completed',
          agentId: 'codex',
          turnId: b.nativeTurnId,
          outputId: 'answer',
          text: 'Full final response.',
        }),
      )
      listener?.(
        fixture.repo.recordNativeEvidence({
          kind: 'ended',
          source: 'live_terminal',
          outcome: 'completed',
          identity: { ...fixture.proof(b), agentId: 'codex', requestId: b.id },
        }),
      )
      listener?.(
        fixture.repo.applyEvent(fixture.sessionId, b.id, {
          type: 'turn.completed',
          agentId: 'codex',
          turnId: b.nativeTurnId,
          outcome: 'completed',
        }),
      )
      listener?.(fixture.repo.settleKnownNativeEnding(b.id))
      listener?.(fixture.repo.recordNativeEffects(b.id, 'settled'))
    })
    expect(hook.result.current.history.window?.preserveRunId).toBe(b.id)
    expect(
      hook.result.current.history.window?.view.runs.find((run) => run.id === b.id)?.outputSnapshots
        ?.settled,
    ).toBe(true)
    expect(hook.result.current.history.gapRecoveryPending).toBe(false)
    expect(
      Object.values(hook.result.current.history.window!.messageMeta).some(
        (meta) => meta.bodyResync,
      ),
    ).toBe(false)
    const readsBeforeFold = getConversation.mock.calls.length
    await act(async () => hook.result.current.history.collapseEarlierResponses?.(b.id))
    expect(getConversation.mock.calls).toHaveLength(readsBeforeFold)
    expect(
      hook.result.current.history.window?.view.messages.some((message) => message.id === sourceId),
    ).toBe(true)
    expect(hook.result.current.history.window?.sourceMessageId).toBe(sourceId)
    expect(hook.result.current.history.window?.preserveRunId).toBe(b.id)
    await act(async () => hook.result.current.history.loadLatest())
    expect(hook.result.current.history.window?.sourceMessageId).toBeUndefined()
    await act(async () => hook.result.current.history.collapseEarlierResponses?.(b.id))
    expect(hook.result.current.history.window?.preserveRunId).toBeUndefined()
    expect(
      hook.result.current.history.window?.view.messages.some(
        (message) => message.runId === b.id && message.outputSnapshot?.canonical === false,
      ),
    ).toBe(false)
  } finally {
    unmount?.()
    client.clear()
    fixture.close()
  }
})

it('keeps historical A selected while B gets its first cut, then folds only B after its guard passes', async () => {
  const f = historyFixture()
  await waitFor(() => expect(f.result.current.history.window).toBeDefined())
  const a = snapshotRun(f, 'completed'),
    b = snapshotRun(f)
  const sourceId = crypto.randomUUID()
  const release = f.defer()
  let reading!: Promise<void>
  act(() => {
    reading = f.result.current.history.ensureMessage(sourceId)
  })
  act(() => f.deliver(2, [], { runs: [a, b], latestRunId: b.id }))
  expect(f.result.current.history.window?.preserveRunId).toBe(b.id)
  const source = f.page(sourceId, 80, 2)
  source.sourceMessageId = sourceId
  source.snapshotView = { runId: a.id, mode: 'expanded' }
  source.preserveRunId = b.id
  source.runs = [a, b]
  f.getConversation.mockResolvedValueOnce({ ok: true, value: source })
  await act(async () => {
    release(source)
    await reading
  })
  await waitFor(() => expect(f.result.current.history.window?.sourceMessageId).toBe(sourceId))
  expect(f.getConversation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      aroundMessageId: sourceId,
      includeHistoricalSource: true,
      preserveRunId: b.id,
    }),
  )
  expect(f.result.current.history.window?.snapshotView).toEqual(source.snapshotView)
  const done = {
    ...b,
    status: 'completed' as const,
    outputSnapshots: { ...b.outputSnapshots!, settled: true },
  }
  act(() => f.deliver(3, [], { runs: [done] }))
  act(() => f.result.current.history.setSnapshotFoldGuard?.(() => false))
  const before = f.getConversation.mock.calls.length
  await act(async () => f.result.current.history.collapseEarlierResponses?.(b.id))
  expect(f.getConversation.mock.calls).toHaveLength(before)
  act(() => f.result.current.history.setSnapshotFoldGuard?.(() => true))
  const folded = f.page(sourceId, 80, 3)
  folded.snapshotView = source.snapshotView
  folded.runs = [a, done]
  f.getConversation.mockResolvedValueOnce({ ok: true, value: folded })
  await act(async () => f.result.current.history.collapseEarlierResponses?.(b.id))
  expect(f.getConversation).toHaveBeenLastCalledWith(
    expect.objectContaining({ snapshotView: source.snapshotView }),
  )
  expect(f.getConversation.mock.calls.at(-1)?.[0]).not.toHaveProperty('preserveRunId')
  expect(f.result.current.history.window?.preserveRunId).toBeUndefined()
  expect(f.result.current.history.window?.snapshotView).toEqual(source.snapshotView)
  f.client.clear()
})

it.each(['resident', 'latest', 'recover-latest'] as const)(
  'supersedes an in-flight historical target with %s during a new Run cut',
  async (intent) => {
    const f = historyFixture()
    await waitFor(() => expect(f.result.current.history.window).toBeDefined())
    const oldTarget = crypto.randomUUID(),
      b = snapshotRun(f)
    const release = f.defer()
    let reading!: Promise<void>
    act(() => {
      reading = f.result.current.history.ensureMessage(oldTarget)
    })
    if (intent !== 'resident') {
      await act(async () => f.result.current.history.loadLatest())
    }
    act(() => f.deliver(2, [], { runs: [b], latestRunId: b.id }))
    if (intent === 'resident')
      await act(async () => f.result.current.history.ensureMessage(f.firstId))
    if (intent === 'recover-latest')
      await act(async () => f.result.current.history.recoverLatest!())
    const latest = f.page(f.firstId, 100, 2)
    latest.runs = [b]
    latest.preserveRunId = b.id
    f.getConversation.mockResolvedValueOnce({ ok: true, value: latest })
    await act(async () => {
      release(f.page(oldTarget, 50, 1))
      await reading
    })
    await waitFor(() => expect(f.result.current.history.loadingPage).toBe(false))
    expect(f.result.current.history.window?.view.messages[0]?.id).toBe(f.firstId)
    expect(f.result.current.history.window?.preserveRunId).toBe(b.id)
    const around = f.getConversation.mock.calls.filter(
      ([input]) => input.scope === 'messages' && input.aroundMessageId === oldTarget,
    )
    expect(around).toHaveLength(1)
    expect(f.result.current.history.window?.sourceMessageId).toBe(
      intent === 'resident' ? f.firstId : undefined,
    )
    const latestReads = f.getConversation.mock.calls.filter(
      ([input]) => input.scope === 'messages' && !input.aroundMessageId,
    )
    expect(latestReads).toHaveLength(intent === 'resident' ? 1 : 2)
    expect(latestReads.at(-1)?.[0]).toMatchObject(
      intent === 'resident' ? { scope: 'messages' } : { scope: 'messages', preserveRunId: b.id },
    )
    expect(f.result.current.history.gapRecoveryPending).toBe(false)
    f.client.clear()
  },
)

it('reissues a no-anchor gap recovery if the first live Steer cut invalidates its page', async () => {
  const f = historyFixture()
  await waitFor(() => expect(f.result.current.history.window).toBeDefined())
  const release = f.defer(),
    b = snapshotRun(f)
  let recovery!: Promise<void>
  act(() => {
    recovery = f.result.current.history.recoverLatest!()
  })
  act(() => f.deliver(3, [], { runs: [b], latestRunId: b.id }))
  const latest = f.page(f.firstId, 100, 3)
  latest.runs = [b]
  f.getConversation.mockResolvedValueOnce({ ok: true, value: latest })
  await act(async () => {
    release(f.page())
    await recovery
  })
  await waitFor(() => expect(f.result.current.history.loadingPage).toBe(false))
  expect(f.getConversation.mock.calls.at(-1)?.[0]).toMatchObject({ preserveRunId: b.id })
  expect(f.result.current.history.gapRecoveryPending).toBe(false)
  expect(f.result.current.history.window?.view.observation.sequence).toBe(3)
  f.client.clear()
})

it('cannot let a stale A completion fold release the live preservation of B', async () => {
  const f = historyFixture()
  await waitFor(() => expect(f.result.current.history.window).toBeDefined())
  const a = snapshotRun(f),
    b = snapshotRun(f)
  act(() => f.deliver(2, [], { runs: [a], latestRunId: a.id }))
  const done = {
    ...a,
    status: 'completed' as const,
    outputSnapshots: { ...a.outputSnapshots!, settled: true },
  }
  act(() => f.deliver(3, [], { runs: [done] }))
  act(() => f.result.current.history.setSnapshotFoldGuard?.(() => true))
  const release = f.defer()
  let folding!: Promise<void>
  act(() => {
    folding = f.result.current.history.collapseEarlierResponses!(a.id)
  })
  act(() => f.deliver(4, [], { runs: [b], latestRunId: b.id }))
  const stale = f.page(f.firstId, 100, 3)
  stale.runs = [done]
  await act(async () => {
    release(stale)
    await folding
  })
  expect(f.result.current.history.window?.preserveRunId).toBe(b.id)
  expect(f.result.current.history.window?.view.runs.find((run) => run.id === b.id)).toEqual(b)
  expect(f.result.current.history.window?.view.observation.sequence).toBe(4)
  f.client.clear()
})

async function queueReturnFixture(state: 'pending' | 'installed' = 'installed') {
  const returned = {
    inputId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    expectedRevision: 3,
    state,
    ...(state === 'installed'
      ? { claimId: crypto.randomUUID(), installedCommentsRevision: 0 }
      : {}),
  }
  const header: Partial<MessagePage['header']> = {
    commentsRevision: 0,
    queue: { enabled: true, revision: 3, input: null, returnedInput: returned },
  }
  const f = historyFixture(header)
  await waitFor(() => expect(f.result.current.history.window).toBeDefined())
  const original = f.getConversation.getMockImplementation()!
  const body: Extract<ConversationPage, { scope: 'queued-input' }> = {
    scope: 'queued-input',
    source: 'returned',
    sessionId: f.page().sessionId,
    inputId: returned.inputId,
    operationId: returned.operationId,
    text: '@codex Returned body',
    offset: 0,
    nextOffset: 20,
    hasMore: false,
    comments: [],
    commentsNextPosition: null,
    route: { type: 'agent', agentId: 'codex' },
  }
  body.nextOffset = body.text.length
  f.getConversation.mockImplementation(async (input) =>
    input.scope === 'queued-input' ? { ok: true, value: body } : original(input),
  )
  let observation = 1
  const claim = vi.fn<DesktopBridge['returnQueuedConversationMessage']>(async (input) => ({
    ok: true,
    value: {
      version: 'conversation-patch-v1',
      sessionId: body.sessionId,
      observation: {
        ...f.page().observation,
        sequence: (observation = Math.max(
          observation + 1,
          (f.result.current.snapshot?.observation.sequence ?? 0) + 1,
        )),
      },
      session: f.page().header.session,
      messages: [],
      runs: [],
      activities: [],
      activityStates: [],
      queue: {
        ...header.queue!,
        returnedInput: {
          ...returned,
          state: 'installed',
          claimId: input.claimId!,
          installedCommentsRevision: header.commentsRevision!,
        },
      },
    },
  }))
  vi.stubGlobal('pact', { ...window.pact, returnQueuedConversationMessage: claim })
  return { ...f, body, header, returned, claim }
}

it.each(['pending', 'installed'] as const)(
  'reuses the original %s Return claim across repeated Restore actions',
  async (state) => {
    const f = await queueReturnFixture(state)
    act(() => f.result.current.setComposer('Draft to overwrite'))
    await act(async () =>
      expect(await f.result.current.history.queueActions?.restoreReturned()).toBe(true),
    )
    expect(f.result.current.composer).toBe(f.body.text)
    act(() => f.result.current.setComposer('Another draft to overwrite'))
    await act(async () =>
      expect(await f.result.current.history.queueActions?.restoreReturned()).toBe(true),
    )
    expect(f.result.current.composer).toBe(f.body.text)
    expect(f.claim).toHaveBeenCalledTimes(2)
    for (const [input] of f.claim.mock.calls)
      expect(input).toMatchObject({
        phase: 'claim',
        expectedCommentsRevision: 0,
        claimId: state === 'installed' ? f.returned.claimId : f.returned.operationId,
      })
    expect(f.result.current.composerRoute).toEqual(f.body.route)
    f.client.clear()
  },
)

it.each(['comments', 'session'] as const)(
  'keeps new %s changes made during a paginated Return read',
  async (change) => {
    const f = await queueReturnFixture()
    act(() => f.result.current.setComposer('Original draft'))
    let release!: (page: ConversationPage) => void
    const pending = new Promise<ConversationPage>((resolve) => {
      release = resolve
    })
    const original = f.getConversation.getMockImplementation()!
    f.getConversation.mockImplementation(async (input) =>
      input.scope === 'queued-input' ? { ok: true, value: await pending } : original(input),
    )
    let restoring!: Promise<boolean>
    act(() => {
      restoring = f.result.current.history.queueActions!.restoreReturned()
    })
    if (change === 'comments') {
      f.header.commentsRevision = 1
      act(() => f.deliver(2, [], { comments: { revision: 1, upserts: [], removedIds: [] } }))
    } else f.rerender({ selected: undefined })
    await act(async () => {
      release(f.body)
      expect(await restoring).toBe(false)
    })
    expect(f.claim).not.toHaveBeenCalled()
    expect(f.result.current.composer).toBe(change === 'session' ? '' : 'Original draft')
    f.client.clear()
  },
)

it('locks Composer edits while its Return body is being restored', async () => {
  const f = await queueReturnFixture()
  act(() => f.result.current.setComposer('Original draft'))
  let release!: (page: ConversationPage) => void
  const pending = new Promise<ConversationPage>((resolve) => {
    release = resolve
  })
  const original = f.getConversation.getMockImplementation()!
  f.getConversation.mockImplementation(async (input) =>
    input.scope === 'queued-input' ? { ok: true, value: await pending } : original(input),
  )
  let restoring!: Promise<boolean>
  act(() => {
    restoring = f.result.current.history.queueActions!.restoreReturned()
  })
  act(() => f.result.current.setComposer('Blocked edit'))
  expect(f.result.current.composer).toBe('Original draft')
  await act(async () => {
    release(f.body)
    expect(await restoring).toBe(true)
  })
  expect(f.result.current.composer).toBe(f.body.text)
  expect(f.claim).toHaveBeenCalledTimes(1)
  f.client.clear()
})

it('uses a fresh claim only for an explicit Restore after Comments changed, with the click-start CAS revision', async () => {
  const f = await queueReturnFixture()
  f.header.commentsRevision = 1
  act(() => f.deliver(2, [], { comments: { revision: 1, upserts: [], removedIds: [] } }))
  await act(async () =>
    expect(await f.result.current.history.queueActions?.restoreReturned()).toBe(true),
  )
  const claim = f.claim.mock.calls[0]![0]
  expect(claim.expectedCommentsRevision).toBe(1)
  expect(claim.claimId).not.toBe(f.returned.claimId)
  expect(f.result.current.composer).toBe(f.body.text)
  f.client.clear()
})

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

it('keeps stale decision answers and the ordinary draft across session navigation until explicitly merged', async () => {
  const f = historyFixture()
  try {
    await waitFor(() => expect(f.result.current.snapshot).toBeDefined())
    const decision = {
      reference: {
        taskId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        decisionInputSequence: 1,
        expectedInputSequence: 1,
      },
      questions: [
        {
          id: 'q1',
          prompt: 'Delivery?',
          selection: 'single' as const,
          options: [
            { id: 'o1', label: 'Queue' },
            { id: 'o2', label: 'Steer' },
          ],
        },
      ],
      answers: { q1: { optionIds: ['o1'], text: 'After review' } },
    }
    act(() => f.result.current.setComposer('Ordinary draft'))
    act(() => expect(f.result.current.history.setDecisionDraft?.(decision)).toBe(true))
    const changed = {
      ...decision,
      reference: { ...decision.reference, runId: crypto.randomUUID() },
    }
    act(() => expect(f.result.current.history.setDecisionDraft?.(changed)).toBe(false))
    f.rerender({ selected: undefined })
    f.rerender({ selected: f.page().sessionId })
    await waitFor(() => expect(f.result.current.history.decisionDraft).toEqual(decision))
    expect(f.result.current.composer).toBe('Ordinary draft')
    act(() => expect(f.result.current.history.clearDecisionDraft?.(true)).toBe(true))
    expect(f.result.current.history.decisionDraft).toBeUndefined()
    expect(f.result.current.composer).toContain('Ordinary draft\n\n**1. Delivery?**')
    expect(f.result.current.composer).toContain('**Your answer:**\n\n- Queue')
    expect(f.result.current.composer).toContain('After review')
  } finally {
    f.unmount()
    f.client.clear()
  }
})

it.each([true, false])(
  'sends only decision answers and preserves the ordinary draft (acknowledged: %s)',
  async (acknowledged) => {
    const f = historyFixture()
    try {
      await waitFor(() => expect(f.result.current.snapshot).toBeDefined())
      const decision = {
        reference: {
          taskId: crypto.randomUUID(),
          runId: crypto.randomUUID(),
          decisionInputSequence: 1,
          expectedInputSequence: 1,
        },
        questions: [
          { id: 'q1', prompt: 'Delivery?', selection: 'single' as const },
          {
            id: 'q2',
            prompt: 'Keep boundaries/*?',
            selection: 'single' as const,
            options: [{ id: 'keep', label: 'Keep _rules_', description: 'Use `ESLint`' }],
          },
        ],
        answers: {
          q1: { optionIds: [], text: 'After review' },
          q2: { optionIds: ['keep'], text: '' },
        },
      }
      const send = vi.fn<DesktopBridge['sendConversationMessage']>().mockResolvedValue(
        acknowledged
          ? {
              ok: true,
              value: {
                version: 'conversation-patch-v1',
                sessionId: f.page().sessionId,
                observation: { ...f.page().observation, sequence: 2 },
                session: f.page().header.session,
                messages: [],
                activities: [],
                runs: [],
                activityStates: [],
              },
            }
          : { ok: false, error: { code: 'CONFLICT', message: 'Request changed.' } },
      )
      window.pact.sendConversationMessage = send
      act(() => f.result.current.setComposer('Unsent ordinary draft'))
      act(() => expect(f.result.current.history.setDecisionDraft?.(decision)).toBe(true))
      await act(async () =>
        expect(
          await f.result.current.send(
            'Unsent ordinary draft',
            [crypto.randomUUID()],
            { type: 'agent', agentId: 'claude' },
            [],
            decision,
          ),
        ).toBe(acknowledged),
      )
      expect(send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          replyToDecision: decision.reference,
          content:
            '**Replies to your questions**\n\n**1. Delivery?**\n\n**Your answer:**\n\n\nAfter review\n\n**2. Keep boundaries/\\*?**\n\n**Your answer:**\n\n- Keep \\_rules\\_ — Use \\`ESLint\\`',
          freezeDrafts: false,
          commentIds: [],
        }),
      )
      expect(send.mock.calls[0]?.[0]).not.toHaveProperty('route')
      expect(send.mock.calls[0]?.[0]).not.toHaveProperty('imageIds')
      expect(f.result.current.composer).toBe('Unsent ordinary draft')
      expect(f.result.current.history.decisionDraft).toEqual(acknowledged ? undefined : decision)
    } finally {
      f.unmount()
      f.client.clear()
    }
  },
)

it('freezes the user information with Send and preserves a declaration-only edit across its ACK', async () => {
  const f = historyFixture()
  await waitFor(() => expect(f.result.current.snapshot).toBeDefined())
  await waitFor(() =>
    expect(f.getConversation).toHaveBeenCalledWith(expect.objectContaining({ scope: 'drafts' })),
  )
  let acknowledge!: (value: Awaited<ReturnType<DesktopBridge['sendConversationMessage']>>) => void
  const send = vi.fn<DesktopBridge['sendConversationMessage']>(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve
      }),
  )
  window.pact.sendConversationMessage = send
  const declaration = {
    version: 'user-information-v1' as const,
    id: crypto.randomUUID(),
    kind: 'user_supplied_value' as const,
    question: 'What launch date should be used?',
    input: 'text' as const,
    options: [],
    state: { status: 'unanswered' as const },
  }
  act(() => {
    f.result.current.setComposer('Keep the original request.')
    f.result.current.setComposerUserInformation(declaration)
  })
  let submitted!: Promise<boolean>
  act(() => {
    submitted = f.result.current.send('Keep the original request.', [])
  })
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  expect(send.mock.calls[0]![0].userInformation).toEqual(declaration)
  act(() => {
    f.result.current.setComposerUserInformation({
      ...declaration,
      question: 'Which launch region should be used?',
    })
  })
  await act(async () => {
    acknowledge({
      ok: true,
      value: {
        version: 'conversation-patch-v1',
        sessionId: f.page().sessionId,
        observation: { incarnation: f.page().observation.incarnation, sequence: 2 },
        session: f.page().header.session,
        messages: [],
        activities: [],
        runs: [],
        activityStates: [],
      },
    })
    expect(await submitted).toBe(true)
  })
  expect(f.result.current.composer).toBe('Keep the original request.')
  expect(f.result.current.composerUserInformation?.question).toBe(
    'Which launch region should be used?',
  )
})

it.each(['valid question', ''])(
  'sends collaboration answers while preserving an ordinary declaration (%s)',
  async (question) => {
    const f = historyFixture()
    await waitFor(() => expect(f.result.current.snapshot).toBeDefined())
    const declaration = {
      version: 'user-information-v1' as const,
      id: crypto.randomUUID(),
      kind: 'user_supplied_value' as const,
      question,
      input: 'text' as const,
      options: [],
      state: { status: 'unanswered' as const },
    }
    const decision = {
      reference: {
        taskId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        decisionInputSequence: 1,
        expectedInputSequence: 1,
      },
      questions: [{ id: 'q1', prompt: 'Which delivery?', selection: 'single' as const }],
      answers: { q1: { optionIds: [], text: 'After review' } },
    }
    const send = vi.fn<DesktopBridge['sendConversationMessage']>().mockResolvedValue({
      ok: true,
      value: {
        version: 'conversation-patch-v1',
        sessionId: f.page().sessionId,
        observation: { ...f.page().observation, sequence: 2 },
        session: f.page().header.session,
        messages: [],
        activities: [],
        runs: [],
        activityStates: [],
      },
    })
    window.pact.sendConversationMessage = send
    act(() => {
      f.result.current.setComposer('Untouched ordinary draft')
      f.result.current.setComposerUserInformation(declaration)
    })
    act(() => expect(f.result.current.history.setDecisionDraft?.(decision)).toBe(true))
    await act(async () =>
      expect(
        await f.result.current.send('Untouched ordinary draft', [], undefined, [], decision),
      ).toBe(true),
    )
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).not.toHaveProperty('userInformation')
    expect(f.result.current.composerUserInformation).toEqual(declaration)
    expect(f.result.current.composer).toBe('Untouched ordinary draft')
  },
)

function informationCancellationCard(
  sessionId: string,
  declaration: import('@pact/contracts').UserInformationDeclaration,
): import('@pact/contracts').RelaySchedulingDecision {
  return {
    version: 'relay-decision-v2',
    sessionId,
    decisionId: crypto.randomUUID(),
    revision: 0,
    handoffId: 'a'.repeat(64),
    title: 'One detail',
    reason: 'Reserved by you.',
    consequence: 'Cancel returns to draft.',
    sources: [{ id: 'input', label: 'Current request' }],
    request: {
      category: 'necessary_information',
      consumer: {
        kind: 'prepared_input_clarification',
        batchId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        requestFingerprint: 'b'.repeat(64),
        sourceFingerprint: 'c'.repeat(64),
        defaultAgentId: 'codex',
      },
      field: {
        fieldId: declaration.id,
        prompt: declaration.question,
        input: { kind: 'text', maxLength: 1024 },
      },
    },
  }
}

it.each(['body only', 'declaration ABA'] as const)(
  'keeps an uncertain Cancel across Session changes, checks without resending, and preserves %s edits',
  async (edit) => {
    const f = historyFixture(),
      sessionId = f.page().sessionId
    await waitFor(() => expect(f.result.current.snapshot).toBeDefined())
    const declaration = {
        version: 'user-information-v1' as const,
        id: crypto.randomUUID(),
        kind: 'user_supplied_value' as const,
        question: 'Which date?',
        input: 'text' as const,
        options: [],
        state: { status: 'unanswered' as const },
      },
      card = informationCancellationCard(sessionId, declaration)
    act(() => {
      f.result.current.setComposer('Original draft')
      f.result.current.setComposerUserInformation(declaration)
    })
    const staleFlow = f.result.current
    let acknowledge!: (value: Awaited<ReturnType<DesktopBridge['answerRelayDecision']>>) => void,
      receipt!: (value: Awaited<ReturnType<DesktopBridge['getRelayDecisionReceipt']>>) => void
    const answer = vi.fn<DesktopBridge['answerRelayDecision']>(
        () =>
          new Promise((done) => {
            acknowledge = done
          }),
      ),
      read = vi
        .fn<DesktopBridge['getRelayDecisionReceipt']>()
        .mockResolvedValueOnce({
          ok: false,
          error: { code: 'UNCERTAIN', message: 'Receipt temporarily unavailable.' },
        })
        .mockImplementation(
          () =>
            new Promise((done) => {
              receipt = done
            }),
        ),
      send = vi
        .fn<DesktopBridge['sendConversationMessage']>()
        .mockImplementation(async (input) => ({
          ok: true,
          value: {
            version: 'conversation-patch-v1',
            sessionId: input.sessionId,
            observation: { ...f.page().observation, sequence: 8 },
            session: { ...f.page().header.session, id: input.sessionId },
            messages: [],
            activities: [],
            runs: [],
            activityStates: [],
          },
        }))
    window.pact.answerRelayDecision = answer
    window.pact.getRelayDecisionReceipt = read
    window.pact.sendConversationMessage = send
    let cancel!: Promise<boolean>
    act(() => {
      cancel = f.result.current.history.cancelPreparedInformation!(card)
    })
    await act(async () => expect(await staleFlow.send('Original draft', [])).toBe(false))
    expect(send).not.toHaveBeenCalled()
    act(() => f.deliver(2, [], { relaySchedulingDecision: null }))
    await act(async () => {
      acknowledge({
        ok: false,
        error: {
          code: edit === 'declaration ABA' ? 'INTERNAL' : 'TIMEOUT',
          message: 'Cancel acknowledgement lost.',
        },
      })
      expect(await cancel).toBe(false)
    })
    expect(f.result.current.history.informationCancellation).toMatchObject({
      request: card,
      status: 'receipt_unconfirmed',
    })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
    const originalGet = f.getConversation.getMockImplementation()!
    f.getConversation.mockImplementation(async (input) => {
      const response = await originalGet(input)
      if (!response.ok || input.sessionId === sessionId) return response
      if (response.value.scope === 'messages')
        return {
          ok: true,
          value: {
            ...response.value,
            sessionId: input.sessionId,
            header: {
              ...response.value.header,
              session: { ...response.value.header.session, id: input.sessionId },
            },
          },
        }
      return { ok: true, value: { ...response.value, sessionId: input.sessionId } }
    })
    const other = crypto.randomUUID()
    f.rerender({ selected: other })
    await waitFor(() => expect(f.result.current.snapshot?.sessionId).toBe(other))
    expect(f.result.current.history.informationCancellation).toBeUndefined()
    act(() => f.result.current.setComposer('Other Session draft'))
    await act(async () => expect(await f.result.current.send('Other Session draft', [])).toBe(true))
    expect(send).toHaveBeenCalledTimes(1)
    f.rerender({ selected: sessionId })
    await waitFor(() => expect(f.result.current.snapshot?.sessionId).toBe(sessionId))
    expect(f.result.current.history.informationCancellation?.request).toEqual(card)
    act(() => {
      f.result.current.setComposer('Current edited draft')
      if (edit === 'declaration ABA') {
        f.result.current.setComposerUserInformation({ ...declaration, question: 'Which region?' })
        f.result.current.setComposerUserInformation(declaration)
      }
    })
    let checking!: Promise<boolean>
    act(() => {
      checking = f.result.current.history.checkInformationCancellation!()
    })
    await act(async () =>
      expect(await f.result.current.history.checkInformationCancellation!()).toBe(false),
    )
    await act(async () =>
      expect(await f.result.current.send('Current edited draft', [])).toBe(false),
    )
    const operation = answer.mock.calls[0]![0]
    await act(async () => {
      receipt({
        ok: true,
        value: {
          sessionId,
          decisionId: card.decisionId,
          clientOperationId: operation.clientOperationId,
          disposition: 'cancelled',
          runId: null,
          rebuildId: null,
        },
      })
      expect(await checking).toBe(true)
    })
    expect(f.result.current.history.informationCancellation).toBeUndefined()
    expect(f.result.current.composer).toBe('Current edited draft')
    expect(f.result.current.composerUserInformation).toEqual(
      edit === 'declaration ABA' ? declaration : undefined,
    )
    expect(answer).toHaveBeenCalledTimes(1)
    expect(read.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        { sessionId, decisionId: card.decisionId, clientOperationId: operation.clientOperationId },
      ]),
    )
    await act(async () =>
      expect(await f.result.current.history.cancelPreparedInformation!(card)).toBe(false),
    )
    await act(async () =>
      expect(await f.result.current.send('Current edited draft', [])).toBe(true),
    )
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.at(-1)![0]).toMatchObject({ sessionId, content: 'Current edited draft' })
    expect(send.mock.calls.at(-1)![0].userInformation).toEqual(
      edit === 'declaration ABA' ? declaration : undefined,
    )
  },
)

it('a verified pre-mutation Cancel conflict preserves the declaration without inventing a cancellation', async () => {
  const f = historyFixture(),
    sessionId = f.page().sessionId
  await waitFor(() => expect(f.result.current.snapshot).toBeDefined())
  const declaration = {
      version: 'user-information-v1' as const,
      id: crypto.randomUUID(),
      kind: 'user_supplied_value' as const,
      question: 'Which date?',
      input: 'text' as const,
      options: [],
      state: { status: 'unanswered' as const },
    },
    answer = vi.fn<DesktopBridge['answerRelayDecision']>().mockResolvedValue({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'The original decision already changed before cancellation.',
      },
    }),
    read = vi.fn<DesktopBridge['getRelayDecisionReceipt']>()
  window.pact.answerRelayDecision = answer
  window.pact.getRelayDecisionReceipt = read
  act(() => {
    f.result.current.setComposer('Keep this draft')
    f.result.current.setComposerUserInformation(declaration)
  })
  await act(async () =>
    expect(
      await f.result.current.history.cancelPreparedInformation!(
        informationCancellationCard(sessionId, declaration),
      ),
    ).toBe(false),
  )
  expect(answer).toHaveBeenCalledTimes(1)
  expect(read).not.toHaveBeenCalled()
  expect(f.result.current.history.informationCancellation).toBeUndefined()
  expect(f.result.current.history.cancelledInformationDecisionId).toBeUndefined()
  expect(f.result.current.composerUserInformation).toEqual(declaration)
  expect(f.result.current.composer).toBe('Keep this draft')
  expect(f.onNotice).toHaveBeenCalledWith(
    'The original decision already changed before cancellation.',
  )
})

it.each(['body', 'declaration ABA'] as const)(
  'terminal Cancel retires an uncertain original Send and sends the current %s draft with a new nonce',
  async (edit) => {
    const f = historyFixture(),
      sessionId = f.page().sessionId
    await waitFor(() => expect(f.result.current.snapshot).toBeDefined())
    const declaration = {
      version: 'user-information-v1' as const,
      id: crypto.randomUUID(),
      kind: 'user_supplied_value' as const,
      question: 'Which date?',
      input: 'text' as const,
      options: [],
      state: { status: 'unanswered' as const },
    }
    const send = vi.fn<DesktopBridge['sendConversationMessage']>().mockResolvedValue({
      ok: false,
      error: { code: 'UNCERTAIN', message: 'Original Send acknowledgement lost.' },
    })
    window.pact.sendConversationMessage = send
    act(() => {
      f.result.current.setComposer('Original request')
      f.result.current.setComposerUserInformation(declaration)
    })
    await act(async () => expect(await f.result.current.send('Original request', [])).toBe(false))
    const first = send.mock.calls[0]![0],
      card = informationCancellationCard(sessionId, declaration)
    if (card.request.category !== 'necessary_information')
      throw Error('Expected information decision')
    card.request.consumer.clientMessageId = first.clientMessageId
    act(() => f.deliver(2, [], { relaySchedulingDecision: card }))
    let acknowledge!: (value: Awaited<ReturnType<DesktopBridge['answerRelayDecision']>>) => void
    const cancel = vi.fn<DesktopBridge['answerRelayDecision']>(
      () =>
        new Promise((done) => {
          acknowledge = done
        }),
    )
    window.pact.answerRelayDecision = cancel
    let cancelled!: Promise<boolean>
    act(() => {
      cancelled = f.result.current.history.cancelPreparedInformation!(card)
    })
    act(() => {
      f.result.current.setComposer('Current edited request')
      if (edit === 'declaration ABA') {
        f.result.current.setComposerUserInformation({ ...declaration, question: 'Which region?' })
        f.result.current.setComposerUserInformation(declaration)
      }
    })
    await act(async () => {
      acknowledge({
        ok: true,
        value: {
          sessionId,
          decisionId: card.decisionId,
          clientOperationId: cancel.mock.calls[0]![0].clientOperationId,
          disposition: 'cancelled',
          runId: null,
          rebuildId: null,
        },
      })
      expect(await cancelled).toBe(true)
    })
    expect(f.result.current.composer).toBe('Current edited request')
    expect(f.result.current.composerUserInformation).toEqual(
      edit === 'declaration ABA' ? declaration : undefined,
    )
    send.mockResolvedValueOnce({
      ok: true,
      value: {
        version: 'conversation-patch-v1',
        sessionId,
        observation: { ...f.page().observation, sequence: 3 },
        session: f.page().header.session,
        messages: [],
        activities: [],
        runs: [],
        activityStates: [],
      },
    })
    await act(async () =>
      expect(await f.result.current.send('Current edited request', [])).toBe(true),
    )
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![0]).toMatchObject({ sessionId, content: 'Current edited request' })
    expect(send.mock.calls[1]![0].clientMessageId).not.toBe(first.clientMessageId)
    expect(send.mock.calls[1]![0].userInformation).toEqual(
      edit === 'declaration ABA' ? declaration : undefined,
    )
  },
)

it.each(['held ACK', 'error ACK'] as const)(
  'Cancel releases an in-flight Send, and its late %s cannot retire the newer uncertain request',
  async (late) => {
    const f = historyFixture(),
      sessionId = f.page().sessionId
    await waitFor(() => expect(f.result.current.snapshot).toBeDefined())
    const declaration = {
      version: 'user-information-v1' as const,
      id: crypto.randomUUID(),
      kind: 'user_supplied_value' as const,
      question: 'Which date?',
      input: 'text' as const,
      options: [],
      state: { status: 'unanswered' as const },
    }
    let acknowledge!: (value: Awaited<ReturnType<DesktopBridge['sendConversationMessage']>>) => void
    const send = vi
      .fn<DesktopBridge['sendConversationMessage']>()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            acknowledge = done
          }),
      )
      .mockResolvedValue({
        ok: false,
        error: { code: 'UNCERTAIN', message: 'New Send acknowledgement lost.' },
      })
    window.pact.sendConversationMessage = send
    act(() => {
      f.result.current.setComposer('Original request')
      f.result.current.setComposerUserInformation(declaration)
    })
    let firstSend!: Promise<boolean>
    act(() => {
      firstSend = f.result.current.send('Original request', [])
    })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const first = send.mock.calls[0]![0],
      card = informationCancellationCard(sessionId, declaration)
    if (card.request.category !== 'necessary_information')
      throw Error('Expected information decision')
    card.request.consumer.clientMessageId = first.clientMessageId
    act(() => f.deliver(2, [], { relaySchedulingDecision: card }))
    window.pact.answerRelayDecision = vi.fn<DesktopBridge['answerRelayDecision']>(
      async (input) => ({
        ok: true,
        value: {
          sessionId,
          decisionId: card.decisionId,
          clientOperationId: input.clientOperationId,
          disposition: 'cancelled',
          runId: null,
          rebuildId: null,
        },
      }),
    )
    await act(async () =>
      expect(await f.result.current.history.cancelPreparedInformation!(card)).toBe(true),
    )
    expect(f.result.current.sending).toBe(false)
    act(() => f.result.current.setComposer('New request'))
    await act(async () => expect(await f.result.current.send('New request', [])).toBe(false))
    expect(send).toHaveBeenCalledTimes(2)
    const second = send.mock.calls[1]![0]
    expect(second.clientMessageId).not.toBe(first.clientMessageId)
    await act(async () => {
      acknowledge(
        late === 'held ACK'
          ? {
              ok: true,
              value: {
                version: 'conversation-patch-v1',
                sessionId,
                observation: { ...f.page().observation, sequence: 2 },
                session: f.page().header.session,
                messages: [],
                activities: [],
                runs: [],
                activityStates: [],
                sendDisposition: 'held_for_information',
              },
            }
          : { ok: false, error: { code: 'UNCERTAIN', message: 'Late original error.' } },
      )
      await firstSend
    })
    expect(f.result.current.composer).toBe('New request')
    act(() => f.result.current.setComposer('Different third request'))
    await act(async () =>
      expect(await f.result.current.send('Different third request', [])).toBe(false),
    )
    expect(send).toHaveBeenCalledTimes(2)
    act(() => f.result.current.setComposer('New request'))
    await act(async () => expect(await f.result.current.send('New request', [])).toBe(false))
    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls[2]![0].clientMessageId).toBe(second.clientMessageId)
  },
)

it('confirmed Cancel preserves a different outstanding Send nonce', async () => {
  const f = historyFixture(),
    sessionId = f.page().sessionId
  await waitFor(() => expect(f.result.current.snapshot).toBeDefined())
  const send = vi.fn<DesktopBridge['sendConversationMessage']>().mockResolvedValue({
    ok: false,
    error: { code: 'UNCERTAIN', message: 'Current request is unconfirmed.' },
  })
  window.pact.sendConversationMessage = send
  act(() => f.result.current.setComposer('Different current request'))
  await act(async () =>
    expect(await f.result.current.send('Different current request', [])).toBe(false),
  )
  const currentNonce = send.mock.calls[0]![0].clientMessageId
  const card = informationCancellationCard(sessionId, {
    version: 'user-information-v1',
    id: crypto.randomUUID(),
    kind: 'user_supplied_value',
    question: 'Earlier question?',
    input: 'text',
    options: [],
    state: { status: 'unanswered' },
  })
  window.pact.answerRelayDecision = vi.fn<DesktopBridge['answerRelayDecision']>(async (input) => ({
    ok: true,
    value: {
      sessionId,
      decisionId: card.decisionId,
      clientOperationId: input.clientOperationId,
      disposition: 'cancelled',
      runId: null,
      rebuildId: null,
    },
  }))
  await act(async () =>
    expect(await f.result.current.history.cancelPreparedInformation!(card)).toBe(true),
  )
  expect(f.result.current.composer).toBe('Different current request')
  act(() => f.result.current.setComposer('Must not replace an uncertain different request'))
  await act(async () =>
    expect(await f.result.current.send('Must not replace an uncertain different request', [])).toBe(
      false,
    ),
  )
  expect(send).toHaveBeenCalledTimes(1)
  act(() => f.result.current.setComposer('Different current request'))
  await act(async () =>
    expect(await f.result.current.send('Different current request', [])).toBe(false),
  )
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1]![0].clientMessageId).toBe(currentNonce)
})
