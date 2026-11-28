import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  COLLABORATION_PROTOCOL,
  collaborationInputGate,
  collaborationMarkdownNodeSchema,
  collaborationMarkdownTreeWithinBudget,
  collaborationTaskSchema,
  parseComposerCommandPrefix,
  type AgentRun,
  type AnchoredComment,
  type CollaborationDocument,
  type CollaborationMarkdownNode,
  type CollaborationTask,
  type ConversationPatch,
  type RuntimeAgentId,
} from '@pact/contracts'

import type { ConversationRepositoryHost } from './context.js'

import * as scheduling from '../conversation-scheduling.js'
import {
  collaborationActionReceipts,
  collaborationInputs,
  collaborationMarkdownPages,
  collaborationTasks,
  conversationBodyInputs,
  conversationBodyParts,
  conversationQueueOperations,
  sessions,
  workflowTurns,
} from '../schema/index.js'
import { storedReceivedMetadata } from './helpers.js'
import { BODY_INTERNAL_READ_BYTES, BODY_PART_UNITS, RunOperationConflictError } from './types.js'

export function receivedCollaborationInput(
  repo: ConversationRepositoryHost,
  sessionId: string,
  includeCancelled = false,
) {
  if (!includeCancelled) return repo.sourceQueries.activeReceivedInput().get({ sessionId })
  return repo.database
    .select()
    .from(collaborationInputs)
    .where(
      and(
        eq(collaborationInputs.sessionId, sessionId),
        includeCancelled
          ? and(
              ne(collaborationInputs.state, 'materialized'),
              sql`NOT EXISTS (SELECT 1 FROM ${conversationQueueOperations} WHERE ${conversationQueueOperations.inputId} = ${collaborationInputs.id} AND ${conversationQueueOperations.kind} = 'remove' AND ${conversationQueueOperations.targetRunId} IS NOT NULL AND ${conversationQueueOperations.state} = 'complete')`,
            )
          : inArray(collaborationInputs.state, ['accepted', 'blocked']),
      ),
    )
    .orderBy(desc(collaborationInputs.createdAt))
    .limit(1)
    .get()
}

export function receivedInputReceipt(
  repo: ConversationRepositoryHost,
  sessionId: string,
  clientMessageId: string,
  input?: import('@pact/contracts').ConversationSendInput,
  waitingForWork = false,
  expectedActor?: RuntimeAgentId,
): ConversationPatch | undefined {
  const row = repo.database
    .select()
    .from(collaborationInputs)
    .where(
      and(
        eq(collaborationInputs.id, clientMessageId),
        eq(collaborationInputs.sessionId, sessionId),
      ),
    )
    .get()
  if (!row) return undefined
  if (expectedActor && expectedActor !== row.actor) {
    throw new RunOperationConflictError('This received nonce belongs to different input.')
  }
  if (input) {
    const meta = storedReceivedMetadata(row.metadataJson)
    let effectivePrefixText = input.content
    if (input.inputId && input.inputId === row.inputId && !input.content) {
      const body = repo.database
        .select()
        .from(conversationBodyInputs)
        .where(
          and(
            eq(conversationBodyInputs.id, row.inputId),
            eq(conversationBodyInputs.sessionId, sessionId),
          ),
        )
        .get()
      if (body?.sealed && body.bytes <= BODY_INTERNAL_READ_BYTES) {
        const read = repo.readBody(body, true)
        if (read.hash === row.digest && read.hash === body.hash) {
          effectivePrefixText = read.text
        }
      }
    }
    const prefix = parseComposerCommandPrefix(effectivePrefixText, input.skills)
    const routeMatches = (() => {
      if (meta.route?.type === 'all') {
        const requested = input.route ?? prefix.route
        if (requested?.type !== 'all') return false
        if (input.route && input.route.type !== 'all') return false
        if (input.route && 'firstAgentId' in input.route && 'firstAgentId' in meta.route) {
          return (
            Reflect.get(input.route, 'firstAgentId') === meta.route.firstAgentId &&
            Reflect.get(input.route, 'secondAgentId') === meta.route.secondAgentId
          )
        }
        return true
      }
      return JSON.stringify(input.route) === JSON.stringify(meta.route)
    })()
    const askOnly =
      meta.replyIntentBasis?.kind === 'ask_only'
        ? { taskId: row.taskId, expectedRevision: meta.replyIntentBasis.taskRevision }
        : undefined
    if (
      (input.inputId && input.inputId !== row.inputId) ||
      (!input.inputId && createHash('sha256').update(input.content).digest('hex') !== row.digest) ||
      (!meta.batchId && JSON.stringify(input.commentIds) !== JSON.stringify(meta.commentIds)) ||
      (input.batchId ?? input.clientMessageId) !== (meta.batchId ?? row.id) ||
      (input.freezeDrafts ?? true) !== (meta.freezeDrafts ?? true) ||
      JSON.stringify(input.imageIds ?? []) !== JSON.stringify(meta.imageIds) ||
      JSON.stringify(input.skills ?? []) !== JSON.stringify(meta.skills) ||
      !routeMatches ||
      !isDeepStrictEqual(input.replyToDecision, meta.replyToDecision) ||
      !isDeepStrictEqual(input.replaceTask, meta.replaceTask) ||
      !isDeepStrictEqual(input.askOnly, askOnly)
    )
      throw new RunOperationConflictError('This received nonce belongs to different input.')
  }
  return repo.createPatch(sessionId, {
    receivedInputIds: [row.id],
    ...(waitingForWork && row.state === 'accepted' ? { queuedInputIds: [row.id] } : {}),
  })
}

