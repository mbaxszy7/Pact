import type {
  AnchoredComment,
  ConversationObservation,
  ConversationPage,
  ConversationPageActivity,
  ConversationPageMessage,
  ConversationPatch,
  ConversationSnapshot,
  NativeAgentContext,
  NativeRebuildOperation,
  AgentRun,
  RuntimeAgentId,
  SessionIssues,
} from '@pact/contracts'

import {
  CONVERSATION_PAGE_ITEMS,
  CONVERSATION_MARKDOWN_BYTES,
  CONVERSATION_WINDOW_MESSAGES,
  CONVERSATION_WORK_LOG_ITEMS,
} from '@pact/contracts'

export interface ActivityBodySource {
  activityId: string
  revision: number
  bodyBytes: number
  preview: string
  previewChars: number
}

export interface ExpandedActivityBody {
  activityId: string
  revision: number
  text: string
  loading: boolean
  error?: string | undefined
}

export type LoadMoreActivityBody = (source: ActivityBodySource) => void

export interface ConversationViewProjection {
  observation: ConversationObservation
  sessionId: string
  session: ConversationSnapshot['session']
  messages: ConversationSnapshot['messages']
  draftComments: AnchoredComment[]
  commentsRevision: number
  activities: ConversationSnapshot['activities']
  runs: ConversationSnapshot['runs']
  nativeContexts: ConversationSnapshot['nativeContexts']
  pendingNativeInteractions?: ConversationSnapshot['pendingNativeInteractions']
  forkOperation?: ConversationSnapshot['forkOperation']
  forkBlocked?: boolean | undefined
  rebuildOperations?: ConversationSnapshot['rebuildOperations']
  rebuildInputRecovery?: ConversationSnapshot['rebuildInputRecovery']
  sessionIssues?: SessionIssues | undefined
}

export interface ConversationWindow {
  view: ConversationViewProjection
  /** Same-incarnation gap floor; an older page cannot certify an unknown body. */
  bodyResyncObservation?: number | undefined
  messageMeta: Record<
    string,
    Pick<ConversationPageMessage, 'hasActivities' | 'hasComments'> & {
      oversized?: Extract<ConversationPageMessage, { kind: 'oversized' }> | undefined
      bodyResync?: true | undefined
      introducedAt?: number | undefined
    }
  >
  activityMeta: Record<string, Extract<ConversationPageActivity, { kind: 'oversized' }>>
  activityBodyResync: Record<string, true>
  sentCommentsByMessage: Record<string, AnchoredComment[]>
  loadedCommentMessageIds: Record<string, true>
  commentError?: string | undefined
  hasOlder: boolean
  hasNewer: boolean
  sourceMessageId?: string | undefined
  latestRun?: ConversationSnapshot['runs'][number] | undefined
  latestCompleteAssistantSequence?: number | undefined
  runArtifacts?: Extract<ConversationPage, { scope: 'messages' }>['runArtifacts'] | undefined
  artifactHistory?:
    | {
        userMessageId: string
        agentId: ConversationSnapshot['runs'][number]['agentId']
        runIds: string[]
        nextBefore?: { createdAt: string; id: string } | undefined
      }
    | undefined
  activityView?:
    | {
        runId: string
        manual?: true | undefined
        truncated: boolean
        observation: ConversationObservation
      }
    | undefined
}

export interface ConversationPatchMerge {
  window: ConversationWindow
  applied: boolean
  resyncMessages: boolean
  resyncActivityRunIds: string[]
}

type MessagePage = Extract<ConversationPage, { scope: 'messages' }>
type ActivityPage = Extract<ConversationPage, { scope: 'activities' }>

const textEncoder = new TextEncoder()

const MAX_ARTIFACT_RUNS = 25
const MAX_ARTIFACT_GROUPS = 50
const MAX_ARTIFACT_BYTES = 1024 * 1024

// A shared projection for the Composer and file-Comment surface; never infer
// native execution from file recording or transport timeout metadata.
export function nativeRecoveryTargets(view: ConversationViewProjection | undefined): Array<{
  sessionId: string
  agentId: RuntimeAgentId
  context?: NativeAgentContext | undefined
  run?: AgentRun | undefined
  rebuildOperation?: NativeRebuildOperation | undefined
}> {
  const targets: ReturnType<typeof nativeRecoveryTargets> = []
  if (!view) return targets
  if (view.sessionIssues) {
    if (view.sessionIssues.inputGate !== 'read_only') return targets
    return view.sessionIssues.agents.map((issue) => ({
      sessionId: view.sessionId,
      agentId: issue.agentId,
      context: view.nativeContexts.find((item) => item.agentId === issue.agentId),
      run: view.runs.find((item) => item.id === issue.runId),
      rebuildOperation: view.rebuildOperations?.find((item) => item.agentId === issue.agentId)
        ?.operation,
    }))
  }
  for (const agentId of ['codex', 'claude'] as const) {
    const context = view?.nativeContexts.find((item) => item.agentId === agentId)
    const rebuildOperation =
      view?.rebuildOperations?.find((item) => item.agentId === agentId)?.operation ??
      context?.rebuildOperation
    const run = (view?.runs ?? [])
      .filter(
        (item) =>
          item.agentId === agentId &&
          item.controlDisposition !== 'abandoned' &&
          (!context?.bindingGeneration || item.bindingGeneration === context.bindingGeneration),
      )
      .toSorted(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )[0]
    if (rebuildOperation && !['completed', 'superseded'].includes(rebuildOperation.stage)) {
      targets.push({ sessionId: view.sessionId, agentId, context, run, rebuildOperation })
    } else if (context) {
      if (
        context.continuationState === 'recovery_required' ||
        context.continuationState === 'rebuilding' ||
        context.continuationState === 'checking' ||
        (run &&
          ['failed', 'interrupted'].includes(run.status) &&
          (context.continuationState === 'responding' ||
            context.continuationState === 'waiting_user'))
      )
        targets.push({ sessionId: view.sessionId, agentId, context, run })
    } else if (
      run &&
      ['failed', 'interrupted'].includes(run.status) &&
      (run.dispatchPhase === 'possibly_sent' || run.dispatchPhase === 'accepted')
    ) {
      targets.push({ sessionId: view.sessionId, agentId, run })
    }
  }
  return targets
}

