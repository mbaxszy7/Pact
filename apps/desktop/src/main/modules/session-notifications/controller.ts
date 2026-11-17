import { app, Notification } from 'electron'
import { randomUUID } from 'node:crypto'

import type {
  RpcResult,
  SessionNotificationEvent,
  SessionReminder,
  SessionReminderActionResult,
  SessionReminderState,
} from '@pact/contracts'
import type { DiagnosticEvent } from '@pact/contracts/diagnostics'

import { IPC_CHANNELS, sessionReminderStateSchema } from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust'
import type { UtilityProcessClient } from '../../utility-process/client'
import type { NativePresence } from '../native-presence'

const MAX_IN_APP_ITEMS = 32
const MAX_IN_APP_BYTES = 64 * 1024
const MAX_NATIVE_ITEMS = 5
const MAX_BADGE_SESSIONS = 100
const MAX_DEDUPE_IDS = 256
const MAX_DEDUPE_BYTES = 64 * 1024
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000
const REMINDER_TTL_MS = 10 * 60 * 1000
const NATIVE_TTL_MS = 10 * 60 * 1000
const FOREGROUND_HANDOFF_MS = 250

interface PendingReminder {
  primary: SessionReminder
  primaryExpiresAt: number
  secondary?: SessionReminder | undefined
  secondaryExpiresAt?: number | undefined
  secondaryIsLatest?: boolean | undefined
}

interface NativeReminder {
  notification: Notification
  reminder: SessionReminder
  timer: ReturnType<typeof setTimeout>
  expiresAt: number
  closing: boolean
  confirmed: boolean
}

function agentLabel(agentId: SessionReminder['agentId']): string {
  return agentId === 'codex' ? 'Codex' : agentId === 'claude' ? 'Claude Code' : 'Pact'
}

function systemBody(reminder: SessionReminder): string {
  const agent = agentLabel(reminder.agentId)
  return reminder.category === 'needs_input'
    ? `${agent} needs your input`
    : reminder.category === 'failure'
      ? `${agent} could not finish`
      : `${agent} finished a reply`
}

function compareReminders(left: SessionReminder, right: SessionReminder): number {
  return right.priority - left.priority || left.createdAt.localeCompare(right.createdAt)
}

function compareEviction(left: SessionReminder, right: SessionReminder): number {
  return left.priority - right.priority || left.createdAt.localeCompare(right.createdAt)
}

function lowestReminder(items: PendingReminder[]): PendingReminder {
  return items.reduce((candidate, item) =>
    compareEviction(item.primary, candidate.primary) < 0 ? item : candidate,
  )
}

function previewReminder(item: PendingReminder): SessionReminder {
  if (!item.secondary) return item.primary
  return {
    ...item.primary,
    secondaryCategory: item.secondary.category,
    secondaryIsLatest: item.secondaryIsLatest ?? false,
  }
}

function summaryReminder(attention: number, completed: number): SessionReminder {
  const category: SessionReminder['category'] =
    completed > 0 && attention === 0 ? 'completed' : 'needs_input'
  const summaryTarget: NonNullable<SessionReminder['summaryTarget']> =
    completed > 0 ? 'workspace' : 'attention'
  const sessionTitle =
    completed > 0
      ? attention > 0
        ? 'More Session updates'
        : 'More replies are ready'
      : 'More Sessions need attention'
  return {
    id: 'summary:attention',
    sessionId: randomUUID(),
    sessionTitle,
    category,
    priority: 1,
    createdAt: new Date().toISOString(),
    summary: true,
    summaryAttention: Math.min(attention, 999),
    summaryCompleted: Math.min(completed, 999),
    summaryTarget,
  }
}

/**
 * Main-owned delivery policy for Session notifications. Utility owns the event
 * facts; this owner decides system vs. in-app vs. suppression, bounds both
 * channels, and reuses NativePresence for all navigation.
 */
