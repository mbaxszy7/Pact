import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { AgentRun, WorkspaceChangeSet } from '@pact/contracts'

import { WORKSPACE_CHANGE_FILES, WORKSPACE_OPERATION_TIMEOUT_MS } from '@pact/contracts'

import type { ConversationViewProjection } from './conversation-window'

import {
  cancelWorkspaceFileLoadWaiters,
  coalesceWorkspaceLoadIntent,
  enqueueWorkspaceFileLoadWaiter,
  hasVisibleChanges,
  promoteWorkspaceFileLoadWaiter,
  tryAcquireWorkspaceFileLoadSlot,
  upsertWorkspaceFilesLru,
  type WorkspaceFileLoadIntent,
} from './conversation-view-helpers'
import { WorkspaceChangesCard, type WorkspaceChangesList } from './WorkspaceChangesCard'

interface WorkspaceFileLoadSlot {
  changeSetId: string
  generation: number
  inFlight: boolean
  inFlightRevision: number
  inFlightExpand: boolean
  inFlightOpen: boolean
  inFlightContextGeneration?: number | undefined
  timedOut: boolean
  timeout?: number | undefined
  waitingForConcurrency: boolean
  queued?: WorkspaceFileLoadIntent | undefined
}

export interface UseConversationWorkspaceChangesOptions {
  readonly sessionId: string
  readonly visible: boolean
  readonly snapshot: ConversationViewProjection | undefined
  readonly latestChangesRun: AgentRun | undefined
  readonly activeRun: AgentRun | undefined
  readonly activeWorkspaceDiff: { sessionId: string; changeSetId: string; path: string } | undefined
  readonly activeWorkspaceFilePath: string | undefined
  readonly onUndoWorkspaceChanges: (changeSetId: string) => Promise<boolean>
  readonly onUndoWorkspaceFile:
    | ((changeSetId: string, path: string) => Promise<boolean>)
    | undefined
  readonly onPrepareWorkspaceChanges: () => number
  readonly onOpenWorkspaceChanges: (
    changeSetId: string,
    path: string,
    expectedGeneration?: number,
    revision?: number,
  ) => void
  readonly onNotice: (message: string) => void
}

/**
 * Cohesive hook owning bounded LRU workspace-file listings, physical concurrency slots,
 * revision-driven auto-refresh, and single-flight undo actions for WorkspaceChangesCard rows.
 */