// Startup inputs need not belong to an established native binding. Cards and their
// in-memory drafts use the same projection; legacy contexts only fill absent fields.
export function nativeInputRequests(view: ConversationViewProjection | undefined) {
  return (
    view?.pendingNativeInteractions ??
    view?.nativeContexts.flatMap((context) =>
      (context.permissionRequests ?? []).map((request) => ({
        agentId: context.agentId,
        bindingGeneration: context.bindingGeneration,
        executorId: context.executorId,
        request,
      })),
    ) ??
    []
  )
}

function artifactRun(run: ConversationSnapshot['runs'][number]): boolean {
  return Boolean(
    (run.workspaceChanges?.fileCount &&
      (run.workspaceChanges.finalizedAt || run.dispatchPhase === 'ended')) ||
    (run.dispatchPhase === 'ended' && run.workspaceRecordingUnavailableReason) ||
    run.controlDisposition === 'abandoned',
  )
}

// Artifact and Message residency share this one window. Eviction never deletes durable history.
function boundRunArtifacts(
  window: ConversationWindow,
  direction: 'older' | 'latest',
): ConversationWindow {
  let messages = [...window.view.messages]
  const allRuns = window.view.runs
  const opened = window.artifactHistory
  const protectedUserId = opened?.userMessageId
  let trimmed = false
  let runs = allRuns
  let groups = window.runArtifacts ?? []
  for (;;) {
    const users = new Set(messages.map((message) => message.replyToMessageId ?? message.id))
    groups = (window.runArtifacts ?? []).filter((group) => users.has(group.userMessageId))
    const retainedIds = new Set([
      ...messages.flatMap((message) => (message.runId ? [message.runId] : [])),
      ...groups.map((group) => group.latestRunId),
      ...(opened?.runIds ?? []),
      ...(window.latestRun ? [window.latestRun.id] : []),
    ])
    runs = allRuns.filter((run) => retainedIds.has(run.id))
    const artifacts = runs.filter(artifactRun)
    if (
      artifacts.length <= MAX_ARTIFACT_RUNS &&
      groups.length <= MAX_ARTIFACT_GROUPS &&
      textEncoder.encode(JSON.stringify({ artifacts, groups, opened })).byteLength <=
        MAX_ARTIFACT_BYTES
    )
      break
    const ordered = direction === 'older' ? messages.toReversed() : messages
    const remove = ordered.find(
      (message) =>
        message.id !== window.sourceMessageId &&
        (message.replyToMessageId ?? message.id) !== protectedUserId &&
        !messages.some(
          (other) =>
            other.id === window.sourceMessageId &&
            (other.replyToMessageId ?? other.id) === (message.replyToMessageId ?? message.id),
        ),
    )
    if (!remove)
      throw new Error(
        'Saved change history exceeds its reading limit. Close earlier records and try again.',
      )
    const userId = remove.replyToMessageId ?? remove.id
    messages = messages.filter((message) => (message.replyToMessageId ?? message.id) !== userId)
    trimmed = true
  }
  const ids = new Set(messages.map((message) => message.id))
  const activityResident = Boolean(
    window.activityView && runs.some((run) => run.id === window.activityView?.runId),
  )
  return {
    ...window,
    view: {
      ...window.view,
      messages,
      runs,
      activities: activityResident ? window.view.activities : [],
    },
    activityView: activityResident ? window.activityView : undefined,
    activityMeta: activityResident ? window.activityMeta : {},
    activityBodyResync: activityResident ? window.activityBodyResync : {},
    runArtifacts: groups,
    artifactHistory:
      opened &&
      groups.some(
        (group) => group.userMessageId === opened.userMessageId && group.agentId === opened.agentId,
      )
        ? opened
        : undefined,
    messageMeta: Object.fromEntries(
      Object.entries(window.messageMeta).filter(([id]) => ids.has(id)),
    ),
    sentCommentsByMessage: Object.fromEntries(
      Object.entries(window.sentCommentsByMessage).filter(([id]) => ids.has(id)),
    ),
    loadedCommentMessageIds: Object.fromEntries(
      Object.entries(window.loadedCommentMessageIds).filter(([id]) => ids.has(id)),
    ),
    hasOlder: window.hasOlder || (trimmed && direction === 'latest'),
    hasNewer: window.hasNewer || (trimmed && direction === 'older'),
  }
}

export function mergeRunArtifactPage(
  current: ConversationWindow,
  page: Extract<ConversationPage, { scope: 'run-artifacts' }>,
): ConversationWindow {
  if (
    current.view.sessionId !== page.sessionId ||
    current.view.observation.incarnation !== page.observation.incarnation
  )
    throw new Error('Saved change history changed. Open it again.')
  const resident = current.view.messages.some(
    (message) => (message.replyToMessageId ?? message.id) === page.userMessageId,
  )
  if (!resident) return current
  const runs = new Map(closeRunArtifacts(current).view.runs.map((run) => [run.id, run]))
  for (const run of page.runs) {
    const existing = current.view.runs.find((item) => item.id === run.id)
    runs.set(run.id, existing && existing.updatedAt > run.updatedAt ? existing : run)
  }
  const groups = (current.runArtifacts ?? []).filter(
    (group) => group.userMessageId !== page.userMessageId || group.agentId !== page.agentId,
  )
  const existingGroup = current.runArtifacts?.find(
    (group) => group.userMessageId === page.userMessageId && group.agentId === page.agentId,
  )
  if (existingGroup && current.view.observation.sequence > page.observation.sequence)
    groups.push({
      ...existingGroup,
      totalCount: Math.max(existingGroup.totalCount, page.totalCount),
    })
  else if (page.latestRunId)
    groups.push({
      userMessageId: page.userMessageId,
      agentId: page.agentId,
      totalCount: page.totalCount,
      latestRunId: page.latestRunId,
    })
  return boundRunArtifacts(
    {
      ...current,
      view: { ...current.view, runs: [...runs.values()] },
      runArtifacts: groups,
      artifactHistory: {
        userMessageId: page.userMessageId,
        agentId: page.agentId,
        runIds: page.runs.map((run) => run.id),
        nextBefore: page.nextBefore,
      },
    },
    'latest',
  )
}

export function closeRunArtifacts(current: ConversationWindow): ConversationWindow {
  const ids = new Set(current.artifactHistory?.runIds ?? [])
  const latestIds = new Set((current.runArtifacts ?? []).map((group) => group.latestRunId))
  const messageIds = new Set(
    current.view.messages.flatMap((message) => (message.runId ? [message.runId] : [])),
  )
  return {
    ...current,
    artifactHistory: undefined,
    view: {
      ...current.view,
      runs: current.view.runs.filter(
        (run) =>
          !ids.has(run.id) ||
          latestIds.has(run.id) ||
          messageIds.has(run.id) ||
          current.latestRun?.id === run.id,
      ),
    },
  }
}

