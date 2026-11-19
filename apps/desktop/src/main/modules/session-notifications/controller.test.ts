import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DiagnosticEvent } from '@pact/contracts/diagnostics'

import {
  IPC_CHANNELS,
  type SessionNotificationEvent,
  type SessionReminderState,
} from '@pact/contracts'

import type { UtilityProcessClient } from '../../utility-process/client.js'
import type { NativePresence } from '../native-presence.js'

import { createRendererTrust, type TrustedIpcEvent } from '../../renderer-trust.js'
import { SessionNotificationController } from './controller.js'
import { registerSessionNotificationIpcHandlers } from './ipc.js'

interface FakeNotificationInstance {
  readonly options: { title: string; body: string; silent?: boolean }
  showCount: number
  closeCount: number
  emit(event: string | symbol, ...args: unknown[]): boolean
}

const harness = vi.hoisted(() => ({
  supported: true,
  throwOnShow: false,
  instances: [] as FakeNotificationInstance[],
  handlers: new Map<string, (event: TrustedIpcEvent, input?: unknown) => unknown>(),
}))

vi.mock('electron', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('node:events')

  class FakeNotification extends NodeEventEmitter implements FakeNotificationInstance {
    readonly options: { title: string; body: string; silent?: boolean }
    showCount = 0
    closeCount = 0

    constructor(options: { title: string; body: string; silent?: boolean }) {
      super()
      this.options = options
      harness.instances.push(this)
    }

    static isSupported(): boolean {
      return harness.supported
    }

    show(): void {
      if (harness.throwOnShow) throw new Error('Notification blocked')
      this.showCount += 1
    }

    close(): void {
      this.closeCount += 1
    }
  }

  return {
    app: { getName: () => 'Pact' },
    Notification: FakeNotification,
    ipcMain: {
      handle: (channel: string, listener: (event: TrustedIpcEvent, input?: unknown) => unknown) =>
        harness.handlers.set(channel, listener),
      removeHandler: (channel: string) => harness.handlers.delete(channel),
    },
  }
})

function createEvent(overrides: {
  id?: string
  sessionId?: string
  sessionTitle?: string
  agentId?: 'codex' | 'claude' | 'agy'
  category?: 'needs_input' | 'failure' | 'completed'
  createdAt?: string
}): SessionNotificationEvent {
  const category = overrides.category ?? 'completed'
  const priority = category === 'needs_input' ? 3 : category === 'failure' ? 2 : 1
  return {
    kind: 'raise',
    id: overrides.id ?? `evt:${randomUUID()}`,
    sessionId: overrides.sessionId ?? randomUUID(),
    sessionTitle: overrides.sessionTitle ?? 'Sensitive Project Title',
    ...(overrides.agentId ? { agentId: overrides.agentId } : {}),
    category,
    priority,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  }
}

