import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'

import {
  workspaceArchivePreviewSchema,
  workspaceArchiveReceiptSchema,
  type WorkspaceArchivePreview,
  type WorkspaceArchiveReceipt,
  type WorkspaceArchiveScope,
} from '@pact/contracts'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import {
  projects,
  sessions,
  collaborationInputs,
  workspaceArchiveOperations as operations,
} from './schema/index.js'

export class WorkspaceArchiveConflictError extends Error {}

export function workspaceArchiveBlocked(
  database: PactDrizzleDatabase,
  projectId: string,
  sessionId?: string,
  allowUnresolved = false,
): boolean {
  return Boolean(
    database
      .select({ id: operations.id })
      .from(operations)
      .where(
        and(
          eq(operations.projectId, projectId),
          // Match the partial index predicate literally; bound state parameters do not imply it.
          sql`${operations.state} IN ('stopping', 'unresolved')`,
          allowUnresolved ? eq(operations.state, 'stopping') : undefined,
          sessionId
            ? or(isNull(operations.sessionId), eq(operations.sessionId, sessionId))
            : undefined,
        ),
      )
      .limit(1)
      .get(),
  )
}

export function assertProjectAvailable(database: PactDrizzleDatabase, projectId: string): void {
  const project = database
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get()
  const projectFence = database
    .select({ id: operations.id })
    .from(operations)
    .where(
      and(
        eq(operations.projectId, projectId),
        isNull(operations.sessionId),
        sql`${operations.state} IN ('stopping', 'unresolved')`,
      ),
    )
    .limit(1)
    .get()
  if (!project || project.archivedAt || projectFence)
    throw new WorkspaceArchiveConflictError(
      'This Project is archived or is being archived. Nothing new was started.',
    )
}

export function assertSessionAvailable(
  database: PactDrizzleDatabase,
  sessionId: string,
  allowUnresolved = false,
): void {
  const session = database
    .select({
      projectId: sessions.projectId,
      archivedAt: sessions.archivedAt,
      status: sessions.status,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get()
  if (!session || session.archivedAt || session.status === 'archived')
    throw new WorkspaceArchiveConflictError('This Session is archived. Nothing new was started.')
  const project = database
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, session.projectId))
    .get()
  if (
    !project ||
    project.archivedAt ||
    workspaceArchiveBlocked(database, session.projectId, sessionId, allowUnresolved)
  )
    throw new WorkspaceArchiveConflictError(
      'This Session or its Project is being archived. Nothing new was started.',
    )
}

export function assertArchiveCommit(
  database: PactDrizzleDatabase,
  scope: WorkspaceArchiveScope,
  operationId?: string,
): void {
  const context = new WorkspaceArchiveRepository(database).context(scope)
  if (
    workspaceArchiveBlocked(
      database,
      context.projectId,
      scope.kind === 'session' ? scope.sessionId : undefined,
    )
  ) {
    const receipt = operationId
      ? new WorkspaceArchiveRepository(database).read(operationId)
      : undefined
    if (
      !receipt ||
      receipt.state !== 'stopping' ||
      JSON.stringify(receipt.preview.scope) !== JSON.stringify(scope)
    )
      throw new WorkspaceArchiveConflictError('Another archive operation is still settling.')
  }
  if (archiveScopeHasNativeWork(database, scope))
    throw new WorkspaceArchiveConflictError(
      'Native work has not been confirmed ended. Nothing was archived.',
    )
}

