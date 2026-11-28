import { Gauge, RefreshCw } from 'lucide-react'
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  ProviderUsageProvider,
  ProviderUsageSnapshot,
  ProviderUsageStatus,
  ProviderUsageWindow,
} from '@pact/contracts'

import { isUsageSnapshotStale, useProviderUsage } from './useProviderUsage'

const PROVIDERS: readonly { id: ProviderUsageProvider; label: string }[] = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'agy', label: 'Antigravity' },
]

type PopoverMode = 'closed' | 'compact' | 'detailed'

const HOVER_OPEN_DELAY_MS = 70
const HOVER_CLOSE_DELAY_MS = 140

type ResolvedUsageWindow = ProviderUsageWindow & { usedPercent: number }

function hasUsageWindow(window: ProviderUsageWindow | null): window is ResolvedUsageWindow {
  return window !== null && window.usedPercent !== null
}

function effectiveStatus(snapshot: ProviderUsageSnapshot, nowMs: number): ProviderUsageStatus {
  return isUsageSnapshotStale(snapshot, nowMs) ? 'stale' : snapshot.status
}

function snapshotWindows(snapshot: ProviderUsageSnapshot): Array<ProviderUsageWindow | null> {
  if (snapshot.pools?.length) {
    return snapshot.pools.flatMap((pool) => [pool.fiveHour, pool.sevenDay])
  }
  return [snapshot.fiveHour, snapshot.sevenDay]
}

function shouldShowWindows(snapshot: ProviderUsageSnapshot, status: ProviderUsageStatus): boolean {
  return (
    snapshotWindows(snapshot).some((window) => hasUsageWindow(window)) &&
    status !== 'unauthenticated' &&
    status !== 'not_applicable' &&
    status !== 'unsupported' &&
    status !== 'close_unconfirmed' &&
    !(status === 'unavailable' && !snapshot.identityConfirmed)
  )
}

function isSilentLoading(snapshot: ProviderUsageSnapshot, status: ProviderUsageStatus): boolean {
  return (
    !shouldShowWindows(snapshot, status) &&
    (status === 'loading' || status === 'idle' || status === 'busy' || status === 'cancelling')
  )
}

function formatResetTime(timestamp: string, nowMs: number): string {
  const targetMs = Date.parse(timestamp)
  if (!Number.isFinite(targetMs)) return 'Resets soon'
  const diffMs = targetMs - nowMs
  if (diffMs <= 0) return 'Resets now'
  const totalMinutes = Math.ceil(diffMs / 60_000)
  if (totalMinutes < 60) return `Resets in ${totalMinutes}m`
  if (totalMinutes < 24 * 60) {
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return hours < 6 && minutes > 0 ? `Resets in ${hours}h ${minutes}m` : `Resets in ${hours}h`
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(targetMs))
  const weekday = parts.find((part) => part.type === 'weekday')?.value
  const hour = parts.find((part) => part.type === 'hour')?.value
  const minute = parts.find((part) => part.type === 'minute')?.value
  if (weekday && hour && minute) {
    return `Resets ${weekday} ${hour}:${minute}`
  }
  const formatted = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(targetMs))
  return `Resets ${formatted}`
}

function toRemainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - Math.round(usedPercent)))
}

function barFillClass(remainingPercent: number, stale: boolean): string {
  if (stale) return 'bg-border-strong'
  if (remainingPercent <= 5) return 'bg-status-danger'
  if (remainingPercent <= 20) return 'bg-status-warning'
  return 'bg-focus'
}

function valueTextClass(remainingPercent: number, stale: boolean): string {
  if (stale) return 'text-tertiary'
  if (remainingPercent <= 5) return 'text-status-danger-foreground'
  if (remainingPercent <= 20) return 'text-status-warning-foreground'
  return 'text-secondary'
}

function shortStatusLabel(snapshot: ProviderUsageSnapshot, status: ProviderUsageStatus): string {
  switch (status) {
    case 'unauthenticated':
      return snapshot.message ?? 'Sign in required'
    case 'not_applicable':
      return snapshot.message ?? 'No plan limits'
    case 'unsupported':
      return snapshot.message ?? 'Update CLI'
    case 'close_unconfirmed':
      return snapshot.message ?? 'Wait to retry'
    case 'unavailable':
      return snapshot.message ?? 'Unavailable'
    default:
      return snapshot.message ?? 'Unavailable'
  }
}

function statusToneClass(status: ProviderUsageStatus): string {
  if (status === 'close_unconfirmed') return 'text-status-danger-foreground'
  if (status === 'unauthenticated' || status === 'unsupported') {
    return 'text-status-warning-foreground'
  }
  return 'text-tertiary'
}

