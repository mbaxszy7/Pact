import { Bot, CornerUpLeft, Users } from 'lucide-react'

import type {
  AgentRun,
  AnchoredComment,
  CollaborationSession,
  CollaborationTask,
  CommentAnchor,
  ConversationPage,
  RuntimeAgentId,
  SkillSelection,
} from '@pact/contracts'

import { agentDisplayName, isCollaborationOpenMode } from '@pact/contracts'

import type { DraftImage } from './image-client'
import type { ConversationComposerMention } from './useConversation'
import type { WorkspaceChangesList } from './WorkspaceChangesCard'

export const EMPTY_SKILLS: SkillSelection[] = []
export const EMPTY_IMAGES: readonly DraftImage[] = []
export const EMPTY_COMMENTS: AnchoredComment[] = []
export const ignoreSkillChanges = (_value: SkillSelection[]): void => undefined

export const TRANSCRIPT_OVERSCAN = 4
export const CONVERSATION_WIDTH = 'w-full max-w-[clamp(44rem,82cqw,52rem)]'
export const OLDER_HISTORY_SCROLL_THRESHOLD = 160
export const WORKSPACE_FILES_LRU_LIMIT = 8
export const MAX_CONCURRENT_WORKSPACE_FILE_LOADS = 2
export const MAX_WORKSPACE_FILE_LOAD_WAITERS = 12

export interface WorkspaceFileLoadIntent {
  expand: boolean
  open: boolean
  contextGeneration?: number | undefined
  targetRevision: number
}

export function coalesceWorkspaceLoadIntent(
  previous: WorkspaceFileLoadIntent | undefined,
  next: WorkspaceFileLoadIntent,
  options?: { autoRefresh?: boolean | undefined },
): WorkspaceFileLoadIntent {
  if (!previous) return next
  const open = previous.open || next.open
  const contextGeneration =
    options?.autoRefresh && previous.open
      ? previous.contextGeneration
      : next.open
        ? next.contextGeneration
        : previous.open
          ? previous.contextGeneration
          : undefined
  return {
    expand: previous.expand || next.expand,
    open,
    contextGeneration,
    targetRevision: Math.max(previous.targetRevision, next.targetRevision),
  }
}

export interface WorkspaceFileLoadWaiterInput {
  ownerId: symbol
  changeSetId: string
  priority: boolean
  timeoutMs: number
  shouldDispatch: () => boolean
  onGrant: () => void
  onReject: (reason: 'queue_full' | 'timeout') => void
}

interface WorkspaceFileLoadWaiterEntry extends WorkspaceFileLoadWaiterInput {
  deadlineTimer: number | undefined
}

interface WorkspaceFileLoadCoordinator {
  physicalInFlight: number
  waitQueue: WorkspaceFileLoadWaiterEntry[]
}

const workspaceLoadCoordinators = new WeakMap<object, WorkspaceFileLoadCoordinator>()
const fallbackWorkspaceLoadCoordinator: WorkspaceFileLoadCoordinator = {
  physicalInFlight: 0,
  waitQueue: [],
}

function getWorkspaceLoadCoordinator(): WorkspaceFileLoadCoordinator {
  const key = typeof window !== 'undefined' ? window.pact : undefined
  if (!key || typeof key !== 'object') return fallbackWorkspaceLoadCoordinator
  let coordinator = workspaceLoadCoordinators.get(key)
  if (!coordinator) {
    coordinator = { physicalInFlight: 0, waitQueue: [] }
    workspaceLoadCoordinators.set(key, coordinator)
  }
  return coordinator
}

function drainWorkspaceFileLoadWaiters(coordinator: WorkspaceFileLoadCoordinator): void {
  while (
    coordinator.physicalInFlight < MAX_CONCURRENT_WORKSPACE_FILE_LOADS &&
    coordinator.waitQueue.length > 0
  ) {
    let index = coordinator.waitQueue.findIndex((entry) => entry.priority)
    if (index === -1) index = 0
    const [waiter] = coordinator.waitQueue.splice(index, 1)
    if (!waiter) break
    if (waiter.deadlineTimer !== undefined) {
      window.clearTimeout(waiter.deadlineTimer)
      waiter.deadlineTimer = undefined
    }
    if (!waiter.shouldDispatch()) continue
    waiter.onGrant()
  }
}

export function tryAcquireWorkspaceFileLoadSlot(): (() => void) | undefined {
  const coordinator = getWorkspaceLoadCoordinator()
  if (coordinator.physicalInFlight >= MAX_CONCURRENT_WORKSPACE_FILE_LOADS) return undefined
  coordinator.physicalInFlight += 1
  let released = false
  return () => {
    if (released) return
    released = true
    coordinator.physicalInFlight = Math.max(0, coordinator.physicalInFlight - 1)
    drainWorkspaceFileLoadWaiters(coordinator)
  }
}

