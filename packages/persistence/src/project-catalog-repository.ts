import { and, asc, eq, isNull } from 'drizzle-orm'

import type { Project, ProjectCatalogState, ProjectNameChange } from '@pact/contracts'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { updateProjectNativeVisibility } from './native-presence-metadata.js'
import { projects } from './schema/index.js'
import { assertArchiveCommit, workspaceArchiveBlocked } from './workspace-archive-repository.js'

export class ProjectCatalogRepository {
  constructor(private readonly database: PactDrizzleDatabase) {}

  read(): ProjectCatalogState {
    return {
      projects: this.database
        .select()
        .from(projects)
        .where(isNull(projects.archivedAt))
        .orderBy(asc(projects.createdAt))
        .all()
        .map((project) => ProjectCatalogRepository.toProject(project)),
    }
  }

  find(projectId: string): Project | undefined {
    const project = this.database.select().from(projects).where(eq(projects.id, projectId)).get()
    return project ? ProjectCatalogRepository.toProject(project) : undefined
  }

  add(project: Project): ProjectCatalogState {
    return this.database.transaction(() => {
      const existing = this.database
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.directoryPath, project.directoryPath))
        .get()
      if (existing && workspaceArchiveBlocked(this.database, existing.id))
        throw new Error('This Project archive is still settling.')
      this.database
        .insert(projects)
        .values({ ...project, archivedAt: null })
        .onConflictDoUpdate({
          target: projects.directoryPath,
          set: { kind: project.kind, archivedAt: null },
        })
        .run()
      updateProjectNativeVisibility(this.database, existing?.id ?? project.id)
      return this.read()
    })
  }

  archive(projectId: string, operationId?: string): ProjectCatalogState {
    return this.database.transaction(() => {
      assertArchiveCommit(this.database, { kind: 'project', projectId }, operationId)
      const archivedAt = new Date().toISOString()
      const result = this.database
        .update(projects)
        .set({ archivedAt })
        .where(eq(projects.id, projectId))
        .run()
      if (result.changes === 0) throw new Error('Project does not exist.')
      updateProjectNativeVisibility(this.database, projectId)
      return this.read()
    })
  }

  rename(input: ProjectNameChange): ProjectNameChange {
    const change = this.database
      .update(projects)
      .set({ name: input.name })
      .where(and(eq(projects.id, input.projectId), isNull(projects.archivedAt)))
      .returning({ projectId: projects.id, name: projects.name })
      .get()
    if (!change) throw new Error('Active Project does not exist.')
    return change
  }

  restore(projectId: string): ProjectCatalogState {
    return this.database.transaction(() => {
      if (workspaceArchiveBlocked(this.database, projectId))
        throw new Error(
          'This Project archive is still settling. Check its result before restoring.',
        )
      const result = this.database
        .update(projects)
        .set({ archivedAt: null })
        .where(eq(projects.id, projectId))
        .run()
      if (result.changes === 0) throw new Error('Project does not exist.')
      updateProjectNativeVisibility(this.database, projectId)
      return this.read()
    })
  }

  private static toProject(row: typeof projects.$inferSelect): Project {
    const project: Project = {
      id: row.id,
      name: row.name,
      directoryPath: row.directoryPath,
      kind: row.kind,
      createdAt: row.createdAt,
    }
    if (row.archivedAt) project.archivedAt = row.archivedAt
    return project
  }
}
