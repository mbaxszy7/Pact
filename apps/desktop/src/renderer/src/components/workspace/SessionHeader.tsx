import {
  BookOpen,
  Check,
  FileDiff,
  FileText,
  FolderClosed,
  MessagesSquare,
  Pencil,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { useRef, useState } from 'react'

import type { CollaborationSession, CollaborationTask, SessionActivity } from '@pact/contracts'

interface SessionHeaderProps {
  session: CollaborationSession
  collaborationTask?: CollaborationTask | null | undefined
  projectName?: string | undefined
  saving: boolean
  onSave: (title: string) => Promise<boolean>
  onOpenSettings: () => void
  settingsButtonRef?: React.RefObject<HTMLButtonElement | null> | undefined
  settingsOpen?: boolean | undefined
  planAvailable?: boolean | undefined
  planOpen?: boolean | undefined
  planVersion?: number | undefined
  onTogglePlan?: (() => void) | undefined
  planButtonRef?: React.RefObject<HTMLButtonElement | null> | undefined
  changesAvailable?: boolean | undefined
  changesOpen?: boolean | undefined
  onToggleChanges?: (() => void) | undefined
  fileAvailable?: boolean | undefined
  fileOpen?: boolean | undefined
  fileLabel?: string | undefined
  onToggleFile?: (() => void) | undefined
  sideChatsOpen?: boolean | undefined
  sideChatActiveCount?: number | undefined
  sideChatAttentionCount?: number | undefined
  sideChatUnreadCount?: number | undefined
  onOpenSideChats?: (() => void) | undefined
  sideChatsButtonRef?: React.RefObject<HTMLButtonElement | null> | undefined
}

type StatusTone = 'ready' | 'warning' | 'danger' | 'info'

interface QuietStatusPill {
  label: string
  tone: StatusTone
}

const STATUS_DOT_CLASS: Record<StatusTone, string> = {
  ready: 'bg-status-ready',
  warning: 'bg-status-warning',
  danger: 'bg-status-danger',
  info: 'bg-status-info',
}

function agentDisplayName(agentId: SessionActivity['agentId']): string {
  if (agentId === 'claude') return 'Claude Code'
  if (agentId === 'codex') return 'Codex'
  if (agentId === 'agy') return 'Antigravity'
  return 'Agent'
}

function deriveQuietStatus(
  activity: SessionActivity,
  collaborationTask?: CollaborationTask | null,
): QuietStatusPill | null {
  switch (activity.state) {
    case 'agent_working':
      return { label: `${agentDisplayName(activity.agentId)} working`, tone: 'ready' }
    case 'recovering':
      return { label: `Recovering ${agentDisplayName(activity.agentId)}`, tone: 'warning' }
    case 'waiting_for_user':
      return { label: 'Waiting for reply', tone: 'info' }
    case 'error':
      return { label: `${agentDisplayName(activity.agentId)} error`, tone: 'danger' }
    case 'interrupted':
      return { label: `${agentDisplayName(activity.agentId)} interrupted`, tone: 'warning' }
    case 'paused':
      return { label: 'Paused', tone: 'warning' }
    case 'idle':
    case 'completed':
      break
  }

  if (!collaborationTask || collaborationTask.ending) return null
  if (collaborationTask.unreviewedCodeActor) {
    return { label: 'Changes unreviewed', tone: 'warning' }
  }
  if (collaborationTask.unreviewedPlanActor && collaborationTask.planVersion > 0) {
    return { label: `Plan v${collaborationTask.planVersion} unreviewed`, tone: 'warning' }
  }
  if (
    collaborationTask.planReference &&
    collaborationTask.planVersion > 0 &&
    collaborationTask.status === 'ready'
  ) {
    return { label: `Plan v${collaborationTask.planVersion} ready`, tone: 'ready' }
  }
  return null
}

function headerButtonClass(active: boolean): string {
  return `pact-pressable relative inline-flex h-8 shrink-0 items-center justify-center rounded-xl border text-caption font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
    active
      ? 'border-border bg-surface text-primary shadow-sheet'
      : 'border-transparent text-secondary hover:bg-row-hover hover:text-primary'
  }`
}

export function SessionHeader({
  session,
  collaborationTask,
  projectName,
  saving,
  onSave,
  onOpenSettings,
  settingsButtonRef,
  settingsOpen = false,
  planAvailable = false,
  planOpen = false,
  planVersion,
  onTogglePlan,
  planButtonRef,
  changesAvailable = false,
  changesOpen = false,
  onToggleChanges,
  fileAvailable = false,
  fileOpen = false,
  fileLabel,
  onToggleFile,
  sideChatsOpen = false,
  sideChatActiveCount = 0,
  sideChatAttentionCount = 0,
  sideChatUnreadCount = 0,
  onOpenSideChats,
  sideChatsButtonRef,
}: SessionHeaderProps): React.JSX.Element {
  const showSideChats = !session.parentSessionId && Boolean(onOpenSideChats)
  const statusPill = deriveQuietStatus(session.activity, collaborationTask)
  const planTitle = planVersion ? `Plan v${planVersion}` : 'Plan'
  const resolvedFileLabel = fileLabel ?? 'File'
  const hasSideChatCount = sideChatAttentionCount > 0 || sideChatActiveCount > 0

  return (
    <div className="flex h-full min-w-0 items-center justify-between gap-group">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className="grid size-7 shrink-0 place-items-center text-secondary"
          title={projectName ? `Project: ${projectName}` : undefined}
        >
          <FolderClosed aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </span>
        {projectName ? (
          <>
            <span
              className="max-w-40 shrink-0 truncate text-body text-secondary"
              title={projectName}
            >
              {projectName}
            </span>
            <span aria-hidden="true" className="shrink-0 text-body text-tertiary select-none">
              /
            </span>
          </>
        ) : null}
        <EditableSessionTitle session={session} saving={saving} onSave={onSave} />
        {statusPill ? (
          <span
            data-session-status-pill={statusPill.tone}
            className="hidden shrink-0 items-center gap-1.5 rounded-pill border border-border bg-surface-muted px-2.5 py-0.5 text-caption font-medium text-secondary sm:inline-flex"
          >
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-pill ${STATUS_DOT_CLASS[statusPill.tone]}`}
            />
            <span>{statusPill.label}</span>
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {planAvailable && onTogglePlan ? (
          <button
            ref={planButtonRef}
            className={`${headerButtonClass(planOpen)} w-8`}
            type="button"
            aria-label="Plan"
            aria-expanded={planOpen}
            title={planTitle}
            onClick={onTogglePlan}
          >
            <BookOpen aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </button>
        ) : null}
        {changesAvailable && onToggleChanges ? (
          <button
            className={`${headerButtonClass(changesOpen)} w-8`}
            type="button"
            aria-label="Changes"
            aria-expanded={changesOpen}
            title="Changes"
            onClick={onToggleChanges}
          >
            <FileDiff aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </button>
        ) : null}
        {fileAvailable && onToggleFile ? (
          <button
            className={`${headerButtonClass(fileOpen)} w-8`}
            type="button"
            aria-label={resolvedFileLabel}
            aria-expanded={fileOpen}
            title={resolvedFileLabel}
            onClick={onToggleFile}
          >
            <FileText aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </button>
        ) : null}
        {showSideChats ? (
          <button
            ref={sideChatsButtonRef}
            className={`${headerButtonClass(sideChatsOpen)} ${hasSideChatCount ? 'gap-1.5 px-2' : 'w-8'}`}
            type="button"
            aria-label="Side chats"
            aria-expanded={sideChatsOpen}
            title="Side chats"
            onClick={onOpenSideChats}
          >
            <MessagesSquare aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
            {sideChatAttentionCount > 0 ? (
              <span
                key="attention"
                className="pact-reminder-icon-pop inline-flex items-center gap-1 rounded-pill bg-status-warning-muted px-1.5 py-0.5 text-caption font-medium leading-none text-status-warning-foreground"
                aria-label={`${sideChatAttentionCount} side chat${sideChatAttentionCount === 1 ? '' : 's'} needing attention`}
              >
                <span aria-hidden="true" className="size-1.5 rounded-pill bg-status-warning" />
                {sideChatAttentionCount}
              </span>
            ) : sideChatActiveCount > 0 ? (
              <span
                key="active"
                className="pact-reminder-icon-pop inline-flex items-center gap-1 rounded-pill bg-status-info-muted px-1.5 py-0.5 text-caption font-medium leading-none text-status-info-foreground"
                aria-label={`${sideChatActiveCount} active side chat${sideChatActiveCount === 1 ? '' : 's'}`}
              >
                <span aria-hidden="true" className="size-1.5 rounded-pill bg-status-info" />
                {sideChatActiveCount}
              </span>
            ) : sideChatUnreadCount > 0 ? (
              <span
                key="unread"
                className="pact-reminder-icon-pop absolute top-1.5 right-1.5 size-1.5 shrink-0 rounded-pill bg-focus"
                aria-label={`${sideChatUnreadCount} unread side chat${sideChatUnreadCount === 1 ? '' : 's'}`}
                title={`${sideChatUnreadCount} unread side chat${sideChatUnreadCount === 1 ? '' : 's'}`}
              />
            ) : null}
          </button>
        ) : null}
        <button
          ref={settingsButtonRef}
          className={`${headerButtonClass(settingsOpen)} w-8`}
          type="button"
          aria-label="Session settings"
          aria-expanded={settingsOpen}
          title="Session settings"
          onClick={onOpenSettings}
        >
          <SlidersHorizontal aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  )
}

function EditableSessionTitle({
  session,
  saving,
  onSave,
}: Pick<SessionHeaderProps, 'session' | 'saving' | 'onSave'>): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const [error, setError] = useState<string | undefined>()
  const editorRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const beginEditing = (): void => {
    setDraft(session.title)
    setError(undefined)
    setEditing(true)
    window.requestAnimationFrame(() => inputRef.current?.select())
  }
  const cancel = (): void => {
    if (saving) return
    setDraft(session.title)
    setError(undefined)
    setEditing(false)
  }
  const save = async (): Promise<void> => {
    if (saving) return
    const title = draft.trim()
    if (!title) {
      setError('Enter a title.')
      inputRef.current?.focus()
      return
    }
    if (title === session.title) {
      setEditing(false)
      return
    }
    if (await onSave(title)) setEditing(false)
    else setError('Couldn’t save the title. Try again.')
  }

  if (!editing) {
    return (
      <div
        data-titlebar-interactive
        className="group/title flex min-w-0 max-w-full items-center gap-1.5"
      >
        <h1 className="truncate text-body font-medium text-primary" title={session.title}>
          {session.title}
        </h1>
        <button
          className="grid size-7 shrink-0 place-items-center rounded-lg text-tertiary opacity-0 transition-opacity duration-150 hover:bg-row-hover hover:text-primary focus-visible:opacity-100 group-hover/title:opacity-100 group-focus-within/title:opacity-100"
          type="button"
          aria-label="Rename Session"
          title="Rename Session"
          onClick={beginEditing}
        >
          <Pencil aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
    )
  }

  return (
    <div
      ref={editorRef}
      data-titlebar-interactive
      className="relative min-w-0 flex-1"
      onBlur={(event) => {
        if (editorRef.current?.contains(event.relatedTarget)) return
        void save()
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <input
          ref={inputRef}
          className="h-8 min-w-0 flex-1 rounded-control border border-focus bg-surface-raised px-2.5 text-body font-medium text-primary outline-none ring-2 ring-focus/20"
          aria-label="Session title"
          maxLength={120}
          value={draft}
          disabled={saving}
          onChange={(event) => {
            setDraft(event.target.value)
            setError(undefined)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void save()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancel()
            }
          }}
        />
        <button
          className="grid size-8 shrink-0 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary disabled:cursor-wait disabled:opacity-50"
          type="button"
          aria-label="Save Session title"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? (
            <span className="primary-action-spinner" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" className="size-4" strokeWidth={1.8} />
          )}
        </button>
        <button
          className="grid size-8 shrink-0 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary disabled:opacity-50"
          type="button"
          aria-label="Cancel renaming"
          disabled={saving}
          onClick={cancel}
        >
          <X aria-hidden="true" className="size-4" strokeWidth={1.8} />
        </button>
      </div>
      {error ? (
        <p
          className="absolute left-0 top-[calc(100%+0.375rem)] z-20 rounded-control border border-border bg-menu-surface px-2.5 py-1.5 text-caption text-danger shadow-popover"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}
