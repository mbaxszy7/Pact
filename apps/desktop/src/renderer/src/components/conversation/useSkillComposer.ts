import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'

import {
  agentDisplayName,
  PACT_COMPOSER_SKILLS,
  parseComposerCommandPrefix,
  resolveActiveAgentPair,
  type NativeSkill,
  type PactComposerSkill,
  type RuntimeAgentId,
  type SkillSelection,
  type SkillCatalogPage,
  type CollaborationSession,
} from '@pact/contracts'

import {
  extractBtwSideChatDraft,
  resolveComposerRoute,
  type ComposerDocument,
} from './composer-document'

export type PactSkillOption = {
  id: string
  agentId: 'pact'
  name: PactComposerSkill
  description: string
}
export type ComposerSkillOption = NativeSkill | PactSkillOption
type Agent = RuntimeAgentId
interface Query {
  sessionId: string
  start: number
  end: number
  text: string
}
export interface ComposerEdit {
  start: number
  end: number
  text: string
}
type Page = SkillCatalogPage & { startOffset: number }
const encoder = new TextEncoder()
const agentName = (id: RuntimeAgentId): string => agentDisplayName(id)
const queryAt = (
  sessionId: string,
  value: string,
  cursor: number,
  selections: SkillSelection[],
): Query | undefined => {
  const match = /(?:^|\s)\/([\p{L}\p{N}_.:-]*)$/u.exec(value.slice(0, cursor))
  if (!match) return undefined
  const start = cursor - match[1]!.length - 1
  if (selections.some((entry) => entry.start < cursor && entry.end > start)) return undefined
  return { sessionId, start, end: cursor, text: match[1]! }
}
const windowPage = (
  page: SkillCatalogPage,
  rows: NativeSkill[],
  startOffset: number,
  backward: boolean,
): Page => {
  const costs = rows.map((row) => encoder.encode(JSON.stringify(row)).byteLength + 1)
  let bytes = costs.reduce((sum, cost) => sum + cost, 2),
    first = 0,
    end = rows.length
  while (end - first > 100 || bytes > 128 * 1_024 - 2_048) {
    if (backward) bytes -= costs[--end]!
    else bytes -= costs[first++]!
  }
  const start = startOffset + first
  return {
    ...page,
    skills: rows.slice(first, end),
    startOffset: start,
    nextOffset: start + end - first < page.total ? start + end - first : null,
  }
}