function badgeDotTone(
  snapshots: Record<ProviderUsageProvider, ProviderUsageSnapshot>,
  nowMs: number,
): 'danger' | 'warning' | undefined {
  let lowestRemaining = 101
  for (const { id } of PROVIDERS) {
    const snapshot = snapshots[id]
    const status = effectiveStatus(snapshot, nowMs)
    if (status === 'stale' || !shouldShowWindows(snapshot, status)) continue
    for (const window of snapshotWindows(snapshot)) {
      if (hasUsageWindow(window)) {
        lowestRemaining = Math.min(lowestRemaining, toRemainingPercent(window.usedPercent))
      }
    }
  }
  if (lowestRemaining <= 5) return 'danger'
  if (lowestRemaining <= 20) return 'warning'
  return undefined
}

function UsageWindowBar({
  providerLabel,
  windowLabel,
  window,
  stale,
  showResetTime,
  nowMs,
}: {
  providerLabel: string
  windowLabel: '5h' | '7d'
  window: ResolvedUsageWindow
  stale: boolean
  showResetTime: boolean
  nowMs: number
}): React.JSX.Element {
  const remainingPercent = toRemainingPercent(window.usedPercent)
  const fillWidth = remainingPercent > 0 ? Math.max(4, Math.min(100, remainingPercent)) : 0

  return (
    <div className="space-y-0.5">
      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2">
        <span
          aria-hidden="true"
          className="text-caption font-medium leading-none text-tertiary tabular-nums"
        >
          {windowLabel}
        </span>
        <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-pill bg-border/85">
          <div
            className={`h-full rounded-pill transition-[width] duration-300 ease-out motion-reduce:transition-none ${barFillClass(remainingPercent, stale)}`}
            style={{ width: `${fillWidth}%` }}
          />
        </div>
        <span
          aria-hidden="true"
          className={`whitespace-nowrap text-right text-caption font-medium leading-none tabular-nums ${valueTextClass(remainingPercent, stale)}`}
        >
          {`${remainingPercent}% left`}
        </span>
        <span className="sr-only">
          {`${providerLabel} ${windowLabel}: ${remainingPercent}% left`}
        </span>
      </div>
      {showResetTime && window.resetsAt ? (
        <p className="pl-8 text-caption leading-tight text-tertiary tabular-nums">
          {formatResetTime(window.resetsAt, nowMs)}
        </p>
      ) : null}
    </div>
  )
}