function boundedTextDescriptor(
  text: string,
): { bodyBytes: number; preview: string; previewChars: number } | undefined {
  const bodyBytes = textEncoder.encode(text).byteLength
  if (bodyBytes <= CONVERSATION_MARKDOWN_BYTES) return undefined
  let preview = ''
  let previewChars = 0
  for (const character of text) {
    if (previewChars === 2_048) break
    preview += character
    previewChars += 1
  }
  return { bodyBytes, preview, previewChars }
}

function pageMessage(message: ConversationPageMessage): ConversationSnapshot['messages'][number] {
  return message.kind === 'complete' ? message.message : { ...message.message, content: '' }
}

function pageMeta(page: MessagePage): ConversationWindow['messageMeta'] {
  return Object.fromEntries(
    page.messages.map((item) => [item.message.id, projectPageMessageMeta(item)]),
  )
}

function projectPageMessageMeta(
  item: ConversationPageMessage,
): ConversationWindow['messageMeta'][string] {
  return {
    hasActivities: item.hasActivities,
    hasComments: item.hasComments,
    ...(item.kind === 'oversized' ? { oversized: item } : {}),
  }
}

function uniqueRuns(page: MessagePage): ConversationSnapshot['runs'] {
  const runs = new Map(page.runs.map((run) => [run.id, run]))
  if (page.header.latestRun) runs.set(page.header.latestRun.id, page.header.latestRun)
  return [...runs.values()]
}

// Reply versions remain durable; only one occupies a logical answer slot.
// An exact Comment source wins until navigation leaves that source.
function sameReplySlot(
  left: Pick<ConversationViewProjection['messages'][number], 'replyToMessageId' | 'agentId'>,
  right: Pick<ConversationViewProjection['messages'][number], 'replyToMessageId' | 'agentId'>,
): boolean {
  return Boolean(
    left.replyToMessageId &&
    left.replyToMessageId === right.replyToMessageId &&
    left.agentId &&
    left.agentId === right.agentId,
  )
}

function installReply(
  messages: Map<string, ConversationViewProjection['messages'][number]>,
  message: ConversationViewProjection['messages'][number],
  sourceMessageId?: string,
): boolean {
  if (message.replyToMessageId) {
    for (const [id, existing] of messages) {
      if (id === message.id || !sameReplySlot(existing, message)) continue
      if (id === sourceMessageId) return false
      messages.delete(id)
    }
  }
  messages.set(message.id, message)
  return true
}

export function windowFromPage(page: MessagePage): ConversationWindow {
  return boundRunArtifacts(
    {
      view: {
        observation: page.observation,
        sessionId: page.sessionId,
        session: page.header.session,
        messages: page.messages.map(pageMessage),
        draftComments: [],
        commentsRevision: page.header.commentsRevision,
        activities: [],
        runs: uniqueRuns(page),
        nativeContexts: page.header.nativeContexts ?? [],
        pendingNativeInteractions: page.header.pendingNativeInteractions,
        rebuildOperations: page.header.rebuildOperations ?? [],
        forkOperation: page.header.forkOperation,
        forkBlocked: page.header.forkBlocked,
        rebuildInputRecovery: page.header.rebuildInputRecovery,
        sessionIssues: page.header.sessionIssues,
      },
      messageMeta: pageMeta(page),
      activityMeta: {},
      activityBodyResync: {},
      sentCommentsByMessage: {},
      loadedCommentMessageIds: {},
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      sourceMessageId: page.sourceMessageId,
      latestRun: page.header.latestRun,
      latestCompleteAssistantSequence: page.header.latestCompleteAssistantSequence,
      runArtifacts: page.runArtifacts,
    },
    'latest',
  )
}

