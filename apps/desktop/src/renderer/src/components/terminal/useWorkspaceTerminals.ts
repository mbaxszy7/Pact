import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { TerminalStateEvent, TerminalSummary } from '@pact/contracts'

import {
  disposeProjectTerminalViews,
  disposeTerminalView,
  updateCachedTerminalSummary,
} from './terminal-view-cache'

export const DEFAULT_TERMINAL_HEIGHT = 248
export const MIN_TERMINAL_HEIGHT = 140
export const TERMINAL_SEPARATOR_GAP = 8
const MIN_CHAT_WORKSPACE_HEIGHT = 180

export interface ProjectTerminalUiState {
  open: boolean
  maximized: boolean
  height: number
  activeTerminalId?: string | undefined
}

export interface PendingCloseConfirmation {
  terminalId: string
  title: string
  foregroundCommand?: string | null | undefined
}

export interface WorkspaceTerminalsState {
  terminalsByProject: Record<string, TerminalSummary[]>
  uiByProject: Record<string, ProjectTerminalUiState>
  busyByProject: Record<string, boolean>
  errorByProject: Record<string, string | undefined>
  inputErrorByTerminal: Record<string, string | undefined>
  pendingClose?: PendingCloseConfirmation | undefined
  openProjectTerminal(projectId: string): Promise<void>
  toggleProjectTerminal(projectId: string): Promise<void>
  collapseProjectTerminal(projectId: string): void
  setProjectMaximized(projectId: string, maximized: boolean): void
  setProjectHeight(projectId: string, height: number): void
  selectTerminalTab(projectId: string, terminalId: string): void
  createTab(projectId: string): Promise<void>
  requestCloseTab(projectId: string, terminalId: string): Promise<void>
  confirmPendingClose(): Promise<void>
  cancelPendingClose(): void
  setTerminalInputError(terminalId: string, message: string | undefined): void
  disposeProject(projectId: string): void
}

const DEFAULT_UI_STATE: ProjectTerminalUiState = {
  open: false,
  maximized: false,
  height: DEFAULT_TERMINAL_HEIGHT,
}

export function clampTerminalHeight(desired: number, containerHeight: number): number {
  const usableHeight = Math.max(MIN_TERMINAL_HEIGHT, containerHeight - TERMINAL_SEPARATOR_GAP)
  const maxAllowed =
    usableHeight > MIN_TERMINAL_HEIGHT + MIN_CHAT_WORKSPACE_HEIGHT
      ? usableHeight - MIN_CHAT_WORKSPACE_HEIGHT
      : Math.max(MIN_TERMINAL_HEIGHT, Math.floor(usableHeight * 0.55))
  return Math.max(MIN_TERMINAL_HEIGHT, Math.min(maxAllowed, Math.round(desired)))
}