export function enqueueWorkspaceFileLoadWaiter(
  input: WorkspaceFileLoadWaiterInput,
): 'queued' | 'updated' | 'queue_full' {
  const coordinator = getWorkspaceLoadCoordinator()
  const existing = coordinator.waitQueue.find(
    (entry) => entry.ownerId === input.ownerId && entry.changeSetId === input.changeSetId,
  )
  if (existing) {
    existing.priority = existing.priority || input.priority
    existing.shouldDispatch = input.shouldDispatch
    existing.onGrant = input.onGrant
    existing.onReject = input.onReject
    return 'updated'
  }
  for (let i = coordinator.waitQueue.length - 1; i >= 0; i -= 1) {
    const entry = coordinator.waitQueue[i]
    if (entry && !entry.shouldDispatch()) {
      if (entry.deadlineTimer !== undefined) {
        window.clearTimeout(entry.deadlineTimer)
        entry.deadlineTimer = undefined
      }
      coordinator.waitQueue.splice(i, 1)
    }
  }
  if (coordinator.waitQueue.length >= MAX_WORKSPACE_FILE_LOAD_WAITERS) {
    if (input.priority) {
      const victimIndex = coordinator.waitQueue.findIndex((entry) => !entry.priority)
      if (victimIndex >= 0) {
        const [victim] = coordinator.waitQueue.splice(victimIndex, 1)
        if (victim) {
          if (victim.deadlineTimer !== undefined) {
            window.clearTimeout(victim.deadlineTimer)
            victim.deadlineTimer = undefined
          }
          victim.onReject('queue_full')
        }
      } else {
        input.onReject('queue_full')
        return 'queue_full'
      }
    } else {
      input.onReject('queue_full')
      return 'queue_full'
    }
  }
  const entry: WorkspaceFileLoadWaiterEntry = {
    ...input,
    deadlineTimer: undefined,
  }
  entry.deadlineTimer = window.setTimeout(() => {
    entry.deadlineTimer = undefined
    const index = coordinator.waitQueue.indexOf(entry)
    if (index === -1) return
    coordinator.waitQueue.splice(index, 1)
    entry.onReject('timeout')
  }, input.timeoutMs)
  coordinator.waitQueue.push(entry)
  return 'queued'
}

export function promoteWorkspaceFileLoadWaiter(ownerId: symbol, changeSetId: string): void {
  const coordinator = getWorkspaceLoadCoordinator()
  const existing = coordinator.waitQueue.find(
    (entry) => entry.ownerId === ownerId && entry.changeSetId === changeSetId,
  )
  if (existing) {
    existing.priority = true
  }
}

export function cancelWorkspaceFileLoadWaiters(ownerId: symbol): void {
  const coordinator = getWorkspaceLoadCoordinator()
  for (let i = coordinator.waitQueue.length - 1; i >= 0; i -= 1) {
    const entry = coordinator.waitQueue[i]
    if (entry && entry.ownerId === ownerId) {
      if (entry.deadlineTimer !== undefined) {
        window.clearTimeout(entry.deadlineTimer)
        entry.deadlineTimer = undefined
      }
      coordinator.waitQueue.splice(i, 1)
    }
  }
}

export const messageTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export const messageDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export const agentName = (id: RuntimeAgentId): string => agentDisplayName(id)

export const speakerCrestClasses = (id: RuntimeAgentId | undefined): string =>
  id === 'claude'
    ? 'bg-speaker-claude text-speaker-claude-foreground'
    : id === 'agy'
      ? 'bg-speaker-agy text-speaker-agy-foreground'
      : 'bg-speaker-codex text-speaker-codex-foreground'

export const speakerLineClass = (id: RuntimeAgentId | undefined): string =>
  id === 'claude'
    ? 'border-speaker-claude-line'
    : id === 'agy'
      ? 'border-speaker-agy-line'
      : 'border-speaker-codex-line'

export const speakerForegroundClass = (id: RuntimeAgentId | undefined): string =>
  id === 'claude'
    ? 'text-speaker-claude-foreground'
    : id === 'agy'
      ? 'text-speaker-agy-foreground'
      : 'text-speaker-codex-foreground'

export function commentSourceLabel(
  anchor: CommentAnchor,
  currentSession?: Pick<CollaborationSession, 'id' | 'parentSessionId'>,
): string {
  return anchor.type === 'unavailable'
    ? 'Source unavailable'
    : anchor.type === 'file'
      ? anchor.path
      : anchor.type === 'cutoff_message'
        ? (currentSession?.parentSessionId &&
            anchor.sourceSessionId === currentSession.parentSessionId) ||
          anchor.sourceSessionId === currentSession?.id
          ? 'Main chat'
          : 'Side chat'
        : anchor.plan
          ? `Plan v${anchor.plan.version}`
          : anchor.report
            ? 'Review'
            : 'Message'
}

