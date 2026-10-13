import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { IPC_CHANNELS, type ConversationPatch, type RpcResult } from '@pact/contracts'

import { createRendererTrust } from '../../renderer-trust'
import { createUtilityProcessClient, type UtilityProcessClient } from '../../utility-process/client'
import { registerConversationIpcHandlers } from './ipc'

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  windows: new Map<object, unknown>(),
}))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: (sender: object) => harness.windows.get(sender) },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      harness.handlers.set(channel, handler),
    removeHandler: (channel: string) => harness.handlers.delete(channel),
  },
}))
const ready: RpcResult<{ ready: true }> = { ok: true, value: { ready: true } }
const timedOut: RpcResult<{ ready: true }> = {
  ok: false,
  error: { code: 'TIMEOUT', message: 'Interest propagation timed out.' },
}
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0).toReversed()) dispose()
  vi.restoreAllMocks()
  harness.handlers.clear()
  harness.windows.clear()
})
class Contents extends EventEmitter {
  nativeEvents = new EventEmitter()
  visible = true
  minimized = false
  mainFrame = { url: 'app://bundle/index.html' }
  destroyed = false
  getURL() {
    return this.mainFrame.url
  }
  isDestroyed() {
    return this.destroyed
  }
  send = vi.fn<(channel: string, ...args: unknown[]) => void>()
}
function fixture() {
  const trust = createRendererTrust({ isPackaged: true })
  const client = createUtilityProcessClient()
  const update = vi.spyOn(client, 'setConversationInterests').mockResolvedValue(ready)
  let publish: Parameters<UtilityProcessClient['subscribeConversation']>[0] | undefined
  vi.spyOn(client, 'subscribeConversation').mockImplementation((listener) => {
    publish = listener
    return () => {
      publish = undefined
    }
  })
  const dispose = registerConversationIpcHandlers(trust, client)
  disposers.push(dispose)
  const viewer = () => {
    const contents = new Contents(),
      windowEvents = contents.nativeEvents
    const window = {
      webContents: contents,
      isDestroyed: () => false,
      isVisible: () => contents.visible,
      isMinimized: () => contents.minimized,
      on: windowEvents.on.bind(windowEvents),
      removeListener: windowEvents.removeListener.bind(windowEvents),
      once: windowEvents.once.bind(windowEvents),
    }
    harness.windows.set(contents, window)
    disposers.push(trust.registerWindow(window))
    return contents
  }
  const select = (sender: Contents, sessionId: string | null, generation: number) => {
    const handler = harness.handlers.get(IPC_CHANNELS.conversationInterest)
    if (!handler) throw new Error('Interest handler missing')
    return handler({ sender, senderFrame: sender.mainFrame }, { sessionId, generation })
  }
  return {
    client,
    update,
    viewer,
    select,
    dispose,
    publish: (value: ConversationPatch, progress: boolean) => {
      if (!publish) throw new Error('Publisher missing')
      publish(value, progress)
    },
  }
}
function patch(sessionId: string): ConversationPatch {
  const timestamp = new Date().toISOString()
  return {
    version: 'conversation-patch-v1',
    sessionId,
    observation: { incarnation: randomUUID(), sequence: 2 },
    session: {
      id: sessionId,
      title: 'Session',
      titleSource: 'local',
      status: 'discussing',
      activity: { state: 'agent_working', agentId: 'codex', attemptCount: 1 },
      hasUnread: false,
      updatedAt: timestamp,
    },
    messages: [
      {
        mode: 'replace',
        text: 'Transcript body',
        hasActivities: false,
        hasComments: false,
        message: {
          id: randomUUID(),
          sessionId,
          role: 'assistant',
          agentId: 'codex',
          sequence: 1,
          contentRevision: 0,
          state: 'streaming',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    ],
    runs: [],
    activities: [],
    activityStates: [],
  }
}
describe('Conversation interest IPC owner', () => {
  it('routes inactive fork status without copying transcript or private lineage receipts', async () => {
    const f = fixture(),
      sender = f.viewer(),
      child = randomUUID()
    await f.select(sender, randomUUID(), 1)
    const value = patch(child)
    value.forkBlocked = true
    value.forkOperation = {
      id: randomUUID(),
      sessionId: child,
      sourceSessionId: randomUUID(),
      sourceMessageId: randomUUID(),
      sourceSequence: 4,
      revision: 2,
      ready: false,
      sides: [
        {
          agentId: 'claude',
          state: 'ready',
          nativeSessionId: 'claude-child',
          canInitialize: false,
          canContinue: false,
        },
        {
          agentId: 'codex',
          state: 'unconfirmed',
          reason: 'Candidate needs confirmation',
          canInitialize: false,
          canContinue: false,
        },
      ],
    }
    // Unknown private fields are not a valid cross-process envelope.
    expect(() =>
      f.publish(
        { ...value, witness: { prefix: 'private-native-history' } } as ConversationPatch,
        false,
      ),
    ).toThrow(/Unrecognized key/u)
    expect(sender.send).not.toHaveBeenCalled()
    f.publish(value, false)
    expect(sender.send).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.conversationChanged,
      expect.objectContaining({
        forkOperation: value.forkOperation,
        forkBlocked: true,
        messages: [],
        activities: [],
        runs: [],
      }),
    )
    const serialized = JSON.stringify(sender.send.mock.calls)
    expect(serialized).not.toContain('Transcript body')
    expect(serialized).not.toContain('witness')
  })
  it('validates named Fork commands behind trusted main-frame access and releases their handler', async () => {
    const f = fixture(),
      sender = f.viewer()
    const fork = vi
      .spyOn(f.client, 'forkSession')
      .mockResolvedValue({ ok: true, value: { kind: 'state', operation: null } })
    const invoke = harness.handlers.get(IPC_CHANNELS.sessionFork)!
    const input = { action: 'prepare', sourceSessionId: randomUUID(), messageId: randomUUID() }
    await expect(invoke({ sender, senderFrame: sender.mainFrame }, input)).resolves.toEqual({
      ok: true,
      value: { kind: 'state', operation: null },
    })
    expect(fork).toHaveBeenCalledExactlyOnceWith(input)
    for (const invalid of [
      { ...input, witness: {} },
      { ...input, action: 'rebuild' },
      { action: 'create', sourceSessionId: input.sourceSessionId },
      { action: 'check', sessionId: randomUUID(), operationId: randomUUID(), agentId: 'unknown' },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Check each independent invalid envelope before disposal.
      await expect(
        invoke({ sender, senderFrame: sender.mainFrame }, invalid),
      ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    }
    expect(() => invoke({ sender, senderFrame: { url: sender.mainFrame.url } }, input)).toThrow(
      'Rejected IPC request from a non-main frame.',
    )
    const unregistered = new Contents()
    expect(() =>
      invoke({ sender: unregistered, senderFrame: unregistered.mainFrame }, input),
    ).toThrow('Rejected IPC request from an unregistered or inactive window.')
    expect(fork).toHaveBeenCalledOnce()
    f.dispose()
    expect(harness.handlers.has(IPC_CHANNELS.sessionFork)).toBe(false)
  })
  it.each(['hide', 'minimize'] as const)(
    'suppresses %s progress and restores the same interest',
    async (event) => {
      const f = fixture(),
        sender = f.viewer(),
        id = randomUUID()
      await f.select(sender, id, 1)
      sender.visible = event !== 'hide'
      sender.minimized = event === 'minimize'
      sender.nativeEvents.emit(event)
      await Promise.resolve()
      await Promise.resolve()
      expect(f.update).toHaveBeenLastCalledWith([], expect.any(Number))
      f.publish(patch(id), true)
      expect(sender.send).not.toHaveBeenCalled()
      sender.visible = true
      sender.minimized = false
      sender.nativeEvents.emit(event === 'hide' ? 'show' : 'restore')
      await Promise.resolve()
      await Promise.resolve()
      expect(f.update).toHaveBeenLastCalledWith([id], expect.any(Number))
      f.publish(patch(id), true)
      expect(sender.send).toHaveBeenCalledOnce()
      sender.emit('render-process-gone')
      for (const name of ['hide', 'show', 'minimize', 'restore'])
        expect(sender.nativeEvents.listenerCount(name)).toBe(0)
    },
  )
  it('returns interests and owned listeners to baseline across 100 document reloads', async () => {
    const f = fixture(),
      sender = f.viewer()
    for (let index = 0; index < 100; index++) {
      // oxlint-disable-next-line no-await-in-loop -- Each lifecycle is fully established before release.
      await f.select(sender, randomUUID(), 1)
      sender.emit('did-start-navigation', {}, 'app://bundle/index.html', false, true)
      // oxlint-disable-next-line no-await-in-loop -- Settle this release before the next document.
      await Promise.resolve()
      // oxlint-disable-next-line no-await-in-loop -- Drain the single propagation continuation.
      await Promise.resolve()
      expect(sender.eventNames()).toEqual([])
      expect(f.update).toHaveBeenLastCalledWith([], expect.any(Number))
    }
  })
  it('retains user message identity as a body-free late send ACK for uninterested documents', async () => {
    const f = fixture(),
      sender = f.viewer(),
      source = randomUUID()
    await f.select(sender, randomUUID(), 1)
    const value = patch(source)
    value.messages[0]!.message.role = 'user'
    delete value.messages[0]!.message.agentId
    f.publish(value, false)
    expect(sender.send).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.conversationChanged,
      expect.objectContaining({
        messages: [
          expect.objectContaining({ mode: 'metadata', message: value.messages[0]!.message }),
        ],
      }),
    )
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('Transcript body')
  })
  it('serializes terminal clearing after an in-flight interest update', async () => {
    const f = fixture(),
      sender = f.viewer(),
      first = Promise.withResolvers<RpcResult<{ ready: true }>>()
    f.update.mockReturnValueOnce(first.promise)
    const update = f.select(sender, randomUUID(), 1)
    f.dispose()
    expect(f.update).toHaveBeenCalledTimes(1)
    first.resolve(ready)
    await update
    expect(f.update).toHaveBeenCalledTimes(2)
    expect(f.update).toHaveBeenLastCalledWith([], expect.any(Number))
  })
  it.each(['destroyed', 'render-process-gone', 'navigation'] as const)(
    'propagates release after the pending update fails during %s',
    async (event) => {
      const f = fixture(),
        sender = f.viewer(),
        id = randomUUID(),
        first = Promise.withResolvers<RpcResult<{ ready: true }>>()
      f.update.mockReturnValueOnce(first.promise)
      const pending = f.select(sender, id, 1)
      if (event === 'navigation')
        sender.emit('did-start-navigation', {}, 'app://bundle/index.html', false, true)
      else sender.emit(event)
      expect(f.update).toHaveBeenCalledTimes(1)
      first.resolve(timedOut)
      await expect(pending).resolves.toEqual(ready)
      expect(f.update.mock.calls.map(([ids]) => ids)).toEqual([[id], []])
      expect(sender.eventNames()).toEqual([])
    },
  )
  it('propagates only the latest replacement after an older update fails', async () => {
    const f = fixture(),
      sender = f.viewer(),
      a = randomUUID(),
      b = randomUUID(),
      first = Promise.withResolvers<RpcResult<{ ready: true }>>()
    f.update.mockReturnValueOnce(first.promise)
    const one = f.select(sender, a, 1),
      two = f.select(sender, b, 2)
    expect(f.update).toHaveBeenCalledTimes(1)
    first.resolve(timedOut)
    await expect(Promise.all([one, two])).resolves.toEqual([ready, ready])
    expect(f.update.mock.calls.map(([ids]) => ids)).toEqual([[a], [b]])
  })
  it('settles a failed latest update without retrying unchanged state', async () => {
    const f = fixture(),
      sender = f.viewer(),
      first = Promise.withResolvers<RpcResult<{ ready: true }>>()
    f.update.mockReturnValueOnce(first.promise).mockResolvedValueOnce(timedOut)
    const one = f.select(sender, randomUUID(), 1),
      two = f.select(sender, randomUUID(), 2)
    first.resolve(timedOut)
    await expect(Promise.all([one, two])).resolves.toEqual([timedOut, timedOut])
    expect(f.update).toHaveBeenCalledTimes(2)
  })
  it('keeps the original chain deadline when a newer interest follows a failure', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const f = fixture(),
      sender = f.viewer(),
      first = Promise.withResolvers<RpcResult<{ ready: true }>>()
    f.update.mockReturnValueOnce(first.promise)
    const one = f.select(sender, randomUUID(), 1),
      two = f.select(sender, randomUUID(), 2)
    now = 10_000
    first.resolve(timedOut)
    await expect(Promise.all([one, two])).resolves.toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'TIMEOUT' }) }),
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'TIMEOUT' }) }),
    ])
    expect(f.update).toHaveBeenCalledTimes(1)
  })
  it('clears terminal interest after an in-flight update fails', async () => {
    const f = fixture(),
      sender = f.viewer(),
      id = randomUUID(),
      first = Promise.withResolvers<RpcResult<{ ready: true }>>()
    f.update.mockReturnValueOnce(first.promise)
    const pending = f.select(sender, id, 1)
    f.dispose()
    expect(f.update).toHaveBeenCalledTimes(1)
    first.resolve(timedOut)
    await expect(pending).resolves.toEqual(ready)
    expect(f.update.mock.calls.map(([ids]) => ids)).toEqual([[id], []])
  })
  it('routes progress only to interested documents and sends other documents header-only facts', async () => {
    const f = fixture(),
      a = f.viewer(),
      b = f.viewer(),
      aId = randomUUID(),
      bId = randomUUID()
    await f.select(a, aId, 1)
    await f.select(b, bId, 1)
    const value = patch(aId)
    f.publish(value, true)
    expect(a.send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.conversationChanged, value)
    expect(b.send).not.toHaveBeenCalled()
    f.publish(value, false)
    expect(b.send).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.conversationChanged,
      expect.objectContaining({ session: value.session, messages: [], activities: [], runs: [] }),
    )
  })
  it('coalesces rapid replacements behind one ACK and ignores an old cleanup generation', async () => {
    const f = fixture(),
      sender = f.viewer(),
      a = randomUUID(),
      b = randomUUID()
    const first = Promise.withResolvers<RpcResult<{ ready: true }>>()
    f.update.mockReturnValueOnce(first.promise)
    const one = f.select(sender, a, 1),
      two = f.select(sender, b, 2),
      stale = f.select(sender, null, 1)
    expect(f.update).toHaveBeenCalledTimes(1)
    first.resolve(ready)
    await Promise.all([one, two, stale])
    expect(f.update.mock.calls.map(([ids]) => ids)).toEqual([[a], [b]])
    f.publish(patch(a), true)
    expect(sender.send).not.toHaveBeenCalled()
    f.publish(patch(b), true)
    expect(sender.send).toHaveBeenCalledOnce()
  })
  it.each(['destroyed', 'render-process-gone', 'navigation'] as const)(
    'releases %s interest, listeners and permits a fresh document generation',
    async (event) => {
      const f = fixture(),
        sender = f.viewer()
      await f.select(sender, randomUUID(), 9)
      if (event === 'navigation')
        sender.emit('did-start-navigation', {}, 'app://bundle/index.html', false, true)
      else sender.emit(event)
      await Promise.resolve()
      await Promise.resolve()
      expect(f.update).toHaveBeenLastCalledWith([], expect.any(Number))
      expect(
        sender.listenerCount('destroyed') +
          sender.listenerCount('render-process-gone') +
          sender.listenerCount('did-start-navigation'),
      ).toBe(0)
      const next = randomUUID()
      await f.select(sender, next, 1)
      expect(f.update).toHaveBeenLastCalledWith([next], expect.any(Number))
    },
  )
  it('ignores subframe/in-place navigation and removes all interests on disposal', async () => {
    const f = fixture(),
      sender = f.viewer(),
      sessionId = randomUUID()
    await f.select(sender, sessionId, 1)
    sender.emit('did-start-navigation', {}, 'app://bundle/index.html', false, false)
    sender.emit('did-start-navigation', {}, 'app://bundle/index.html', true, true)
    expect(f.update).toHaveBeenCalledTimes(1)
    f.dispose()
    expect(f.update).toHaveBeenLastCalledWith([], expect.any(Number))
    expect(sender.eventNames()).toEqual([])
  })
  it('rejects invalid input and excessive document owners without expanding the interest set', async () => {
    const f = fixture()
    await expect(f.select(f.viewer(), 'bad-session', 1)).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    })
    // oxlint-disable-next-line no-await-in-loop -- Establish each acknowledged owner before testing capacity.
    for (let i = 0; i < 8; i++) await f.select(f.viewer(), randomUUID(), 1)
    const before = f.update.mock.calls.length
    await expect(f.select(f.viewer(), randomUUID(), 1)).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    })
    expect(f.update.mock.calls.length).toBe(before)
  })
})
