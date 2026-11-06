import { Eye, EyeOff } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type {
  RpcResult,
  RelayCredentialRevealed,
  SchedulingSettings,
  SchedulingState,
  SchedulingSettingsSave,
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
  relayApiKeySchema,
  RELAY_KEY_BYTES,
  RELAY_CREDENTIAL_TIMEOUT_MS,
} from '@pact/contracts'

type ReadIntent = 'latest' | 'older' | 'newer'
const bytes = (rows: SchedulingActivityRow[]) =>
  new TextEncoder().encode(JSON.stringify(rows)).byteLength

const expireConnection = (
  connection: SchedulingState['connection'],
): SchedulingState['connection'] =>
  connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now()
    ? { ...connection, status: 'stale' }
    : connection

/** App owns one state reader, credential mutations, and the Settings-only history reader. */
export function useSchedulingSettings(
  active: boolean,
  sessionId?: string,
  settingsVisible = active,
) {
  const scope = useMemo(() => ({ active, sessionId }), [active, sessionId])
  const [settings, setSettings] = useState<SchedulingSettings>()
  const [settingsEpoch, setSettingsEpoch] = useState(-1)
  const [snapshot, setSnapshot] = useState<{ value: SchedulingState; scope: typeof scope }>()
  const [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false)
  const [saveBlocked, setSaveBlocked] = useState(false)
  const [error, setError] = useState<string>()
  const [credentialView, setCredentialView] = useState<{
    saving: boolean
    checking: boolean
    uncertain: boolean
    operation: 'save' | 'remove' | undefined
    error: string | undefined
  }>({ saving: false, checking: false, uncertain: false, operation: undefined, error: undefined })
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
    pendingRead: false,
    saving: false,
    saveBlocked: false,
    readbackVersion: 0,
    saveFailure: undefined as string | undefined,
    credentialPending: undefined as
      | {
          nonce: string
          operation: 'save' | 'remove'
          expectedRevision: number
          deadlineAt: number
        }
      | undefined,
    credentialChecking: false,
    credentialSaving: false,
    credentialError: undefined as string | undefined,
  })
  const readState = useCallback(function requestState(): void {
    const current = owner.current
    if (!current.active || !current.mounted) return
    if (current.readingState) {
      current.pendingRead = true
      return
    }
    current.readingState = true
    const epoch = current.epoch
    const changeVersion = current.changeVersion
    const readbackVersion = current.readbackVersion
    const requestScope = current.scope
    setLoading(true)
    void (async () => {
      try {
        const input = requestScope.sessionId ? { sessionId: requestScope.sessionId } : {}
        const result = await window.pact.getSchedulingState(input)
        if (!current.mounted || !current.active || current.epoch !== epoch) return
        if (current.changeVersion !== changeVersion) {
          current.pendingRead = true
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
          value: { ...value, connection: expireConnection(value.connection) },
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
        const pending = current.pendingRead
        current.pendingRead = false
        if (current.mounted) setLoading(false)
        if (pending && current.active && current.mounted) requestState()
      }
    })()
  }, [])
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
      current.pendingRead = false
    }
  }, [])
  useEffect(() => {
    const current = owner.current
    current.epoch += 1
    current.active = scope.active
    current.sessionId = scope.sessionId
    current.scope = scope
    current.pendingRead = false
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
      current.pendingRead = false
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
      current.rows = []
      current.asOf = ''
      current.older = false
      current.newer = false
      queueMicrotask(() => {
        if (!current.mounted || current.details || current.detailsEpoch !== epoch) return
        setRows([])
        setActivityError(undefined)
      })
      return undefined
    }
    queueMicrotask(() => {
      if (!current.mounted || !current.active || !current.details || current.detailsEpoch !== epoch)
        return
      read('latest')
    })
    return () => {
      current.pending = undefined
    }
  }, [scope, settingsVisible, settings?.enabled, settingsEpoch, read])
  const state =
    active &&
    snapshot?.scope === scope &&
    (snapshot.value.context?.sessionId ?? undefined) === sessionId &&
    snapshot.value.settings.revision === settings?.revision
      ? snapshot.value
      : undefined
  useEffect(() => {
    if (!active || !state || state.connection.status === 'stale') return undefined
    const deadline = state.connection.expiresAt ? Date.parse(state.connection.expiresAt) : undefined
    if (deadline === undefined) return undefined
    const timer = window.setTimeout(
      () => {
        const current = owner.current
        if (!current.active || !current.mounted) return
        // Expiry marks the disposable connection view stale, then re-reads plain state.
        setSnapshot((previous) => {
          if (!previous || previous.value !== state) return previous
          return {
            ...previous,
            value: { ...state, connection: expireConnection(state.connection) },
          }
        })
        readState()
      },
      Math.max(0, deadline - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [active, state, readState])
  const readbackSettings = useCallback(() => {
    const current = owner.current
    current.readbackVersion += 1
    current.saveBlocked = true
    if (current.mounted) setSaveBlocked(true)
    readState()
  }, [readState])
  const save = useCallback(
    async (input: Omit<SchedulingSettingsSave, 'expectedRevision'>) => {
      const current = owner.current
      if (
        !settings ||
        current.saving ||
        current.saveBlocked ||
        current.credentialPending ||
        !current.active
      )
        return
      current.saving = true
      current.saveFailure = undefined
      current.changeVersion += 1
      const epoch = current.epoch
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
          readbackSettings()
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
          readbackSettings()
        }
      } catch {
        if (current.mounted) {
          current.changeVersion += 1
          current.saveFailure = 'Could not confirm the save. Reopen Relay settings to try again.'
          if (current.active && current.epoch === epoch) setError(current.saveFailure)
          readbackSettings()
        }
      } finally {
        current.saving = false
        if (current.mounted) setSaving(false)
      }
    },
    [settings, readState, readbackSettings],
  )
  const projectCredential = useCallback(() => {
    const current = owner.current
    if (!current.mounted) return
    setCredentialView({
      saving: current.credentialSaving,
      checking: current.credentialChecking,
      uncertain: current.credentialPending !== undefined && !current.credentialSaving,
      operation: current.credentialPending?.operation,
      error: current.credentialError,
    })
  }, [])
  const credentialWrite = useCallback(
    (operation: 'save' | 'remove', key?: string): boolean => {
      const current = owner.current
      if (
        !settings ||
        !current.active ||
        !current.mounted ||
        current.credentialPending ||
        current.credentialChecking ||
        current.saving ||
        current.saveBlocked
      )
        return false
      if (operation === 'save' && !relayApiKeySchema.safeParse(key).success) return false
      const pending = {
        nonce: crypto.randomUUID(),
        operation,
        expectedRevision: settings.credential.revision,
        deadlineAt: Date.now() + RELAY_CREDENTIAL_TIMEOUT_MS,
      }
      current.credentialPending = pending
      current.credentialError = undefined
      current.credentialSaving = true
      projectCredential()
      void (async () => {
        try {
          const result =
            operation === 'save'
              ? await window.pact.saveRelayApiKey({
                  nonce: pending.nonce,
                  expectedRevision: pending.expectedRevision,
                  deadlineAt: pending.deadlineAt,
                  key: key!,
                })
              : await window.pact.removeRelayApiKey({
                  nonce: pending.nonce,
                  expectedRevision: pending.expectedRevision,
                  deadlineAt: pending.deadlineAt,
                })
          if (!current.mounted || current.credentialPending !== pending) return
          current.changeVersion += 1
          if (result.ok) {
            if (
              result.value.nonce === pending.nonce &&
              result.value.operation === pending.operation &&
              result.value.revision === pending.expectedRevision + 1 &&
              result.value.configured === (pending.operation === 'save')
            ) {
              current.credentialPending = undefined
              current.credentialError = undefined
            }
            // A committed receipt is metadata, never a live availability claim.
            readbackSettings()
          } else if (result.error.code === 'UNCERTAIN') {
            // The retained nonce/operation/revision is the status-check identity.
          } else {
            current.credentialPending = undefined
            current.credentialError = result.error.message
            readbackSettings()
          }
        } catch {
          // An unacknowledged result keeps the retained nonce until Check status resolves it.
        } finally {
          current.credentialSaving = false
          projectCredential()
        }
      })()
      return true
    },
    [settings, readbackSettings, projectCredential],
  )
  const checkCredentialStatus = useCallback((): void => {
    const current = owner.current
    const pending = current.credentialPending
    if (
      !pending ||
      current.credentialChecking ||
      current.credentialSaving ||
      !current.mounted ||
      !current.active
    )
      return
    current.credentialChecking = true
    projectCredential()
    void (async () => {
      try {
        const result = await window.pact.readRelayCredentialReceipt({ nonce: pending.nonce })
        if (!current.mounted || current.credentialPending !== pending) return
        current.changeVersion += 1
        if (
          result.ok &&
          result.value &&
          result.value.nonce === pending.nonce &&
          result.value.operation === pending.operation &&
          result.value.revision === pending.expectedRevision + 1 &&
          result.value.configured === (pending.operation === 'save')
        ) {
          current.credentialPending = undefined
          current.credentialError = undefined
          readbackSettings()
        } else if (result.ok && result.value === null && Date.now() >= pending.deadlineAt) {
          // Missing receipt after the original request deadline: no stored mutation.
          current.credentialPending = undefined
          current.credentialError = 'The key change was not saved.'
          readbackSettings()
        }
        // Any other outcome keeps the retained nonce for a later explicit check.
      } catch {
        // A failed status read keeps uncertainty.
      } finally {
        current.credentialChecking = false
        projectCredential()
      }
    })()
  }, [readbackSettings, projectCredential])
  return {
    settings,
    state,
    loading,
    saving,
    saveBlocked,
    error,
    rows,
    activityLoading,
    activityError,
    save,
    readOlder: () => read('older'),
    readNewer: () => read('newer'),
    saveKey: (key: string) => credentialWrite('save', key),
    removeKey: () => credentialWrite('remove'),
    checkCredentialStatus,
    credentialSaving: credentialView.saving,
    credentialChecking: credentialView.checking,
    credentialUncertain: credentialView.uncertain,
    credentialOperation: credentialView.operation,
    credentialError: credentialView.error,
    visible: active && settingsVisible,
  }
}

