import type { SQLiteTable } from 'drizzle-orm/sqlite-core'

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  or,
  lte,
  max,
  sql,
  type SQL,
} from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'

import {
  collaborationTaskSchema,
  collaborationTurnAuthorizationSchema,
  collaborationDocumentSchema,
  type CollaborationDocument,
  type CollaborationTurnAuthorization,
  nativeForkBoundarySchema,
  nativeForkWitnessSchema,
  commentAnchorSchema,
  storedCommentAnchor,
  sessionForkOperationSchema,
  type AgentNativeForkBoundary,
  type AgentNativeForkWitness,
  type RuntimeAgentId,
  type SessionForkOperation,
  type SessionForkPrepared,
  type SessionSettings,
} from '@pact/contracts'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { appendAgentEvent } from './agent-event-journal.js'
import { refreshNativeSessionMetadata } from './native-presence-metadata.js'
import {
  collaborationTasks,
  workflowTurns,
  conversationInputBatches,
  conversationInputBatchMembers,
  conversationRunSourceRefs,
  conversationBodyInputs,
  conversationBodyParts,
  agentEventJournal,
  agentRunActivities,
  agentRuns,
  anchoredComments,
  conversationMessages,
  conversationMessageImages,
  conversationOutputSnapshots,
  nativeAgentContexts,
  nativeForkIntents,
  nativeForkCandidateReceipts,
  sessionCatalogRevisions,
  sessionForkOperations,
  sessionSettingsRevisions,
  sessions,
  workspaceChangeSets,
  workspaceFileChanges,
} from './schema/index.js'
import { assertSessionAvailable } from './workspace-archive-repository.js'

const MAX_ENTITIES = 10_000
const MAX_BYTES = 8 * 1024 * 1024
const AGENTS = ['claude', 'codex'] as const
type RunRow = typeof agentRuns.$inferSelect

export interface ForkSelection {
  prepared: SessionForkPrepared
  runs: Record<RuntimeAgentId, RunRow>
}

/** One explicit cold read, owned by ConversationRepository, never a streaming/Catalog scan. */
export function selectForkSource(
  database: PactDrizzleDatabase,
  sourceSessionId: string,
  messageId: string,
  settings: SessionSettings,
  expectedSettingsRevision: number,
): ForkSelection {
  return database.transaction(() => {
    const session = database.select().from(sessions).where(eq(sessions.id, sourceSessionId)).get()
    const selected = database
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.sessionId, sourceSessionId),
          eq(conversationMessages.id, messageId),
        ),
      )
      .get()
    if (!session || session.status === 'archived')
      throw new Error('The source session is unavailable.')
    if (session.settingsRevision !== expectedSettingsRevision)
      throw new Error(
        'Source settings changed while checking readiness. Review the current settings again.',
      )
    if (
      !selected ||
      selected.role !== 'assistant' ||
      selected.state !== 'complete' ||
      !selected.isVisible
    )
      throw new Error('Only a completed Agent message can be forked.')
    // A Steer User is appended after the root assistant's reserved sequence.
    // The selected complete answer includes those inputs, so its frozen bundle
    // extends through its own last User and never through a later Run's answer.
    const selectedInputSequence = selected.runId
      ? database
          .select({ value: max(conversationMessages.sequence) })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.sessionId, sourceSessionId),
              eq(conversationMessages.runId, selected.runId),
              eq(conversationMessages.role, 'user'),
              eq(conversationMessages.state, 'complete'),
            ),
          )
          .get()?.value
      : undefined
    const selectedSequence = Math.max(selected.sequence, selectedInputSequence ?? selected.sequence)
    const journalSequence = database
      .select({ value: max(agentEventJournal.sequence) })
      .from(agentEventJournal)
      .where(eq(agentEventJournal.sessionId, sourceSessionId))
      .get()?.value
    const contexts = database
      .select({
        agentId: nativeAgentContexts.agentId,
        nativeSessionId: nativeAgentContexts.nativeSessionId,
        generation: nativeAgentContexts.bindingGeneration,
      })
      .from(nativeAgentContexts)
      .where(eq(nativeAgentContexts.sessionId, sourceSessionId))
      .orderBy(asc(nativeAgentContexts.agentId))
      .all()
    const runs: Partial<Record<RuntimeAgentId, RunRow>> = {}
    for (const agentId of AGENTS) {
      const result = database
        .select({ run: agentRuns })
        .from(conversationMessages)
        .innerJoin(agentRuns, eq(agentRuns.id, conversationMessages.runId))
        .where(
          and(
            eq(conversationMessages.sessionId, sourceSessionId),
            eq(conversationMessages.agentId, agentId),
            eq(conversationMessages.role, 'assistant'),
            eq(conversationMessages.state, 'complete'),
            eq(conversationMessages.isVisible, true),
            lte(conversationMessages.sequence, selectedSequence),
          ),
        )
        .orderBy(desc(conversationMessages.sequence))
        .limit(1)
        .get()
      if (!result?.run.nativeSessionId || !result.run.nativeTurnId || !result.run.nativeOutcome)
        throw new Error(
          `${agentId === 'claude' ? 'Claude' : 'Codex'} has no confirmed native history at this message. Both Agents need native history before a fork can be created.`,
        )
      runs[agentId] = result.run
    }
    const sourceRevision = createHash('sha256')
      .update(
        JSON.stringify({
          settingsRevision: session.settingsRevision,
          commentsRevision: session.commentsRevision,
          journalSequence,
          messageRevision: selected.contentRevision,
          contexts,
        }),
      )
      .digest('hex')
    return {
      runs: { claude: runs.claude!, codex: runs.codex! },
      prepared: {
        sourceSessionId,
        messageId,
        messageRevision: selected.contentRevision,
        settingsRevision: session.settingsRevision,
        sourceRevision,
        sequence: selectedSequence,
        preview: selected.content.slice(0, 256),
        settings,
      },
    }
  })
}

export function forkResponse(
  database: PactDrizzleDatabase,
  runId: string,
  throughSequence: number,
): { responseHash: string; sequence: number; deliveryCursor: number } {
  const row = database
    .select({ content: conversationMessages.content, sequence: conversationMessages.sequence })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.runId, runId),
        eq(conversationMessages.role, 'assistant'),
        eq(conversationMessages.isVisible, true),
        eq(conversationMessages.state, 'complete'),
        lte(conversationMessages.sequence, throughSequence),
      ),
    )
    .orderBy(desc(conversationMessages.sequence))
    .limit(1)
    .get()
  if (!row) throw new Error('The completed native response is unavailable at the selected cutoff.')
  const cursor = database.get<{ sequence: number }>(sql`
    SELECT max(sequence) AS sequence FROM ${conversationMessages}
    WHERE session_id=(SELECT session_id FROM ${agentRuns} WHERE id=${runId})
      AND sequence<=${throughSequence}
      AND (id=(SELECT user_message_id FROM ${agentRuns} WHERE id=${runId}) OR
        (run_id=${runId} AND role='user' AND state='complete') OR
        id IN (SELECT json_extract(value,'$.id') FROM json_each(
          (SELECT handoff_source_ids FROM ${agentRuns} WHERE id=${runId}))))
  `)
  if (cursor?.sequence === undefined || cursor.sequence === null)
    throw new Error('The source native delivery cursor is unavailable.')
  return {
    responseHash: createHash('sha256').update(row.content).digest('hex'),
    sequence: Math.max(row.sequence, cursor.sequence),
    deliveryCursor: cursor.sequence,
  }
}