/** New user input admission; durable receipts and authorized workflow dispatch are checked separately. */

export function decodedCollaboration(
  repo: ConversationRepositoryHost,
  state: string,
  _hydrate?: boolean,
): CollaborationTask {
  return collaborationTaskSchema.parse(JSON.parse(state))
}

export function collaboration(
  repo: ConversationRepositoryHost,
  sessionId: string,
  runId?: string,
  _hydrate?: boolean,
): CollaborationTask | undefined {
  if (runId) {
    const active = collaboration(repo, sessionId)
    if (active?.runId === runId) return active
    const run = repo.findRun(runId)
    if (!run || run.sessionId !== sessionId)
      throw new RunOperationConflictError('The workflow source is unavailable.')
    // An ended task stays readable on its last Run after it leaves the active slot.
    const taskRow = run.collaboration
      ? repo.database
          .select()
          .from(collaborationTasks)
          .where(
            and(
              eq(collaborationTasks.id, run.collaboration.taskId),
              eq(collaborationTasks.sessionId, sessionId),
            ),
          )
          .get()
      : undefined
    const ended = taskRow && decodedCollaboration(repo, taskRow.stateJson)
    if (ended?.ending && ended.runId === runId)
      return { ...ended, inputSequence: taskRow!.inputSequence }
    const turn = repo.database
      .select({
        applied: workflowTurns.applied,
        authorizationJson: workflowTurns.authorizationJson,
        state: workflowTurns.stateJson,
      })
      .from(workflowTurns)
      .where(eq(workflowTurns.runId, runId))
      .get()
    if (!turn) return undefined
    const snapshot = decodedCollaboration(repo, turn.state)
    return turn.applied &&
      !snapshot.ending &&
      snapshot.planReference?.sourceRunId !== runId &&
      (snapshot.status === 'waiting' ||
        snapshot.automation !== 'paused' ||
        snapshot.pauseReason !== 'failure')
      ? repo.projectAppliedPlanUnavailable(run, turn, snapshot)
      : snapshot
  }
  const row = repo.database
    .select()
    .from(collaborationTasks)
    .where(
      and(
        eq(collaborationTasks.sessionId, sessionId),
        eq(collaborationTasks.active, true),
        sql`json_extract(${collaborationTasks.stateJson}, '$.protocol') = ${COLLABORATION_PROTOCOL}`,
      ),
    )
    .get()
  if (!row) return undefined
  const task = decodedCollaboration(repo, row.stateJson)
  return { ...task, inputSequence: row.inputSequence }
}

/** Immutable Run-owned content; physical segment limits never bound cumulative text. */