const activityActions: Record<NonNullable<SchedulingActivityRow['action']>, string> = {
  plan_review: 'Review Plan',
  plan_revision: 'Revise Plan',
  implementation: 'Implement changes',
  code_review: 'Review code',
  respond: 'Respond to review',
  repair: 'Repair code',
  reply: 'Reply to message',
  route_codex: 'Route to Codex',
  route_claude: 'Route to Claude Code',
  clarify_prepared_input: 'Clarify input',
  supplement_plan: 'Clarify Plan',
  supplement_code_response: 'Clarify review',
  native_check: 'Check agent session',
  queue_check: 'Check delivery',
  rebuild_check: 'Check rebuild',
  confirmed_resend: 'Retry unsent work',
  rebuild_native_context: 'Rebuild agent session',
  reassign_roles: 'Change code roles',
}
const activityReasons: Record<SchedulingActivityRow['reason'], string> = {
  workflow: 'Workflow handoff',
  input: 'Message routing',
  native_check: 'Check agent session',
  queue_check: 'Check delivery',
  rebuild_check: 'Check rebuild',
  native_rebuild: 'Rebuild agent session',
  confirmed_resend: 'Retry unsent work',
}
const activityResults: Record<NonNullable<SchedulingActivityRow['actionResult']>, string> = {
  reserved: 'Not started',
  dispatched: 'Awaiting result',
  completed: 'Completed',
  failed: 'Failed',
  not_sent: 'Not started',
  unconfirmed: 'Unconfirmed',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
}
function activityDisplay(row: SchedulingActivityRow): {
  action: string
  outcome: string
  warning: string | null
  failed: boolean
} {
  const action = row.action ? activityActions[row.action] : activityReasons[row.reason]
  const check = ['native_check', 'queue_check', 'rebuild_check'].includes(row.reason)
  let outcome: string
  if (row.suggestionState === 'awaiting_user')
    outcome = row.action === 'clarify_prepared_input' ? 'Needs information' : 'Needs confirmation'
  else if (row.actionResult) outcome = activityResults[row.actionResult]
  else if (check)
    outcome =
      row.result === 'completed'
        ? 'Checked'
        : row.result === 'failed'
          ? 'Check failed'
          : row.result === 'possibly_sent'
            ? 'Awaiting result'
            : 'Not started'
  else if (row.suggestionState === 'adopted') outcome = 'Applied'
  else if (row.suggestionState === 'suggested') outcome = 'Suggested'
  else if (row.suggestionState === 'discarded') outcome = 'Not used'
  else if (row.suggestionState === 'fallback') outcome = 'Default kept'
  else
    outcome =
      row.result === 'completed'
        ? row.suggestion
          ? 'Suggested'
          : 'No change'
        : row.result === 'failed'
          ? 'No decision'
          : row.result === 'not_sent'
            ? 'Not consulted'
            : row.result === 'possibly_sent'
              ? 'Awaiting result'
              : 'Pending'
  const terminal = row.actionResult
    ? ['completed', 'failed', 'not_sent', 'cancelled', 'superseded'].includes(row.actionResult)
    : ['completed', 'failed', 'not_sent'].includes(row.result)
  const warnings = [
    row.originalUnconfirmed ? 'Previous work unconfirmed' : null,
    terminal && row.physicalUnconfirmed ? 'Cleanup unconfirmed' : null,
  ].filter(Boolean)
  return {
    action,
    outcome,
    warning: warnings.length ? warnings.join(' · ') : null,
    failed: outcome === 'Failed' || outcome === 'Check failed',
  }
}