function forkId(sessionId: string, kind: string, sourceId: string): string {
  const bytes = createHash('sha256')
    .update(`${sessionId}:${kind}:${sourceId}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Commit Pact identity, independent frozen facts, consent and both intents before any native write. */
export function commitFork(
  database: PactDrizzleDatabase,
  operationId: string,
  selection: ForkSelection,
  boundaries: Record<RuntimeAgentId, AgentNativeForkBoundary>,
  fullConsent: RuntimeAgentId[],
  authorizationForRun?: (runId: string) => CollaborationTurnAuthorization | undefined,
): SessionForkOperation {
  const prior = database
    .select()
    .from(sessionForkOperations)
    .where(eq(sessionForkOperations.id, operationId))
    .get()
  if (prior) {
    if (
      prior.sourceSessionId !== selection.prepared.sourceSessionId ||
      prior.sourceMessageId !== selection.prepared.messageId
    )
      throw new Error('This fork operation already belongs to a different message.')
    return readFork(database, prior.sessionId)!
  }
  return database.transaction(() => {
    const prepared = selection.prepared
    assertSessionAvailable(database, prepared.sourceSessionId)
    const source = database
      .select()
      .from(sessions)
      .where(eq(sessions.id, prepared.sourceSessionId))
      .get()
    if (
      database
        .select({ id: sessionForkOperations.id })
        .from(sessionForkOperations)
        .where(
          and(
            eq(sessionForkOperations.sourceSessionId, prepared.sourceSessionId),
            eq(sessionForkOperations.ready, false),
          ),
        )
        .limit(1)
        .get()
    )
      throw new Error(
        'A fork from this session still needs native confirmation. Open that fork to continue.',
      )
    const settings = database
      .select()
      .from(sessionSettingsRevisions)
      .where(
        and(
          eq(sessionSettingsRevisions.sessionId, prepared.sourceSessionId),
          eq(sessionSettingsRevisions.revision, prepared.settingsRevision),
        ),
      )
      .get()
    if (
      !source ||
      !settings ||
      source.status === 'archived' ||
      source.settingsRevision !== prepared.settingsRevision
    )
      throw new Error('Source settings changed. Review the fork confirmation again.')
    if (
      selectForkSource(
        database,
        source.id,
        prepared.messageId,
        prepared.settings,
        prepared.settingsRevision,
      ).prepared.sourceRevision !== prepared.sourceRevision
    )
      throw new Error('Source history changed. Review the fork confirmation again.')
    for (const agentId of AGENTS) {
      const mode =
        prepared.settings.permissionModes?.[agentId] ?? (agentId === 'claude' ? 'ask' : 'native')
      if (mode === 'full' && !fullConsent.includes(agentId))
        throw new Error(`Full access for the new ${agentId} session must be explicitly confirmed.`)
      nativeForkBoundarySchema.parse(boundaries[agentId])
    }
    const sessionId = randomUUID()
    const now = new Date().toISOString()
    let entities = 0,
      bytes = 0
    const bound = <T>(rows: T[]): T[] => {
      entities += rows.length
      for (const row of rows) bytes += Buffer.byteLength(JSON.stringify(row)) + 1
      if (entities > MAX_ENTITIES || bytes > MAX_BYTES)
        throw new Error(
          'The complete frozen history exceeds 10,000 records or 8 MiB. No shortened fork was created.',
        )
      return rows
    }
    const preflight = (table: SQLiteTable, predicate: SQL | undefined): void => {
      const entries = Object.entries(getTableColumns(table))
      const columns = entries.map(([, column]) => column)
      const lengths = columns.map((column) =>
        column.dataType === 'boolean'
          ? sql`CASE WHEN ${column} IS NULL OR ${column}=1 THEN 4 ELSE 5 END`
          : sql`length(CAST(json_quote(${column}) AS BLOB))`,
      )
      // Count the escaped strings and stored integer/boolean/null values before
      // hydration; fixed scalar reserves also falsely rejected valid near-limit histories.
      const metadataReserve =
        3 + // Braces plus the same per-row separator counted by bound().
        Math.max(0, columns.length - 1) +
        entries.reduce((total, [key]) => total + Buffer.byteLength(JSON.stringify(key)) + 1, 0)
      const measure = database
        .select({
          count: sql<number>`count(*)`,
          bytes: sql<number>`coalesce(sum(${sql.join(lengths, sql` + `)} + ${metadataReserve}),0)`,
        })
        .from(table)
        .where(predicate)
        .get()
      if (!measure || entities + measure.count > MAX_ENTITIES || bytes + measure.bytes > MAX_BYTES)
        throw new Error(
          'The complete frozen history exceeds its record or byte bound. No fork was created.',
        )
    }
    const messagePredicate = and(
      eq(conversationMessages.sessionId, source.id),
      lte(conversationMessages.sequence, prepared.sequence),
    )
    preflight(conversationMessages, messagePredicate)
    const messages = bound(
      database
        .select()
        .from(conversationMessages)
        .where(messagePredicate)
        .orderBy(asc(conversationMessages.sequence))
        .limit(MAX_ENTITIES + 1)
        .all(),
    )
    const imagePredicate = sql`${conversationMessageImages.messageId} IN (SELECT id FROM ${conversationMessages} WHERE session_id=${source.id} AND sequence<=${prepared.sequence})`
    preflight(conversationMessageImages, imagePredicate)
    const imageReferences = bound(
      database
        .select()
        .from(conversationMessageImages)
        .where(imagePredicate)
        .orderBy(asc(conversationMessageImages.messageId), asc(conversationMessageImages.ordinal))
        .limit(MAX_ENTITIES + 1)
        .all(),
    )
    const messageIds = messages.map((row) => row.id)
    const messageSet = new Set(messageIds)
    const runPredicate = and(
      eq(agentRuns.sessionId, source.id),
      sql`NOT EXISTS (SELECT 1 FROM ${conversationMessages} m WHERE m.run_id=${agentRuns.id} AND m.role='assistant' AND m.sequence>${prepared.sequence}) AND (EXISTS (SELECT 1 FROM ${conversationMessages} m WHERE m.run_id = ${agentRuns.id} AND m.sequence <= ${prepared.sequence}) OR (${agentRuns.userMessageId} IN (SELECT id FROM ${conversationMessages} WHERE session_id=${source.id} AND sequence<=${prepared.sequence}) AND ${agentRuns.createdAt} < ${messages.at(-1)?.updatedAt ?? now} AND NOT EXISTS (SELECT 1 FROM ${conversationMessages} m WHERE m.run_id=${agentRuns.id} AND m.role='assistant' AND m.sequence>${prepared.sequence})))`,
    )
    preflight(agentRuns, runPredicate)
    const runs = bound(
      database
        .select()
        .from(agentRuns)
        .where(runPredicate)
        .limit(MAX_ENTITIES + 1)
        .all(),
    )
    const runIds = runs.map((row) => row.id)
    const runSet = new Set(runIds)
    const collaborationPredicate = inArray(workflowTurns.runId, runIds)
    if (runIds.length) preflight(workflowTurns, collaborationPredicate)
    const collaborationHistory = runIds.length
      ? bound(
          database
            .select()
            .from(workflowTurns)
            .where(collaborationPredicate)
            .limit(MAX_ENTITIES + 1)
            .all(),
        )
      : []
    const commentPredicate = and(
      eq(anchoredComments.sessionId, source.id),
      sql`${anchoredComments.sentWithMessageId} IN (SELECT id FROM ${conversationMessages} WHERE session_id=${source.id} AND sequence<=${prepared.sequence})`,
    )
    preflight(anchoredComments, commentPredicate)
    const comments = bound(
      database
        .select()
        .from(anchoredComments)
        .where(commentPredicate)
        .orderBy(asc(anchoredComments.position))
        .limit(MAX_ENTITIES + 1)
        .all(),
    )
    const commentSet = new Set(comments.map((row) => row.id))
    const taskSet = new Set(collaborationHistory.map((row) => row.taskId))
    const readBounded = <T>(
      table: SQLiteTable,
      predicate: SQL | undefined,
      read: () => T[],
    ): T[] => {
      preflight(table, predicate)
      return bound(read())
    }
    const runById = new Map(runs.map((run) => [run.id, run]))
    const historicalAuthorizations = new Map(
      collaborationHistory.map((row) => {
        const base = collaborationTurnAuthorizationSchema.parse(JSON.parse(row.authorizationJson))
        const run = runById.get(row.runId)
        const effective =
          run?.status === 'completed' && run.nativeOutcome === 'completed'
            ? authorizationForRun?.(row.runId)
            : undefined
        const appended = effective && effective.inputSequence > base.inputSequence
        const authorization = appended
          ? collaborationTurnAuthorizationSchema.parse(effective)
          : base
        if (
          authorization.runId !== row.runId ||
          authorization.taskId !== row.taskId ||
          authorization.actor !== row.actor ||
          authorization.stage !== row.stage ||
          base.runId !== row.runId ||
          base.taskId !== row.taskId ||
          base.actor !== row.actor ||
          base.stage !== row.stage
        )
          throw new Error('The historical workflow authorization does not match its frozen root.')
        if (appended) bound([authorization])
        return [row.runId, authorization] as const
      }),
    )
    const batchPredicate = and(
      eq(conversationInputBatches.sessionId, source.id),
      inArray(conversationInputBatches.messageId, messageIds),
      or(isNull(conversationInputBatches.runId), inArray(conversationInputBatches.runId, runIds)),
    )
    const batchRows = readBounded(conversationInputBatches, batchPredicate, () =>
      database
        .select()
        .from(conversationInputBatches)
        .where(batchPredicate)
        .orderBy(asc(conversationInputBatches.createdAt))
        .limit(MAX_ENTITIES + 1)
        .all(),
    )
    const includedInputSequences = new Map<string, number>()
    for (const batch of batchRows)
      if (batch.taskId)
        includedInputSequences.set(
          batch.taskId,
          Math.max(includedInputSequences.get(batch.taskId) ?? 0, batch.sequence),
        )
    for (const authorization of historicalAuthorizations.values())
      if (authorization.inputSequence > (includedInputSequences.get(authorization.taskId) ?? 0))
        throw new Error(
          'The workflow authorization includes input outside the selected Fork boundary.',
        )
    const batchIds = batchRows.map((row) => row.id)
    const batchSet = new Set(batchIds)
    const memberRows = batchIds.length
      ? readBounded(
          conversationInputBatchMembers,
          inArray(conversationInputBatchMembers.batchId, batchIds),
          () =>
            database
              .select()
              .from(conversationInputBatchMembers)
              .where(inArray(conversationInputBatchMembers.batchId, batchIds))
              .limit(MAX_ENTITIES + 1)
              .all(),
        )
      : []
    const runSourceRows = runIds.length
      ? readBounded(
          conversationRunSourceRefs,
          inArray(conversationRunSourceRefs.runId, runIds),
          () =>
            database
              .select()
              .from(conversationRunSourceRefs)
              .where(inArray(conversationRunSourceRefs.runId, runIds))
              .limit(MAX_ENTITIES + 1)
              .all(),
        )
      : []
    const outputSnapshotRows = runIds.length
      ? readBounded(
          conversationOutputSnapshots,
          inArray(conversationOutputSnapshots.runId, runIds),
          () =>
            database
              .select()
              .from(conversationOutputSnapshots)
              .where(inArray(conversationOutputSnapshots.runId, runIds))
              .orderBy(
                asc(conversationOutputSnapshots.runId),
                asc(conversationOutputSnapshots.ordinal),
              )
              .limit(MAX_ENTITIES + 1)
              .all(),
        )
      : []
    const identity = (
      kind: 'run' | 'message' | 'comment' | 'collaboration' | 'batch',
      id: string,
    ): string => {
      const set =
        kind === 'run'
          ? runSet
          : kind === 'message'
            ? messageSet
            : kind === 'comment'
              ? commentSet
              : kind === 'batch'
                ? batchSet
                : taskSet
      if (!set.has(id))
        throw new Error(`A required Fork ${kind} source is outside the frozen history.`)
      return forkId(sessionId, kind, id)
    }
    const memberIdentity = (id: string) => (id === '$body' ? id : identity('comment', id))
    const userIdentity = (id: string) => identity(commentSet.has(id) ? 'comment' : 'message', id)
    const structuredDocuments = new Set<string>()
    const registerDocument = (value: unknown, structured = false): void => {
      const parsed = collaborationDocumentSchema.safeParse(value)
      if (parsed.success && structured) structuredDocuments.add(parsed.data.id)
    }
    for (const turn of collaborationHistory) {
      const task = collaborationTaskSchema.parse(JSON.parse(turn.stateJson))
      if (task.id !== turn.taskId || task.runId !== turn.runId)
        throw new Error('The workflow snapshot does not belong to its frozen Fork root.')
      registerDocument(task.reviewScopeRef, true)
      registerDocument(task.review?.scopeRef, true)
      const auth = historicalAuthorizations.get(turn.runId)!
      registerDocument(auth.reviewScopeRef, true)
      registerDocument(auth.sourceManifestRef, true)
    }
    for (const row of memberRows)
      if (row.anchorDocumentJson) registerDocument(JSON.parse(row.anchorDocumentJson), true)
    const pendingDocuments = new Set<string>()
    const remapDocument = (
      ref: CollaborationDocument | undefined,
      structured = false,
    ): typeof ref => {
      if (!ref) return undefined
      const old = database
        .select()
        .from(conversationBodyInputs)
        .where(eq(conversationBodyInputs.id, ref.id))
        .get()
      if (
        !old?.sealed ||
        old.sessionId !== source.id ||
        !old.sourceRunId ||
        !runSet.has(old.sourceRunId) ||
        old.hash !== ref.sha256
      )
        throw new Error('The Fork document source is unavailable at the chosen boundary.')
      const id = forkId(sessionId, 'document', ref.id)
      const copied = database
        .select()
        .from(conversationBodyInputs)
        .where(eq(conversationBodyInputs.id, id))
        .get()
      if (copied?.hash) return { id, sha256: copied.hash, bytes: copied.bytes, chars: copied.chars }
      if (pendingDocuments.has(ref.id))
        throw new Error('A Fork source contains a cyclic document reference.')
      if (pendingDocuments.size >= 64)
        throw new Error('The Fork document reference graph exceeds its stack bound.')
      pendingDocuments.add(ref.id)
      const parts = readBounded(
        conversationBodyParts,
        eq(conversationBodyParts.inputId, old.id),
        () =>
          database
            .select()
            .from(conversationBodyParts)
            .where(eq(conversationBodyParts.inputId, old.id))
            .orderBy(asc(conversationBodyParts.offset))
            .limit(MAX_ENTITIES + 1)
            .all(),
      )
      bound([old])
      let text: string | undefined
      if (structured || structuredDocuments.has(ref.id)) {
        const original = parts.map((part) => part.text).join('')
        let value: unknown
        try {
          value = JSON.parse(original)
        } catch {
          value = undefined
        }
        // Unparseable structured sources remain exact evidence, never new valid metadata.
        if (value !== undefined) text = JSON.stringify(remapMetadata(value))
      }
      const sha256 =
        text === undefined ? ref.sha256 : createHash('sha256').update(text).digest('hex')
      const next = {
        id,
        sha256,
        bytes: text === undefined ? old.bytes : Buffer.byteLength(text),
        chars: text === undefined ? old.chars : text.length,
      }
      database
        .insert(conversationBodyInputs)
        .values({
          ...old,
          id,
          sessionId,
          sourceRunId: identity('run', old.sourceRunId),
          ownerKey: `fork:${forkId(sessionId, 'body-owner', old.ownerKey)}`,
          clientMessageId: sha256,
          committedMessageId: null,
          pendingReceiptId: null,
          bytes: next.bytes,
          chars: next.chars,
          hash: sha256,
          projectionPages: null,
          parts: text === undefined ? old.parts : Math.ceil(next.chars / 4096),
        })
        .run()
      if (text === undefined)
        database.run(
          sql`INSERT INTO conversation_body_parts(input_id,offset,text,end_bytes) SELECT ${id},offset,text,end_bytes FROM conversation_body_parts WHERE input_id=${old.id}`,
        )
      else {
        let endBytes = 0,
          count = 0
        for (let offset = 0; offset < text.length;) {
          let end = Math.min(text.length, offset + 4096)
          if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--
          const piece = text.slice(offset, end)
          endBytes += Buffer.byteLength(piece)
          database
            .insert(conversationBodyParts)
            .values({ inputId: id, offset, text: piece, endBytes })
            .run()
          count++
          offset = end
        }
        database
          .update(conversationBodyInputs)
          .set({ parts: count })
          .where(eq(conversationBodyInputs.id, id))
          .run()
      }
      pendingDocuments.delete(ref.id)
      return next
    }
    const remapMetadata = (value: unknown, depth = 0): unknown => {
      if (depth > 64) throw new Error('Fork source metadata exceeds its stack bound.')
      if (Array.isArray(value)) return value.map((item) => remapMetadata(item, depth + 1))
      if (!value || typeof value !== 'object') return value
      const doc = collaborationDocumentSchema.safeParse(value)
      if (doc.success) return remapDocument(doc.data)
      const object: Record<string, unknown> = Object.fromEntries(Object.entries(value))
      const mapped: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(object)) {
        if (item == null) {
          mapped[key] = item
          continue
        }
        if (key === 'sessionId') mapped[key] = sessionId
        else if (key === 'inputProcessing') {
          const processing = remapMetadata(item, depth + 1)
          const pending =
            processing && typeof processing === 'object'
              ? Reflect.get(processing, 'pending')
              : undefined
          const inputId =
            pending && typeof pending === 'object' ? Reflect.get(pending, 'inputId') : undefined
          if (pending && typeof pending === 'object' && typeof inputId === 'string')
            Object.assign(pending, { inputId: forkId(sessionId, 'workflow-input', inputId) })
          mapped[key] = processing
        } else if (['taskId', 'sourceTaskId'].includes(key) && typeof item === 'string')
          mapped[key] = identity('collaboration', item)
        else if (
          ['runId', 'sourceRunId', 'responseRunId', 'codeRunId', 'sourceChangeSetId'].includes(
            key,
          ) &&
          typeof item === 'string'
        )
          mapped[key] = identity('run', item)
        else if (
          [
            'messageId',
            'sourceMessageId',
            'userMessageId',
            'taskMessageId',
            'latestUserMessageId',
          ].includes(key) &&
          typeof item === 'string'
        )
          mapped[key] = identity('message', item)
        else if (key === 'commentId' && typeof item === 'string')
          mapped[key] = identity('comment', item)
        else if (['batchId', 'inputBatchId'].includes(key) && typeof item === 'string')
          mapped[key] = identity('batch', item)
        else if (key === 'memberId' && typeof item === 'string') mapped[key] = memberIdentity(item)
        else if (key === 'userSourceIds' && Array.isArray(item))
          mapped[key] = item.map((id) => userIdentity(String(id)))
        else if (key === 'userSources' && Array.isArray(item))
          mapped[key] = item.map((userSource) => {
            const remapped = remapMetadata(userSource, depth + 1)
            if (!remapped || typeof remapped !== 'object' || Array.isArray(remapped))
              throw new Error('The historical user source is invalid.')
            const sourceId =
              userSource && typeof userSource === 'object'
                ? Reflect.get(userSource, 'id')
                : undefined
            if (typeof sourceId !== 'string')
              throw new Error('The historical user source identity is unavailable.')
            return { ...remapped, id: userIdentity(sourceId) }
          })
        else if (key === 'inputBatchRef' && typeof item === 'object') {
          const metadata = remapMetadata(item, depth + 1)
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
            throw new Error('The historical Batch reference is invalid.')
          mapped[key] = Object.assign(metadata, {
            id: identity('batch', String(Reflect.get(item, 'id'))),
          })
        } else mapped[key] = remapMetadata(item, depth + 1)
      }
      return mapped
    }
    const remapCommentAnchor = (json: string): string => {
      const sourceAnchor = storedCommentAnchor(JSON.parse(json))
      return JSON.stringify(commentAnchorSchema.parse(remapMetadata(sourceAnchor)))
    }
    const remapCollaboration = (stateJson: string): string => {
      const task = collaborationTaskSchema.parse(JSON.parse(stateJson))
      const inputSequence = Math.min(task.inputSequence, includedInputSequences.get(task.id) ?? 0)
      return JSON.stringify(
        collaborationTaskSchema.parse({
          ...collaborationTaskSchema.parse(
            remapMetadata({
              ...task,
              latestUserMessageId:
                task.latestUserMessageId && messageSet.has(task.latestUserMessageId)
                  ? task.latestUserMessageId
                  : undefined,
              inputSequence,
              handledInputSequence: Math.min(task.handledInputSequence, inputSequence),
              authorization: undefined,
              pendingWork: undefined,
              nextStage: undefined,
            }),
          ),
          id: identity('collaboration', task.id),
          sessionId,
          // The original outcome remains historical evidence. It authorizes no work in this Session.
          automation: 'paused',
          pauseReason: 'user',
          notice: 'Inherited collaboration history is read-only; no Agent action is authorized.',
        }),
      )
    }
    const copyArtifactBody = (bodyId: string): string => {
      const old = database
        .select()
        .from(conversationBodyInputs)
        .where(eq(conversationBodyInputs.id, bodyId))
        .get()
      if (!old || old.sessionId !== source.id || !old.sourceRunId || !runSet.has(old.sourceRunId))
        throw new Error('The historical workflow artifact is outside the frozen Fork history.')
      if (old.sealed && old.hash)
        return remapDocument({ id: old.id, sha256: old.hash, bytes: old.bytes, chars: old.chars })!
          .id
      const id = forkId(sessionId, 'document', old.id)
      if (
        database
          .select({ id: conversationBodyInputs.id })
          .from(conversationBodyInputs)
          .where(eq(conversationBodyInputs.id, id))
          .get()
      )
        return id
      readBounded(conversationBodyParts, eq(conversationBodyParts.inputId, old.id), () =>
        database
          .select()
          .from(conversationBodyParts)
          .where(eq(conversationBodyParts.inputId, old.id))
          .limit(MAX_ENTITIES + 1)
          .all(),
      )
      bound([old])
      database
        .insert(conversationBodyInputs)
        .values({
          ...old,
          id,
          sessionId,
          sourceRunId: identity('run', old.sourceRunId),
          ownerKey: `fork:${forkId(sessionId, 'body-owner', old.ownerKey)}`,
          committedMessageId: null,
          pendingReceiptId: null,
        })
        .run()
      database.run(
        sql`INSERT INTO conversation_body_parts(input_id,offset,text,end_bytes) SELECT ${id},offset,text,end_bytes FROM conversation_body_parts WHERE input_id=${old.id}`,
      )
      return id
    }
    const activityPredicate = and(
      eq(agentRunActivities.sessionId, source.id),
      inArray(agentRunActivities.runId, runIds),
    )
    if (runIds.length) preflight(agentRunActivities, activityPredicate)
    const activities = runIds.length
      ? bound(
          database
            .select()
            .from(agentRunActivities)
            .where(activityPredicate)
            .limit(MAX_ENTITIES + 1)
            .all(),
        )
      : []
    const changePredicate = inArray(workspaceChangeSets.runId, runIds)
    if (runIds.length) preflight(workspaceChangeSets, changePredicate)
    const changes = runIds.length
      ? bound(
          database
            .select()
            .from(workspaceChangeSets)
            .where(changePredicate)
            .limit(MAX_ENTITIES + 1)
            .all(),
        )
      : []
    const filePredicate = inArray(
      workspaceFileChanges.changeSetId,
      changes.map((row) => row.id),
    )
    if (changes.length) preflight(workspaceFileChanges, filePredicate)
    const files = changes.length
      ? bound(
          database
            .select()
            .from(workspaceFileChanges)
            .where(filePredicate)
            .limit(MAX_ENTITIES + 1)
            .all(),
        )
      : []
    const settingsPredicate = and(
      eq(sessionSettingsRevisions.sessionId, source.id),
      inArray(sessionSettingsRevisions.revision, [
        ...new Set([source.settingsRevision, ...runs.map((row) => row.settingsRevision)]),
      ]),
    )
    preflight(sessionSettingsRevisions, settingsPredicate)
    const historicalSettings = bound(
      database
        .select()
        .from(sessionSettingsRevisions)
        .where(settingsPredicate)
        .limit(MAX_ENTITIES + 1)
        .all(),
    )
    if (
      runs.some(
        (run) => !historicalSettings.some((saved) => saved.revision === run.settingsRevision),
      )
    )
      throw new Error(
        'A historical Run settings revision is unavailable. No incomplete fork was created.',
      )
    // One transaction owns all bounded source copies; any unavailable reference rolls back the Fork.
    database
      .insert(sessions)
      .values({
        id: sessionId,
        projectId: source.projectId,
        title: `${source.title.slice(0, 200)} (fork)`,
        titleSource: 'local',
        status: 'draft',
        settingsRevision: source.settingsRevision,
        commentsRevision: comments.length ? 1 : 0,
        lastSeenMessageSequence: prepared.sequence,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    for (const saved of historicalSettings)
      database
        .insert(sessionSettingsRevisions)
        .values({
          ...saved,
          sessionId,
          ...(saved.revision === source.settingsRevision ? { createdAt: now } : {}),
        })
        .run()
    for (const row of runs)
      database
        .insert(agentRuns)
        .values({
          ...row,
          id: forkId(sessionId, 'run', row.id),
          sessionId,
          userMessageId: forkId(sessionId, 'message', row.userMessageId),
          forkSourceRunId: row.forkSourceRunId ?? row.id,
          collaborationTaskId:
            row.collaborationTaskId && taskSet.has(row.collaborationTaskId)
              ? identity('collaboration', row.collaborationTaskId)
              : null,
          collaborationKind:
            row.collaborationTaskId && taskSet.has(row.collaborationTaskId)
              ? row.collaborationKind
              : null,
          collaborationStage:
            row.collaborationTaskId && taskSet.has(row.collaborationTaskId)
              ? row.collaborationStage
              : null,
          answerFormat: null,
          peerProposalId: row.peerProposalId
            ? forkId(sessionId, 'proposal', row.peerProposalId)
            : null,
          peerProposalState: row.peerProposalState ? 'superseded' : null,
          peerProposalAcceptedMessageId:
            row.peerProposalAcceptedMessageId && messageSet.has(row.peerProposalAcceptedMessageId)
              ? forkId(sessionId, 'message', row.peerProposalAcceptedMessageId)
              : null,
          reexecutionOperationId: null,
          reexecutedFromRunId:
            row.reexecutedFromRunId && runSet.has(row.reexecutedFromRunId)
              ? forkId(sessionId, 'run', row.reexecutedFromRunId)
              : null,
          handoffSourceIds: remapHandoffRefs(row.handoffSourceIds, remapMetadata, (id) =>
            identity('message', id),
          ),
          workspaceChangesJson: row.workspaceChangesJson
            ? JSON.stringify({
                ...JSON.parse(row.workspaceChangesJson),
                id: forkId(sessionId, 'run', row.id),
                runId: forkId(sessionId, 'run', row.id),
                sessionId,
                undoUnavailableReason: 'Inherited history is read-only.',
              })
            : null,
        })
        .run()
    const inheritedTaskIds = new Set<string>()
    const messageOrdinal = new Map<string, number>()
    for (const message of messages)
      if (message.runId)
        messageOrdinal.set(
          message.runId,
          Math.max(messageOrdinal.get(message.runId) ?? -1, message.sequence),
        )
    const orderedHistory = collaborationHistory.toSorted(
      (left, right) =>
        (messageOrdinal.get(left.runId) ?? -1) - (messageOrdinal.get(right.runId) ?? -1) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.runId.localeCompare(right.runId),
    )
    for (const row of orderedHistory) {
      const planBodyId = row.planBodyId ? copyArtifactBody(row.planBodyId) : null
      const reportBodyId = row.reportBodyId ? copyArtifactBody(row.reportBodyId) : null
      const stateJson = remapCollaboration(row.stateJson)
      const task = collaborationTaskSchema.parse(JSON.parse(stateJson))
      if (!inheritedTaskIds.has(task.id)) {
        database
          .insert(collaborationTasks)
          .values({
            id: task.id,
            sessionId,
            stateJson,
            active: false,
            inputSequence: task.inputSequence,
            processedWatermark: task.handledInputSequence,
            updatedAt: now,
          })
          .run()
        inheritedTaskIds.add(task.id)
      } else
        database
          .update(collaborationTasks)
          .set({
            stateJson,
            inputSequence: task.inputSequence,
            processedWatermark: task.handledInputSequence,
          })
          .where(eq(collaborationTasks.id, task.id))
          .run()
      const authorization = collaborationTurnAuthorizationSchema.parse(
        remapMetadata(historicalAuthorizations.get(row.runId)!),
      )
      database
        .insert(workflowTurns)
        .values({
          ...row,
          runId: identity('run', row.runId),
          taskId: task.id,
          inputSequence: authorization.inputSequence,
          authorizationJson: JSON.stringify(authorization),
          stateJson,
          planBodyId,
          reportBodyId,
        })
        .run()
    }
    for (const row of messages)
      database
        .insert(conversationMessages)
        .values({
          ...row,
          id: forkId(sessionId, 'message', row.id),
          sessionId,
          runId: row.runId && runSet.has(row.runId) ? forkId(sessionId, 'run', row.runId) : null,
          replyToMessageId:
            row.replyToMessageId && messageSet.has(row.replyToMessageId)
              ? forkId(sessionId, 'message', row.replyToMessageId)
              : null,
          sourceMessageId:
            row.sourceMessageId && messageSet.has(row.sourceMessageId)
              ? forkId(sessionId, 'message', row.sourceMessageId)
              : null,
          routePendingAgentId: null,
        })
        .run()
    for (const row of outputSnapshotRows) {
      if (
        row.sessionId !== source.id ||
        !Number.isInteger(row.ordinal) ||
        row.ordinal < 0 ||
        row.ordinal >= 64
      )
        throw new Error('The Fork output snapshot is outside its original Run boundary.')
      database
        .insert(conversationOutputSnapshots)
        .values({
          ...row,
          sessionId,
          runId: identity('run', row.runId),
          afterMessageId: identity('message', row.afterMessageId),
          sourceMessageId: row.sourceMessageId ? identity('message', row.sourceMessageId) : null,
        })
        .run()
    }
    for (const row of imageReferences)
      database
        .insert(conversationMessageImages)
        .values({ ...row, messageId: forkId(sessionId, 'message', row.messageId) })
        .run()
    for (const row of comments) {
      const anchorJson = remapCommentAnchor(row.anchorJson)
      database
        .insert(anchoredComments)
        .values({
          ...row,
          id: identity('comment', row.id),
          sessionId,
          pendingReceiptId: null,
          returnOperationId: null,
          answerKey: null,
          anchorJson,
          sentWithMessageId: identity('message', row.sentWithMessageId!),
        })
        .run()
    }
    for (const row of batchRows) {
      const body = row.bodyDocumentJson
        ? remapDocument(JSON.parse(row.bodyDocumentJson))
        : undefined
      database
        .insert(conversationInputBatches)
        .values({
          ...row,
          id: identity('batch', row.id),
          sessionId,
          taskId:
            row.taskId && taskSet.has(row.taskId) ? identity('collaboration', row.taskId) : null,
          clientMessageId: forkId(sessionId, 'historical-batch-nonce', row.clientMessageId),
          runId: row.runId ? identity('run', row.runId) : null,
          messageId: row.messageId ? identity('message', row.messageId) : null,
          inputId: null,
          bodyDocumentJson: body ? JSON.stringify(body) : null,
        })
        .run()
    }
    for (const row of memberRows) {
      const body = row.bodyDocumentJson
        ? remapDocument(JSON.parse(row.bodyDocumentJson))
        : undefined
      const anchor = row.anchorDocumentJson
        ? remapDocument(JSON.parse(row.anchorDocumentJson))
        : undefined
      database
        .insert(conversationInputBatchMembers)
        .values({
          ...row,
          batchId: identity('batch', row.batchId),
          memberId: memberIdentity(row.memberId),
          commentId: identity('comment', row.commentId),
          anchorJson: remapCommentAnchor(row.anchorJson),
          bodyDocumentJson: body ? JSON.stringify(body) : null,
          anchorDocumentJson: anchor ? JSON.stringify(anchor) : null,
          sourceTaskId: null,
          sourceTodoId: null,
          questionId: null,
          questionRevision: null,
          answerResolver: null,
          responseRunId: null,
          responseDocumentJson: null,
          todoId: null,
        })
        .run()
    }
    for (const row of runSourceRows)
      database
        .insert(conversationRunSourceRefs)
        .values({
          ...row,
          runId: identity('run', row.runId),
          sourceMessageId: identity('message', row.sourceMessageId),
          batchId: row.batchId ? identity('batch', row.batchId) : null,
          documentsJson: JSON.stringify(remapMetadata(JSON.parse(row.documentsJson))),
        })
        .run()
    for (const row of activities)
      database
        .insert(agentRunActivities)
        .values({
          ...row,
          id: forkId(sessionId, 'activity', row.id),
          sessionId,
          runId: forkId(sessionId, 'run', row.runId),
        })
        .run()
    for (const row of changes) {
      const id = forkId(sessionId, 'run', row.runId)
      database
        .insert(workspaceChangeSets)
        .values({
          ...row,
          id,
          runId: id,
          sessionId,
          undoUnavailableReason: 'Inherited history is read-only.',
          projectionPending: false,
        })
        .run()
    }
    for (const row of files)
      database
        .insert(workspaceFileChanges)
        .values({ ...row, changeSetId: forkId(sessionId, 'run', row.changeSetId) })
        .run()
    database
      .insert(sessionForkOperations)
      .values({
        id: operationId,
        sessionId,
        sourceSessionId: source.id,
        sourceMessageId: prepared.messageId,
        sourceSequence: prepared.sequence,
        sourceRevision: prepared.sourceRevision,
        settingsRevision: source.settingsRevision,
        fullConsentJson: JSON.stringify(fullConsent),
        createdAt: now,
      })
      .run()
    for (const agentId of AGENTS)
      database
        .insert(nativeForkIntents)
        .values({
          operationId,
          agentId,
          settingsRevision: source.settingsRevision,
          sourceJson: JSON.stringify(boundaries[agentId]),
          state: 'prepared',
          updatedAt: now,
        })
        .run()
    appendAgentEvent(database, {
      sessionId,
      runId: operationId,
      eventType: 'session.fork.committed',
      payload: JSON.stringify({
        sourceSessionId: source.id,
        sourceMessageId: prepared.messageId,
        sourceSequence: prepared.sequence,
        sourceRevision: prepared.sourceRevision,
        fullConsent,
      }),
      createdAt: now,
    })
    database
      .update(sessionCatalogRevisions)
      .set({ revision: sql`${sessionCatalogRevisions.revision} + 1` })
      .where(eq(sessionCatalogRevisions.id, 1))
      .run()
    refreshNativeSessionMetadata(database, sessionId)
    return readFork(database, sessionId)!
  })
}

export function readFork(
  database: PactDrizzleDatabase,
  sessionId: string,
): SessionForkOperation | undefined {
  const operation = database
    .select({
      id: sessionForkOperations.id,
      sourceSessionId: sessionForkOperations.sourceSessionId,
      sourceMessageId: sessionForkOperations.sourceMessageId,
      sourceSequence: sessionForkOperations.sourceSequence,
      revision: sessionForkOperations.revision,
      ready: sessionForkOperations.ready,
    })
    .from(sessionForkOperations)
    .where(eq(sessionForkOperations.sessionId, sessionId))
    .get()
  if (!operation) return undefined
  const sides = database
    .select({
      agentId: nativeForkIntents.agentId,
      state: nativeForkIntents.state,
      nativeSessionId: nativeForkIntents.nativeSessionId,
      reason: nativeForkIntents.reason,
      dispatched: nativeForkIntents.dispatched,
      candidateMissing: nativeForkIntents.candidateMissing,
      candidateVerified: nativeForkIntents.candidateVerified,
      nativeWorkState: nativeForkIntents.nativeWorkState,
      hasWitness: sql<number>`${nativeForkIntents.witnessJson} IS NOT NULL`,
    })
    .from(nativeForkIntents)
    .where(eq(nativeForkIntents.operationId, operation.id))
    .all()
  return sessionForkOperationSchema.parse({
    id: operation.id,
    sessionId,
    sourceSessionId: operation.sourceSessionId,
    sourceMessageId: operation.sourceMessageId,
    sourceSequence: operation.sourceSequence,
    revision: operation.revision,
    ready:
      operation.ready &&
      database
        .select({ count: sql<number>`count(*)` })
        .from(nativeAgentContexts)
        .where(eq(nativeAgentContexts.sessionId, sessionId))
        .get()?.count === 2,
    sides: sides.map((side) => ({
      agentId: side.agentId,
      state: side.state,
      nativeSessionId: side.nativeSessionId ?? undefined,
      reason: side.reason?.slice(0, 1024) ?? undefined,
      canInitialize:
        !!side.nativeSessionId &&
        !!side.hasWitness &&
        side.candidateVerified &&
        side.state !== 'ready' &&
        side.nativeWorkState !== 'pending' &&
        side.nativeWorkState !== 'unknown',
      canContinue: !side.dispatched || side.candidateMissing,
    })),
  })
}

export function forkIntent(
  database: PactDrizzleDatabase,
  sessionId: string,
  operationId: string,
  agentId: RuntimeAgentId,
) {
  const operation = readFork(database, sessionId)
  if (!operation || operation.id !== operationId)
    throw new Error('This fork operation is no longer current.')
  const row = database
    .select()
    .from(nativeForkIntents)
    .where(
      and(eq(nativeForkIntents.operationId, operationId), eq(nativeForkIntents.agentId, agentId)),
    )
    .get()
  if (
    !row ||
    Buffer.byteLength(row.sourceJson) > 16 * 1024 ||
    (row.witnessJson && Buffer.byteLength(row.witnessJson) > 1024 * 1024)
  )
    throw new Error('The durable native fork evidence is invalid or oversized.')
  return {
    ...row,
    source: nativeForkBoundarySchema.parse(JSON.parse(row.sourceJson)),
    witness: row.witnessJson
      ? nativeForkWitnessSchema.parse(JSON.parse(row.witnessJson))
      : undefined,
  }
}

export function updateForkIntent(
  database: PactDrizzleDatabase,
  sessionId: string,
  operationId: string,
  agentId: RuntimeAgentId,
  patch: Partial<typeof nativeForkIntents.$inferInsert>,
): SessionForkOperation {
  return database.transaction(() => {
    if (patch.dispatched === true || patch.nativeWorkState === 'pending') {
      assertSessionAvailable(database, sessionId)
      const source = database
        .select({ id: sessionForkOperations.sourceSessionId })
        .from(sessionForkOperations)
        .where(eq(sessionForkOperations.id, operationId))
        .get()
      if (source) assertSessionAvailable(database, source.id)
    }
    const current = database
      .select({
        operationId: nativeForkIntents.operationId,
        sourceJson: nativeForkIntents.sourceJson,
        nativeSessionId: nativeForkIntents.nativeSessionId,
        witnessJson: nativeForkIntents.witnessJson,
        state: nativeForkIntents.state,
        executorId: nativeForkIntents.executorId,
        candidateMissing: nativeForkIntents.candidateMissing,
      })
      .from(nativeForkIntents)
      .innerJoin(sessionForkOperations, eq(sessionForkOperations.id, nativeForkIntents.operationId))
      .where(
        and(
          eq(sessionForkOperations.sessionId, sessionId),
          eq(nativeForkIntents.operationId, operationId),
          eq(nativeForkIntents.agentId, agentId),
        ),
      )
      .get()
    if (!current) throw new Error('This native fork intent is unavailable.')
    const replacingMissing =
      patch.phase === 'fork' && patch.dispatched === true && current.candidateMissing
    const replacingIdentity =
      !!patch.nativeSessionId &&
      !!current.nativeSessionId &&
      patch.nativeSessionId !== current.nativeSessionId
    if ((replacingMissing || replacingIdentity) && current.nativeSessionId && current.witnessJson) {
      const receipt = database
        .select({ id: nativeForkCandidateReceipts.nativeSessionId })
        .from(nativeForkCandidateReceipts)
        .where(
          and(
            eq(nativeForkCandidateReceipts.operationId, operationId),
            eq(nativeForkCandidateReceipts.agentId, agentId),
            eq(nativeForkCandidateReceipts.nativeSessionId, current.nativeSessionId),
          ),
        )
        .get()
      if (!receipt) {
        const totals = database
          .select({
            count: sql<number>`count(*)`,
            bytes: sql<number>`coalesce(sum(length(CAST(${nativeForkCandidateReceipts.witnessJson} AS BLOB))),0)`,
          })
          .from(nativeForkCandidateReceipts)
          .where(
            and(
              eq(nativeForkCandidateReceipts.operationId, operationId),
              eq(nativeForkCandidateReceipts.agentId, agentId),
            ),
          )
          .get()!
        if (
          totals.count >= 8 ||
          totals.bytes + Buffer.byteLength(current.witnessJson) > 8 * 1024 * 1024
        )
          throw new Error(
            'The retained native candidate evidence limit is reached. No replacement was dispatched.',
          )
        database
          .insert(nativeForkCandidateReceipts)
          .values({
            operationId,
            agentId,
            nativeSessionId: current.nativeSessionId,
            witnessJson: current.witnessJson,
            createdAt: new Date().toISOString(),
          })
          .run()
      }
    }
    if (replacingMissing)
      patch = {
        ...patch,
        nativeSessionId: null,
        witnessJson: null,
        candidateMissing: false,
        candidateVerified: false,
      }
    else if (replacingIdentity && !patch.witnessJson)
      patch = { ...patch, witnessJson: null, candidateVerified: false }
    if (patch.witnessJson) {
      if (Buffer.byteLength(patch.witnessJson) > 1024 * 1024)
        throw new Error('The native fork witness is oversized.')
      const witness = nativeForkWitnessSchema.parse(JSON.parse(patch.witnessJson))
      const source = nativeForkBoundarySchema.parse(JSON.parse(current.sourceJson))
      if (
        witness.nativeSessionId !==
          (patch.nativeSessionId === undefined ? current.nativeSessionId : patch.nativeSessionId) ||
        witness.sourceNativeSessionId !== source.nativeSessionId ||
        witness.sourceCutId !== source.nativeCutId ||
        witness.sourcePrefixHash !== source.prefixHash
      )
        throw new Error('The native witness does not belong to this source cutoff.')
    }
    database
      .update(nativeForkIntents)
      .set({ ...patch, operationId, agentId, updatedAt: new Date().toISOString() })
      .where(
        and(eq(nativeForkIntents.operationId, operationId), eq(nativeForkIntents.agentId, agentId)),
      )
      .run()

    appendAgentEvent(database, {
      sessionId,
      runId: operationId,
      eventType: 'native.fork.state_changed',
      createdAt: new Date().toISOString(),
      payload: JSON.stringify({
        agentId,
        previousState: current.state,
        state: patch.state ?? current.state,
        previousCandidate: current.nativeSessionId,
        candidate:
          patch.nativeSessionId === undefined ? current.nativeSessionId : patch.nativeSessionId,
        executorId: patch.executorId ?? current.executorId,
        phase: patch.phase,
        dispatched: patch.dispatched,
        nativeWorkState: patch.nativeWorkState,
        witnessHash: patch.witnessJson
          ? createHash('sha256').update(patch.witnessJson).digest('hex')
          : undefined,
      }),
    })
    const pending = database
      .select({ agentId: nativeForkIntents.agentId })
      .from(nativeForkIntents)
      .where(
        and(
          eq(nativeForkIntents.operationId, operationId),
          sql`${nativeForkIntents.state} <> 'ready'`,
        ),
      )
      .limit(1)
      .get()
    const count = database
      .select({ value: sql<number>`count(*)` })
      .from(nativeForkIntents)
      .where(eq(nativeForkIntents.operationId, operationId))
      .get()?.value
    database
      .update(sessionForkOperations)
      .set({ ready: !pending && count === 2, revision: sql`${sessionForkOperations.revision} + 1` })
      .where(eq(sessionForkOperations.id, operationId))
      .run()
    database
      .update(sessionCatalogRevisions)
      .set({ revision: sql`${sessionCatalogRevisions.revision} + 1` })
      .where(eq(sessionCatalogRevisions.id, 1))
      .run()
    refreshNativeSessionMetadata(database, sessionId)
    return readFork(database, sessionId)!
  })
}

export function completeForkSide(
  database: PactDrizzleDatabase,
  sessionId: string,
  operationId: string,
  agentId: RuntimeAgentId,
  nativeSessionId: string,
  witness: AgentNativeForkWitness,
): SessionForkOperation {
  return database.transaction(() => {
    const intent = forkIntent(database, sessionId, operationId, agentId)
    const validated = nativeForkWitnessSchema.parse(witness)
    if (
      nativeSessionId !== intent.nativeSessionId ||
      validated.nativeSessionId !== nativeSessionId ||
      validated.sourceNativeSessionId !== intent.source.nativeSessionId ||
      validated.sourceCutId !== intent.source.nativeCutId ||
      validated.sourcePrefixHash !== intent.source.prefixHash ||
      !validated.initializedAt ||
      intent.nativeWorkState !== 'settled'
    )
      throw new Error(
        'Native fork identity, cutoff, initialization or settlement has not been confirmed.',
      )
    const map = new Map(validated.idMap)
    const inherited = database
      .select({
        id: agentRuns.id,
        turnId: agentRuns.nativeTurnId,
        nativeInputIdsJson: agentRuns.nativeInputIdsJson,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          eq(agentRuns.agentId, agentId),
          sql`${agentRuns.forkSourceRunId} IS NOT NULL`,
          eq(agentRuns.nativeSessionId, intent.source.nativeSessionId),
          eq(agentRuns.bindingGeneration, intent.source.bindingGeneration),
        ),
      )
      .limit(MAX_ENTITIES + 1)
      .all()
    if (inherited.length > MAX_ENTITIES)
      throw new Error('The native identity map exceeds its record bound.')
    for (const run of inherited) {
      const turnId = run.turnId ? map.get(run.turnId) : undefined
      if (turnId) {
        if (Buffer.byteLength(run.nativeInputIdsJson) > 8192)
          throw new Error('The inherited native input identities exceed their byte bound.')
        const nativeInputIds: unknown = JSON.parse(run.nativeInputIdsJson)
        if (
          !Array.isArray(nativeInputIds) ||
          nativeInputIds.length > 64 ||
          new Set(nativeInputIds).size !== nativeInputIds.length ||
          nativeInputIds.some((id) => typeof id !== 'string' || !id || id.length > 1024) ||
          (nativeInputIds.length > 0 && nativeInputIds[0] !== run.turnId)
        )
          throw new Error('The inherited native input identities are incomplete or invalid.')
        const mappedInputIds = nativeInputIds.map((id) => {
          // Codex preserves opaque Turn/client-message identities verbatim; its
          // witness maps Turn boundaries only. Claude remaps native message UUIDs.
          const mapped = map.get(String(id)) ?? (agentId === 'codex' ? String(id) : undefined)
          if (!mapped)
            throw new Error('The native Fork omitted a consumed input from its identity map.')
          return mapped
        })
        database
          .update(agentRuns)
          .set({
            nativeSessionId,
            nativeTurnId: turnId,
            nativeInputIdsJson: JSON.stringify(mappedInputIds),
            bindingGeneration: 1,
          })
          .where(eq(agentRuns.id, run.id))
          .run()
      }
    }
    if (intent.state !== 'ready')
      database
        .insert(nativeAgentContexts)
        .values({
          sessionId,
          agentId,
          nativeSessionId,
          bindingGeneration: 1,
          executorId: intent.executorId,
          state: 'active',
          continuationState: 'ready',
          recoveryAction: 'none',
          forkThroughSequence: intent.source.deliveryCursor,
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: [nativeAgentContexts.sessionId, nativeAgentContexts.agentId],
          set: {
            nativeSessionId,
            executorId: intent.executorId,
            state: 'active',
            continuationState: 'ready',
            recoveryReason: null,
            recoveryFailureKind: null,
            recoveryFailureMessage: null,
            recoveryAction: 'none',
            lastRunId: null,
            permissionRequestsJson: null,
            updatedAt: new Date().toISOString(),
            forkThroughSequence: intent.source.deliveryCursor,
          },
        })
        .run()
    return updateForkIntent(database, sessionId, operationId, agentId, {
      state: 'ready',
      reason: null,
      candidateMissing: false,
      witnessJson: JSON.stringify(validated),
    })
  })
}

export function forkBlocksInput(database: PactDrizzleDatabase, sessionId: string): boolean {
  return !!database
    .select({ id: sessionForkOperations.id })
    .from(sessionForkOperations)
    .where(
      and(
        eq(sessionForkOperations.sessionId, sessionId),
        sql`(${sessionForkOperations.ready}=0 OR (SELECT count(*) FROM ${nativeAgentContexts} c WHERE c.session_id=${sessionForkOperations.sessionId})<>2)`,
      ),
    )
    .limit(1)
    .get()
}

export function recoverForkIntents(database: PactDrizzleDatabase): void {
  while (true) {
    const page = database.all<{
      sessionId: string
    }>(sql`SELECT DISTINCT f.session_id AS sessionId FROM native_fork_intents n JOIN session_fork_operations f ON f.id=n.operation_id
      WHERE n.native_work_state='pending' OR n.state IN ('forking','initializing') OR (n.state='prepared' AND n.dispatched=0) ORDER BY f.session_id LIMIT 25`)
    if (!page.length) return
    const ids = page.map((row) => row.sessionId)
    database.transaction(() => {
      const scope = sql`${nativeForkIntents.operationId} IN (SELECT id FROM session_fork_operations WHERE session_id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}))`
      database
        .update(nativeForkIntents)
        .set({
          state: 'unconfirmed',
          nativeWorkState: 'unknown',
          reason: 'App exited before native fork or initialization was confirmed.',
          updatedAt: new Date().toISOString(),
        })
        .where(and(scope, eq(nativeForkIntents.nativeWorkState, 'pending')))
        .run()
      database
        .update(nativeForkIntents)
        .set({
          state: 'unconfirmed',
          reason:
            'App exited during native setup. Check this original candidate before continuing.',
          updatedAt: new Date().toISOString(),
        })
        .where(and(scope, sql`${nativeForkIntents.state} IN ('forking','initializing')`))
        .run()
      database
        .update(nativeForkIntents)
        .set({
          state: 'error',
          reason:
            'Native fork was not dispatched before the App exited. Continue this same fork when ready.',
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            scope,
            eq(nativeForkIntents.state, 'prepared'),
            eq(nativeForkIntents.dispatched, false),
          ),
        )
        .run()
      database
        .update(sessionForkOperations)
        .set({ ready: false, revision: sql`${sessionForkOperations.revision} + 1` })
        .where(inArray(sessionForkOperations.sessionId, ids))
        .run()
      database
        .update(sessionCatalogRevisions)
        .set({ revision: sql`${sessionCatalogRevisions.revision} + 1` })
        .where(eq(sessionCatalogRevisions.id, 1))
        .run()
      for (const id of ids) refreshNativeSessionMetadata(database, id)
    })
  }
}

export function forkActorIsCurrent(
  database: PactDrizzleDatabase,
  sessionId: string,
  operationId: string,
  agentId: RuntimeAgentId,
  executorId: string | undefined,
): boolean {
  if (!executorId) return false
  return !!database
    .select({ id: sessionForkOperations.id })
    .from(sessionForkOperations)
    .innerJoin(nativeForkIntents, eq(nativeForkIntents.operationId, sessionForkOperations.id))
    .where(
      and(
        eq(sessionForkOperations.sessionId, sessionId),
        eq(sessionForkOperations.id, operationId),
        eq(nativeForkIntents.agentId, agentId),
        eq(nativeForkIntents.executorId, executorId),
        sql`${nativeForkIntents.state} <> 'ready'`,
      ),
    )
    .limit(1)
    .get()
}

function remapHandoffRefs(
  json: string,
  remap: (value: unknown) => unknown,
  messageId: (id: string) => string,
): string {
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value) || value.length > MAX_ENTITIES)
    throw new Error('Historical context references are invalid.')
  return JSON.stringify(
    value.map((ref) => {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref))
        throw new Error('Historical context reference is invalid.')
      const id: unknown = Reflect.get(ref, 'id'),
        revision: unknown = Reflect.get(ref, 'revision'),
        digest: unknown = Reflect.get(ref, 'digest')
      if (
        typeof id !== 'string' ||
        typeof revision !== 'number' ||
        !Number.isInteger(revision) ||
        revision < 0 ||
        typeof digest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(digest)
      )
        throw new Error('Historical context identity is invalid.')
      const mapped = remap(ref)
      if (!mapped || typeof mapped !== 'object' || Array.isArray(mapped))
        throw new Error('Historical context namespace is invalid.')
      // The original sent digest remains historical evidence; inherited Runs cannot resend it.
      return Object.assign(mapped, { id: messageId(id) })
    }),
  )
}