/** Immutable Run-owned content; physical segment limits never bound cumulative text. */
export function saveCollaborationDocument(
  repo: ConversationRepositoryHost,
  runId: string,
  text: string,
): CollaborationDocument {
  const run = repo.findRun(runId)
  if (!run) throw new RunOperationConflictError('The content Run is unavailable.')
  const sha256 = createHash('sha256').update(text).digest('hex')
  const ownerKey = `collaboration:${runId}`
  const old = repo.database
    .select()
    .from(conversationBodyInputs)
    .where(
      and(
        eq(conversationBodyInputs.ownerKey, ownerKey),
        eq(conversationBodyInputs.clientMessageId, sha256),
        eq(conversationBodyInputs.purpose, 'collaboration'),
      ),
    )
    .get()
  if (old?.sealed && old.hash === sha256)
    return { id: old.id, sha256, bytes: old.bytes, chars: old.chars }
  const now = new Date().toISOString()
  const id = randomUUID()
  repo.database
    .insert(conversationBodyInputs)
    .values({
      id,
      sessionId: run.sessionId,
      clientMessageId: sha256,
      ownerKey,
      purpose: 'collaboration',
      sourceRunId: runId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  let row = repo.bodyInput(id, run.sessionId, ownerKey)
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + BODY_PART_UNITS)
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--
    repo.appendBodyPart(row, offset, text.slice(offset, end))
    offset = end
    row = repo.bodyInput(id, run.sessionId, ownerKey)
  }
  repo.sealBody(row)
  return { id, sha256, bytes: row.bytes, chars: row.chars }
}

export function collaborationDocumentRow(
  repo: ConversationRepositoryHost,
  sessionId: string,
  ref: CollaborationDocument,
) {
  const row = repo.sourceQueries.document().get({ sessionId, documentId: ref.id })
  if (
    !row?.sealed ||
    !row.sourceRunId ||
    row.hash !== ref.sha256 ||
    row.bytes !== ref.bytes ||
    row.chars !== ref.chars
  )
    throw new RunOperationConflictError(
      'The immutable source does not match. Copy its complete id, sha256, bytes and chars from the supplied reference.',
    )
  return row
}

export function collaborationCommentDocument(
  repo: ConversationRepositoryHost,
  sessionId: string,
  anchor: Extract<AnchoredComment['anchor'], { type: 'message' }>,
): CollaborationDocument | undefined {
  const runId = anchor.plan?.runId ?? anchor.report?.runId
  if (!runId) return undefined
  const run = repo.findRun(runId)
  if (
    !run ||
    run.sessionId !== sessionId ||
    (run.userMessageId !== anchor.messageId && run.responseMessageId !== anchor.messageId)
  )
    throw new RunOperationConflictError('The Comment source Run changed.')
  const turn = repo.database
    .select()
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, runId))
    .get()
  if (!turn?.applied) return undefined
  if (anchor.plan) {
    const task = decodedCollaboration(repo, turn.stateJson)
    if (task.planReference?.version !== anchor.plan.version)
      throw new RunOperationConflictError('The plan version changed.')
    return task.planReference.document
  }
  return turn.reportBodyId ? repo.documentReference(sessionId, turn.reportBodyId) : undefined
}

export function usePlainCollaborationProjection(
  repo: ConversationRepositoryHost,
  sessionId: string,
  source: CollaborationDocument,
): void {
  collaborationDocumentRow(repo, sessionId, source)
  repo.database
    .update(conversationBodyInputs)
    .set({ projectionBasis: 'plain-visible-v1' })
    .where(eq(conversationBodyInputs.id, source.id))
    .run()
}

export function collaborationRawRange(
  repo: ConversationRepositoryHost,
  sessionId: string,
  source: CollaborationDocument,
  start: number,
  end: number,
): string {
  collaborationDocumentRow(repo, sessionId, source)
  let text = '',
    cursor = start
  while (cursor < end) {
    const row = repo.database
      .select()
      .from(conversationBodyParts)
      .where(
        and(
          eq(conversationBodyParts.inputId, source.id),
          lte(conversationBodyParts.offset, cursor),
        ),
      )
      .orderBy(desc(conversationBodyParts.offset))
      .limit(1)
      .get()
    if (!row) throw new RunOperationConflictError('The source has a missing text segment.')
    const next = row.text.slice(cursor - row.offset, Math.min(row.text.length, end - row.offset))
    if (!next.length) throw new RunOperationConflictError('The source has a missing text segment.')
    text += next
    cursor += next.length
  }
  return text
}

export function beginMarkdownProjection(
  repo: ConversationRepositoryHost,
  sessionId: string,
  source: CollaborationDocument,
): void {
  collaborationDocumentRow(repo, sessionId, source)
  repo.database
    .delete(collaborationMarkdownPages)
    .where(eq(collaborationMarkdownPages.documentId, source.id))
    .run()
}