export function useConversationWorkspaceChanges(options: UseConversationWorkspaceChangesOptions): {
  renderWorkspaceChanges: (changeSet: WorkspaceChangeSet) => React.JSX.Element
} {
  const {
    sessionId,
    visible,
    snapshot,
    latestChangesRun,
    activeRun,
    activeWorkspaceDiff,
    activeWorkspaceFilePath,
    onUndoWorkspaceChanges,
    onUndoWorkspaceFile,
    onPrepareWorkspaceChanges,
    onOpenWorkspaceChanges,
    onNotice,
  } = options

  const snapshotRef = useRef(snapshot)
  useLayoutEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  // Bounded LRU map (max 8 entries) keyed by changeSetId prevents expanding Card B from wiping Card A.
  const [workspaceFilesState, setWorkspaceFilesState] = useState<{
    sessionId: string
    files: Map<string, WorkspaceChangesList>
  }>(() => ({ sessionId, files: new Map() }))
  const workspaceFilesById = useMemo(
    () =>
      workspaceFilesState.sessionId === sessionId
        ? workspaceFilesState.files
        : new Map<string, WorkspaceChangesList>(),
    [workspaceFilesState, sessionId],
  )
  const workspaceFilesMapRef = useRef<Map<string, WorkspaceChangesList>>(new Map())
  const lastSessionIdRef = useRef(sessionId)
  const workspaceFileLoadsRef = useRef<Map<string, WorkspaceFileLoadSlot>>(new Map())
  const workspaceLoadOwnerIdRef = useRef<symbol>(Symbol('workspace-file-loads'))
  const loadWorkspaceFilesRef = useRef<
    | ((
        changeSetId: string,
        expand?: boolean,
        open?: boolean,
        contextGeneration?: number,
        targetRevision?: number,
      ) => Promise<void>)
    | undefined
  >(undefined)
  const [undoingChangeSetId, setUndoingChangeSetId] = useState<string>()
  const undoingChangeSetRef = useRef<string | undefined>(undefined)
  const [undoingFile, setUndoingFile] = useState<{ changeSetId: string; path: string }>()
  const undoingFileRef = useRef<{ changeSetId: string; path: string } | undefined>(undefined)
  const workspaceOwnerActiveRef = useRef(true)
  const defaultWorkspaceChangesIdRef = useRef<string | undefined>(undefined)

  const upsertWorkspaceFiles = useCallback(
    (changeSetId: string, entry: WorkspaceChangesList): void => {
      const next = upsertWorkspaceFilesLru(workspaceFilesMapRef.current, changeSetId, entry)
      workspaceFilesMapRef.current = next
      setWorkspaceFilesState({ sessionId, files: next })
    },
    [sessionId],
  )

  const currentWorkspaceChangeSetRevision = useCallback(
    (changeSetId: string): number | undefined => {
      const summary = snapshotRef.current?.runs.find(
        (run) => run.workspaceChanges?.id === changeSetId,
      )?.workspaceChanges
      return summary ? (summary.revision ?? 0) : undefined
    },
    [],
  )

  const clearAllWorkspaceLoads = useCallback((): void => {
    cancelWorkspaceFileLoadWaiters(workspaceLoadOwnerIdRef.current)
    workspaceLoadOwnerIdRef.current = Symbol('workspace-file-loads')
    for (const slot of workspaceFileLoadsRef.current.values()) {
      slot.generation += 1
      slot.queued = undefined
      slot.waitingForConcurrency = false
      if (slot.timeout !== undefined) {
        window.clearTimeout(slot.timeout)
        slot.timeout = undefined
      }
    }
    workspaceFileLoadsRef.current.clear()
  }, [])

  useEffect(() => {
    workspaceOwnerActiveRef.current = true
    return () => {
      workspaceOwnerActiveRef.current = false
      clearAllWorkspaceLoads()
    }
  }, [clearAllWorkspaceLoads])

  useEffect(() => {
    if (lastSessionIdRef.current === sessionId) return
    lastSessionIdRef.current = sessionId
    clearAllWorkspaceLoads()
    workspaceFilesMapRef.current = new Map()
    defaultWorkspaceChangesIdRef.current = undefined
  }, [sessionId, clearAllWorkspaceLoads])

  const loadWorkspaceFiles = useCallback(
    async (
      changeSetId: string,
      expand = false,
      open = false,
      contextGeneration?: number,
      targetRevision?: number,
    ): Promise<void> => {
      const existing = workspaceFilesMapRef.current.get(changeSetId)
      const revision = currentWorkspaceChangeSetRevision(changeSetId) ?? targetRevision ?? 0
      const current = (existing?.revision ?? 0) === revision ? existing : undefined
      let slot = workspaceFileLoadsRef.current.get(changeSetId)

      // Cache hits never allocate a tracking slot.
      if (!slot) {
        if (
          current &&
          !current.loading &&
          !current.error &&
          ((!expand && current.files.length) || (expand && !current.expanded))
        ) {
          upsertWorkspaceFiles(changeSetId, { ...current, expanded: expand || current.expanded })
          if (open && current.files[0])
            onOpenWorkspaceChanges(
              changeSetId,
              current.files[0].path,
              contextGeneration,
              current.revision,
            )
          return
        }
        if (current && !current.loading && expand && !current.nextPath && !current.error) return
      }

      if (slot && (slot.inFlight || slot.waitingForConcurrency)) {
        slot.queued = coalesceWorkspaceLoadIntent(slot.queued, {
          expand,
          open,
          contextGeneration,
          targetRevision: revision,
        })
        if (slot.waitingForConcurrency && slot.queued.open) {
          promoteWorkspaceFileLoadWaiter(workspaceLoadOwnerIdRef.current, changeSetId)
        }
        return
      }

      if (!slot) {
        slot = {
          changeSetId,
          generation: 0,
          inFlight: false,
          inFlightRevision: revision,
          inFlightExpand: expand,
          inFlightOpen: open,
          inFlightContextGeneration: contextGeneration,
          timedOut: false,
          waitingForConcurrency: false,
        }
        workspaceFileLoadsRef.current.set(changeSetId, slot)
      }

      const releasePhysicalSlot = tryAcquireWorkspaceFileLoadSlot()
      if (!releasePhysicalSlot) {
        const waitingSlot = slot
        waitingSlot.waitingForConcurrency = true
        waitingSlot.queued = coalesceWorkspaceLoadIntent(waitingSlot.queued, {
          expand,
          open,
          contextGeneration,
          targetRevision: revision,
        })
        enqueueWorkspaceFileLoadWaiter({
          ownerId: workspaceLoadOwnerIdRef.current,
          changeSetId,
          priority: waitingSlot.queued.open,
          timeoutMs: WORKSPACE_OPERATION_TIMEOUT_MS,
          shouldDispatch: () => {
            if (!workspaceOwnerActiveRef.current) return false
            const currentSlot = workspaceFileLoadsRef.current.get(changeSetId)
            if (
              currentSlot !== waitingSlot ||
              currentSlot.inFlight ||
              !currentSlot.waitingForConcurrency
            ) {
              return false
            }
            const intent = currentSlot.queued
            if (!intent) return false
            if (!intent.open && currentWorkspaceChangeSetRevision(changeSetId) === undefined) {
              currentSlot.waitingForConcurrency = false
              currentSlot.queued = undefined
              workspaceFileLoadsRef.current.delete(changeSetId)
              return false
            }
            return true
          },
          onGrant: () => {
            const currentSlot = workspaceFileLoadsRef.current.get(changeSetId)
            if (
              currentSlot !== waitingSlot ||
              currentSlot.inFlight ||
              !currentSlot.waitingForConcurrency
            ) {
              return
            }
            const intent = currentSlot.queued
            currentSlot.waitingForConcurrency = false
            currentSlot.queued = undefined
            workspaceFileLoadsRef.current.delete(changeSetId)
            if (intent) {
              void loadWorkspaceFilesRef.current?.(
                changeSetId,
                intent.expand,
                intent.open,
                intent.contextGeneration,
                intent.targetRevision,
              )
            }
          },
          onReject: (reason) => {
            const currentSlot = workspaceFileLoadsRef.current.get(changeSetId)
            if (
              currentSlot !== waitingSlot ||
              currentSlot.inFlight ||
              !currentSlot.waitingForConcurrency
            ) {
              return
            }
            const intent = currentSlot.queued
            currentSlot.waitingForConcurrency = false
            currentSlot.queued = undefined
            workspaceFileLoadsRef.current.delete(changeSetId)
            if (!workspaceOwnerActiveRef.current || !intent) return
            const message =
              reason === 'queue_full'
                ? 'Too many changed file lists are loading right now. Try again.'
                : 'Loading changed files took too long. Try again.'
            const existingEntry = workspaceFilesMapRef.current.get(changeSetId)
            const latestRev =
              currentWorkspaceChangeSetRevision(changeSetId) ?? intent.targetRevision
            const currentEntry =
              (existingEntry?.revision ?? 0) === latestRev ? existingEntry : undefined
            upsertWorkspaceFiles(changeSetId, {
              changeSetId,
              revision: latestRev,
              files: currentEntry?.files ?? [],
              nextPath: currentEntry?.nextPath ?? null,
              loading: false,
              expanded: intent.expand || existingEntry?.expanded || false,
              error: message,
            })
            if (intent.open) onNotice(message)
          },
        })
        return
      }

      const activeSlot = slot
      const generation = ++activeSlot.generation
      activeSlot.waitingForConcurrency = false
      activeSlot.inFlight = true
      activeSlot.inFlightRevision = revision
      activeSlot.inFlightExpand = expand || existing?.expanded || false
      activeSlot.inFlightOpen = open
      activeSlot.inFlightContextGeneration = contextGeneration
      activeSlot.timedOut = false
      if (activeSlot.timeout !== undefined) window.clearTimeout(activeSlot.timeout)
      const initial: WorkspaceChangesList = {
        changeSetId,
        revision,
        files: current?.files ?? [],
        nextPath: current?.nextPath ?? null,
        loading: true,
        expanded: expand || existing?.expanded || false,
      }
      upsertWorkspaceFiles(changeSetId, initial)
      const localTimeout = window.setTimeout(() => {
        if (
          !workspaceOwnerActiveRef.current ||
          workspaceFileLoadsRef.current.get(changeSetId) !== activeSlot ||
          generation !== activeSlot.generation
        )
          return
        activeSlot.generation += 1
        activeSlot.timedOut = true
        activeSlot.timeout = undefined
        upsertWorkspaceFiles(changeSetId, {
          ...initial,
          loading: false,
          error: 'Loading changed files took too long. Try again.',
        })
        if (open) onNotice('Loading changed files took too long. Try again.')
      }, WORKSPACE_OPERATION_TIMEOUT_MS)
      activeSlot.timeout = localTimeout
      try {
        const result = await window.pact.readWorkspaceChanges({
          changeSetId,
          ...(current?.nextPath ? { afterPath: current.nextPath } : {}),
        })
        if (
          !workspaceOwnerActiveRef.current ||
          workspaceFileLoadsRef.current.get(changeSetId) !== activeSlot ||
          generation !== activeSlot.generation ||
          activeSlot.timedOut
        )
          return
        const latestRevision = currentWorkspaceChangeSetRevision(changeSetId)
        if (latestRevision !== undefined && latestRevision !== revision) {
          activeSlot.queued = coalesceWorkspaceLoadIntent(
            activeSlot.queued,
            {
              expand: initial.expanded,
              open,
              contextGeneration,
              targetRevision: latestRevision,
            },
            { autoRefresh: true },
          )
          return
        }
        if (!result.ok) {
          upsertWorkspaceFiles(changeSetId, {
            ...initial,
            loading: false,
            error: result.error.message,
          })
          if (open) onNotice(result.error.message)
          return
        }
        if (
          result.value.changeSet.id !== changeSetId ||
          result.value.changeSet.sessionId !== sessionId
        )
          throw new Error('These file changes do not belong to this session.')
        if ((result.value.changeSet.revision ?? 0) !== revision)
          throw new Error('Changed files were updated while loading. Try again.')
        const files = [...initial.files, ...result.value.files]
        if (files.length > WORKSPACE_CHANGE_FILES)
          throw new Error('Too many changed files to display at once.')
        if (new Set(files.map((file) => file.path)).size !== files.length)
          throw new Error('Changed file list contained duplicate paths.')
        if (!result.value.nextPath && files.length !== result.value.changeSet.fileCount)
          throw new Error('Changed file list is incomplete. Try again.')
        if (result.value.nextPath && result.value.nextPath === current?.nextPath)
          throw new Error('Couldn’t load the next page of changed files.')
        upsertWorkspaceFiles(changeSetId, {
          ...initial,
          revision: result.value.changeSet.revision ?? 0,
          files,
          nextPath: result.value.nextPath,
          loading: false,
        })
        if (open) {
          const first = files[0]
          if (first)
            onOpenWorkspaceChanges(
              changeSetId,
              first.path,
              contextGeneration,
              result.value.changeSet.revision,
            )
          else onNotice('No changed files were recorded for this turn.')
        }
      } catch (failure) {
        if (
          !workspaceOwnerActiveRef.current ||
          workspaceFileLoadsRef.current.get(changeSetId) !== activeSlot ||
          generation !== activeSlot.generation ||
          activeSlot.timedOut
        )
          return
        const latestRevision = currentWorkspaceChangeSetRevision(changeSetId)
        if (latestRevision !== undefined && latestRevision !== revision) {
          activeSlot.queued = coalesceWorkspaceLoadIntent(
            activeSlot.queued,
            {
              expand: initial.expanded,
              open,
              contextGeneration,
              targetRevision: latestRevision,
            },
            { autoRefresh: true },
          )
          return
        }
        const message = failure instanceof Error ? failure.message : 'Couldn’t load changed files.'
        upsertWorkspaceFiles(changeSetId, { ...initial, loading: false, error: message })
        if (open) onNotice(message)
      } finally {
        window.clearTimeout(localTimeout)
        let replayIntent: WorkspaceFileLoadIntent | undefined
        if (workspaceFileLoadsRef.current.get(changeSetId) === activeSlot) {
          if (activeSlot.timeout === localTimeout) activeSlot.timeout = undefined
          activeSlot.inFlight = false
          activeSlot.timedOut = false
          replayIntent = activeSlot.queued
          activeSlot.queued = undefined
          if (!activeSlot.waitingForConcurrency) {
            workspaceFileLoadsRef.current.delete(changeSetId)
          }
        }
        releasePhysicalSlot()
        if (workspaceOwnerActiveRef.current && replayIntent) {
          void loadWorkspaceFilesRef.current?.(
            changeSetId,
            replayIntent.expand,
            replayIntent.open,
            replayIntent.contextGeneration,
            replayIntent.targetRevision,
          )
        }
      }
    },
    [
      currentWorkspaceChangeSetRevision,
      onNotice,
      onOpenWorkspaceChanges,
      sessionId,
      upsertWorkspaceFiles,
    ],
  )

  useLayoutEffect(() => {
    loadWorkspaceFilesRef.current = loadWorkspaceFiles
  }, [loadWorkspaceFiles])

  const newestChangesId = hasVisibleChanges(latestChangesRun)
    ? latestChangesRun?.workspaceChanges?.id
    : undefined
  useEffect(() => {
    if (visible && newestChangesId && defaultWorkspaceChangesIdRef.current !== newestChangesId) {
      defaultWorkspaceChangesIdRef.current = newestChangesId
      void loadWorkspaceFiles(newestChangesId)
    }
  }, [visible, newestChangesId, loadWorkspaceFiles])

  // Refresh any cached workspace file lists whose changeSet revision advanced (e.g. recording -> settled).
  const workspaceChangesRevisionKey = useMemo(
    () =>
      (snapshot?.runs ?? [])
        .filter((run) => Boolean(run.workspaceChanges))
        .map((run) => `${run.workspaceChanges!.id}:${run.workspaceChanges!.revision ?? 0}`)
        .join('|'),
    [snapshot?.runs],
  )
  useEffect(() => {
    const runs = snapshotRef.current?.runs
    if (!workspaceChangesRevisionKey || !runs?.length) return
    const trackedIds = new Set<string>([
      ...workspaceFilesMapRef.current.keys(),
      ...workspaceFileLoadsRef.current.keys(),
    ])
    for (const changeSetId of trackedIds) {
      const summary = runs.find((run) => run.workspaceChanges?.id === changeSetId)?.workspaceChanges
      if (!summary) continue
      const nextRevision = summary.revision ?? 0
      const list = workspaceFilesMapRef.current.get(changeSetId)
      const slot = workspaceFileLoadsRef.current.get(changeSetId)
      if (slot?.inFlight) {
        if (slot.inFlightRevision === nextRevision) continue
        slot.generation += 1
        if (slot.timeout !== undefined) {
          window.clearTimeout(slot.timeout)
          slot.timeout = undefined
        }
        slot.queued = coalesceWorkspaceLoadIntent(
          slot.queued,
          {
            expand: slot.inFlightExpand || list?.expanded || false,
            open: slot.inFlightOpen,
            contextGeneration: slot.inFlightContextGeneration,
            targetRevision: nextRevision,
          },
          { autoRefresh: true },
        )
        continue
      }
      if (slot?.waitingForConcurrency && slot.queued) {
        if (slot.queued.targetRevision !== nextRevision) {
          slot.queued = { ...slot.queued, targetRevision: nextRevision }
        }
        continue
      }
      if (list && (list.revision ?? 0) !== nextRevision) {
        void loadWorkspaceFiles(changeSetId, list.expanded)
      }
    }
  }, [workspaceChangesRevisionKey, loadWorkspaceFiles])

  const undoWorkspaceChanges = useCallback(
    (changeSetId: string): void => {
      if (undoingChangeSetRef.current || undoingFileRef.current) return
      undoingChangeSetRef.current = changeSetId
      setUndoingChangeSetId(changeSetId)
      void onUndoWorkspaceChanges(changeSetId).finally(() => {
        undoingChangeSetRef.current = undefined
        if (workspaceOwnerActiveRef.current) setUndoingChangeSetId(undefined)
      })
    },
    [onUndoWorkspaceChanges],
  )

  const handleUndoWorkspaceFile = useCallback(
    async (changeSetId: string, path: string): Promise<boolean> => {
      if (!onUndoWorkspaceFile || undoingChangeSetRef.current || undoingFileRef.current) {
        return false
      }
      const target = { changeSetId, path }
      undoingFileRef.current = target
      setUndoingFile(target)
      try {
        return await onUndoWorkspaceFile(changeSetId, path)
      } finally {
        undoingFileRef.current = undefined
        if (workspaceOwnerActiveRef.current) setUndoingFile(undefined)
      }
    },
    [onUndoWorkspaceFile],
  )

  const renderWorkspaceChanges = useCallback(
    (changeSet: WorkspaceChangeSet): React.JSX.Element => {
      const cached = workspaceFilesById.get(changeSet.id)
      const list =
        cached && (cached.revision ?? 0) === (changeSet.revision ?? 0) ? cached : undefined
      const activeFilePathForCard = activeWorkspaceDiff
        ? activeWorkspaceDiff.sessionId === sessionId &&
          activeWorkspaceDiff.changeSetId === changeSet.id
          ? activeWorkspaceDiff.path
          : undefined
        : activeWorkspaceFilePath
      return (
        <WorkspaceChangesCard
          changeSet={changeSet}
          list={list}
          undoing={undoingChangeSetId === changeSet.id}
          disabled={Boolean(activeRun || undoingChangeSetId || undoingFile)}
          activeFilePath={activeFilePathForCard}
          undoingPath={undoingFile?.changeSetId === changeSet.id ? undoingFile.path : undefined}
          onUndo={undoWorkspaceChanges}
          onUndoFile={onUndoWorkspaceFile ? handleUndoWorkspaceFile : undefined}
          onView={(id) => void loadWorkspaceFiles(id, false, true, onPrepareWorkspaceChanges())}
          onShowFiles={(id) => void loadWorkspaceFiles(id, true)}
          onOpenFile={(id, path) => onOpenWorkspaceChanges(id, path, undefined, changeSet.revision)}
        />
      )
    },
    [
      workspaceFilesById,
      undoingChangeSetId,
      undoingFile,
      activeRun,
      activeWorkspaceDiff,
      activeWorkspaceFilePath,
      sessionId,
      undoWorkspaceChanges,
      onUndoWorkspaceFile,
      handleUndoWorkspaceFile,
      loadWorkspaceFiles,
      onPrepareWorkspaceChanges,
      onOpenWorkspaceChanges,
    ],
  )

  return { renderWorkspaceChanges }
}
