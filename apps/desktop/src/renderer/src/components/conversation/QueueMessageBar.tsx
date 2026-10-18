/* oxlint-disable jsx-a11y/prefer-tag-over-role -- The native popover follows the keyboard-operated ARIA menu pattern. */
import {
  CornerDownRight,
  Info,
  ListEnd,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import type { ConversationQueueState, RuntimeAgentId } from '@pact/contracts'

interface QueueMessageBarProps {
  queue: ConversationQueueState
  pending: boolean
  disabled: boolean
  canSteer: boolean
  steerUnavailableReason: string
  respondingAgentId?: RuntimeAgentId | undefined
  onSteer: () => Promise<boolean>
  onRemove: () => Promise<boolean>
  onEdit: () => Promise<boolean>
  onResume: () => Promise<boolean>
  onSetEnabled: (enabled: boolean) => Promise<boolean>
  onCheckStatus?: (() => Promise<boolean>) | undefined
}

/** A disposable view of the single durable queue entry; actions remain owned by useConversation. */
export function QueueMessageBar({
  queue,
  pending,
  disabled,
  canSteer,
  steerUnavailableReason,
  respondingAgentId,
  onSteer,
  onRemove,
  onEdit,
  onResume,
  onSetEnabled,
  onCheckStatus,
}: QueueMessageBarProps): React.JSX.Element | null {
  const id = useId().replaceAll(':', '')
  const menuId = `queue-actions-${id}`
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const entry = queue.input
  const busy = pending || checking || disabled
  const locked = entry?.state === 'dispatching' || entry?.state === 'unknown'
  const removableDelivery = entry?.delivery?.canRemove === true
  useEffect(() => {
    if (locked) menu.current?.hidePopover()
  }, [locked])
  const close = (): void => {
    menu.current?.hidePopover()
    trigger.current?.focus()
  }
  const focusItem = (last = false): void => {
    const items = menu.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    )
    ;(last ? items?.[items.length - 1] : items?.[0])?.focus()
  }
  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'Tab') {
      menu.current?.hidePopover()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    ]
    if (!items.length) return
    event.preventDefault()
    const index = items.findIndex((item) => item === document.activeElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
  const checkStatus = async (): Promise<void> => {
    if (busy || !onCheckStatus) return
    setChecking(true)
    try {
      await onCheckStatus()
    } finally {
      setChecking(false)
    }
  }
  if (!entry) {
    return !queue.enabled ? (
      <div className="flex min-h-8 items-center gap-2 px-2 text-caption text-secondary">
        <ListEnd aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span>Queue disabled</span>
        <button
          type="button"
          disabled={busy}
          className="ml-auto min-h-7 rounded-control px-2 font-medium text-primary hover:bg-surface-muted disabled:opacity-40"
          onClick={() => void onSetEnabled(true)}
        >
          Enable queue
        </button>
      </div>
    ) : null
  }
  const name =
    entry.recipient === 'all'
      ? 'All Agents'
      : entry.recipient === 'claude'
        ? 'Claude Code'
        : 'Codex'
  const agentMismatchReason =
    respondingAgentId &&
    entry.recipient !== 'all' &&
    entry.recipient !== respondingAgentId &&
    !entry.workflowCommand
      ? `${respondingAgentId === 'claude' ? 'Claude Code' : 'Codex'} is responding, but this message targets ${name}. Steer is only available for the Agent currently responding.`
      : undefined
  const steerInfoId = `queue-steer-info-${id}`
  const stateLabel =
    entry.state === 'dispatching'
      ? 'Delivering message…'
      : entry.state === 'unknown'
        ? 'Delivery not confirmed'
        : entry.state === 'paused'
          ? 'Queue paused'
          : !queue.enabled
            ? 'Queue disabled'
            : 'Queued'
  const attachments = [
    entry.imageCount ? `${entry.imageCount} ${entry.imageCount === 1 ? 'image' : 'images'}` : '',
    entry.commentCount
      ? `${entry.commentCount} ${entry.commentCount === 1 ? 'Comment' : 'Comments'}`
      : '',
    entry.skillCount ? `${entry.skillCount} ${entry.skillCount === 1 ? 'Skill' : 'Skills'}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const iconButton =
    'grid size-8 shrink-0 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary disabled:cursor-default disabled:opacity-40'
  return (
    <div
      className="relative mx-1 rounded-t-card border border-b-0 border-border bg-surface-muted px-3 pt-2 pb-3 text-caption"
      data-pact-surface="raised"
    >
      <div className="flex min-w-0 items-center gap-2">
        {pending ? (
          <LoaderCircle
            aria-hidden="true"
            className="size-4 shrink-0 animate-spin text-secondary"
            strokeWidth={1.75}
          />
        ) : (
          <ListEnd
            aria-hidden="true"
            className="size-4 shrink-0 text-secondary"
            strokeWidth={1.75}
          />
        )}
        <span className="shrink-0 font-medium text-secondary">{name}</span>
        <span className="min-w-0 flex-1 truncate text-primary" title={entry.preview || attachments}>
          {entry.preview || attachments || 'Message'}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            disabled={busy || locked || !canSteer}
            title={
              canSteer
                ? 'Send to the current response'
                : (agentMismatchReason ?? steerUnavailableReason)
            }
            className="inline-flex min-h-8 items-center gap-1.5 rounded-control px-2 font-medium text-secondary hover:bg-surface-raised hover:text-primary disabled:cursor-default disabled:opacity-40"
            onClick={() => void onSteer()}
          >
            <CornerDownRight aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
            Steer
          </button>
          {!canSteer && agentMismatchReason ? (
            <span className="group relative inline-flex shrink-0">
              <button
                type="button"
                aria-label="Why Steer is unavailable"
                aria-describedby={steerInfoId}
                className="grid size-7 place-items-center rounded-control text-secondary hover:bg-surface-raised hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
              >
                <Info aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              </button>
              <span
                id={steerInfoId}
                role="tooltip"
                className="pointer-events-none invisible absolute right-0 bottom-[calc(100%+0.5rem)] z-30 w-72 max-w-[calc(100vw-2rem)] rounded-control border border-border bg-surface-raised px-3 py-2 text-caption font-normal leading-relaxed text-primary opacity-0 shadow-popover transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
              >
                {agentMismatchReason}
              </span>
            </span>
          ) : null}
          <button
            type="button"
            className={iconButton}
            aria-label="Remove queued message"
            title={removableDelivery ? 'Remove from Pact queue' : 'Remove queued message'}
            disabled={busy || (locked && !removableDelivery)}
            onClick={() => void onRemove()}
          >
            <Trash2 aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            ref={trigger}
            type="button"
            className={iconButton}
            aria-label="Queued message actions"
            title="More actions"
            popoverTarget={menuId}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={menuId}
            disabled={busy}
            style={{ anchorName: `--${menuId}` }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              menu.current?.showPopover()
              focusItem(event.key === 'ArrowUp')
            }}
          >
            <MoreHorizontal aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>
      {entry.state !== 'queued' || !queue.enabled || entry.reason || attachments ? (
        <div
          className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-secondary"
          role="status"
        >
          <span>
            {stateLabel}
            {removableDelivery
              ? ' · The original execution was rebuilt. You can remove this item from the Pact queue; its delivery remains unconfirmed.'
              : entry.reason
                ? ` · ${entry.reason}`
                : ''}
          </span>
          {entry.state === 'paused' ? (
            <button
              type="button"
              disabled={busy || !queue.enabled}
              className="inline-flex min-h-7 items-center gap-1.5 rounded-control px-2 font-medium text-primary hover:bg-surface-raised disabled:opacity-40"
              onClick={() => void onResume()}
            >
              <Play aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              Resume queue
            </button>
          ) : null}
          {attachments && entry.preview ? <span>{attachments}</span> : null}
          {entry.state === 'unknown' && onCheckStatus ? (
            <button
              type="button"
              disabled={busy}
              className="min-h-6 rounded-control px-1.5 font-medium text-primary hover:bg-surface-raised disabled:opacity-40"
              onClick={() => void checkStatus()}
            >
              {checking ? 'Checking…' : 'Check status'}
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        id={menuId}
        ref={menu}
        popover="auto"
        role="menu"
        tabIndex={-1}
        aria-label="Queued message actions"
        className="pact-composer-popover w-56 max-w-[calc(100vw-2rem)]"
        style={{
          positionAnchor: `--${menuId}`,
          inset: 'auto',
          right: 'anchor(right)',
          bottom: 'anchor(top)',
          margin: 0,
          marginBottom: '0.375rem',
        }}
        onKeyDown={menuKeyDown}
        onBeforeToggle={(event) => setOpen(event.newState === 'open')}
        onToggle={(event) => {
          if (event.newState === 'open') focusItem()
        }}
      >
        <button
          type="button"
          role="menuitem"
          className="pact-composer-menu-item disabled:opacity-40"
          disabled={busy || locked}
          onClick={() => {
            close()
            void onEdit()
          }}
        >
          <Pencil aria-hidden="true" className="size-4" strokeWidth={1.75} />
          <span>Edit message</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="pact-composer-menu-item disabled:opacity-40"
          disabled={busy}
          onClick={() => {
            close()
            void onSetEnabled(!queue.enabled)
          }}
        >
          <ListEnd aria-hidden="true" className="size-4" strokeWidth={1.75} />
          <span>{queue.enabled ? 'Disable queue' : 'Enable queue'}</span>
        </button>
      </div>
    </div>
  )
}
