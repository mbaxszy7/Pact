import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Archive,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Check,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Pencil,
  RefreshCw,
  Reply,
  Settings,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import type {
  CollaborationSession,
  Project,
  ProjectNameChange,
  RpcResult,
  SessionActivity,
  SessionGroup,
  SessionGroupPlacement,
  SessionGroupColor,
  SessionGroupPage,
  SessionGroupPageInput,
  SessionPageInput,
} from '@pact/contracts'

import {
  MAX_AGENT_RUN_ATTEMPTS,
  PROJECT_NAME_LIMIT,
  SESSION_GROUP_COLORS,
  SESSION_GROUP_NAME_LIMIT,
  projectNameChangeSchema,
  sessionGroupNameSchema,
} from '@pact/contracts'

import type { SettingsPage } from './SettingsNavigation'
import type { SessionWorkspaceFlow } from './useSessionWorkspace'

import { scopeKey, UNGROUPED } from './session-catalog-cache'
import {
  useNavigationRowMotion,
  useSessionNavigationDrag,
  type DragSource,
  type DropTarget,
  type NavigationDropRow,
} from './session-navigation-drag'
// oxlint-disable-next-line import/no-unassigned-import -- Scoped navigation styles.
import './session-navigation.css'

export interface NavigationIntent {
  projectId: string
  sessionId: string
  focus: boolean
}

interface ProjectNavigationProps {
  projects: Project[]
  sessions: CollaborationSession[]
  workspace: SessionWorkspaceFlow
  navigationIntent?: NavigationIntent | undefined
  loading: boolean
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
  onStartSession: (projectId: string, groupId?: string) => void
  onSelectSession: (sessionId: string) => void
  onArchiveSession: (sessionId: string) => void
}

type ReadRow =
  | {
      kind: 'session-page'
      input: SessionPageInput
      label: string
      group?: SessionGroup | undefined
      bodyHead?: boolean
      bodyTail?: boolean
    }
  | { kind: 'group-page'; input: SessionGroupPageInput; label: string }

type NavigationRow =
  | ({ key: string } & ReadRow)
  | { key: string; kind: 'project'; project: Project; afterGroups: boolean }
  | {
      key: string
      kind: 'session'
      session: CollaborationSession
      group?: SessionGroup | undefined
      bodyHead?: boolean
      bodyTail?: boolean
      pending?: boolean
    }
  | {
      key: string
      kind: 'drop-slot'
      projectId: string
      placement?: SessionGroupPlacement | undefined
      group?: SessionGroup | undefined
      bodyHead?: boolean
      bodyTail?: boolean
    }
  | { key: string; kind: 'group'; group: SessionGroup; collapsed: boolean }

interface GroupEditorState {
  anchor: HTMLButtonElement
  error?: string | undefined
  projectId: string
  id?: string
  sessionId?: string
  name: string
  color: SessionGroupColor
}

type MenuTarget =
  | { kind: 'project'; project: Project }
  | { kind: 'group'; group: SessionGroup }
  | { kind: 'session'; session: CollaborationSession }

interface MenuState {
  target: MenuTarget
  key: string
  anchor: HTMLButtonElement
  picker?: boolean
  page?: SessionGroupPage
  pending?: boolean
  error?: string
}

const ACTION =
  'grid size-7 shrink-0 place-items-center rounded-control text-tertiary hover:bg-surface-muted hover:text-primary disabled:opacity-55'
const MENU_ITEM =
  'flex min-h-8 w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left text-caption text-primary hover:bg-surface-muted focus:bg-surface-muted disabled:opacity-50'

