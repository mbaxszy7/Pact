import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type {
  AgentRun,
  CollaborationTask,
  ConversationPage,
  MessageCommentAnchor,
} from '@pact/contracts'

import {
  collaborationActor,
  collaborationInputGate,
  collaborationInputProcessing,
} from '@pact/contracts'

import type { CurrentPlanDocument } from './CurrentPlanPanel'

import { clearProjectionHighlight, focusProjectionRange } from './message-selection'

export interface ConversationMessageNavigation {
  navigationId?: string
  messageId: string
  queuedOperationId?: string | undefined
  startOffset: number
  endOffset: number
  textBasis?: MessageCommentAnchor['textBasis']
  plan?: MessageCommentAnchor['plan']
  report?: MessageCommentAnchor['report']
}

export interface UseConversationPlanPreviewOptions {
  readonly sessionId: string
  readonly visible: boolean
  readonly latestRun: AgentRun | undefined
  readonly queueRevision: number | undefined
  readonly messageNavigation: ConversationMessageNavigation | undefined
  readonly onPlanAvailable: ((sessionId: string, taskId?: string) => void) | undefined
  readonly onOpenPlan: (() => void) | undefined
  readonly onClosePlan: (() => void) | undefined
  readonly onRegisterShowCurrentPlan: ((fn: (() => void) | undefined) => void) | undefined
}

/**
 * Cohesive hook owning collaboration current-plan polling/single-flight projection,
 * historical plan-source preview loading, recorded-plan navigation state, and
 * CurrentPlanPanel reveal/open/close lifecycle.
 */