export function recordMarkdownPage(
  repo: ConversationRepositoryHost,
  sessionId: string,
  source: CollaborationDocument,
  page: {
    ordinal: number
    visibleStart: number
    visibleEnd: number
    tree: CollaborationMarkdownNode
    visibleText: string
  },
): void {
  collaborationDocumentRow(repo, sessionId, source)
  const tree = collaborationMarkdownNodeSchema.parse(page.tree)
  const json = JSON.stringify(tree)
  if (
    Buffer.byteLength(json) > 40 * 1024 ||
    !collaborationMarkdownTreeWithinBudget(tree) ||
    page.visibleText.length > 4096 ||
    page.visibleText.length !== page.visibleEnd - page.visibleStart
  )
    throw new RunOperationConflictError(
      'Invalid Markdown projection page. Original content is preserved.',
    )
  const prior = repo.database
    .select()
    .from(collaborationMarkdownPages)
    .where(
      and(
        eq(collaborationMarkdownPages.documentId, source.id),
        eq(collaborationMarkdownPages.ordinal, page.ordinal - 1),
      ),
    )
    .get()
  if (
    (page.ordinal === 0 && page.visibleStart !== 0) ||
    (page.ordinal > 0 && prior?.visibleEnd !== page.visibleStart)
  )
    throw new RunOperationConflictError('Markdown projection has a missing page.')
  repo.database
    .insert(collaborationMarkdownPages)
    .values({
      documentId: source.id,
      ordinal: page.ordinal,
      visibleStart: page.visibleStart,
      visibleEnd: page.visibleEnd,
      treeJson: json,
      visibleText: page.visibleText,
    })
    .run()
}

export function sealMarkdownProjection(
  repo: ConversationRepositoryHost,
  sessionId: string,
  source: CollaborationDocument,
  pages: number,
): void {
  collaborationDocumentRow(repo, sessionId, source)
  repo.database
    .update(conversationBodyInputs)
    .set({ projectionPages: pages, projectionBasis: 'markdown-visible-v2' })
    .where(eq(conversationBodyInputs.id, source.id))
    .run()
}

export function collaborationQuote(
  repo: ConversationRepositoryHost,
  sessionId: string,
  source: CollaborationDocument,
  start: number,
  end: number,
  basis: 'markdown-visible-v2' | 'plain-visible-v1' = 'markdown-visible-v2',
): string {
  if (end - start > 20_000 || start < 0 || end <= start)
    throw new RunOperationConflictError('Invalid Comment quote range.')
  if (basis === 'plain-visible-v1')
    return collaborationRawRange(repo, sessionId, source, start, end)
  const body = collaborationDocumentRow(repo, sessionId, source)
  if (body.projectionPages === null || end - start > 20_000)
    throw new RunOperationConflictError('The selected Markdown range is not ready.')
  const rows = repo.database
    .select({
      visibleStart: collaborationMarkdownPages.visibleStart,
      visibleText: collaborationMarkdownPages.visibleText,
    })
    .from(collaborationMarkdownPages)
    .where(
      and(
        eq(collaborationMarkdownPages.documentId, source.id),
        gte(collaborationMarkdownPages.visibleStart, Math.max(0, start - 4096)),
        lt(collaborationMarkdownPages.visibleStart, end),
        gt(collaborationMarkdownPages.visibleEnd, start),
        gt(collaborationMarkdownPages.visibleEnd, collaborationMarkdownPages.visibleStart),
      ),
    )
    .orderBy(asc(collaborationMarkdownPages.visibleStart))
    .limit(20_000)
    .all()
  const quote = rows
    .map((row) =>
      row.visibleText.slice(
        Math.max(0, start - row.visibleStart),
        Math.min(row.visibleText.length, end - row.visibleStart),
      ),
    )
    .join('')
  if (quote.length !== end - start)
    throw new RunOperationConflictError('The Comment source range is unavailable.')
  return quote
}

export function collaborationDocumentText(
  repo: ConversationRepositoryHost,
  sessionId: string,
  ref: CollaborationDocument,
): string {
  const row = collaborationDocumentRow(repo, sessionId, ref)
  const read = repo.readBody(row, true)
  if (read.hash !== ref.sha256)
    throw new RunOperationConflictError('The complete source digest changed.')
  return read.text
}

export function storedCollaboration(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
): CollaborationTask {
  const taskDocument =
    task.taskDocument ??
    (task.task.length > 1024 && repo.findRun(task.runId)
      ? saveCollaborationDocument(repo, task.runId, task.task)
      : undefined)
  return collaborationTaskSchema.parse({
    ...task,
    task: taskDocument ? '' : task.task,
    ...(taskDocument ? { taskDocument } : {}),
  })
}