function anchoredOverlayStyle(
  anchor: HTMLButtonElement,
  preferredWidth: number,
  preferredHeight: number,
): React.CSSProperties {
  const bounds = anchor.getBoundingClientRect()
  const width = Math.min(preferredWidth, window.innerWidth - 16)
  const below = window.innerHeight - bounds.bottom - 12
  const above = bounds.top - 12
  const openAbove = below < preferredHeight && above > below
  return {
    width,
    maxHeight: Math.max(0, openAbove ? above : below),
    left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
    ...(openAbove ? { bottom: window.innerHeight - bounds.top + 4 } : { top: bounds.bottom + 4 }),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The navigation could not be loaded.'
}

export function ProjectNavigation({
  projects,
  sessions,
  workspace,
  navigationIntent,
  loading,
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
  onStartSession,
  onSelectSession,
  onArchiveSession,
}: ProjectNavigationProps): React.JSX.Element {
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set())
  const [revealedGroupId, setRevealedGroupId] = useState<string>()
  const [editor, setEditor] = useState<GroupEditorState>()
  const [menu, setMenu] = useState<MenuState>()
  const [readState, setReadState] = useState<{ key: string; error?: string }>()
  const [notice, setNotice] = useState<{ message: string; visible?: boolean }>()
  const [moving, setMoving] = useState<{
    session: CollaborationSession
    groupId: string | null
    placement?: SessionGroupPlacement | undefined
  }>()
  const [locationError, setLocationError] = useState<{
    intent: NavigationIntent
    message: string
  }>()
  const [dissolve, setDissolve] = useState<
    { phase: 'confirming'; group: SessionGroup } | { phase: 'refreshing' }
  >()
  const dissolving = dissolve?.phase === 'confirming' ? dissolve.group : undefined
  const [highlight, setHighlight] = useState<string>()
  const [jump, setJump] = useState<{ key: string; focus: boolean }>()
  const scrollRef = useRef<HTMLElement>(null)
  const dropRows = useRef<NavigationDropRow[]>([])
  const updateDropRows = useCallback((mounted: NavigationDropRow[]) => {
    dropRows.current = mounted
  }, [])
  const menuRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLFormElement>(null)
  const editorInput = useRef<HTMLInputElement>(null)
  const dissolveDialog = useRef<HTMLDialogElement>(null)
  const cancelDissolve = useRef<HTMLButtonElement>(null)
  const dissolveHeadingId = useId()
  const dissolveDescriptionId = useId()
  const editorAnchor = editor?.anchor
  useLayoutEffect(() => {
    if (editorAnchor) editorInput.current?.focus({ preventScroll: true })
  }, [editorAnchor])
  useLayoutEffect(() => {
    if (!dissolving) return undefined
    const dialog = dissolveDialog.current
    dialog?.showModal()
    cancelDissolve.current?.focus()
    return () => dialog?.close()
  }, [dissolving])
  const highlightTimer = useRef<number | undefined>(undefined)
  const pendingFocus = useRef<string | undefined>(undefined)
  const readInFlight = useRef(false)
  const intentGeneration = useRef(0)
  const lastExternalIntent = useRef<NavigationIntent | undefined>(undefined)
  const menuButtonId = useId()
  const navigation = workspace.catalog?.navigation
  // The explicit post-dissolve read owns navigation until the saved layout is ready.
  const busy =
    workspace.writingOrganization || workspace.creating || dissolve?.phase === 'refreshing'

  const expandProject = (projectId: string): void => {
    setCollapsedProjects((current) => {
      if (!current.has(projectId)) return current
      const next = new Set(current)
      next.delete(projectId)
      return next
    })
  }

  const locate = async (
    intent: NavigationIntent,
    generation = ++intentGeneration.current,
    saved = false,
  ): Promise<void> => {
    const current = () => generation === intentGeneration.current
    if (!current()) return
    setLocationError(undefined)
    try {
      const located = await workspace.locate(
        {
          projectId: intent.projectId,
          sessionId: intent.sessionId,
        },
        current,
      )
      if (!located || !current()) return
      expandProject(intent.projectId)
      setJump({ key: `session:${intent.sessionId}`, focus: intent.focus })
      setHighlight(intent.sessionId)
      window.clearTimeout(highlightTimer.current)
      highlightTimer.current = window.setTimeout(() => setHighlight(undefined), 1500)
    } catch (failure) {
      if (current())
        setLocationError({
          intent,
          message: saved ? 'Saved · Couldn’t locate the Session' : errorMessage(failure),
        })
    }
  }

  const locateExternal = useEffectEvent((intent: NavigationIntent | undefined): void => {
    const previous = lastExternalIntent.current
    lastExternalIntent.current = intent
    if (!intent) {
      if (previous) {
        intentGeneration.current++
        setLocationError(undefined)
      }
      return
    }
    void locate(intent)
  })
  useEffect(() => {
    locateExternal(navigationIntent)
  }, [navigationIntent])

  useEffect(
    () => () => {
      intentGeneration.current++
      window.clearTimeout(highlightTimer.current)
    },
    [],
  )

  const moveSession = async (
    session: CollaborationSession,
    groupId: string | null,
    focus: boolean,
    placement?: SessionGroupPlacement,
  ): Promise<void> => {
    if (busy || ((session.groupId ?? null) === groupId && !placement)) return
    const generation = ++intentGeneration.current
    const target = navigation?.projects[session.projectId]?.groups?.groups.find(
      (group) => group.id === groupId,
    )
    setMoving({ session, groupId, placement })
    setNotice({ message: target ? `Moving to ${target.name}…` : 'Moving Session…' })
    const saved = await workspace.setGroup({
      projectId: session.projectId,
      sessionId: session.id,
      groupId,
      placement,
    })
    setNotice(saved ? { message: target ? `Moved to ${target.name}` : 'Session moved' } : undefined)
    try {
      if (saved)
        await locate(
          { projectId: session.projectId, sessionId: session.id, focus },
          generation,
          true,
        )
    } finally {
      setMoving(undefined)
    }
  }

  const moveGroup = async (
    group: SessionGroup,
    movement:
      | { direction: 'up' | 'down' }
      | { targetGroupId: string; placement: 'before' | 'after' },
    focus: boolean,
  ): Promise<void> => {
    const generation = ++intentGeneration.current
    const saved = await workspace.moveGroup({
      projectId: group.projectId,
      groupId: group.id,
      ...movement,
    })
    if (!saved) return
    setNotice({ message: `Moved ${group.name}` })
    await loadGroupWindow(group.projectId, group.id, focus, generation)
  }

  const drop = (source: DragSource, target: DropTarget, origin: { x: number; y: number }): void => {
    recordDrop(`${source.kind}:${source.id}`, origin)
    if (source.kind === 'session' && target.kind === 'membership') {
      const session = sessions.find((item) => item.id === source.id)
      if (session) void moveSession(session, target.groupId, false, target.placement)
    }
    if (source.kind === 'group' && target.kind === 'order') {
      const group = navigation?.projects[source.projectId]?.groups?.groups.find(
        (item) => item.id === source.id,
      )
      if (group)
        void moveGroup(group, { targetGroupId: target.groupId, placement: target.placement }, false)
    }
  }
  const drag = useSessionNavigationDrag(scrollRef, dropRows, drop, (sessionId, origin) => {
    recordDrop(`session:${sessionId}`, origin)
  })

  const rows = useMemo(() => {
    const entities = new Map(sessions.map((session) => [session.id, session]))
    const result: NavigationRow[] = []
    for (const project of projects) {
      const id = project.id
      const state = navigation?.projects[id]
      const previous = result.at(-1)
      const afterGroups = Boolean(
        previous && (previous.kind === 'group-page' || ('group' in previous && previous.group)),
      )
      result.push({ key: `project:${id}`, kind: 'project', project, afterGroups })
      if (collapsedProjects.has(id)) continue
      const movingSession = moving?.session.projectId === id ? moving.session : undefined
      const targetGroupId =
        movingSession &&
        moving &&
        (!moving.groupId || state?.groups?.groups.some((group) => group.id === moving.groupId))
          ? moving.groupId
          : (movingSession?.groupId ?? null)
      const dragged =
        drag.source?.kind === 'session' && drag.source.projectId === id
          ? entities.get(drag.source.id)
          : undefined
      const slotFor = (group?: SessionGroup): CollaborationSession | undefined =>
        drag.membershipTarget?.groupId === (group?.id ?? null) ? dragged : undefined
      const dropSlot = (session: CollaborationSession, group?: SessionGroup) => {
        const placement = drag.membershipTarget?.placement
        const anchorId = placement && placement.kind !== 'first' ? placement.sessionId : ''
        return {
          key: `drop-slot:${session.id}:${group?.id ?? ''}:${placement?.kind ?? ''}:${anchorId}`,
          kind: 'drop-slot' as const,
          projectId: id,
          placement,
          group,
          bodyHead: true,
          bodyTail: true,
        }
      }
      const addScope = (group?: SessionGroup): void => {
        const start = result.length
        const scope = group ? ({ kind: 'group', groupId: group.id } as const) : UNGROUPED
        const window = state?.windows[scopeKey(scope)]
        const base = { projectId: id, scope }
        const addPage = (direction: 'newer' | 'older'): void => {
          const cursor = window?.refresh
            ? undefined
            : direction === 'older'
              ? window?.nextCursor
              : window?.previousCursor
          if (window && !window.refresh && !cursor) return
          result.push({
            kind: 'session-page',
            key: `sessions:${id}:${scopeKey(scope)}:${direction}`,
            input: { ...base, cursor },
            group,
            label: window?.refresh
              ? 'Refresh Sessions'
              : window
                ? direction === 'older'
                  ? `Load more Sessions in ${group?.name ?? project.name}`
                  : 'Load newer Sessions'
                : 'Load Sessions',
          })
        }
        if (window?.previousCursor && !window.refresh) addPage('newer')
        const pending = targetGroupId === (group?.id ?? null) ? movingSession : undefined
        const slot = pending ? undefined : slotFor(group)
        const arrival = pending ?? slot
        let placed = false
        const placeArrival = (): void => {
          if (!arrival || placed) return
          placed = true
          result.push(
            pending
              ? {
                  key: `session:${pending.id}`,
                  kind: 'session',
                  session: pending,
                  group,
                  pending: true,
                }
              : { ...dropSlot(arrival, group), bodyHead: false, bodyTail: false },
          )
        }
        const placement = group
          ? pending
            ? moving?.placement
            : drag.membershipTarget?.placement
          : undefined
        if (group && (!placement || placement.kind === 'first')) placeArrival()
        for (const sessionId of window?.ids ?? []) {
          if (sessionId === dragged?.id || sessionId === movingSession?.id) continue
          const session = entities.get(sessionId)
          if (
            !session ||
            session.status === 'archived' ||
            session.sidebarHidden ||
            (session.groupId ?? null) !== (group?.id ?? null)
          )
            continue
          if (
            (placement?.kind === 'before' && placement.sessionId === sessionId) ||
            (!group &&
              arrival &&
              (arrival.createdAt > session.createdAt ||
                (arrival.createdAt === session.createdAt && arrival.id > session.id)))
          )
            placeArrival()
          result.push({ key: `session:${session.id}`, kind: 'session', session, group })
          if (placement?.kind === 'after' && placement.sessionId === sessionId) placeArrival()
        }
        placeArrival()
        if (window?.refresh || window?.nextCursor || (!window && (group || !loading || state)))
          addPage('older')
        if (group && result.length > start) {
          const first = result[start]
          const last = result.at(-1)
          if (
            first?.kind === 'session' ||
            first?.kind === 'session-page' ||
            first?.kind === 'drop-slot'
          )
            first.bodyHead = true
          if (
            last?.kind === 'session' ||
            last?.kind === 'session-page' ||
            last?.kind === 'drop-slot'
          )
            last.bodyTail = true
        }
      }
      addScope()
      if (!state?.hasGroups) continue
      const groupPage = state.groups
      const refreshGroups = groupPage && groupPage.revision < state.revision
      if (groupPage?.previousCursor && !refreshGroups)
        result.push({
          kind: 'group-page',
          key: `groups:${id}:newer`,
          label: 'Load earlier groups',
          input: { projectId: id, cursor: groupPage.previousCursor },
        })
      for (const group of groupPage?.groups ?? []) {
        const revealing = highlight && entities.get(highlight)?.groupId === group.id
        const collapsed =
          group.collapsed &&
          group.id !== drag.hoverGroup &&
          group.id !== revealedGroupId &&
          group.id !== moving?.groupId &&
          !revealing
        const header = {
          key: `group:${group.id}`,
          kind: 'group' as const,
          group,
          collapsed,
        }
        result.push(header)
        if (!collapsed) addScope(group)
        else {
          const slot = slotFor(group)
          if (slot) result.push(dropSlot(slot, group))
        }
      }
      if (!groupPage || refreshGroups || groupPage.nextCursor)
        result.push({
          kind: 'group-page',
          key: `groups:${id}:older`,
          label: refreshGroups ? 'Refresh groups' : groupPage ? 'Load more groups' : 'Load groups',
          input: { projectId: id, cursor: refreshGroups ? undefined : groupPage?.nextCursor },
        })
    }
    return result
  }, [
    sessions,
    projects,
    navigation,
    loading,
    collapsedProjects,
    drag.hoverGroup,
    drag.source,
    drag.membershipTarget,
    revealedGroupId,
    highlight,
    moving,
  ])

  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) => {
      const row = rows[index]
      if (row?.kind === 'project') return row.afterGroups ? 48 : 40
      if (row?.kind === 'group') return 44
      return row && 'group' in row && row.group ? 32 : 34
    },
    overscan: 6,
    useFlushSync: false,
  })
  const visibleRows = virtualizer.getVirtualItems()
  const mountedRows = visibleRows.flatMap((item) => rows[item.index] ?? [])
  const viewKey = mountedRows.map((row) => row.key).join(',')
  const recordDrop = useNavigationRowMotion(scrollRef, rows, viewKey, updateDropRows)
  const top = visibleRows[0]?.start ?? 0
  const bottom = virtualizer.getTotalSize() - (visibleRows.at(-1)?.end ?? 0)

  const primary = (key: string): HTMLButtonElement | null | undefined =>
    scrollRef.current?.querySelector<HTMLButtonElement>(
      `[data-nav-key="${CSS.escape(key)}"] [data-nav-primary]`,
    )

  useLayoutEffect(() => {
    if (!jump) return
    const index = rows.findIndex((row) => row.key === jump.key)
    if (index < 0) return
    if (jump.focus) pendingFocus.current = jump.key
    virtualizer.scrollToIndex(index, { align: 'auto' })
    setJump(undefined)
  }, [jump, rows, virtualizer])

  useLayoutEffect(() => {
    const key = pendingFocus.current
    if (!key) return
    const button = primary(key)
    if (button) {
      button.focus({ preventScroll: true })
      pendingFocus.current = undefined
    }
  }, [viewKey, jump])

  useEffect(() => {
    if (!highlight) return
    const groupId = sessions.find((session) => session.id === highlight)?.groupId
    if (groupId) setRevealedGroupId(groupId)
  }, [highlight, sessions])

  const read = async (row: ReadRow & { key: string }, automatic: boolean): Promise<void> => {
    if (readInFlight.current && automatic) return
    if (readInFlight.current && readState?.key === row.key) return
    readInFlight.current = true
    setReadState({ key: row.key })
    try {
      const loaded =
        row.kind === 'session-page'
          ? await workspace.loadPage(row.input, automatic)
          : await workspace.loadGroups(row.input, automatic)
      setReadState(loaded ? undefined : { key: row.key, error: 'Reading is busy. Try again.' })
      if (!automatic && loaded) {
        const index = rows.findIndex((item) => item.key === row.key)
        const next = rows[row.input.cursor?.direction === 'newer' ? index + 1 : index - 1]
        if (next && document.activeElement === document.body)
          setJump({ key: next.key, focus: true })
      }
    } catch (failure) {
      setReadState({ key: row.key, error: errorMessage(failure) })
    } finally {
      readInFlight.current = false
    }
  }

  const readVisible = useEffectEvent((): void => {
    const keys = new Set<string>()
    for (const row of mountedRows) {
      if (row.kind === 'project') keys.add(row.project.id)
      if (row.kind === 'group') {
        keys.add(row.group.id)
        keys.add(row.group.projectId)
      }
      if (row.kind === 'session') {
        keys.add(row.group?.id ?? row.session.projectId)
        keys.add(row.session.projectId)
      }
      if (row.kind === 'session-page' || row.kind === 'group-page') keys.add(row.input.projectId)
    }
    if (drag.source) keys.add(drag.source.projectId)
    workspace.setVisibleWindows(keys)
    if (loading || busy || moving || readInFlight.current || menu || editorAnchor) return
    const row = mountedRows.find(
      (item): item is NavigationRow & ReadRow =>
        (item.kind === 'session-page' || item.kind === 'group-page') &&
        !item.input.cursor &&
        (!drag.source ||
          (item.kind === 'session-page' &&
            drag.hoverGroup !== undefined &&
            item.group?.id === drag.hoverGroup)) &&
        item.key !== readState?.key,
    )
    if (row) void read(row, true)
  })
  useEffect(() => {
    readVisible()
  }, [viewKey, loading, busy, moving, readState, menu, editorAnchor, drag.source, drag.hoverGroup])

  const closeMenu = (focus: boolean): void => {
    if (focus && menu?.anchor.isConnected) menu.anchor.focus({ preventScroll: true })
    setMenu(undefined)
  }
  const closeEditor = (focus: boolean): void => {
    if (busy) return
    if (focus && editorAnchor?.isConnected) editorAnchor.focus({ preventScroll: true })
    setEditor(undefined)
  }

  const overlayAnchor = menu?.anchor ?? editorAnchor
  const closeOverlay = useEffectEvent(() => {
    if (menu) closeMenu(false)
    else closeEditor(false)
  })
  useEffect(() => {
    if (!overlayAnchor) return undefined
    const outside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target) &&
        !editorRef.current?.contains(event.target) &&
        !overlayAnchor.contains(event.target)
      )
        closeOverlay()
    }
    const close = (): void => closeOverlay()
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', close)
    }
  }, [overlayAnchor])
  useLayoutEffect(() => {
    if (menu && !menu.anchor.isConnected) setMenu(undefined)
    else if (menu)
      menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
    if (editorAnchor && !editorAnchor.isConnected && !busy) setEditor(undefined)
  }, [menu, editorAnchor, busy, viewKey])

  const menuButton = (key: string, target: MenuTarget, label: string) => (
    <button
      type="button"
      className={ACTION}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={menu?.key === key}
      aria-controls={menu?.key === key ? menuButtonId : undefined}
      onClick={(event) => {
        drag.cancel()
        if (editorAnchor) {
          if (busy) return
          closeEditor(false)
          if (editorAnchor === event.currentTarget) return
        }
        if (menu?.key === key) closeMenu(true)
        else setMenu({ key, target, anchor: event.currentTarget })
      }}
    >
      <MoreHorizontal aria-hidden="true" className="size-4" strokeWidth={1.8} />
    </button>
  )

  const loadGroupWindow = async (
    projectId: string,
    groupId: string | undefined,
    focus: boolean,
    generation: number,
  ): Promise<void> => {
    try {
      const loaded = await workspace.loadGroups({ projectId, aroundGroupId: groupId })
      if (loaded && generation === intentGeneration.current) {
        expandProject(projectId)
        if (groupId) setJump({ key: `group:${groupId}`, focus })
      }
    } catch (failure) {
      setNotice({ message: `Saved · ${errorMessage(failure)}`, visible: true })
    }
  }

  const saveEditor = async (): Promise<void> => {
    if (!editor || busy) return
    const name = sessionGroupNameSchema.safeParse(editor.name)
    if (!name.success) {
      setEditor({ ...editor, error: 'Enter a group name on one line.' })
      editorInput.current?.focus()
      return
    }
    const generation = ++intentGeneration.current
    const { projectId, color, sessionId } = editor
    const groupId = editor.id ?? crypto.randomUUID()
    const member = sessionId ? sessions.find((session) => session.id === sessionId) : undefined
    if (member) setMoving({ session: member, groupId })
    try {
      const group = editor.id
        ? await workspace.updateGroup({ projectId, groupId, name: name.data, color })
        : await workspace.createGroup({ projectId, groupId, name: name.data, color, sessionId })
      if (!group) return
      setEditor(undefined)
      setNotice({ message: editor.id ? 'Session group updated' : 'Session group created' })
      if (sessionId) await locate({ projectId, sessionId, focus: true }, generation, true)
      else if (editor.id) setJump({ key: `group:${groupId}`, focus: true })
      else await loadGroupWindow(projectId, groupId, true, generation)
    } finally {
      if (member) setMoving(undefined)
    }
  }

  const closeDissolve = (): void => {
    if (!dissolving) return
    setDissolve(undefined)
    setJump({ key: `group:${dissolving.id}`, focus: true })
  }

  const confirmDissolve = async (group: SessionGroup): Promise<void> => {
    const generation = ++intentGeneration.current
    const selected = sessions.find(
      (session) => session.id === selectedSessionId && session.groupId === group.id,
    )
    setDissolve({ phase: 'refreshing' })
    try {
      const saved = await workspace.dissolveGroup({ projectId: group.projectId, groupId: group.id })
      if (!saved) return
      setNotice({ message: `Dissolved ${group.name}` })
      if (selected)
        await locate(
          { projectId: group.projectId, sessionId: selected.id, focus: true },
          generation,
          true,
        )
      else {
        await loadGroupWindow(group.projectId, undefined, false, generation)
        if (generation === intentGeneration.current)
          setJump({ key: `project:${group.projectId}`, focus: true })
      }
    } finally {
      setDissolve(undefined)
    }
  }

  const pickGroups = async (state: MenuState, input: SessionGroupPageInput): Promise<void> => {
    setMenu({ ...state, picker: true, pending: true })
    try {
      const loaded = await workspace.browseGroups(input)
      setMenu((current) =>
        current?.anchor === state.anchor && current.picker
          ? { ...current, page: loaded, pending: false }
          : current,
      )
    } catch (failure) {
      setMenu((current) =>
        current?.anchor === state.anchor && current.picker
          ? { ...current, error: errorMessage(failure), pending: false }
          : current,
      )
    }
  }

  const renderMenu = (state: MenuState) => {
    const { target, anchor } = state
    const item = (label: string, action: () => void, disabled = busy) => (
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        disabled={disabled}
        onClick={action}
      >
        {label}
      </button>
    )
    let content: React.ReactNode
    if (target.kind === 'project') {
      content = item('New Session group', () => {
        closeMenu(false)
        setEditor({ anchor, projectId: target.project.id, name: '', color: 'gray' })
      })
    } else if (target.kind === 'group') {
      const group = target.group
      const edit = (): void => {
        closeMenu(false)
        setEditor({
          anchor,
          projectId: group.projectId,
          id: group.id,
          name: group.name,
          color: group.color,
        })
      }
      const page = navigation?.projects[group.projectId]?.groups
      content = (
        <>
          {item('Rename or change color', edit)}
          {item('New Session in group', () => {
            closeMenu(false)
            onStartSession(group.projectId, group.id)
          })}
          {item(
            'Move up',
            () => {
              closeMenu(false)
              void moveGroup(group, { direction: 'up' }, true)
            },
            busy || group.position === 0,
          )}
          {item(
            'Move down',
            () => {
              closeMenu(false)
              void moveGroup(group, { direction: 'down' }, true)
            },
            busy || (!page?.nextCursor && page?.groups.at(-1)?.id === group.id),
          )}
          {item('Dissolve group…', () => {
            closeMenu(false)
            setDissolve({ phase: 'confirming', group })
          })}
        </>
      )
    } else {
      const session = target.session
      const input = { projectId: session.projectId }
      const choices = state.page?.groups ?? []
      const openPicker = (): void => {
        void pickGroups(state, input)
      }
      content = state.picker ? (
        <>
          {session.groupId
            ? item('Move out of group', () => {
                closeMenu(false)
                void moveSession(session, null, true)
              })
            : item('New group with this Session', () => {
                closeMenu(false)
                setEditor({
                  anchor,
                  projectId: session.projectId,
                  sessionId: session.id,
                  name: '',
                  color: 'gray',
                })
              })}
          {state.pending && (
            <p className="px-2 py-1 text-caption text-secondary">Loading groups…</p>
          )}
          {state.error && item('Couldn’t load groups · Retry', openPicker, false)}
          {state.page?.previousCursor &&
            item(
              'Load earlier groups',
              () => void pickGroups(state, { ...input, cursor: state.page?.previousCursor }),
              state.pending,
            )}
          {choices.map((group) => (
            <button
              key={group.id}
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              disabled={busy || group.id === session.groupId}
              title={group.name}
              onClick={(event) => {
                closeMenu(false)
                void moveSession(session, group.id, event.detail === 0)
              }}
            >
              <span
                className="pact-nav-group-dot size-2 shrink-0 rounded-pill"
                data-group-color={group.color}
              />
              <span className="min-w-0 flex-1 truncate">{group.name}</span>
            </button>
          ))}
          {state.page?.nextCursor &&
            item(
              'Load more groups',
              () => void pickGroups(state, { ...input, cursor: state.page?.nextCursor }),
              state.pending,
            )}
        </>
      ) : (
        item('Move to group', openPicker)
      )
    }
    return createPortal(
      <div
        id={menuButtonId}
        ref={menuRef}
        role="menu"
        tabIndex={-1}
        aria-label="Navigation actions"
        className={`fixed z-50 max-h-60 overflow-auto rounded-control border border-border bg-surface-raised p-1 shadow-lg ${state.picker ? 'space-y-1' : ''}`}
        style={anchoredOverlayStyle(anchor, 242, 240)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeMenu(true)
            return
          }
          if (event.key === 'Tab') {
            closeMenu(true)
            return
          }
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
          ]
          if (!buttons.length) return
          const index = buttons.findIndex((button) => button === document.activeElement)
          const next =
            event.key === 'ArrowDown'
              ? (index + 1) % buttons.length
              : event.key === 'ArrowUp'
                ? (index - 1 + buttons.length) % buttons.length
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : undefined
          if (next !== undefined) {
            event.preventDefault()
            buttons[next]?.focus()
          }
        }}
      >
        {content}
      </div>,
      document.body,
    )
  }

  const renderEditor = (state: GroupEditorState) =>
    createPortal(
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape closes the editor from any form control.
      <form
        ref={editorRef}
        className="fixed z-50 overflow-auto rounded-control bg-surface-raised px-3 pt-3 shadow-popover"
        style={anchoredOverlayStyle(state.anchor, 262, 168)}
        aria-label={state.id ? 'Edit Session group' : 'New Session group'}
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault()
          void saveEditor()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            event.stopPropagation()
            closeEditor(true)
          }
        }}
      >
        <input
          className="h-9 w-full min-w-0 rounded-control border border-border bg-surface px-2.5 text-body text-primary caret-focus placeholder:text-secondary focus-visible:border-focus focus-visible:outline-offset-0"
          ref={editorInput}
          aria-label="Session group name"
          aria-invalid={Boolean(state.error)}
          maxLength={SESSION_GROUP_NAME_LIMIT}
          placeholder="Group name"
          value={state.name}
          disabled={busy}
          onChange={(event) => setEditor({ ...state, name: event.target.value, error: undefined })}
        />
        {state.error && (
          <p className="mt-1 text-caption text-danger" role="alert">
            {state.error}
          </p>
        )}
        <fieldset className="my-2 grid min-w-0 grid-cols-9" aria-label="Group color">
          {SESSION_GROUP_COLORS.map((color) => {
            const label = color === 'rose' ? 'Pink' : color.charAt(0).toUpperCase() + color.slice(1)
            return (
              <button
                className="pact-group-color-choice hover:bg-surface-muted disabled:opacity-55"
                type="button"
                key={color}
                data-group-color={color}
                aria-label={label}
                title={label}
                aria-pressed={state.color === color}
                onClick={() => setEditor({ ...state, color })}
                disabled={busy}
              >
                <span aria-hidden="true" />
              </button>
            )
          })}
        </fieldset>
        <div className="-mx-3 flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          <button
            type="button"
            className="rounded-control px-2.5 py-1.5 text-caption text-secondary hover:bg-surface-muted"
            disabled={busy}
            onClick={() => closeEditor(true)}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-control bg-surface-inverse px-2.5 py-1.5 text-caption font-medium text-inverse disabled:opacity-55"
            disabled={busy}
          >
            {busy && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
            {state.id ? 'Save changes' : 'Create group'}
          </button>
        </div>
      </form>,
      document.body,
    )

  return (
    <div className="flex h-full min-h-72 flex-col p-group" data-pact-surface>
      <div className="flex h-8 items-center justify-between gap-group px-1">
        <h2 className="text-caption font-medium text-secondary">Projects</h2>
        <button
          className={ACTION}
          type="button"
          aria-label="Add Project"
          title="Add Project"
          disabled={adding}
          onClick={onAddProject}
        >
          {adding ? (
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <FolderPlus aria-hidden="true" className="size-4" strokeWidth={1.75} />
          )}
        </button>
      </div>
      {dissolving && (
        <dialog
          ref={dissolveDialog}
          className="pact-dissolve-confirmation max-w-[26rem] bg-surface-raised text-primary shadow-dialog"
          aria-labelledby={dissolveHeadingId}
          aria-describedby={dissolveDescriptionId}
          onCancel={(event) => {
            event.preventDefault()
            closeDissolve()
          }}
        >
          <div className="min-h-0 overflow-y-auto p-section">
            <h2
              id={dissolveHeadingId}
              className="text-subtitle font-medium [overflow-wrap:anywhere]"
            >
              Dissolve {dissolving.name}?
            </h2>
            <p id={dissolveDescriptionId} className="mt-2 text-body text-secondary">
              Sessions will move out of the group. Their history and running work are preserved.
            </p>
          </div>
          <div className="flex shrink-0 justify-end gap-group border-t border-border px-section py-group">
            <button
              ref={cancelDissolve}
              type="button"
              className="h-9 rounded-control px-panel text-body font-medium text-secondary hover:bg-surface-muted hover:text-primary"
              onClick={closeDissolve}
            >
              Cancel
            </button>
            <button
              type="button"
              className="h-9 rounded-control bg-danger-muted px-panel text-body font-medium text-danger hover:brightness-95"
              onClick={() => void confirmDissolve(dissolving)}
            >
              Dissolve
            </button>
          </div>
        </dialog>
      )}
      {/* Events delegate to the real navigation buttons. */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <nav
        ref={scrollRef}
        className="relative mt-group min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        aria-label="Projects and Sessions"
        onScroll={() => {
          if (menu) closeMenu(false)
          if (editorAnchor) closeEditor(false)
        }}
        onClickCapture={(event) => {
          if (drag.suppressClick()) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
        onKeyDown={(event) => {
          if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-nav-primary]'))
            return
          const index = Number(
            event.target.closest('[data-nav-index]')?.getAttribute('data-nav-index'),
          )
          const next =
            event.key === 'ArrowDown'
              ? Math.min(index + 1, rows.length - 1)
              : event.key === 'ArrowUp'
                ? Math.max(index - 1, 0)
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? rows.length - 1
                    : undefined
          if (next === undefined || !rows[next]) return
          event.preventDefault()
          setJump({ key: rows[next].key, focus: true })
        }}
      >
        <ul className="m-0 list-none p-0">
          {top > 0 && <li aria-hidden="true" style={{ height: top }} />}
          {visibleRows.map(({ index }) => {
            const row = rows[index]
            if (!row) return null
            const attributes = { 'data-nav-index': index, 'data-nav-key': row.key }
            if (row.kind === 'project') {
              const { project } = row
              const collapsed = collapsedProjects.has(project.id)
              return (
                <li
                  key={row.key}
                  {...attributes}
                  className={`pb-1 ${row.afterGroups ? 'pt-2' : ''}`}
                  data-project-menu={project.id}
                  data-drop-project={project.id}
                  data-drop-group=""
                >
                  <ProjectNavigationHeader
                    project={project}
                    collapsed={collapsed}
                    saving={renamingProjectId === project.id}
                    archiving={archivingProjectId === project.id}
                    actionsPending={Boolean(renamingProjectId || archivingProjectId)}
                    onToggle={() => {
                      if (collapsed) expandProject(project.id)
                      else setCollapsedProjects((current) => new Set([...current, project.id]))
                    }}
                    onRename={(name) => onRenameProject(project.id, name)}
                    onStartSession={() => onStartSession(project.id)}
                    menuButton={menuButton(
                      row.key,
                      { kind: 'project', project },
                      `Project ${project.name} actions`,
                    )}
                    onArchive={() => onArchiveProject(project.id)}
                  />
                </li>
              )
            }
            if (row.kind === 'group') {
              const { group, collapsed } = row
              const current =
                collapsed &&
                sessions.some(
                  (session) => session.id === selectedSessionId && session.groupId === group.id,
                )
              return (
                <li
                  key={row.key}
                  {...attributes}
                  className="pact-nav-group-heading group/group relative ml-group h-11 pt-2"
                  data-group-menu={group.id}
                  data-drop-project={group.projectId}
                  data-drop-group={group.id}
                  data-drop-collapsed={collapsed}
                  data-group-dragging={
                    (drag.source?.kind === 'group' && drag.source.id === group.id) || undefined
                  }
                  data-group-color={group.color}
                  onPointerDown={(event) => {
                    if (!busy)
                      drag.start(event, { kind: 'group', id: group.id, projectId: group.projectId })
                  }}
                >
                  <button
                    type="button"
                    data-nav-primary
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${group.name}${current ? ', current Session' : ''}`}
                    className="flex h-8 w-full min-w-0 touch-pan-y select-none items-center gap-1.5 rounded-control px-2 text-left text-caption font-medium pr-8"
                    onClick={() => {
                      setHighlight(undefined)
                      setRevealedGroupId(undefined)
                      if (group.collapsed && !collapsed) return
                      void workspace.updateGroup({
                        projectId: group.projectId,
                        groupId: group.id,
                        collapsed: !collapsed,
                      })
                    }}
                  >
                    <ChevronDown
                      aria-hidden="true"
                      className={`size-3.5 shrink-0 motion-safe:transition-transform ${collapsed ? '-rotate-90' : ''}`}
                    />
                    <span className="min-w-0 truncate" title={group.name}>
                      {group.name}
                    </span>
                    {current && (
                      <span className="ml-auto shrink-0 text-[10px] opacity-80">Current</span>
                    )}
                  </button>
                  <div className="pointer-events-none absolute right-0.5 top-2.5 opacity-0 group-hover/group:pointer-events-auto group-hover/group:opacity-100 group-focus-within/group:pointer-events-auto group-focus-within/group:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                    {menuButton(row.key, { kind: 'group', group }, `Group ${group.name} actions`)}
                  </div>
                </li>
              )
            }
            if (row.kind === 'session') {
              const { session, group } = row
              const selected = selectedSessionId === session.id
              return (
                <li
                  key={row.key}
                  {...attributes}
                  className={`group/session relative ml-group ${group ? 'pact-nav-group-body h-8 pl-2' : 'h-[34px] rounded-control'}`}
                  data-session-menu={session.id}
                  data-session-located={highlight === session.id}
                  data-drop-project={session.projectId}
                  data-drop-group={group?.id ?? ''}
                  data-group-color={group?.color}
                  data-group-head={row.bodyHead || undefined}
                  data-group-tail={row.bodyTail || undefined}
                  aria-busy={row.pending || undefined}
                  onPointerDown={(event) => {
                    if (!busy && !row.pending)
                      drag.start(event, {
                        kind: 'session',
                        id: session.id,
                        projectId: session.projectId,
                        groupId: session.groupId ?? null,
                      })
                  }}
                >
                  <button
                    className="flex h-8 w-full touch-pan-y select-none items-center gap-2 rounded-control px-2 text-left text-caption text-secondary hover:bg-surface-raised hover:text-primary group-hover/session:pr-16 group-focus-within/session:pr-16 data-[selected=true]:bg-navigation-selected data-[selected=true]:font-medium data-[selected=true]:text-primary [@media(hover:none)]:pr-16"
                    data-selected={selected}
                    aria-disabled={row.pending || undefined}
                    aria-current={selected ? 'page' : undefined}
                    aria-label={session.title}
                    data-nav-primary
                    type="button"
                    onClick={() => {
                      if (row.pending) return
                      intentGeneration.current++
                      setLocationError(undefined)
                      onSelectSession(session.id)
                    }}
                  >
                    <MessageSquare
                      aria-hidden="true"
                      className="size-3.5 shrink-0"
                      strokeWidth={1.75}
                    />
                    <span className="min-w-0 flex-1 truncate" title={session.title}>
                      {session.title}
                    </span>
                    <SessionActivityIndicator
                      activity={session.activity}
                      hasUnread={session.hasUnread}
                      selected={selected}
                    />
                  </button>
                  <div className="pointer-events-none absolute right-0.5 top-0.5 flex opacity-0 group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                    {menuButton(
                      row.key,
                      { kind: 'session', session },
                      `Session ${session.title} actions`,
                    )}
                  </div>
                  <button
                    className={`${ACTION} pointer-events-none absolute right-7 top-0.5 opacity-0 group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100`}
                    type="button"
                    aria-label={`Archive Session ${session.title}`}
                    title="Archive Session"
                    disabled={archivingSessionId === session.id}
                    onClick={() => onArchiveSession(session.id)}
                  >
                    {archivingSessionId === session.id ? (
                      <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                    ) : (
                      <Archive aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                    )}
                  </button>
                </li>
              )
            }
            if (row.kind === 'drop-slot')
              return (
                <li
                  key={row.key}
                  {...attributes}
                  aria-hidden="true"
                  className={`pact-nav-drop-slot relative ml-group ${row.group ? 'pact-nav-group-body h-8' : 'h-[34px] rounded-control'}`}
                  data-drop-project={row.projectId}
                  data-drop-group={row.group?.id ?? ''}
                  data-drop-placement={row.placement?.kind}
                  data-drop-anchor={
                    row.placement && row.placement.kind !== 'first'
                      ? row.placement.sessionId
                      : undefined
                  }
                  data-group-color={row.group?.color}
                  data-group-head={row.bodyHead || undefined}
                  data-group-tail={row.bodyTail || undefined}
                />
              )
            const reading = readState?.key === row.key && !readState.error
            const failure = readState?.key === row.key ? readState.error : undefined
            const newer = row.input.cursor?.direction === 'newer'
            return (
              <li
                key={row.key}
                {...attributes}
                className={`relative ml-group ${row.kind === 'session-page' && row.group ? 'pact-nav-group-body h-8 pl-2' : 'h-[34px]'}`}
                data-drop-project={row.input.projectId}
                data-drop-group={row.kind === 'session-page' ? (row.group?.id ?? '') : undefined}
                data-group-color={row.kind === 'session-page' ? row.group?.color : undefined}
                data-group-head={(row.kind === 'session-page' && row.bodyHead) || undefined}
                data-group-tail={(row.kind === 'session-page' && row.bodyTail) || undefined}
              >
                <button
                  className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-caption text-secondary hover:bg-surface-muted"
                  data-nav-primary
                  type="button"
                  aria-label={failure ? `Retry ${row.label}` : row.label}
                  title={failure}
                  aria-busy={reading}
                  onClick={() => void read(row, false)}
                >
                  {reading ? (
                    <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                  ) : newer ? (
                    <ChevronUp aria-hidden="true" className="size-3.5" />
                  ) : (
                    <ChevronDown aria-hidden="true" className="size-3.5" />
                  )}
                  <span className="min-w-0 truncate">
                    {reading
                      ? 'Loading…'
                      : failure
                        ? 'Couldn’t load · Retry'
                        : row.label.startsWith('Load more Sessions in ')
                          ? 'Load more Sessions'
                          : row.label}
                  </span>
                </button>
              </li>
            )
          })}
          {bottom > 0 && <li aria-hidden="true" style={{ height: bottom }} />}
        </ul>
      </nav>

      {menu && renderMenu(menu)}
      {editor && renderEditor(editor)}
      <div className="min-w-0 text-caption">
        {loading && projects.length > 0 && (
          <output className="block px-2 text-tertiary">Loading Sessions…</output>
        )}
        <output className={notice?.visible ? 'block px-2 text-secondary' : 'sr-only'}>
          {notice?.message}
        </output>
        {(error || workspace.checkingWrite) && (
          <div className="px-2 text-danger" role="alert">
            <p>{error ?? 'A save result is pending.'}</p>
            <button
              className="underline underline-offset-2"
              type="button"
              onClick={onRetrySessions}
            >
              {workspace.checkingWrite ? 'Check saved state' : 'Retry loading Sessions'}
            </button>
          </div>
        )}
        {locationError && (
          <div className="px-2 text-danger" role="alert">
            <p>{locationError.message}</p>
            <button
              className="underline underline-offset-2"
              type="button"
              onClick={() => void locate(locationError.intent)}
            >
              Retry locating Session
            </button>
          </div>
        )}
      </div>
      <button
        ref={settingsButtonRef}
        className="mt-auto flex min-h-9 w-full items-center gap-group rounded-control px-group py-2 text-left text-body font-medium text-primary hover:bg-surface-raised"
        type="button"
        onClick={() => {
          drag.cancel()
          onOpenSettings('session-defaults')
        }}
      >
        <Settings aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
        Settings
        {updateAvailable && (
          <span className="ml-auto text-caption font-medium text-focus">New</span>
        )}
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
  menuButton: React.ReactNode
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
  menuButton,
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
            className="h-8 min-w-0 flex-1 truncate rounded-control text-left text-body text-primary group-hover/project-header:mr-28 group-focus-within/project-header:mr-28 disabled:cursor-wait [@media(hover:none)]:mr-28"
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
            {menuButton}
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
