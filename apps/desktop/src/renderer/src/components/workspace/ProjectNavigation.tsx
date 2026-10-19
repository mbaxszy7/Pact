import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Archive,
  CircleAlert,
  CircleCheck,
  CirclePause,
  ChevronDown,
  Check,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  MessageSquare,
  Plus,
  Pencil,
  RefreshCw,
  Reply,
  Settings,
  X,
} from 'lucide-react'
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type {
  CollaborationSession,
  Project,
  ProjectNameChange,
  RpcResult,
  SessionActivity,
} from '@pact/contracts'

import {
  MAX_AGENT_RUN_ATTEMPTS,
  PROJECT_NAME_LIMIT,
  projectNameChangeSchema,
} from '@pact/contracts'

import type { SessionCatalogCache } from './session-catalog-cache'
import type { SettingsPage } from './SettingsNavigation'

interface ProjectNavigationProps {
  projects: Project[]
  sessions: CollaborationSession[]
  projectPages: SessionCatalogCache['projectPages']
  loading: boolean
  loadingMoreProjectId?: string | undefined
  loadMoreErrors: Record<string, string>
  error?: string | undefined
  adding: boolean
  archivingProjectId?: string | undefined
  renamingProjectId?: string | undefined
  archivingSessionId?: string | undefined
  selectedSessionId?: string | undefined
  updateAvailable?: boolean
  settingsButtonRef: React.RefObject<HTMLButtonElement | null>
  onAddProject: () => void
  onArchiveProject: (projectId: string) => void
  onRenameProject: (projectId: string, name: string) => Promise<RpcResult<ProjectNameChange>>
  onOpenSettings: (page: Exclude<SettingsPage, null>) => void
  onRetrySessions: () => void
  onLoadMoreSessions: (projectId: string) => Promise<number>
  onStartSession: (projectId: string) => void
  onSelectSession: (sessionId: string) => void
  onArchiveSession: (sessionId: string) => void
}

type NavigationRow =
  | { kind: 'project'; project: Project }
  | { kind: 'session'; session: CollaborationSession }
  | { kind: 'loadMore'; projectId: string }

