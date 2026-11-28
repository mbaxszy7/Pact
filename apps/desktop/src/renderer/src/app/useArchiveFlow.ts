import { useRef, useState } from 'react'

import type {
  WorkspaceArchivePreview,
  WorkspaceArchiveReceipt,
  WorkspaceArchiveScope,
} from '@pact/contracts'

import type { useProjectCatalog } from '../components/workspace/useProjectCatalog'
import type { SessionWorkspaceFlow } from '../components/workspace/useSessionWorkspace'

import {
  ARCHIVE_RESULT_LIMIT,
  type ArchiveAction,
  type ArchivedItem,
  type ArchiveResult,
} from '../components/workspace/ArchiveNotice'
import { unwrapRpcResult } from '../query-client'

function archiveItem(item: WorkspaceArchivePreview): ArchivedItem {
  return item.scope.kind === 'session'
    ? { kind: 'session', id: item.scope.sessionId, title: item.title, projectId: item.projectId }
    : { kind: 'project', id: item.scope.projectId, title: item.title }
}

export interface ArchiveFlow {
  archiveResults: ArchiveResult[]
  archiveAction: ArchiveAction | undefined
  archiveResultId: string | undefined
  archivePreview: WorkspaceArchivePreview | undefined
  archiveReceipt: WorkspaceArchiveReceipt | undefined
  archiveError: string | undefined
  archiveStopping: boolean
  requestArchive: (scope: WorkspaceArchiveScope, resultId?: string) => Promise<void>
  confirmArchive: () => Promise<void>
  closeArchive: () => void
  checkArchive: () => Promise<void>
  checkArchiveResult: (result: ArchiveResult, inDialog?: boolean) => Promise<void>
  reviewArchive: () => void
  removeFromSidebar: () => Promise<void>
  dismissArchiveResults: (id?: string) => void
  restoreArchived: (result: ArchiveResult) => Promise<void>
}

