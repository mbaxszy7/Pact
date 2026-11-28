import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileDiff,
  Maximize2,
  Minimize2,
  RotateCcw,
  X,
} from 'lucide-react'
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import {
  WORKSPACE_CHANGE_FILES,
  WORKSPACE_CHANGE_PAGE_FILES,
  WORKSPACE_OPERATION_TIMEOUT_MS,
  WORKSPACE_PREVIEW_BYTES,
  type FileCommentAnchor,
  type ProjectFile,
  type WorkspaceChangeFilePreview,
  type WorkspaceChangeSet,
  type WorkspaceChangesPage,
  type WorkspaceFileChange,
} from '@pact/contracts'

import type { RenderedViewerTarget } from './ProjectCodeViewer'
import type { FileCommentSaveOutcome } from './ProjectFilePanel'

import { PlainFileViewer } from './PlainFileViewer'
import { projectFileLanguage } from './project-file-language'

const ProjectCodeViewer = lazy(async () => {
  const module = await import('./ProjectCodeViewer')
  return { default: module.ProjectCodeViewer }
})
const ProjectDiffViewer = lazy(async () => {
  const module = await import('./ProjectCodeViewer')
  return { default: module.ProjectDiffViewer }
})
const RecordedPatchViewer = lazy(async () => {
  const module = await import('./RecordedPatchViewer')
  return { default: module.RecordedPatchViewer }
})

const PREVIEW_CACHE_MAX_ENTRIES = 48
const MAX_COMMENT_DRAFTS = 8

export interface WorkspaceChangesCommentOptions {
  commentId?: string | undefined
  sessionId?: string | undefined
  requestId?: string | undefined
  mode?: 'create' | 'edit' | undefined
}

export interface WorkspaceChangesNavigationTarget {
  sessionId: string
  changeSetId: string
  path: string
  revision?: number | undefined
  expectedGeneration?: number | undefined
}

interface PendingWorkspaceCommentSubmit {
  requestId: string
  body: string
  mode: 'create' | 'edit'
}

interface WorkspaceCommentDraft {
  draftKey: string
  path: string
  contentHash: string
  draftId: string
  commentId: string
  persisted: boolean
  pendingSubmit?: PendingWorkspaceCommentSubmit | undefined
  anchor: FileCommentAnchor
  quote: string
  body: string
}

type PendingWorkspaceNavigation =
  | {
      kind: 'internal'
      targetPath: string
      direction: number
      sourceDraftKey: string
      capturedEpoch: number
    }
  | {
      kind: 'external'
      target: WorkspaceChangesNavigationTarget
      sourceDraftKey: string
      capturedEpoch: number
    }

function putBoundedCommentDraft(
  drafts: ReadonlyMap<string, WorkspaceCommentDraft>,
  draftKey: string,
  draft: WorkspaceCommentDraft,
): { next: Map<string, WorkspaceCommentDraft>; evictedBlocked: boolean } {
  const next = new Map(drafts)
  if (next.has(draftKey)) {
    next.delete(draftKey)
    next.set(draftKey, draft)
    return { next, evictedBlocked: false }
  }
  while (next.size >= MAX_COMMENT_DRAFTS) {
    let emptyKey: string | undefined
    for (const [key, entry] of next) {
      if (entry.body.trim().length === 0) {
        emptyKey = key
        break
      }
    }
    if (emptyKey === undefined) {
      return { next: new Map(drafts), evictedBlocked: true }
    }
    next.delete(emptyKey)
  }
  next.set(draftKey, draft)
  return { next, evictedBlocked: false }
}

function isWorkspaceFileUndone(
  file: Pick<WorkspaceFileChange, 'path' | 'undone' | 'undoStrategy'> | undefined,
  changeSet: WorkspaceChangeSet | undefined,
  locallyUndonePaths: ReadonlySet<string>,
  revision: number,
  path: string,
): boolean {
  if (file?.undone) return true
  if (locallyUndonePaths.has(`${revision}:${path}`)) return true
  if (changeSet?.state === 'undone' && file?.undoStrategy !== 'unavailable') return true
  return false
}

const FILE_KIND_BADGE = {
  added: {
    code: 'A',
    label: 'Added',
    className: 'bg-diff-added text-diff-added-foreground',
  },
  modified: {
    code: 'M',
    label: 'Modified',
    className: 'bg-status-info-muted text-status-info-foreground',
  },
  deleted: {
    code: 'D',
    label: 'Deleted',
    className: 'bg-diff-removed text-diff-removed-foreground',
  },
  renamed: {
    code: 'R',
    label: 'Renamed',
    className: 'bg-status-warning-muted text-status-warning-foreground',
  },
} as const satisfies Record<
  WorkspaceFileChange['kind'],
  { code: string; label: string; className: string }
>

export interface WorkspaceChangesPanelState {
  sessionId: string
  changeSetId: string
  path: string
  revision?: number | undefined
}

interface PreviewReadState {
  key: string
  loading: boolean
  preview?: WorkspaceChangeFilePreview
  patches?: string[]
  error?: { message: string; retryable: boolean }
}

type CachedPreviewEntry = Omit<PreviewReadState, 'loading'>

interface SettledPreviewSnapshot {
  revision: number
  path: string
  language: string
  before?: ProjectFile | undefined
  after?: ProjectFile | undefined
  patchFile?: ProjectFile | undefined
  patches?: string[] | undefined
  needsPatch: boolean
}

function splitFilePath(path: string): { name: string; directory: string } {
  const normalized = path.replace(/\\/gu, '/')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return { name: path, directory: '' }
  return {
    name: normalized.slice(lastSlash + 1),
    directory: normalized.slice(0, lastSlash + 1),
  }
}

function unavailableMessage(
  reason: Extract<WorkspaceChangeFilePreview, { status: 'unavailable' }>['reason'],
): string {
  const messages = {
    not_recorded: 'Full file versions weren’t recorded by the agent.',
    not_final: 'This change isn’t finalized yet.',
    blob_missing: 'The saved file version is missing.',
    blob_corrupt: 'The saved file version failed integrity verification.',
    too_large: 'This file version is too large to preview.',
    unsupported_encoding: 'Only UTF-8 text files can be previewed.',
    temporary_io: 'Couldn’t read this saved version. Try again.',
  }
  return messages[reason]
}

function putBoundedPreviewCache(
  cache: ReadonlyMap<string, CachedPreviewEntry>,
  key: string,
  entry: CachedPreviewEntry,
): Map<string, CachedPreviewEntry> {
  const next = new Map(cache)
  next.delete(key)
  next.set(key, entry)
  while (next.size > PREVIEW_CACHE_MAX_ENTRIES) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

// Each side owns one bounded result and deadline. Retrying it cannot discard the other sides.
function useSavedPreview(
  { sessionId, changeSetId, path, revision }: WorkspaceChangesPanelState,
  side: WorkspaceChangeFilePreview['side'],
  previewCache: ReadonlyMap<string, CachedPreviewEntry>,
  onCacheEntry: (key: string, entry: CachedPreviewEntry) => void,
  onEvictEntry: (key: string) => void,
  enabled = true,
  patchCount = 1,
): PreviewReadState & { retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify([
    sessionId,
    changeSetId,
    path,
    revision ?? 0,
    side,
    patchCount,
    attempt,
  ])
  const cachedForKey = enabled ? previewCache.get(key) : undefined
  const [read, setRead] = useState<Omit<PreviewReadState, 'loading'>>({ key })

  useEffect(() => {
    if (!enabled || cachedForKey) return undefined
    let cancelled = false
    const fail = (message: string, retryable: boolean): void => {
      if (!cancelled) setRead({ key, error: { message, retryable } })
    }
    const timeout = window.setTimeout(() => {
      fail('Loading this preview took too long. Try again.', true)
      cancelled = true
    }, WORKSPACE_OPERATION_TIMEOUT_MS)
    const load = async (): Promise<void> => {
      let first: WorkspaceChangeFilePreview | undefined
      const patches: string[] = []
      let bytes = 0
      for (let index = 0; index < (side === 'patch' ? patchCount : 1); index += 1) {
        if (cancelled) return
        const patchIndex = side === 'patch' ? index : undefined
        // oxlint-disable-next-line no-await-in-loop -- Immutable patches are read sequentially under one deadline and aggregate byte budget.
        const result = await window.pact.readWorkspaceChangeFile({
          changeSetId,
          path,
          side,
          ...(side === 'patch' ? { patchIndex } : {}),
        })
        if (cancelled) return undefined
        if (!result.ok) {
          fail(
            result.error.message,
            result.error.code === 'TIMEOUT' || result.error.code === 'RUNTIME_UNAVAILABLE',
          )
          return undefined
        }
        const preview = result.value
        const identity = preview.status === 'available' ? preview.file : preview
        if (
          preview.changeSetId !== changeSetId ||
          preview.side !== side ||
          preview.patchIndex !== patchIndex ||
          identity.sessionId !== sessionId ||
          identity.relativePath !== path
        ) {
          fail('This preview doesn’t match the selected changes.', false)
          return undefined
        }
        if (side === 'patch' && preview.patchCount !== patchCount) {
          fail('These file changes were updated. Reopen this file.', true)
          return
        }
        first ??= preview
        if (preview.status === 'unavailable') {
          const entry: CachedPreviewEntry = { key, preview }
          if (preview.reason !== 'temporary_io' && preview.reason !== 'not_final') {
            onCacheEntry(key, entry)
          }
          setRead(entry)
          return
        }
        if (side === 'patch') {
          bytes += new TextEncoder().encode(preview.file.content).byteLength
          if (bytes > WORKSPACE_PREVIEW_BYTES) {
            fail('This change is too large to preview.', false)
            return
          }
          patches.push(preview.file.content)
        }
      }
      if (first) {
        const entry: CachedPreviewEntry = {
          key,
          preview: first,
          ...(side === 'patch' ? { patches } : {}),
        }
        onCacheEntry(key, entry)
        setRead(entry)
      }
    }
    void load()
      .catch(() => fail('Couldn’t load this preview. Try again.', true))
      .finally(() => window.clearTimeout(timeout))
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [sessionId, changeSetId, path, side, patchCount, key, enabled, cachedForKey, onCacheEntry])

  const active = cachedForKey ?? (read.key === key ? read : { key })
  return {
    ...active,
    loading: enabled && !active.preview && !active.error,
    retry: () => {
      onEvictEntry(key)
      setAttempt((value) => value + 1)
    },
  }
}

function useNextSavedFile(
  { sessionId, changeSetId, path, revision }: WorkspaceChangesPanelState,
  enabled: boolean,
): {
  path?: string | null | undefined
  page?: WorkspaceChangesPage | undefined
  afterPath?: string | undefined
  loading: boolean
  error?: string | undefined
  retry: () => void
} {
  const [attempt, setAttempt] = useState(0)
  const [settlement, setSettlement] = useState(0)
  const pendingRef = useRef(false)
  const completedKey = useRef<string | undefined>(undefined)
  const mounted = useRef(true)
  const key = JSON.stringify([sessionId, changeSetId, path, revision ?? 0, attempt])
  const [read, setRead] = useState<{
    key: string
    afterPath?: string | undefined
    nextPath?: string | null | undefined
    page?: WorkspaceChangesPage | undefined
    error?: string | undefined
  }>({
    key: '',
  })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!enabled || pendingRef.current || completedKey.current === key) return undefined
    if (typeof window.pact?.readWorkspaceChanges !== 'function') return undefined
    let retired = false
    pendingRef.current = true
    completedKey.current = undefined
    const fail = (message: string): void => {
      if (retired) return
      completedKey.current = key
      setRead({ key, error: message })
    }
    const timeout = window.setTimeout(() => {
      fail('Loading the next file took too long. Try again.')
      retired = true
    }, WORKSPACE_OPERATION_TIMEOUT_MS)
    const load = async (): Promise<void> => {
      const result = await window.pact.readWorkspaceChanges({ changeSetId, afterPath: path })
      if (retired) return
      if (!result.ok) {
        fail(result.error.message || 'Couldn’t load the next file. Try again.')
        return
      }
      const page = result.value
      if (page.changeSet.id !== changeSetId || page.changeSet.sessionId !== sessionId)
        throw new Error('These files don’t match the selected changes.')
      if (revision !== undefined && (page.changeSet.revision ?? 0) !== revision)
        throw new Error('The file changes were updated. Reopen this card.')
      const next = page.files[0]
      if (
        page.files.length > WORKSPACE_CHANGE_PAGE_FILES ||
        next?.path === path ||
        next?.hidden ||
        (!next && page.nextPath !== null)
      )
        throw new Error('Couldn’t load the next file. Reopen this card.')
      completedKey.current = key
      setRead({ key, afterPath: path, nextPath: next?.path ?? null, page })
    }
    void load()
      .catch((failure: unknown) =>
        fail(
          failure instanceof Error ? failure.message : 'Couldn’t load the next file. Try again.',
        ),
      )
      .finally(() => {
        window.clearTimeout(timeout)
        pendingRef.current = false
        if (mounted.current) {
          setSettlement((value) => value + 1)
        }
      })
    return () => {
      retired = true
      window.clearTimeout(timeout)
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Settlement retries the current key after a retired request releases pendingRef.
  }, [sessionId, changeSetId, path, revision, key, enabled, settlement])
  const current = read.key === key ? read : undefined
  const bridgeAvailable = typeof window.pact?.readWorkspaceChanges === 'function'
  return {
    path: current?.nextPath,
    page: current?.page,
    afterPath: current?.afterPath,
    error: current?.error,
    loading:
      enabled &&
      bridgeAvailable &&
      (!current || (current.nextPath === undefined && !current.error)),
    retry: () => setAttempt((value) => value + 1),
  }
}

