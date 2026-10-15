import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import type {
  Project,
  ProjectArchiveInput,
  ProjectCatalogState,
  ProjectDirectoryAddInput,
  ProjectKind,
  ProjectNameChange,
  ProjectContext,
  ProjectContextInput,
  RpcResult,
} from '@pact/contracts'

import { projectContextSchema, projectNameChangeSchema } from '@pact/contracts'
import { ProjectCatalogRepository } from '@pact/persistence'

import { workspaceGit } from '../workspace-changes/workspace-git'

class ProjectDirectoryError extends Error {}

export class ProjectCatalog {
  private contextRead:
    | {
        projectId: string
        controller: AbortController
        promise: Promise<RpcResult<ProjectContext>>
      }
    | undefined
  private disposed = false

  constructor(private readonly repository: ProjectCatalogRepository) {}

  readContext(input: ProjectContextInput): Promise<RpcResult<ProjectContext>> {
    if (this.disposed || (this.contextRead && this.contextRead.projectId !== input.projectId))
      return Promise.resolve({
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Project context is busy. Try again.' },
      })
    if (this.contextRead) return this.contextRead.promise
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 2_000)
    const promise = this.inspectContext(input.projectId, controller.signal).finally(() => {
      clearTimeout(deadline)
      this.contextRead = undefined
    })
    this.contextRead = { projectId: input.projectId, controller, promise }
    return promise
  }

  dispose(): void {
    this.disposed = true
    this.contextRead?.controller.abort()
  }

  private async inspectContext(
    projectId: string,
    signal: AbortSignal,
  ): Promise<RpcResult<ProjectContext>> {
    try {
      const project = this.repository.find(projectId)
      if (!project || project.archivedAt)
        return {
          ok: false,
          error: { code: 'VALIDATION', message: 'This project is no longer available.' },
        }
      const directoryPath = await realpath(project.directoryPath)
      if (directoryPath !== project.directoryPath || !(await stat(directoryPath)).isDirectory())
        throw new Error('Project directory changed.')
      signal.throwIfAborted()
      let git: ProjectContext['git'] = { state: 'none' }
      // Branch metadata follows the containing repository, while the registered
      // Project remains the exact user-selected directory with its original kind.
      let ancestor = directoryPath
      let repositoryFound = false
      for (let depth = 0; depth < 128; depth += 1) {
        signal.throwIfAborted()
        try {
          // oxlint-disable-next-line no-await-in-loop -- Inspect one nearest ancestor at a time; do not enumerate project files.
          await stat(join(ancestor, '.git'))
          repositoryFound = true
          break
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
            git = { state: 'unavailable' }
            break
          }
        }
        const parent = dirname(ancestor)
        if (parent === ancestor) break
        ancestor = parent
        if (depth === 127) git = { state: 'unavailable' }
      }
      signal.throwIfAborted()
      if (repositoryFound) {
        try {
          const branch = await workspaceGit(
            ['symbolic-ref', '--quiet', '--short', 'HEAD'],
            directoryPath,
            signal,
          )
          if (branch.code === 0)
            git = { state: 'branch', name: branch.output.replace(/\r?\n$/u, '') }
          else if (branch.code === 1) {
            const head = await workspaceGit(
              ['rev-parse', '--verify', '--short=8', 'HEAD'],
              directoryPath,
              signal,
            )
            git =
              head.code === 0
                ? { state: 'detached', commit: head.output.trim() }
                : { state: 'unavailable' }
          } else git = { state: 'unavailable' }
        } catch {
          git = { state: 'unavailable' }
        }
      }
      // Validate complete identifiers; never turn a truncated/invalid Git result into a name.
      const value = projectContextSchema.safeParse({
        projectId,
        directoryPath,
        folderName: basename(directoryPath),
        git,
      })
      if (!value.success) {
        return {
          ok: true,
          value: projectContextSchema.parse({
            projectId,
            directoryPath,
            folderName: basename(directoryPath),
            git: { state: 'unavailable' },
          }),
        }
      }
      return { ok: true, value: value.data }
    } catch {
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: 'Couldn’t read the project folder. Check that it is still available.',
        },
      }
    }
  }

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
      return { ok: true, value: this.repository.archive(input.projectId, input.operationId) }
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