export function useArchiveFlow({
  projectCatalog,
  sessionWorkspace,
  userSelectionEpochRef,
  beginUserSelection,
  requestSessionLocation,
  settingsButtonRef,
  showWarning,
  showError,
  purgeSideChatCaches,
  onSessionArchived,
  onProjectArchived,
  onProjectRestored,
}: {
  projectCatalog: ReturnType<typeof useProjectCatalog>
  sessionWorkspace: SessionWorkspaceFlow
  userSelectionEpochRef: React.RefObject<number>
  beginUserSelection: () => number
  requestSessionLocation: (projectId: string, sessionId: string) => void
  settingsButtonRef: React.RefObject<HTMLButtonElement | null>
  showWarning: (message: string) => void
  showError: (message: string) => void
  purgeSideChatCaches: (scope: { sessionId?: string; projectId?: string }) => void
  onSessionArchived: (sessionId: string, projectId: string) => void
  onProjectArchived: (projectId: string) => void
  onProjectRestored: (projectId: string) => void
}): ArchiveFlow {
  const [archiveResults, setArchiveResults] = useState<ArchiveResult[]>([])
  const archiveResultsRef = useRef<ArchiveResult[]>([])
  const [archiveAction, setArchiveAction] = useState<ArchiveAction>()
  const [archiveResultId, setArchiveResultId] = useState<string>()
  const [archivePreview, setArchivePreview] = useState<WorkspaceArchivePreview>()
  const [archiveReceipt, setArchiveReceipt] = useState<WorkspaceArchiveReceipt>()
  const [archiveError, setArchiveError] = useState<string>()
  const [archiveStopping, setArchiveStopping] = useState(false)
  const archiveBusyRef = useRef(false)
  const archiveStoppingRef = useRef(false)

  const archiveSession = async (
    sessionId: string,
    operationId?: string,
    prepared?: WorkspaceArchivePreview,
    selectionEpoch = userSelectionEpochRef.current,
  ): Promise<boolean> => {
    const session =
      sessionWorkspace.catalog?.sessions.find((item) => item.id === sessionId) ??
      (prepared?.scope.kind === 'session' && prepared.scope.sessionId === sessionId
        ? { id: sessionId, title: prepared.title, projectId: prepared.projectId }
        : undefined)
    if (!session || !(await sessionWorkspace.archive(sessionId, operationId))) return false
    purgeSideChatCaches({ sessionId })
    if (selectionEpoch !== userSelectionEpochRef.current) return true
    onSessionArchived(sessionId, session.projectId)
    return true
  }

  const archiveProject = async (
    projectId: string,
    operationId?: string,
    prepared?: WorkspaceArchivePreview,
    selectionEpoch = userSelectionEpochRef.current,
  ): Promise<boolean> => {
    const project =
      projectCatalog.catalog?.projects.find((item) => item.id === projectId) ??
      (prepared?.scope.kind === 'project' && prepared.scope.projectId === projectId
        ? { id: projectId, name: prepared.title }
        : undefined)
    if (!project || !(await projectCatalog.archive(projectId, operationId))) return false
    purgeSideChatCaches({ projectId })
    if (selectionEpoch !== userSelectionEpochRef.current) return true
    onProjectArchived(projectId)
    return true
  }

  const completeArchive = (
    item: WorkspaceArchivePreview,
    selectionEpoch = userSelectionEpochRef.current,
  ): Promise<boolean> =>
    item.scope.kind === 'session'
      ? archiveSession(item.scope.sessionId, item.operationId, item, selectionEpoch)
      : archiveProject(item.scope.projectId, item.operationId, item, selectionEpoch)

  // This ref is the synchronous admission view of the same App-owned result projection.
  const updateArchiveResults = (update: (current: ArchiveResult[]) => ArchiveResult[]): void => {
    const next = update(archiveResultsRef.current)
    archiveResultsRef.current = next
    setArchiveResults(next)
  }

  const recordArchiveResult = (result: ArchiveResult): void => {
    updateArchiveResults((current) => {
      const previous = current.find((item) => item.id === result.id)
      return previous
        ? current.map((item) => (item.id === result.id ? result : item))
        : [result, ...current]
    })
  }

  const setArchiveActionError = (id: string, message?: string): void => {
    updateArchiveResults((current) =>
      current.map((result) => {
        if (result.id !== id) return result
        const { actionError: _previous, ...rest } = result
        return message ? { ...rest, actionError: message } : rest
      }),
    )
  }

  const acceptArchiveReceipt = async (
    id: string,
    item: WorkspaceArchivePreview,
    receipt: WorkspaceArchiveReceipt,
    inDialog: boolean,
    selectionEpoch: number,
  ): Promise<void> => {
    const receiptTarget =
      receipt.preview.scope.kind === 'session'
        ? receipt.preview.scope.sessionId
        : receipt.preview.scope.projectId
    const target = item.scope.kind === 'session' ? item.scope.sessionId : item.scope.projectId
    if (
      receipt.preview.operationId !== item.operationId ||
      receipt.preview.scope.kind !== item.scope.kind ||
      receiptTarget !== target
    )
      throw new Error('The archive receipt did not match this operation.')
    const state =
      receipt.state === 'archived'
        ? 'archived'
        : receipt.state === 'unresolved' || receipt.state === 'stopping'
          ? 'unresolved'
          : 'failed'
    const message =
      receipt.message ??
      (state === 'unresolved'
        ? 'Couldn’t confirm whether archiving finished. Check its status before trying again.'
        : state === 'failed'
          ? 'Not archived. Tasks changed or this confirmation expired—review again.'
          : undefined)
    const sidebarRemoved = archiveResultsRef.current.find(
      (entry) => entry.id === id,
    )?.sidebarRemoved
    recordArchiveResult({
      id,
      item: archiveItem(item),
      state,
      preview: item,
      receipt,
      ...(state !== 'archived' && sidebarRemoved ? { sidebarRemoved } : {}),
      ...(message ? { message } : {}),
    })
    if (state === 'archived') {
      // Only durable success permits this idempotent catalog read; it never repeats Stop.
      if (!(await completeArchive(item, selectionEpoch))) {
        setArchiveActionError(id, 'Archived, but the sidebar couldn’t refresh. Reload to update.')
        sessionWorkspace.retry()
        projectCatalog.retry()
      }
      if (inDialog) {
        setArchivePreview(undefined)
        archiveBusyRef.current = false
      }
    } else if (inDialog) {
      setArchiveReceipt(receipt)
      setArchiveError(message)
    }
  }

  const runArchive = async (
    id: string,
    item: WorkspaceArchivePreview,
    selectionEpoch = userSelectionEpochRef.current,
  ): Promise<void> => {
    if (archiveStoppingRef.current) return
    archiveStoppingRef.current = true
    setArchiveStopping(true)
    setArchiveAction({ id, kind: 'archiving' })
    setArchiveError(undefined)
    try {
      if (await completeArchive(item, selectionEpoch)) {
        recordArchiveResult({ id, item: archiveItem(item), state: 'archived', preview: item })
        setArchivePreview(undefined)
        archiveBusyRef.current = false
      } else {
        const receipt = unwrapRpcResult(
          await window.pact.readWorkspaceArchive({ operationId: item.operationId }),
        )
        await acceptArchiveReceipt(id, item, receipt, true, selectionEpoch)
      }
    } catch {
      const message =
        'Couldn’t confirm whether archiving finished. Check its status before trying again.'
      recordArchiveResult({
        id,
        item: archiveItem(item),
        state: 'unresolved',
        preview: item,
        message,
      })
      setArchiveError(message)
      // An unknown outcome stays read-only even when no durable receipt was returned.
      setArchiveReceipt(undefined)
    } finally {
      archiveStoppingRef.current = false
      setArchiveStopping(false)
      setArchiveAction(undefined)
    }
  }

  const closeArchive = (): void => {
    if (archiveStoppingRef.current) return
    const result = archiveResultsRef.current.find((item) => item.id === archiveResultId)
    if (
      archivePreview &&
      result?.state !== 'unresolved' &&
      (!archiveReceipt || archiveReceipt.state === 'prepared')
    )
      void window.pact
        .cancelWorkspaceArchive({ operationId: archivePreview.operationId })
        .catch(() => undefined)
    setArchivePreview(undefined)
    setArchiveReceipt(undefined)
    setArchiveError(undefined)
    setArchiveResultId(undefined)
    archiveBusyRef.current = false
  }

  const checkArchiveResult = async (result: ArchiveResult, inDialog = false): Promise<void> => {
    if ((!inDialog && archiveBusyRef.current) || archiveStoppingRef.current || !result.preview)
      return
    const selectionEpoch = userSelectionEpochRef.current
    archiveStoppingRef.current = true
    archiveBusyRef.current = true
    setArchiveAction({ id: result.id, kind: 'checking' })
    setArchiveActionError(result.id)
    if (inDialog) setArchiveStopping(true)
    try {
      const receipt = unwrapRpcResult(
        await window.pact.readWorkspaceArchive({ operationId: result.preview.operationId }),
      )
      await acceptArchiveReceipt(result.id, result.preview, receipt, inDialog, selectionEpoch)
    } catch {
      const message = 'Couldn’t check status. Try Check status again.'
      setArchiveActionError(result.id, message)
      if (inDialog) setArchiveError(message)
    } finally {
      archiveStoppingRef.current = false
      setArchiveAction(undefined)
      if (inDialog) setArchiveStopping(false)
      else archiveBusyRef.current = false
    }
  }

  const requestArchive = async (scope: WorkspaceArchiveScope, resultId?: string): Promise<void> => {
    if (archiveBusyRef.current) return
    const targetId = scope.kind === 'session' ? scope.sessionId : scope.projectId
    const existing = archiveResultsRef.current.find(
      (result) => result.item.kind === scope.kind && result.item.id === targetId,
    )
    if (existing?.state === 'unresolved') {
      await checkArchiveResult(existing)
      return
    }
    if (existing?.state === 'archived') {
      showWarning('Already archived. Click Undo to restore it first.')
      return
    }
    if (existing?.sidebarRemoved) {
      showWarning('Already removed from the sidebar. Click Undo to bring it back.')
      return
    }
    if (!existing && archiveResultsRef.current.length >= ARCHIVE_RESULT_LIMIT) {
      showWarning('Dismiss or review older archive results before archiving more items.')
      return
    }
    const id = existing?.id ?? resultId ?? crypto.randomUUID()
    const fallback: ArchivedItem | undefined =
      scope.kind === 'session'
        ? (() => {
            const session = sessionWorkspace.catalog?.sessions.find(
              (item) => item.id === scope.sessionId,
            )
            return session
              ? {
                  kind: 'session' as const,
                  id: session.id,
                  title: session.title,
                  projectId: session.projectId,
                }
              : undefined
          })()
        : (() => {
            const project = projectCatalog.catalog?.projects.find(
              (item) => item.id === scope.projectId,
            )
            return project
              ? { kind: 'project' as const, id: project.id, title: project.name }
              : undefined
          })()
    if (fallback && fallback.title.length > 4096) {
      showError('This name is too long to archive. Rename it first.')
      return
    }
    const selectionEpoch = userSelectionEpochRef.current
    archiveBusyRef.current = true
    setArchiveResultId(id)
    setArchiveAction({ id, kind: 'preparing' })
    setArchiveReceipt(undefined)
    setArchiveError(undefined)
    try {
      const prepared = unwrapRpcResult(
        await window.pact.prepareWorkspaceArchive({ operationId: crypto.randomUUID(), scope }),
      )
      setArchivePreview(prepared)
      if (prepared.blockedReason)
        recordArchiveResult({
          id,
          item: archiveItem(prepared),
          state: 'failed',
          preview: prepared,
          message: prepared.blockedReason,
        })
      else if (!prepared.tasks.length) await runArchive(id, prepared, selectionEpoch)
    } catch (error) {
      const message =
        error instanceof Error && error.message.length <= 2048
          ? error.message
          : 'Couldn’t prepare archive. Review the item and try again.'
      if (fallback || existing)
        recordArchiveResult({ id, item: fallback ?? existing!.item, state: 'failed', message })
      else showError(message)
      setArchivePreview(undefined)
      archiveBusyRef.current = false
    } finally {
      setArchiveAction(undefined)
    }
  }

  const confirmArchive = async (): Promise<void> => {
    if (!archivePreview || archiveStoppingRef.current || !archiveResultId) return
    await runArchive(archiveResultId, archivePreview)
  }

  const checkArchive = async (): Promise<void> => {
    const result = archiveResultsRef.current.find((item) => item.id === archiveResultId)
    if (result) await checkArchiveResult(result, true)
  }

  const reviewArchive = (): void => {
    if (!archivePreview || archiveStoppingRef.current) return
    const scope = archivePreview.scope
    const id = archiveResultId
    closeArchive()
    void requestArchive(scope, id)
  }

  const removeFromSidebar = async (): Promise<void> => {
    const scope = archivePreview?.scope
    const result = archiveResultsRef.current.find((item) => item.id === archiveResultId)
    if (
      scope?.kind !== 'session' ||
      !result ||
      result.state === 'archived' ||
      result.sidebarRemoved ||
      archiveStoppingRef.current
    )
      return
    archiveStoppingRef.current = true
    setArchiveStopping(true)
    setArchiveAction({ id: result.id, kind: 'removing' })
    let removed = false
    try {
      await sessionWorkspace.setSidebarHidden(scope.sessionId, true)
      updateArchiveResults((current) => [
        { ...result, sidebarRemoved: true },
        ...current.filter((entry) => entry.id !== result.id),
      ])
      removed = true
    } catch {
      setArchiveError(
        'Could not confirm removal from the sidebar. Try again to check the saved state.',
      )
    } finally {
      archiveStoppingRef.current = false
      setArchiveStopping(false)
      setArchiveAction(undefined)
    }
    if (removed) closeArchive()
  }

  const dismissArchiveResults = (id?: string): void => {
    if (archiveBusyRef.current) return
    updateArchiveResults((current) =>
      current.filter(
        (result) => result.state === 'unresolved' || (id !== undefined && result.id !== id),
      ),
    )
    if (!archiveResultsRef.current.length) settingsButtonRef.current?.focus()
  }

  const restoreArchived = async (result: ArchiveResult): Promise<void> => {
    if (
      archiveBusyRef.current ||
      (result.state !== 'archived' && !result.sidebarRemoved) ||
      !archiveResultsRef.current.some((item) => item.id === result.id)
    )
      return
    const item = result.item
    const restoreError = result.sidebarRemoved
      ? 'Could not confirm that the Session is back in the sidebar. Try Undo again.'
      : 'Could not confirm the restore. Try Undo again to check its saved state.'
    if (
      item.kind === 'session' &&
      !projectCatalog.catalog?.projects.some((project) => project.id === item.projectId)
    ) {
      setArchiveActionError(result.id, 'Restore or re-add its Project first, then try Undo again.')
      return
    }
    const selectionEpoch =
      item.kind === 'project' ? beginUserSelection() : userSelectionEpochRef.current
    archiveBusyRef.current = true
    setArchiveAction({ id: result.id, kind: 'restoring' })
    setArchiveActionError(result.id)
    try {
      const restored =
        item.kind === 'session'
          ? result.sidebarRemoved
            ? await sessionWorkspace.setSidebarHidden(item.id, false)
            : await sessionWorkspace.restore(item.id)
          : await projectCatalog.restore(item.id)
      if (!restored) {
        setArchiveActionError(result.id, restoreError)
        return
      }
      updateArchiveResults((current) =>
        current.flatMap((entry) => {
          if (entry.id !== result.id) return [entry]
          if (entry.state !== 'unresolved') return []
          const { sidebarRemoved: _removed, ...archive } = entry
          return [archive]
        }),
      )
      if (selectionEpoch !== userSelectionEpochRef.current) return
      if (item.kind === 'session') {
        requestSessionLocation(item.projectId, item.id)
      } else {
        onProjectRestored(item.id)
      }
      if (!archiveResultsRef.current.length) settingsButtonRef.current?.focus()
    } catch {
      setArchiveActionError(result.id, restoreError)
    } finally {
      archiveBusyRef.current = false
      setArchiveAction(undefined)
    }
  }

  return {
    archiveResults,
    archiveAction,
    archiveResultId,
    archivePreview,
    archiveReceipt,
    archiveError,
    archiveStopping,
    requestArchive,
    confirmArchive,
    closeArchive,
    checkArchive,
    checkArchiveResult,
    reviewArchive,
    removeFromSidebar,
    dismissArchiveResults,
    restoreArchived,
  }
}