interface ActiveLoadMoreRequest {
  requestId: number
  listKey: string
  revision: number
  startCursor: string
  timeout: number
  timedOut: boolean
  retired: boolean
}

function useChangedFilesList({
  sessionId,
  changeSetId,
  revision,
}: Pick<WorkspaceChangesPanelState, 'sessionId' | 'changeSetId' | 'revision'>): {
  changeSet?: WorkspaceChangeSet | undefined
  loadedRevision?: number | undefined
  files: WorkspaceFileChange[]
  nextPath: string | null
  loading: boolean
  loadingMore: boolean
  error?: string | undefined
  loadMoreError?: string | undefined
  loadMore: () => void
  mergePage: (page: WorkspaceChangesPage, afterPath: string) => void
  refresh: () => void
} {
  const [refreshCount, setRefreshCount] = useState(0)
  const [state, setState] = useState<{
    key: string
    changeSet?: WorkspaceChangeSet | undefined
    loadedRevision?: number | undefined
    files: WorkspaceFileChange[]
    nextPath: string | null
    loadingMore: boolean
    error?: string | undefined
    loadMoreError?: string | undefined
  }>({
    key: '',
    files: [],
    nextPath: null,
    loadingMore: false,
  })
  const mountedRef = useRef(true)
  const minRevisionRef = useRef<number>(revision ?? 0)
  const loadMoreRequestSeqRef = useRef(0)
  const activeLoadMoreRef = useRef<ActiveLoadMoreRequest | undefined>(undefined)
  const pendingRetryRef = useRef<string | undefined>(undefined)
  const listKey = JSON.stringify([sessionId, changeSetId, revision ?? 0, refreshCount])
  const listKeyRef = useRef(listKey)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      pendingRetryRef.current = undefined
      if (activeLoadMoreRef.current) {
        window.clearTimeout(activeLoadMoreRef.current.timeout)
        activeLoadMoreRef.current.retired = true
      }
    }
  }, [])

  useEffect(() => {
    listKeyRef.current = listKey
  }, [listKey])

  useEffect(() => {
    if (revision !== undefined && revision > minRevisionRef.current) {
      minRevisionRef.current = revision
    }
  }, [revision])

  useEffect(() => {
    if (typeof window.pact?.readWorkspaceChanges !== 'function') return undefined
    let cancelled = false
    pendingRetryRef.current = undefined
    if (activeLoadMoreRef.current) {
      window.clearTimeout(activeLoadMoreRef.current.timeout)
      activeLoadMoreRef.current.retired = true
    }
    const expectedMinRevision = Math.max(revision ?? 0, minRevisionRef.current)
    const timeout = window.setTimeout(() => {
      if (cancelled || !mountedRef.current) return
      cancelled = true
      setState({
        key: listKey,
        files: [],
        nextPath: null,
        loadingMore: false,
        error: 'Loading changed files took too long.',
      })
    }, WORKSPACE_OPERATION_TIMEOUT_MS)

    const loadInitial = async (): Promise<void> => {
      const result = await window.pact.readWorkspaceChanges({ changeSetId })
      if (cancelled || !mountedRef.current) return
      if (!result.ok) {
        setState({
          key: listKey,
          files: [],
          nextPath: null,
          loadingMore: false,
          error: result.error.message || 'Couldn’t load changed files.',
        })
        return
      }
      const page = result.value
      if (page.changeSet.id !== changeSetId || page.changeSet.sessionId !== sessionId) {
        setState({
          key: listKey,
          files: [],
          nextPath: null,
          loadingMore: false,
          error: 'These files don’t match the selected changes.',
        })
        return
      }
      const pageRevision = page.changeSet.revision ?? 0
      if (
        (revision !== undefined && pageRevision < revision) ||
        pageRevision < expectedMinRevision
      ) {
        setState({
          key: listKey,
          files: [],
          nextPath: null,
          loadingMore: false,
          error: 'Changed files were updated while loading. Try again.',
        })
        return
      }
      if (page.files.length > WORKSPACE_CHANGE_PAGE_FILES) {
        setState({
          key: listKey,
          files: [],
          nextPath: null,
          loadingMore: false,
          error: 'Couldn’t load changed files.',
        })
        return
      }
      const visibleFiles = page.files.filter((f) => !f.hidden)
      if (new Set(visibleFiles.map((f) => f.path)).size !== visibleFiles.length) {
        setState({
          key: listKey,
          files: [],
          nextPath: null,
          loadingMore: false,
          error: 'Changed file list contained duplicate paths.',
        })
        return
      }
      minRevisionRef.current = Math.max(minRevisionRef.current, pageRevision)
      setState({
        key: listKey,
        changeSet: page.changeSet,
        loadedRevision: pageRevision,
        files: visibleFiles,
        nextPath: page.nextPath,
        loadingMore: false,
      })
    }

    void loadInitial()
      .catch(() => {
        if (!cancelled && mountedRef.current) {
          setState({
            key: listKey,
            files: [],
            nextPath: null,
            loadingMore: false,
            error: 'Couldn’t load changed files.',
          })
        }
      })
      .finally(() => window.clearTimeout(timeout))

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
      if (pendingRetryRef.current === listKey) {
        pendingRetryRef.current = undefined
      }
      if (activeLoadMoreRef.current?.listKey === listKey) {
        window.clearTimeout(activeLoadMoreRef.current.timeout)
        activeLoadMoreRef.current.retired = true
      }
    }
  }, [sessionId, changeSetId, listKey, revision])

  const bridgeAvailable = typeof window.pact?.readWorkspaceChanges === 'function'
  const settled = state.key === listKey
  const active = settled
    ? state
    : {
        key: listKey,
        files: [] as WorkspaceFileChange[],
        nextPath: null,
        loadingMore: false,
      }

  const refresh = useCallback(() => {
    setRefreshCount((value) => value + 1)
  }, [])

  const startLoadMoreRef = useRef<() => boolean>(() => false)

  const startLoadMore = useCallback((): boolean => {
    if (
      !active.nextPath ||
      active.loadedRevision === undefined ||
      active.files.length >= WORKSPACE_CHANGE_FILES ||
      typeof window.pact?.readWorkspaceChanges !== 'function'
    )
      return false
    const expectedKey = listKey
    if (activeLoadMoreRef.current) {
      // Never overlap a second physical IPC while the previous request has not settled.
      if (activeLoadMoreRef.current.timedOut || activeLoadMoreRef.current.retired) {
        pendingRetryRef.current = expectedKey
        setState((current) =>
          current.key === expectedKey
            ? { ...current, loadingMore: true, loadMoreError: undefined }
            : current,
        )
        return true
      }
      return false
    }
    const startCursor = active.nextPath
    const expectedRevision = active.loadedRevision
    const requestId = ++loadMoreRequestSeqRef.current
    pendingRetryRef.current = undefined
    let localTimedOut = false
    const timeout = window.setTimeout(() => {
      localTimedOut = true
      if (
        !mountedRef.current ||
        activeLoadMoreRef.current?.requestId !== requestId ||
        activeLoadMoreRef.current.retired ||
        listKeyRef.current !== expectedKey
      ) {
        return
      }
      activeLoadMoreRef.current.timedOut = true
      setState((current) =>
        current.key === expectedKey
          ? { ...current, loadingMore: false, loadMoreError: 'Loading more files took too long.' }
          : current,
      )
    }, WORKSPACE_OPERATION_TIMEOUT_MS)

    activeLoadMoreRef.current = {
      requestId,
      listKey: expectedKey,
      revision: expectedRevision,
      startCursor,
      timeout,
      timedOut: false,
      retired: false,
    }
    setState((current) =>
      current.key === expectedKey
        ? { ...current, loadingMore: true, loadMoreError: undefined }
        : current,
    )

    const isCurrentRequest = (): boolean =>
      mountedRef.current &&
      !localTimedOut &&
      activeLoadMoreRef.current?.requestId === requestId &&
      !activeLoadMoreRef.current.retired &&
      listKeyRef.current === expectedKey

    const run = async (): Promise<void> => {
      const result = await window.pact.readWorkspaceChanges({
        changeSetId,
        afterPath: startCursor,
      })
      if (!isCurrentRequest()) return
      if (!result.ok) {
        setState((current) =>
          current.key === expectedKey
            ? {
                ...current,
                loadingMore: false,
                loadMoreError: result.error.message || 'Couldn’t load more files.',
              }
            : current,
        )
        return
      }
      const page = result.value
      if (page.changeSet.id !== changeSetId || page.changeSet.sessionId !== sessionId) {
        setState((current) =>
          current.key === expectedKey
            ? {
                ...current,
                loadingMore: false,
                loadMoreError: 'These files don’t match the selected changes.',
              }
            : current,
        )
        return
      }
      const pageRevision = page.changeSet.revision ?? 0
      if (pageRevision !== expectedRevision) {
        // Revision changed mid-pagination: discard mixed page results and reload cleanly from page 1.
        if (pageRevision > expectedRevision) {
          minRevisionRef.current = Math.max(minRevisionRef.current, pageRevision)
          setRefreshCount((value) => value + 1)
        } else {
          setState((current) =>
            current.key === expectedKey
              ? {
                  ...current,
                  loadingMore: false,
                  loadMoreError: 'Changed files were updated while loading. Try again.',
                }
              : current,
          )
        }
        return
      }
      if (page.files.length > WORKSPACE_CHANGE_PAGE_FILES || page.nextPath === startCursor) {
        setState((current) =>
          current.key === expectedKey
            ? {
                ...current,
                loadingMore: false,
                loadMoreError: 'Couldn’t load the next page of changed files.',
              }
            : current,
        )
        return
      }
      setState((current) => {
        if (current.key !== expectedKey || current.loadedRevision !== expectedRevision) {
          return current
        }
        if (current.nextPath !== startCursor) {
          return current.loadingMore ? { ...current, loadingMore: false } : current
        }
        const seen = new Set(current.files.map((item) => item.path))
        const merged = [...current.files]
        for (const item of page.files) {
          if (!item.hidden && !seen.has(item.path) && merged.length < WORKSPACE_CHANGE_FILES) {
            seen.add(item.path)
            merged.push(item)
          }
        }
        return {
          ...current,
          changeSet: page.changeSet,
          files: merged,
          nextPath: merged.length < WORKSPACE_CHANGE_FILES ? page.nextPath : null,
          loadingMore: false,
          loadMoreError: undefined,
        }
      })
    }

    void run()
      .catch(() => {
        if (!isCurrentRequest()) return
        setState((current) =>
          current.key === expectedKey
            ? { ...current, loadingMore: false, loadMoreError: 'Couldn’t load more files.' }
            : current,
        )
      })
      .finally(() => {
        window.clearTimeout(timeout)
        if (activeLoadMoreRef.current?.requestId === requestId) {
          activeLoadMoreRef.current = undefined
        }
        if (mountedRef.current && pendingRetryRef.current === listKeyRef.current) {
          pendingRetryRef.current = undefined
          if (!startLoadMoreRef.current()) {
            setState((current) =>
              current.key === listKeyRef.current && current.loadingMore
                ? { ...current, loadingMore: false }
                : current,
            )
          }
        }
      })
    return true
  }, [active.files.length, active.loadedRevision, active.nextPath, changeSetId, listKey, sessionId])

  useLayoutEffect(() => {
    startLoadMoreRef.current = startLoadMore
  }, [startLoadMore])

  const loadMore = useCallback(() => {
    startLoadMore()
  }, [startLoadMore])

  const mergePage = useCallback(
    (page: WorkspaceChangesPage, afterPath: string) => {
      if (
        page.changeSet.id !== changeSetId ||
        page.changeSet.sessionId !== sessionId ||
        page.files.length > WORKSPACE_CHANGE_PAGE_FILES
      ) {
        return
      }
      const pageRevision = page.changeSet.revision ?? 0
      setState((current) => {
        if (
          current.key !== listKeyRef.current ||
          !current.changeSet ||
          current.loadedRevision !== pageRevision ||
          current.files.length === 0 ||
          current.files[current.files.length - 1]?.path !== afterPath
        ) {
          return current
        }
        const seen = new Set(current.files.map((item) => item.path))
        const merged = [...current.files]
        let added = 0
        for (const item of page.files) {
          if (!item.hidden && !seen.has(item.path) && merged.length < WORKSPACE_CHANGE_FILES) {
            seen.add(item.path)
            merged.push(item)
            added += 1
          }
        }
        const nextPath = merged.length < WORKSPACE_CHANGE_FILES ? page.nextPath : null
        const advanced = added > 0 || current.nextPath !== nextPath
        if (!advanced && !current.loadingMore && !current.loadMoreError) return current
        if (advanced && pendingRetryRef.current === current.key) {
          pendingRetryRef.current = undefined
        }
        return {
          ...current,
          changeSet: page.changeSet,
          files: merged,
          nextPath,
          loadingMore: false,
          loadMoreError: undefined,
        }
      })
    },
    [changeSetId, sessionId],
  )

  return {
    changeSet: active.changeSet,
    loadedRevision: active.loadedRevision,
    files: active.files,
    nextPath: active.nextPath,
    loading: bridgeAvailable && !settled,
    loadingMore: active.loadingMore,
    error: active.error,
    loadMoreError: active.loadMoreError,
    loadMore,
    mergePage,
    refresh,
  }
}