export function useConversationPlanPreview(options: UseConversationPlanPreviewOptions) {
  const {
    sessionId,
    visible,
    latestRun,
    queueRevision,
    messageNavigation,
    onPlanAvailable,
    onOpenPlan,
    onClosePlan,
    onRegisterShowCurrentPlan,
  } = options

  const [dismissedNavigation, setDismissedNavigation] = useState<
    ConversationMessageNavigation | undefined
  >()
  const [cardPlanNavigation, setCardPlanNavigation] = useState<
    (ConversationMessageNavigation & { sessionId: string }) | undefined
  >()
  const planSourceNavigation =
    messageNavigation?.plan && dismissedNavigation !== messageNavigation
      ? messageNavigation
      : cardPlanNavigation?.sessionId === sessionId
        ? cardPlanNavigation
        : undefined
  const openRecordedPlan = useCallback(
    (source: { runId: string; messageId: string; version: number }): void => {
      setDismissedNavigation(messageNavigation)
      setCardPlanNavigation({
        sessionId,
        navigationId: crypto.randomUUID(),
        messageId: source.messageId,
        startOffset: 0,
        endOffset: 0,
        plan: { runId: source.runId, version: source.version },
      })
      onOpenPlan?.()
    },
    [messageNavigation, onOpenPlan, sessionId],
  )
  const planSourceNavigationRef = useRef(planSourceNavigation)
  const openPlanCallback = useRef(onOpenPlan)
  const planAvailableCallback = useRef(onPlanAvailable)
  const appliedNavigationRef = useRef<ConversationMessageNavigation | undefined>(undefined)

  useLayoutEffect(() => {
    planSourceNavigationRef.current = planSourceNavigation
    openPlanCallback.current = onOpenPlan
    planAvailableCallback.current = onPlanAvailable
  }, [planSourceNavigation, onOpenPlan, onPlanAvailable])

  const isNavigationApplied = useCallback(
    (navigation: ConversationMessageNavigation): boolean =>
      appliedNavigationRef.current === navigation,
    [],
  )

  const markNavigationApplied = useCallback((navigation: ConversationMessageNavigation): void => {
    appliedNavigationRef.current = navigation
  }, [])

  const dismissCommentNavigation = useCallback((): void => {
    setDismissedNavigation(messageNavigation)
    clearProjectionHighlight()
  }, [messageNavigation])

  const [currentPlan, setCurrentPlan] = useState<{
    sessionId: string
    task?: CollaborationTask | undefined
    replacement?:
      | Extract<ConversationPage, { scope: 'collaboration' }>['view']['replacement']
      | undefined
    planSync?: Extract<ConversationPage, { scope: 'collaboration' }>['view']['planSync'] | undefined
    source?: { runId: string; messageId: string } | undefined
    error?: string | undefined
  }>()
  const [planRefresh, setPlanRefresh] = useState(0)
  const planReadOwner = useRef<{
    active: boolean
    pending: boolean
    desired?: { sessionId: string; key: string } | undefined
  }>({ active: true, pending: false })
  const planReadKey = `${latestRun?.id ?? ''}:${latestRun?.status ?? ''}:${latestRun && !['starting', 'running', 'recovering'].includes(latestRun.status) ? latestRun.updatedAt : ''}:${queueRevision ?? ''}:${planRefresh}`

  useEffect(() => {
    const owner = planReadOwner.current
    owner.active = true
    return () => {
      owner.active = false
      owner.desired = undefined
    }
  }, [])

  useEffect(() => {
    const owner = planReadOwner.current
    owner.desired = visible ? { sessionId, key: planReadKey } : undefined
    const read = async (): Promise<void> => {
      if (owner.pending || !owner.active || !owner.desired) return
      owner.pending = true
      const requested = owner.desired
      try {
        const response = await window.pact.getConversation({
          scope: 'collaboration',
          sessionId: requested.sessionId,
          projection: 'current',
        })
        if (!owner.active || owner.desired !== requested) return
        if (!response.ok || response.value.scope !== 'collaboration') {
          setCurrentPlan((current) => ({
            ...(current?.sessionId === requested.sessionId ? current : {}),
            sessionId: requested.sessionId,
            error: response.ok ? 'Plan unavailable.' : response.error.message,
          }))
          return
        }
        const view = response.value.view
        const task = view.task ?? undefined
        setCurrentPlan({
          sessionId: requested.sessionId,
          task,
          replacement: view.replacement,
          source: view.planSource,
          planSync: view.planSync,
        })
        if (!planSourceNavigationRef.current)
          planAvailableCallback.current?.(
            requested.sessionId,
            task?.planReference && view.planSource ? task.id : undefined,
          )
      } catch {
        if (owner.active && owner.desired === requested)
          setCurrentPlan((current) => ({
            ...(current?.sessionId === requested.sessionId ? current : {}),
            sessionId: requested.sessionId,
            error: 'Plan unavailable.',
          }))
      } finally {
        owner.pending = false
        if (owner.active && owner.desired && owner.desired !== requested) void read()
      }
    }
    void read()
  }, [sessionId, planReadKey, visible])

  const currentTask = currentPlan?.sessionId === sessionId ? currentPlan.task : undefined
  const planningTask =
    currentTask && (currentTask.kind === 'plan' || Boolean(currentTask.planReference))
      ? currentTask
      : undefined
  const unfinishedTask = currentTask?.status === 'complete' ? undefined : currentTask
  const inputGateState = unfinishedTask ? collaborationInputGate(unfinishedTask) : undefined
  const planRecovery =
    currentPlan?.sessionId === sessionId && currentPlan.planSync?.runId === unfinishedTask?.runId
      ? currentPlan?.planSync
      : undefined
  const decisionSource = unfinishedTask
    ? collaborationInputProcessing(unfinishedTask).decision
    : undefined
  const decisionKey =
    unfinishedTask && decisionSource
      ? `${unfinishedTask.id}:${decisionSource.runId}:${unfinishedTask.inputSequence}`
      : undefined
  const decisionTakeover = Boolean(decisionSource)

  const [planSourcePreview, setPlanSourcePreview] = useState<{
    key: string
    taskId?: string | undefined
    plan?: CurrentPlanDocument | undefined
    error?: string | undefined
  }>()
  const planSourceRead = useRef<{
    active: boolean
    pending: boolean
    desired?: { key: string; sessionId: string; runId: string; version: number } | undefined
  }>({ active: true, pending: false })
  const planSourceKey = planSourceNavigation?.plan
    ? `${sessionId}:${planSourceNavigation.navigationId ?? ''}:${planSourceNavigation.plan.runId}:${planSourceNavigation.plan.version}:${planSourceNavigation.startOffset}:${planSourceNavigation.endOffset}:${planSourceNavigation.textBasis ?? ''}:${planRefresh}`
    : undefined

  useEffect(() => {
    const owner = planSourceRead.current
    owner.active = true
    return () => {
      owner.active = false
      owner.desired = undefined
    }
  }, [])

  useEffect(() => {
    const owner = planSourceRead.current
    const anchor = planSourceNavigationRef.current?.plan
    owner.desired =
      visible && planSourceKey && anchor
        ? {
            key: planSourceKey,
            sessionId,
            runId: anchor.runId,
            version: anchor.version,
          }
        : undefined
    if (owner.desired) openPlanCallback.current?.()
    const read = async (): Promise<void> => {
      if (!owner.active || owner.pending || !owner.desired) return
      owner.pending = true
      const requested = owner.desired
      try {
        const result = await window.pact.getConversation({
          scope: 'collaboration',
          projection: 'plan',
          sessionId: requested.sessionId,
          runId: requested.runId,
        })
        if (!owner.active || owner.desired !== requested) return
        const view =
          result.ok && result.value.scope === 'collaboration' ? result.value.view : undefined
        const source = view?.planSource
        const task = view?.task
        if (
          !task?.planReference ||
          task.planVersion !== requested.version ||
          source?.runId !== requested.runId
        ) {
          setPlanSourcePreview({ key: requested.key, error: 'This plan source is unavailable.' })
          return
        }
        setPlanSourcePreview({
          key: requested.key,
          taskId: task.id,
          plan: {
            runId: requested.runId,
            messageId: source.messageId,
            version: requested.version,
            author:
              task.planReference.author ?? task.planAuthor ?? collaborationActor(task, 'plan'),
            content: '',
            document: task.planReference.document,
            sessionId: requested.sessionId,
            aroundOffset: planSourceNavigationRef.current?.startOffset,
            endOffset: planSourceNavigationRef.current?.endOffset,
            navigationId: planSourceNavigationRef.current?.navigationId,
            basis:
              planSourceNavigationRef.current?.textBasis === 'plain-visible-v1'
                ? 'plain-visible-v1'
                : undefined,
            status: 'Original version',
          },
        })
        planAvailableCallback.current?.(requested.sessionId, task.id)
        openPlanCallback.current?.()
      } catch {
        if (owner.active && owner.desired === requested)
          setPlanSourcePreview({ key: requested.key, error: 'This plan source is unavailable.' })
      } finally {
        owner.pending = false
        if (owner.active && owner.desired && owner.desired !== requested) void read()
      }
    }
    void read()
  }, [sessionId, planSourceKey, visible])

  const handlePanelPlanReady = useCallback(
    (host: HTMLElement): (() => void) | undefined => {
      if (
        !visible ||
        !planSourceNavigation?.plan ||
        planSourceNavigation.endOffset <= planSourceNavigation.startOffset ||
        appliedNavigationRef.current === planSourceNavigation
      )
        return undefined
      if (
        host.dataset.pactPlanRunId !== planSourceNavigation.plan.runId ||
        Number(host.dataset.pactPlanVersion) !== planSourceNavigation.plan.version
      )
        return undefined
      const frame = requestAnimationFrame(() => {
        const content = host.querySelector<HTMLElement>('[data-pact-message-content]')
        if (
          content?.isConnected &&
          focusProjectionRange(
            content,
            planSourceNavigation.startOffset,
            planSourceNavigation.endOffset,
          )
        )
          appliedNavigationRef.current = planSourceNavigation
      })
      return () => cancelAnimationFrame(frame)
    },
    [visible, planSourceNavigation],
  )

  const refreshTaskPlan = useCallback((): void => {
    setPlanRefresh((value) => value + 1)
  }, [])

  const sourcePreview =
    planSourceKey && planSourcePreview?.key === planSourceKey ? planSourcePreview : undefined
  const latestPlanVersion =
    sourcePreview?.plan &&
    planningTask?.planReference &&
    currentPlan?.source &&
    planningTask.id === sourcePreview.taskId &&
    planningTask.planVersion > sourcePreview.plan.version
      ? planningTask.planVersion
      : undefined
  const showCurrentPlan = (): void => {
    if (planSourceNavigation) {
      planSourceRead.current.desired = undefined
      setPlanSourcePreview(undefined)
      setCardPlanNavigation(undefined)
      setDismissedNavigation(messageNavigation)
      planAvailableCallback.current?.(
        sessionId,
        planningTask?.planReference && currentPlan?.source ? planningTask.id : undefined,
      )
    }
    onOpenPlan?.()
  }
  const showCurrentPlanRef = useRef(showCurrentPlan)
  useLayoutEffect(() => {
    showCurrentPlanRef.current = showCurrentPlan
  })
  useEffect(() => {
    if (!onRegisterShowCurrentPlan) return undefined
    onRegisterShowCurrentPlan(() => showCurrentPlanRef.current())
    return () => onRegisterShowCurrentPlan(undefined)
  }, [onRegisterShowCurrentPlan])

  const handlePlanRevealApplied = useCallback((id: string): void => {
    const navigation = planSourceNavigationRef.current
    if (navigation?.navigationId === id && navigation.plan)
      appliedNavigationRef.current = navigation
  }, [])

  const handleClosePlanPanel = useCallback((): void => {
    if (planSourceNavigationRef.current) {
      planSourceRead.current.desired = undefined
      setPlanSourcePreview(undefined)
      setCardPlanNavigation(undefined)
      setDismissedNavigation(messageNavigation)
    }
    onClosePlan?.()
  }, [messageNavigation, onClosePlan])

  return {
    dismissedNavigation,
    dismissCommentNavigation,
    isNavigationApplied,
    markNavigationApplied,
    openRecordedPlan,
    currentPlan,
    currentTask,
    planningTask,
    unfinishedTask,
    inputGateState,
    planRecovery,
    decisionSource,
    decisionKey,
    decisionTakeover,
    planSourcePreview,
    planSourceKey,
    handlePanelPlanReady,
    handlePlanRevealApplied,
    handleClosePlanPanel,
    refreshTaskPlan,
    latestPlanVersion,
    showCurrentPlan,
  }
}
