/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Native popovers contain the keyboard-operated ARIA menu pattern. */
import {
  Check,
  ChevronDown,
  Copy,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'

import type { ProjectContext } from '@pact/contracts'

function focusMenu(menu: HTMLDivElement | null): void {
  if (!menu || menu.contains(document.activeElement)) return
  const item = menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
  ;(item ?? menu).focus()
}

/** Disposable view of the selected Project; Utility owns directory and Git inspection. */
export function ProjectContextMenu({
  projectId,
  visible,
  refreshKey,
  onNotice,
  platform,
}: {
  projectId: string
  visible: boolean
  refreshKey: string
  onNotice: (message: string) => void
  platform?: string | undefined
}): React.JSX.Element {
  const [context, setContext] = useState<ProjectContext>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<'folder' | 'branch'>()
  const [copied, setCopied] = useState<'folder' | 'branch'>()
  const [acting, setActing] = useState(false)
  const folderTrigger = useRef<HTMLButtonElement>(null)
  const branchTrigger = useRef<HTMLButtonElement>(null)
  const folderMenu = useRef<HTMLDivElement>(null)
  const branchMenu = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const reading = useRef(false)
  const refreshPending = useRef(false)
  const readGeneration = useRef(0)
  const isVisible = useRef(visible)
  const actionPending = useRef(false)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const folderId = `project-folder-${projectId}`
  const branchId = `project-branch-${projectId}`

  const refresh = useCallback(async (): Promise<void> => {
    const request = { projectId }
    if (!mounted.current || !isVisible.current) return
    readGeneration.current += 1
    refreshPending.current = true
    if (reading.current) return
    reading.current = true
    setLoading(true)
    try {
      // Keep one active read and one latest refresh intention.
      while (refreshPending.current && mounted.current && isVisible.current) {
        refreshPending.current = false
        const generation = readGeneration.current
        try {
          // oxlint-disable-next-line no-await-in-loop -- Refresh latest facts after the sole active read settles.
          const result = await window.pact.readProjectContext(request)
          if (!mounted.current || !isVisible.current || generation !== readGeneration.current)
            continue
          if (result.ok) {
            setContext(result.value)
            setError(undefined)
          } else setError(result.error.message)
        } catch {
          if (mounted.current && isVisible.current && generation === readGeneration.current)
            setError('Couldn’t read project details. Try again.')
        }
      }
    } finally {
      reading.current = false
      if (mounted.current) setLoading(false)
    }
    // oxlint-disable-next-line react/memo-dependencies -- Project identity scopes the async read and visible subscriptions.
  }, [projectId])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      refreshPending.current = false
      readGeneration.current += 1
      clearTimeout(feedbackTimer.current)
    }
  }, [])
  useEffect(() => {
    isVisible.current = visible
    if (!visible || !refreshKey) {
      refreshPending.current = false
      readGeneration.current += 1
      folderMenu.current?.hidePopover()
      branchMenu.current?.hidePopover()
      return undefined
    }
    void Promise.resolve().then(refresh)
    const regainFocus = (): void => {
      if (!document.hidden) void refresh()
    }
    window.addEventListener('focus', regainFocus)
    document.addEventListener('visibilitychange', regainFocus)
    return () => {
      window.removeEventListener('focus', regainFocus)
      document.removeEventListener('visibilitychange', regainFocus)
    }
  }, [visible, refreshKey, refresh])

  const close = (kind: 'folder' | 'branch'): void => {
    const menu = kind === 'folder' ? folderMenu.current : branchMenu.current
    menu?.hidePopover()
    ;(kind === 'folder' ? folderTrigger : branchTrigger).current?.focus()
  }
  const copy = async (kind: 'folder' | 'branch'): Promise<void> => {
    const text =
      kind === 'folder'
        ? context?.directoryPath
        : context?.git.state === 'branch'
          ? context.git.name
          : undefined
    if (!text || actionPending.current || (kind === 'branch' && (loading || error))) return
    actionPending.current = true
    setActing(true)
    try {
      await navigator.clipboard.writeText(text)
      if (!mounted.current) return
      clearTimeout(feedbackTimer.current)
      setCopied(kind)
      feedbackTimer.current = setTimeout(() => setCopied(undefined), 1_600)
      close(kind)
    } catch {
      if (mounted.current) onNotice('Couldn’t copy to the clipboard. Try again.')
    } finally {
      actionPending.current = false
      if (mounted.current) setActing(false)
    }
  }
  const showFolder = async (): Promise<void> => {
    if (actionPending.current) return
    actionPending.current = true
    setActing(true)
    try {
      const result = await window.pact.openProjectDirectory({ projectId })
      if (!mounted.current) return
      if (result.ok) close('folder')
      else onNotice(result.error.message)
    } catch {
      if (mounted.current)
        onNotice('Couldn’t open the project folder. Try copying its path instead.')
    } finally {
      actionPending.current = false
      if (mounted.current) setActing(false)
    }
  }
  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>, kind: 'folder' | 'branch'): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close(kind)
      return
    }
    if (event.key === 'Tab') {
      ;(kind === 'folder' ? folderMenu : branchMenu).current?.hidePopover()
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
  const triggerKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    kind: 'folder' | 'branch',
  ): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const menu = (kind === 'folder' ? folderMenu : branchMenu).current
    menu?.showPopover()
    const items = menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    const item = event.key === 'ArrowUp' ? items?.[items.length - 1] : items?.[0]
    item?.focus()
  }
  const git = error ? { state: 'unavailable' as const } : context?.git
  const branchLabel =
    git?.state === 'branch'
      ? git.name
      : git?.state === 'detached'
        ? `Detached · ${git.commit}`
        : 'Branch unavailable'
  const BranchIcon =
    copied === 'branch' ? Check : git?.state === 'detached' ? GitCommitHorizontal : GitBranch
  const FolderIcon = copied === 'folder' ? Check : Folder
  const itemClass = 'pact-composer-menu-item'

  return (
    <div className="pact-project-context ml-auto text-caption">
      <output className="sr-only" aria-live="polite">
        {copied === 'folder'
          ? 'Project path copied'
          : copied === 'branch'
            ? 'Branch name copied'
            : ''}
      </output>
      <button
        ref={folderTrigger}
        type="button"
        popoverTarget={folderId}
        className="pact-project-trigger pact-project-folder"
        style={{ anchorName: `--${folderId}` }}
        title={context?.directoryPath ?? error ?? 'Project folder'}
        aria-label={`Project folder: ${context?.folderName ?? 'Loading'}`}
        aria-haspopup="menu"
        aria-expanded={open === 'folder'}
        aria-controls={folderId}
        onKeyDown={(event) => triggerKeyDown(event, 'folder')}
      >
        {loading && !context ? (
          <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <FolderIcon
            key={copied ?? 'folder'}
            aria-hidden="true"
            className={`size-3.5 shrink-0 ${copied === 'folder' ? 'pact-project-copied' : ''}`}
            strokeWidth={1.75}
          />
        )}
        <span className="truncate">
          {context?.folderName ?? (error ? 'Project unavailable' : 'Project')}
        </span>
        <ChevronDown aria-hidden="true" className="pact-project-chevron size-3 shrink-0" />
      </button>
      {git && git.state !== 'none' ? (
        <>
          <span className="pact-project-divider" aria-hidden="true" />
          <button
            ref={branchTrigger}
            type="button"
            popoverTarget={branchId}
            className="pact-project-trigger pact-project-branch"
            style={{ anchorName: `--${branchId}` }}
            title={branchLabel}
            aria-label={`Git branch: ${branchLabel}`}
            aria-haspopup="menu"
            aria-expanded={open === 'branch'}
            aria-controls={branchId}
            onKeyDown={(event) => triggerKeyDown(event, 'branch')}
          >
            <BranchIcon
              key={copied ?? 'branch'}
              aria-hidden="true"
              className={`size-3.5 shrink-0 ${copied === 'branch' ? 'pact-project-copied' : ''}`}
              strokeWidth={1.75}
            />
            <span className="truncate font-mono">{branchLabel}</span>
            <ChevronDown aria-hidden="true" className="pact-project-chevron size-3 shrink-0" />
          </button>
        </>
      ) : null}
      <div
        id={folderId}
        ref={folderMenu}
        popover="auto"
        role="menu"
        tabIndex={-1}
        aria-label="Project folder actions"
        className="pact-project-popover pact-composer-popover"
        style={{ positionAnchor: `--${folderId}` }}
        onKeyDown={(event) => menuKeyDown(event, 'folder')}
        onToggle={(event) => {
          if (event.newState === 'open') focusMenu(folderMenu.current)
        }}
        onBeforeToggle={(event) => {
          if (event.newState === 'open') {
            setOpen('folder')
            void refresh()
          } else setOpen((current) => (current === 'folder' ? undefined : current))
        }}
      >
        <p className="pact-composer-menu-heading">{context?.folderName ?? 'Project folder'}</p>
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          disabled={!context || acting}
          onClick={() => void showFolder()}
        >
          <FolderOpen aria-hidden="true" className="size-4" strokeWidth={1.75} />
          <span className="font-medium">
            {platform === 'darwin'
              ? 'Open in Finder'
              : platform === 'win32'
                ? 'Show in Explorer'
                : 'Open folder'}
          </span>
          {acting ? (
            <LoaderCircle aria-hidden="true" className="ml-auto size-3.5 animate-spin" />
          ) : null}
        </button>
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          disabled={!context || acting}
          onClick={() => void copy('folder')}
        >
          <Copy aria-hidden="true" className="size-4" strokeWidth={1.75} />
          <span className="font-medium">Copy path</span>
        </button>
        {error ? (
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" className="size-4" strokeWidth={1.75} />
            <span className="font-medium">Retry</span>
          </button>
        ) : null}
        {context || error ? (
          <div className="pact-composer-menu-detail">
            {context ? <p className="font-mono">{context.directoryPath}</p> : null}
            {error ? <p role="status">{error}</p> : null}
          </div>
        ) : null}
      </div>
      <div
        id={branchId}
        ref={branchMenu}
        popover="auto"
        role="menu"
        tabIndex={-1}
        aria-label="Git branch actions"
        className="pact-project-popover pact-composer-popover"
        style={{ positionAnchor: `--${branchId}` }}
        onKeyDown={(event) => menuKeyDown(event, 'branch')}
        onToggle={(event) => {
          if (event.newState === 'open') focusMenu(branchMenu.current)
        }}
        onBeforeToggle={(event) => {
          if (event.newState === 'open') {
            setOpen('branch')
            void refresh()
          } else setOpen((current) => (current === 'branch' ? undefined : current))
        }}
      >
        <p className="pact-composer-menu-heading">
          {git?.state === 'detached' ? 'Detached HEAD' : 'Current branch'}
        </p>
        {git?.state === 'branch' ? (
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            disabled={loading || acting}
            onClick={() => void copy('branch')}
          >
            <Copy aria-hidden="true" className="size-4" strokeWidth={1.75} />
            <span className="font-medium">Copy branch name</span>
            {loading ? (
              <LoaderCircle aria-hidden="true" className="ml-auto size-3.5 animate-spin" />
            ) : null}
          </button>
        ) : git?.state === 'detached' ? (
          <p className="px-3 py-2 leading-relaxed text-secondary">No branch is checked out.</p>
        ) : (
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" className="size-4" strokeWidth={1.75} />
            <span className="font-medium">{loading ? 'Refreshing…' : 'Retry'}</span>
          </button>
        )}
        <p className="pact-composer-menu-detail font-mono">
          {git?.state === 'branch'
            ? git.name
            : git?.state === 'detached'
              ? git.commit
              : 'Branch unavailable'}
        </p>
      </div>
    </div>
  )
}