export class SessionNotificationController {
  private readonly pending: PendingReminder[] = []
  private readonly native = new Map<string, NativeReminder>()
  private readonly seen = new Map<string, number>()
  private readonly unreadBackground = new Map<string, number>()
  private readonly unsubscribe: () => void
  private readonly unsubscribeVisibility: () => void
  private readonly recordDiagnostic: ((event: DiagnosticEvent) => void) | undefined
  private readonly pruneTimer: ReturnType<typeof setInterval>
  private foregroundHandoffTimer: ReturnType<typeof setTimeout> | undefined
  private revision = 0
  private disposed = false

  constructor(
    private readonly trust: RendererTrust,
    private readonly utility: UtilityProcessClient,
    private readonly nativePresence: NativePresence,
    private readonly isSessionVisible: (sessionId: string) => boolean,
    options?: {
      subscribeVisibilityChanges?: (listener: () => void) => () => void
      recordDiagnostic?: (event: DiagnosticEvent) => void
    },
  ) {
    this.unsubscribe =
      utility.subscribeSessionNotifications?.((event) => this.observe(event)) ?? (() => undefined)
    this.unsubscribeVisibility =
      options?.subscribeVisibilityChanges?.(() => this.acknowledgeVisibleSessions()) ??
      (() => undefined)
    this.recordDiagnostic = options?.recordDiagnostic
    this.pruneTimer = setInterval(() => this.prune(), 60_000)
  }

