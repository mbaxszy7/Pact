import { Check, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type {
  SchedulingSettings,
  SchedulingState,
  DecisionCapabilityReason,
  SchedulingSettingsSave,
  SchedulingModels,
  SchedulingActivityRow,
  SchedulingActivityPage,
  SchedulingActivityRead,
} from '@pact/contracts'

// oxlint-disable-next-line import/no-unassigned-import -- This surface owns its scoped disclosure and switch styles.
import './relay-settings.css'

import {
  SCHEDULING_USAGE_NOTICE,
  SCHEDULING_ACTIVITY_RESIDENT_ITEMS,
  SCHEDULING_ACTIVITY_RESIDENT_BYTES,
} from '@pact/contracts'

import { relayActivity } from './RelayActivityIndicator'

type ReadIntent = 'latest' | 'older' | 'newer'
const bytes = (rows: SchedulingActivityRow[]) =>
  new TextEncoder().encode(JSON.stringify(rows)).byteLength

type StateIntent = 'read' | 'refresh'
const expireObservation = (observation: SchedulingState['host']): SchedulingState['host'] =>
  observation.expiresAt && Date.parse(observation.expiresAt) <= Date.now()
    ? { ...observation, status: 'stale' }
    : observation

/** App owns one state reader and the Settings-only catalog/history readers. */
export function useSchedulingSettings(
  active: boolean,
  sessionId?: string,
  settingsVisible = active,
) {
  const scope = useMemo(() => ({ active, sessionId }), [active, sessionId])
  const [settings, setSettings] = useState<SchedulingSettings>()
  const [settingsEpoch, setSettingsEpoch] = useState(-1)
  const [snapshot, setSnapshot] = useState<{ value: SchedulingState; scope: typeof scope }>()
  const [models, setModels] = useState<SchedulingModels>()
  const [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false)
  const [saveBlocked, setSaveBlocked] = useState(false)
  const [refreshingModels, setRefreshingModels] = useState(false),
    [refreshingState, setRefreshingState] = useState(false)
  const [error, setError] = useState<string>()
  const [modelError, setModelError] = useState<string>()
  const [rows, setRows] = useState<SchedulingActivityRow[]>([])
  const [activityLoading, setActivityLoading] = useState(false),
    [activityError, setActivityError] = useState<string>()
  const owner = useRef({
    active,
    sessionId,
    scope,
    mounted: true,
    epoch: 0,
    changeVersion: 0,
    configurationGeneration: -1,
    settingsRevision: -1,
    details: false,
    detailsEpoch: 0,
    reading: false,
    pending: undefined as ReadIntent | undefined,
    rows: [] as SchedulingActivityRow[],
    asOf: '',
    older: false,
    newer: false,
    readingState: false,
    refreshingState: false,
    pendingState: undefined as StateIntent | undefined,
    saving: false,
    saveBlocked: false,
    readbackVersion: 0,
    saveFailure: undefined as string | undefined,
    refreshing: false,
    pendingModels: false,
  })
  const readState = useCallback(function requestState(intent: StateIntent = 'read'): void {
    const current = owner.current
    if (!current.active || !current.mounted || (intent === 'refresh' && !current.details)) return
    if (current.readingState) {
      if (intent === 'refresh' || current.pendingState !== 'refresh') current.pendingState = intent
      if (intent === 'refresh') setRefreshingState(true)
      return
    }
    current.readingState = true
    current.refreshingState = intent === 'refresh'
    const epoch = current.epoch
    const changeVersion = current.changeVersion
    const readbackVersion = current.readbackVersion
    const requestScope = current.scope
    setLoading(true)
    if (intent === 'refresh') setRefreshingState(true)
    void (async () => {
      try {
        const input = requestScope.sessionId ? { sessionId: requestScope.sessionId } : {}
        const result = await (intent === 'refresh'
          ? window.pact.refreshSchedulingState(input)
          : window.pact.getSchedulingState(input))
        if (!current.mounted || !current.active || current.epoch !== epoch) return
        if (current.changeVersion !== changeVersion) {
          if (current.pendingState !== 'refresh') current.pendingState = 'read'
          return
        }
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        const value = result.value
        if (
          (value.context?.sessionId ?? undefined) !== requestScope.sessionId ||
          value.configurationGeneration < current.configurationGeneration ||
          value.settings.revision < current.settingsRevision
        )
          return
        current.configurationGeneration = value.configurationGeneration
        current.settingsRevision = value.settings.revision
        setSnapshot({
          value: {
            ...value,
            host: expireObservation(value.host),
            context: value.context
              ? { ...value.context, observation: expireObservation(value.context.observation) }
              : null,
          },
          scope: requestScope,
        })
        setSettings(value.settings)
        setSettingsEpoch(epoch)
        setError(current.saveFailure)
        if (readbackVersion === current.readbackVersion) {
          current.saveBlocked = false
          setSaveBlocked(false)
        }
      } catch {
        if (current.mounted && current.active && current.epoch === epoch)
          setError('Relay status could not be loaded. Reopen Relay settings to try again.')
      } finally {
        current.readingState = false
        current.refreshingState = false
        const pending = current.pendingState
        current.pendingState = undefined
        if (current.mounted) {
          setLoading(false)
          setRefreshingState(false)
        }
        if (pending && current.active && current.mounted)
          requestState(pending === 'refresh' && current.details ? 'refresh' : 'read')
      }
    })()
  }, [])
  const refreshModels = useCallback(
    function refreshCurrentModels(checkCompatibility = true): void {
      const current = owner.current
      if (!current.active || !current.details || !current.mounted) return
      if (current.refreshing) {
        // Reopening can request one latest catalog; repeated clicks never queue native probes.
        if (!checkCompatibility) current.pendingModels = true
        return
      }
      if (current.refreshingState || current.pendingState === 'refresh') {
        if (!checkCompatibility) current.pendingModels = true
        return
      }
      current.pendingModels = false
      current.refreshing = true
      const epoch = current.detailsEpoch
      const scopeEpoch = current.epoch
      setRefreshingModels(true)
      void (async () => {
        try {
          const result = await window.pact.refreshSchedulingModels()
          if (
            !current.mounted ||
            !current.active ||
            !current.details ||
            current.detailsEpoch !== epoch
          )
            return
          if (result.ok) {
            setModels(result.value)
            setModelError(undefined)
          } else {
            setModels(undefined)
            setModelError(result.error.message)
          }
        } catch {
          if (
            current.mounted &&
            current.active &&
            current.details &&
            current.detailsEpoch === epoch
          ) {
            setModels(undefined)
            setModelError('Model availability could not be confirmed.')
          }
        } finally {
          current.refreshing = false
          if (current.mounted) setRefreshingModels(false)
          const pending = current.pendingModels
          current.pendingModels = false
          if (
            checkCompatibility &&
            current.mounted &&
            current.active &&
            current.details &&
            current.detailsEpoch === epoch &&
            current.epoch === scopeEpoch
          )
            readState('refresh')
          else if (pending && current.active && current.details && current.mounted)
            refreshCurrentModels(false)
        }
      })()
    },
    // oxlint-disable-next-line react/memo-dependencies -- Exhaustive-deps requires the stable state-reader callback to stay explicit.
    [readState],
  )
  useEffect(() => {
    if (!refreshingState && owner.current.pendingModels && !owner.current.refreshing)
      refreshModels(false)
  }, [refreshingState, refreshModels])
  const read = useCallback(function request(intent: ReadIntent) {
    const current = owner.current
    if (!current.active || !current.details || !current.mounted) return
    if (current.reading) {
      if (intent === 'latest') current.pending = intent
      return
    }
    if ((intent === 'older' && !current.older) || (intent === 'newer' && !current.newer)) return
    const edge = intent === 'older' ? current.rows.at(-1) : current.rows[0]
    const input: SchedulingActivityRead =
      intent === 'latest' || !edge
        ? {}
        : {
            direction: intent,
            cursor: { asOf: current.asOf, createdAt: edge.createdAt, id: edge.id },
          }
    current.reading = true
    const epoch = current.detailsEpoch
    setActivityLoading(true)
    void (async () => {
      try {
        const result = await window.pact.readSchedulingActivity(input)
        if (
          !current.mounted ||
          !current.active ||
          !current.details ||
          current.detailsEpoch !== epoch
        )
          return
        if (!result.ok) {
          setActivityError('Scheduling activity could not be loaded.')
          return
        }
        const page: SchedulingActivityPage = result.value
        let next: SchedulingActivityRow[]
        if (intent === 'latest') {
          const fresh = new Map(page.rows.map((row) => [row.id, row])),
            overlaps = current.rows.some((row) => fresh.has(row.id)),
            newestResident = current.rows[0],
            newestLatest = page.rows[0],
            oldestLatest = page.rows.at(-1)
          const keepsLatestEdge =
            newestResident &&
            newestLatest &&
            (newestLatest.createdAt > newestResident.createdAt ||
              (newestLatest.createdAt === newestResident.createdAt &&
                newestLatest.id >= newestResident.id))
          const newerGap =
            newestResident &&
            oldestLatest &&
            (oldestLatest.createdAt > newestResident.createdAt ||
              (oldestLatest.createdAt === newestResident.createdAt &&
                oldestLatest.id > newestResident.id))
          // Keep the reading window continuous until reverse paging bridges new history.
          if (page.nextCursor && keepsLatestEdge && (newerGap || (current.newer && overlaps))) {
            next = current.rows.map((row) => fresh.get(row.id) ?? row)
            current.newer = true
          } else {
            next =
              page.nextCursor && overlaps && keepsLatestEdge
                ? [...page.rows, ...current.rows.filter((row) => !fresh.has(row.id))]
                : page.rows
            current.newer = false
            current.older = page.nextCursor !== null
          }
          current.asOf = page.asOf
        } else {
          const seen = new Set(current.rows.map((row) => row.id))
          const added = page.rows.filter((row) => !seen.has(row.id))
          const incoming = new Map(page.rows.map((row) => [row.id, row]))
          const refreshed = current.rows.map((row) => incoming.get(row.id) ?? row)
          next = intent === 'older' ? [...refreshed, ...added] : [...added, ...refreshed]
          if (intent === 'older') current.older = page.nextCursor !== null
          else {
            current.newer = page.nextCursor !== null
            if (!current.newer) current.pending = 'latest'
          }
        }
        next = next.toSorted(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        )
        while (
          next.length > SCHEDULING_ACTIVITY_RESIDENT_ITEMS ||
          bytes(next) > SCHEDULING_ACTIVITY_RESIDENT_BYTES
        ) {
          if (intent === 'older') {
            next.shift()
            current.newer = true
          } else {
            next.pop()
            current.older = true
          }
        }
        current.rows = next
        setRows(next)
        setActivityError(undefined)
      } catch {
        if (current.mounted && current.active && current.details && current.detailsEpoch === epoch)
          setActivityError('Scheduling activity could not be loaded.')
      } finally {
        current.reading = false
        if (current.mounted) setActivityLoading(false)
        const pending = current.pending
        current.pending = undefined
        if (pending && current.active && current.details && current.mounted) request(pending)
      }
    })()
  }, [])
  useEffect(() => {
    const current = owner.current
    current.mounted = true
    return () => {
      current.mounted = false
      current.active = false
      current.details = false
      current.pending = undefined
      current.pendingState = undefined
      current.pendingModels = false
    }
  }, [])
  useEffect(() => {
    const current = owner.current
    current.epoch += 1
    current.active = scope.active
    current.sessionId = scope.sessionId
    current.scope = scope
    current.pendingState = undefined
    if (!scope.active) return undefined
    queueMicrotask(() => {
      if (current.active && current.mounted) readState()
    })
    const unsubscribe = window.pact.onSchedulingChanged(() => {
      current.changeVersion += 1
      readState()
      if (current.details) read('latest')
    })
    return () => {
      unsubscribe()
      current.pendingState = undefined
    }
  }, [scope, readState, read])
  useEffect(() => {
    const current = owner.current
    current.detailsEpoch += 1
    const epoch = current.detailsEpoch
    current.details =
      scope.active &&
      current.scope === scope &&
      settingsVisible &&
      settingsEpoch === current.epoch &&
      settings?.enabled === true
    if (!current.details) {
      current.pending = undefined
      current.pendingModels = false
      if (current.pendingState === 'refresh') current.pendingState = 'read'
      current.rows = []
      current.asOf = ''
      current.older = false
      current.newer = false
      queueMicrotask(() => {
        if (!current.mounted || current.details || current.detailsEpoch !== epoch) return
        setRows([])
        setModels(undefined)
        setModelError(undefined)
        setActivityError(undefined)
        if (!current.refreshingState) setRefreshingState(false)
      })
      return undefined
    }
    queueMicrotask(() => {
      if (!current.mounted || !current.active || !current.details || current.detailsEpoch !== epoch)
        return
      refreshModels(false)
      read('latest')
    })
    return () => {
      current.pending = undefined
      current.pendingModels = false
    }
  }, [scope, settingsVisible, settings?.enabled, settingsEpoch, refreshModels, read])
  const state =
    active &&
    snapshot?.scope === scope &&
    (snapshot.value.context?.sessionId ?? undefined) === sessionId &&
    snapshot.value.settings.revision === settings?.revision
      ? snapshot.value
      : undefined
  useEffect(() => {
    if (!active || !state) return undefined
    const expires = [state.host, state.context?.observation]
      .filter((observation) => observation && observation.status !== 'stale')
      .flatMap((observation) => (observation?.expiresAt ? [Date.parse(observation.expiresAt)] : []))
    if (!expires.length) return undefined
    const deadline = Math.min(...expires)
    const timer = window.setTimeout(
      () => {
        const current = owner.current
        if (!current.active || !current.mounted) return
        // Expiry changes the disposable view immediately; only an explicit refresh probes native.
        setSnapshot((previous) => {
          if (!previous || previous.value !== state) return previous
          return {
            ...previous,
            value: {
              ...state,
              host: expireObservation(state.host),
              context: state.context
                ? { ...state.context, observation: expireObservation(state.context.observation) }
                : null,
            },
          }
        })
        readState()
      },
      Math.max(0, deadline - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [active, state, readState])
  const save = useCallback(
    async (input: Omit<SchedulingSettingsSave, 'expectedRevision'>) => {
      const current = owner.current
      if (!settings || current.saving || current.saveBlocked || !current.active) return
      current.saving = true
      current.saveFailure = undefined
      current.changeVersion += 1
      const epoch = current.epoch
      const readback = () => {
        current.readbackVersion += 1
        current.saveBlocked = true
        if (current.mounted) setSaveBlocked(true)
        readState()
      }
      setSaving(true)
      setError(undefined)
      try {
        const result = await window.pact.saveSchedulingSettings({
          ...input,
          expectedRevision: settings.revision,
        })
        if (!current.mounted) return
        current.changeVersion += 1
        if (!current.active || current.epoch !== epoch) {
          readback()
          return
        }
        if (result.ok) {
          if (result.value.revision >= current.settingsRevision) {
            current.settingsRevision = result.value.revision
            setSettings(result.value)
          }
          readState()
        } else {
          current.saveFailure = result.error.message
          setError(result.error.message)
          readback()
        }
      } catch {
        if (current.mounted) {
          current.changeVersion += 1
          current.saveFailure = 'Could not confirm the save. Reopen Relay settings to try again.'
          if (current.active && current.epoch === epoch) setError(current.saveFailure)
          readback()
        }
      } finally {
        current.saving = false
        if (current.mounted) setSaving(false)
      }
    },
    [settings, readState],
  )
  return {
    settings,
    state,
    models,
    loading,
    saving,
    saveBlocked,
    refreshing: refreshingModels || refreshingState,
    refreshingModels,
    refreshingState,
    error,
    modelError,
    rows,
    activityLoading,
    activityError,
    refreshModels,
    save,
    readOlder: () => read('older'),
    readNewer: () => read('newer'),
  }
}

const targets = [
  { id: 'codex_luna', label: 'GPT-6 Luna · Codex' },
  { id: 'claude_haiku_5_5', label: 'Haiku 5.5 · Claude Code' },
] as const
const reasonLabels: Record<SchedulingActivityRow['reason'], string> = {
  workflow: 'Workflow handoff',
  input: 'Input routing',
  native_check: 'Native session check',
  queue_check: 'Delivery status check',
  rebuild_check: 'Rebuild candidate check',
  native_rebuild: 'Native context rebuild',
  confirmed_resend: 'Confirmed-unsent resend',
}
const capabilityReasons: Record<DecisionCapabilityReason, string> = {
  supported: 'Native compatibility confirmed.',
  busy: 'The native runtime is busy. Refresh models when it finishes.',
  timeout: 'The compatibility check timed out. Refresh models to try again.',
  cancelled: 'The compatibility check was cancelled. Refresh models to try again.',
  stale: 'Native configuration changed. Refresh models to check compatibility again.',
  unsupported_platform: 'This platform does not support Relay decisions.',
  unsupported_provider: 'This provider does not support Relay decisions.',
  unsupported_network: 'The current network configuration is not supported for Relay.',
  unsupported_authentication: 'The current sign-in method is not supported for Relay.',
  unsupported_protocol: 'The installed native runtime does not support Relay decisions.',
  project_authentication_differs: 'This Project uses a different native sign-in configuration.',
  executable_unavailable: 'The native runtime could not be found.',
  model_unavailable: 'The selected model is unavailable in the native runtime.',
  model_metadata_invalid: 'The native runtime could not confirm the selected model.',
  model_effort_unavailable: 'The selected model does not support the required reasoning setting.',
  catalog_limit: 'The model list exceeded the discovery limit. Compatibility is unconfirmed.',
  unavailable: 'Native compatibility could not be confirmed. Refresh models to try again.',
  cleanup_unconfirmed: 'Background resources are still being released.',
}

function relayStatus(state: SchedulingState | undefined, checking: boolean): string {
  if (state) {
    const activity = relayActivity(state)
    if (activity) return activity.description
  }
  if (checking) return 'Checking native compatibility…'
  if (!state) return 'Reading Relay status…'
  if (!state.settings.selection) return 'Choose a model to use Relay.'
  const context = state.context
  if (context) {
    switch (context.eligibility) {
      case 'disabled':
        return 'Relay is off.'
      case 'model_required':
        return 'Choose a model to use Relay.'
      case 'busy':
        return 'This Session is busy. Relay is unavailable while it runs.'
      case 'archived':
        return 'Relay is unavailable for this archived Session.'
      case 'paused':
        return 'Collaboration is paused in this Session.'
      case 'input_pending':
        return 'This Session is waiting for user input.'
      case 'native_interaction':
        return 'Complete the native interaction before Relay can continue.'
      case 'recovery_required':
        return 'This Session needs recovery before Relay can continue.'
    }
  }
  const observation = context?.observation ?? state.host
  if (observation.status === 'stale')
    return 'The compatibility check has expired. Refresh models to check again.'
  if (observation.status === 'unconfirmed')
    return context
      ? 'Compatibility for this Session has not been checked. Refresh models to check.'
      : 'Native compatibility has not been checked. Refresh models to check.'
  if (observation.status === 'unavailable')
    return capabilityReasons[observation.capability?.reason ?? 'unavailable']
  if (context?.eligibility === 'unavailable') return 'Relay is unavailable for this Session.'
  if (context?.eligibility === 'unconfirmed')
    return 'Eligibility for this Session is unconfirmed. Refresh models to check.'
  return context
    ? 'Compatible for this Session. Relay can assist eligible workflow handoffs.'
    : 'Host compatibility confirmed. Open a Session to check its eligibility.'
}
function resultLabel(row: SchedulingActivityRow): string {
  const check =
    row.reason === 'native_check' || row.reason === 'queue_check' || row.reason === 'rebuild_check'
  let result: string
  if (row.action === 'rebuild_native_context' && !row.actionResult) {
    result = 'Awaiting your rebuild decision'
  } else if (check) {
    result =
      row.result === 'reserved'
        ? 'Check prepared; not started'
        : row.result === 'possibly_sent'
          ? 'Check result unconfirmed'
          : row.result === 'not_sent'
            ? 'Check not started'
            : row.result === 'completed'
              ? 'Check completed'
              : 'Check failed'
    if (row.originalUnconfirmed) result += '; original work unconfirmed'
  } else if (row.actionResult) {
    const labels: Record<NonNullable<SchedulingActivityRow['actionResult']>, string> = {
      reserved:
        row.action === 'rebuild_native_context'
          ? 'Rebuild prepared; not started'
          : 'Action prepared; not started',
      dispatched:
        row.action === 'rebuild_native_context'
          ? 'Rebuild requested; result unconfirmed'
          : 'Action requested; result unconfirmed',
      completed:
        row.action === 'rebuild_native_context'
          ? 'Native context rebuilt'
          : row.action === 'confirmed_resend'
            ? 'Reexecution completed'
            : 'Business turn completed',
      failed:
        row.action === 'rebuild_native_context'
          ? 'Native rebuild failed'
          : row.action === 'confirmed_resend'
            ? 'Reexecution failed'
            : 'Business turn failed',
      not_sent: 'Action not sent',
      unconfirmed: 'Action result unconfirmed',
      cancelled: 'Scheduling action cancelled',
      superseded: 'Native rebuild superseded',
    }
    result = labels[row.actionResult]
  } else
    result =
      row.result === 'reserved'
        ? 'Decision prepared; no request sent'
        : row.result === 'not_sent'
          ? 'No decision request sent'
          : row.result === 'possibly_sent'
            ? 'Decision result unconfirmed'
            : row.result === 'completed'
              ? 'Decision request completed'
              : 'Decision request failed'
  if (row.action === 'rebuild_native_context' && row.originalUnconfirmed)
    result += '; original work unconfirmed'
  const terminal = row.actionResult
    ? ['completed', 'failed', 'not_sent', 'cancelled', 'superseded'].includes(row.actionResult)
    : ['completed', 'failed', 'not_sent'].includes(row.result)
  return result + (terminal && row.physicalUnconfirmed ? '; cleanup unconfirmed' : '')
}

const actionLabels: Record<NonNullable<SchedulingActivityRow['action']>, string> = {
  plan_review: 'Independent Plan review',
  plan_revision: 'Author Plan revision',
  implementation: 'Authorized implementation',
  code_review: 'Independent code review',
  respond: 'Read-only response',
  repair: 'Authorized repair',
  reply: 'User-input response',
  route_codex: 'Route to Codex',
  route_claude: 'Route to Claude Code',
  clarify_prepared_input: 'Request missing information',
  supplement_plan: 'Extra read-only Plan clarification',
  supplement_code_response: 'Extra read-only code-review response',
  native_check: 'Native session check',
  queue_check: 'Delivery status check',
  rebuild_check: 'Rebuild candidate check',
  confirmed_resend: 'Confirmed-unsent reexecution',
  rebuild_native_context: 'Rebuild native context',
}
function suggestionLabel(row: SchedulingActivityRow): string | null {
  if (row.suggestionState === 'fallback') return 'Default workflow used.'
  if (row.suggestionState === 'awaiting_user')
    return row.suggestion
      ? `Suggestion: ${row.suggestion} Awaiting your decision.`
      : 'Awaiting your scheduling decision.'
  if (row.suggestionState === 'discarded')
    return row.suggestion
      ? `Suggestion not used: ${row.suggestion}`
      : 'Scheduling suggestion discarded.'
  return row.suggestion
    ? `${row.suggestionState === 'adopted' ? 'Suggestion accepted' : 'Suggestion'}: ${row.suggestion}`
    : null
}

type SelectionPoint = { id: string; offset: number; affinity: 'following' | 'preceding' }
function selectionPoint(
  container: HTMLElement,
  node: Node | null,
  offset: number,
): SelectionPoint | undefined {
  const element = node instanceof Element ? node : node?.parentElement,
    row = element?.closest<HTMLElement>('[data-activity-row]')
  if (!node || !row || !container.contains(row)) return undefined
  const range = document.createRange()
  range.selectNodeContents(row)
  range.setEnd(node, offset)
  return {
    id: row.dataset.activityRow!,
    offset: range.toString().length,
    affinity: offset === 0 ? 'following' : 'preceding',
  }
}
function selectionNode(
  container: HTMLElement,
  point: SelectionPoint,
): { node: Node; offset: number } | undefined {
  const row = [...container.querySelectorAll<HTMLElement>('[data-activity-row]')].find(
    (element) => element.dataset.activityRow === point.id,
  )
  if (!row) return undefined
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let offset = point.offset,
    node = walker.nextNode(),
    last: Node | undefined
  while (node) {
    const length = node.textContent?.length ?? 0
    if (offset < length || (offset === length && point.affinity === 'preceding'))
      return { node, offset }
    offset -= length
    last = node
    node = walker.nextNode()
  }
  return last ? { node: last, offset: last.textContent?.length ?? 0 } : undefined
}

function RelaySwitch({
  checked,
  disabled,
  busy,
  compact,
  buttonRef,
  descriptionId,
  children,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  busy: boolean
  compact?: boolean
  buttonRef?: React.Ref<HTMLButtonElement>
  descriptionId?: string
  children: React.ReactNode
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={descriptionId}
      aria-busy={busy}
      aria-disabled={disabled}
      disabled={disabled && !busy}
      className="relay-toggle"
      data-compact={compact || undefined}
      onClick={() => {
        if (!disabled) onChange(!checked)
      }}
    >
      <span className="relay-switch-track" aria-hidden="true" data-on={checked}>
        <span className="relay-switch-thumb" />
      </span>
      <span className="min-w-0 text-left">{children}</span>
    </button>
  )
}

export function DecisionSchedulingSettings({
  state,
}: {
  state: ReturnType<typeof useSchedulingSettings>
}): React.JSX.Element {
  const { settings, models } = state
  const enabled = settings?.enabled === true
  const nativeBusy =
    state.state &&
    (state.state.activity.decision.status !== 'idle' ||
      state.state.activity.check.status !== 'idle')
  const toggle = useRef<HTMLButtonElement>(null)
  const focusWithin = useRef(false)
  const wasEnabled = useRef(enabled)
  const list = useRef<HTMLElement>(null)
  const anchor = useRef<{ id: string; top: number } | undefined>(undefined)
  const selection = useRef<{ anchor: SelectionPoint; focus: SelectionPoint } | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return undefined
    const capture = () => {
      const current = document.getSelection(),
        container = list.current
      if (!current || current.isCollapsed || !container) {
        selection.current = undefined
        return
      }
      const first = selectionPoint(container, current.anchorNode, current.anchorOffset),
        last = selectionPoint(container, current.focusNode, current.focusOffset)
      selection.current = first && last ? { anchor: first, focus: last } : undefined
    }
    document.addEventListener('selectionchange', capture)
    return () => {
      document.removeEventListener('selectionchange', capture)
      selection.current = undefined
    }
  }, [enabled])
  const captureAnchor = useCallback((): void => {
    const container = list.current
    if (!container) return
    const top = container.getBoundingClientRect().top
    const row = [...container.querySelectorAll<HTMLElement>('[data-activity-row]')].find(
      (element) => element.getBoundingClientRect().bottom > top,
    )
    anchor.current = row
      ? { id: row.dataset.activityRow!, top: row.getBoundingClientRect().top - top }
      : undefined
  }, [])
  useLayoutEffect(() => {
    if (
      wasEnabled.current &&
      !enabled &&
      focusWithin.current &&
      !document.hidden &&
      document.hasFocus()
    )
      toggle.current?.focus({ preventScroll: true })
    wasEnabled.current = enabled
  }, [enabled])
  useLayoutEffect(() => {
    if (!state.rows.length) {
      anchor.current = undefined
      selection.current = undefined
      return
    }
    const current = anchor.current,
      container = list.current
    if (current && container && container.scrollTop > 0) {
      const row = [...container.querySelectorAll<HTMLElement>('[data-activity-row]')].find(
        (element) => element.dataset.activityRow === current.id,
      )
      if (row)
        container.scrollTop +=
          row.getBoundingClientRect().top - container.getBoundingClientRect().top - current.top
    }
    const retained = selection.current
    if (retained && container) {
      const first = selectionNode(container, retained.anchor),
        last = selectionNode(container, retained.focus)
      if (first && last)
        document.getSelection()?.setBaseAndExtent(first.node, first.offset, last.node, last.offset)
      else selection.current = undefined
    }
    captureAnchor()
  }, [state.rows, captureAnchor])
  return (
    <div className="relay-settings-surface">
      <main
        className="relay-settings mx-auto min-h-full w-full max-w-[48rem] p-section sm:p-spacious"
        aria-label="Relay settings"
        onFocusCapture={() => {
          focusWithin.current = true
        }}
        onBlurCapture={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            focusWithin.current = false
        }}
      >
        <header className="relay-header">
          <h2 className="text-title font-medium tracking-[-0.025em] text-primary">Relay</h2>
          <p className="mt-2 max-w-[60ch] text-body leading-[1.6] text-secondary">
            Smarter orchestration between Codex and Claude Code.
          </p>
        </header>
        <RelaySwitch
          checked={enabled}
          disabled={!settings || state.saving || state.saveBlocked}
          busy={state.loading || state.saving}
          buttonRef={toggle}
          descriptionId="relay-authorization"
          onChange={(checked) => void state.save({ enabled: checked })}
        >
          <span className="text-body font-medium text-primary">Enable Relay</span>
        </RelaySwitch>
        <p
          id="relay-authorization"
          className="mt-1 max-w-[65ch] text-caption leading-relaxed text-secondary"
        >
          Enabling Relay authorizes Codex or Claude Code to run with full access for background
          decisions; the decision model cannot use tools or edit project files.
        </p>
        {state.error ? (
          <output className="mt-group block text-caption text-danger">{state.error}</output>
        ) : null}
        {enabled && settings ? (
          <div className="relay-details" id="relay-details">
            <div className="relay-details-inner">
              <section className="relay-section" aria-labelledby="relay-model-heading">
                <div className="flex items-center justify-between gap-group">
                  <h3 id="relay-model-heading" className="text-body font-medium text-primary">
                    Model
                  </h3>
                  <button
                    className="relay-refresh"
                    type="button"
                    title={
                      state.refreshing
                        ? 'Refreshing models and compatibility…'
                        : 'Refresh models and compatibility'
                    }
                    aria-label="Refresh models and compatibility"
                    aria-busy={state.refreshing}
                    disabled={state.refreshing || state.saving || nativeBusy}
                    onClick={() => state.refreshModels()}
                  >
                    <RefreshCw aria-hidden="true" className="size-4" strokeWidth={1.75} />
                  </button>
                </div>
                <div
                  className="relay-models"
                  role="radiogroup"
                  aria-labelledby="relay-model-heading"
                >
                  {targets.map((target) => {
                    const available = models?.models.find((model) => model.target === target.id)
                    const saved = settings.selection?.target === target.id
                    const checked =
                      saved &&
                      (!available?.selection ||
                        available.selection.modelId === settings.selection?.modelId)
                    const catalogUnavailable = !available?.selection
                    const unavailable = catalogUnavailable || state.refreshing
                    const detail = state.refreshingModels
                      ? 'Checking…'
                      : available?.status === 'not_found'
                        ? 'Unavailable'
                        : catalogUnavailable
                          ? 'Not confirmed'
                          : saved && !checked
                            ? 'Saved version unavailable'
                            : undefined
                    const wireId =
                      available?.selection?.modelId ??
                      (saved ? settings.selection?.modelId : undefined)
                    const dated = wireId && /-\d{8}$/u.test(wireId)
                    return (
                      <label
                        key={target.id}
                        className="relay-model-row"
                        data-selected={checked || undefined}
                        data-disabled={unavailable || undefined}
                        title={
                          unavailable
                            ? `${target.label}: ${detail}${saved ? `. Saved: ${settings.selection!.modelId}` : ''}`
                            : dated
                              ? wireId
                              : undefined
                        }
                      >
                        <input
                          className="sr-only"
                          type="radio"
                          name="relay-model"
                          aria-label={dated ? `${target.label}, ${wireId}` : target.label}
                          aria-describedby={detail ? `relay-${target.id}-status` : undefined}
                          checked={checked}
                          disabled={unavailable || state.saving || state.saveBlocked}
                          onChange={() => {
                            if (available?.selection)
                              void state.save({
                                selection: available.selection,
                                catalogIdentity: models?.catalogIdentity,
                              })
                          }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-body font-medium">{target.label}</span>
                          {dated ? (
                            <span className="mt-0.5 block break-all text-caption text-secondary">
                              {wireId}
                            </span>
                          ) : null}
                        </span>
                        {detail ? (
                          <span id={`relay-${target.id}-status`} className="shrink-0 text-caption">
                            {saved && checked ? 'Saved · ' : ''}
                            {detail}
                          </span>
                        ) : null}
                        <span className="relay-model-mark" aria-hidden="true">
                          {checked ? <Check className="size-3" strokeWidth={2.5} /> : null}
                        </span>
                      </label>
                    )
                  })}
                </div>
                {state.modelError ? (
                  <output className="mt-2 block text-caption text-secondary">
                    {state.modelError}
                  </output>
                ) : null}
              </section>
              <p className="relay-usage text-caption leading-relaxed text-secondary">
                {SCHEDULING_USAGE_NOTICE}
              </p>
              <output className="mt-2 block text-caption leading-relaxed text-secondary">
                {relayStatus(state.state, state.refreshingState)}
              </output>
              <section className="relay-section relay-preference" aria-label="Indicator preference">
                <RelaySwitch
                  checked={settings.showIndicator}
                  disabled={state.saving || state.saveBlocked}
                  busy={state.saving}
                  compact
                  onChange={(checked) => void state.save({ showIndicator: checked })}
                >
                  <span className="text-body text-secondary">Show activity indicator</span>
                </RelaySwitch>
              </section>
              <section
                className="relay-section relay-activity"
                aria-labelledby="relay-activity-heading"
              >
                <h3 id="relay-activity-heading" className="text-body font-medium text-primary">
                  Activity
                </h3>
                <section
                  ref={list}
                  className="relay-activity-list"
                  aria-label="Relay activity"
                  // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A populated read-only history supports keyboard scrolling.
                  tabIndex={state.rows.length ? 0 : -1}
                  onScroll={(event) => {
                    captureAnchor()
                    const node = event.currentTarget
                    if (node.scrollTop < 80) state.readNewer()
                    if (node.scrollHeight - node.scrollTop - node.clientHeight < 160)
                      state.readOlder()
                  }}
                >
                  {state.rows.length ? (
                    <div className="divide-y divide-border">
                      {state.rows.map((row) => (
                        <div
                          key={row.id}
                          data-activity-row={row.id}
                          className="grid gap-1 py-3 text-caption sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-x-group"
                        >
                          <time className="tabular-nums text-tertiary" dateTime={row.createdAt}>
                            {new Date(row.createdAt).toLocaleString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: false,
                            })}
                          </time>
                          <div className="min-w-0">
                            <p className="break-words font-medium text-primary">
                              {row.project} · {row.session}
                            </p>
                            <p className="mt-1 text-secondary">{reasonLabels[row.reason]}</p>
                            {row.called && row.provider && row.model ? (
                              <p className="mt-1 break-words text-secondary">
                                {row.provider === 'codex' ? 'Codex' : 'Claude Code'} · {row.model}
                              </p>
                            ) : null}
                            {suggestionLabel(row) ? (
                              <p className="mt-1 text-secondary">{suggestionLabel(row)}</p>
                            ) : null}
                            {row.action ? (
                              <p className="mt-1 text-secondary">
                                Action: {actionLabels[row.action]}
                              </p>
                            ) : null}
                            <p className="mt-1 text-primary">Result: {resultLabel(row)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="py-3 text-caption text-tertiary">
                      {state.activityLoading ? 'Loading activity…' : 'No activity yet.'}
                    </p>
                  )}
                  {state.rows.length && state.activityLoading ? (
                    <output className="block py-2 text-caption text-secondary">
                      Loading activity…
                    </output>
                  ) : null}
                  {state.activityError ? (
                    <output className="block py-2 text-caption text-secondary">
                      {state.activityError}
                    </output>
                  ) : null}
                </section>
              </section>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  )
}