export function hasVisibleChanges(run: AgentRun | undefined): boolean {
  return Boolean(
    run?.workspaceChanges &&
    run.workspaceChanges.fileCount > 0 &&
    (run.workspaceChanges.finalizedAt || run.dispatchPhase === 'ended'),
  )
}

export function hasRecordingWarning(run: AgentRun | undefined): boolean {
  return Boolean(run?.dispatchPhase === 'ended' && run.workspaceRecordingUnavailableReason)
}

export function handoffSourceLabel(run: AgentRun): string | undefined {
  const peerIds = [...new Set(run.handoffSourceAgents ?? [])]
  if (peerIds.length === 1) return agentName(peerIds[0]!)
  if (peerIds.length === 2) return `${agentName(peerIds[0]!)} and ${agentName(peerIds[1]!)}`
  if (peerIds.length > 2) {
    const names = peerIds.map((id) => agentName(id))
    return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)!}`
  }
  return undefined
}

export interface MentionQuery {
  start: number
  end: number
  query: string
}

export interface MentionOption {
  token: '@claude' | '@codex' | '@agy' | '@all' | '@Main'
  label: string
  description: string
  route: ConversationComposerMention['route']
  icon: typeof Bot
}

export function agentMentionOption(agentId: RuntimeAgentId): MentionOption {
  const label = agentDisplayName(agentId)
  const token = agentId === 'claude' ? '@claude' : agentId === 'codex' ? '@codex' : '@agy'
  return {
    token,
    label,
    description: `Send only to ${label}`,
    route: { type: 'agent', agentId },
    icon: Bot,
  }
}

export function buildMentionOptions(
  pair: readonly [RuntimeAgentId, RuntimeAgentId],
  isSideChat: boolean,
): MentionOption[] {
  const [first, second] = pair
  if (isSideChat) {
    return [
      agentMentionOption(first),
      agentMentionOption(second),
      {
        token: '@all',
        label: 'All Agents',
        description: 'Primary, then Secondary',
        route: { type: 'all' },
        icon: Users,
      },
      {
        token: '@Main',
        label: 'Main chat',
        description: 'Send to the main chat',
        route: { type: 'main' },
        icon: CornerUpLeft,
      },
    ]
  }
  return [
    agentMentionOption(first),
    agentMentionOption(second),
    {
      token: '@all',
      label: 'All',
      description: 'Primary, then Secondary',
      route: { type: 'all' },
      icon: Users,
    },
  ]
}

export function mentionQueryAt(value: string, cursor: number): MentionQuery | undefined {
  const prefix = value.slice(0, cursor)
  const match = /(?:^|\s)@([a-z]*)$/iu.exec(prefix)
  if (!match) return undefined
  const start = cursor - match[1]!.length - 1
  return { start, end: cursor, query: match[1]!.toLowerCase() }
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Maintains a bounded LRU Map of per-card workspace file lists (max 8 entries)
 * so expanding or inspecting one change card never evicts or overwrites another.
 */
export function upsertWorkspaceFilesLru(
  current: ReadonlyMap<string, WorkspaceChangesList>,
  changeSetId: string,
  entry: WorkspaceChangesList,
  maxEntries = WORKSPACE_FILES_LRU_LIMIT,
): Map<string, WorkspaceChangesList> {
  const next = new Map(current)
  if (next.has(changeSetId)) next.delete(changeSetId)
  next.set(changeSetId, entry)
  while (next.size > maxEntries) {
    const oldestKey = next.keys().next().value
    if (oldestKey === undefined) break
    next.delete(oldestKey)
  }
  return next
}

export function resolvePlanStatusLabel(
  planningTask: CollaborationTask,
  planSync: Extract<ConversationPage, { scope: 'collaboration' }>['view']['planSync'] | undefined,
): string {
  if (planSync) return 'Needs restore'
  if (planningTask.status === 'running' && planningTask.stage === 'plan') return 'Drafting'
  if (planningTask.status === 'running' && planningTask.stage === 'plan_review') return 'In review'
  if (
    planningTask.review?.stage === 'plan_review' &&
    planningTask.planReference &&
    planningTask.review.planReference?.version === planningTask.planVersion &&
    planningTask.review.planReference?.document.sha256 ===
      planningTask.planReference.document.sha256
  ) {
    if (planningTask.review.verdict === 'accepted') return 'Accepted'
    if (planningTask.review.verdict === 'changes_requested') return 'Changes requested'
    return isCollaborationOpenMode(planningTask) ? 'Unreviewed' : 'In review'
  }
  if (planningTask.unreviewedPlanActor) return 'Unreviewed'
  if (isCollaborationOpenMode(planningTask)) return 'Accepted'
  return planningTask.stage === 'plan_review' ? 'In review' : 'Drafting'
}
