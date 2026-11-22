/* oxlint-disable react/exhaustive-effect-dependencies, jsx-a11y/prefer-tag-over-role -- The reminder identity resets closure-owned timer refs; the status container also contains layout blocks and controls. */
import { CircleAlert, CircleCheck, Reply, X } from 'lucide-react'
import { useEffect, useEffectEvent, useRef } from 'react'

import type { SessionReminder as SessionReminderModel } from '@pact/contracts'

const SESSION_REMINDER_DISPLAY_MS = 8_000
const DEFAULT_COMPOSER_CLEARANCE_PX = 188
const COMPOSER_GAP_PX = 12

function statusLabel(category: SessionReminderModel['category']): string {
  return category === 'needs_input'
    ? 'Needs your input'
    : category === 'failure'
      ? 'Failed'
      : 'Finished'
}

function agentLabel(agentId: SessionReminderModel['agentId']): string {
  return agentId === 'codex'
    ? 'Codex'
    : agentId === 'claude'
      ? 'Claude Code'
      : agentId === 'agy'
        ? 'Antigravity'
        : 'Pact'
}

export function SessionReminder({
  reminder,
  pendingCount = 1,
  aboveComposer = false,
  onView,
  onDismiss,
}: {
  reminder: SessionReminderModel
  pendingCount?: number
  aboveComposer?: boolean
  onView: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const remainingRef = useRef(SESSION_REMINDER_DISPLAY_MS)
  const startedAtRef = useRef(0)
  const pausedRef = useRef(false)
  const hoveredRef = useRef(false)
  const focusedRef = useRef(false)
  const dismiss = useEffectEvent(onDismiss)

  const clear = (): void => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    timerRef.current = undefined
  }
  const schedule = (delay: number): void => {
    clear()
    startedAtRef.current = performance.now()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined
      dismiss()
    }, delay)
  }
  useEffect(() => {
    remainingRef.current = SESSION_REMINDER_DISPLAY_MS
    pausedRef.current = false
    hoveredRef.current = false
    focusedRef.current = false
    schedule(SESSION_REMINDER_DISPLAY_MS)
    return clear
  }, [reminder.id])

  useEffect(() => {
    const card = cardRef.current
    if (!aboveComposer || !card) {
      card?.style.removeProperty('bottom')
      return undefined
    }
    const target = document.querySelector('.pact-queued-input')
    const measure = (): void => {
      if (!target) {
        card.style.removeProperty('bottom')
        return
      }
      const rect = target.getBoundingClientRect()
      if (rect.height <= 0) {
        card.style.removeProperty('bottom')
        return
      }
      const maxClearance = Math.max(DEFAULT_COMPOSER_CLEARANCE_PX, window.innerHeight - 120)
      const next = Math.min(
        maxClearance,
        Math.max(
          DEFAULT_COMPOSER_CLEARANCE_PX,
          Math.ceil(window.innerHeight - rect.top + COMPOSER_GAP_PX),
        ),
      )
      card.style.bottom = `${next}px`
    }
    measure()
    const observer =
      target && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined
    if (target && observer) observer.observe(target)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      card.style.removeProperty('bottom')
    }
  }, [aboveComposer, reminder.id])

  const pause = (): void => {
    if (pausedRef.current) return
    pausedRef.current = true
    clear()
    remainingRef.current = Math.max(
      0,
      remainingRef.current - (performance.now() - startedAtRef.current),
    )
  }
  const resume = (): void => {
    if (hoveredRef.current || focusedRef.current) return
    if (!pausedRef.current) return
    pausedRef.current = false
    if (remainingRef.current <= 0) dismiss()
    else schedule(remainingRef.current)
  }
  const enterHover = (): void => {
    hoveredRef.current = true
    pause()
  }
  const leaveHover = (): void => {
    hoveredRef.current = false
    resume()
  }
  const enterFocus = (): void => {
    focusedRef.current = true
    pause()
  }
  const leaveFocus = (): void => {
    focusedRef.current = false
    resume()
  }

  const secondaryCategory = reminder.secondaryCategory
  const summaryParts = reminder.summary
    ? [
        reminder.summaryAttention
          ? `${reminder.summaryAttention} ${reminder.summaryAttention === 1 ? 'needs' : 'need'} attention`
          : undefined,
        reminder.summaryCompleted ? `${reminder.summaryCompleted} completed` : undefined,
      ].filter((part): part is string => Boolean(part))
    : []
  const metadata =
    summaryParts.length > 0
      ? summaryParts.join(' · ')
      : `${agentLabel(reminder.agentId)} · ${statusLabel(reminder.category)}${
          secondaryCategory ? ` · ${statusLabel(secondaryCategory)}` : ''
        }`

  const Icon =
    reminder.category === 'failure'
      ? CircleAlert
      : reminder.category === 'completed'
        ? CircleCheck
        : Reply
  const iconTone =
    reminder.category === 'failure'
      ? 'text-status-danger-foreground'
      : reminder.category === 'completed'
        ? 'text-status-ready-foreground'
        : 'text-status-info-foreground'
  const viewLabel =
    reminder.summaryTarget === 'workspace'
      ? 'View workspace'
      : reminder.summary
        ? 'Review'
        : 'View Session'

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Pointer and focus capture pause the status timer; the nested buttons remain the controls.
    <div
      ref={cardRef}
      className={`pact-session-reminder fixed right-5 z-[80] flex w-[min(24.5rem,calc(100vw-2.5rem))] items-center gap-2.5 rounded-panel border border-border bg-menu-surface py-2.5 pr-2 pl-3 text-caption text-primary shadow-island ${
        aboveComposer ? 'bottom-[11.75rem]' : 'bottom-5'
      }`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-session-reminder={reminder.category}
      onMouseEnter={enterHover}
      onMouseLeave={leaveHover}
      onFocusCapture={enterFocus}
      onBlurCapture={leaveFocus}
    >
      <Icon
        aria-hidden="true"
        className={`pact-reminder-icon-pop mt-0.5 size-4 shrink-0 self-start ${iconTone}`}
        strokeWidth={1.75}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="min-w-0 flex-1 truncate font-medium leading-snug text-primary">
            {reminder.sessionTitle}
          </p>
          {!reminder.summary && pendingCount > 1 ? (
            <span
              key={pendingCount}
              className="pact-reminder-badge shrink-0 rounded-pill border border-border bg-surface-muted px-1.5 py-0.5 text-caption font-medium leading-none text-secondary tabular-nums"
              aria-label={`${pendingCount - 1} more pending`}
            >
              +{pendingCount - 1 > 98 ? '99+' : pendingCount - 1}
            </span>
          ) : null}
        </div>
        <p className="truncate leading-snug text-secondary">{metadata}</p>
      </div>
      <button
        className="pact-pressable h-7 shrink-0 rounded-lg px-2.5 font-medium text-secondary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
        type="button"
        onClick={onView}
      >
        {viewLabel}
      </button>
      <button
        className="pact-pressable grid size-7 shrink-0 place-items-center rounded-lg text-tertiary hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
        type="button"
        aria-label="Dismiss Session reminder"
        onClick={onDismiss}
      >
        <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  )
}