function ProviderUsageSection({
  label,
  snapshot,
  isRefreshing,
  detailed,
  nowMs,
  onRefresh,
}: {
  label: string
  snapshot: ProviderUsageSnapshot
  isRefreshing: boolean
  detailed: boolean
  nowMs: number
  onRefresh: () => void
}): React.JSX.Element {
  const status = effectiveStatus(snapshot, nowMs)
  const stale = status === 'stale'
  const showWindows = shouldShowWindows(snapshot, status)
  const silentLoading = isSilentLoading(snapshot, status)

  const cooldownMs = snapshot.cooldownUntil ? Date.parse(snapshot.cooldownUntil) : 0
  const remainingCooldownSeconds =
    Number.isFinite(cooldownMs) && cooldownMs > nowMs ? Math.ceil((cooldownMs - nowMs) / 1000) : 0

  const spinning =
    isRefreshing || status === 'loading' || status === 'busy' || status === 'cancelling'
  const refreshBlocked = spinning || status === 'close_unconfirmed' || remainingCooldownSeconds > 0

  return (
    <div data-provider-usage={snapshot.provider}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-caption font-medium text-primary">{label}</span>
          {stale ? <span className="text-caption text-tertiary">Outdated</span> : null}
        </div>
        {detailed ? (
          <button
            type="button"
            className="grid size-6 shrink-0 place-items-center rounded-control text-tertiary transition-colors hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-40"
            aria-label={`Refresh ${label}`}
            title={
              remainingCooldownSeconds > 0
                ? `Refresh available in ${remainingCooldownSeconds}s`
                : undefined
            }
            disabled={refreshBlocked}
            onClick={onRefresh}
          >
            <RefreshCw
              aria-hidden="true"
              className={`size-3.5 ${spinning ? 'motion-safe:animate-spin' : ''}`}
              strokeWidth={1.75}
            />
          </button>
        ) : null}
      </div>

      {showWindows ? (
        snapshot.pools && snapshot.pools.length > 1 ? (
          <div className={detailed ? 'mt-1.5 space-y-2' : 'mt-1 space-y-1.5'}>
            {snapshot.pools.map((pool) => (
              <div key={pool.id} className="space-y-1">
                <p className="truncate text-caption leading-snug text-tertiary">{pool.label}</p>
                {hasUsageWindow(pool.fiveHour) ? (
                  <UsageWindowBar
                    providerLabel={`${label} ${pool.label}`}
                    windowLabel="5h"
                    window={pool.fiveHour}
                    stale={stale}
                    showResetTime={detailed}
                    nowMs={nowMs}
                  />
                ) : null}
                {hasUsageWindow(pool.sevenDay) ? (
                  <UsageWindowBar
                    providerLabel={`${label} ${pool.label}`}
                    windowLabel="7d"
                    window={pool.sevenDay}
                    stale={stale}
                    showResetTime={detailed}
                    nowMs={nowMs}
                  />
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className={detailed ? 'mt-1.5 space-y-1.5' : 'mt-1 space-y-1'}>
            {snapshot.message ? (
              <p className="truncate text-caption leading-snug text-tertiary">{snapshot.message}</p>
            ) : null}
            {hasUsageWindow(snapshot.fiveHour) ? (
              <UsageWindowBar
                providerLabel={label}
                windowLabel="5h"
                window={snapshot.fiveHour}
                stale={stale}
                showResetTime={detailed}
                nowMs={nowMs}
              />
            ) : null}
            {hasUsageWindow(snapshot.sevenDay) ? (
              <UsageWindowBar
                providerLabel={label}
                windowLabel="7d"
                window={snapshot.sevenDay}
                stale={stale}
                showResetTime={detailed}
                nowMs={nowMs}
              />
            ) : null}
          </div>
        )
      ) : silentLoading ? (
        <output className="mt-1.5 block" aria-busy="true" aria-label={`${label} usage loading`}>
          <span
            aria-hidden="true"
            className="block h-1.5 w-full rounded-pill bg-border/85 motion-safe:animate-pulse"
          />
        </output>
      ) : (
        <p className={`mt-1 truncate text-caption leading-snug ${statusToneClass(status)}`}>
          {shortStatusLabel(snapshot, status)}
        </p>
      )}
    </div>
  )
}

export function ProviderUsagePanel({
  visible,
  onInteract,
}: {
  visible: boolean
  onInteract?: () => void
}): React.JSX.Element {
  const { snapshots, refreshing, nowMs, refresh } = useProviderUsage(visible)
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focusPreview, setFocusPreview] = useState(false)
  const [anchorStyle, setAnchorStyle] = useState<React.CSSProperties>()

  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDialogElement>(null)
  const openTimerRef = useRef<number | undefined>(undefined)
  const closeTimerRef = useRef<number | undefined>(undefined)

  const mode: PopoverMode = !visible
    ? 'closed'
    : pinned
      ? 'detailed'
      : hovered || focusPreview
        ? 'compact'
        : 'closed'
  const isOpen = mode !== 'closed'

  const clearTimers = (): void => {
    if (openTimerRef.current !== undefined) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = undefined
    }
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = undefined
    }
  }

  useEffect(
    () => () => {
      if (openTimerRef.current !== undefined) window.clearTimeout(openTimerRef.current)
      if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current)
    },
    [],
  )

  const closeAll = useEffectEvent((restoreFocus: boolean): void => {
    clearTimers()
    setPinned(false)
    setHovered(false)
    setFocusPreview(false)
    if (restoreFocus && triggerRef.current?.isConnected) {
      triggerRef.current.focus({ preventScroll: true })
    }
  })

  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) return undefined
    const updatePosition = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = mode === 'detailed' ? 260 : 212
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
      setAnchorStyle({
        width,
        left,
        right: 'auto',
        top: 'auto',
        bottom: Math.max(12, window.innerHeight - rect.top),
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [isOpen, mode])

  useEffect(() => {
    if (!isOpen) return undefined
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const active = document.activeElement
      const restore = Boolean(
        active instanceof Node &&
        (popoverRef.current?.contains(active) || triggerRef.current?.contains(active)),
      )
      event.preventDefault()
      closeAll(restore)
    }
    const handlePointerDown = (event: PointerEvent): void => {
      if (!pinned || !(event.target instanceof Node)) return
      if (
        popoverRef.current?.contains(event.target) ||
        triggerRef.current?.contains(event.target)
      ) {
        return
      }
      closeAll(false)
    }
    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [isOpen, pinned])

  const refreshIfNeeded = useEffectEvent((includeUnavailable: boolean): void => {
    const now = Date.now()
    for (const { id } of PROVIDERS) {
      const snapshot = snapshots[id]
      const status = effectiveStatus(snapshot, now)
      const cooldownMs = snapshot.cooldownUntil ? Date.parse(snapshot.cooldownUntil) : 0
      const inCooldown = Number.isFinite(cooldownMs) && cooldownMs > now
      const eligible =
        status === 'idle' || status === 'stale' || (includeUnavailable && status === 'unavailable')
      if (eligible && !inCooldown) {
        refresh(id)
      }
    }
  })

  const handlePointerEnter = useEffectEvent((): void => {
    if (!visible) return
    clearTimers()
    if (pinned || hovered) {
      setHovered(true)
      refreshIfNeeded(false)
      return
    }
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = undefined
      setHovered(true)
      refreshIfNeeded(false)
    }, HOVER_OPEN_DELAY_MS)
  })

  const handlePointerLeave = useEffectEvent((): void => {
    clearTimers()
    if (pinned) {
      setHovered(false)
      return
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = undefined
      setHovered(false)
    }, HOVER_CLOSE_DELAY_MS)
  })

  useEffect(() => {
    const popover = popoverRef.current
    if (!isOpen || !popover) return undefined
    const enter = (): void => handlePointerEnter()
    const leave = (): void => handlePointerLeave()
    popover.addEventListener('mouseenter', enter)
    popover.addEventListener('mouseleave', leave)
    return () => {
      popover.removeEventListener('mouseenter', enter)
      popover.removeEventListener('mouseleave', leave)
    }
  }, [isOpen])

  const handleTriggerClick = (): void => {
    onInteract?.()
    clearTimers()
    if (pinned) {
      setPinned(false)
      setHovered(false)
      setFocusPreview(false)
      return
    }
    setPinned(true)
    setHovered(false)
    setFocusPreview(false)
    refreshIfNeeded(true)
  }

  const dotTone = badgeDotTone(snapshots, nowMs)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="flex min-h-9 w-full items-center gap-group rounded-xl px-group py-2 text-left text-body font-medium text-secondary transition-colors duration-150 hover:bg-row-hover hover:text-primary focus-visible:outline-2 focus-visible:outline-focus data-[active=true]:bg-surface-raised data-[active=true]:text-primary"
        aria-label="Usage"
        aria-haspopup="dialog"
        aria-expanded={mode === 'detailed'}
        data-active={isOpen}
        data-usage-trigger
        onMouseEnter={() => handlePointerEnter()}
        onMouseLeave={() => handlePointerLeave()}
        onFocus={(event) => {
          if (event.currentTarget.matches(':focus-visible')) {
            setFocusPreview(true)
            refreshIfNeeded(false)
          }
        }}
        onBlur={(event) => {
          const next = event.relatedTarget
          if (next instanceof Node && popoverRef.current?.contains(next)) return
          setFocusPreview(false)
        }}
        onClick={handleTriggerClick}
      >
        <Gauge aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
        <span className="truncate">Usage</span>
        {dotTone ? (
          <span
            aria-hidden="true"
            className={`ml-auto size-1.5 shrink-0 rounded-pill ${dotTone === 'danger' ? 'bg-status-danger' : 'bg-status-warning'}`}
          />
        ) : null}
      </button>

      {isOpen && anchorStyle
        ? createPortal(
            <dialog
              open
              ref={popoverRef}
              aria-label="Usage"
              data-provider-usage-popover={mode}
              className="fixed z-50 m-0 border-0 bg-transparent p-0 pb-2 text-inherit"
              style={anchorStyle}
              onBlurCapture={(event) => {
                if (pinned) return
                const next = event.relatedTarget
                if (
                  next instanceof Node &&
                  (popoverRef.current?.contains(next) || triggerRef.current?.contains(next))
                ) {
                  return
                }
                setFocusPreview(false)
              }}
            >
              <div
                className={`max-h-[calc(100vh-2rem)] overflow-y-auto rounded-panel border border-border bg-menu-surface text-primary shadow-popover ${
                  mode === 'detailed' ? 'space-y-2.5 p-3' : 'space-y-2 p-2.5'
                }`}
              >
                {PROVIDERS.map(({ id, label }, index) => (
                  <div
                    key={id}
                    className={index > 0 ? 'border-t border-border/70 pt-2' : undefined}
                  >
                    <ProviderUsageSection
                      label={label}
                      snapshot={snapshots[id]}
                      isRefreshing={refreshing[id]}
                      detailed={mode === 'detailed'}
                      nowMs={nowMs}
                      onRefresh={() => refresh(id)}
                    />
                  </div>
                ))}
              </div>
            </dialog>,
            document.body,
          )
        : null}
    </>
  )
}
