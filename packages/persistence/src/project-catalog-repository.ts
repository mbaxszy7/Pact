import { and, asc, eq, isNull } from 'drizzle-orm'

import type { Project, ProjectCatalogState, ProjectNameChange } from '@pact/contracts'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { projects } from './schema/index.js'

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
    this.database
      .insert(projects)
      .values({ ...project, archivedAt: null })
      .onConflictDoUpdate({
        target: projects.directoryPath,
        set: { kind: project.kind, archivedAt: null },
      })
      .run()
    return this.read()
  }

  archive(projectId: string): ProjectCatalogState {
    const archivedAt = new Date().toISOString()
    const result = this.database
      .update(projects)
      .set({ archivedAt })
      .where(eq(projects.id, projectId))
      .run()
    if (result.changes === 0) throw new Error('Project does not exist.')
    return this.read()
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
    const result = this.database
      .update(projects)
      .set({ archivedAt: null })
      .where(eq(projects.id, projectId))
      .run()
    if (result.changes === 0) throw new Error('Project does not exist.')
    return this.read()
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