export function mergeMessagePage(
  current: ConversationWindow,
  page: MessagePage,
  direction: 'older' | 'around',
): ConversationWindow {
  if (current.view.sessionId !== page.sessionId) return current
  const sameIncarnation = current.view.observation.incarnation === page.observation.incarnation
  if (!sameIncarnation && direction !== 'around') return current
  const keepCurrentValues =
    sameIncarnation && current.view.observation.sequence > page.observation.sequence
  const replacing = direction === 'around'
  const sourceMessageId = replacing ? page.sourceMessageId : current.sourceMessageId
  const currentMessages = new Map(current.view.messages.map((message) => [message.id, message]))
  const messages = new Map(replacing ? [] : currentMessages)
  const meta: ConversationWindow['messageMeta'] = replacing ? {} : { ...current.messageMeta }
  for (const item of page.messages) {
    const currentReply =
      item.message.replyToMessageId &&
      current.view.messages.find((message) => sameReplySlot(message, item.message))
    if (
      keepCurrentValues &&
      currentReply &&
      currentReply.id !== item.message.id &&
      item.message.id !== page.sourceMessageId
    )
      continue
    const id = item.message.id
    const existing = sameIncarnation ? currentMessages.get(id) : undefined
    // Observation fences metadata; body revisions fence text. A later terminal
    // metadata event must not certify a body missed by invalidate/advance.
    const keepBody =
      existing &&
      (existing.contentRevision > item.message.contentRevision ||
        (keepCurrentValues &&
          !current.messageMeta[id]?.bodyResync &&
          existing.contentRevision === item.message.contentRevision))
    const body = keepBody ? existing : pageMessage(item)
    if (
      !installReply(
        messages,
        keepCurrentValues && existing
          ? {
              ...existing,
              content: body.content,
              contentRevision: Math.max(existing.contentRevision, body.contentRevision),
            }
          : body,
        sourceMessageId,
      )
    )
      continue
    meta[id] = keepBody ? current.messageMeta[id]! : projectPageMessageMeta(item)
    if (keepCurrentValues && current.messageMeta[id]) {
      meta[id] = {
        ...meta[id],
        hasActivities: current.messageMeta[id].hasActivities,
        hasComments: current.messageMeta[id].hasComments,
      }
      if (meta[id].oversized)
        meta[id].oversized = { ...meta[id].oversized, message: messages.get(id)! }
      if (
        current.messageMeta[id].bodyResync &&
        page.observation.sequence < (current.bodyResyncObservation ?? 0)
      )
        meta[id].bodyResync = true
    }
  }
  if (replacing && keepCurrentValues) {
    // A late around-page must not erase a partial reply introduced by a Patch
    // after that page was read. Do not carry unrelated old rows to a new anchor.
    for (const [id, message] of currentMessages) {
      if (
        !messages.has(id) &&
        (current.messageMeta[id]?.introducedAt ?? 0) > page.observation.sequence
      ) {
        messages.set(id, message)
        meta[id] = current.messageMeta[id]!
      }
    }
  }
  const ordered = [...messages.values()].toSorted((a, b) => a.sequence - b.sequence)
  const retained =
    ordered.length <= CONVERSATION_WINDOW_MESSAGES
      ? ordered
      : ordered.slice(0, CONVERSATION_WINDOW_MESSAGES)
  const retainedIds = new Set(retained.map((message) => message.id))
  const retainedUsers = new Set(retained.map((message) => message.replyToMessageId ?? message.id))
  const artifactGroups = new Map(
    (sameIncarnation ? (current.runArtifacts ?? []) : []).map((group) => [
      `${group.userMessageId}:${group.agentId}`,
      group,
    ]),
  )
  for (const group of page.runArtifacts ?? []) {
    const key = `${group.userMessageId}:${group.agentId}`
    if (!keepCurrentValues || !artifactGroups.has(key)) artifactGroups.set(key, group)
  }
  const runArtifacts = [...artifactGroups.values()].filter((group) =>
    retainedUsers.has(group.userMessageId),
  )
  const artifactHistory =
    sameIncarnation &&
    current.artifactHistory &&
    retainedUsers.has(current.artifactHistory.userMessageId)
      ? current.artifactHistory
      : undefined
  const runIds = new Set(retained.flatMap((message) => (message.runId ? [message.runId] : [])))
  for (const group of runArtifacts) runIds.add(group.latestRunId)
  for (const id of artifactHistory?.runIds ?? []) runIds.add(id)
  const latestRun = keepCurrentValues
    ? current.latestRun
    : (page.header.latestRun ?? (sameIncarnation ? current.latestRun : undefined))
  if (latestRun) runIds.add(latestRun.id)
  const runs = new Map((replacing ? page.runs : current.view.runs).map((run) => [run.id, run]))
  for (const run of page.runs) {
    if (!keepCurrentValues || !runs.has(run.id)) runs.set(run.id, run)
  }
  if (keepCurrentValues && replacing) {
    for (const run of current.view.runs) if (runIds.has(run.id)) runs.set(run.id, run)
  }
  if (artifactHistory) {
    const ids = new Set(artifactHistory.runIds)
    for (const run of current.view.runs) if (ids.has(run.id)) runs.set(run.id, run)
  }
  if (latestRun) runs.set(latestRun.id, latestRun)
  for (const id of Object.keys(meta)) if (!retainedIds.has(id)) delete meta[id]
  const commentsRevision = keepCurrentValues
    ? current.view.commentsRevision
    : page.header.commentsRevision
  const draftComments =
    sameIncarnation && commentsRevision === current.view.commentsRevision
      ? current.view.draftComments
      : []
  // Message-page replacement is not Work log replacement. Keep the bounded
  // resident steps for retained Runs until their own page arrives, but never
  // carry a projection across a Utility incarnation.
  const activities = sameIncarnation
    ? current.view.activities
        .filter((activity) => runIds.has(activity.runId))
        .map((activity) => {
          if (activity.status !== 'running') return activity
          const run = runs.get(activity.runId)
          if (run?.status === 'completed')
            return Object.assign({}, activity, { status: 'completed' as const })
          if (run?.status === 'failed' || run?.status === 'interrupted')
            return Object.assign({}, activity, { status: 'failed' as const })
          return activity
        })
    : []
  const activitiesById = new Map(activities.map((activity) => [activity.id, activity]))
  const trimmed = ordered.length > retained.length
  return boundRunArtifacts(
    {
      bodyResyncObservation: sameIncarnation ? current.bodyResyncObservation : undefined,
      view: {
        observation: keepCurrentValues ? current.view.observation : page.observation,
        sessionId: page.sessionId,
        session: keepCurrentValues ? current.view.session : page.header.session,
        messages: retained,
        draftComments,
        activities,
        runs: [...runs.values()].filter((run) => runIds.has(run.id)),
        nativeContexts: keepCurrentValues
          ? current.view.nativeContexts
          : (page.header.nativeContexts ?? current.view.nativeContexts),
        pendingNativeInteractions: keepCurrentValues
          ? current.view.pendingNativeInteractions
          : (page.header.pendingNativeInteractions ?? current.view.pendingNativeInteractions),
        forkOperation: keepCurrentValues
          ? current.view.forkOperation
          : (page.header.forkOperation ?? current.view.forkOperation),
        forkBlocked: keepCurrentValues
          ? current.view.forkBlocked
          : (page.header.forkBlocked ?? current.view.forkBlocked),
        rebuildOperations: keepCurrentValues
          ? current.view.rebuildOperations
          : (page.header.rebuildOperations ?? current.view.rebuildOperations),
        rebuildInputRecovery:
          keepCurrentValues || page.header.rebuildInputRecovery === undefined
            ? current.view.rebuildInputRecovery
            : page.header.rebuildInputRecovery,
        sessionIssues: keepCurrentValues
          ? current.view.sessionIssues
          : (page.header.sessionIssues ?? current.view.sessionIssues),
        commentsRevision,
      },
      messageMeta: meta,
      activityMeta: Object.fromEntries(
        Object.entries(current.activityMeta)
          .filter(([id]) => activitiesById.has(id))
          .map(([id, descriptor]) => [
            id,
            {
              ...descriptor,
              activity: { ...descriptor.activity, status: activitiesById.get(id)!.status },
            },
          ]),
      ),
      activityBodyResync: Object.fromEntries(
        Object.entries(current.activityBodyResync).filter(([id]) => activitiesById.has(id)),
      ),
      sentCommentsByMessage: replacing
        ? {}
        : Object.fromEntries(
            Object.entries(current.sentCommentsByMessage).filter(([id]) => retainedIds.has(id)),
          ),
      loadedCommentMessageIds: replacing
        ? {}
        : Object.fromEntries(
            Object.entries(current.loadedCommentMessageIds).filter(([id]) => retainedIds.has(id)),
          ),
      hasOlder: page.hasOlder,
      // An older page reports messages after its own end, including rows already
      // resident here. Only replacement or trimming can move this window's end.
      hasNewer: replacing ? page.hasNewer || trimmed : current.hasNewer || trimmed,
      sourceMessageId:
        sourceMessageId && retainedIds.has(sourceMessageId) ? sourceMessageId : undefined,
      latestRun,
      activityView:
        sameIncarnation && current.activityView && runIds.has(current.activityView.runId)
          ? current.activityView
          : undefined,
      latestCompleteAssistantSequence: keepCurrentValues
        ? current.latestCompleteAssistantSequence
        : page.header.latestCompleteAssistantSequence,
      runArtifacts,
      artifactHistory,
    },
    direction === 'older' ? 'older' : 'latest',
  )
}

