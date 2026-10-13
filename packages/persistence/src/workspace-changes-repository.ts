import { and, asc, count, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm'

import {
  WORKSPACE_CHANGE_FILES,
  WORKSPACE_CHANGE_PAGE_FILES,
  WORKSPACE_FILE_BYTES,
  WORKSPACE_STORAGE_BYTES,
  workspaceChangeSetSchema,
  workspaceChangesPageSchema,
  workspaceChangesReadInputSchema,
  workspaceFileChangeSchema,
  type RuntimeAgentId,
  type WorkspaceChangeSet,
  type WorkspaceChangesPage,
  type WorkspaceChangesReadInput,
  type WorkspaceFileChange,
} from '@pact/contracts'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import {
  agentRuns,
  pactSchemaMeta,
  sessions,
  workspaceBlobs,
  workspaceChangeIntents,
  workspaceChangeSets,
  workspaceFileChanges,
} from './schema/index.js'

export const WORKSPACE_ROUND_INTENTS = 1_024
export const WORKSPACE_INTENT_BYTES = 1024 * 1024
const PENDING_INTENT_PAGE_ITEMS = 100
const STORAGE_BYTES_KEY = 'workspace_storage_bytes'

export type WorkspaceChangeSetRecord = WorkspaceChangeSet & {
  root: string
  rootDevice: string
  rootInode: string
  stagingRoot: string
}

export interface WorkspaceChangeIntent {
  id: string
  changeSetId: string
  kind: 'write' | 'delete' | 'move' | 'undo'
  payload: Record<string, unknown>
  retainedBytes: number
  status: 'pending' | 'applied' | 'recovery_required'
  createdAt: string
  updatedAt: string
  reconciledAt: string | null
}

/** Durable metadata only: Utility owns blob writes and filesystem application/recovery. */
export class WorkspaceChangesRepository {
  constructor(private readonly database: PactDrizzleDatabase) {}

  begin(input: {
    runId: string
    sessionId: string
    projectId: string
    agentId: RuntimeAgentId
    root: string
    rootDevice: string
    rootInode: string
    stagingRoot: string
  }): WorkspaceChangeSet {
    const run = this.database
      .select({
        sessionId: agentRuns.sessionId,
        agentId: agentRuns.agentId,
        projectId: sessions.projectId,
      })
      .from(agentRuns)
      .innerJoin(sessions, eq(agentRuns.sessionId, sessions.id))
      .where(eq(agentRuns.id, input.runId))
      .get()
    if (
      !run ||
      run.sessionId !== input.sessionId ||
      run.projectId !== input.projectId ||
      run.agentId !== input.agentId
    )
      throw new Error('Workspace changes do not belong to this Agent Run.')
    for (const path of [input.root, input.stagingRoot]) {
      if (!path || path.length > 4096) throw new Error('Invalid workspace storage path.')
    }
    WorkspaceChangesRepository.validateRootIdentity(input.rootDevice, input.rootInode)
    const previous = this.find(input.runId)
    if (previous) {
      if (
        previous.root !== input.root ||
        previous.rootDevice !== input.rootDevice ||
        previous.rootInode !== input.rootInode ||
        previous.stagingRoot !== input.stagingRoot
      )
        throw new Error('Workspace change storage cannot be replaced.')
      return this.summary(input.runId)
    }
    const changeSet = workspaceChangeSetSchema.parse({
      id: input.runId,
      runId: input.runId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      agentId: input.agentId,
      state: 'recording',
      fileCount: 0,
      additions: 0,
      deletions: 0,
      undoUnavailableReason: null,
      createdAt: new Date().toISOString(),
      finalizedAt: null,
    })
    this.database
      .insert(workspaceChangeSets)
      .values({
        ...changeSet,
        root: input.root,
        rootDevice: input.rootDevice,
        rootInode: input.rootInode,
        stagingRoot: input.stagingRoot,
      })
      .run()
    return changeSet
  }

  summary(id: string): WorkspaceChangeSet {
    const {
      root: _root,
      rootDevice: _rootDevice,
      rootInode: _rootInode,
      stagingRoot: _stagingRoot,
      ...summary
    } = this.require(id)
    const incompleteCounts = this.database
      .select({ path: workspaceFileChanges.path })
      .from(workspaceFileChanges)
      .where(
        and(
          eq(workspaceFileChanges.changeSetId, id),
          sql`(${workspaceFileChanges.additions} IS NULL OR ${workspaceFileChanges.deletions} IS NULL)`,
        ),
      )
      .limit(1)
      .get()
    return workspaceChangeSetSchema.parse({
      ...summary,
      countsAvailable: incompleteCounts === undefined,
    })
  }

  find(id: string): WorkspaceChangeSetRecord | undefined {
    const row = this.database
      .select()
      .from(workspaceChangeSets)
      .where(eq(workspaceChangeSets.id, id))
      .get()
    if (!row) return undefined
    return WorkspaceChangesRepository.toSet(row)
  }

  /** Cold startup reconciliation reads only metadata; no Project file is touched. */
  recoverableSets(afterId?: string): WorkspaceChangeSetRecord[] {
    const unpublished = this.database
      .select({ id: workspaceChangeSets.id })
      .from(workspaceChangeSets)
      .where(
        and(
          afterId === undefined ? undefined : gt(workspaceChangeSets.id, afterId),
          sql`NOT EXISTS (SELECT 1 FROM ${agentRuns} r WHERE r.id=${workspaceChangeSets.runId} AND r.fork_source_run_id IS NOT NULL)`,
          sql`(${workspaceChangeSets.projectionPending} = 1 OR ${workspaceChangeSets.state} = 'recording' OR ${workspaceChangeSets.finalizedAt} IS NULL)`,
        ),
      )
    const appliedUndo = this.database
      .select({ id: workspaceChangeSets.id })
      .from(workspaceChangeIntents)
      .innerJoin(
        workspaceChangeSets,
        eq(workspaceChangeIntents.changeSetId, workspaceChangeSets.id),
      )
      .where(
        and(
          afterId === undefined ? undefined : gt(workspaceChangeSets.id, afterId),
          ne(workspaceChangeSets.state, 'undone'),
          sql`${workspaceChangeIntents.kind} = 'undo' AND ${workspaceChangeIntents.status} = 'applied' AND ${workspaceChangeIntents.reconciledAt} IS NULL`,
        ),
      )
    const candidates = unpublished
      .union(appliedUndo)
      .orderBy(asc(sql`id`))
      .limit(PENDING_INTENT_PAGE_ITEMS)
    return this.database
      .select()
      .from(workspaceChangeSets)
      .where(inArray(workspaceChangeSets.id, candidates))
      .orderBy(asc(workspaceChangeSets.id))
      .all()
      .map((changeSet) => WorkspaceChangesRepository.toSet(changeSet))
  }

  hasRecoveryForRoot(root: string): boolean {
    return (
      this.database
        .select({ id: workspaceChangeSets.id })
        .from(workspaceChangeSets)
        .where(
          and(
            eq(workspaceChangeSets.root, root),
            sql`NOT EXISTS (SELECT 1 FROM ${agentRuns} r WHERE r.id=${workspaceChangeSets.runId} AND r.fork_source_run_id IS NOT NULL)`,
            eq(workspaceChangeSets.state, 'recovery_required'),
          ),
        )
        .limit(1)
        .get() !== undefined
    )
  }

  file(id: string, path: string): WorkspaceFileChange | undefined {
    const row = this.database
      .select()
      .from(workspaceFileChanges)
      .where(and(eq(workspaceFileChanges.changeSetId, id), eq(workspaceFileChanges.path, path)))
      .get()
    return row ? WorkspaceChangesRepository.toFile(row) : undefined
  }

  files(id: string): WorkspaceFileChange[] {
    this.require(id)
    const rows = this.database
      .select()
      .from(workspaceFileChanges)
      .where(eq(workspaceFileChanges.changeSetId, id))
      .orderBy(asc(workspaceFileChanges.path))
      .limit(WORKSPACE_CHANGE_FILES + 1)
      .all()
    if (rows.length > WORKSPACE_CHANGE_FILES)
      throw new Error('Workspace changes exceed the round file limit.')
    return rows.map((row) => WorkspaceChangesRepository.toFile(row))
  }

  readPage(input: WorkspaceChangesReadInput): WorkspaceChangesPage {
    const { changeSetId, afterPath } = workspaceChangesReadInputSchema.parse(input)
    const rows = this.database
      .select()
      .from(workspaceFileChanges)
      .where(
        and(
          eq(workspaceFileChanges.changeSetId, changeSetId),
          eq(workspaceFileChanges.hidden, false),
          afterPath === undefined ? undefined : gt(workspaceFileChanges.path, afterPath),
        ),
      )
      .orderBy(asc(workspaceFileChanges.path))
      .limit(WORKSPACE_CHANGE_PAGE_FILES + 1)
      .all()
    const files = rows
      .slice(0, WORKSPACE_CHANGE_PAGE_FILES)
      .map((row) => WorkspaceChangesRepository.toFile(row))
    return workspaceChangesPageSchema.parse({
      changeSet: this.summary(changeSetId),
      files,
      nextPath: rows.length > WORKSPACE_CHANGE_PAGE_FILES ? (files.at(-1)?.path ?? null) : null,
    })
  }

  recordFiles(id: string, changes: WorkspaceFileChange[], reason?: string): WorkspaceChangeSet {
    if (changes.length > WORKSPACE_CHANGE_FILES)
      throw new Error('Workspace changes exceed the round file limit.')
    const parsed = changes.map((change) => workspaceFileChangeSchema.parse(change))
    const unavailableReason = WorkspaceChangesRepository.reason(reason)
    this.database.transaction(() => {
      const current = this.require(id)
      if (current.state !== 'recording')
        throw new Error('Finalized workspace versions cannot be replaced.')
      const files = new Map(this.files(id).map((file) => [file.path, file]))
      for (const change of parsed) {
        const previous = files.get(change.path)
        const before = previous?.before ?? change.before
        const previousPath = previous?.previousPath ?? change.previousPath
        const next: WorkspaceFileChange = {
          ...change,
          before,
          // An observation gap invalidates the endpoint, not its last confirmed bytes.
          after: change.afterAvailable === false && previous ? previous.after : change.after,
          previousPath,
          kind:
            change.afterAvailable === false && previous
              ? previous.kind
              : change.beforeAvailable === false || change.afterAvailable === false
                ? change.kind
                : previousPath
                  ? 'renamed'
                  : before.hash === null
                    ? 'added'
                    : change.after.hash === null
                      ? 'deleted'
                      : 'modified',
          beforeAvailable: previous?.beforeAvailable ?? change.beforeAvailable,
          modeKnown:
            previous?.modeKnown === false || change.modeKnown === false
              ? false
              : (previous?.modeKnown ?? change.modeKnown),
          patchVersions: [...(previous?.patchVersions ?? []), ...(change.patchVersions ?? [])],
          reason: previous?.reason ?? change.reason,
        }
        if (next.beforeAvailable === false || next.afterAvailable === false) {
          next.additions = null
          next.deletions = null
        }
        // A later complete operation cannot turn an unknown original into a known absence.
        if (
          next.beforeAvailable === false ||
          next.afterAvailable === false ||
          next.undoStrategy === 'patch' ||
          previous?.undoStrategy === 'unavailable'
        ) {
          next.undoStrategy = 'unavailable'
          next.reason ??=
            'Complete original and final native file versions are unavailable for Undo.'
        }
        if (
          previousPath === null &&
          next.beforeAvailable !== false &&
          next.afterAvailable !== false &&
          next.undoStrategy !== 'unavailable' &&
          before.hash === next.after.hash &&
          before.bytes === next.after.bytes &&
          before.mode === next.after.mode
        ) {
          files.delete(next.path)
          this.database
            .delete(workspaceFileChanges)
            .where(
              and(
                eq(workspaceFileChanges.changeSetId, id),
                eq(workspaceFileChanges.path, next.path),
              ),
            )
            .run()
          continue
        }
        files.set(next.path, next)
        workspaceFileChangeSchema.parse(next)
        if (files.size > WORKSPACE_CHANGE_FILES)
          throw new Error('Workspace changes exceed the round file limit.')
        this.database
          .insert(workspaceFileChanges)
          .values(WorkspaceChangesRepository.fileRow(id, next))
          .onConflictDoUpdate({
            target: [workspaceFileChanges.changeSetId, workspaceFileChanges.path],
            set: {
              previousPath: next.previousPath,
              kind: next.kind,
              afterHash: next.after.hash,
              afterBytes: next.after.bytes,
              afterMode: next.after.mode,
              additions: next.additions,
              deletions: next.deletions,
              hidden: next.hidden,
              reason: next.reason,
              nativeEvidenceJson: WorkspaceChangesRepository.fileRow(id, next).nativeEvidenceJson,
            },
          })
          .run()
      }
      const all = [...files.values()]
      const visible = all.filter((file) => !file.hidden)
      this.database
        .update(workspaceChangeSets)
        .set({
          projectionPending: true,
          revision: sql`${workspaceChangeSets.revision} + 1`,
          fileCount: visible.length,
          additions: visible.reduce((total, file) => total + (file.additions ?? 0), 0),
          deletions: visible.reduce((total, file) => total + (file.deletions ?? 0), 0),
          undoUnavailableReason:
            current.undoUnavailableReason ??
            unavailableReason ??
            parsed.find((file) => file.reason)?.reason ??
            all.find((file) => file.reason)?.reason ??
            null,
        })
        .where(eq(workspaceChangeSets.id, id))
        .run()
    })
    return this.summary(id)
  }

  observeUncertainEffects(id: string): void {
    this.database
      .update(workspaceChangeSets)
      .set({
        effectsUncertain: true,
        projectionPending: true,
        revision: sql`${workspaceChangeSets.revision} + 1`,
      })
      .where(eq(workspaceChangeSets.id, id))
      .run()
  }

  /** Restart cannot prove the final endpoint of a native recording that never settled. */
  recoverInterruptedRecording(id: string): WorkspaceChangeSet {
    this.database.transaction(() => {
      const current = this.require(id)
      if (current.state !== 'recording') return
      const run = this.database
        .select({ nativeEffectsState: agentRuns.nativeEffectsState })
        .from(agentRuns)
        .where(eq(agentRuns.id, current.runId))
        .get()
      if (run?.nativeEffectsState === 'settled') return
      const reason =
        'Native file recording was interrupted before completion was confirmed. Original versions, last confirmed bytes and patches are retained; the final version and Undo are unavailable.'
      for (const file of this.files(id)) {
        const unavailable: WorkspaceFileChange = {
          ...file,
          afterAvailable: false,
          undoStrategy: 'unavailable',
          reason: file.reason ?? reason,
          additions: null,
          deletions: null,
        }
        this.database
          .update(workspaceFileChanges)
          .set({
            nativeEvidenceJson: WorkspaceChangesRepository.fileRow(id, unavailable)
              .nativeEvidenceJson,
            reason: unavailable.reason,
            additions: null,
            deletions: null,
          })
          .where(
            and(eq(workspaceFileChanges.changeSetId, id), eq(workspaceFileChanges.path, file.path)),
          )
          .run()
      }
      this.database
        .update(workspaceChangeSets)
        .set({
          state: 'mixed',
          projectionPending: true,
          revision: sql`${workspaceChangeSets.revision} + 1`,
          additions: 0,
          deletions: 0,
          undoUnavailableReason: current.undoUnavailableReason ?? reason,
          finalizedAt: current.finalizedAt ?? new Date().toISOString(),
        })
        .where(eq(workspaceChangeSets.id, id))
        .run()
    })
    return this.summary(id)
  }

  finalize(id: string): WorkspaceChangeSet {
    this.database.transaction(() => {
      const current = this.require(id)
      if (current.state !== 'recording' && current.state !== 'recovery_required') return
      const unfinished = this.database
        .select({ id: workspaceChangeIntents.id })
        .from(workspaceChangeIntents)
        .where(
          and(
            eq(workspaceChangeIntents.changeSetId, id),
            ne(workspaceChangeIntents.status, 'applied'),
            isNull(workspaceChangeIntents.reconciledAt),
          ),
        )
        .limit(1)
        .get()
      const recoveryRequired = current.state === 'recovery_required' || unfinished !== undefined
      this.database
        .update(workspaceChangeSets)
        .set({
          projectionPending: true,
          revision: sql`${workspaceChangeSets.revision} + 1`,
          state: recoveryRequired
            ? 'recovery_required'
            : current.undoUnavailableReason
              ? 'mixed'
              : 'ready',
          undoUnavailableReason:
            current.undoUnavailableReason ??
            (unfinished ? 'This round contains an unfinished file operation.' : null),
          finalizedAt: current.finalizedAt ?? new Date().toISOString(),
        })
        .where(eq(workspaceChangeSets.id, id))
        .run()
    })
    return this.summary(id)
  }

  markRecoveryRequired(id: string, reason: string): WorkspaceChangeSet {
    const current = this.require(id)
    if (current.state === 'undone') throw new Error('The round has already been undone.')
    this.database
      .update(workspaceChangeSets)
      .set({
        projectionPending: true,
        revision: sql`${workspaceChangeSets.revision} + 1`,
        state: 'recovery_required',
        undoUnavailableReason:
          current.undoUnavailableReason ?? WorkspaceChangesRepository.reason(reason),
      })
      .where(eq(workspaceChangeSets.id, id))
      .run()
    return this.summary(id)
  }

  /** Metadata settlement is atomic here; filesystem application remains Utility-owned. */
  completeUndo(intentId: string, id: string): WorkspaceChangeSet {
    this.database.transaction(() => {
      const intent = this.findIntent(intentId)
      const current = this.require(id)
      if (!intent || intent.changeSetId !== id || intent.kind !== 'undo')
        throw new Error('This Undo intent does not belong to the round.')
      if (current.state === 'undone' && intent.status === 'applied') return
      if (current.state !== 'ready') throw new Error('This round cannot complete Undo safely.')
      this.database
        .update(workspaceChangeIntents)
        .set({ status: 'applied', reconciledAt: null, updatedAt: new Date().toISOString() })
        .where(eq(workspaceChangeIntents.id, intentId))
        .run()
      this.database
        .update(workspaceChangeSets)
        .set({
          state: 'undone',
          projectionPending: true,
          revision: sql`${workspaceChangeSets.revision} + 1`,
          finalizedAt: current.finalizedAt ?? new Date().toISOString(),
        })
        .where(eq(workspaceChangeSets.id, id))
        .run()
    })
    return this.summary(id)
  }

  /** Settles observed state only; original intent payloads and recovery blobs remain intact. */
  settleRecovery(id: string, observedIntentIds: string[], reason: string): WorkspaceChangeSet {
    if (!observedIntentIds.length || observedIntentIds.length > WORKSPACE_ROUND_INTENTS)
      throw new Error('Invalid recovery observation count.')
    const observed = new Set(observedIntentIds)
    if (observed.size !== observedIntentIds.length)
      throw new Error('Recovery observations contain duplicate intents.')
    const observedReason = WorkspaceChangesRepository.reason(reason)
    this.database.transaction(() => {
      const current = this.require(id)
      if (current.state !== 'recovery_required')
        throw new Error('This round is not waiting for filesystem reconciliation.')
      const unresolved = this.intents(id).filter(
        (intent) =>
          intent.reconciledAt === null && (intent.status !== 'applied' || intent.kind === 'undo'),
      )
      if (
        unresolved.length !== observed.size ||
        unresolved.some((intent) => !observed.has(intent.id))
      )
        throw new Error('Not every interrupted operation has been observed.')
      const now = new Date().toISOString()
      this.database
        .update(workspaceChangeSets)
        .set({
          state: 'mixed',
          projectionPending: true,
          revision: sql`${workspaceChangeSets.revision} + 1`,
          finalizedAt: current.finalizedAt ?? now,
          undoUnavailableReason: observedReason,
        })
        .where(eq(workspaceChangeSets.id, id))
        .run()
      this.database
        .update(workspaceChangeIntents)
        .set({
          reconciledAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(workspaceChangeIntents.changeSetId, id),
            inArray(workspaceChangeIntents.id, observedIntentIds),
            isNull(workspaceChangeIntents.reconciledAt),
          ),
        )
        .run()
    })
    return this.summary(id)
  }

  /** All retained blob versions and write-ahead payloads count toward storage admission. */
  blobBytes(): number {
    const stored = this.database
      .select({ value: pactSchemaMeta.value })
      .from(pactSchemaMeta)
      .where(eq(pactSchemaMeta.key, STORAGE_BYTES_KEY))
      .get()
    if (stored) return WorkspaceChangesRepository.parseStorageBytes(stored.value)
    return this.database.transaction(() => {
      const existing = this.database
        .select({ value: pactSchemaMeta.value })
        .from(pactSchemaMeta)
        .where(eq(pactSchemaMeta.key, STORAGE_BYTES_KEY))
        .get()
      if (existing) return WorkspaceChangesRepository.parseStorageBytes(existing.value)
      // One cold reconstruction for an older/missing counter, never one SUM per file.
      const blobs =
        this.database
          .select({ bytes: sql<number>`coalesce(sum(${workspaceBlobs.bytes}), 0)` })
          .from(workspaceBlobs)
          .get()?.bytes ?? 0
      const intents =
        this.database
          .select({
            bytes: sql<number>`coalesce(sum(${workspaceChangeIntents.payloadBytes} + ${workspaceChangeIntents.retainedBytes}), 0)`,
          })
          .from(workspaceChangeIntents)
          .get()?.bytes ?? 0
      const total = WorkspaceChangesRepository.parseStorageBytes(String(blobs + intents))
      this.database
        .insert(pactSchemaMeta)
        .values({ key: STORAGE_BYTES_KEY, value: String(total) })
        .run()
      return total
    })
  }

  recordBlob(hash: string, bytes: number): void {
    if (
      !/^[a-f\d]{64}$/u.test(hash) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > WORKSPACE_FILE_BYTES
    )
      throw new Error('Invalid workspace blob metadata.')
    this.database.transaction(() => {
      const existing = this.database
        .select()
        .from(workspaceBlobs)
        .where(eq(workspaceBlobs.hash, hash))
        .get()
      if (existing) {
        if (existing.bytes !== bytes)
          throw new Error('Workspace blob size does not match its hash.')
        return
      }
      const storedBytes = this.blobBytes()
      if (storedBytes + bytes > WORKSPACE_STORAGE_BYTES)
        throw new Error('Workspace recovery storage is full.')
      this.database
        .insert(workspaceBlobs)
        .values({ hash, bytes, createdAt: new Date().toISOString() })
        .run()
      this.storeStorageBytes(storedBytes + bytes)
    })
  }

  intent(
    input: Pick<WorkspaceChangeIntent, 'id' | 'changeSetId' | 'kind' | 'payload'> & {
      status?: WorkspaceChangeIntent['status']
      retainedBytes?: number
    },
  ): WorkspaceChangeIntent {
    if (!input.id || input.id.length > 512 || !WorkspaceChangesRepository.isPayload(input.payload))
      throw new Error('Invalid workspace operation intent.')
    const retainedBytes = input.retainedBytes ?? 0
    if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0)
      throw new Error('Invalid workspace backup size.')
    const payloadJson = JSON.stringify(input.payload)
    const payloadBytes = Buffer.byteLength(payloadJson, 'utf8')
    if (payloadBytes > WORKSPACE_INTENT_BYTES)
      throw new Error('Workspace operation intent is too large.')
    const payload: unknown = JSON.parse(payloadJson)
    if (!WorkspaceChangesRepository.isPayload(payload))
      throw new Error('Invalid workspace operation intent.')
    let exceededStorage = false
    this.database.transaction(() => {
      const existing = this.database
        .select()
        .from(workspaceChangeIntents)
        .where(eq(workspaceChangeIntents.id, input.id))
        .get()
      if (existing) {
        if (
          existing.changeSetId !== input.changeSetId ||
          existing.kind !== input.kind ||
          existing.payloadJson !== payloadJson
        )
          throw new Error('Workspace operation intent cannot be replaced.')
        if (retainedBytes > existing.retainedBytes) {
          const storedBytes = this.blobBytes() + retainedBytes - existing.retainedBytes
          exceededStorage = storedBytes > WORKSPACE_STORAGE_BYTES
          this.database
            .update(workspaceChangeIntents)
            .set({
              retainedBytes,
              ...(exceededStorage ? { status: 'recovery_required' as const } : {}),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(workspaceChangeIntents.id, input.id))
            .run()
          this.storeStorageBytes(storedBytes)
          if (exceededStorage)
            this.markRecoveryRequired(
              input.changeSetId,
              'An external change exceeded the reserved workspace backup storage.',
            )
        }
        return
      }
      const current = this.require(input.changeSetId)
      if (input.kind === 'undo' ? current.state !== 'ready' : current.state !== 'recording')
        throw new Error('This workspace round cannot accept another operation.')
      const intents =
        this.database
          .select({ value: count() })
          .from(workspaceChangeIntents)
          .where(eq(workspaceChangeIntents.changeSetId, input.changeSetId))
          .get()?.value ?? 0
      if (intents >= WORKSPACE_ROUND_INTENTS)
        throw new Error('Workspace changes exceed the round operation limit.')
      const storedBytes = this.blobBytes() + payloadBytes + retainedBytes
      if (storedBytes > WORKSPACE_STORAGE_BYTES)
        throw new Error('Workspace recovery storage is full.')
      const now = new Date().toISOString()
      this.database
        .insert(workspaceChangeIntents)
        .values({
          id: input.id,
          changeSetId: input.changeSetId,
          kind: input.kind,
          payloadJson,
          payloadBytes,
          retainedBytes,
          status: input.status ?? 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      this.storeStorageBytes(storedBytes)
    })
    if (exceededStorage)
      throw new Error(
        'Workspace recovery storage exceeded its limit; recovery evidence was preserved.',
      )
    const intent = this.findIntent(input.id)
    if (!intent) throw new Error('Workspace operation intent was not saved.')
    return intent
  }

  findIntent(id: string): WorkspaceChangeIntent | undefined {
    const row = this.database
      .select()
      .from(workspaceChangeIntents)
      .where(eq(workspaceChangeIntents.id, id))
      .get()
    return row ? WorkspaceChangesRepository.toIntent(row) : undefined
  }

  completeIntent(id: string, status: 'applied' | 'recovery_required'): WorkspaceChangeIntent {
    const current = this.findIntent(id)
    if (!current) throw new Error('Workspace operation intent does not exist.')
    if (current.status === 'applied' && status !== 'applied')
      throw new Error('An applied workspace intent cannot be reopened.')
    this.database
      .update(workspaceChangeIntents)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(workspaceChangeIntents.id, id))
      .run()
    const updated = this.findIntent(id)
    if (!updated) throw new Error('Workspace operation intent does not exist.')
    return updated
  }

  /** The file owner proved no installation began; retain the audit without claiming Undo. */
  cancelUnappliedUndo(id: string): void {
    const current = this.findIntent(id)
    if (!current || current.kind !== 'undo' || current.status !== 'pending' || current.reconciledAt)
      throw new Error('This Undo intent cannot be cancelled before application.')
    this.database
      .update(workspaceChangeIntents)
      .set({ reconciledAt: new Date().toISOString() })
      .where(eq(workspaceChangeIntents.id, id))
      .run()
  }

  pendingIntents(afterId?: string): WorkspaceChangeIntent[] {
    return this.database
      .select()
      .from(workspaceChangeIntents)
      .where(
        and(
          isNull(workspaceChangeIntents.reconciledAt),
          sql`(${workspaceChangeIntents.status} <> 'applied' OR (${workspaceChangeIntents.kind} = 'undo' AND EXISTS (SELECT 1 FROM ${workspaceChangeSets} WHERE ${workspaceChangeSets.id} = ${workspaceChangeIntents.changeSetId} AND ${workspaceChangeSets.state} <> 'undone')))`,
          afterId === undefined ? undefined : gt(workspaceChangeIntents.id, afterId),
        ),
      )
      .orderBy(asc(workspaceChangeIntents.id))
      .limit(PENDING_INTENT_PAGE_ITEMS)
      .all()
      .map((row) => WorkspaceChangesRepository.toIntent(row))
  }

  intents(id: string): WorkspaceChangeIntent[] {
    this.require(id)
    const rows = this.database
      .select()
      .from(workspaceChangeIntents)
      .where(eq(workspaceChangeIntents.changeSetId, id))
      .orderBy(asc(workspaceChangeIntents.id))
      .limit(WORKSPACE_ROUND_INTENTS + 1)
      .all()
    if (rows.length > WORKSPACE_ROUND_INTENTS)
      throw new Error('Workspace changes exceed the round operation limit.')
    return rows.map((row) => WorkspaceChangesRepository.toIntent(row))
  }

  private require(id: string): WorkspaceChangeSetRecord {
    const record = this.find(id)
    if (!record) throw new Error('Workspace changes do not exist.')
    return record
  }

  private storeStorageBytes(bytes: number): void {
    const value = String(WorkspaceChangesRepository.parseStorageBytes(String(bytes)))
    this.database
      .update(pactSchemaMeta)
      .set({ value })
      .where(eq(pactSchemaMeta.key, STORAGE_BYTES_KEY))
      .run()
  }

  private static parseStorageBytes(value: string): number {
    const bytes = Number(value)
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error('The durable workspace storage counter is invalid.')
    return bytes
  }

  private static toSet(row: typeof workspaceChangeSets.$inferSelect): WorkspaceChangeSetRecord {
    const {
      root,
      rootDevice,
      rootInode,
      stagingRoot,
      projectionPending: _projectionPending,
      ...summary
    } = row
    WorkspaceChangesRepository.validateRootIdentity(rootDevice, rootInode)
    return { ...workspaceChangeSetSchema.parse(summary), root, rootDevice, rootInode, stagingRoot }
  }

  private static validateRootIdentity(device: string, inode: string): void {
    if (!/^(0|[1-9]\d{0,39})$/u.test(device) || !/^(0|[1-9]\d{0,39})$/u.test(inode))
      throw new Error('The Project directory identity is invalid.')
  }

  private static reason(value: string | undefined): string | null {
    if (value === undefined) return null
    if (!value || value.length > 1024) throw new Error('Invalid workspace Undo warning.')
    return value
  }

  private static toFile(row: typeof workspaceFileChanges.$inferSelect): WorkspaceFileChange {
    return workspaceFileChangeSchema.parse({
      path: row.path,
      previousPath: row.previousPath,
      kind: row.kind,
      before: { hash: row.beforeHash, bytes: row.beforeBytes, mode: row.beforeMode },
      after: { hash: row.afterHash, bytes: row.afterBytes, mode: row.afterMode },
      additions: row.additions,
      deletions: row.deletions,
      hidden: row.hidden,
      reason: row.reason,
      ...(row.nativeEvidenceJson ? JSON.parse(row.nativeEvidenceJson) : {}),
    })
  }

  private static fileRow(
    id: string,
    file: WorkspaceFileChange,
  ): typeof workspaceFileChanges.$inferInsert {
    return {
      changeSetId: id,
      path: file.path,
      previousPath: file.previousPath,
      kind: file.kind,
      beforeHash: file.before.hash,
      beforeBytes: file.before.bytes,
      beforeMode: file.before.mode,
      afterHash: file.after.hash,
      afterBytes: file.after.bytes,
      afterMode: file.after.mode,
      additions: file.additions,
      deletions: file.deletions,
      hidden: file.hidden,
      reason: file.reason,
      nativeEvidenceJson: JSON.stringify({
        beforeAvailable: file.beforeAvailable,
        afterAvailable: file.afterAvailable,
        modeKnown: file.modeKnown,
        undoStrategy: file.undoStrategy,
        patchVersions: file.patchVersions,
      }),
    }
  }

  private static toIntent(row: typeof workspaceChangeIntents.$inferSelect): WorkspaceChangeIntent {
    const payload: unknown = JSON.parse(row.payloadJson)
    if (!WorkspaceChangesRepository.isPayload(payload))
      throw new Error('The saved workspace intent is invalid.')
    return {
      id: row.id,
      changeSetId: row.changeSetId,
      kind: row.kind,
      payload,
      retainedBytes: row.retainedBytes,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      reconciledAt: row.reconciledAt,
    }
  }

  private static isPayload(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}
