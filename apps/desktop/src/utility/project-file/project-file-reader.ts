import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  AnchoredComment,
  CommentSourceResolution,
  DirectoryFileOperationInput,
  DirectoryFileOperationResult,
  FileCommentAnchor,
  ProjectFile,
  ProjectFileReadInput,
  RpcResult,
} from '@pact/contracts'

import { PROJECT_FILE_PREVIEW_TIMEOUT_MS } from '@pact/contracts'
import { ProjectCatalogRepository, SessionRepository } from '@pact/persistence'

const MAX_FILE_BYTES = 1024 * 1024

class ProjectFileError extends Error {}

export class ProjectFileReader {
  private active:
    | { controller: AbortController; promise: Promise<RpcResult<ProjectFile>> }
    | undefined
  private disposed = false

  constructor(
    private readonly sessions: SessionRepository,
    private readonly projects: ProjectCatalogRepository,
    private readonly directoryOperation: (
      input: DirectoryFileOperationInput,
      signal: AbortSignal,
    ) => Promise<DirectoryFileOperationResult>,
  ) {}

  read(input: ProjectFileReadInput): Promise<RpcResult<ProjectFile>> {
    if (this.disposed || this.active)
      return Promise.resolve({
        ok: false,
        error: {
          code: 'RUNTIME_UNAVAILABLE',
          message: 'File preview is busy or closing. Try again.',
        },
      })
    const controller = new AbortController()
    const deadlineAt = Date.now() + PROJECT_FILE_PREVIEW_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), PROJECT_FILE_PREVIEW_TIMEOUT_MS)
    const promise = this.readFile(input, controller.signal, deadlineAt).finally(() => {
      clearTimeout(timer)
      this.active = undefined
    })
    this.active = { controller, promise }
    return promise
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const active = this.active
    active?.controller.abort()
    await active?.promise
  }

  private async readFile(
    input: ProjectFileReadInput,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<RpcResult<ProjectFile>> {
    try {
      const session = this.sessions.find(input.sessionId)
      if (!session || session.status === 'archived') {
        throw new ProjectFileError('This Session is unavailable.')
      }
      const project = this.projects.find(session.projectId)
      if (!project || project.archivedAt) {
        throw new ProjectFileError('This Project is unavailable.')
      }

      const projectRoot = await realpath(project.directoryPath)
      signal.throwIfAborted()
      let localPath = /^file:/iu.test(input.path) ? fileURLToPath(input.path) : input.path
      if (process.platform === 'win32') localPath = localPath.replace(/^\/(?=[a-z]:[\\/])/iu, '')
      const requestedPath = isAbsolute(localPath) ? localPath : resolve(projectRoot, localPath)
      const canonicalPath = await realpath(requestedPath)
      signal.throwIfAborted()
      const relativePath = relative(projectRoot, canonicalPath)
      const isExternal =
        relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
      if (isExternal && !isAbsolute(localPath)) {
        throw new ProjectFileError('Use an absolute path to preview a file outside this Project.')
      }

      const rootPath = parse(canonicalPath).root
      const root = await lstat(rootPath, { bigint: true })
      signal.throwIfAborted()
      if (!root.isDirectory() || root.isSymbolicLink())
        throw new ProjectFileError('The file root is unavailable.')
      const parts = relative(rootPath, canonicalPath).split(sep)
      const name = parts.pop()
      if (!name) throw new ProjectFileError('This link does not point to a file.')
      const read = await this.directoryOperation(
        {
          operation: 'preview',
          rootPath,
          rootDevice: root.dev.toString(),
          rootInode: root.ino.toString(),
          directories: parts,
          name,
          deadlineAt,
        },
        signal,
      )
      signal.throwIfAborted()
      if (!read.ok) throw new ProjectFileError(read.message)
      if (!read.existed || !read.preview || read.hash === null)
        throw new ProjectFileError('Pact could not read this local file.')
      const { content, updatedAt } = read.preview

      const lineCount = content ? content.replace(/\r\n?/gu, '\n').split('\n').length : 0
      if (input.lineStart && input.lineStart > lineCount) {
        throw new ProjectFileError('The linked line is outside this file.')
      }
      const lineEnd = input.lineStart ? (input.lineEnd ?? input.lineStart) : undefined
      if (lineEnd && lineEnd > lineCount) {
        throw new ProjectFileError('The linked line range is outside this file.')
      }

      const result: RpcResult<ProjectFile> = {
        ok: true,
        value: {
          sessionId: input.sessionId,
          relativePath,
          absolutePath: canonicalPath,
          ...(isExternal ? { isExternal: true } : {}),
          content,
          contentHash: read.hash,
          lineCount,
          updatedAt,
          ...(input.lineStart ? { lineStart: input.lineStart } : {}),
          ...(lineEnd ? { lineEnd } : {}),
        },
      }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_FILE_BYTES) {
        throw new ProjectFileError('This file is too large to preview.')
      }
      return result
    } catch (error) {
      if (signal.aborted)
        return {
          ok: false,
          error: {
            code: this.disposed ? 'RUNTIME_UNAVAILABLE' : 'TIMEOUT',
            message: this.disposed ? 'File preview is closing.' : 'File preview timed out.',
          },
        }
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message:
            error instanceof ProjectFileError
              ? error.message
              : 'Pact could not read this local file.',
        },
      }
    }
  }

  async validateCommentAnchor(sessionId: string, anchor: FileCommentAnchor): Promise<void> {
    const source = await this.read({ sessionId, path: anchor.path })
    if (!source.ok) throw new ProjectFileError(source.error.message)
    if (source.value.isExternal) {
      throw new ProjectFileError('File Comments must refer to a file inside this Project.')
    }
    if (source.value.contentHash !== anchor.contentHash) {
      throw new ProjectFileError('The file changed before this Comment could be saved.')
    }
    if (ProjectFileReader.quoteForRange(source.value.content, anchor) !== anchor.quote) {
      throw new ProjectFileError('The selected file range no longer matches its quoted text.')
    }
  }

  async resolveCommentSource(
    sessionId: string,
    comment: AnchoredComment,
  ): Promise<RpcResult<CommentSourceResolution>> {
    if (comment.anchor.type !== 'file') {
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'Comment is not attached to a file.' },
      }
    }
    const source = await this.read({ sessionId, path: comment.anchor.path })
    if (!source.ok || source.value.isExternal) {
      return {
        ok: true,
        value: {
          status: 'outdated',
          commentId: comment.id,
          quote: comment.anchor.quote,
          reason: source.ok
            ? 'This Comment source is outside the current Project.'
            : source.error.message,
        },
      }
    }
    if (
      source.value.contentHash !== comment.anchor.contentHash ||
      ProjectFileReader.quoteForRange(source.value.content, comment.anchor) !== comment.anchor.quote
    ) {
      return {
        ok: true,
        value: {
          status: 'outdated',
          commentId: comment.id,
          quote: comment.anchor.quote,
          reason: 'This file no longer matches the version quoted by the Comment.',
        },
      }
    }
    return {
      ok: true,
      value: { status: 'resolved', commentId: comment.id, anchor: comment.anchor },
    }
  }

  private static quoteForRange(content: string, anchor: FileCommentAnchor): string | undefined {
    const lines = content.replace(/\r\n?/gu, '\n').split('\n')
    if (anchor.startLine > lines.length || anchor.endLine > lines.length) return undefined
    const start = lines[anchor.startLine - 1]
    const end = lines[anchor.endLine - 1]
    if (
      start === undefined ||
      end === undefined ||
      anchor.startColumn > start.length + 1 ||
      anchor.endColumn > end.length + 1
    ) {
      return undefined
    }
    if (anchor.startLine === anchor.endLine) {
      return start.slice(anchor.startColumn - 1, anchor.endColumn - 1)
    }
    return [
      start.slice(anchor.startColumn - 1),
      ...lines.slice(anchor.startLine, anchor.endLine - 1),
      end.slice(0, anchor.endColumn - 1),
    ].join('\n')
  }
}