export function useWorkspaceTerminals(
  activeProjectId: string | undefined,
  onRestoreFocusAfterClose?: (projectId: string) => void,
): WorkspaceTerminalsState {
  const [terminalsByProject, setTerminalsByProject] = useState<Record<string, TerminalSummary[]>>(
    {},
  )
  const [uiByProject, setUiByProject] = useState<Record<string, ProjectTerminalUiState>>({})
  const [busyByProject, setBusyByProject] = useState<Record<string, boolean>>({})
  const [errorByProject, setErrorByProject] = useState<Record<string, string | undefined>>({})
  const [inputErrorByTerminal, setInputErrorByTerminal] = useState<
    Record<string, string | undefined>
  >({})
  const [pendingClose, setPendingClose] = useState<PendingCloseConfirmation | undefined>()

  const terminalsRef = useRef(terminalsByProject)
  const uiRef = useRef(uiByProject)
  useLayoutEffect(() => {
    terminalsRef.current = terminalsByProject
    uiRef.current = uiByProject
  }, [terminalsByProject, uiByProject])
  const creatingProjectsRef = useRef(new Set<string>())
  const loadedProjectsRef = useRef(new Set<string>())
  const prevProjectIdRef = useRef<string | undefined>(undefined)

  const refreshProjectList = useCallback(async (projectId: string): Promise<TerminalSummary[]> => {
    if (typeof window.pact?.listTerminals !== 'function') {
      return terminalsRef.current[projectId] ?? []
    }
    const result = await window.pact.listTerminals({ projectId })
    if (!result.ok) return terminalsRef.current[projectId] ?? []
    loadedProjectsRef.current.add(projectId)
    const { terminals, activeTerminalId } = result.value
    for (const summary of terminals) {
      updateCachedTerminalSummary(summary)
    }
    setTerminalsByProject((prev) => ({ ...prev, [projectId]: terminals }))
    setUiByProject((prev) => {
      const current = prev[projectId] ?? DEFAULT_UI_STATE
      const nextActive =
        current.activeTerminalId && terminals.some((t) => t.id === current.activeTerminalId)
          ? current.activeTerminalId
          : (activeTerminalId ?? terminals[0]?.id)
      return {
        ...prev,
        [projectId]: { ...current, activeTerminalId: nextActive },
      }
    })
    return terminals
  }, [])

  // On Project switch, dispose ONLY Renderer terminal views of the previous Project while Utility keeps shells alive.
  useEffect(() => {
    const prevProjectId = prevProjectIdRef.current
    if (prevProjectId && prevProjectId !== activeProjectId) {
      disposeProjectTerminalViews(prevProjectId)
      if (typeof window.pact?.releaseProjectTerminalViews === 'function') {
        void window.pact
          .releaseProjectTerminalViews({ projectId: prevProjectId })
          .catch(() => undefined)
      }
    }
    prevProjectIdRef.current = activeProjectId
    if (activeProjectId && !loadedProjectsRef.current.has(activeProjectId)) {
      void refreshProjectList(activeProjectId)
    }
  }, [activeProjectId, refreshProjectList])

  useEffect(() => {
    if (typeof window.pact?.onTerminalState !== 'function') return undefined
    const unsub = window.pact.onTerminalState((event: TerminalStateEvent) => {
      if (event.kind === 'upsert') {
        const summary = event.terminal
        updateCachedTerminalSummary(summary)
        setTerminalsByProject((prev) => {
          const list = prev[summary.projectId] ?? []
          const idx = list.findIndex((item) => item.id === summary.id)
          const next =
            idx >= 0
              ? [...list.slice(0, idx), summary, ...list.slice(idx + 1)]
              : [...list, summary].toSorted((a, b) => a.index - b.index)
          return { ...prev, [summary.projectId]: next }
        })
        return
      }

      disposeTerminalView(event.terminalId)
      setInputErrorByTerminal((prev) => {
        if (!(event.terminalId in prev)) return prev
        const copy = { ...prev }
        delete copy[event.terminalId]
        return copy
      })
      setPendingClose((curr) => (curr?.terminalId === event.terminalId ? undefined : curr))
      setTerminalsByProject((prev) => {
        const existing = prev[event.projectId] ?? []
        const remaining = existing.filter((item) => item.id !== event.terminalId)
        setUiByProject((uiPrev) => {
          const curUi = uiPrev[event.projectId]
          if (!curUi) return uiPrev
          const stillHasActive = remaining.some((item) => item.id === curUi.activeTerminalId)
          const nextActive = stillHasActive ? curUi.activeTerminalId : remaining[0]?.id
          const shouldCollapse = remaining.length === 0
          return {
            ...uiPrev,
            [event.projectId]: {
              ...curUi,
              activeTerminalId: nextActive,
              ...(shouldCollapse ? { open: false, maximized: false } : {}),
            },
          }
        })
        return { ...prev, [event.projectId]: remaining }
      })
    })
    return () => unsub()
  }, [])

  const createTab = useCallback(async (projectId: string): Promise<void> => {
    if (typeof window.pact?.createTerminal !== 'function') return
    if (creatingProjectsRef.current.has(projectId)) return
    creatingProjectsRef.current.add(projectId)
    setBusyByProject((prev) => ({ ...prev, [projectId]: true }))
    setErrorByProject((prev) => ({ ...prev, [projectId]: undefined }))
    try {
      const requestId = crypto.randomUUID()
      const result = await window.pact.createTerminal({ projectId, requestId })
      if (!result.ok) {
        setErrorByProject((prev) => ({ ...prev, [projectId]: result.error.message }))
        return
      }
      const created = result.value
      updateCachedTerminalSummary(created)
      setTerminalsByProject((prev) => {
        const list = prev[projectId] ?? []
        const next = list.some((t) => t.id === created.id)
          ? list.map((t) => (t.id === created.id ? created : t))
          : [...list, created].toSorted((a, b) => a.index - b.index)
        return { ...prev, [projectId]: next }
      })
      setUiByProject((prev) => {
        const cur = prev[projectId] ?? DEFAULT_UI_STATE
        return {
          ...prev,
          [projectId]: { ...cur, open: true, activeTerminalId: created.id },
        }
      })
    } finally {
      creatingProjectsRef.current.delete(projectId)
      setBusyByProject((prev) => ({ ...prev, [projectId]: false }))
    }
  }, [])

  const openProjectTerminal = useCallback(
    async (projectId: string): Promise<void> => {
      const currentList = loadedProjectsRef.current.has(projectId)
        ? (terminalsRef.current[projectId] ?? [])
        : await refreshProjectList(projectId)

      setUiByProject((prev) => {
        const cur = prev[projectId] ?? DEFAULT_UI_STATE
        return {
          ...prev,
          [projectId]: {
            ...cur,
            open: true,
            activeTerminalId:
              cur.activeTerminalId && currentList.some((item) => item.id === cur.activeTerminalId)
                ? cur.activeTerminalId
                : currentList[0]?.id,
          },
        }
      })

      if (currentList.length === 0) {
        await createTab(projectId)
      }
    },
    [createTab, refreshProjectList],
  )

  const collapseProjectTerminal = useCallback((projectId: string): void => {
    setPendingClose((curr) => {
      if (!curr) return curr
      const belongs = (terminalsRef.current[projectId] ?? []).some((t) => t.id === curr.terminalId)
      return belongs ? undefined : curr
    })
    setUiByProject((prev) => {
      const cur = prev[projectId] ?? DEFAULT_UI_STATE
      return { ...prev, [projectId]: { ...cur, open: false, maximized: false } }
    })
  }, [])

  const toggleProjectTerminal = useCallback(
    async (projectId: string): Promise<void> => {
      const cur = uiRef.current[projectId] ?? DEFAULT_UI_STATE
      if (cur.open) {
        collapseProjectTerminal(projectId)
        onRestoreFocusAfterClose?.(projectId)
      } else {
        await openProjectTerminal(projectId)
      }
    },
    [collapseProjectTerminal, onRestoreFocusAfterClose, openProjectTerminal],
  )

  const setProjectMaximized = useCallback((projectId: string, maximized: boolean): void => {
    setUiByProject((prev) => {
      const cur = prev[projectId] ?? DEFAULT_UI_STATE
      return { ...prev, [projectId]: { ...cur, open: true, maximized } }
    })
  }, [])

  const setProjectHeight = useCallback((projectId: string, height: number): void => {
    setUiByProject((prev) => {
      const cur = prev[projectId] ?? DEFAULT_UI_STATE
      return { ...prev, [projectId]: { ...cur, height } }
    })
  }, [])

  const selectTerminalTab = useCallback((projectId: string, terminalId: string): void => {
    setPendingClose(undefined)
    setUiByProject((prev) => {
      const cur = prev[projectId] ?? DEFAULT_UI_STATE
      return { ...prev, [projectId]: { ...cur, activeTerminalId: terminalId } }
    })
  }, [])

  const setTerminalInputError = useCallback(
    (terminalId: string, message: string | undefined): void => {
      setInputErrorByTerminal((prev) => {
        if (prev[terminalId] === message) return prev
        if (message === undefined) {
          const copy = { ...prev }
          delete copy[terminalId]
          return copy
        }
        return { ...prev, [terminalId]: message }
      })
    },
    [],
  )

  const performClose = useCallback(
    async (projectId: string, terminalId: string, force: boolean): Promise<void> => {
      if (typeof window.pact?.closeTerminal !== 'function') return
      const summary = (terminalsRef.current[projectId] ?? []).find((t) => t.id === terminalId)
      const result = await window.pact.closeTerminal({ terminalId, force })
      if (!result.ok) {
        setErrorByProject((prev) => ({ ...prev, [projectId]: result.error.message }))
        return
      }
      if (result.value.confirmationRequired) {
        setPendingClose({
          terminalId,
          title: summary?.title ?? 'Terminal',
          foregroundCommand: result.value.foregroundCommand ?? summary?.foregroundCommand,
        })
        return
      }
      setPendingClose((curr) => (curr?.terminalId === terminalId ? undefined : curr))
      disposeTerminalView(terminalId)
      setInputErrorByTerminal((prev) => {
        if (!(terminalId in prev)) return prev
        const copy = { ...prev }
        delete copy[terminalId]
        return copy
      })
      const list = terminalsRef.current[projectId] ?? []
      const remaining = list.filter((t) => t.id !== terminalId)
      setTerminalsByProject((prev) => ({ ...prev, [projectId]: remaining }))
      setUiByProject((prev) => {
        const cur = prev[projectId] ?? DEFAULT_UI_STATE
        const nextActive =
          cur.activeTerminalId && remaining.some((t) => t.id === cur.activeTerminalId)
            ? cur.activeTerminalId
            : remaining[0]?.id
        const shouldCollapse = remaining.length === 0
        return {
          ...prev,
          [projectId]: {
            ...cur,
            activeTerminalId: nextActive,
            ...(shouldCollapse ? { open: false, maximized: false } : {}),
          },
        }
      })
      if (remaining.length === 0) {
        onRestoreFocusAfterClose?.(projectId)
      }
    },
    [onRestoreFocusAfterClose],
  )

  const requestCloseTab = useCallback(
    async (projectId: string, terminalId: string): Promise<void> => {
      await performClose(projectId, terminalId, false)
    },
    [performClose],
  )

  const confirmPendingClose = useCallback(async (): Promise<void> => {
    if (!pendingClose) return
    const target = pendingClose
    const ownerProject = Object.entries(terminalsRef.current).find(([, list]) =>
      list.some((item) => item.id === target.terminalId),
    )?.[0]
    if (!ownerProject) {
      setPendingClose(undefined)
      return
    }
    await performClose(ownerProject, target.terminalId, true)
  }, [pendingClose, performClose])

  const cancelPendingClose = useCallback((): void => {
    setPendingClose(undefined)
  }, [])

  const disposeProject = useCallback((projectId: string): void => {
    disposeProjectTerminalViews(projectId)
    if (typeof window.pact?.releaseProjectTerminalViews === 'function') {
      void window.pact.releaseProjectTerminalViews({ projectId }).catch(() => undefined)
    }
    loadedProjectsRef.current.delete(projectId)
    setTerminalsByProject((prev) => {
      if (!(projectId in prev)) return prev
      const copy = { ...prev }
      delete copy[projectId]
      return copy
    })
    setUiByProject((prev) => {
      if (!(projectId in prev)) return prev
      const copy = { ...prev }
      delete copy[projectId]
      return copy
    })
  }, [])

  return {
    terminalsByProject,
    uiByProject,
    busyByProject,
    errorByProject,
    inputErrorByTerminal,
    pendingClose,
    openProjectTerminal,
    toggleProjectTerminal,
    collapseProjectTerminal,
    setProjectMaximized,
    setProjectHeight,
    selectTerminalTab,
    createTab,
    requestCloseTab,
    confirmPendingClose,
    cancelPendingClose,
    setTerminalInputError,
    disposeProject,
  }
}
