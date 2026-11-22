import { useCallback, useEffect, useRef, useState } from 'react'

import type { DiagnosticStatus, SessionReminder as SessionReminderModel } from '@pact/contracts'

import { APP_TOAST_DURATION_MS, type AppToastTone } from '../components/workspace/AppToast'

export interface AppToastState {
  id: number
  message: string
  tone: AppToastTone
}

export interface SessionReminderState {
  current: SessionReminderModel
  pending: number
}

export interface AppNotificationsFlow {
  toast: AppToastState | undefined
  showToast: (message: string, tone?: AppToastTone) => void
  showWarning: (message: string) => void
  showError: (message: string) => void
  dismissToast: () => void
  sessionReminder: SessionReminderState | undefined
  viewSessionReminder: (reminder: SessionReminderModel) => void
  dismissSessionReminder: (reminder: SessionReminderModel) => void
}

export function useAppNotifications(): AppNotificationsFlow {
  const [toast, setToast] = useState<AppToastState | undefined>()
  const [sessionReminder, setSessionReminder] = useState<SessionReminderState | undefined>()
  const toastTimerRef = useRef<number | undefined>(undefined)

  const showToast = useCallback((message: string, tone: AppToastTone = 'info'): void => {
    if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    setToast({ id: Date.now(), message, tone })
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = undefined
      setToast(undefined)
    }, APP_TOAST_DURATION_MS[tone])
  }, [])

  const showWarning = useCallback(
    (message: string): void => showToast(message, 'warning'),
    [showToast],
  )
  const showError = useCallback((message: string): void => showToast(message, 'error'), [showToast])

  const dismissToast = useCallback((): void => {
    if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = undefined
    setToast(undefined)
  }, [])

  useEffect(
    () => () => {
      if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    const remove = window.pact.onSessionReminderChanged?.((state) => {
      setSessionReminder(
        state.current ? { current: state.current, pending: state.pending } : undefined,
      )
    })
    return () => remove?.()
  }, [])

  const viewSessionReminder = useCallback(
    (reminder: SessionReminderModel): void => {
      void window.pact
        .viewSessionReminder({ id: reminder.id })
        .then((result) => {
          if (!result.ok) showWarning(result.error.message)
          return undefined
        })
        .catch(() => showWarning('Couldn’t open this session. Open it from the sidebar.'))
    },
    [showWarning],
  )

  const dismissSessionReminder = useCallback((reminder: SessionReminderModel): void => {
    void window.pact.dismissSessionReminder({ id: reminder.id }).catch(() => undefined)
  }, [])

  useEffect(() => {
    let active = true
    let notified = false
    const receive = (status: DiagnosticStatus): void => {
      if (active && !notified && status.state === 'unavailable') {
        notified = true
        showWarning('Diagnostic logs couldn’t be saved. Pact will keep running normally.')
      }
    }
    const remove = window.pact.onDiagnosticStatusChanged?.(receive)
    void window.pact
      .getDiagnosticStatus?.()
      .then(receive)
      .catch(() => undefined)
    const onError = (): void => window.pact.reportRendererFault?.('error')
    const onRejection = (): void => window.pact.reportRendererFault?.('rejection')
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      active = false
      remove?.()
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [showWarning])

  return {
    toast,
    showToast,
    showWarning,
    showError,
    dismissToast,
    sessionReminder,
    viewSessionReminder,
    dismissSessionReminder,
  }
}

export function useAutoDismissSessionReminder({
  sessionReminder,
  selectedSessionId,
  conversationVisible,
  windowFocused,
  dismissSessionReminder,
}: {
  sessionReminder: SessionReminderState | undefined
  selectedSessionId: string | undefined
  conversationVisible: boolean
  windowFocused: boolean
  dismissSessionReminder: (reminder: SessionReminderModel) => void
}): void {
  useEffect(() => {
    const reminder = sessionReminder?.current
    if (!reminder || reminder.summary) return
    if (selectedSessionId !== reminder.sessionId || !conversationVisible || !windowFocused) return
    dismissSessionReminder(reminder)
  }, [
    conversationVisible,
    dismissSessionReminder,
    selectedSessionId,
    sessionReminder,
    windowFocused,
  ])
}
