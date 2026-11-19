import { useEffect, useEffectEvent, useRef, useState } from 'react'

import {
  AGENTS,
  agentDisplayName,
  resolveActiveAgentPair,
  type ActiveAgentPairInput,
  type AgentModelCatalog,
  type AgentModelSelection,
  type DefaultSessionSettings,
  type DefaultSessionSettingsEditorState,
  type RpcResult,
  type RuntimeAgentId,
  type RuntimePreparation,
  type SessionSettingsEditorState,
} from '@pact/contracts'

import { runtimeReadinessUnavailableReason } from '../../runtime-preparation/RuntimePreparationView'
import { AgentModelSelector } from './AgentModelSelector'
import { InfoTip } from './InfoTip'
import { SettingsSelect } from './SettingsSelect'

export type AgentPairAvailability = Partial<
  Record<RuntimeAgentId, { available: boolean; reason?: string | undefined }>
>

export interface SessionPairNotice {
  tone: 'info' | 'warning'
  text: string
}

export interface ActivePairCatalogPayload {
  modelCatalogs: {
    claude: AgentModelCatalog
    codex: AgentModelCatalog
    agy?: AgentModelCatalog | undefined
  }
}

interface UseActivePairCatalogsOptions {
  editorState: unknown
  baseCatalogs?: ActivePairCatalogPayload['modelCatalogs'] | undefined
  activePair?: readonly [RuntimeAgentId, RuntimeAgentId] | undefined
  agentAvailability?: AgentPairAvailability | undefined
  enabled: boolean
  loadForPair?:
    | ((pair: ActiveAgentPairInput) => Promise<RpcResult<ActivePairCatalogPayload>>)
    | undefined
  onFallbackRefresh?: (() => void) | undefined
}

export interface ActivePairCatalogsState {
  fetchedCatalogs: Partial<Record<RuntimeAgentId, AgentModelCatalog>>
  sameSource: boolean
  pairCatalogLoading: boolean
  refreshCatalogs: () => void
}

const UNLOADED_ACTIVE_PAIR_CATALOG_SUFFIX = ' in the active pair to load its models.'
const UNREADY_ACTIVE_PAIR_CATALOG_SUFFIX = ' must be ready before models can be loaded.'

export function normalizeAgentPairKey(pair: readonly [RuntimeAgentId, RuntimeAgentId]): string {
  return pair[0] < pair[1] ? `${pair[0]}:${pair[1]}` : `${pair[1]}:${pair[0]}`
}

export function isUnloadedPairCatalog(catalog: AgentModelCatalog | undefined): boolean {
  return (
    !catalog ||
    (catalog.status === 'unavailable' &&
      Boolean(
        catalog.detail?.endsWith(UNLOADED_ACTIVE_PAIR_CATALOG_SUFFIX) ||
        catalog.detail?.endsWith(UNREADY_ACTIVE_PAIR_CATALOG_SUFFIX),
      ))
  )
}

export function mergeFetchedPairCatalogs(
  previous: Partial<Record<RuntimeAgentId, AgentModelCatalog>>,
  incoming: ActivePairCatalogPayload['modelCatalogs'],
  pair: readonly [RuntimeAgentId, RuntimeAgentId],
): Partial<Record<RuntimeAgentId, AgentModelCatalog>> {
  const next: Partial<Record<RuntimeAgentId, AgentModelCatalog>> = { ...previous }
  for (const agentId of pair) {
    const candidate = incoming[agentId]
    if (candidate) {
      next[agentId] = candidate
    }
  }
  return next
}

function resolveCatalogEntry(
  base: AgentModelCatalog,
  fetched: AgentModelCatalog | undefined,
  sameSource: boolean,
): AgentModelCatalog {
  if (sameSource && fetched) return fetched
  if (isUnloadedPairCatalog(base) && fetched && !isUnloadedPairCatalog(fetched)) {
    return fetched
  }
  return base
}

function resolveOptionalCatalogEntry(
  base: AgentModelCatalog | undefined,
  fetched: AgentModelCatalog | undefined,
  sameSource: boolean,
): AgentModelCatalog | undefined {
  if (base) return resolveCatalogEntry(base, fetched, sameSource)
  if (sameSource && fetched) return fetched
  if (fetched && !isUnloadedPairCatalog(fetched)) return fetched
  return undefined
}