function createFixture() {
  const visibleSessions = new Set<string>()
  let windowUsable = true
  let windowFocused = true
  let windowVisible = true
  let notifyListener: ((event: SessionNotificationEvent) => void) | undefined
  let visibilityListener: (() => void) | undefined
  const badgeCounts: number[] = []
  const navigated: string[] = []
  const openedAttention: number[] = []
  const openedWorkspace: number[] = []
  const diagnostics: DiagnosticEvent[] = []

  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: {
      mainFrame: { url: 'app://bundle/index.html' },
      getURL: () => 'app://bundle/index.html',
      isDestroyed: () => false,
      send: vi.fn<(channel: string, payload: SessionReminderState) => void>(),
    },
  })
  const trust = createRendererTrust({ isPackaged: true })
  const unregisterWindow = trust.registerWindow(window)

  const resolveNativeSession = vi.fn<UtilityProcessClient['resolveNativeSession']>(
    async ({ sessionId }) => ({
      ok: true,
      value: {
        kind: 'change',
        revision: 1,
        session: {
          id: sessionId,
          projectId: randomUUID(),
          title: 'Resolved Session',
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    }),
  )

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test double implements the UtilityProcessClient notification and session-resolution surface.
  const utility = {
    subscribeSessionNotifications: vi.fn<
      NonNullable<UtilityProcessClient['subscribeSessionNotifications']>
    >((listener) => {
      notifyListener = listener
      return () => {
        notifyListener = undefined
      }
    }),
    resolveNativeSession,
  } as unknown as UtilityProcessClient

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test double implements the NativePresence visibility, badge, and navigation surface.
  const nativePresence = {
    isWindowUsable: () => windowUsable,
    isWindowFocused: () => windowFocused,
    isWindowVisible: () => windowVisible,
    setNotificationBadgeCount: vi.fn<(count: number) => void>((count) => {
      badgeCounts.push(count)
    }),
    navigate: vi.fn<(sessionId: string) => void>((sessionId) => {
      navigated.push(sessionId)
    }),
    openAttention: vi.fn<() => void>(() => {
      openedAttention.push(1)
    }),
    openWorkspace: vi.fn<() => void>(() => {
      openedWorkspace.push(1)
    }),
  } as unknown as NativePresence

  const controller = new SessionNotificationController(
    trust,
    utility,
    nativePresence,
    (sessionId) => visibleSessions.has(sessionId),
    {
      subscribeVisibilityChanges: (listener) => {
        visibilityListener = listener
        return () => {
          visibilityListener = undefined
        }
      },
      recordDiagnostic: (event) => {
        diagnostics.push(event)
      },
    },
  )
  const disposeIpc = registerSessionNotificationIpcHandlers(trust, controller)

  const ipcEvent: TrustedIpcEvent = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  }

  return {
    controller,
    trust,
    window,
    ipcEvent,
    visibleSessions,
    diagnostics,
    badgeCounts,
    navigated,
    openedAttention,
    openedWorkspace,
    resolveNativeSession,
    nativePresence,
    setWindowState(next: { usable?: boolean; focused?: boolean; visible?: boolean }) {
      if (next.usable !== undefined) windowUsable = next.usable
      if (next.focused !== undefined) windowFocused = next.focused
      if (next.visible !== undefined) windowVisible = next.visible
      visibilityListener?.()
    },
    emit(event: SessionNotificationEvent) {
      if (!notifyListener) throw new Error('Controller did not subscribe to notifications.')
      notifyListener(event)
    },
    lastPublished(): SessionReminderState | undefined {
      return window.webContents.send.mock.calls.at(-1)?.[1]
    },
    invoke(channel: string, raw: unknown) {
      const handler = harness.handlers.get(channel)
      if (!handler) throw new Error(`Missing handler for ${channel}`)
      return handler(ipcEvent, raw)
    },
    dispose() {
      disposeIpc()
      controller.dispose()
      unregisterWindow()
    },
  }
}