export function mergeActivityPage(
  current: ConversationWindow,
  page: ActivityPage,
): ConversationWindow | undefined {
  if (current.view.sessionId !== page.sessionId) return undefined
  if (current.view.observation.incarnation !== page.observation.incarnation) return undefined
  if (!current.view.runs.some((run) => run.id === page.runId)) return undefined
  if (current.activityView && current.activityView.runId !== page.runId) return undefined
  const keepMetadata = current.view.observation.sequence > page.observation.sequence
  const existingActivities = new Map(
    current.view.activities.map((activity) => [activity.id, activity]),
  )
  const activityMeta: ConversationWindow['activityMeta'] = {}
  const activityBodyResync: ConversationWindow['activityBodyResync'] = {}
  const activities = page.activities.map((item) => {
    const existing = existingActivities.get(item.activity.id)
    const keepBody =
      existing &&
      (existing.detailRevision > item.activity.detailRevision ||
        (keepMetadata &&
          !current.activityBodyResync[existing.id] &&
          existing.detailRevision === item.activity.detailRevision))
    const body = keepBody
      ? existing
      : item.kind === 'complete'
        ? item.activity
        : { ...item.activity, detail: item.preview }
    const descriptor = keepBody
      ? current.activityMeta[item.activity.id]
      : item.kind === 'oversized'
        ? item
        : undefined
    const activity =
      keepMetadata && existing
        ? {
            ...existing,
            detail: body.detail,
            detailRevision: Math.max(existing.detailRevision, body.detailRevision),
          }
        : body
    if (descriptor) activityMeta[item.activity.id] = { ...descriptor, activity }
    if (
      (keepBody || page.observation.sequence < (current.bodyResyncObservation ?? 0)) &&
      current.activityBodyResync[item.activity.id]
    )
      activityBodyResync[item.activity.id] = true
    return activity
  })
  if (keepMetadata && current.activityView?.runId === page.runId) {
    const ids = new Set(activities.map((activity) => activity.id))
    for (const activity of current.view.activities) {
      if (ids.has(activity.id)) continue
      activities.push(activity)
      if (current.activityMeta[activity.id])
        activityMeta[activity.id] = current.activityMeta[activity.id]!
      if (current.activityBodyResync[activity.id]) activityBodyResync[activity.id] = true
    }
  }
  const retained = activities
    .toSorted((a, b) => a.sequence - b.sequence)
    .slice(-CONVERSATION_WORK_LOG_ITEMS)
  const retainedIds = new Set(retained.map((activity) => activity.id))
  return {
    ...current,
    view: { ...current.view, activities: retained },
    activityMeta: Object.fromEntries(
      Object.entries(activityMeta).filter(([id]) => retainedIds.has(id)),
    ),
    activityBodyResync: Object.fromEntries(
      Object.entries(activityBodyResync).filter(([id]) => retainedIds.has(id)),
    ),
    activityView: {
      runId: page.runId,
      ...(current.activityView?.runId === page.runId && current.activityView.manual
        ? { manual: true }
        : {}),
      truncated: page.truncated || activities.length > retained.length,
      observation: page.observation,
    },
  }
}

export function mergeSentComments(
  current: ConversationWindow,
  messageIds: string[],
  comments: AnchoredComment[],
): ConversationWindow {
  const residentIds = new Set(current.view.messages.map((message) => message.id))
  const next = { ...current.sentCommentsByMessage }
  const loaded = { ...current.loadedCommentMessageIds }
  for (const messageId of messageIds) {
    if (!residentIds.has(messageId)) continue
    next[messageId] = []
    loaded[messageId] = true
  }
  for (const comment of comments) {
    const messageId = comment.sentWithMessageId
    if (!messageId || !residentIds.has(messageId) || !loaded[messageId]) continue
    next[messageId]!.push(comment)
  }
  // Completed sources stay in SQLite; this is a three-page disposable view.
  const requestedIds = new Set(messageIds)
  const retained = new Set<string>()
  let bytes = 0
  for (const entry of Object.values(next)
    .flat()
    .toSorted(
      (a, b) =>
        Number(requestedIds.has(b.sentWithMessageId ?? '')) -
          Number(requestedIds.has(a.sentWithMessageId ?? '')) || b.position - a.position,
    )) {
    const size = new TextEncoder().encode(JSON.stringify(entry)).byteLength
    if (retained.size >= CONVERSATION_PAGE_ITEMS * 3 || bytes + size > 48 * 1024 * 3) continue
    retained.add(entry.id)
    bytes += size
  }
  for (const [messageId, entries] of Object.entries(next)) {
    next[messageId] = entries.filter((entry) => retained.has(entry.id))
  }
  return { ...current, sentCommentsByMessage: next, loadedCommentMessageIds: loaded }
}

export function withCommentError(
  current: ConversationWindow,
  message: string | undefined,
): ConversationWindow {
  return { ...current, commentError: message }
}