/** Durable native-work predicates include old bindings and both sides of Forks. */
export function archiveScopeHasNativeWork(
  database: PactDrizzleDatabase,
  scope: WorkspaceArchiveScope,
  ignoredRunIds: string[] = [],
): boolean {
  const ignored = ignoredRunIds.length
    ? sql`AND r.id NOT IN (${sql.join(
        ignoredRunIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``
  const ignoredContexts = ignoredRunIds.length
    ? sql`AND (n.last_run_id IS NULL OR n.last_run_id NOT IN (${sql.join(
        ignoredRunIds.map((id) => sql`${id}`),
        sql`, `,
      )}))`
    : sql``
  return Boolean(
    database
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          scope.kind === 'session'
            ? eq(sessions.id, scope.sessionId)
            : eq(sessions.projectId, scope.projectId),
          sql`(
      EXISTS (SELECT 1 FROM agent_runs r WHERE r.session_id=${sessions.id} AND r.fork_source_run_id IS NULL ${ignored}
        AND ((r.status IN ('starting','running','recovering') AND r.control_disposition <> 'abandoned') OR r.native_effects_state IN ('pending','unknown')
          OR (r.dispatch_phase IN ('possibly_sent','accepted','ended') AND r.native_outcome IS NULL)))
      OR EXISTS (SELECT 1 FROM native_rebuild_operations r WHERE r.session_id=${sessions.id} AND r.native_work_state IN ('pending','unknown'))
      OR EXISTS (SELECT 1 FROM native_agent_contexts n WHERE n.session_id=${sessions.id} AND n.continuation_state IN ('responding','waiting_user') ${ignoredContexts})
      OR EXISTS (SELECT 1 FROM session_fork_operations f JOIN native_fork_intents i ON i.operation_id=f.id
        WHERE (f.session_id=${sessions.id} OR f.source_session_id=${sessions.id}) AND i.native_work_state IN ('pending','unknown'))
    )`,
        ),
      )
      .limit(1)
      .get(),
  )
}

export class WorkspaceArchiveRepository {
  constructor(private readonly database: PactDrizzleDatabase) {}

  unresolvedOperations(scope: WorkspaceArchiveScope): string[] {
    const context = this.context(scope)
    const rows = this.database
      .select({ id: operations.id })
      .from(operations)
      .where(
        and(
          eq(operations.projectId, context.projectId),
          sql`${operations.state} IN ('stopping', 'unresolved')`,
          eq(operations.state, 'unresolved'),
          scope.kind === 'session'
            ? or(isNull(operations.sessionId), eq(operations.sessionId, scope.sessionId))
            : undefined,
        ),
      )
      .limit(6)
      .all()
    if (rows.length > 5)
      throw new WorkspaceArchiveConflictError(
        'Check earlier archives on the affected Sessions individually before archiving this Project.',
      )
    return rows.map((row) => row.id)
  }

  sessionMetadata(sessionId: string) {
    return this.database
      .select({ title: sessions.title, projectId: sessions.projectId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get()
  }

  pendingInputs(scope: WorkspaceArchiveScope) {
    return this.database
      .select({ sessionId: collaborationInputs.sessionId, id: collaborationInputs.id })
      .from(collaborationInputs)
      .innerJoin(sessions, eq(sessions.id, collaborationInputs.sessionId))
      .where(
        and(
          scope.kind === 'session'
            ? eq(sessions.id, scope.sessionId)
            : eq(sessions.projectId, scope.projectId),
          inArray(collaborationInputs.state, ['accepted', 'blocked']),
        ),
      )
      .limit(6)
      .all()
  }

  blocksSession(sessionId: string, allowUnresolved = false): boolean {
    try {
      assertSessionAvailable(this.database, sessionId, allowUnresolved)
      return false
    } catch (error) {
      if (error instanceof WorkspaceArchiveConflictError) return true
      throw error
    }
  }

  hasNativeWork(scope: WorkspaceArchiveScope, ignoredRunIds: string[] = []): boolean {
    return archiveScopeHasNativeWork(this.database, scope, ignoredRunIds)
  }

  context(scope: WorkspaceArchiveScope): { title: string; projectId: string } {
    if (scope.kind === 'project') {
      const project = this.database
        .select()
        .from(projects)
        .where(eq(projects.id, scope.projectId))
        .get()
      if (!project || project.archivedAt)
        throw new WorkspaceArchiveConflictError('This Project is no longer available.')
      return { title: project.name, projectId: project.id }
    }
    const session = this.database
      .select({
        title: sessions.title,
        projectId: sessions.projectId,
        archivedAt: sessions.archivedAt,
      })
      .from(sessions)
      .where(eq(sessions.id, scope.sessionId))
      .get()
    if (!session || session.archivedAt)
      throw new WorkspaceArchiveConflictError('This Session is no longer available.')
    const project = this.database
      .select({ archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, session.projectId))
      .get()
    if (!project || project.archivedAt)
      throw new WorkspaceArchiveConflictError('This Project is no longer available.')
    return { title: session.title, projectId: session.projectId }
  }

  prepare(preview: WorkspaceArchivePreview, ownerId: string): WorkspaceArchivePreview {
    const validated = workspaceArchivePreviewSchema.parse(preview)
    const json = JSON.stringify(validated)
    if (Buffer.byteLength(json) > 16 * 1024)
      throw new WorkspaceArchiveConflictError(
        'The archive preview is too large. Nothing was stopped.',
      )
    return this.database.transaction(() => {
      const prior = this.read(preview.operationId)
      if (prior) {
        if (JSON.stringify(prior.preview.scope) !== JSON.stringify(preview.scope))
          throw new WorkspaceArchiveConflictError('This archive operation belongs to another item.')
        return prior.preview
      }
      this.context(preview.scope)
      const now = new Date().toISOString()
      // One open confirmation per Utility; replacing a preview has no task effects.
      this.database
        .update(operations)
        .set({ state: 'cancelled', updatedAt: now })
        .where(and(eq(operations.ownerId, ownerId), sql`${operations.state} = 'prepared'`))
        .run()
      this.database
        .insert(operations)
        .values({
          id: preview.operationId,
          projectId: preview.projectId,
          sessionId: preview.scope.kind === 'session' ? preview.scope.sessionId : null,
          ownerId,
          state: 'prepared',
          previewJson: json,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      return validated
    })
  }

  read(operationId: string): WorkspaceArchiveReceipt | undefined {
    const row = this.database.select().from(operations).where(eq(operations.id, operationId)).get()
    if (!row) return undefined
    if (Buffer.byteLength(row.previewJson) + Buffer.byteLength(row.resultsJson) > 32 * 1024)
      throw new Error('The archive receipt exceeds its read budget.')
    return workspaceArchiveReceiptSchema.parse({
      preview: JSON.parse(row.previewJson),
      state: row.state,
      tasks: JSON.parse(row.resultsJson),
      ...(row.message ? { message: row.message } : {}),
    })
  }

  claim(
    operationId: string,
    ownerId: string,
    currentTasks: WorkspaceArchivePreview['tasks'],
    ownedRunIds: string[],
    retirePending: () => void,
  ): WorkspaceArchiveReceipt {
    return this.database.transaction(() => {
      const receipt = this.read(operationId)
      const row = this.database
        .select({ ownerId: operations.ownerId })
        .from(operations)
        .where(eq(operations.id, operationId))
        .get()
      if (
        !receipt ||
        receipt.state !== 'prepared' ||
        row?.ownerId !== ownerId ||
        Date.now() >= Date.parse(receipt.preview.expiresAt)
      )
        throw new WorkspaceArchiveConflictError(
          'This confirmation expired. Review the current tasks before archiving.',
        )
      if (receipt.preview.blockedReason)
        throw new WorkspaceArchiveConflictError(receipt.preview.blockedReason)
      if (
        currentTasks.some(
          (task) =>
            !receipt.preview.tasks.some(
              (prior) => prior.sessionId === task.sessionId && prior.identity === task.identity,
            ),
        )
      )
        throw new WorkspaceArchiveConflictError(
          'The running tasks changed. Review them again before stopping anything.',
        )
      this.context(receipt.preview.scope)
      if (archiveScopeHasNativeWork(this.database, receipt.preview.scope, ownedRunIds))
        throw new WorkspaceArchiveConflictError(
          'Other native work entered this item. Review its current state before stopping anything.',
        )
      if (
        workspaceArchiveBlocked(
          this.database,
          receipt.preview.projectId,
          receipt.preview.scope.kind === 'session' ? receipt.preview.scope.sessionId : undefined,
        )
      )
        throw new WorkspaceArchiveConflictError(
          'Another archive operation is still settling. Nothing new was stopped.',
        )
      this.database
        .update(operations)
        .set({ state: 'stopping', updatedAt: new Date().toISOString() })
        .where(and(eq(operations.id, operationId), eq(operations.state, 'prepared')))
        .run()
      retirePending()
      return this.read(operationId)!
    })
  }

  cancel(operationId: string): WorkspaceArchiveReceipt {
    this.database
      .update(operations)
      .set({ state: 'cancelled', updatedAt: new Date().toISOString() })
      .where(and(eq(operations.id, operationId), eq(operations.state, 'prepared')))
      .run()
    const receipt = this.read(operationId)
    if (!receipt)
      throw new WorkspaceArchiveConflictError('This archive operation no longer exists.')
    return receipt
  }

  finish<T>(operationId: string, tasks: WorkspaceArchiveReceipt['tasks'], commit: () => T): T {
    return this.database.transaction(() => {
      const receipt = this.read(operationId)
      if (
        !receipt ||
        receipt.state !== 'stopping' ||
        archiveScopeHasNativeWork(this.database, receipt.preview.scope)
      )
        throw new WorkspaceArchiveConflictError(
          'Native work has not been confirmed ended. Nothing was archived.',
        )
      const result = commit()
      this.database
        .update(operations)
        .set({
          state: 'archived',
          resultsJson: JSON.stringify(tasks),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(operations.id, operationId), eq(operations.state, 'stopping')))
        .run()
      return result
    })
  }

  fail(
    operationId: string,
    tasks: WorkspaceArchiveReceipt['tasks'],
    message: string,
    unresolved: boolean,
  ): void {
    this.database
      .update(operations)
      .set({
        state: unresolved ? 'unresolved' : 'not_archived',
        resultsJson: JSON.stringify(tasks),
        message,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(operations.id, operationId), eq(operations.state, 'stopping')))
      .run()
  }

  recover(ownerId: string): void {
    this.database
      .update(operations)
      .set({
        state: 'unresolved',
        message:
          'Pact closed before this archive finished. It has not been resumed. Check the remaining native work.',
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          sql`${operations.state} IN ('stopping', 'unresolved')`,
          eq(operations.state, 'stopping'),
          ne(operations.ownerId, ownerId),
        ),
      )
      .run()
  }

  releaseResolved(operationId: string): void {
    const receipt = this.read(operationId)
    if (
      !receipt ||
      receipt.state !== 'unresolved' ||
      archiveScopeHasNativeWork(this.database, receipt.preview.scope)
    )
      return
    this.database
      .update(operations)
      .set({
        state: 'not_archived',
        resultsJson: JSON.stringify(
          receipt.tasks.map((task) =>
            task.outcome === 'unresolved' ? Object.assign({}, task, { outcome: 'finished' }) : task,
          ),
        ),
        message:
          'The remaining work has ended. Nothing was archived; review the item again to archive it.',
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(operations.id, operationId), eq(operations.state, 'unresolved')))
      .run()
  }
}