const selectionParts = [
  'action',
  'outcome',
  'context',
  'time',
  'time-context',
  'project',
  'project-session',
  'session',
  'warning',
] as const
type SelectionPoint = {
  id: string
  part?: (typeof selectionParts)[number]
  offset: number
  affinity: 'following' | 'preceding'
}
function selectionPoint(
  container: HTMLElement,
  node: Node | null,
  offset: number,
): SelectionPoint | undefined {
  const element = node instanceof Element ? node : node?.parentElement,
    row = element?.closest<HTMLElement>('[data-activity-row]')
  if (!node || !row || !container.contains(row)) return undefined
  const segment = element?.closest<HTMLElement>('[data-activity-text]'),
    part = selectionParts.find((name) => name === segment?.dataset.activityText),
    range = document.createRange()
  range.selectNodeContents(part && segment && row.contains(segment) ? segment : row)
  range.setEnd(node, offset)
  return {
    id: row.dataset.activityRow!,
    ...(part ? { part } : {}),
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
  const segment = point.part
    ? row.querySelector<HTMLElement>(`[data-activity-text="${point.part}"]`)
    : row
  if (!segment) return undefined
  const walker = document.createTreeWalker(segment, NodeFilter.SHOW_TEXT)
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
  const { settings } = state
  const [key, setKey] = useState('')
  const [keyError, setKeyError] = useState<string>()
  const [showKey, setShowKey] = useState(false)
  const [revealed, setRevealed] = useState<{ key: string; revision: number }>()
  const [revealing, setRevealing] = useState(false)
  const [revealError, setRevealError] = useState<string>()
  const revealIntent = useRef(0)
  const revealMounted = useRef(false)
  const revealRequest = useRef<Promise<unknown> | undefined>(undefined)
  const revealFacts = useRef({
    visible: false,
    enabled: false,
    configured: false,
    busy: false,
    revision: 0,
  })
  const clearRevealed = useCallback(() => {
    revealIntent.current++
    setRevealed(undefined)
    setShowKey(false)
    setRevealError(undefined)
  }, [])
  const credentialBusy =
    state.saving ||
    state.saveBlocked ||
    state.credentialSaving ||
    state.credentialChecking ||
    state.credentialUncertain
  const savingKey = state.credentialSaving && state.credentialOperation === 'save'
  const removingKey = state.credentialSaving && state.credentialOperation === 'remove'
  const enabled = settings?.enabled === true
  const credentialConfigured = settings?.credential.configured === true
  const credentialRevision = settings?.credential.revision
  // Mount + window/document listeners; unmount marks scope and invalidates intent without setState.
  useLayoutEffect(() => {
    const mounted = revealMounted
    const facts = revealFacts
    const intentRef = revealIntent
    mounted.current = true
    const clear = (): void => {
      if (document.hidden) clearRevealed()
    }
    window.addEventListener('blur', clearRevealed)
    document.addEventListener('visibilitychange', clear)
    return () => {
      window.removeEventListener('blur', clearRevealed)
      document.removeEventListener('visibilitychange', clear)
      mounted.current = false
      facts.current.visible = false
      intentRef.current++
    }
  }, [clearRevealed])
  useLayoutEffect(() => {
    const previous = revealFacts.current
    const next = {
      visible: state.visible,
      enabled,
      configured: credentialConfigured,
      busy: credentialBusy,
      revision: credentialRevision ?? -1,
    }
    revealFacts.current = next
    if (
      previous.visible === next.visible &&
      previous.enabled === next.enabled &&
      previous.configured === next.configured &&
      previous.busy === next.busy &&
      previous.revision === next.revision
    )
      return
    // Only a real scope change invalidates the in-flight intent.
    const intent = ++revealIntent.current
    queueMicrotask(() => {
      if (revealMounted.current && revealIntent.current === intent) clearRevealed()
    })
  }, [
    state.visible,
    enabled,
    credentialConfigured,
    credentialBusy,
    credentialRevision,
    clearRevealed,
  ])
  const currentRevealed =
    state.visible &&
    enabled &&
    credentialConfigured &&
    !credentialBusy &&
    revealed &&
    revealed.revision === settings?.credential.revision
      ? revealed
      : undefined
  const keyShown =
    showKey && state.visible && enabled && !credentialBusy && (!!key || !!currentRevealed)
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
  useEffect(() => {
    if (state.visible && enabled) return
    queueMicrotask(() => {
      setKey('')
      setKeyError(undefined)
    })
  }, [state.visible, enabled])
  const toggleKeyVisibility = (): void => {
    if (key) {
      setShowKey((value) => !value)
      return
    }
    if (currentRevealed) {
      clearRevealed()
      return
    }
    if (revealRequest.current) return
    if (
      !credentialConfigured ||
      revealing ||
      !settings ||
      !state.visible ||
      !enabled ||
      credentialBusy ||
      !revealMounted.current
    ) {
      setShowKey(false)
      return
    }
    const intent = ++revealIntent.current
    setRevealing(true)
    setRevealError(undefined)
    const input = {
      expectedRevision: settings.credential.revision,
      deadlineAt: Date.now() + RELAY_CREDENTIAL_TIMEOUT_MS,
    }
    const request = Promise.resolve().then(() => window.pact.revealRelayApiKey(input))
    revealRequest.current = request
    const complete = (result?: RpcResult<RelayCredentialRevealed>): void => {
      if (revealRequest.current !== request) return
      revealRequest.current = undefined
      if (!revealMounted.current) return
      setRevealing(false)
      if (revealIntent.current !== intent) return
      const facts = revealFacts.current
      if (
        !facts.visible ||
        !facts.enabled ||
        !facts.configured ||
        facts.busy ||
        document.hidden ||
        !document.hasFocus()
      )
        return
      if (result?.ok && result.value.revision === facts.revision) {
        setRevealed(result.value)
        setShowKey(true)
      } else {
        setRevealError("Couldn't show the saved API key. Try again.")
      }
    }
    void request.then(complete, () => complete())
  }
  const submitKey = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!relayApiKeySchema.safeParse(key).success) {
      setKeyError('Enter a valid API key.')
      return
    }
    setKeyError(undefined)
    if (state.saveKey(key)) {
      setKey('')
      clearRevealed()
    }
  }
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
        className="relay-settings mx-auto min-h-full w-full max-w-3xl p-section sm:p-spacious"
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
          <h2 className="text-title font-medium tracking-tight text-primary">Relay</h2>
          <p className="mt-2 max-w-[60ch] text-body leading-[1.6] text-secondary">
            Smarter orchestration between Codex and Claude Code, powered by Decisions API.
          </p>
        </header>
        <RelaySwitch
          checked={enabled}
          disabled={!settings || state.saving || state.saveBlocked || credentialBusy}
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
          Relay can adjust routing and handoffs within existing permissions.
        </p>
        {state.error ? (
          <output className="mt-group block text-caption text-danger">{state.error}</output>
        ) : null}
        {enabled && settings ? (
          <div className="relay-details" id="relay-details">
            <div className="relay-details-inner">
              <section className="relay-section" aria-labelledby="relay-key-heading">
                <div className="flex items-center justify-between gap-group">
                  <h3 id="relay-key-heading" className="text-body font-medium text-primary">
                    Decisions API
                  </h3>
                  <span className="text-caption text-secondary">
                    {settings.credential.configured ? 'Saved' : 'Not configured'}
                  </span>
                </div>
                <form onSubmit={submitKey} className="mt-group">
                  <label
                    htmlFor="relay-api-key"
                    className="block text-caption font-medium text-primary"
                  >
                    OpenAI API key
                  </label>
                  <div className="relay-key-controls">
                    <div className="relay-key-field">
                      <input
                        id="relay-api-key"
                        type={keyShown ? 'text' : 'password'}
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={RELAY_KEY_BYTES}
                        value={key || currentRevealed?.key || ''}
                        placeholder={
                          credentialConfigured && !key && !currentRevealed
                            ? '••••••••••••'
                            : undefined
                        }
                        onChange={(event) => {
                          const text = event.target.value
                          revealIntent.current++
                          setRevealed(undefined)
                          setKey(text)
                          setKeyError(undefined)
                          setRevealError(undefined)
                          if (!text) setShowKey(false)
                        }}
                        aria-invalid={keyError !== undefined || undefined}
                        aria-describedby={[
                          'relay-key-help',
                          keyError ? 'relay-key-error' : undefined,
                          state.credentialError ? 'relay-credential-error' : undefined,
                          revealError ? 'relay-reveal-error' : undefined,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        disabled={credentialBusy}
                      />
                      <button
                        className="relay-key-eye"
                        type="button"
                        aria-label={keyShown ? 'Hide API key' : 'Show API key'}
                        title={keyShown ? 'Hide API key' : 'Show API key'}
                        aria-controls="relay-api-key"
                        disabled={
                          credentialBusy ||
                          revealing ||
                          (!key && !credentialConfigured && !currentRevealed)
                        }
                        aria-busy={revealing}
                        onClick={toggleKeyVisibility}
                      >
                        {keyShown ? (
                          <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
                        ) : (
                          <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
                        )}
                      </button>
                    </div>
                    <button
                      className="primary-action-button"
                      type="submit"
                      disabled={credentialBusy || revealing || !key}
                      aria-busy={savingKey}
                      data-busy={savingKey || undefined}
                    >
                      {savingKey ? (
                        <span className="primary-action-spinner" aria-hidden="true" />
                      ) : null}
                      {savingKey
                        ? 'Saving…'
                        : settings.credential.configured
                          ? 'Replace key'
                          : 'Save key'}
                    </button>
                  </div>
                  <p id="relay-key-help" className="mt-2 text-caption text-secondary">
                    Stored encrypted on this device.
                  </p>
                  {keyError ? (
                    <output id="relay-key-error" className="mt-2 block text-caption text-danger">
                      {keyError}
                    </output>
                  ) : null}
                  {state.credentialError ? (
                    <output
                      id="relay-credential-error"
                      className="mt-2 block text-caption text-danger"
                    >
                      {state.credentialError}
                    </output>
                  ) : null}
                  {revealError ? (
                    <output id="relay-reveal-error" className="mt-2 block text-caption text-danger">
                      {revealError}
                    </output>
                  ) : null}
                  {state.credentialUncertain ? (
                    <p className="mt-2 text-caption text-secondary">
                      The key change could not be confirmed.
                    </p>
                  ) : null}
                  {settings.credential.configured || state.credentialUncertain ? (
                    <div className="relay-key-actions">
                      {state.credentialUncertain ? (
                        <button
                          className="relay-key-secondary"
                          type="button"
                          disabled={state.credentialChecking}
                          aria-busy={state.credentialChecking}
                          onClick={() => state.checkCredentialStatus()}
                        >
                          {state.credentialChecking ? 'Checking…' : 'Check status'}
                        </button>
                      ) : null}
                      {settings.credential.configured ? (
                        <button
                          className="relay-key-secondary"
                          type="button"
                          disabled={credentialBusy || revealing}
                          aria-busy={removingKey}
                          onClick={() => {
                            clearRevealed()
                            state.removeKey()
                          }}
                        >
                          {removingKey ? 'Removing…' : 'Remove'}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </form>
              </section>
              <p className="relay-usage text-caption leading-relaxed text-secondary">
                {SCHEDULING_USAGE_NOTICE}
              </p>
              <section className="relay-section relay-preference" aria-label="Indicator preference">
                <RelaySwitch
                  checked={settings.showIndicator}
                  disabled={state.saving || state.saveBlocked || credentialBusy}
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
                      {state.rows.map((row) => {
                        const display = activityDisplay(row)
                        return (
                          <div
                            key={row.id}
                            data-activity-row={row.id}
                            className="py-3 text-caption"
                          >
                            <div className="relay-activity-summary">
                              <p
                                data-activity-text="action"
                                className="min-w-0 wrap-break-word text-body font-medium text-primary"
                              >
                                {display.action}
                              </p>
                              <p
                                data-activity-text="outcome"
                                className={
                                  display.failed
                                    ? 'font-medium text-danger'
                                    : 'font-medium text-secondary'
                                }
                              >
                                {display.outcome}
                              </p>
                            </div>
                            <p
                              data-activity-text="context"
                              className="mt-1 wrap-break-word text-tertiary"
                            >
                              <time
                                data-activity-text="time"
                                className="tabular-nums"
                                dateTime={row.createdAt}
                              >
                                {new Date(row.createdAt).toLocaleString('en-US', {
                                  month: 'short',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  hour12: false,
                                })}
                              </time>
                              <span data-activity-text="time-context">{' · '}</span>
                              <span data-activity-text="project">{row.project}</span>
                              <span data-activity-text="project-session">{' / '}</span>
                              <span data-activity-text="session">{row.session}</span>
                            </p>
                            {display.warning ? (
                              <p
                                data-activity-text="warning"
                                className="mt-1 wrap-break-word text-secondary"
                              >
                                {display.warning}
                              </p>
                            ) : null}
                          </div>
                        )
                      })}
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