  async view(id: string): Promise<RpcResult<SessionReminderActionResult>> {
    const reminder = this.findEvent(id)
    if (!reminder) {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'That Session reminder is no longer available.' },
      }
    }
    if (reminder.summary) {
      this.remove(id, { navigate: false })
      if (reminder.summaryTarget === 'workspace') this.nativePresence.openWorkspace()
      else this.nativePresence.openAttention()
      return { ok: true, value: { accepted: true } }
    }
    const resolved = await this.utility.resolveNativeSession({ sessionId: reminder.sessionId })
    if (!resolved.ok) return { ok: false, error: resolved.error }
    if (resolved.value.session.status === 'archived') {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'That Session is archived and cannot be opened.' },
      }
    }
    this.remove(id, { navigate: true })
    return { ok: true, value: { accepted: true } }
  }

  dismiss(id: string): RpcResult<SessionReminderActionResult> {
    if (!this.findEvent(id)) {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'That Session reminder is no longer available.' },
      }
    }
    this.remove(id, { navigate: false })
    return { ok: true, value: { accepted: true } }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.unsubscribeVisibility()
    this.clearForegroundHandoff()
    clearInterval(this.pruneTimer)
    for (const entry of this.native.values()) {
      entry.closing = true
      clearTimeout(entry.timer)
      try {
        entry.notification.close()
      } catch {
        // A closed native notification is already released.
      }
    }
    this.native.clear()
    this.pending.length = 0
    this.seen.clear()
    this.unreadBackground.clear()
    this.nativePresence.setNotificationBadgeCount(0)
  }

  private observe(event: SessionNotificationEvent): void {
    if (this.disposed) return
    if (event.kind === 'revoke') {
      this.revoke(event.id)
      return
    }
    if (this.isSeen(event.id)) return
    this.markSeen(event.id)
    const reminder: SessionReminder = {
      id: event.id,
      sessionId: event.sessionId,
      sessionTitle: event.sessionTitle,
      ...(event.agentId ? { agentId: event.agentId } : {}),
      category: event.category,
      priority: event.priority,
      createdAt: event.createdAt,
    }

    if (
      this.isSessionVisible(reminder.sessionId) &&
      this.nativePresence.isWindowFocused() &&
      this.nativePresence.isWindowVisible() &&
      this.nativePresence.isWindowUsable()
    )
      return

    if (
      this.nativePresence.isWindowUsable() &&
      this.nativePresence.isWindowFocused() &&
      this.nativePresence.isWindowVisible()
    ) {
      this.enqueue(reminder)
      return
    }
    this.markUnreadBackground(reminder.sessionId)
    this.syncNotificationBadge()
    this.showNative(reminder)
  }

  private enqueue(reminder: SessionReminder, expiresAt = Date.now() + REMINDER_TTL_MS): void {
    const now = Date.now()
    const expired = this.dropExpired(now)
    if (expiresAt <= now) {
      if (expired) this.publish()
      return
    }
    const existing = this.pending.find(
      (item) => !item.primary.summary && item.primary.sessionId === reminder.sessionId,
    )
    if (existing) {
      if (existing.primary.priority > reminder.priority) {
        existing.secondary = reminder
        existing.secondaryExpiresAt = expiresAt
        existing.secondaryIsLatest = true
      } else {
        existing.secondary = existing.primary
        existing.secondaryExpiresAt = existing.primaryExpiresAt
        existing.secondaryIsLatest = false
        existing.primary = reminder
        existing.primaryExpiresAt = expiresAt
      }
    } else {
      this.addPending(reminder, expiresAt)
    }
    this.pending.sort((left, right) => compareReminders(left.primary, right.primary))
    this.enforcePendingByteBudget()
    this.pending.sort((left, right) => compareReminders(left.primary, right.primary))
    this.publish()
  }

  private enforcePendingByteBudget(): void {
    while (Buffer.byteLength(JSON.stringify(this.pending), 'utf8') > MAX_IN_APP_BYTES) {
      const removable = this.pending.filter((item) => !item.primary.summary)
      if (removable.length === 0) break
      const lowest = lowestReminder(removable)
      this.pending.splice(this.pending.indexOf(lowest), 1)
      this.addSummary(this.overflowEvents(lowest))
    }
  }

  private addPending(reminder: SessionReminder, expiresAt: number): void {
    if (this.pending.length < MAX_IN_APP_ITEMS) {
      this.pending.push({ primary: reminder, primaryExpiresAt: expiresAt })
      return
    }
    const summary = this.summaryItem()
    const removable = this.pending.filter((item) => !item.primary.summary)
    if (removable.length === 0) return
    const lowest = lowestReminder(removable)
    if (reminder.priority < lowest.primary.priority) {
      if (summary) {
        this.addSummary([reminder])
      } else {
        this.pending.splice(this.pending.indexOf(lowest), 1)
        this.addSummary([...this.overflowEvents(lowest), reminder])
      }
      return
    }

    this.pending.splice(this.pending.indexOf(lowest), 1)
    const overflow = this.overflowEvents(lowest)
    if (!summary) {
      const remaining = removable.filter((item) => item !== lowest)
      const secondLowest = remaining.length > 0 ? lowestReminder(remaining) : undefined
      if (secondLowest) {
        this.pending.splice(this.pending.indexOf(secondLowest), 1)
        overflow.push(...this.overflowEvents(secondLowest))
      }
    }
    this.addSummary(overflow)
    this.pending.push({ primary: reminder, primaryExpiresAt: expiresAt })
  }

  private overflowEvents(item: PendingReminder): SessionReminder[] {
    const now = Date.now()
    return [
      item.primary,
      ...(item.secondary && (item.secondaryExpiresAt ?? 0) > now ? [item.secondary] : []),
    ]
  }

  private addSummary(events: SessionReminder[]): void {
    let attention = 0
    let completed = 0
    for (const event of events) {
      if (event.category === 'completed') completed += 1
      else attention += 1
    }
    if (attention + completed === 0) return
    const existing = this.summaryItem()
    if (existing) {
      attention += existing.primary.summaryAttention ?? 0
      completed += existing.primary.summaryCompleted ?? 0
      existing.primary = summaryReminder(attention, completed)
      existing.primaryExpiresAt = Date.now() + REMINDER_TTL_MS
      return
    }
    this.pending.push({
      primary: summaryReminder(attention, completed),
      primaryExpiresAt: Date.now() + REMINDER_TTL_MS,
    })
  }

  private summaryItem(): PendingReminder | undefined {
    return this.pending.find((item) => item.primary.summary)
  }

  private showNative(reminder: SessionReminder): void {
    if (!Notification.isSupported()) {
      this.recordDiagnostic?.({
        operation: 'app',
        phase: 'blocked',
        level: 'warn',
        runtimeBoundary: 'native_notification',
        sessionId: reminder.sessionId,
        ...(reminder.agentId ? { agentId: reminder.agentId } : {}),
      })
      this.enqueue(reminder)
      return
    }

    const sameSession = [...this.native.values()].find(
      (entry) => entry.reminder.sessionId === reminder.sessionId,
    )
    if (sameSession) {
      if (sameSession.reminder.priority > reminder.priority) {
        this.enqueue(reminder)
        return
      }
      this.closeNative(sameSession, true)
    }

    if (this.native.size >= MAX_NATIVE_ITEMS) {
      const lowest = [...this.native.values()].reduce((candidate, entry) =>
        compareEviction(entry.reminder, candidate.reminder) < 0 ? entry : candidate,
      )
      if (reminder.priority < lowest.reminder.priority) {
        this.enqueue(reminder)
        return
      }
      this.closeNative(lowest, true)
    }

    let entry: NativeReminder | undefined
    try {
      const notification = new Notification({
        title: app.getName(),
        body: systemBody(reminder),
        silent: false,
      })
      const expiresAt = Date.now() + NATIVE_TTL_MS
      entry = {
        notification,
        reminder,
        expiresAt,
        timer: setTimeout(
          () => {
            if (entry) this.closeNative(entry, false)
          },
          Math.max(0, expiresAt - Date.now()),
        ),
        closing: false,
        confirmed: false,
      }
      notification.on('click', () => {
        if (!entry) return
        entry.confirmed = true
        this.unreadBackground.delete(reminder.sessionId)
        this.closeNative(entry, false)
        this.syncNotificationBadge()
        this.nativePresence.navigate(reminder.sessionId)
      })
      notification.on('close', () => {
        if (!entry || entry.closing) return
        entry.closing = true
        entry.confirmed = true
        clearTimeout(entry.timer)
        this.native.delete(entry.reminder.id)
        if (!this.hasActiveReminderForSession(entry.reminder.sessionId)) {
          this.unreadBackground.delete(entry.reminder.sessionId)
          this.syncNotificationBadge()
        }
      })
      notification.on('failed', () => {
        if (!entry) return
        this.recordDiagnostic?.({
          operation: 'app',
          phase: 'failed',
          level: 'warn',
          runtimeBoundary: 'native_notification',
          sessionId: reminder.sessionId,
          ...(reminder.agentId ? { agentId: reminder.agentId } : {}),
        })
        this.closeNative(entry, true)
      })
      this.native.set(reminder.id, entry)
      notification.show()
    } catch {
      this.recordDiagnostic?.({
        operation: 'app',
        phase: 'failed',
        level: 'warn',
        runtimeBoundary: 'native_notification',
        sessionId: reminder.sessionId,
        ...(reminder.agentId ? { agentId: reminder.agentId } : {}),
      })
      if (entry) {
        clearTimeout(entry.timer)
        this.native.delete(entry.reminder.id)
      }
      this.enqueue(reminder)
    }
  }

  private acknowledgeVisibleSessions(): void {
    if (
      this.disposed ||
      !this.nativePresence.isWindowUsable() ||
      !this.nativePresence.isWindowVisible() ||
      !this.nativePresence.isWindowFocused()
    ) {
      this.clearForegroundHandoff()
      return
    }

    for (const entry of this.native.values()) {
      if (this.isSessionVisible(entry.reminder.sessionId)) this.closeNative(entry, false)
    }

    let pendingChanged = false
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const item = this.pending[index]!
      if (item.primary.summary || !this.isSessionVisible(item.primary.sessionId)) continue
      this.pending.splice(index, 1)
      pendingChanged = true
    }
    if (pendingChanged) this.publish()

    for (const sessionId of this.unreadBackground.keys()) {
      if (this.isSessionVisible(sessionId)) this.unreadBackground.delete(sessionId)
    }
    this.syncNotificationBadge()

    if (
      (this.native.size > 0 || this.unreadBackground.size > 0) &&
      this.foregroundHandoffTimer === undefined
    ) {
      this.foregroundHandoffTimer = setTimeout(() => {
        this.foregroundHandoffTimer = undefined
        if (
          this.disposed ||
          !this.nativePresence.isWindowUsable() ||
          !this.nativePresence.isWindowVisible() ||
          !this.nativePresence.isWindowFocused()
        )
          return
        for (const entry of this.native.values()) this.closeNative(entry, true)
        for (const sessionId of this.unreadBackground.keys()) {
          if (this.isSessionVisible(sessionId) || !this.hasActiveReminderForSession(sessionId))
            this.unreadBackground.delete(sessionId)
        }
        this.syncNotificationBadge()
      }, FOREGROUND_HANDOFF_MS)
    }
  }

  private closeNative(entry: NativeReminder, queueIfUnconfirmed: boolean): void {
    if (!this.native.has(entry.reminder.id)) return
    entry.closing = true
    this.native.delete(entry.reminder.id)
    clearTimeout(entry.timer)
    try {
      entry.notification.close()
    } catch {
      // The OS may already have discarded the notification.
    }
    if (queueIfUnconfirmed && !entry.confirmed) this.enqueue(entry.reminder, entry.expiresAt)
  }

  private findEvent(id: string): SessionReminder | undefined {
    for (const item of this.pending) {
      if (item.primary.id === id) return item.primary
      if (item.secondary?.id === id) return item.secondary
    }
    return this.native.get(id)?.reminder
  }

  private revoke(id: string): void {
    const native = this.native.get(id)
    if (native) {
      const targetSessionId = native.reminder.sessionId
      this.closeNative(native, false)
      this.reconcileUnreadAfterRemoval(targetSessionId, false)
      this.syncNotificationBadge()
      this.publish()
      return
    }
    const index = this.pending.findIndex(
      (item) => item.primary.id === id || item.secondary?.id === id,
    )
    if (index < 0) return
    const item = this.pending[index]!
    const targetSessionId =
      item.primary.id === id ? item.primary.sessionId : item.secondary?.sessionId
    const wasSummary = Boolean(item.primary.summary)
    if (item.primary.id === id) {
      if (item.secondary && (item.secondaryExpiresAt ?? 0) > Date.now()) {
        item.primary = item.secondary
        item.primaryExpiresAt = item.secondaryExpiresAt!
        item.secondary = undefined
        item.secondaryExpiresAt = undefined
        item.secondaryIsLatest = undefined
      } else {
        this.pending.splice(index, 1)
      }
    } else {
      item.secondary = undefined
      item.secondaryExpiresAt = undefined
      item.secondaryIsLatest = undefined
    }
    this.pending.sort((left, right) => compareReminders(left.primary, right.primary))
    this.reconcileUnreadAfterRemoval(targetSessionId, wasSummary)
    this.syncNotificationBadge()
    this.publish()
  }

  private remove(id: string, { navigate }: { navigate: boolean }): void {
    const native = this.native.get(id)
    if (native) this.closeNative(native, false)
    const index = this.pending.findIndex(
      (item) => item.primary.id === id || item.secondary?.id === id,
    )
    const item = index >= 0 ? this.pending[index] : undefined
    if (index >= 0) this.pending.splice(index, 1)
    const reminder = native?.reminder ?? item?.primary ?? item?.secondary
    const targetSessionId = reminder?.sessionId
    const wasSummary = Boolean(item?.primary.summary)
    if (navigate && reminder) this.nativePresence.navigate(reminder.sessionId)
    if (navigate && reminder && !reminder.summary) this.unreadBackground.delete(reminder.sessionId)
    else this.reconcileUnreadAfterRemoval(targetSessionId, wasSummary)
    this.syncNotificationBadge()
    this.publish()
  }

  private markUnreadBackground(sessionId: string): void {
    this.unreadBackground.delete(sessionId)
    this.unreadBackground.set(sessionId, Date.now())
    while (this.unreadBackground.size > MAX_BADGE_SESSIONS) {
      const oldest = this.unreadBackground.keys().next().value
      if (oldest === undefined) break
      this.unreadBackground.delete(oldest)
    }
  }

  private hasActiveReminderForSession(sessionId: string): boolean {
    for (const entry of this.native.values()) {
      if (entry.reminder.sessionId === sessionId) return true
    }
    for (const item of this.pending) {
      if (item.primary.summary || item.primary.sessionId === sessionId) return true
    }
    return false
  }

  private reconcileUnreadAfterRemoval(sessionId: string | undefined, wasSummary: boolean): void {
    if (wasSummary) {
      for (const candidate of this.unreadBackground.keys()) {
        if (!this.hasActiveReminderForSession(candidate)) this.unreadBackground.delete(candidate)
      }
      return
    }
    if (sessionId && !this.hasActiveReminderForSession(sessionId))
      this.unreadBackground.delete(sessionId)
  }

  private syncNotificationBadge(): void {
    this.nativePresence.setNotificationBadgeCount(this.disposed ? 0 : this.unreadBackground.size)
  }

  private clearForegroundHandoff(): void {
    if (this.foregroundHandoffTimer === undefined) return
    clearTimeout(this.foregroundHandoffTimer)
    this.foregroundHandoffTimer = undefined
  }

  private isSeen(id: string): boolean {
    const seenAt = this.seen.get(id)
    if (seenAt === undefined) return false
    if (Date.now() - seenAt <= DEDUPE_TTL_MS) return true
    this.seen.delete(id)
    return false
  }

  private seenBytes(): number {
    let bytes = 0
    for (const id of this.seen.keys()) bytes += Buffer.byteLength(id, 'utf8') + 16
    return bytes
  }

  private markSeen(id: string): void {
    this.seen.delete(id)
    this.seen.set(id, Date.now())
    while (this.seen.size > MAX_DEDUPE_IDS || this.seenBytes() > MAX_DEDUPE_BYTES) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
  }

  private dropExpired(now: number): boolean {
    let changed = false
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const item = this.pending[index]!
      if (item.primaryExpiresAt <= now) {
        if (item.secondary && (item.secondaryExpiresAt ?? 0) > now) {
          item.primary = item.secondary
          item.primaryExpiresAt = item.secondaryExpiresAt!
          item.secondary = undefined
          item.secondaryExpiresAt = undefined
          item.secondaryIsLatest = undefined
        } else {
          this.pending.splice(index, 1)
        }
        changed = true
      } else if (item.secondary && (item.secondaryExpiresAt ?? 0) <= now) {
        item.secondary = undefined
        item.secondaryExpiresAt = undefined
        item.secondaryIsLatest = undefined
        changed = true
      }
    }
    if (changed) this.pending.sort((left, right) => compareReminders(left.primary, right.primary))
    return changed
  }

  private prune(): void {
    if (this.disposed) return
    const now = Date.now()
    const pendingChanged = this.dropExpired(now)
    for (const [id, seenAt] of this.seen) {
      if (now - seenAt > DEDUPE_TTL_MS) this.seen.delete(id)
    }
    const foregroundActive =
      this.nativePresence.isWindowUsable() &&
      this.nativePresence.isWindowVisible() &&
      this.nativePresence.isWindowFocused()
    for (const [sessionId, createdAt] of this.unreadBackground) {
      if (
        now - createdAt > DEDUPE_TTL_MS ||
        (foregroundActive &&
          (this.isSessionVisible(sessionId) || !this.hasActiveReminderForSession(sessionId)))
      )
        this.unreadBackground.delete(sessionId)
    }
    this.syncNotificationBadge()
    if (pendingChanged) this.publish()
  }

  private publish(): void {
    if (this.disposed) return
    this.revision += 1
    const current = this.pending[0]
    const state: SessionReminderState = sessionReminderStateSchema.parse({
      revision: this.revision,
      current: current ? previewReminder(current) : null,
      pending: this.pending.length,
    })
    for (const window of this.trust.trustedWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send(IPC_CHANNELS.sessionReminderChanged, state)
    }
  }
}