/** One Composer owns bounded directory pages, request fences and selection edits. */
export function useSkillComposer(input: {
  session: CollaborationSession
  text: string
  selections: SkillSelection[]
  route?: ComposerDocument['route']
  mention?: ComposerDocument['mention']
  returnedInputOperationId?: ComposerDocument['returnedInputOperationId']
  mainTargetAgentId?: RuntimeAgentId | undefined
  disabled: boolean
}) {
  const isSideChat = Boolean(input.session.parentSessionId)
  const [queryState, setQuery] = useState<Query>()
  const dismissedQuery = useRef<Query | undefined>(undefined)
  const query = queryState?.sessionId === input.session.id ? queryState : undefined
  const [pages, setPages] = useState<Partial<Record<Agent, Page>>>({})
  const [errors, setErrors] = useState<Partial<Record<Agent, string>>>({})
  const [menuReady, setMenuReady] = useState('')
  const [menuOwner, setMenuOwner] = useState('')
  const [pagingOwner, setPagingOwner] = useState('')
  const [active, setActiveIndex] = useState(0)
  const [revealActive, setRevealActive] = useState(true)
  const [optionStarts, setOptionStarts] = useState<Partial<Record<Agent, number>>>({})
  const [validation, setValidation] = useState<{ key: string; warning?: string }>({ key: '' })
  const request = useRef(0)
  const prefix = useMemo(
    () => parseComposerCommandPrefix(input.text, input.selections),
    [input.text, input.selections],
  )
  const [activePrimary, activeSecondary] = resolveActiveAgentPair(input.session.settings)
  const activePair: readonly [Agent, Agent] = [activePrimary, activeSecondary]
  const { route, targets } = resolveComposerRoute(
    { ...input, skills: input.selections },
    activePrimary,
    { allowMainRoute: isSideChat, secondaryAgentId: activeSecondary },
  )
  const btwHandoffActive = !isSideChat && Boolean(prefix.btw && !prefix.error)
  const btwDraft = useMemo(
    () =>
      btwHandoffActive
        ? extractBtwSideChatDraft({
            text: input.text,
            skills: input.selections,
            route: input.route,
            mention: input.mention,
            returnedInputOperationId: input.returnedInputOperationId,
          })
        : undefined,
    [
      btwHandoffActive,
      input.text,
      input.selections,
      input.route,
      input.mention,
      input.returnedInputOperationId,
    ],
  )
  const btwTargets = btwDraft
    ? resolveComposerRoute(
        {
          text: btwDraft.text,
          skills: btwDraft.skills,
          route: btwDraft.route,
          mention: btwDraft.mention,
        },
        activePrimary,
        { allowMainRoute: false, secondaryAgentId: activeSecondary },
      ).targets
    : undefined
  const effectiveTargets: Agent[] =
    route.type === 'main' ? [input.mainTargetAgentId ?? activePair[0]] : (btwTargets ?? targets)
  const names = [
    ...new Set([
      ...prefix.skills.map((entry) => entry.name),
      ...input.selections.map((entry) => entry.name),
    ]),
  ]
  const key = JSON.stringify([
    input.session.id,
    input.session.settingsRevision,
    route,
    effectiveTargets,
    names,
    input.selections.map((entry) => [entry.id, entry.agentId]),
  ])
  const open = Boolean(query)
  const menuDelay = query?.text ? 80 : 0
  const menuIdentity = JSON.stringify([input.session.id, input.session.settingsRevision])
  const menuKey = JSON.stringify([menuIdentity, query?.text])
  const paging = pagingOwner === menuKey
  const preferredFirst = effectiveTargets[0] ?? activePair[0]
  const agents: Agent[] =
    preferredFirst === activePair[0]
      ? [activePair[0], activePair[1]]
      : activePair.includes(preferredFirst)
        ? [activePair[1], activePair[0]]
        : [preferredFirst, activePair[0], activePair[1]]
  const settled = menuReady === menuKey
  // Retain one bounded window while its replacement arrives; never blank it per keystroke.
  const currentPages = menuOwner === menuIdentity ? pages : {}
  const search = (query?.text ?? '').toLocaleLowerCase()
  const visiblePages: Partial<Record<Agent, Page>> = {}
  for (const agent of agents) {
    const page = currentPages[agent]
    if (page) {
      visiblePages[agent] = {
        ...page,
        skills: page.skills.filter((entry) =>
          `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(search),
        ),
      }
    }
  }
  const editingBtwToken = Boolean(
    query && prefix.btw && query.start === prefix.btw.start && query.end === prefix.btw.end,
  )
  const pactOptions: PactSkillOption[] = isSideChat
    ? []
    : PACT_COMPOSER_SKILLS.filter(
        (name) =>
          Boolean(
            query && query.start <= prefix.argumentsStart && (!prefix.btw || editingBtwToken),
          ) && name.includes(search),
      ).map((name) => ({
        id: `pact-${name}`,
        agentId: 'pact',
        name,
        description:
          name === 'plan'
            ? 'Clarify, plan and collaborate'
            : name === 'build'
              ? 'Implement code and collaborate on Review'
              : name === 'review'
                ? 'Review code and handle feedback'
                : 'Ask a side question in a new side chat',
      }))
  const VISIBLE_SKILLS_PER_AGENT = pactOptions.length ? 18 : 20
  const options: ComposerSkillOption[] = [
    ...pactOptions,
    ...agents.flatMap((agent) => visiblePages[agent]?.skills ?? []),
  ]
  const visibleOptions = agents.flatMap((agent) => {
    const start = optionStarts[agent] ?? 0
    return visiblePages[agent]?.skills.slice(start, start + VISIBLE_SKILLS_PER_AGENT) ?? []
  })
  const beforeAgent = (agent: Agent): number => {
    let offset = pactOptions.length
    for (const item of agents) {
      if (item === agent) break
      offset += visiblePages[item]?.skills.length ?? 0
    }
    return offset
  }
  const showOptions = (agent: Agent, start: number, activeOffset = 0): void => {
    setRevealActive(true)
    setOptionStarts((current) => ({ ...current, [agent]: start }))
    setActiveIndex(beforeAgent(agent) + start + activeOffset)
  }
  const setActive = (index: number, reveal = true): void => {
    const next = Math.max(0, Math.min(options.length - 1, index))
    const entry = options[next]
    setRevealActive(reveal)
    setActiveIndex(next)
    if (!entry || entry.agentId === 'pact') return
    const local = next - beforeAgent(entry.agentId)
    const start = optionStarts[entry.agentId] ?? 0
    if (local < start || local >= start + VISIBLE_SKILLS_PER_AGENT)
      setOptionStarts((current) => ({
        ...current,
        [entry.agentId]: local < start ? local : local - VISIBLE_SKILLS_PER_AGENT + 1,
      }))
  }
  const canMore = (agent: Agent): boolean => {
    const page = currentPages[agent]
    return (
      settled &&
      Boolean(
        page &&
        ((optionStarts[agent] ?? 0) + VISIBLE_SKILLS_PER_AGENT < page.skills.length ||
          page.nextOffset !== null),
      )
    )
  }
  const canPrevious = (agent: Agent): boolean =>
    settled && ((optionStarts[agent] ?? 0) > 0 || (currentPages[agent]?.startOffset ?? 0) > 0)
  const rangeLabel = (agent: Agent): string => {
    const page = currentPages[agent]
    if (!page) return ''
    const start = optionStarts[agent] ?? 0
    return `${page.startOffset + start + 1}–${page.startOffset + Math.min(start + VISIBLE_SKILLS_PER_AGENT, page.skills.length)} of ${page.total}`
  }
  const targetLabel = (target: Agent): string =>
    route.type === 'main'
      ? `the main chat target (${agentName(target)})`
      : route.type === 'primary'
        ? `your primary Agent (${agentName(target)})`
        : route.type === 'agent'
          ? `your selected Agent @${target} (${agentName(target)})`
          : `${agentName(target)} in @all`
  const inactiveTarget =
    !input.returnedInputOperationId && route.type !== 'main'
      ? effectiveTargets.find((target) => !activePair.includes(target))
      : undefined
  const inactiveTargetWarning = inactiveTarget
    ? `@${inactiveTarget} (${agentName(inactiveTarget)}) is not active in this ${isSideChat ? 'side chat' : 'session'}.`
    : undefined
  const wrong = btwHandoffActive
    ? undefined
    : input.selections.find((entry) => !effectiveTargets.includes(entry.agentId))
  const sourceWarning = wrong
    ? `/${wrong.name} belongs to ${agentName(wrong.agentId)}. It does not match ${targetLabel(effectiveTargets[0]!)}.`
    : undefined
  const sideChatCommandError =
    isSideChat && (prefix.pact || prefix.btw)
      ? 'Pact commands (/plan, /build, /review, /btw) can only be used in the main chat.'
      : undefined

  const loadMenu = useEffectEvent(async (expectedKey: string, alive: () => boolean) => {
    const directory: Partial<Record<Agent, Page>> = {},
      failures: Partial<Record<Agent, string>> = {}
    await Promise.all(
      agents.map(async (agent) => {
        const result = await window.pact.readSkillCatalog({
          sessionId: input.session.id,
          agentId: agent,
          query: query?.text ?? '',
          offset: 0,
          refresh: false,
        })
        if (result.ok) directory[agent] = windowPage(result.value, result.value.skills, 0, false)
        else failures[agent] = result.error.message
      }),
    ).catch(() => {
      for (const agent of agents) {
        failures[agent] = 'Skills could not be loaded.'
      }
    })
    if (alive()) {
      setPagingOwner('')
      setPages(directory)
      setErrors(failures)
      setActiveIndex(0)
      setRevealActive(true)
      setOptionStarts({})
      setMenuOwner(menuIdentity)
      setMenuReady(expectedKey)
    }
  })
  useEffect(() => {
    if (!open || input.disabled) return () => undefined
    const revision = ++request.current
    let closed = false
    // One replaceable timer per Composer coalesces fast typing; close/session change cancels it.
    const timer = window.setTimeout(() => {
      if (!closed) void loadMenu(menuKey, () => !closed && revision === request.current)
    }, menuDelay)
    return () => {
      closed = true
      window.clearTimeout(timer)
    }
  }, [menuKey, input.disabled, open, menuDelay])
  useEffect(() => {
    const sessionId = input.session.id
    return () => {
      void window.pact.cancelSkillCatalog(sessionId).catch(() => undefined)
    }
  }, [input.session.id])

  const verify = useEffectEvent(async (expectedKey: string, alive: () => boolean) => {
    if (
      !names.length ||
      btwHandoffActive ||
      inactiveTargetWarning ||
      sourceWarning ||
      sideChatCommandError
    )
      return
    const deadline = Date.now() + 10_000
    try {
      for (const target of effectiveTargets) {
        const found = new Map<string, string>()
        let offset = 0,
          generation: string | undefined
        for (let page = 0; page < 83; page++) {
          if (Date.now() >= deadline)
            throw new Error('Couldn’t finish checking skills in time. Try again.')
          // oxlint-disable-next-line no-await-in-loop -- One bounded, generation-fenced ordered page reader.
          const result = await window.pact.readSkillCatalog({
            sessionId: input.session.id,
            agentId: target,
            names,
            query: '',
            offset,
            refresh: false,
            ...(generation ? { generation } : {}),
          })
          if (!alive()) return
          if (!result.ok) {
            setValidation({ key: expectedKey, warning: result.error.message })
            return
          }
          generation = result.value.generation
          for (const entry of result.value.skills) found.set(entry.name, entry.id)
          if (result.value.nextOffset === null) break
          offset = result.value.nextOffset
        }
        const missing = names.find((name) => !found.has(name))
        if (missing) {
          setValidation({
            key: expectedKey,
            warning: `/${missing} is unavailable for ${targetLabel(target)}.`,
          })
          return
        }
        const changed = input.selections.find(
          (entry) => entry.agentId === target && found.get(entry.name) !== entry.id,
        )
        if (changed) {
          setValidation({
            key: expectedKey,
            warning: `/${changed.name} changed in ${targetLabel(target)}. Select it again.`,
          })
          return
        }
      }
      if (alive()) setValidation({ key: expectedKey })
    } catch {
      if (alive())
        setValidation({
          key: expectedKey,
          warning: 'The selected Skills could not be verified. Open / to try again.',
        })
    }
  })
  useEffect(() => {
    let closed = false
    const timer = window.setTimeout(
      () => {
        if (!closed) void verify(key, () => !closed)
      },
      open ? 80 : 0,
    )
    return () => {
      closed = true
      window.clearTimeout(timer)
    }
  }, [key, open])

  const update = (value: string, cursor: number, selections: SkillSelection[]): void => {
    const next = queryAt(input.session.id, value, cursor, selections)
    const dismissed = dismissedQuery.current
    if (
      next &&
      dismissed &&
      next.sessionId === dismissed.sessionId &&
      next.start === dismissed.start &&
      next.end === dismissed.end &&
      next.text === dismissed.text
    )
      return
    dismissedQuery.current = undefined
    setQuery(next)
    setActiveIndex(0)
    setRevealActive(true)
    setOptionStarts({})
  }
  const choose = (
    entry: ComposerSkillOption,
  ): { start: number; end: number; text: string; skill?: SkillSelection } | undefined => {
    if (!query) return undefined
    const token = `/${entry.name}`
    if (entry.agentId === 'pact') {
      const replacement = { start: query.start, end: query.end, text: `${token} ` }
      setQuery(undefined)
      return replacement
    }
    const replacement = {
      start: query.start,
      end: query.end,
      text: `${token} `,
      skill: {
        id: entry.id,
        agentId: entry.agentId,
        name: entry.name,
        start: query.start,
        end: query.start + token.length,
      },
    }
    setQuery(undefined)
    return replacement
  }
  const more = async (preferred?: Agent, backward = false): Promise<void> => {
    const agent = preferred ?? agents.find((item) => currentPages[item]?.nextOffset != null)
    if (!agent || !query || paging || !settled) return
    const previous = currentPages[agent]
    if (!previous) return
    const start = optionStarts[agent] ?? 0
    if (backward && start > 0) {
      showOptions(agent, Math.max(0, start - VISIBLE_SKILLS_PER_AGENT))
      return
    }
    if (!backward && start + VISIBLE_SKILLS_PER_AGENT < previous.skills.length) {
      showOptions(agent, start + VISIBLE_SKILLS_PER_AGENT)
      return
    }
    if (backward ? previous.startOffset === 0 : previous.nextOffset === null) return
    const offset = backward ? Math.max(0, previous.startOffset - 50) : previous.nextOffset!
    const revision = request.current
    setPagingOwner(menuKey)
    try {
      const result = await window.pact.readSkillCatalog({
        sessionId: input.session.id,
        agentId: agent,
        query: query.text,
        offset,
        generation: previous.generation,
        refresh: false,
      })
      if (revision !== request.current) return
      if (result.ok) {
        // A backward read can overlap the retained window after eviction; keep only earlier rows.
        const incoming = backward
          ? result.value.skills.slice(0, Math.max(0, previous.startOffset - offset))
          : result.value.skills
        const adjacent = !backward || offset + incoming.length === previous.startOffset
        const combined = backward
          ? adjacent
            ? [...incoming, ...previous.skills]
            : incoming
          : [...previous.skills, ...incoming]
        const next = windowPage(
          result.value,
          combined,
          backward ? offset : previous.startOffset,
          backward,
        )
        setPages((current) => ({ ...current, [agent]: next }))
        const first = backward
          ? Math.max(0, incoming.length - VISIBLE_SKILLS_PER_AGENT)
          : Math.max(0, previous.startOffset + previous.skills.length - next.startOffset)
        showOptions(
          agent,
          first,
          backward ? Math.max(0, Math.min(VISIBLE_SKILLS_PER_AGENT, incoming.length) - 1) : 0,
        )
      } else setErrors((current) => ({ ...current, [agent]: result.error.message }))
    } catch {
      if (revision === request.current)
        setErrors((current) => ({
          ...current,
          [agent]: 'More Skills could not be loaded. Try again.',
        }))
    } finally {
      if (revision === request.current) setPagingOwner('')
    }
  }
  return {
    query,
    options,
    pactOptions,
    visibleOptions,
    agents,
    pages: visiblePages,
    errors: settled ? errors : {},
    loading: Boolean(query && !settled) || paging,
    active,
    revealActive,
    setActive,
    update,
    choose,
    more,
    canMore,
    canPrevious,
    rangeLabel,
    close: () => {
      dismissedQuery.current = query
      setQuery(undefined)
      void window.pact.cancelSkillCatalog(input.session.id).catch(() => undefined)
    },
    warning:
      prefix.error ??
      sideChatCommandError ??
      inactiveTargetWarning ??
      sourceWarning ??
      (validation.key === key ? validation.warning : undefined),
    checking:
      !btwHandoffActive &&
      names.length > 0 &&
      !inactiveTargetWarning &&
      !sourceWarning &&
      !sideChatCommandError &&
      validation.key !== key,
    hasMore: settled && agents.some((agent) => currentPages[agent]?.nextOffset != null),
  }
}