export function resolveMergedDefaultModelCatalogs(
  base: DefaultSessionSettingsEditorState['modelCatalogs'],
  fetched: Partial<Record<RuntimeAgentId, AgentModelCatalog>>,
  sameSource: boolean,
): DefaultSessionSettingsEditorState['modelCatalogs'] {
  return {
    claude: resolveCatalogEntry(base.claude, fetched.claude, sameSource),
    codex: resolveCatalogEntry(base.codex, fetched.codex, sameSource),
    agy: resolveCatalogEntry(base.agy, fetched.agy, sameSource),
  }
}

export function resolveMergedSessionModelCatalogs(
  base: SessionSettingsEditorState['modelCatalogs'],
  fetched: Partial<Record<RuntimeAgentId, AgentModelCatalog>>,
  sameSource: boolean,
): SessionSettingsEditorState['modelCatalogs'] {
  const agy = resolveOptionalCatalogEntry(base.agy, fetched.agy, sameSource)
  return {
    claude: resolveCatalogEntry(base.claude, fetched.claude, sameSource),
    codex: resolveCatalogEntry(base.codex, fetched.codex, sameSource),
    ...(agy ? { agy } : {}),
  }
}

export function useActivePairCatalogs({
  editorState,
  baseCatalogs,
  activePair,
  agentAvailability,
  enabled,
  loadForPair,
  onFallbackRefresh,
}: UseActivePairCatalogsOptions): ActivePairCatalogsState {
  const [catalogFetchState, setCatalogFetchState] = useState<{
    source: unknown
    catalogs: Partial<Record<RuntimeAgentId, AgentModelCatalog>>
    probedAgents: ReadonlyArray<RuntimeAgentId>
    failedSelectionKey?: string | undefined
    refreshing: boolean
  }>(() => ({
    source: editorState,
    catalogs: {},
    probedAgents: [],
    failedSelectionKey: undefined,
    refreshing: false,
  }))
  const [initialReadyState, setInitialReadyState] = useState<{
    source: unknown
    readyAgents: ReadonlySet<RuntimeAgentId>
  }>(() => ({
    source: editorState,
    readyAgents: new Set(
      AGENTS.filter((agentId) => agentAvailability?.[agentId]?.available ?? true),
    ),
  }))
  if (initialReadyState.source !== editorState) {
    setInitialReadyState({
      source: editorState,
      readyAgents: new Set(
        AGENTS.filter((agentId) => agentAvailability?.[agentId]?.available ?? true),
      ),
    })
  }
  const initialReadyAgents =
    initialReadyState.source === editorState
      ? initialReadyState.readyAgents
      : new Set(AGENTS.filter((agentId) => agentAvailability?.[agentId]?.available ?? true))
  const trackerRef = useRef<{
    mounted: boolean
    refreshRequestId: number
    requestToken: number
    inFlight: { pairKey: string; token: number } | undefined
  }>({
    mounted: true,
    refreshRequestId: 0,
    requestToken: 0,
    inFlight: undefined,
  })

  useEffect(() => {
    const tracker = trackerRef.current
    tracker.mounted = true
    return () => {
      tracker.mounted = false
      tracker.refreshRequestId += 1
      tracker.requestToken += 1
      tracker.inFlight = undefined
    }
  }, [])

  const sameSource = catalogFetchState.source === editorState
  const probedAgents = sameSource ? catalogFetchState.probedAgents : []
  const primaryId = activePair?.[0]
  const secondaryId = activePair?.[1]
  const pairKey =
    primaryId && secondaryId ? normalizeAgentPairKey([primaryId, secondaryId]) : undefined
  const primaryReady = primaryId ? (agentAvailability?.[primaryId]?.available ?? true) : false
  const secondaryReady = secondaryId ? (agentAvailability?.[secondaryId]?.available ?? true) : false
  const selectionKey = pairKey
    ? `${pairKey}:${String(primaryReady)}:${String(secondaryReady)}`
    : undefined
  if (
    sameSource &&
    catalogFetchState.failedSelectionKey &&
    catalogFetchState.failedSelectionKey !== selectionKey
  ) {
    setCatalogFetchState((previous) =>
      previous.source === editorState && previous.failedSelectionKey !== undefined
        ? { ...previous, failedSelectionKey: undefined }
        : previous,
    )
  }
  const hasBridgeLoader = Boolean(loadForPair)
  const needsPairFetch = Boolean(
    enabled &&
    primaryId &&
    secondaryId &&
    baseCatalogs &&
    !(sameSource && catalogFetchState.failedSelectionKey === selectionKey) &&
    [primaryId, secondaryId].some((agentId) => {
      const ready = agentAvailability?.[agentId]?.available ?? true
      if (!ready || probedAgents.includes(agentId)) return false
      const effective = resolveOptionalCatalogEntry(
        baseCatalogs[agentId],
        sameSource ? catalogFetchState.catalogs[agentId] : undefined,
        sameSource,
      )
      if (effective?.status === 'available') return false
      return isUnloadedPairCatalog(effective) || !initialReadyAgents.has(agentId)
    }),
  )
  const autoLoading = Boolean(needsPairFetch && hasBridgeLoader && pairKey)
  const pairCatalogLoading = (sameSource && catalogFetchState.refreshing) || autoLoading

  const invokeLoader = useEffectEvent(
    async (pair: ActiveAgentPairInput): Promise<RpcResult<ActivePairCatalogPayload> | undefined> =>
      loadForPair ? loadForPair(pair) : undefined,
  )

  useEffect(() => {
    if (!enabled || !hasBridgeLoader || !primaryId || !secondaryId || !pairKey) return undefined
    const tracker = trackerRef.current
    if (!autoLoading) {
      if (tracker.inFlight && tracker.inFlight.pairKey !== pairKey) {
        const cancelToken = ++tracker.requestToken
        tracker.inFlight = { pairKey, token: cancelToken }
        void invokeLoader({
          primaryAgentId: primaryId,
          secondaryAgentId: secondaryId,
        })
          .catch(() => undefined)
          .finally(() => {
            if (tracker.inFlight?.token === cancelToken) {
              tracker.inFlight = undefined
            }
          })
      }
      return undefined
    }
    let cancelled = false
    const targetPair: [RuntimeAgentId, RuntimeAgentId] = [primaryId, secondaryId]
    const readyMembers = targetPair.filter((agentId) =>
      agentId === primaryId ? primaryReady : secondaryReady,
    )
    const token = ++tracker.requestToken
    tracker.inFlight = { pairKey, token }
    void (async () => {
      try {
        const result = await invokeLoader({
          primaryAgentId: primaryId,
          secondaryAgentId: secondaryId,
        })
        if (cancelled || !tracker.mounted) return
        setCatalogFetchState((previous) => {
          const baseCatalogMap = previous.source === editorState ? previous.catalogs : {}
          const baseProbed = previous.source === editorState ? previous.probedAgents : []
          if (!result?.ok) {
            return {
              source: editorState,
              catalogs: baseCatalogMap,
              probedAgents: baseProbed,
              failedSelectionKey: selectionKey,
              refreshing: previous.source === editorState ? previous.refreshing : false,
            }
          }
          const nextProbed = [...new Set([...baseProbed, ...readyMembers])]
          return {
            source: editorState,
            catalogs: mergeFetchedPairCatalogs(
              baseCatalogMap,
              result.value.modelCatalogs,
              targetPair,
            ),
            probedAgents: nextProbed,
            failedSelectionKey: undefined,
            refreshing: previous.source === editorState ? previous.refreshing : false,
          }
        })
      } catch {
        if (cancelled || !tracker.mounted) return
        setCatalogFetchState((previous) => {
          const baseCatalogMap = previous.source === editorState ? previous.catalogs : {}
          const baseProbed = previous.source === editorState ? previous.probedAgents : []
          return {
            source: editorState,
            catalogs: baseCatalogMap,
            probedAgents: baseProbed,
            failedSelectionKey: selectionKey,
            refreshing: previous.source === editorState ? previous.refreshing : false,
          }
        })
      } finally {
        if (tracker.inFlight?.token === token) {
          tracker.inFlight = undefined
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    autoLoading,
    editorState,
    enabled,
    hasBridgeLoader,
    pairKey,
    primaryId,
    primaryReady,
    secondaryId,
    secondaryReady,
    selectionKey,
  ])

  const refreshCatalogs = (): void => {
    if (!loadForPair || !primaryId || !secondaryId || !pairKey) {
      onFallbackRefresh?.()
      return
    }
    const tracker = trackerRef.current
    const targetPair: [RuntimeAgentId, RuntimeAgentId] = [primaryId, secondaryId]
    const readyMembers = targetPair.filter(
      (agentId) => agentAvailability?.[agentId]?.available ?? true,
    )
    const requestId = ++tracker.refreshRequestId
    const token = ++tracker.requestToken
    tracker.inFlight = { pairKey, token }
    setCatalogFetchState((previous) => ({
      source: editorState,
      catalogs: previous.source === editorState ? previous.catalogs : {},
      probedAgents: previous.source === editorState ? previous.probedAgents : [],
      failedSelectionKey: undefined,
      refreshing: true,
    }))
    void (async () => {
      try {
        const result = await loadForPair({
          primaryAgentId: primaryId,
          secondaryAgentId: secondaryId,
        })
        if (!tracker.mounted) return
        setCatalogFetchState((previous) => {
          const baseCatalogMap = previous.source === editorState ? previous.catalogs : {}
          const baseProbed = previous.source === editorState ? previous.probedAgents : []
          return {
            source: editorState,
            catalogs: result.ok
              ? mergeFetchedPairCatalogs(baseCatalogMap, result.value.modelCatalogs, targetPair)
              : baseCatalogMap,
            probedAgents: result.ok ? [...new Set([...baseProbed, ...readyMembers])] : baseProbed,
            failedSelectionKey: result.ok ? undefined : selectionKey,
            refreshing: tracker.refreshRequestId === requestId ? false : previous.refreshing,
          }
        })
      } catch {
        if (!tracker.mounted) return
        setCatalogFetchState((previous) => ({
          source: editorState,
          catalogs: previous.source === editorState ? previous.catalogs : {},
          probedAgents: previous.source === editorState ? previous.probedAgents : [],
          failedSelectionKey: selectionKey,
          refreshing: tracker.refreshRequestId === requestId ? false : previous.refreshing,
        }))
      } finally {
        if (tracker.inFlight?.token === token) {
          tracker.inFlight = undefined
        }
      }
    })()
  }

  return {
    fetchedCatalogs: sameSource ? catalogFetchState.catalogs : {},
    sameSource,
    pairCatalogLoading,
    refreshCatalogs,
  }
}

interface SessionSettingsFieldsProps {
  idPrefix: string
  settings: DefaultSessionSettings
  modelCatalogs: SessionSettingsEditorState['modelCatalogs']
  agentAvailability?: AgentPairAvailability | undefined
  existingPair?: readonly [RuntimeAgentId, RuntimeAgentId] | undefined
  lockedPair?: readonly [RuntimeAgentId, RuntimeAgentId] | undefined
  nonRetirableAgents?: readonly RuntimeAgentId[] | undefined
  pairNotice?: SessionPairNotice | undefined
  disabled: boolean
  refreshing?: boolean
  showRefresh?: boolean
  compact?: boolean
  onChange: (settings: DefaultSessionSettings) => void
  onRefresh?: () => void
}

const unavailableModelCatalog = (agentId: RuntimeAgentId): AgentModelCatalog => ({
  agentId,
  status: 'unavailable',
  models: [],
  checkedAt: new Date(0).toISOString(),
})

export const initialSessionSettings: DefaultSessionSettings = {
  primaryAgentId: 'claude',
  secondaryAgentId: 'codex',
  agents: {
    claude: { model: null, effort: null, speed: 'native' },
    codex: { model: null, effort: null, speed: 'native' },
    agy: { model: null, effort: null, speed: 'native' },
  },
  maxDiscussionRounds: 6,
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}

export function deriveAgentAvailability(
  preparation?: RuntimePreparation,
): AgentPairAvailability | undefined {
  if (!preparation) return undefined
  const byId = new Map(preparation.agents.map((entry) => [entry.agentId, entry]))
  const result: AgentPairAvailability = {}
  for (const agentId of AGENTS) {
    const entry = byId.get(agentId)
    result[agentId] = {
      available: entry?.state === 'ready',
      reason: runtimeReadinessUnavailableReason(entry),
    }
  }
  return result
}

export function preferredReadyPair(
  preparation?: RuntimePreparation,
  fallback: readonly [RuntimeAgentId, RuntimeAgentId] = ['claude', 'codex'],
): [RuntimeAgentId, RuntimeAgentId] {
  if (!preparation) return [fallback[0], fallback[1]]
  const readyIds = AGENTS.filter(
    (agentId) => preparation.agents.find((entry) => entry.agentId === agentId)?.state === 'ready',
  )
  if (readyIds.includes(fallback[0]) && readyIds.includes(fallback[1])) {
    return [fallback[0], fallback[1]]
  }
  const first = readyIds[0]
  const second = readyIds[1]
  if (first && second) return [first, second]
  return [fallback[0], fallback[1]]
}

export function sessionSettingsEqual(
  left: DefaultSessionSettings,
  right: DefaultSessionSettings,
): boolean {
  return (
    left.primaryAgentId === right.primaryAgentId &&
    left.secondaryAgentId === right.secondaryAgentId &&
    left.agents.claude.model === right.agents.claude.model &&
    left.agents.claude.effort === right.agents.claude.effort &&
    left.agents.codex.model === right.agents.codex.model &&
    left.agents.codex.effort === right.agents.codex.effort &&
    left.agents.agy.model === right.agents.agy.model &&
    left.agents.agy.effort === right.agents.agy.effort &&
    left.maxDiscussionRounds === right.maxDiscussionRounds &&
    left.maxReviewCycles === right.maxReviewCycles &&
    left.maxRepairAttempts === right.maxRepairAttempts
  )
}

function resolveNextPairForPrimary(
  settings: DefaultSessionSettings,
  nextPrimary: RuntimeAgentId,
  agentAvailability?: AgentPairAvailability,
): [RuntimeAgentId, RuntimeAgentId] {
  const secondaryId = resolveActiveAgentPair(settings)[1]
  if (nextPrimary === settings.primaryAgentId) {
    return [settings.primaryAgentId, secondaryId]
  }
  if (nextPrimary === secondaryId) {
    return [nextPrimary, settings.primaryAgentId]
  }
  const currentSecondaryAvailable = agentAvailability?.[secondaryId]?.available ?? true
  const previousPrimaryAvailable = agentAvailability?.[settings.primaryAgentId]?.available ?? true
  const nextSecondary =
    !currentSecondaryAvailable && previousPrimaryAvailable ? settings.primaryAgentId : secondaryId
  return [nextPrimary, nextSecondary]
}

export function SessionSettingsFields({
  idPrefix,
  settings,
  modelCatalogs,
  agentAvailability,
  existingPair,
  lockedPair,
  nonRetirableAgents,
  pairNotice,
  disabled,
  refreshing = false,
  showRefresh = false,
  compact = false,
  onChange,
  onRefresh,
}: SessionSettingsFieldsProps): React.JSX.Element {
  const activePair = resolveActiveAgentPair(settings)
  const secondaryId = activePair[1]
  const requiredRetainedAgents = lockedPair ?? nonRetirableAgents ?? []

  const updateAgent = (agentId: RuntimeAgentId, selection: AgentModelSelection): void => {
    onChange({ ...settings, agents: { ...settings.agents, [agentId]: selection } })
  }

  const selectPrimaryAgent = (nextPrimary: RuntimeAgentId): void => {
    if (nextPrimary === settings.primaryAgentId) return
    const [resolvedPrimary, nextSecondary] = resolveNextPairForPrimary(
      settings,
      nextPrimary,
      agentAvailability,
    )
    if (!requiredRetainedAgents.every((req) => resolvedPrimary === req || nextSecondary === req)) {
      return
    }
    onChange({
      ...settings,
      primaryAgentId: resolvedPrimary,
      secondaryAgentId: nextSecondary,
    })
  }

  const secondaryCandidates = AGENTS.filter((agentId) => agentId !== settings.primaryAgentId)

  return (
    <div className="divide-y divide-border">
      <section
        className={compact ? 'py-panel' : 'py-section'}
        aria-labelledby={`${idPrefix}-lead-title`}
      >
        <h2
          id={`${idPrefix}-lead-title`}
          className="text-subtitle font-medium tracking-[-0.015em] text-primary"
        >
          Default agent
        </h2>
        <p className="mt-1 text-caption text-secondary">
          Choose two active agents for the session. Primary receives ordinary messages by default
          and leads /plan drafting and code review while Secondary reviews the plan and implements.
        </p>
        <div
          className={`mt-group grid overflow-hidden rounded-card border border-border ${compact ? 'grid-cols-1' : 'sm:grid-cols-3'}`}
          role="radiogroup"
          aria-labelledby={`${idPrefix}-lead-title`}
        >
          {AGENTS.map((agentId) => {
            const selected = settings.primaryAgentId === agentId
            const candidatePair = resolveNextPairForPrimary(settings, agentId, agentAvailability)
            const inLockedPair = requiredRetainedAgents.every((req) => candidatePair.includes(req))
            const isExistingPairSwap = Boolean(
              existingPair && candidatePair.every((id) => existingPair.includes(id)),
            )
            const availability = agentAvailability?.[agentId]
            const unavailable = availability ? !availability.available : false
            const optionDisabled =
              disabled || (!selected && (!inLockedPair || (unavailable && !isExistingPairSwap)))
            const inputId = `${idPrefix}-primary-${agentId}`
            const statusText = selected
              ? 'Primary agent'
              : !inLockedPair
                ? 'Active pair locked'
                : unavailable && !isExistingPairSwap
                  ? (availability?.reason ?? 'Not ready')
                  : 'Set as primary agent'
            return (
              <div
                key={agentId}
                className={`flex items-center gap-group bg-surface-raised px-panel py-group text-body text-primary has-[:checked]:bg-surface-muted has-[:disabled]:opacity-60 ${optionDisabled ? 'cursor-not-allowed' : 'cursor-pointer'} [&+&]:border-border ${compact ? '[&+&]:border-t' : 'sm:[&+&]:border-l sm:[&+&]:border-t-0 [&+&]:border-t'}`}
              >
                <input
                  id={inputId}
                  className="size-4 accent-focus"
                  type="radio"
                  name={`${idPrefix}-primary-agent`}
                  value={agentId}
                  checked={selected}
                  disabled={optionDisabled}
                  onChange={() => selectPrimaryAgent(agentId)}
                />
                <label
                  className={`min-w-0 flex-1 ${optionDisabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                  htmlFor={inputId}
                >
                  <span className="block font-medium">{agentDisplayName(agentId)}</span>{' '}
                  <span className="mt-0.5 block text-caption text-secondary">{statusText}</span>
                </label>
              </div>
            )
          })}
        </div>

        <label className="mt-group block min-w-0 text-caption font-medium text-secondary">
          Secondary agent
          <SettingsSelect
            aria-label="Secondary agent"
            value={secondaryId}
            disabled={disabled}
            onChange={(event) => {
              const chosen = AGENTS.find((agentId) => agentId === event.target.value)
              if (
                chosen &&
                chosen !== settings.primaryAgentId &&
                requiredRetainedAgents.every(
                  (req) => settings.primaryAgentId === req || chosen === req,
                )
              ) {
                onChange({ ...settings, secondaryAgentId: chosen })
              }
            }}
          >
            {secondaryCandidates.map((agentId) => {
              const selected = secondaryId === agentId
              const candidatePair: [RuntimeAgentId, RuntimeAgentId] = [
                settings.primaryAgentId,
                agentId,
              ]
              const inLockedPair = requiredRetainedAgents.every((req) =>
                candidatePair.includes(req),
              )
              const isExistingPairSwap = Boolean(
                existingPair && candidatePair.every((id) => existingPair.includes(id)),
              )
              const availability = agentAvailability?.[agentId]
              const unavailable = availability ? !availability.available : false
              const optionDisabled =
                !selected && (!inLockedPair || (unavailable && !isExistingPairSwap))
              const suffix = !selected
                ? !inLockedPair
                  ? ' — active pair locked'
                  : unavailable && !isExistingPairSwap
                    ? ` — ${availability?.reason ?? 'Not ready'}`
                    : ''
                : ''
              return (
                <option key={agentId} value={agentId} disabled={optionDisabled}>
                  {agentDisplayName(agentId)}
                  {suffix}
                </option>
              )
            })}
          </SettingsSelect>
        </label>

        {pairNotice ? (
          <p
            className={`mt-group rounded-control px-group py-2 text-caption leading-relaxed ${
              pairNotice.tone === 'warning'
                ? 'bg-status-warning-muted text-status-warning-foreground'
                : 'bg-surface-muted text-secondary'
            }`}
          >
            {pairNotice.text}
          </p>
        ) : null}
      </section>

      <section
        className={compact ? 'py-panel' : 'py-section'}
        aria-labelledby={`${idPrefix}-agents-title`}
      >
        <div className="flex items-start justify-between gap-group">
          <div>
            <h2
              id={`${idPrefix}-agents-title`}
              className="text-subtitle font-medium tracking-[-0.015em]"
            >
              Models &amp; effort
            </h2>
          </div>
          {showRefresh && onRefresh ? (
            <button
              className="h-8 shrink-0 rounded-control px-3 text-caption font-medium text-secondary hover:bg-surface-muted hover:text-primary disabled:cursor-wait disabled:opacity-55"
              type="button"
              disabled={refreshing}
              onClick={onRefresh}
            >
              {refreshing ? 'Refreshing…' : 'Refresh options'}
            </button>
          ) : null}
        </div>
        <div className="mt-group divide-y divide-border">
          {activePair.map((agentId) => (
            <AgentModelSelector
              key={agentId}
              agentId={agentId}
              catalog={modelCatalogs[agentId] ?? unavailableModelCatalog(agentId)}
              selection={settings.agents[agentId]}
              disabled={disabled}
              loading={refreshing && isUnloadedPairCatalog(modelCatalogs[agentId])}
              compact={compact}
              onChange={(selection) => updateAgent(agentId, selection)}
            />
          ))}
        </div>
      </section>

      <section
        className={compact ? 'py-panel' : 'py-section'}
        aria-labelledby={`${idPrefix}-limits-title`}
      >
        <h2
          id={`${idPrefix}-limits-title`}
          className="text-subtitle font-medium tracking-[-0.015em] text-primary"
        >
          Collaboration limits
        </h2>
        <p className="mt-1 text-caption text-secondary">Caps automatic review and repair loops.</p>
        <div className={`mt-group grid gap-group ${compact ? 'grid-cols-1' : 'sm:grid-cols-2'}`}>
          <NumberSetting
            label="Plan reviews"
            value={settings.maxDiscussionRounds}
            max={20}
            disabled={disabled}
            description="Each peer review of a plan counts once. Drafting, revisions and user questions do not count."
            onChange={(maxDiscussionRounds) => onChange({ ...settings, maxDiscussionRounds })}
          />
          <NumberSetting
            label="Code reviews"
            value={settings.maxReviewCycles}
            max={10}
            disabled={disabled}
            description="Each code review counts once, including the first review and every review after a response or repair."
            onChange={(maxReviewCycles) => onChange({ ...settings, maxReviewCycles })}
          />
          <NumberSetting
            label="Repair attempts"
            value={settings.maxRepairAttempts}
            max={10}
            disabled={disabled}
            description="Each authorized repair counts once. Initial implementation and read-only responses or reviews do not count."
            onChange={(maxRepairAttempts) => onChange({ ...settings, maxRepairAttempts })}
          />
        </div>
      </section>
    </div>
  )
}

function SettingLabel({ label, children }: { label: string; children: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-caption font-medium text-secondary">
      <span>{label}</span>
      <InfoTip label={label.toLowerCase()}>{children}</InfoTip>
    </div>
  )
}

function NumberSetting({
  label,
  value,
  max,
  disabled,
  description,
  onChange,
}: {
  label: string
  value: number
  max: number
  disabled: boolean
  description: string
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <div>
      <SettingLabel label={label}>{description}</SettingLabel>
      <input
        aria-label={label}
        className="mt-2 h-10 w-full rounded-control border border-border bg-surface-raised px-3 text-body text-primary"
        type="number"
        min="1"
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}