function readError(read: PreviewReadState): { message: string; retryable: boolean } | undefined {
  if (read.error) return read.error
  return read.preview?.status === 'unavailable'
    ? {
        message: unavailableMessage(read.preview.reason),
        retryable: read.preview.reason === 'temporary_io',
      }
    : undefined
}

class SavedCodeBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { failed: boolean; failedKey?: string | undefined }
> {
  override state: { failed: boolean; failedKey?: string | undefined } = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { failed: boolean; failedKey?: string | undefined },
  ): { failed: boolean; failedKey?: string | undefined } | null {
    if (state.failed && state.failedKey === undefined) {
      return { failed: true, failedKey: props.resetKey }
    }
    if (state.failed && state.failedKey !== props.resetKey) {
      return { failed: false, failedKey: undefined }
    }
    return null
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

interface WorkspaceChangesPanelProps {
  state: WorkspaceChangesPanelState
  expanded: boolean
  onClose: () => void
  onBackToSideChat?: (() => void) | undefined
  onExpandedChange: (expanded: boolean) => void
  onSelectFile?: ((path: string) => void) | undefined
  onUndoFile?: ((changeSetId: string, path: string) => Promise<boolean>) | undefined
  onCreateComment?:
    | ((
        anchor: FileCommentAnchor,
        body: string,
        options?: WorkspaceChangesCommentOptions,
      ) => Promise<FileCommentSaveOutcome>)
    | undefined
  commentingDisabled?: boolean | undefined
  filePath?: string | undefined
  navigationEpoch?: number | undefined
  onRegisterNavigationGuard?:
    | ((guard: ((target: WorkspaceChangesNavigationTarget) => boolean) | undefined) => void)
    | undefined
  onConfirmExternalNavigation?: ((target: WorkspaceChangesNavigationTarget) => void) | undefined
  onFocusChanges?: (() => void) | undefined
}

export function WorkspaceChangesPanel(props: WorkspaceChangesPanelProps): React.JSX.Element {
  return (
    <SavedChangesPanel
      key={JSON.stringify([props.state.sessionId, props.state.changeSetId])}
      {...props}
    />
  )
}

function SavedChangesPanel({
  state,
  expanded,
  onClose,
  onBackToSideChat,
  onExpandedChange,
  onSelectFile,
  onUndoFile,
  onCreateComment,
  commentingDisabled = false,
  filePath,
  navigationEpoch,
  onRegisterNavigationGuard,
  onConfirmExternalNavigation,
  onFocusChanges,
}: WorkspaceChangesPanelProps): React.JSX.Element {
  const effectivePath = filePath ?? state.path
  const effectiveState: WorkspaceChangesPanelState =
    effectivePath === state.path ? state : { ...state, path: effectivePath }
  const normalizedEffectivePath = effectiveState.path.replace(/\\/gu, '/')

  const [mode, setMode] = useState<'diff' | 'after'>('diff')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [undoingFile, setUndoingFile] = useState(false)
  const [locallyUndonePaths, setLocallyUndonePaths] = useState<ReadonlySet<string>>(() => new Set())
  const [commentDrafts, setCommentDrafts] = useState<ReadonlyMap<string, WorkspaceCommentDraft>>(
    () => new Map(),
  )
  const [commentDraftLimitNotice, setCommentDraftLimitNotice] = useState<string | undefined>()
  const [pendingCommentReplacement, setPendingCommentReplacement] = useState<
    { draftKey: string; anchor: FileCommentAnchor; quote: string } | undefined
  >()
  const [pendingNavigation, setPendingNavigation] = useState<
    PendingWorkspaceNavigation | undefined
  >()
  const [savingComment, setSavingComment] = useState<
    { requestId: string; draftId: string; draftKey: string } | undefined
  >()
  const [monacoViewerActivated, setMonacoViewerActivated] = useState(false)
  const [renderedViewerTarget, setRenderedViewerTarget] = useState<
    RenderedViewerTarget | undefined
  >()

  const mountedRef = useRef(true)
  const commentDraftsRef = useRef<ReadonlyMap<string, WorkspaceCommentDraft>>(commentDrafts)
  const pendingNavigationRef = useRef<PendingWorkspaceNavigation | undefined>(pendingNavigation)
  const navigationEpochRef = useRef(navigationEpoch ?? 0)
  const prevNavigationEpochRef = useRef(navigationEpoch ?? 0)
  const savingCommentRef = useRef<
    { requestId: string; draftId: string; draftKey: string } | undefined
  >(undefined)

  const drawerId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const slideDirectionRef = useRef<number>(0)
  const prevPathIndexRef = useRef<{ path: string; index: number }>({
    path: effectiveState.path,
    index: -1,
  })

  // Sliding-pill mode switcher refs
  const modeGroupRef = useRef<HTMLDivElement>(null)
  const modeIndicatorRef = useRef<HTMLSpanElement>(null)
  const modeButtonRefs = useRef(new Map<'diff' | 'after', HTMLButtonElement | null>())

  const changedFiles = useChangedFilesList({
    sessionId: effectiveState.sessionId,
    changeSetId: effectiveState.changeSetId,
    revision: effectiveState.revision,
  })
  const {
    mergePage: mergeChangedFilesPage,
    loadMore: loadMoreChangedFiles,
    error: changedFilesError,
    loadMoreError: changedFilesLoadMoreError,
    loading: changedFilesLoading,
    loadingMore: changedFilesLoadingMore,
    nextPath: changedFilesNextPath,
    files: changedFilesList,
  } = changedFiles
  const effectiveRevision = Math.max(effectiveState.revision ?? 0, changedFiles.loadedRevision ?? 0)
  const previewState: WorkspaceChangesPanelState =
    effectiveRevision !== (effectiveState.revision ?? 0)
      ? { ...effectiveState, revision: effectiveRevision }
      : effectiveState

  const [previewCacheState, setPreviewCacheState] = useState<{
    revision: number
    entries: ReadonlyMap<string, CachedPreviewEntry>
  }>(() => ({ revision: effectiveRevision, entries: new Map() }))
  if (previewCacheState.revision !== effectiveRevision) {
    setPreviewCacheState({ revision: effectiveRevision, entries: new Map() })
  }
  const previewCache =
    previewCacheState.revision === effectiveRevision
      ? previewCacheState.entries
      : new Map<string, CachedPreviewEntry>()

  const cachePreviewEntry = useCallback((entryKey: string, entry: CachedPreviewEntry) => {
    setPreviewCacheState((current) => ({
      ...current,
      entries: putBoundedPreviewCache(current.entries, entryKey, entry),
    }))
  }, [])

  const evictPreviewEntry = useCallback((entryKey: string) => {
    setPreviewCacheState((current) => {
      if (!current.entries.has(entryKey)) return current
      const next = new Map(current.entries)
      next.delete(entryKey)
      return { ...current, entries: next }
    })
  }, [])

  const currentIndex = changedFilesList.findIndex((item) => item.path === effectiveState.path)
  const hasLoadedNextInList = currentIndex >= 0 && currentIndex + 1 < changedFilesList.length
  const nextFile = useNextSavedFile(
    {
      ...effectiveState,
      revision: changedFiles.loadedRevision ?? effectiveState.revision,
    },
    Boolean(onSelectFile) && !hasLoadedNextInList,
  )

  useEffect(() => {
    if (nextFile.page && nextFile.afterPath) {
      mergeChangedFilesPage(nextFile.page, nextFile.afterPath)
    }
  }, [mergeChangedFilesPage, nextFile.afterPath, nextFile.page])

  // If opened directly on a file beyond page 1 (21+ files), page forward until its metadata loads.
  useEffect(() => {
    if (
      currentIndex === -1 &&
      !changedFilesLoading &&
      !changedFilesLoadingMore &&
      !changedFilesError &&
      !changedFilesLoadMoreError &&
      changedFilesNextPath &&
      changedFilesList.length < WORKSPACE_CHANGE_FILES
    ) {
      loadMoreChangedFiles()
    }
  }, [
    changedFilesError,
    changedFilesList.length,
    changedFilesLoadMoreError,
    changedFilesLoading,
    changedFilesLoadingMore,
    changedFilesNextPath,
    currentIndex,
    loadMoreChangedFiles,
  ])

  const beforeRead = useSavedPreview(
    previewState,
    'before',
    previewCache,
    cachePreviewEntry,
    evictPreviewEntry,
  )
  const afterRead = useSavedPreview(
    previewState,
    'after',
    previewCache,
    cachePreviewEntry,
    evictPreviewEntry,
  )
  const before = beforeRead.preview?.status === 'available' ? beforeRead.preview.file : undefined
  const after = afterRead.preview?.status === 'available' ? afterRead.preview.file : undefined
  const needsPatch = !before || !after
  const patchCount = afterRead.preview?.patchCount ?? beforeRead.preview?.patchCount ?? 0
  const versionsSettled = !beforeRead.loading && !afterRead.loading
  const patchRead = useSavedPreview(
    previewState,
    'patch',
    previewCache,
    cachePreviewEntry,
    evictPreviewEntry,
    needsPatch && patchCount > 0,
    patchCount,
  )
  const patchFile = patchRead.preview?.status === 'available' ? patchRead.preview.file : undefined
  const previewFile = mode === 'after' ? after : needsPatch ? patchFile : after
  const selectedRead =
    mode === 'after'
      ? afterRead
      : needsPatch && patchCount > 0
        ? patchRead
        : before
          ? afterRead
          : beforeRead
  const error = readError(selectedRead)
  const previewLoading =
    !previewFile &&
    (mode === 'after' ? afterRead.loading : !versionsSettled || selectedRead.loading)
  const unavailable =
    !previewFile && !error && !previewLoading
      ? 'Before/after versions and patch details aren’t available for this file.'
      : undefined

  const language = projectFileLanguage(effectiveState.path) ?? 'plaintext'
  const { name: label } = splitFilePath(effectiveState.path)

  // Retain the last settled preview within the SAME revision so path switches keep Monaco mounted
  // underneath while an opaque loading overlay covers stale content. Revision bumps discard immediately.
  const [settledSnapshot, setSettledSnapshot] = useState<SettledPreviewSnapshot | undefined>()
  if (
    previewFile &&
    (settledSnapshot?.revision !== effectiveRevision ||
      settledSnapshot.path !== effectiveState.path ||
      settledSnapshot.before !== before ||
      settledSnapshot.after !== after ||
      settledSnapshot.patchFile !== patchFile ||
      settledSnapshot.needsPatch !== needsPatch)
  ) {
    setSettledSnapshot({
      revision: effectiveRevision,
      path: effectiveState.path,
      language,
      before,
      after,
      patchFile,
      patches: patchRead.patches,
      needsPatch,
    })
  }
  const reusableSnapshot =
    settledSnapshot && settledSnapshot.revision === effectiveRevision ? settledSnapshot : undefined

  const reusablePreviewFile =
    mode === 'after'
      ? reusableSnapshot?.after
      : reusableSnapshot?.needsPatch
        ? reusableSnapshot.patchFile
        : reusableSnapshot?.after
  const showRetainedWhileLoading =
    previewLoading && Boolean(reusableSnapshot) && Boolean(reusablePreviewFile)

  const displayBefore = previewFile
    ? before
    : showRetainedWhileLoading
      ? reusableSnapshot?.before
      : undefined
  const displayAfter = previewFile
    ? after
    : showRetainedWhileLoading
      ? reusableSnapshot?.after
      : undefined
  const displayPatchFile = previewFile
    ? patchFile
    : showRetainedWhileLoading
      ? reusableSnapshot?.patchFile
      : undefined
  const displayPatches = previewFile
    ? patchRead.patches
    : showRetainedWhileLoading
      ? reusableSnapshot?.patches
      : undefined
  const displayNeedsPatch = previewFile
    ? needsPatch
    : showRetainedWhileLoading
      ? (reusableSnapshot?.needsPatch ?? needsPatch)
      : needsPatch
  const displayPath = previewFile
    ? effectiveState.path
    : showRetainedWhileLoading
      ? reusableSnapshot!.path
      : effectiveState.path
  const displayLanguage = previewFile
    ? language
    : showRetainedWhileLoading
      ? (reusableSnapshot?.language ?? language)
      : language
  const displayPreviewFile =
    mode === 'after' ? displayAfter : displayNeedsPatch ? displayPatchFile : displayAfter

  const handleRenderedTargetChange = useCallback((mounted: RenderedViewerTarget | undefined) => {
    setMonacoViewerActivated(true)
    setRenderedViewerTarget(mounted)
  }, [])

  const usesMonacoDiffViewer = Boolean(
    displayPreviewFile && mode === 'diff' && displayBefore && displayAfter,
  )
  const usesMonacoCodeViewer = Boolean(
    displayPreviewFile && !usesMonacoDiffViewer && !(mode === 'diff' && displayNeedsPatch),
  )
  const usesMonacoViewer = usesMonacoDiffViewer || usesMonacoCodeViewer
  const expectedViewerPath = `${effectiveState.changeSetId}/${effectiveState.path}`
    .replace(/\\/gu, '/')
    .replace(/^\/+/u, '')
  const viewerTargetAligned =
    !usesMonacoViewer ||
    !monacoViewerActivated ||
    Boolean(
      renderedViewerTarget &&
      renderedViewerTarget.path === expectedViewerPath &&
      (usesMonacoDiffViewer
        ? before !== undefined &&
          after !== undefined &&
          renderedViewerTarget.contentHash === after.contentHash &&
          renderedViewerTarget.beforeContentHash === before.contentHash
        : previewFile !== undefined &&
          renderedViewerTarget.contentHash === previewFile.contentHash &&
          renderedViewerTarget.beforeContentHash === undefined),
    )
  const switchingPreview =
    (previewLoading && displayPath !== effectiveState.path) ||
    (!previewLoading && Boolean(previewFile) && !viewerTargetAligned)

  const currentFile = currentIndex >= 0 ? changedFiles.files[currentIndex] : undefined
  const totalFiles = changedFiles.changeSet?.fileCount ?? changedFiles.files.length
  const prevPath = currentIndex > 0 ? changedFiles.files[currentIndex - 1]?.path : undefined
  const resolvedNextPath =
    (hasLoadedNextInList ? changedFiles.files[currentIndex + 1]?.path : undefined) ??
    nextFile.path ??
    undefined

  const isCurrentFileUndone = isWorkspaceFileUndone(
    currentFile,
    changedFiles.changeSet,
    locallyUndonePaths,
    effectiveRevision,
    effectiveState.path,
  )
  const hasVerifiedCurrentFile =
    Boolean(currentFile) &&
    !changedFiles.loading &&
    changedFiles.changeSet !== undefined &&
    changedFiles.loadedRevision === effectiveRevision &&
    (changedFiles.changeSet.revision ?? 0) >= effectiveRevision
  const previewEndpointsAligned = Boolean(
    currentFile &&
    (!before || !currentFile.before.hash || before.contentHash === currentFile.before.hash) &&
    (!after || !currentFile.after.hash || after.contentHash === currentFile.after.hash) &&
    (!displayNeedsPatch || patchCount === (currentFile.patchVersions?.length ?? patchCount)),
  )
  const canAttemptPerFileUndoSet = Boolean(
    changedFiles.changeSet &&
    ((changedFiles.changeSet.state === 'ready' &&
      !changedFiles.changeSet.undoUnavailableReason &&
      (changedFiles.changeSet.undoableFileCount ?? changedFiles.changeSet.fileCount) > 0) ||
      (changedFiles.changeSet.state === 'mixed' &&
        (changedFiles.changeSet.undoableFileCount ?? 0) > 0)),
  )
  const previewAlignedForUndo =
    !previewLoading &&
    displayPath === effectiveState.path &&
    viewerTargetAligned &&
    changedFiles.loadedRevision === effectiveRevision &&
    previewEndpointsAligned
  const canShowUndoCurrentFile =
    Boolean(onUndoFile) &&
    hasVerifiedCurrentFile &&
    !isCurrentFileUndone &&
    currentFile?.undoStrategy !== 'unavailable' &&
    canAttemptPerFileUndoSet
  const canExecuteUndoCurrentFile = canShowUndoCurrentFile && previewAlignedForUndo && !undoingFile

  const activeDraftKey = after
    ? `${effectiveState.changeSetId}:${after.relativePath.replace(/\\/gu, '/')}:${after.contentHash}`
    : undefined
  const activeCommentDraft = commentingDisabled
    ? undefined
    : activeDraftKey
      ? commentDrafts.get(activeDraftKey)
      : afterRead.loading
        ? [...commentDrafts.values()].find((draft) => draft.path === normalizedEffectivePath)
        : undefined
  const pendingExternalDraft =
    !commentingDisabled && pendingNavigation?.kind === 'external'
      ? commentDrafts.get(pendingNavigation.sourceDraftKey)
      : undefined
  const displayedCommentDraft = pendingExternalDraft ?? activeCommentDraft
  const activePendingReplacement =
    pendingCommentReplacement &&
    displayedCommentDraft &&
    pendingCommentReplacement.draftKey === displayedCommentDraft.draftKey
      ? pendingCommentReplacement
      : undefined
  const activePendingNavigation =
    pendingNavigation &&
    displayedCommentDraft &&
    pendingNavigation.sourceDraftKey === displayedCommentDraft.draftKey
      ? pendingNavigation
      : undefined
  const savingCurrentComment = Boolean(
    savingComment &&
    displayedCommentDraft &&
    savingComment.draftKey === displayedCommentDraft.draftKey &&
    savingComment.draftId === displayedCommentDraft.draftId,
  )

  const previewAlignedForComment =
    !previewLoading &&
    displayPath === effectiveState.path &&
    viewerTargetAligned &&
    !changedFiles.loading &&
    (changedFiles.loadedRevision === undefined ||
      (changedFiles.loadedRevision === effectiveRevision && previewEndpointsAligned))
  const canCommentOnAfter =
    Boolean(onCreateComment) &&
    !commentingDisabled &&
    !switchingPreview &&
    previewAlignedForComment &&
    Boolean(after) &&
    !after?.isExternal &&
    !isCurrentFileUndone &&
    currentFile?.kind !== 'deleted'

  const effectiveStateRef = useRef({
    sessionId: effectiveState.sessionId,
    changeSetId: effectiveState.changeSetId,
    path: effectiveState.path,
  })
  const activeCommentDraftRef = useRef(activeCommentDraft)
  const commentingDisabledRef = useRef(commentingDisabled)
  const onFocusChangesRef = useRef(onFocusChanges)
  const onConfirmExternalNavigationRef = useRef(onConfirmExternalNavigation)

  useLayoutEffect(() => {
    commentDraftsRef.current = commentDrafts
    pendingNavigationRef.current = pendingNavigation
    navigationEpochRef.current = navigationEpoch ?? 0
    effectiveStateRef.current = {
      sessionId: effectiveState.sessionId,
      changeSetId: effectiveState.changeSetId,
      path: effectiveState.path,
    }
    activeCommentDraftRef.current = activeCommentDraft
    commentingDisabledRef.current = commentingDisabled
    onFocusChangesRef.current = onFocusChanges
    onConfirmExternalNavigationRef.current = onConfirmExternalNavigation
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      pendingNavigationRef.current = undefined
    }
  }, [])

  useEffect(() => {
    const currentEpoch = navigationEpoch ?? 0
    if (prevNavigationEpochRef.current !== currentEpoch) {
      prevNavigationEpochRef.current = currentEpoch
      pendingNavigationRef.current = undefined
      setPendingNavigation(undefined)
    }
  }, [navigationEpoch])

  useEffect(() => {
    if (!onRegisterNavigationGuard) return undefined
    const guard = (target: WorkspaceChangesNavigationTarget): boolean => {
      if (commentingDisabledRef.current) return false
      const current = effectiveStateRef.current
      const sameContext =
        target.sessionId === current.sessionId && target.changeSetId === current.changeSetId
      const sameTarget = sameContext && target.path === current.path
      if (sameTarget) return false

      const activeDraft = activeCommentDraftRef.current
      let dirtyDraft: WorkspaceCommentDraft | undefined
      if (activeDraft && activeDraft.body.trim().length > 0) {
        dirtyDraft = activeDraft
      } else if (!sameContext) {
        for (const draft of commentDraftsRef.current.values()) {
          if (draft.body.trim().length > 0) {
            dirtyDraft = draft
            break
          }
        }
      }
      if (!dirtyDraft) return false

      onFocusChangesRef.current?.()
      setDrawerOpen(false)
      const nextPending: PendingWorkspaceNavigation = {
        kind: 'external',
        target,
        sourceDraftKey: dirtyDraft.draftKey,
        capturedEpoch: navigationEpochRef.current,
      }
      pendingNavigationRef.current = nextPending
      setPendingNavigation(nextPending)
      return true
    }
    onRegisterNavigationGuard(guard)
    return () => {
      onRegisterNavigationGuard(undefined)
    }
  }, [onRegisterNavigationGuard])

  const commitCommentDrafts = useCallback(
    (
      updater: (
        current: ReadonlyMap<string, WorkspaceCommentDraft>,
      ) => ReadonlyMap<string, WorkspaceCommentDraft>,
    ): ReadonlyMap<string, WorkspaceCommentDraft> => {
      const next = updater(commentDraftsRef.current)
      if (next === commentDraftsRef.current) return next
      commentDraftsRef.current = next
      setCommentDrafts(next)
      return next
    },
    [],
  )

  const clearDraftByKey = useCallback(
    (draftKey: string) => {
      commitCommentDrafts((current) => {
        if (!current.has(draftKey)) return current
        const next = new Map(current)
        next.delete(draftKey)
        return next
      })
      setCommentDraftLimitNotice(undefined)
      setPendingCommentReplacement((current) =>
        current?.draftKey === draftKey ? undefined : current,
      )
      setPendingNavigation((current) => {
        const next = current?.sourceDraftKey === draftKey ? undefined : current
        pendingNavigationRef.current = next
        return next
      })
    },
    [commitCommentDrafts],
  )

  const performNavigateToFile = useCallback(
    (targetPath: string, direction: number) => {
      if (!onSelectFile || targetPath === effectiveState.path) return
      pendingNavigationRef.current = undefined
      setPendingNavigation(undefined)
      slideDirectionRef.current = direction
      setDrawerOpen(false)
      onSelectFile(targetPath)
    },
    [effectiveState.path, onSelectFile],
  )

  const navigateToFile = useCallback(
    (targetPath: string, direction: number) => {
      if (!onSelectFile || targetPath === effectiveState.path) return
      if (activeCommentDraft && activeCommentDraft.body.trim().length > 0) {
        setDrawerOpen(false)
        const nextPending: PendingWorkspaceNavigation = {
          kind: 'internal',
          targetPath,
          direction,
          sourceDraftKey: activeCommentDraft.draftKey,
          capturedEpoch: navigationEpochRef.current,
        }
        pendingNavigationRef.current = nextPending
        setPendingNavigation(nextPending)
        return
      }
      performNavigateToFile(targetPath, direction)
    },
    [activeCommentDraft, effectiveState.path, onSelectFile, performNavigateToFile],
  )

  const handleStepPrev = useCallback(() => {
    if (prevPath) navigateToFile(prevPath, -1)
  }, [navigateToFile, prevPath])

  const handleStepNext = useCallback(() => {
    if (nextFile.error) {
      nextFile.retry()
      return
    }
    if (nextFile.page && nextFile.afterPath) {
      changedFiles.mergePage(nextFile.page, nextFile.afterPath)
    }
    if (resolvedNextPath) navigateToFile(resolvedNextPath, 1)
  }, [changedFiles, navigateToFile, nextFile, resolvedNextPath])

  const handleUndoCurrentFile = async (): Promise<void> => {
    if (!onUndoFile || !canExecuteUndoCurrentFile) return
    const targetChangeSetId = effectiveState.changeSetId
    const targetPath = effectiveState.path
    const targetRevision = effectiveRevision
    setUndoingFile(true)
    try {
      const ok = await onUndoFile(targetChangeSetId, targetPath)
      if (ok) {
        setLocallyUndonePaths((current) => {
          const next = new Set(current)
          next.add(`${targetRevision}:${targetPath}`)
          return next
        })
        changedFiles.refresh()
      }
    } finally {
      setUndoingFile(false)
    }
  }

  const handleOpenCommentComposer = useCallback(
    (range: {
      startLine: number
      startColumn: number
      endLine: number
      endColumn: number
      quote: string
    }) => {
      if (!after || !activeDraftKey || !canCommentOnAfter) return
      const anchor: FileCommentAnchor = {
        type: 'file',
        path: after.relativePath.replace(/\\/gu, '/'),
        contentHash: after.contentHash,
        startLine: range.startLine,
        startColumn: range.startColumn,
        endLine: range.endLine,
        endColumn: range.endColumn,
        quote: range.quote,
      }
      const existing = commentDraftsRef.current.get(activeDraftKey)
      if (existing && existing.body.trim().length > 0) {
        setPendingCommentReplacement({ draftKey: activeDraftKey, anchor, quote: range.quote })
        return
      }
      const newDraft: WorkspaceCommentDraft = {
        draftKey: activeDraftKey,
        path: anchor.path,
        contentHash: after.contentHash,
        draftId: crypto.randomUUID(),
        commentId: crypto.randomUUID(),
        persisted: false,
        anchor,
        quote: range.quote,
        body: '',
      }
      const result = putBoundedCommentDraft(commentDraftsRef.current, activeDraftKey, newDraft)
      if (result.evictedBlocked) {
        setCommentDraftLimitNotice(
          `You have ${MAX_COMMENT_DRAFTS} unsaved comment drafts. Save or discard one before starting another.`,
        )
        return
      }
      setPendingCommentReplacement(undefined)
      setCommentDraftLimitNotice(undefined)
      commentDraftsRef.current = result.next
      setCommentDrafts(result.next)
    },
    [activeDraftKey, after, canCommentOnAfter],
  )

  const saveCommentDraft = async (
    targetDraft: WorkspaceCommentDraft | undefined = displayedCommentDraft,
    options?: { keepPendingNavigation?: boolean },
  ): Promise<{ cleared: boolean }> => {
    if (
      !onCreateComment ||
      !targetDraft?.body.trim() ||
      commentingDisabled ||
      savingCommentRef.current
    ) {
      return { cleared: false }
    }
    const reusedSubmit =
      targetDraft.pendingSubmit && targetDraft.pendingSubmit.body === targetDraft.body
        ? targetDraft.pendingSubmit
        : undefined
    const pendingSubmit: PendingWorkspaceCommentSubmit = reusedSubmit ?? {
      requestId: crypto.randomUUID(),
      body: targetDraft.body,
      mode: targetDraft.persisted ? 'edit' : 'create',
    }
    const submitted = {
      ...targetDraft,
      requestId: pendingSubmit.requestId,
      mode: pendingSubmit.mode,
      sessionId: effectiveState.sessionId,
    }
    const token = {
      requestId: submitted.requestId,
      draftId: submitted.draftId,
      draftKey: submitted.draftKey,
    }
    savingCommentRef.current = token
    setSavingComment(token)
    if (!reusedSubmit) {
      commitCommentDrafts((current) => {
        const live = current.get(submitted.draftKey)
        if (!live || live.draftId !== submitted.draftId) return current
        const next = new Map(current)
        next.set(submitted.draftKey, { ...live, pendingSubmit })
        return next
      })
    }
    try {
      const saved = await onCreateComment(submitted.anchor, submitted.body, {
        commentId: submitted.commentId,
        sessionId: submitted.sessionId,
        requestId: submitted.requestId,
        mode: submitted.mode,
      })
      if (!mountedRef.current) return { cleared: false }
      if (saved === false) return { cleared: false }
      if (typeof saved === 'object' && saved !== null && 'conflict' in saved) {
        commitCommentDrafts((current) => {
          const live = current.get(submitted.draftKey)
          if (
            !live ||
            live.draftId !== submitted.draftId ||
            live.commentId !== submitted.commentId
          ) {
            return current
          }
          const next = new Map(current)
          next.set(submitted.draftKey, {
            ...live,
            draftId: crypto.randomUUID(),
            pendingSubmit: undefined,
          })
          return next
        })
        return { cleared: false }
      }
      const succeeded = saved === true || (typeof saved === 'string' && saved.length > 0)
      if (!succeeded) return { cleared: false }
      const savedCommentId = typeof saved === 'string' ? saved : submitted.commentId
      const liveBeforeUpdate = commentDraftsRef.current.get(submitted.draftKey)
      if (
        !liveBeforeUpdate ||
        liveBeforeUpdate.draftId !== submitted.draftId ||
        liveBeforeUpdate.commentId !== submitted.commentId
      ) {
        return { cleared: false }
      }
      const cleared = liveBeforeUpdate.body === submitted.body
      commitCommentDrafts((current) => {
        const live = current.get(submitted.draftKey)
        if (!live || live.draftId !== submitted.draftId || live.commentId !== submitted.commentId) {
          return current
        }
        const next = new Map(current)
        if (live.body === submitted.body) {
          next.delete(submitted.draftKey)
        } else {
          // User kept editing while saving: preserve saved commentId and mark persisted so next save edits.
          next.set(submitted.draftKey, {
            ...live,
            draftId: crypto.randomUUID(),
            commentId: savedCommentId,
            persisted: true,
            pendingSubmit: undefined,
          })
        }
        return next
      })
      setPendingCommentReplacement((current) =>
        current?.draftKey === submitted.draftKey ? undefined : current,
      )
      setCommentDraftLimitNotice(undefined)
      if (cleared && !options?.keepPendingNavigation) {
        setPendingNavigation((current) => {
          const next = current?.sourceDraftKey === submitted.draftKey ? undefined : current
          pendingNavigationRef.current = next
          return next
        })
      }
      return { cleared }
    } finally {
      if (savingCommentRef.current?.requestId === submitted.requestId) {
        savingCommentRef.current = undefined
        if (mountedRef.current) {
          setSavingComment(undefined)
        }
      }
    }
  }

  // Sliding pill position sync for Diff / After mode switcher.
  useLayoutEffect(() => {
    const syncIndicator = (): void => {
      const indicator = modeIndicatorRef.current
      const activeButton = modeButtonRefs.current.get(mode)
      if (!indicator || !activeButton) {
        if (indicator) indicator.style.opacity = '0'
        return
      }
      const left = activeButton.offsetLeft
      const width = activeButton.offsetWidth
      indicator.style.opacity = width > 0 ? '1' : '0'
      indicator.style.width = `${width}px`
      indicator.style.transform = `translate3d(${left}px, 0, 0)`
    }
    syncIndicator()
    const group = modeGroupRef.current
    if (!group || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(syncIndicator)
    observer.observe(group)
    return () => observer.disconnect()
  }, [mode])

  // Directional ±10px silk slide when switching files without unmounting Monaco.
  useEffect(() => {
    const prev = prevPathIndexRef.current
    let direction = slideDirectionRef.current
    slideDirectionRef.current = 0
    if (
      direction === 0 &&
      prev.path !== effectiveState.path &&
      prev.index >= 0 &&
      currentIndex >= 0
    ) {
      direction = currentIndex > prev.index ? 1 : currentIndex < prev.index ? -1 : 0
    }
    prevPathIndexRef.current = { path: effectiveState.path, index: currentIndex }
    const el = viewportRef.current
    if (!el || direction === 0 || typeof el.animate !== 'function') return undefined
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const animation = el.animate(
      reduced
        ? [{ opacity: 0.65 }, { opacity: 1 }]
        : [
            { opacity: 0.35, transform: `translate3d(${direction > 0 ? 10 : -10}px, 0, 0)` },
            { opacity: 1, transform: 'translate3d(0, 0, 0)' },
          ],
      {
        duration: reduced ? 100 : 200,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    )
    return () => animation.cancel()
  }, [effectiveState.path, currentIndex])

  // Alt+[ / Alt+] keyboard shortcuts for Prev / Next changed file navigation.
  useEffect(() => {
    if (!onSelectFile) return undefined
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const isPrev = event.code === 'BracketLeft' || event.key === '['
      const isNext = event.code === 'BracketRight' || event.key === ']'
      if (!isPrev && !isNext) return
      const panel = panelRef.current
      if (!panel || panel.closest('[hidden], [inert]')) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)
      ) {
        return
      }
      if (isPrev && prevPath) {
        event.preventDefault()
        handleStepPrev()
      } else if (isNext && (resolvedNextPath || nextFile.error)) {
        event.preventDefault()
        handleStepNext()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleStepNext, handleStepPrev, nextFile.error, onSelectFile, prevPath, resolvedNextPath])

  const currentBadge = currentFile ? FILE_KIND_BADGE[currentFile.kind] : undefined
  const indexLabel =
    currentIndex >= 0 && totalFiles > 0
      ? `${currentIndex + 1} / ${totalFiles}`
      : totalFiles > 0
        ? `${totalFiles}`
        : undefined
  const canOpenDrawer = changedFiles.files.length > 0 || changedFiles.loading

  return (
    <section
      ref={panelRef}
      className="flex h-full min-h-0 flex-col"
      aria-labelledby="workspace-changes-title"
    >
      {onBackToSideChat ? (
        <div className="flex h-10 shrink-0 items-center border-b border-border px-3">
          <button
            type="button"
            className="pact-pressable inline-flex h-7 cursor-pointer items-center gap-1 rounded-control px-2 text-caption font-medium text-secondary transition-colors hover:bg-surface-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
            onClick={onBackToSideChat}
          >
            <ChevronLeft aria-hidden="true" className="size-4" strokeWidth={1.75} />
            Back to side chat
          </button>
        </div>
      ) : null}

      <header className="shrink-0 border-b border-border bg-surface-muted/70 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            id="workspace-changes-title"
            aria-expanded={canOpenDrawer ? drawerOpen : undefined}
            aria-controls={canOpenDrawer ? drawerId : undefined}
            disabled={!canOpenDrawer}
            title={effectiveState.path}
            onClick={() => setDrawerOpen((open) => !open)}
            className="pact-pressable flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface-raised px-2.5 text-left text-caption transition-colors hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:hover:bg-surface-raised"
          >
            {currentBadge ? (
              <span
                className={`inline-grid size-5 shrink-0 place-items-center rounded-md font-mono text-[10px] font-semibold ${currentBadge.className}`}
                aria-label={currentBadge.label}
              >
                {currentBadge.code}
              </span>
            ) : (
              <FileDiff
                aria-hidden="true"
                className="size-3.5 shrink-0 text-secondary"
                strokeWidth={1.75}
              />
            )}
            <span
              className={`min-w-0 truncate font-mono font-medium text-primary ${isCurrentFileUndone ? 'line-through opacity-55' : ''}`}
            >
              {label}
            </span>
            {isCurrentFileUndone ? (
              <span className="shrink-0 rounded-pill bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium text-tertiary">
                Undone
              </span>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums text-tertiary">
              {indexLabel ? <span>{indexLabel}</span> : null}
              {canOpenDrawer ? (
                <ChevronDown
                  aria-hidden="true"
                  className={`size-3.5 transition-transform duration-200 ease-[var(--ease-silk-out)] ${drawerOpen ? 'rotate-180' : ''}`}
                  strokeWidth={1.8}
                />
              ) : null}
            </span>
          </button>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label="Previous changed file"
              title={prevPath ? `Previous: ${prevPath} (Alt+[)` : 'First changed file (Alt+[)'}
              disabled={!onSelectFile || !prevPath}
              onClick={handleStepPrev}
              className="pact-pressable grid size-8 cursor-pointer place-items-center rounded-lg border border-border bg-surface-raised text-secondary hover:bg-row-hover hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45"
            >
              <ChevronLeft aria-hidden="true" className="size-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label="Next changed file"
              aria-busy={nextFile.loading}
              title={
                nextFile.error ??
                (nextFile.loading
                  ? 'Loading the next file…'
                  : resolvedNextPath
                    ? `Next: ${resolvedNextPath} (Alt+])`
                    : 'Last changed file (Alt+])')
              }
              disabled={
                !onSelectFile ||
                (nextFile.loading && !resolvedNextPath) ||
                (!nextFile.error && !resolvedNextPath)
              }
              onClick={handleStepNext}
              className="pact-pressable grid size-8 cursor-pointer place-items-center rounded-lg border border-border bg-surface-raised text-secondary hover:bg-row-hover hover:text-primary focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45"
            >
              {nextFile.loading && !resolvedNextPath ? (
                <span className="primary-action-spinner" aria-hidden="true" />
              ) : (
                <ChevronRight aria-hidden="true" className="size-4" strokeWidth={1.75} />
              )}
            </button>
            <button
              className="pact-pressable grid size-8 cursor-pointer place-items-center rounded-lg text-secondary hover:bg-row-hover hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
              type="button"
              aria-label={expanded ? 'Restore changes preview' : 'Expand changes preview'}
              title={expanded ? 'Restore preview' : 'Expand preview'}
              onClick={() => onExpandedChange(!expanded)}
            >
              {expanded ? (
                <Minimize2 aria-hidden="true" className="size-4" strokeWidth={1.75} />
              ) : (
                <Maximize2 aria-hidden="true" className="size-4" strokeWidth={1.75} />
              )}
            </button>
            <button
              className="pact-pressable grid size-8 cursor-pointer place-items-center rounded-lg text-secondary hover:bg-row-hover hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
              type="button"
              aria-label="Close changes preview"
              title="Close preview"
              onClick={onClose}
            >
              <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {/* Smooth CSS-grid 0fr -> 1fr changed-file dropdown drawer */}
        <div
          id={drawerId}
          aria-hidden={!drawerOpen}
          inert={!drawerOpen}
          className={`grid transition-[grid-template-rows,opacity] duration-250 ease-[var(--ease-silk-out)] motion-reduce:transition-opacity motion-reduce:duration-100 ${
            drawerOpen ? 'mt-2 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-xl border border-border bg-surface-raised p-1 text-caption shadow-sm">
              {changedFiles.files.map((file, index) => {
                const badge = FILE_KIND_BADGE[file.kind]
                const { name, directory } = splitFilePath(file.path)
                const isSelected = file.path === effectiveState.path
                const fileUndone = isWorkspaceFileUndone(
                  file,
                  changedFiles.changeSet,
                  locallyUndonePaths,
                  effectiveRevision,
                  file.path,
                )
                return (
                  <button
                    key={file.path}
                    type="button"
                    tabIndex={drawerOpen ? 0 : -1}
                    aria-current={isSelected ? 'true' : undefined}
                    title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                    onClick={() => {
                      const dir =
                        currentIndex >= 0
                          ? index > currentIndex
                            ? 1
                            : index < currentIndex
                              ? -1
                              : 0
                          : 0
                      navigateToFile(file.path, dir)
                    }}
                    className={`relative flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
                      isSelected ? 'bg-accent-soft' : 'hover:bg-row-hover'
                    }`}
                  >
                    {isSelected ? (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1.5 bottom-1.5 left-1 w-[3px] rounded-pill bg-focus"
                      />
                    ) : null}
                    <span
                      className={`inline-grid size-4 shrink-0 place-items-center rounded font-mono text-[10px] font-semibold ${badge.className}`}
                      aria-label={badge.label}
                    >
                      {badge.code}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <span
                        className={`font-mono font-medium text-primary ${fileUndone ? 'line-through opacity-55' : ''}`}
                      >
                        {name}
                      </span>
                      {directory ? (
                        <span className="ml-1.5 font-mono text-[11px] text-tertiary">
                          {directory}
                        </span>
                      ) : null}
                    </span>
                    {fileUndone ? (
                      <span className="shrink-0 rounded-pill bg-surface-muted px-1.5 py-0.5 text-[10px] text-tertiary">
                        Undone
                      </span>
                    ) : null}
                    {file.additions !== null && file.deletions !== null ? (
                      <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">
                        <span className="text-diff-added-foreground">+{file.additions}</span>
                        <span className="text-diff-removed-foreground">−{file.deletions}</span>
                      </span>
                    ) : null}
                  </button>
                )
              })}
              {changedFiles.loadMoreError ? (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-caption text-status-warning-foreground"
                >
                  <span className="min-w-0 flex-1">{changedFiles.loadMoreError}</span>
                  <button
                    type="button"
                    tabIndex={drawerOpen ? 0 : -1}
                    disabled={changedFiles.loadingMore}
                    onClick={changedFiles.loadMore}
                    className="pact-pressable shrink-0 cursor-pointer rounded-md px-2 py-0.5 font-medium text-primary hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50"
                  >
                    Retry
                  </button>
                </div>
              ) : changedFiles.nextPath ? (
                <button
                  type="button"
                  tabIndex={drawerOpen ? 0 : -1}
                  disabled={changedFiles.loadingMore}
                  onClick={changedFiles.loadMore}
                  className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-caption font-medium text-secondary hover:bg-row-hover hover:text-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50"
                >
                  {changedFiles.loadingMore ? (
                    <>
                      <span className="primary-action-spinner" aria-hidden="true" /> Loading more…
                    </>
                  ) : (
                    'Load more files'
                  )}
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* Mode sliding-pill switcher + single-file Undo action */}
        <div className="mt-2 flex items-center justify-between gap-2 text-caption">
          <div
            ref={modeGroupRef}
            className="relative inline-flex items-center gap-0.5 rounded-xl bg-surface p-0.5 border border-border"
          >
            <span
              ref={modeIndicatorRef}
              aria-hidden="true"
              className="pact-inspector-tab-indicator"
              style={{ opacity: 0 }}
            />
            {(['diff', 'after'] as const).map((option) => (
              <button
                key={option}
                ref={(node) => {
                  modeButtonRefs.current.set(option, node)
                }}
                className={`relative z-10 h-6 cursor-pointer rounded-[10px] px-2.5 text-caption font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-45 ${
                  mode === option ? 'text-primary' : 'text-secondary hover:text-primary'
                }`}
                type="button"
                aria-pressed={mode === option}
                disabled={
                  option === 'after' &&
                  afterRead.preview?.status === 'unavailable' &&
                  afterRead.preview.reason !== 'temporary_io'
                }
                title={
                  option === 'after' && afterRead.preview?.status === 'unavailable'
                    ? unavailableMessage(afterRead.preview.reason)
                    : undefined
                }
                onClick={() => setMode(option)}
              >
                {option === 'diff' ? 'Diff' : 'After'}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            {mode === 'diff' &&
            previewFile &&
            (readError(beforeRead)?.retryable || readError(afterRead)?.retryable) ? (
              <button
                type="button"
                aria-label="Retry reading saved versions"
                title="Retry reading saved versions"
                className="pact-pressable grid size-7 cursor-pointer place-items-center rounded-lg text-secondary hover:bg-row-hover hover:text-primary focus-visible:outline-2 focus-visible:outline-focus"
                onClick={() => {
                  if (readError(beforeRead)?.retryable) beforeRead.retry()
                  if (readError(afterRead)?.retryable) afterRead.retry()
                }}
              >
                <RotateCcw aria-hidden="true" className="size-3.5" />
              </button>
            ) : null}

            {canShowUndoCurrentFile ? (
              <button
                type="button"
                disabled={!canExecuteUndoCurrentFile}
                onClick={() => void handleUndoCurrentFile()}
                className="pact-pressable inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-caption font-medium text-status-info-foreground hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50"
              >
                {undoingFile ? (
                  <span className="primary-action-spinner" aria-hidden="true" />
                ) : (
                  <RotateCcw aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                )}
                <span>{undoingFile ? 'Undoing…' : 'Undo this file'}</span>
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-[11px] text-tertiary">
        <span className="min-w-0 truncate font-mono" title={effectiveState.path}>
          {effectiveState.path}
        </span>
        {canCommentOnAfter ? <span className="shrink-0">Select code to comment</span> : null}
      </div>

      {changedFiles.error ? (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-panel py-2 text-caption text-status-warning-foreground"
        >
          <span className="min-w-0 flex-1">{changedFiles.error}</span>
          <button
            type="button"
            onClick={changedFiles.refresh}
            className="pact-pressable shrink-0 cursor-pointer rounded-md border border-border bg-surface-raised px-2 py-0.5 font-medium text-primary hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            Retry
          </button>
        </div>
      ) : null}

      {nextFile.error ? (
        <p
          role="alert"
          className="shrink-0 border-b border-border px-panel py-2 text-caption text-status-warning-foreground"
        >
          {nextFile.error}
        </p>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {previewLoading && !showRetainedWhileLoading ? (
          <div
            className="grid min-h-0 flex-1 place-items-center text-caption text-secondary"
            aria-busy="true"
          >
            Loading saved changes…
          </div>
        ) : (error || unavailable) && !showRetainedWhileLoading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-section" role="alert">
            <div className="w-full max-w-72 text-center">
              <AlertTriangle
                aria-hidden="true"
                className="mx-auto size-5 text-status-warning-foreground"
                strokeWidth={1.75}
              />
              <h3 className="mt-group text-body font-medium text-primary">
                Saved preview unavailable
              </h3>
              <p className="mt-1 text-caption leading-relaxed text-secondary">
                {error?.message ?? unavailable}
              </p>
              {error?.retryable ? (
                <button
                  className="pact-pressable mt-section inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control border border-border px-3 text-caption font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus"
                  type="button"
                  onClick={selectedRead.retry}
                >
                  <RotateCcw aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                  Try again
                </button>
              ) : null}
            </div>
          </div>
        ) : displayPreviewFile ? (
          <div
            ref={viewportRef}
            className="relative min-h-0 flex-1 overflow-hidden bg-surface"
            data-pact-surface
            aria-busy={previewLoading ? 'true' : undefined}
          >
            <div
              className="h-full min-h-0 w-full"
              inert={switchingPreview}
              aria-hidden={switchingPreview ? 'true' : undefined}
            >
              <SavedCodeBoundary
                resetKey={`${effectiveState.changeSetId}:${effectiveRevision}:${displayPath}:${mode}`}
                fallback={
                  mode === 'after' ? (
                    <PlainFileViewer file={displayPreviewFile} wrapLines />
                  ) : (
                    <div className="p-panel text-caption text-secondary" role="alert">
                      Couldn’t display diff. Choose After to read the saved code.
                    </div>
                  )
                }
              >
                <Suspense
                  fallback={
                    <div
                      className="grid h-full place-items-center text-caption text-secondary"
                      aria-busy="true"
                    >
                      Loading code view…
                    </div>
                  }
                >
                  {mode === 'diff' && displayBefore && displayAfter ? (
                    <ProjectDiffViewer
                      path={`${effectiveState.changeSetId}/${displayPath}`}
                      before={displayBefore.content}
                      after={displayAfter.content}
                      beforeContentHash={displayBefore.contentHash}
                      afterContentHash={displayAfter.contentHash}
                      language={displayLanguage}
                      onRenderedTargetChange={handleRenderedTargetChange}
                      onCreateComment={
                        canCommentOnAfter && !previewLoading ? handleOpenCommentComposer : undefined
                      }
                    />
                  ) : mode === 'diff' && displayNeedsPatch ? (
                    <RecordedPatchViewer
                      key={`${effectiveState.changeSetId}:${effectiveRevision}:${displayPath}:${displayPatchFile?.contentHash ?? ''}`}
                      path={displayPath}
                      contents={displayPatches ?? [displayPreviewFile.content]}
                    />
                  ) : (
                    <ProjectCodeViewer
                      path={`${effectiveState.changeSetId}/${displayPath}`}
                      content={displayPreviewFile.content}
                      contentHash={displayPreviewFile.contentHash}
                      language={
                        displayNeedsPatch && mode === 'diff' ? 'plaintext' : displayLanguage
                      }
                      onRenderedTargetChange={handleRenderedTargetChange}
                      onCreateComment={
                        mode === 'after' && canCommentOnAfter && !previewLoading
                          ? handleOpenCommentComposer
                          : undefined
                      }
                    />
                  )}
                </Suspense>
              </SavedCodeBoundary>
            </div>

            {switchingPreview ? (
              <div
                className="absolute inset-0 z-10 grid place-items-center bg-surface text-caption text-secondary"
                aria-busy="true"
              >
                Loading saved changes…
              </div>
            ) : null}
          </div>
        ) : null}

        {commentDraftLimitNotice && !displayedCommentDraft ? (
          <div
            role="alert"
            className="absolute inset-x-3 bottom-3 z-20 flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-raised px-3 py-2.5 text-caption text-status-warning-foreground shadow-popover"
          >
            <span>{commentDraftLimitNotice}</span>
            <button
              type="button"
              aria-label="Dismiss notice"
              className="pact-pressable grid size-6 shrink-0 cursor-pointer place-items-center rounded-control text-secondary hover:bg-surface-muted hover:text-primary"
              onClick={() => setCommentDraftLimitNotice(undefined)}
            >
              <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>
        ) : null}

        {displayedCommentDraft ? (
          <section className="absolute inset-x-3 bottom-3 z-20 rounded-xl border border-border bg-surface-raised p-3 shadow-popover">
            {commentDraftLimitNotice ? (
              <div
                role="alert"
                className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-muted px-2.5 py-2 text-caption text-status-warning-foreground"
              >
                <span>{commentDraftLimitNotice}</span>
                <button
                  type="button"
                  aria-label="Dismiss notice"
                  className="pact-pressable grid size-6 shrink-0 cursor-pointer place-items-center rounded-control text-secondary hover:bg-surface-raised hover:text-primary"
                  onClick={() => setCommentDraftLimitNotice(undefined)}
                >
                  <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                </button>
              </div>
            ) : null}
            {activePendingNavigation ? (
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-muted px-2.5 py-2 text-caption">
                <span className="text-primary">
                  Save or discard your comment before switching files?
                </span>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    disabled={savingCurrentComment}
                    className="pact-pressable h-7 cursor-pointer rounded-control px-2 text-secondary hover:bg-surface-raised hover:text-primary disabled:opacity-40"
                    onClick={() => {
                      pendingNavigationRef.current = undefined
                      setPendingNavigation(undefined)
                    }}
                  >
                    Stay
                  </button>
                  <button
                    type="button"
                    disabled={savingCurrentComment}
                    className="pact-pressable h-7 cursor-pointer rounded-control px-2 text-secondary hover:bg-surface-raised hover:text-primary disabled:opacity-40"
                    onClick={() => {
                      const next = activePendingNavigation
                      clearDraftByKey(displayedCommentDraft.draftKey)
                      if (next.kind === 'external') {
                        const sameContext =
                          next.target.sessionId === effectiveStateRef.current.sessionId &&
                          next.target.changeSetId === effectiveStateRef.current.changeSetId
                        if (!sameContext) {
                          let remainingDirty: WorkspaceCommentDraft | undefined
                          for (const draft of commentDraftsRef.current.values()) {
                            if (draft.body.trim().length > 0) {
                              remainingDirty = draft
                              break
                            }
                          }
                          if (remainingDirty) {
                            const chained: PendingWorkspaceNavigation = {
                              ...next,
                              sourceDraftKey: remainingDirty.draftKey,
                            }
                            pendingNavigationRef.current = chained
                            setPendingNavigation(chained)
                            return
                          }
                        }
                        pendingNavigationRef.current = undefined
                        setPendingNavigation(undefined)
                        onConfirmExternalNavigationRef.current?.(next.target)
                      } else {
                        performNavigateToFile(next.targetPath, next.direction)
                      }
                    }}
                  >
                    Discard & switch
                  </button>
                  <button
                    type="button"
                    disabled={savingCurrentComment || !displayedCommentDraft.body.trim()}
                    className="pact-pressable h-7 cursor-pointer rounded-control bg-surface-inverse px-2 font-medium text-inverse disabled:opacity-40"
                    onClick={() => {
                      const next = activePendingNavigation
                      const draftToSave = displayedCommentDraft
                      void (async () => {
                        const result = await saveCommentDraft(draftToSave, {
                          keepPendingNavigation: true,
                        })
                        if (
                          !result.cleared ||
                          !mountedRef.current ||
                          navigationEpochRef.current !== next.capturedEpoch ||
                          pendingNavigationRef.current !== next
                        ) {
                          return
                        }
                        const liveDraft = commentDraftsRef.current.get(next.sourceDraftKey)
                        if (liveDraft && liveDraft.body.trim().length > 0) {
                          return
                        }
                        if (next.kind === 'external') {
                          const sameContext =
                            next.target.sessionId === effectiveStateRef.current.sessionId &&
                            next.target.changeSetId === effectiveStateRef.current.changeSetId
                          if (!sameContext) {
                            let remainingDirty: WorkspaceCommentDraft | undefined
                            for (const draft of commentDraftsRef.current.values()) {
                              if (draft.body.trim().length > 0) {
                                remainingDirty = draft
                                break
                              }
                            }
                            if (remainingDirty) {
                              const chained: PendingWorkspaceNavigation = {
                                ...next,
                                sourceDraftKey: remainingDirty.draftKey,
                              }
                              pendingNavigationRef.current = chained
                              setPendingNavigation(chained)
                              return
                            }
                          }
                          pendingNavigationRef.current = undefined
                          setPendingNavigation(undefined)
                          onConfirmExternalNavigationRef.current?.(next.target)
                        } else {
                          performNavigateToFile(next.targetPath, next.direction)
                        }
                      })()
                    }}
                  >
                    {savingCurrentComment ? 'Saving…' : 'Save & switch'}
                  </button>
                </div>
              </div>
            ) : activePendingReplacement ? (
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-muted px-2.5 py-2 text-caption">
                <span className="text-primary">
                  Replace your unsaved comment with the new selection?
                </span>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={savingCurrentComment}
                    className="pact-pressable h-7 cursor-pointer rounded-control px-2 text-secondary hover:bg-surface-raised hover:text-primary disabled:opacity-40"
                    onClick={() => setPendingCommentReplacement(undefined)}
                  >
                    Keep editing
                  </button>
                  <button
                    type="button"
                    disabled={savingCurrentComment}
                    className="pact-pressable h-7 cursor-pointer rounded-control bg-surface-inverse px-2 font-medium text-inverse disabled:opacity-40"
                    onClick={() => {
                      const replacement = activePendingReplacement
                      setPendingCommentReplacement(undefined)
                      setCommentDraftLimitNotice(undefined)
                      commitCommentDrafts((current) => {
                        const result = putBoundedCommentDraft(current, replacement.draftKey, {
                          draftKey: replacement.draftKey,
                          path: replacement.anchor.path,
                          contentHash: replacement.anchor.contentHash,
                          draftId: crypto.randomUUID(),
                          commentId: crypto.randomUUID(),
                          persisted: false,
                          anchor: replacement.anchor,
                          quote: replacement.quote,
                          body: '',
                        })
                        return result.evictedBlocked ? current : result.next
                      })
                    }}
                  >
                    Discard & replace
                  </button>
                </div>
              </div>
            ) : null}
            <p
              className="line-clamp-2 text-caption text-secondary"
              title={displayedCommentDraft.quote}
            >
              {displayedCommentDraft.path !== normalizedEffectivePath
                ? `${displayedCommentDraft.path} · `
                : ''}
              Comment on “{displayedCommentDraft.quote}”
            </p>
            <textarea
              className="mt-2 min-h-16 w-full resize-y rounded-control bg-surface-muted p-2 text-caption text-primary outline-none focus:outline-2 focus:outline-focus"
              value={displayedCommentDraft.body}
              disabled={commentingDisabled}
              placeholder="What should the Agent notice?"
              onChange={(event) => {
                const body = event.target.value
                const key = displayedCommentDraft.draftKey
                commitCommentDrafts((current) => {
                  const live = current.get(key)
                  if (!live) return current
                  const nextPendingSubmit =
                    live.pendingSubmit && live.pendingSubmit.body === body
                      ? live.pendingSubmit
                      : undefined
                  const result = putBoundedCommentDraft(current, key, {
                    ...live,
                    body,
                    pendingSubmit: nextPendingSubmit,
                  })
                  return result.evictedBlocked ? current : result.next
                })
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !savingCurrentComment) {
                  clearDraftByKey(displayedCommentDraft.draftKey)
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void saveCommentDraft(displayedCommentDraft)
                }
              }}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-caption text-tertiary">
                Enter to save · Shift+Enter for a new line
              </p>
              <div className="flex gap-2">
                <button
                  className="pact-pressable h-8 cursor-pointer rounded-control px-3 text-caption text-secondary hover:bg-surface-muted"
                  type="button"
                  disabled={commentingDisabled || savingCurrentComment}
                  onClick={() => clearDraftByKey(displayedCommentDraft.draftKey)}
                >
                  Cancel
                </button>
                <button
                  className="pact-pressable h-8 cursor-pointer rounded-control bg-surface-inverse px-3 text-caption font-medium text-inverse disabled:opacity-40"
                  type="button"
                  disabled={
                    !displayedCommentDraft.body.trim() || commentingDisabled || savingCurrentComment
                  }
                  onClick={() => void saveCommentDraft(displayedCommentDraft)}
                >
                  {savingCurrentComment ? 'Saving…' : 'Save comment'}
                </button>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </section>
  )
}