beforeEach(() => {
  harness.supported = true
  harness.throwOnShow = false
  harness.instances.length = 0
  harness.handlers.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SessionNotificationController & IPC', () => {
  it('suppresses visible focused Session, enqueues in-app for other focused Sessions, and shows fixed-copy native notifications in background', () => {
    const f = createFixture()
    try {
      const activeSession = randomUUID()
      const otherSession = randomUUID()
      f.visibleSessions.add(activeSession)

      // Visible & focused target session is suppressed silently.
      f.emit(createEvent({ sessionId: activeSession, agentId: 'codex', category: 'completed' }))
      expect(f.window.webContents.send).not.toHaveBeenCalled()
      expect(harness.instances).toHaveLength(0)
      expect(f.badgeCounts).toEqual([])

      // Different session while focused & visible goes to in-app reminder.
      const inAppEvent = createEvent({
        sessionId: otherSession,
        sessionTitle: 'Background Chat',
        agentId: 'claude',
        category: 'needs_input',
      })
      f.emit(inAppEvent)
      expect(harness.instances).toHaveLength(0)
      expect(f.lastPublished()).toMatchObject({
        revision: 1,
        pending: 1,
        current: {
          id: inAppEvent.id,
          sessionId: otherSession,
          sessionTitle: 'Background Chat',
          category: 'needs_input',
          agentId: 'claude',
        },
      })

      // Unfocused window shows native notification with Pact identity and fixed copy (no titles/content).
      f.setWindowState({ focused: false })
      const bgSession = randomUUID()
      f.emit(
        createEvent({
          sessionId: bgSession,
          sessionTitle: 'Private Secret Repo',
          agentId: 'codex',
          category: 'failure',
        }),
      )
      expect(harness.instances).toHaveLength(1)
      expect(harness.instances[0]!.options).toEqual({
        title: 'Pact',
        body: 'Codex could not finish',
        silent: false,
      })
      expect(harness.instances[0]!.options.body).not.toContain('Private Secret Repo')
      expect(f.badgeCounts.at(-1)).toBe(1)
    } finally {
      f.dispose()
    }
  })

  it('deduplicates stable event IDs and applies priority coalescing and revocation', () => {
    const f = createFixture()
    try {
      const sessionA = randomUUID()
      const completeEvt = createEvent({
        id: 'evt:dup-1',
        sessionId: sessionA,
        agentId: 'codex',
        category: 'completed',
        createdAt: '2026-11-16T10:00:00.000Z',
      })
      f.emit(completeEvt)
      // Duplicate ID is ignored.
      f.emit(completeEvt)
      expect(f.window.webContents.send).toHaveBeenCalledTimes(1)

      // Higher priority promotes to primary and keeps previous as secondaryCategory.
      const failEvt = createEvent({
        id: 'evt:fail-1',
        sessionId: sessionA,
        agentId: 'codex',
        category: 'failure',
        createdAt: '2026-11-16T10:00:05.000Z',
      })
      f.emit(failEvt)
      expect(f.lastPublished()?.current).toMatchObject({
        id: 'evt:fail-1',
        category: 'failure',
        secondaryCategory: 'completed',
        secondaryIsLatest: false,
      })

      // Lower priority does not replace unconfirmed higher priority; updates secondary with secondaryIsLatest.
      const needsEvt = createEvent({
        id: 'evt:needs-1',
        sessionId: sessionA,
        agentId: 'codex',
        category: 'needs_input',
        createdAt: '2026-11-16T10:00:10.000Z',
      })
      f.emit(needsEvt)
      const secondCompleteEvt = createEvent({
        id: 'evt:comp-2',
        sessionId: sessionA,
        agentId: 'codex',
        category: 'completed',
        createdAt: '2026-11-16T10:00:15.000Z',
      })
      f.emit(secondCompleteEvt)
      expect(f.lastPublished()?.current).toMatchObject({
        id: 'evt:needs-1',
        category: 'needs_input',
        secondaryCategory: 'completed',
        secondaryIsLatest: true,
      })

      // Revoking primary promotes surviving secondary.
      f.emit({ kind: 'revoke', id: 'evt:needs-1', sessionId: sessionA })
      expect(f.lastPublished()?.current).toMatchObject({
        id: 'evt:comp-2',
        category: 'completed',
      })
      f.emit({ kind: 'revoke', id: 'evt:comp-2', sessionId: sessionA })
      expect(f.lastPublished()?.current).toBeNull()
      expect(f.lastPublished()?.pending).toBe(0)
    } finally {
      f.dispose()
    }
  })

  it('auto-clears reminders when viewing the session and hands unconfirmed native reminders to foreground after 250ms', async () => {
    vi.useFakeTimers()
    const f = createFixture()
    try {
      const sessionA = randomUUID()
      const sessionB = randomUUID()
      f.setWindowState({ focused: false })

      f.emit(
        createEvent({ id: 'bg-a', sessionId: sessionA, agentId: 'codex', category: 'needs_input' }),
      )
      f.emit(
        createEvent({ id: 'bg-b', sessionId: sessionB, agentId: 'claude', category: 'completed' }),
      )
      expect(harness.instances).toHaveLength(2)
      expect(f.badgeCounts.at(-1)).toBe(2)

      // Focus returns with sessionA visible: sessionA clears immediately, sessionB hands off to foreground after 250ms.
      f.visibleSessions.add(sessionA)
      f.setWindowState({ focused: true })
      expect(harness.instances[0]!.closeCount).toBe(1)
      expect(f.badgeCounts.at(-1)).toBe(1)
      expect(f.lastPublished()?.current ?? null).toBeNull()

      await vi.advanceTimersByTimeAsync(250)
      expect(harness.instances[1]!.closeCount).toBe(1)
      expect(f.badgeCounts.at(-1)).toBe(1)
      expect(f.lastPublished()).toMatchObject({
        pending: 1,
        current: { id: 'bg-b', sessionId: sessionB, category: 'completed' },
      })

      // Switching visibility to sessionB auto-clears sessionB's foreground reminder and badge.
      f.visibleSessions.delete(sessionA)
      f.visibleSessions.add(sessionB)
      f.setWindowState({ focused: true })
      expect(f.lastPublished()).toMatchObject({ current: null, pending: 0 })
      expect(f.badgeCounts.at(-1)).toBe(0)
    } finally {
      f.dispose()
    }
  })

  it('falls back to in-app queue when native notifications are unsupported or fail, and bounds capacity to 5 native / 32 in-app with summary overflow', () => {
    const f = createFixture()
    try {
      f.setWindowState({ focused: false })
      harness.supported = false
      f.emit(createEvent({ id: 'unsupported-1', category: 'failure', agentId: 'claude' }))
      expect(f.diagnostics).toMatchObject([
        { operation: 'app', phase: 'blocked', runtimeBoundary: 'native_notification' },
      ])
      expect(f.lastPublished()?.current?.id).toBe('unsupported-1')

      // Native failure event falls back to in-app queue.
      harness.supported = true
      f.emit(createEvent({ id: 'failed-native', category: 'needs_input', agentId: 'codex' }))
      const nativeInstance = harness.instances.at(-1)!
      nativeInstance.emit('failed')
      expect(f.diagnostics.at(-1)).toMatchObject({
        operation: 'app',
        phase: 'failed',
        runtimeBoundary: 'native_notification',
      })
      expect(f.lastPublished()?.current?.id).toBe('failed-native')

      // Clear in-app items, then fill > 5 native notifications (completed evicted to in-app).
      f.controller.dismiss('unsupported-1')
      f.controller.dismiss('failed-native')
      const lowNative = createEvent({ id: 'nat-low', category: 'completed' })
      f.emit(lowNative)
      for (let index = 0; index < 5; index += 1) {
        f.emit(createEvent({ id: `nat-high-${index}`, category: 'needs_input' }))
      }
      expect(f.lastPublished()?.current?.id).toBe('nat-low')

      // Refocus and exceed 32 in-app reminders to produce summary:attention overflow.
      f.setWindowState({ focused: true })
      for (let index = 0; index < 35; index += 1) {
        f.emit(createEvent({ id: `overflow-${index}`, category: 'completed' }))
      }
      const published = f.lastPublished()!
      expect(published.pending).toBe(32)
      expect(f.controller.dismiss('summary:attention')).toMatchObject({ ok: true })
    } finally {
      f.dispose()
    }
  })

  it('validates IPC view/dismiss payloads, enforces frame trust, prevents archived navigation, and cleans up on dispose', async () => {
    const f = createFixture()
    try {
      const sessionId = randomUUID()
      f.emit(createEvent({ id: 'ipc-evt', sessionId, category: 'needs_input', agentId: 'codex' }))

      // Untrusted non-main frame is rejected.
      expect(() =>
        harness.handlers.get(IPC_CHANNELS.sessionReminderView)!(
          { ...f.ipcEvent, senderFrame: { url: 'app://bundle/index.html' } },
          { id: 'ipc-evt' },
        ),
      ).toThrow('Rejected IPC request from a non-main frame.')

      // Invalid payload fails Zod validation.
      expect(f.invoke(IPC_CHANNELS.sessionReminderView, { id: '' })).toEqual({
        ok: false,
        error: { code: 'VALIDATION', message: 'Choose a current Session reminder.' },
      })
      expect(f.invoke(IPC_CHANNELS.sessionReminderDismiss, { id: 'ipc-evt', extra: true })).toEqual(
        {
          ok: false,
          error: { code: 'VALIDATION', message: 'Choose a current Session reminder.' },
        },
      )

      // Archived session cannot be opened via reminder view.
      f.resolveNativeSession.mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'change',
          revision: 2,
          session: {
            id: sessionId,
            projectId: randomUUID(),
            title: 'Archived',
            titleSource: 'local',
            status: 'archived',
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
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      })
      await expect(f.invoke(IPC_CHANNELS.sessionReminderView, { id: 'ipc-evt' })).resolves.toEqual({
        ok: false,
        error: { code: 'CONFLICT', message: 'That Session is archived and cannot be opened.' },
      })
      expect(f.navigated).toEqual([])

      // Non-archived session resolves, navigates, and clears reminder.
      await expect(f.invoke(IPC_CHANNELS.sessionReminderView, { id: 'ipc-evt' })).resolves.toEqual({
        ok: true,
        value: { accepted: true },
      })
      expect(f.navigated).toEqual([sessionId])
      expect(f.lastPublished()).toMatchObject({ current: null, pending: 0 })

      // Viewing stale/missing reminder returns CONFLICT.
      await expect(f.invoke(IPC_CHANNELS.sessionReminderView, { id: 'ipc-evt' })).resolves.toEqual({
        ok: false,
        error: { code: 'CONFLICT', message: 'That Session reminder is no longer available.' },
      })

      // Overflow summary routes to openWorkspace (completed) or openAttention (attention).
      for (let index = 0; index < 34; index += 1) {
        f.emit(createEvent({ id: `sum-comp-${index}`, category: 'completed' }))
      }
      await expect(
        f.invoke(IPC_CHANNELS.sessionReminderView, { id: 'summary:attention' }),
      ).resolves.toEqual({ ok: true, value: { accepted: true } })
      expect(f.openedWorkspace).toHaveLength(1)

      f.dispose()
      expect(harness.handlers.size).toBe(0)
      expect(f.badgeCounts.at(-1)).toBe(0)
    } finally {
      f.dispose()
    }
  })

  it('uses Antigravity label for agy background desktop notifications', () => {
    const f = createFixture()
    try {
      f.setWindowState({ focused: false })
      f.emit(createEvent({ id: 'agy-1', agentId: 'agy', category: 'needs_input' }))
      expect(harness.instances).toHaveLength(1)
      expect(harness.instances[0]?.options).toEqual({
        title: 'Pact',
        body: 'Antigravity needs your input',
        silent: false,
      })

      f.emit(createEvent({ id: 'agy-2', agentId: 'agy', category: 'completed' }))
      expect(harness.instances.at(-1)?.options).toEqual({
        title: 'Pact',
        body: 'Antigravity finished a reply',
        silent: false,
      })
    } finally {
      f.dispose()
    }
  })
})