export function ProjectNavigation({
  projects,
  sessions,
  projectPages,
  loading,
  loadingMoreProjectId,
  loadMoreErrors,
  error,
  adding,
  archivingProjectId,
  renamingProjectId,
  archivingSessionId,
  selectedSessionId,
  settingsButtonRef,
  updateAvailable,
  onAddProject,
  onArchiveProject,
  onRenameProject,
  onOpenSettings,
  onRetrySessions,
  onLoadMoreSessions,
  onStartSession,
  onSelectSession,
  onArchiveSession,
}: ProjectNavigationProps): React.JSX.Element {
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set())
  const scrollRef = useRef<HTMLElement>(null)
  const pendingFocusIndex = useRef<number | undefined>(undefined)
  const scrollFocusIndex = useRef<number | undefined>(undefined)
  const sessionsByProject = useMemo(() => {
    const grouped = new Map<string, CollaborationSession[]>()
    for (const session of sessions) {
      if (session.status === 'archived') continue
      const items = grouped.get(session.projectId)
      if (items) items.push(session)
      else grouped.set(session.projectId, [session])
    }
    return grouped
  }, [sessions])
  const rows = useMemo(() => {
    const result: NavigationRow[] = []
    for (const project of projects) {
      result.push({ kind: 'project', project })
      if (collapsedProjectIds.has(project.id)) continue
      for (const session of sessionsByProject.get(project.id) ?? []) {
        result.push({ kind: 'session', session })
      }
      if (projectPages[project.id]?.nextCursor) {
        result.push({ kind: 'loadMore', projectId: project.id })
      }
    }
    return result
  }, [collapsedProjectIds, projectPages, projects, sessionsByProject])
  const getRowKey = useCallback(
    (index: number) => {
      const row = rows[index]
      return row?.kind === 'project'
        ? `project:${row.project.id}`
        : row?.kind === 'session'
          ? `session:${row.session.id}`
          : row
            ? `load-more:${row.projectId}`
            : `missing:${index}`
    },
    [rows],
  )
  const getRowHeight = useCallback(
    (index: number) => {
      const row = rows[index]
      return row?.kind === 'project'
        ? rows[index + 1]?.kind !== 'project' && rows[index + 1]
          ? 46
          : 40
        : 34
    },
    [rows],
  )
  // TanStack Virtual owns scroll measurements; React Compiler must not memoize its functions.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: getRowKey,
    estimateSize: getRowHeight,
    overscan: 6,
    useFlushSync: false,
  })
  const virtualRows = virtualizer.getVirtualItems()
  const projectRowIndexes = useMemo(() => {
    const indexes = new Map<string, number>()
    rows.forEach((row, index) => {
      if (row.kind === 'project') indexes.set(row.project.id, index)
    })
    return indexes
  }, [rows])
  const projectSpans = useMemo(() => {
    const spans: { rowIndex: number; offset: number }[] = []
    let offset = 0
    rows.forEach((row, index) => {
      if (row.kind === 'project') spans.push({ rowIndex: index, offset })
      offset += getRowHeight(index)
    })
    return { spans, totalHeight: offset }
  }, [getRowHeight, rows])
  const firstVirtualIndex = virtualRows[0]?.index ?? 0
  const lastVirtualIndex = virtualRows.at(-1)?.index ?? Math.min(rows.length - 1, 10)
  const firstProjectIndex = Math.max(
    0,
    projectSpans.spans.findLastIndex((span) => span.rowIndex <= firstVirtualIndex),
  )
  const lastProjectIndex = Math.max(
    firstProjectIndex,
    projectSpans.spans.findLastIndex((span) => span.rowIndex <= lastVirtualIndex),
  )
  const topSpacerHeight = projectSpans.spans[firstProjectIndex]?.offset ?? 0
  const bottomSpacerHeight =
    projectSpans.totalHeight -
    (projectSpans.spans[lastProjectIndex + 1]?.offset ?? projectSpans.totalHeight)

  useLayoutEffect(() => {
    const index = pendingFocusIndex.current
    if (index === undefined) return
    const button = scrollRef.current?.querySelector<HTMLButtonElement>(
      `[data-nav-index="${index}"] button[data-nav-primary]`,
    )
    if (!button) return
    button.focus({ preventScroll: true })
    pendingFocusIndex.current = undefined
  }, [virtualRows])

  useLayoutEffect(() => {
    const index = scrollFocusIndex.current
    if (index === undefined || document.activeElement !== document.body) return
    const nearest = Math.max(firstVirtualIndex, Math.min(index, lastVirtualIndex))
    const button = scrollRef.current?.querySelector<HTMLButtonElement>(
      `[data-nav-index="${nearest}"] button[data-nav-primary]`,
    )
    button?.focus({ preventScroll: true })
    scrollFocusIndex.current = undefined
  }, [firstVirtualIndex, lastVirtualIndex])

  return (
    <div className="flex h-full min-h-72 flex-col p-group" data-pact-surface>
      <div className="flex h-8 items-center justify-between gap-group px-1">
        <h2 className="text-caption font-medium uppercase tracking-wide text-tertiary">Projects</h2>
        <button
          className="grid size-7 place-items-center rounded-control text-secondary hover:bg-surface-raised hover:text-primary disabled:cursor-wait disabled:opacity-55"
          type="button"
          aria-label="Add project"
          title="Add project"
          disabled={adding || Boolean(archivingProjectId || renamingProjectId)}
          onClick={onAddProject}
        >
          {adding ? (
            <span className="primary-action-spinner" aria-hidden="true" />
          ) : (
            <FolderPlus aria-hidden="true" className="size-4" strokeWidth={1.75} />
          )}
        </button>
      </div>

      {loading && projects.length === 0 ? (
        <div className="mt-group space-y-2" aria-label="Loading projects" aria-busy="true">
          <div className="h-9 animate-pulse rounded-control bg-surface-raised" />
          <div className="h-9 animate-pulse rounded-control bg-surface-raised" />
        </div>
      ) : null}

      {/* Keyboard events are delegated from the real Project/Session buttons. */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <nav
        ref={scrollRef}
        className="mt-group min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        aria-label="Projects and Sessions"
        aria-describedby="pact-navigation-keyboard-help"
        onScroll={() => {
          const focused = document.activeElement
          scrollFocusIndex.current =
            focused instanceof HTMLElement && scrollRef.current?.contains(focused)
              ? Number(focused.closest('[data-nav-index]')?.getAttribute('data-nav-index'))
              : undefined
        }}
        onKeyDown={(event) => {
          const target = event.target
          if (!(target instanceof HTMLElement) || !target.matches('button[data-nav-primary]'))
            return
          const currentIndex = Number(
            target.closest('[data-nav-index]')?.getAttribute('data-nav-index'),
          )
          if (!Number.isInteger(currentIndex) || rows.length === 0) return
          const nextIndex =
            event.key === 'ArrowDown'
              ? Math.min(currentIndex + 1, rows.length - 1)
              : event.key === 'ArrowUp'
                ? Math.max(currentIndex - 1, 0)
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? rows.length - 1
                    : undefined
          if (nextIndex === undefined) return
          event.preventDefault()
          pendingFocusIndex.current = nextIndex
          virtualizer.scrollToIndex(nextIndex, { align: 'auto' })
          const button = scrollRef.current?.querySelector<HTMLButtonElement>(
            `[data-nav-index="${nextIndex}"] button[data-nav-primary]`,
          )
          if (button) {
            button.focus({ preventScroll: true })
            pendingFocusIndex.current = undefined
          }
        }}
      >
        <span id="pact-navigation-keyboard-help" className="sr-only">
          Use the arrow keys to move through Projects and Sessions.
        </span>
        <ul className="m-0 list-none p-0">
          {topSpacerHeight > 0 ? (
            <li aria-hidden="true" style={{ height: topSpacerHeight }} />
          ) : null}
          {projects.slice(firstProjectIndex, lastProjectIndex + 1).map((project) => {
            const collapsed = collapsedProjectIds.has(project.id)
            const projectSessions = collapsed ? [] : (sessionsByProject.get(project.id) ?? [])
            const hasMore = Boolean(projectPages[project.id]?.nextCursor)
            const loadingMore = loadingMoreProjectId === project.id
            const loadMoreError = loadMoreErrors[project.id]
            const projectRowIndex = projectRowIndexes.get(project.id) ?? 0
            const firstVisibleSession = Math.min(
              projectSessions.length,
              Math.max(0, firstVirtualIndex - projectRowIndex - 1),
            )
            const afterLastVisibleSession = Math.max(
              firstVisibleSession,
              Math.min(projectSessions.length, lastVirtualIndex - projectRowIndex),
            )
            return (
              <li
                key={project.id}
                className="group/project relative pb-1"
                data-project-menu={project.id}
                data-nav-index={projectRowIndex}
              >
                <ProjectNavigationHeader
                  project={project}
                  collapsed={collapsed}
                  saving={renamingProjectId === project.id}
                  archiving={archivingProjectId === project.id}
                  actionsPending={adding || Boolean(archivingProjectId || renamingProjectId)}
                  onToggle={() => {
                    setCollapsedProjectIds((current) => {
                      const next = new Set(current)
                      if (next.has(project.id)) next.delete(project.id)
                      else next.add(project.id)
                      return next
                    })
                  }}
                  onRename={(name) => onRenameProject(project.id, name)}
                  onStartSession={() => onStartSession(project.id)}
                  onArchive={() => onArchiveProject(project.id)}
                />

                {!collapsed && (projectSessions.length > 0 || hasMore) ? (
                  <ul className="m-0 mt-1.5 list-none pl-group">
                    {firstVisibleSession > 0 ? (
                      <li aria-hidden="true" style={{ height: firstVisibleSession * 34 }} />
                    ) : null}
                    {projectSessions
                      .slice(firstVisibleSession, afterLastVisibleSession)
                      .map((session, offset) => (
                        <li
                          key={session.id}
                          className="group/session relative pb-0.5"
                          data-session-menu={session.id}
                          data-nav-index={projectRowIndex + 1 + firstVisibleSession + offset}
                          aria-posinset={firstVisibleSession + offset + 1}
                          aria-setsize={projectSessions.length + (hasMore ? 1 : 0)}
                        >
                          <button
                            className="flex min-h-8 w-full items-center gap-2 rounded-control py-1.5 pl-2 pr-9 text-left text-caption text-secondary transition-colors duration-150 hover:bg-surface-raised hover:text-primary data-[selected=true]:bg-navigation-selected data-[selected=true]:font-medium data-[selected=true]:text-primary"
                            data-selected={selectedSessionId === session.id}
                            aria-current={selectedSessionId === session.id ? 'page' : undefined}
                            aria-label={session.title}
                            data-nav-primary
                            type="button"
                            onClick={() => {
                              onSelectSession(session.id)
                            }}
                          >
                            <MessageSquare
                              aria-hidden="true"
                              className="size-3.5 shrink-0"
                              strokeWidth={1.75}
                            />
                            <span className="min-w-0 flex-1 truncate">{session.title}</span>
                            <SessionActivityIndicator
                              activity={session.activity}
                              hasUnread={session.hasUnread}
                              selected={selectedSessionId === session.id}
                            />
                          </button>
                          <button
                            className="pointer-events-none absolute right-0.5 top-0.5 grid size-7 place-items-center rounded-control text-tertiary opacity-0 transition-[opacity,background-color,color] duration-150 ease-out hover:bg-surface-muted/50 hover:text-danger focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100 disabled:cursor-wait disabled:opacity-55 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
                            type="button"
                            aria-label={`Archive Session ${session.title}`}
                            title={
                              archivingSessionId === session.id ? 'Archiving…' : 'Archive Session'
                            }
                            disabled={archivingSessionId === session.id}
                            onClick={() => onArchiveSession(session.id)}
                          >
                            {archivingSessionId === session.id ? (
                              <LoaderCircle
                                aria-hidden="true"
                                className="size-4 animate-spin"
                                strokeWidth={1.75}
                              />
                            ) : (
                              <Archive aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                            )}
                          </button>
                        </li>
                      ))}
                    {afterLastVisibleSession < projectSessions.length ? (
                      <li
                        aria-hidden="true"
                        style={{ height: (projectSessions.length - afterLastVisibleSession) * 34 }}
                      />
                    ) : null}
                    {hasMore ? (
                      <li
                        className="pb-0.5"
                        data-nav-index={projectRowIndex + 1 + projectSessions.length}
                        aria-posinset={projectSessions.length + 1}
                        aria-setsize={projectSessions.length + 1}
                      >
                        <button
                          className="flex min-h-8 w-full items-center gap-2 rounded-control py-1.5 pl-2 pr-2 text-left text-caption text-secondary transition-colors duration-150 hover:bg-surface-muted hover:text-primary focus-visible:text-primary disabled:cursor-wait"
                          type="button"
                          data-nav-primary
                          disabled={loadingMore}
                          aria-label={
                            loadMoreError
                              ? `Retry loading Sessions in ${project.name}: ${loadMoreError}`
                              : `Load more Sessions in ${project.name}`
                          }
                          title={loadMoreError || 'Load five more Sessions'}
                          onClick={() => {
                            const firstNewIndex = projectRowIndex + 1 + projectSessions.length
                            void onLoadMoreSessions(project.id).then((added) => {
                              if (added <= 0) return undefined
                              pendingFocusIndex.current = firstNewIndex
                              virtualizer.scrollToIndex(firstNewIndex, { align: 'auto' })
                              return undefined
                            })
                          }}
                        >
                          {loadingMore ? (
                            <LoaderCircle
                              aria-hidden="true"
                              className="size-3.5 shrink-0 animate-spin"
                              strokeWidth={1.8}
                            />
                          ) : (
                            <ChevronDown
                              aria-hidden="true"
                              className="size-3.5 shrink-0"
                              strokeWidth={1.75}
                            />
                          )}
                          <span className="truncate">
                            {loadingMore
                              ? 'Loading Sessions…'
                              : loadMoreError
                                ? 'Couldn’t load · Retry'
                                : 'Load more sessions'}
                          </span>
                        </button>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </li>
            )
          })}
          {bottomSpacerHeight > 0 ? (
            <li aria-hidden="true" style={{ height: bottomSpacerHeight }} />
          ) : null}
        </ul>
      </nav>

      {loading && projects.length > 0 ? (
        <output className="mt-group px-2 text-caption text-tertiary" aria-live="polite">
          Loading Sessions…
        </output>
      ) : null}

      {error ? (
        <div className="mt-group px-2 text-caption text-danger" role="alert">
          <p>{error}</p>
          <button
            className="mt-1 rounded-control text-caption font-medium underline underline-offset-2 hover:text-primary"
            type="button"
            onClick={onRetrySessions}
          >
            Retry loading Sessions
          </button>
        </div>
      ) : null}

      <button
        ref={settingsButtonRef}
        className="mt-auto flex min-h-9 w-full items-center gap-group rounded-control px-group py-2 text-left text-body font-medium text-primary hover:bg-surface-raised"
        type="button"
        onClick={() => onOpenSettings('session-defaults')}
      >
        <Settings aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
        Settings
        {updateAvailable ? (
          <span className="ml-auto text-caption font-medium text-focus">New</span>
        ) : null}
      </button>
    </div>
  )
}

interface ProjectNavigationHeaderProps {
  project: Project
  collapsed: boolean
  saving: boolean
  archiving: boolean
  actionsPending: boolean
  onToggle: () => void
  onRename: (name: string) => Promise<RpcResult<ProjectNameChange>>
  onStartSession: () => void
  onArchive: () => void
}

function ProjectNavigationHeader({
  project,
  collapsed,
  saving,
  archiving,
  actionsPending,
  onToggle,
  onRename,
  onStartSession,
  onArchive,
}: ProjectNavigationHeaderProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.name)
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLButtonElement>(null)
  const savePending = useRef(false)
  const returnFocus = useRef(false)
  const errorId = useId()

  useLayoutEffect(() => {
    if (editing) inputRef.current?.select()
    else if (returnFocus.current) {
      returnFocus.current = false
      nameRef.current?.focus({ preventScroll: true })
    }
  }, [editing])

  const beginEditing = (): void => {
    if (actionsPending) return
    setDraft(project.name)
    setError(undefined)
    setEditing(true)
  }
  const finishEditing = (): void => {
    returnFocus.current = true
    setError(undefined)
    setEditing(false)
  }
  const handleEditorKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement | HTMLButtonElement>,
  ): void => {
    if (event.key === 'Escape' && !saving && !savePending.current) {
      event.preventDefault()
      finishEditing()
    }
    // IME confirmation must not submit the Project name.
    if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
  }
  const save = async (): Promise<void> => {
    if (actionsPending || savePending.current) return
    const parsed = projectNameChangeSchema.safeParse({ projectId: project.id, name: draft })
    if (!parsed.success) {
      setError(
        draft.trim()
          ? `Use a single-line name of up to ${PROJECT_NAME_LIMIT} characters.`
          : 'Enter a Project name.',
      )
      inputRef.current?.focus()
      return
    }
    if (parsed.data.name === project.name) {
      finishEditing()
      return
    }
    savePending.current = true
    setError(undefined)
    try {
      const result = await onRename(parsed.data.name)
      if (result.ok) finishEditing()
      else {
        setError(result.error.message)
        inputRef.current?.focus()
      }
    } catch {
      setError('Couldn’t save the name. Try again.')
      inputRef.current?.focus()
    } finally {
      savePending.current = false
    }
  }

  return (
    <div className="group/project-header relative flex h-9 items-center gap-1 rounded-control pl-0.5 pr-1 hover:bg-surface-raised">
      <button
        className="grid size-7 shrink-0 place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary"
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} Project ${project.name}`}
        aria-expanded={!collapsed}
        title={`${collapsed ? 'Expand' : 'Collapse'} Project`}
        data-nav-primary
        type="button"
        onClick={onToggle}
      >
        <span className="relative size-4" aria-hidden="true">
          <FolderOpen
            className={`absolute inset-0 size-4 transition-[opacity,transform] duration-150 ease-out ${collapsed ? 'scale-90 opacity-0' : 'scale-100 opacity-100'}`}
            strokeWidth={1.75}
          />
          <FolderClosed
            className={`absolute inset-0 size-4 transition-[opacity,transform] duration-150 ease-out ${collapsed ? 'scale-100 opacity-100' : 'scale-90 opacity-0'}`}
            strokeWidth={1.75}
          />
        </span>
      </button>
      {editing ? (
        <form
          className="relative flex h-8 min-w-0 flex-1 items-center gap-0.5 rounded-control border border-focus bg-surface-raised p-px focus-within:outline-2 focus-within:outline-focus focus-within:outline-offset-1"
          aria-label={`Rename Project ${project.name}`}
          aria-busy={saving}
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <input
            ref={inputRef}
            className="h-full min-w-0 flex-1 rounded-control bg-transparent px-1.5 text-body text-primary caret-focus focus-visible:outline-none"
            aria-label="Project name"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            autoComplete="off"
            spellCheck={false}
            maxLength={PROJECT_NAME_LIMIT}
            readOnly={saving}
            value={draft}
            onKeyDown={handleEditorKeyDown}
            onChange={(event) => {
              setDraft(event.target.value)
              setError(undefined)
            }}
          />
          <button
            className="grid size-7 shrink-0 place-items-center rounded-control bg-focus/10 text-focus transition-colors duration-150 hover:bg-focus/20 disabled:cursor-wait disabled:opacity-55"
            type="submit"
            aria-label="Save Project name"
            title="Save name (Enter)"
            disabled={actionsPending}
            onKeyDown={handleEditorKeyDown}
          >
            {saving ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-3.5 animate-spin"
                strokeWidth={1.75}
              />
            ) : (
              <Check aria-hidden="true" className="size-4" strokeWidth={1.75} />
            )}
          </button>
          <button
            className="grid size-7 shrink-0 place-items-center rounded-control text-secondary transition-colors duration-150 hover:bg-surface-muted hover:text-primary disabled:cursor-wait disabled:opacity-55"
            type="button"
            aria-label="Cancel Project rename"
            title="Cancel (Esc)"
            disabled={saving}
            onKeyDown={handleEditorKeyDown}
            onClick={finishEditing}
          >
            <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </button>
          {error ? (
            <p
              id={errorId}
              role="alert"
              className="absolute left-0 right-0 top-full z-20 mt-1 flex items-start gap-1.5 rounded-control border border-border bg-surface-raised px-2 py-1.5 text-caption text-danger"
            >
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0"
                strokeWidth={1.75}
              />
              <span>{error}</span>
            </p>
          ) : null}
        </form>
      ) : (
        <>
          <button
            ref={nameRef}
            className="h-8 min-w-0 flex-1 truncate rounded-control text-left text-body text-primary group-hover/project-header:mr-[5.25rem] group-focus-within/project-header:mr-[5.25rem] disabled:cursor-wait [@media(hover:none)]:mr-[5.25rem]"
            type="button"
            aria-label={`Rename Project ${project.name}`}
            title={`${project.directoryPath}\nClick to rename`}
            disabled={actionsPending}
            onClick={beginEditing}
          >
            {project.name}
          </button>
          <div className="pointer-events-none absolute right-1 top-1 flex items-center opacity-0 transition-opacity duration-150 ease-out group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
            <button
              className="grid size-7 place-items-center rounded-control text-tertiary hover:bg-surface-muted hover:text-primary"
              type="button"
              aria-label={`New Session in ${project.name}`}
              title="New Session"
              onClick={onStartSession}
            >
              <Plus aria-hidden="true" className="size-4" strokeWidth={1.75} />
            </button>
            <button
              className="grid size-7 place-items-center rounded-control text-tertiary hover:bg-surface-muted hover:text-primary disabled:cursor-wait disabled:opacity-55"
              type="button"
              aria-label={`Edit Project ${project.name}`}
              title="Rename Project"
              disabled={actionsPending}
              onClick={beginEditing}
            >
              <Pencil aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
            </button>
            <button
              className="grid size-7 place-items-center rounded-control text-tertiary transition-colors duration-150 hover:bg-surface-muted/50 hover:text-danger disabled:cursor-wait disabled:opacity-55"
              type="button"
              aria-label={`Archive Project ${project.name}`}
              title={archiving ? 'Archiving…' : 'Archive Project'}
              disabled={actionsPending}
              onClick={onArchive}
            >
              {archiving ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="size-4 animate-spin"
                  strokeWidth={1.75}
                />
              ) : (
                <Archive aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              )}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function SessionActivityIndicator({
  activity,
  hasUnread,
  selected,
}: {
  activity: SessionActivity
  hasUnread: boolean
  selected: boolean
}): React.JSX.Element | null {
  if (activity.state === 'idle') {
    if (selected || !hasUnread) return null
    return (
      <output
        className="grid size-6 shrink-0 place-items-center"
        aria-label="New reply"
        title="New reply"
      >
        <span aria-hidden="true" className="size-1.5 rounded-pill bg-focus" />
      </output>
    )
  }
  const agentName =
    activity.agentId === 'claude' ? 'Claude Code' : activity.agentId === 'codex' ? 'Codex' : 'Agent'
  const details = {
    agent_working: {
      label: `${agentName} is working`,
      className: 'text-status-ready-foreground',
      icon: <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" strokeWidth={1.8} />,
    },
    recovering: {
      label: `Recovering ${agentName}${activity.attemptCount ? ` · attempt ${activity.attemptCount} of ${MAX_AGENT_RUN_ATTEMPTS}` : ''}`,
      className: 'text-status-warning-foreground',
      icon: (
        <RefreshCw
          aria-hidden="true"
          className="session-activity-spin size-3.5"
          strokeWidth={1.8}
        />
      ),
    },
    waiting_for_user: {
      label: 'Waiting for your reply',
      className: 'text-status-info-foreground',
      icon: <Reply aria-hidden="true" className="size-3.5" strokeWidth={1.8} />,
    },
    error: {
      label: `${agentName} encountered an error`,
      className: 'text-status-danger-foreground',
      icon: <CircleAlert aria-hidden="true" className="size-3.5" strokeWidth={1.8} />,
    },
    interrupted: {
      label: `${agentName} was interrupted`,
      className: 'text-status-warning-foreground',
      icon: <CirclePause aria-hidden="true" className="size-3.5" strokeWidth={1.8} />,
    },
    paused: {
      label: 'Session paused',
      className: 'text-status-warning-foreground',
      icon: <CirclePause aria-hidden="true" className="size-3.5" strokeWidth={1.8} />,
    },
    completed: {
      label: 'Session completed',
      className: 'text-status-ready-foreground',
      icon: <CircleCheck aria-hidden="true" className="size-3.5" strokeWidth={1.8} />,
    },
  }[activity.state]
  return (
    <output
      className={`grid size-6 shrink-0 place-items-center ${details.className}`}
      aria-label={details.label}
      title={details.label}
    >
      {details.icon}
    </output>
  )
}
