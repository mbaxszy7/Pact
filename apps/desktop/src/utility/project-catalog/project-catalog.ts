import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import type {
  Project,
  ProjectArchiveInput,
  ProjectCatalogState,
  ProjectDirectoryAddInput,
  ProjectKind,
  ProjectNameChange,
  RpcResult,
} from '@pact/contracts'

import { projectNameChangeSchema } from '@pact/contracts'
import { ProjectCatalogRepository } from '@pact/persistence'

class ProjectDirectoryError extends Error {}

export class ProjectCatalog {
  constructor(private readonly repository: ProjectCatalogRepository) {}

  load(): RpcResult<ProjectCatalogState> {
    try {
      return { ok: true, value: this.repository.read() }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Projects could not be loaded.' },
      }
    }
  }

  async add(input: ProjectDirectoryAddInput): Promise<RpcResult<ProjectCatalogState>> {
    try {
      const project = await this.inspectProjectDirectory(input.directoryPath)
      return { ok: true, value: this.repository.add(project) }
    } catch (error) {
      if (error instanceof ProjectDirectoryError) {
        return { ok: false, error: { code: 'VALIDATION', message: error.message } }
      }
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'The project could not be added.' },
      }
    }
  }

  archive(input: ProjectArchiveInput): RpcResult<ProjectCatalogState> {
    try {
      return { ok: true, value: this.repository.archive(input.projectId) }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'The Project could not be archived.' },
      }
    }
  }

  restore(input: ProjectArchiveInput): RpcResult<ProjectCatalogState> {
    try {
      return { ok: true, value: this.repository.restore(input.projectId) }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'The Project could not be restored.' },
      }
    }
  }

  rename(input: ProjectNameChange): RpcResult<ProjectNameChange> {
    const parsed = projectNameChangeSchema.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: 'Use a single-line Project name of 1–120 characters.',
        },
      }
    }
    try {
      return { ok: true, value: this.repository.rename(parsed.data) }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Couldn’t rename the Project. Try again.' },
      }
    }
  }

  private async inspectProjectDirectory(directoryPath: string): Promise<Project> {
    if (!isAbsolute(directoryPath)) {
      throw new ProjectDirectoryError('Choose a local project folder.')
    }

    let canonicalPath: string
    try {
      canonicalPath = await realpath(directoryPath)
      const metadata = await stat(canonicalPath)
      if (!metadata.isDirectory()) throw new ProjectDirectoryError('Choose a project folder.')
    } catch (error) {
      if (error instanceof ProjectDirectoryError) throw error
      throw new ProjectDirectoryError('The selected project folder is no longer available.')
    }

    const name = basename(canonicalPath)
    if (!name) throw new ProjectDirectoryError('The filesystem root cannot be added as a project.')

    return {
      id: randomUUID(),
      name,
      directoryPath: canonicalPath,
      kind: await ProjectCatalog.detectProjectKind(canonicalPath),
      createdAt: new Date().toISOString(),
    }
  }

  private static async detectProjectKind(directoryPath: string): Promise<ProjectKind> {
    try {
      await stat(join(directoryPath, '.git'))
      return 'git'
    } catch {
      return 'directory'
    }
  }
}