export function mergeConversationPatch(
  current: ConversationWindow,
  incoming: ConversationPatch,
): ConversationPatchMerge {
  if (current.view.sessionId !== incoming.sessionId) {
    return { window: current, applied: false, resyncMessages: false, resyncActivityRunIds: [] }
  }
  const currentObservation = current.view.observation
  if (currentObservation.incarnation !== incoming.observation.incarnation) {
    return {
      window: current,
      applied: false,
      resyncMessages: true,
      resyncActivityRunIds: current.activityView ? [current.activityView.runId] : [],
    }
  }
  if (incoming.observation.sequence <= currentObservation.sequence) {
    return { window: current, applied: false, resyncMessages: false, resyncActivityRunIds: [] }
  }
  const gap = incoming.observation.sequence > currentObservation.sequence + 1
  // The full Run/header facts are independently authoritative at this newer
  // observation. A missing body Patch requires resync, not a stale "Working"
  // state until that read finishes. Never apply a gap's dependent body edits.
  const patch: ConversationPatch = gap
    ? {
        ...incoming,
        messages: incoming.messages
          .filter((change) => current.messageMeta[change.message.id])
          .map((change) => ({
            message: change.message,
            mode: 'invalidate',
            hasActivities: change.hasActivities,
            hasComments: change.hasComments,
          })),
        activities: incoming.activities
          .filter((change) =>
            current.view.activities.some((activity) => activity.id === change.activity.id),
          )
          .map((change) => ({ activity: change.activity, mode: 'invalidate' })),
        removedMessageIds: undefined,
        comments: undefined,
        runs: incoming.runs.filter(
          (run) =>
            run.id === incoming.latestRunId ||
            run.id === current.latestRun?.id ||
            current.view.runs.some((known) => known.id === run.id) ||
            current.view.messages.some(
              (message) =>
                message.id === run.userMessageId || message.replyToMessageId === run.userMessageId,
            ),
        ),
        resync: {
          messages: true,
          drafts: true,
          activityRunIds: current.activityView ? [current.activityView.runId] : [],
        },
      }
    : incoming

  let resyncMessages = Boolean(patch.resync?.messages)
  const resyncActivityRunIds = new Set(patch.resync?.activityRunIds ?? [])
  const messages = new Map(current.view.messages.map((message) => [message.id, message]))
  const messageMeta = { ...current.messageMeta }
  const initialMessageIds = new Set(messages.keys())
  const pinnedSource = current.sourceMessageId ? messages.get(current.sourceMessageId) : undefined
  let deferredAnswer = false
  const invalidReplacements = patch.messages.some((change) => change.mode === 'invalidate')
  for (const id of patch.removedMessageIds ?? []) {
    if (id === current.sourceMessageId || invalidReplacements) continue
    messages.delete(id)
    delete messageMeta[id]
  }
  const invalidateMessage = (change: ConversationPatch['messages'][number]): void => {
    const existing = messages.get(change.message.id)
    if (existing) {
      messages.set(change.message.id, { ...change.message, content: existing.content })
      messageMeta[change.message.id] = {
        ...messageMeta[change.message.id],
        hasActivities: change.hasActivities,
        hasComments: change.hasComments,
        bodyResync: true,
      }
    }
    resyncMessages = true
  }
  if (patch.resync?.messages) {
    for (const id of messages.keys()) messageMeta[id] = { ...messageMeta[id]!, bodyResync: true }
  }
  for (const change of patch.messages) {
    if (
      pinnedSource?.replyToMessageId &&
      sameReplySlot(change.message, pinnedSource) &&
      change.message.id !== pinnedSource.id
    ) {
      deferredAnswer = true
      continue
    }
    const existing = messages.get(change.message.id)
    const oversized = current.messageMeta[change.message.id]?.oversized
    if (change.mode === 'advance') {
      if (
        !existing ||
        existing.contentRevision !== change.previousRevision ||
        !oversized ||
        messageMeta[change.message.id]?.bodyResync
      ) {
        invalidateMessage(change)
        continue
      }
      messages.set(change.message.id, { ...change.message, content: existing.content })
      messageMeta[change.message.id] = {
        hasActivities: change.hasActivities,
        hasComments: change.hasComments,
        oversized: {
          ...oversized,
          message: change.message,
          ...(change.contentBytes ? { contentBytes: change.contentBytes } : {}),
        },
      }
      continue
    }
    if (change.mode === 'invalidate') {
      invalidateMessage(change)
      continue
    }
    if (change.mode === 'append') {
      if (
        !existing ||
        existing.contentRevision !== change.previousRevision ||
        messageMeta[change.message.id]?.bodyResync
      ) {
        invalidateMessage(change)
        continue
      }
      if (oversized) {
        messages.set(change.message.id, { ...change.message, content: existing.content })
        messageMeta[change.message.id] = {
          hasActivities: change.hasActivities,
          hasComments: change.hasComments,
          oversized: {
            ...oversized,
            message: change.message,
            ...(change.contentBytes ? { contentBytes: change.contentBytes } : {}),
          },
        }
        continue
      } else {
        const nextContent = `${existing.content}${change.text ?? ''}`
        messages.set(change.message.id, {
          ...change.message,
          content: nextContent,
        })
        const oversizedText = boundedTextDescriptor(nextContent)
        if (oversizedText) {
          messageMeta[change.message.id] = {
            hasActivities: change.hasActivities,
            hasComments: change.hasComments,
            oversized: {
              kind: 'oversized',
              message: change.message,
              contentBytes: oversizedText.bodyBytes,
              preview: oversizedText.preview,
              previewChars: oversizedText.previewChars,
              hasActivities: change.hasActivities,
              hasComments: change.hasComments,
            },
          }
          messages.set(change.message.id, { ...change.message, content: '' })
          continue
        }
      }
    } else if (change.mode === 'replace') {
      if (!existing && current.hasNewer) continue
      if (
        !installReply(
          messages,
          { ...change.message, content: existing?.content ?? '' },
          current.sourceMessageId,
        )
      ) {
        deferredAnswer = true
        continue
      }
      const replacement = change.text ?? ''
      const oversizedText = boundedTextDescriptor(replacement)
      if (oversizedText) {
        messages.set(change.message.id, { ...change.message, content: '' })
        messageMeta[change.message.id] = {
          hasActivities: change.hasActivities,
          hasComments: change.hasComments,
          oversized: {
            kind: 'oversized',
            message: change.message,
            contentBytes: oversizedText.bodyBytes,
            preview: oversizedText.preview,
            previewChars: oversizedText.previewChars,
            hasActivities: change.hasActivities,
            hasComments: change.hasComments,
          },
        }
      } else {
        messages.set(change.message.id, { ...change.message, content: replacement })
        messageMeta[change.message.id] = {
          hasActivities: change.hasActivities,
          hasComments: change.hasComments,
        }
      }
      continue
    } else if (existing) {
      messages.set(change.message.id, { ...change.message, content: existing.content })
      if (
        messageMeta[change.message.id]?.bodyResync ||
        existing.contentRevision !== change.message.contentRevision
      ) {
        invalidateMessage(change)
        continue
      }
    } else {
      resyncMessages = true
      continue
    }
    messageMeta[change.message.id] = {
      hasActivities: change.hasActivities,
      hasComments: change.hasComments,
      ...(oversized ? { oversized: { ...oversized, message: change.message } } : {}),
    }
  }
  for (const id of messages.keys()) {
    const introducedAt =
      current.messageMeta[id]?.introducedAt ??
      (!initialMessageIds.has(id) ? patch.observation.sequence : undefined)
    if (introducedAt !== undefined && messageMeta[id])
      messageMeta[id] = { ...messageMeta[id], introducedAt }
  }
  const orderedMessages = [...messages.values()].toSorted((a, b) => a.sequence - b.sequence)
  const retainedMessages =
    orderedMessages.length <= CONVERSATION_WINDOW_MESSAGES
      ? orderedMessages
      : orderedMessages.slice(-CONVERSATION_WINDOW_MESSAGES)
  const retainedMessageIds = new Set(retainedMessages.map((message) => message.id))
  for (const id of Object.keys(messageMeta)) {
    if (!retainedMessageIds.has(id)) delete messageMeta[id]
  }

  const runs = new Map(current.view.runs.map((run) => [run.id, run]))
  for (const run of patch.runs) runs.set(run.id, run)
  const artifactGroups = new Map(
    (current.runArtifacts ?? []).map((group) => [`${group.userMessageId}:${group.agentId}`, group]),
  )
  for (const run of patch.runs) {
    if (!artifactRun(run)) continue
    const key = `${run.userMessageId}:${run.agentId}`
    const previous = artifactGroups.get(key)
    const previousRun = previous ? runs.get(previous.latestRunId) : undefined
    if (
      previousRun &&
      (previousRun.createdAt > run.createdAt ||
        (previousRun.createdAt === run.createdAt && previousRun.id > run.id))
    ) {
      // A late historical result changes the fold count, not the latest card.
      // Read authoritative group metadata instead of repeatedly guessing a count.
      if (!current.view.runs.some((known) => known.id === run.id && artifactRun(known)))
        resyncMessages = true
      continue
    }
    artifactGroups.set(key, {
      userMessageId: run.userMessageId,
      agentId: run.agentId,
      latestRunId: run.id,
      totalCount: previous
        ? previous.totalCount +
          (previous.latestRunId !== run.id &&
          !current.view.runs.some((known) => known.id === run.id && artifactRun(known))
            ? 1
            : 0)
        : 1,
    })
  }
  const latestRun = patch.latestRunId
    ? runs.get(patch.latestRunId)
    : current.latestRun
      ? (runs.get(current.latestRun.id) ?? current.latestRun)
      : undefined
  const activeLatestRun =
    latestRun && ['starting', 'running', 'recovering'].includes(latestRun.status)
      ? latestRun
      : undefined
  const activities = new Map(current.view.activities.map((activity) => [activity.id, activity]))
  let activityMeta = { ...current.activityMeta }
  let activityBodyResync = { ...current.activityBodyResync }
  let activityView = current.activityView
  if (activeLatestRun && !activityView?.manual && activityView?.runId !== activeLatestRun.id) {
    activities.clear()
    activityMeta = {}
    activityBodyResync = {}
    activityView = {
      runId: activeLatestRun.id,
      truncated: false,
      observation: patch.observation,
    }
  }
  const invalidateActivity = (change: ConversationPatch['activities'][number]): void => {
    const existing = activities.get(change.activity.id)
    if (existing) {
      activities.set(change.activity.id, { ...change.activity, detail: existing.detail })
      activityBodyResync[change.activity.id] = true
    }
    resyncActivityRunIds.add(change.activity.runId)
  }
  for (const activity of activities.values()) {
    if (patch.resync?.activityRunIds.includes(activity.runId))
      activityBodyResync[activity.id] = true
  }
  for (const change of patch.activities) {
    if (activityView?.runId !== change.activity.runId) continue
    const existing = activities.get(change.activity.id)
    const oversized = activityMeta[change.activity.id]
    if (change.mode === 'advance') {
      if (
        !existing ||
        existing.detailRevision !== change.previousRevision ||
        !oversized ||
        activityBodyResync[change.activity.id]
      ) {
        invalidateActivity(change)
        continue
      }
      activities.set(change.activity.id, { ...change.activity, detail: existing.detail })
      activityMeta[change.activity.id] = {
        ...oversized,
        activity: change.activity,
        ...(change.detailBytes ? { detailBytes: change.detailBytes } : {}),
      }
      continue
    }
    if (change.mode === 'invalidate') {
      invalidateActivity(change)
      continue
    }
    if (change.mode === 'append') {
      if (
        !existing ||
        existing.detailRevision !== change.previousRevision ||
        activityBodyResync[change.activity.id]
      ) {
        invalidateActivity(change)
        continue
      }
      if (oversized) {
        activities.set(change.activity.id, { ...change.activity, detail: existing.detail })
        activityMeta[change.activity.id] = {
          ...oversized,
          activity: change.activity,
          ...(change.detailBytes ? { detailBytes: change.detailBytes } : {}),
        }
        continue
      } else {
        const nextDetail = `${existing.detail ?? ''}${change.detail ?? ''}`
        const oversizedText = boundedTextDescriptor(nextDetail)
        if (oversizedText) {
          activities.set(change.activity.id, { ...change.activity, detail: oversizedText.preview })
          activityMeta[change.activity.id] = {
            kind: 'oversized',
            activity: change.activity,
            detailBytes: oversizedText.bodyBytes,
            preview: oversizedText.preview,
            previewChars: oversizedText.previewChars,
          }
          continue
        }
        activities.set(change.activity.id, { ...change.activity, detail: nextDetail })
      }
    } else if (change.mode === 'replace') {
      delete activityBodyResync[change.activity.id]
      const replacement = change.detail ?? ''
      const oversizedText = boundedTextDescriptor(replacement)
      if (oversizedText) {
        activities.set(change.activity.id, { ...change.activity, detail: oversizedText.preview })
        activityMeta[change.activity.id] = {
          kind: 'oversized',
          activity: change.activity,
          detailBytes: oversizedText.bodyBytes,
          preview: oversizedText.preview,
          previewChars: oversizedText.previewChars,
        }
      } else {
        activities.set(change.activity.id, { ...change.activity, detail: replacement })
        delete activityMeta[change.activity.id]
      }
      continue
    } else if (existing) {
      activities.set(change.activity.id, { ...change.activity, detail: existing.detail })
      if (
        activityBodyResync[change.activity.id] ||
        existing.detailRevision !== change.activity.detailRevision
      ) {
        invalidateActivity(change)
        continue
      }
      if (oversized) activityMeta[change.activity.id] = { ...oversized, activity: change.activity }
    } else {
      resyncActivityRunIds.add(change.activity.runId)
      continue
    }
    if (!oversized) delete activityMeta[change.activity.id]
  }
  for (const state of patch.activityStates) {
    for (const [id, activity] of activities) {
      if (activity.runId === state.runId && activity.status === 'running') {
        activities.set(id, { ...activity, status: state.status })
      }
    }
  }
  const orderedActivities = [...activities.values()].toSorted((a, b) => a.sequence - b.sequence)
  const retainedActivities = orderedActivities.slice(-CONVERSATION_WORK_LOG_ITEMS)
  const retainedActivityIds = new Set(retainedActivities.map((activity) => activity.id))
  activityMeta = Object.fromEntries(
    Object.entries(activityMeta).filter(([id]) => retainedActivityIds.has(id)),
  )
  activityBodyResync = Object.fromEntries(
    Object.entries(activityBodyResync).filter(([id]) => retainedActivityIds.has(id)),
  )
  if (activityView && orderedActivities.length > retainedActivities.length) {
    activityView = { ...activityView, truncated: true, observation: patch.observation }
  }

  let draftComments = current.view.draftComments
  let commentsRevision = current.view.commentsRevision
  const sentCommentsByMessage = { ...current.sentCommentsByMessage }
  const loadedCommentMessageIds = { ...current.loadedCommentMessageIds }
  if (patch.comments) {
    commentsRevision = patch.comments.revision
    const drafts = new Map(draftComments.map((comment) => [comment.id, comment]))
    for (const id of patch.comments.removedIds) drafts.delete(id)
    for (const comment of patch.comments.upserts) {
      if (comment.status === 'draft') drafts.set(comment.id, comment)
      else drafts.delete(comment.id)
    }
    if (patch.comments.sent) {
      const sent = sentCommentsByMessage[patch.comments.sent.messageId] ?? []
      const sentIds = new Set(sent.map((comment) => comment.id))
      let complete = true
      for (const id of patch.comments.sent.commentIds) {
        const draft = drafts.get(id)
        drafts.delete(id)
        if (!draft) {
          complete = false
          continue
        }
        if (!sentIds.has(id)) {
          sent.push({
            ...draft,
            status: 'sent',
            sentWithMessageId: patch.comments.sent.messageId,
          })
        }
      }
      if (retainedMessageIds.has(patch.comments.sent.messageId)) {
        sentCommentsByMessage[patch.comments.sent.messageId] = sent
        if (complete) loadedCommentMessageIds[patch.comments.sent.messageId] = true
        else delete loadedCommentMessageIds[patch.comments.sent.messageId]
        const meta = messageMeta[patch.comments.sent.messageId]
        if (meta) messageMeta[patch.comments.sent.messageId] = { ...meta, hasComments: true }
      }
    }
    for (const comment of patch.comments.upserts) {
      if (!comment.sentWithMessageId || !retainedMessageIds.has(comment.sentWithMessageId)) continue
      const sent = sentCommentsByMessage[comment.sentWithMessageId] ?? []
      sentCommentsByMessage[comment.sentWithMessageId] = [
        ...sent.filter((item) => item.id !== comment.id),
        comment,
      ].toSorted((a, b) => a.position - b.position)
      loadedCommentMessageIds[comment.sentWithMessageId] = true
    }
    let draftBytes = 0
    draftComments = [...drafts.values()]
      .toSorted((a, b) => b.position - a.position)
      .slice(0, CONVERSATION_PAGE_ITEMS * 3)
      .filter((comment) => {
        const size = new TextEncoder().encode(JSON.stringify(comment)).byteLength
        if (draftBytes + size > 48 * 1024 * 3) return false
        draftBytes += size
        return true
      })
      .toReversed()
  }

  const retainedRunIds = new Set(
    retainedMessages.flatMap((message) => (message.runId ? [message.runId] : [])),
  )
  for (const run of patch.runs) retainedRunIds.add(run.id)
  for (const group of artifactGroups.values()) retainedRunIds.add(group.latestRunId)
  for (const id of current.artifactHistory?.runIds ?? []) retainedRunIds.add(id)
  if (latestRun) retainedRunIds.add(latestRun.id)
  const next: ConversationWindow = {
    ...current,
    bodyResyncObservation: gap ? patch.observation.sequence : current.bodyResyncObservation,
    view: {
      observation: patch.observation,
      sessionId: patch.sessionId,
      session: patch.session,
      messages: retainedMessages,
      draftComments,
      commentsRevision,
      activities: retainedActivities,
      runs: [...runs.values()].filter((run) => retainedRunIds.has(run.id)),
      nativeContexts: patch.nativeContexts ?? current.view.nativeContexts,
      pendingNativeInteractions:
        patch.pendingNativeInteractions ?? current.view.pendingNativeInteractions,
      rebuildOperations: patch.rebuildOperations ?? current.view.rebuildOperations,
      forkOperation: patch.forkOperation ?? current.view.forkOperation,
      forkBlocked: patch.forkBlocked ?? current.view.forkBlocked,
      rebuildInputRecovery:
        patch.rebuildInputRecovery === undefined
          ? current.view.rebuildInputRecovery
          : patch.rebuildInputRecovery,
      sessionIssues: patch.sessionIssues ?? current.view.sessionIssues,
    },
    messageMeta,
    activityMeta,
    activityBodyResync,
    activityView,
    sentCommentsByMessage: Object.fromEntries(
      Object.entries(sentCommentsByMessage).filter(([id]) => retainedMessageIds.has(id)),
    ),
    loadedCommentMessageIds: Object.fromEntries(
      Object.entries(loadedCommentMessageIds).filter(([id]) => retainedMessageIds.has(id)),
    ),
    hasOlder: current.hasOlder || orderedMessages.length > retainedMessages.length,
    hasNewer: current.hasNewer || deferredAnswer,
    latestRun,
    runArtifacts: [...artifactGroups.values()],
    latestCompleteAssistantSequence:
      retainedMessages.findLast(
        (message) => message.role === 'assistant' && message.state === 'complete',
      )?.sequence ?? current.latestCompleteAssistantSequence,
  }
  return {
    window: boundRunArtifacts(next, 'latest'),
    applied: true,
    resyncMessages,
    resyncActivityRunIds: [...resyncActivityRunIds],
  }
}