export function collaborationPromptState(
  repo: ConversationRepositoryHost,
  task: CollaborationTask,
): CollaborationTask {
  const turn = repo.database
    .select({ state: workflowTurns.stateJson })
    .from(workflowTurns)
    .where(eq(workflowTurns.runId, task.runId))
    .get()
  return turn ? decodedCollaboration(repo, turn.state) : storedCollaboration(repo, task)
}

export function assertWorkflowDispatch(repo: ConversationRepositoryHost, runId: string): void {
  const run = repo.findRun(runId)
  if (
    !run?.collaboration ||
    run.dispatchPhase === 'possibly_sent' ||
    run.dispatchPhase === 'accepted'
  )
    return
  const auth = repo.collaborationTurnAuthorization(runId)
  const current = collaboration(repo, run.sessionId)
  repo.assertRelayDecisionResolved(run.sessionId)
  if (auth?.replyIntentBasis?.kind === 'ask_only') {
    const intent = auth.replyIntentBasis
    const binding = repo.nativeContext(run.sessionId, run.agentId)
    if (
      !current ||
      current.runId !== runId ||
      current.inputProcessing?.pending?.inputId !== intent.inputId ||
      !repo.currentReplyIntent(current, run, auth) ||
      !intent.askBinding ||
      binding?.nativeSessionId !== intent.askBinding.nativeSessionId ||
      binding.bindingGeneration !== intent.askBinding.generation
    )
      throw new RunOperationConflictError(
        'The task checkpoint or its Agent changed before dispatch.',
      )
  }
  if (current && auth) {
    if (!isDeepStrictEqual(current.stageRoles, auth.stageRoles))
      throw new RunOperationConflictError('The workflow stage roles changed before dispatch.')
    if (current.planRevision && ['implement', 'repair', 'respond'].includes(auth.stage))
      throw new RunOperationConflictError(
        'The revised Plan requires a new explicit Implement action.',
      )
  }
  if (auth?.userAuthority) {
    const receipt = repo.database
      .select()
      .from(collaborationActionReceipts)
      .where(eq(collaborationActionReceipts.id, auth.userAuthority.receiptId))
      .get()
    if (
      !receipt ||
      receipt.boundRunId !== runId ||
      receipt.taskId !== auth.taskId ||
      receipt.actor !== auth.actor ||
      receipt.state !== 'bound' ||
      receipt.rootReceiptId !== auth.userAuthority.rootReceiptId
    )
      throw new RunOperationConflictError('The native Turn has no current bound action receipt.')
    if (receipt.action === 'extend_plan_review') {
      const extension = scheduling.confirmedPlanReviewExtension(repo.database, receipt.id),
        session = repo.database
          .select({ settingsRevision: sessions.settingsRevision })
          .from(sessions)
          .where(eq(sessions.id, run.sessionId))
          .get()
      if (
        !repo.schedulingSettings().enabled ||
        !extension ||
        session?.settingsRevision !== run.settingsRevision ||
        auth.stage !== 'plan_review' ||
        extension.taskId !== auth.taskId ||
        extension.actor !== auth.actor ||
        extension.inputSequence !== auth.inputSequence ||
        !isDeepStrictEqual(extension.planReference, auth.planReference)
      )
        throw new RunOperationConflictError(
          'The one-review confirmation changed before native dispatch.',
        )
    }
  } else if (auth && ['implement', 'repair', 'respond'].includes(auth.stage))
    throw new RunOperationConflictError(
      'The native action is missing its concrete user authorization.',
    )
  if (
    !auth ||
    !current ||
    current.id !== auth.taskId ||
    current.runId !== runId ||
    current.revision !== auth.taskRevision ||
    current.inputSequence !== auth.inputSequence ||
    (!['reply', 'collaborate'].includes(auth.stage) &&
      (current.automation !== 'active' || Boolean(collaborationInputGate(current))))
  )
    throw new RunOperationConflictError(
      'The workflow was paused or changed before native dispatch.',
    )
}

export function workflowInputWasNotSent(repo: ConversationRepositoryHost, run: AgentRun): boolean {
  return Boolean(
    run.collaboration &&
    !run.nativeTurnId &&
    !run.nativeOutcome &&
    ['not_sent', 'rejected'].includes(run.dispatchPhase ?? '') &&
    (run.nativeEffectsState === 'not_dispatched' ||
      (run.nativeEffectsState === 'settled' &&
        ['workflow_input_withheld', 'native_turn_not_started'].includes(
          run.nativeEffectsReason ?? '',
        ))),
  )
}
