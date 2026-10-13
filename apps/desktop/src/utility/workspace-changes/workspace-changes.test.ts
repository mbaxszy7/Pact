import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'

const fileRace = vi.hoisted(() => ({
  afterOpen: undefined as
    | ((path: string, flags: string | number | undefined) => Promise<void>)
    | undefined,
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      try {
        if (typeof args[0] === 'string') await fileRace.afterOpen?.(args[0], args[1])
        return handle
      } catch (error) {
        await handle.close()
        throw error
      }
    },
  }
})

import type { NativeFileChange } from '@pact/agent-runtime'
import type {
  DefaultSessionSettings,
  DirectoryFileOperationInput,
  DirectoryFileOperationResult,
} from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { runDirectoryWorker } from './directory-worker.test-support'
import { WorkspaceChanges } from './workspace-changes'

const migrationsFolder = resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle')
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
  maxDiscussionRounds: 6,
  runningMessagePolicy: 'immediate_safe_point',
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}
async function fixture(
  directoryOperation: (
    input: DirectoryFileOperationInput,
    signal: AbortSignal,
  ) => Promise<DirectoryFileOperationResult> = runDirectoryWorker,
) {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-workspace-test-'))
  const directory = await realpath(temporary),
    root = join(directory, 'project'),
    storage = join(directory, 'storage'),
    filePath = join(directory, 'pact.sqlite')
  let fixtureDatabase: PactDatabase | undefined
  let fixtureModule: WorkspaceChanges | undefined
  try {
    await mkdir(root)
    await promisify(execFile)('git', ['init', '--quiet', root])
    const db = await PactDatabase.open({ filePath, migrationsFolder })
    fixtureDatabase = db
    const projectId = crypto.randomUUID(),
      sessionId = crypto.randomUUID(),
      createdAt = new Date().toISOString()
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Workspace',
      kind: 'git',
      directoryPath: root,
      createdAt,
    })
    db.sessionRepository.create(
      { id: sessionId, projectId, title: 'Workspace', createdAt },
      settings,
    )
    const run = db.conversationRepository.beginRun({
      sessionId,
      clientMessageId: crypto.randomUUID(),
      content: 'Edit files',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    }).run
    const module = new WorkspaceChanges(
      db.workspaceChangesRepository,
      db.sessionRepository,
      db.projectCatalogRepository,
      storage,
      directoryOperation,
      filePath,
    )
    fixtureModule = module
    await module.initialize()
    const signal = new AbortController().signal
    await module.start(run, signal)
    return {
      directory,
      root,
      storage,
      filePath,
      db,
      run,
      module,
      signal,
      async close() {
        await module.dispose()
        db.close()
        await rm(directory, { recursive: true })
      },
    }
  } catch (error) {
    await fixtureModule?.dispose()
    fixtureDatabase?.close()
    await rm(directory, { recursive: true })
    throw error
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function record(
  f: Fixture,
  path: string,
  before: string,
  after: string,
  extra: Partial<NativeFileChange> = {},
) {
  await mkdir(resolve(f.root, path, '..'), { recursive: true })
  await writeFile(join(f.root, path), after)
  await f.module.record(
    f.run.id,
    { operationId: crypto.randomUUID(), path, kind: 'modified', before, after, ...extra },
    f.signal,
  )
}
const before = [
  'export const agent = "before";',
  '',
  ...Array.from({ length: 10 }, (_, index) => `// stable ${index}`),
  '',
  'export const user = "before";',
  '',
].join('\n')
const after = before.replace('agent = "before"', 'agent = "after"')

describe('Passive native file results and whole-card Undo', () => {
  it.skipIf(process.platform !== 'win32')(
    'refuses a swapped Windows candidate without changing its blob or Project through cleanup',
    async () => {
      const f = await fixture()
      let injected = false
      try {
        await record(f, 'review.ts', before, after)
        await f.module.finish(f.run.id)
        const hash = createHash('sha256').update(before).digest('hex')
        const blob = join(f.storage, 'objects', hash.slice(0, 2), hash)
        const blobMode = (await stat(blob)).mode & 0o777
        const project = join(f.root, 'review.ts')
        const original = await stat(project, { bigint: true })
        fileRace.afterOpen = async (path, flags) => {
          if (injected || flags !== 'r' || !basename(path).startsWith('candidate-')) return
          injected = true
          await rename(path, path + '.displaced')
          await link(blob, path)
        }
        await expect(f.module.undo(f.run.id)).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
        expect(injected).toBe(true)
        expect(await readFile(blob, 'utf8')).toBe(before)
        expect((await stat(blob)).mode & 0o777).toBe(blobMode)
        expect((await stat(blob)).nlink).toBe(1)
        expect(await readFile(project, 'utf8')).toBe(after)
        const current = await stat(project, { bigint: true })
        expect([current.ino, current.mode, current.mtimeNs, current.ctimeNs]).toEqual([
          original.ino,
          original.mode,
          original.mtimeNs,
          original.ctimeNs,
        ])
        expect(f.db.workspaceChangesRepository.intents(f.run.id)).toEqual([])
      } finally {
        fileRace.afterOpen = undefined
        await f.close()
      }
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'restores a readonly Windows file without changing its immutable source',
    async () => {
      const f = await fixture()
      try {
        const path = join(f.root, 'readonly.ts')
        await writeFile(path, after)
        await chmod(path, 0o400)
        const mode = (await stat(path)).mode & 0o777
        await f.module.record(
          f.run.id,
          {
            operationId: crypto.randomUUID(),
            path: 'readonly.ts',
            kind: 'modified',
            before,
            after,
          },
          f.signal,
        )
        expect(await f.module.finish(f.run.id)).toMatchObject({ state: 'ready' })
        const hash = createHash('sha256').update(before).digest('hex')
        const blob = join(f.storage, 'objects', hash.slice(0, 2), hash)
        const sourceMode = (await stat(blob)).mode & 0o777
        await f.module.undo(f.run.id)
        expect(await readFile(path, 'utf8')).toBe(before)
        expect((await stat(path)).mode & 0o777).toBe(mode)
        expect(await readFile(blob, 'utf8')).toBe(before)
        expect((await stat(blob)).mode & 0o777).toBe(sourceMode)
      } finally {
        await f.close()
      }
    },
  )

  it('uses Git three-way merge to remove Agent changes while preserving later user edits and current mode', async () => {
    const f = await fixture()
    try {
      await record(f, 'src/review.ts', before, after)
      expect(await f.module.finish(f.run.id)).toMatchObject({ state: 'ready', fileCount: 1 })
      const userEdit = after.replace('user = "before"', 'user = "user edit"')
      await writeFile(join(f.root, 'src/review.ts'), userEdit)
      await chmod(join(f.root, 'src/review.ts'), 0o600)
      const currentMode = (await stat(join(f.root, 'src/review.ts'))).mode & 0o777
      const undone = await f.module.undo(f.run.id)
      expect(undone.state).toBe('undone')
      expect(await readFile(join(f.root, 'src/review.ts'), 'utf8')).toBe(
        before.replace('user = "before"', 'user = "user edit"'),
      )
      expect((await stat(join(f.root, 'src/review.ts'))).mode & 0o777).toBe(
        process.platform === 'win32' ? currentMode : 0o600,
      )
      await expect(f.module.undo(f.run.id)).rejects.toMatchObject({
        code: 'WORKSPACE_UNDO_UNAVAILABLE',
      })
    } finally {
      await f.close()
    }
  })

  it('preflights every file and refuses a conflict in the last file with zero Project writes', async () => {
    const f = await fixture()
    try {
      await record(f, 'a.ts', before, after)
      await record(f, 'z.ts', before, after)
      await f.module.finish(f.run.id)
      const conflict = after.replace('agent = "after"', 'agent = "conflicting user edit"')
      await writeFile(join(f.root, 'z.ts'), conflict)
      const first = await stat(join(f.root, 'a.ts'), { bigint: true }),
        last = await stat(join(f.root, 'z.ts'), { bigint: true })
      await expect(f.module.undo(f.run.id)).rejects.toMatchObject({
        code: 'WORKSPACE_CONFLICT',
        message: expect.stringContaining('No files were changed'),
      })
      expect(await readFile(join(f.root, 'a.ts'), 'utf8')).toBe(after)
      expect(await readFile(join(f.root, 'z.ts'), 'utf8')).toBe(conflict)
      const firstAfter = await stat(join(f.root, 'a.ts'), { bigint: true }),
        lastAfter = await stat(join(f.root, 'z.ts'), { bigint: true })
      expect([firstAfter.ino, firstAfter.mtimeNs, firstAfter.ctimeNs]).toEqual([
        first.ino,
        first.mtimeNs,
        first.ctimeNs,
      ])
      expect([lastAfter.ino, lastAfter.mtimeNs, lastAfter.ctimeNs]).toEqual([
        last.ino,
        last.mtimeNs,
        last.ctimeNs,
      ])
      expect(f.db.workspaceChangesRepository.intents(f.run.id)).toEqual([])
    } finally {
      await f.close()
    }
  })

  it('keeps recorded patches readable although missing complete endpoints disables Undo', async () => {
    const f = await fixture()
    try {
      const patch =
        'diff --git a/src/view.ts b/src/view.ts\n--- a/src/view.ts\n+++ b/src/view.ts\n@@ -1 +1 @@\n-before\n+after\n'
      await mkdir(join(f.root, 'src'))
      await writeFile(join(f.root, 'src/view.ts'), 'after\n')
      await f.module.record(
        f.run.id,
        { operationId: 'patch-only', path: 'src/view.ts', kind: 'modified', patch },
        f.signal,
      )
      expect(await f.module.finish(f.run.id)).toMatchObject({ state: 'mixed', fileCount: 1 })
      expect(
        await f.module.readFile({ changeSetId: f.run.id, path: 'src/view.ts', side: 'patch' }),
      ).toMatchObject({
        status: 'available',
        file: { content: patch, relativePath: 'src/view.ts' },
      })
      expect(
        await f.module.readFile({ changeSetId: f.run.id, path: 'src/view.ts', side: 'after' }),
      ).toMatchObject({ status: 'unavailable', reason: 'not_recorded' })
      await expect(f.module.undo(f.run.id)).rejects.toMatchObject({
        code: 'WORKSPACE_UNDO_UNAVAILABLE',
      })
      expect(await readFile(join(f.root, 'src/view.ts'), 'utf8')).toBe('after\n')
    } finally {
      await f.close()
    }
  })

  it('derives complete after evidence from a native before plus Git patch without replacing native writes', async () => {
    const f = await fixture()
    try {
      const patch =
        'diff --git a/view.ts b/view.ts\n--- a/view.ts\n+++ b/view.ts\n@@ -1 +1 @@\n-before\n+after\n'
      await writeFile(join(f.root, 'view.ts'), 'after\n')
      await f.module.record(
        f.run.id,
        {
          operationId: 'derive-after',
          path: 'view.ts',
          kind: 'modified',
          before: 'before\n',
          patch,
        },
        f.signal,
      )
      expect(await f.module.finish(f.run.id)).toMatchObject({ state: 'ready' })
      expect(
        await f.module.readFile({ changeSetId: f.run.id, path: 'view.ts', side: 'after' }),
      ).toMatchObject({ status: 'available', file: { content: 'after\n' } })
      await f.module.undo(f.run.id)
      expect(await readFile(join(f.root, 'view.ts'), 'utf8')).toBe('before\n')
    } finally {
      await f.close()
    }
  })

  it('does not include unrelated user files and disables Undo when the native round contains mixed writes', async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.root, 'user.ts'), 'user-owned\n')
      await record(f, 'agent.ts', before, after)
      await writeFile(join(f.root, 'agent.ts'), after + '// simultaneous user edit\n')
      const summary = await f.module.finish(f.run.id)
      expect(summary).toMatchObject({
        state: 'mixed',
        fileCount: 1,
        undoUnavailableReason: expect.stringContaining('changed while'),
      })
      expect(f.module.readPage({ changeSetId: f.run.id }).files.map((file) => file.path)).toEqual([
        'agent.ts',
      ])
      await expect(f.module.undo(f.run.id)).rejects.toMatchObject({
        code: 'WORKSPACE_UNDO_UNAVAILABLE',
      })
      expect(await readFile(join(f.root, 'user.ts'), 'utf8')).toBe('user-owned\n')
    } finally {
      await f.close()
    }
  })

  it('retains saved versions for failed/stopped native tasks and reopens the card after restart', async () => {
    const f = await fixture()
    let reopened: PactDatabase | undefined, module: WorkspaceChanges | undefined
    let originalClosed = false
    try {
      await record(f, 'failed.ts', before, after)
      f.db.conversationRepository.failRun(
        f.run.id,
        'user_stopped',
        'User stopped native execution.',
        false,
      )
      await f.module.finish(f.run.id)
      await f.module.dispose()
      f.db.close()
      originalClosed = true
      reopened = await PactDatabase.open({ filePath: f.filePath, migrationsFolder })
      module = new WorkspaceChanges(
        reopened.workspaceChangesRepository,
        reopened.sessionRepository,
        reopened.projectCatalogRepository,
        f.storage,
        runDirectoryWorker,
        f.filePath,
      )
      await module.initialize()
      expect(module.readPage({ changeSetId: f.run.id })).toMatchObject({
        changeSet: { state: 'ready', fileCount: 1 },
        files: [{ path: 'failed.ts' }],
      })
      expect(
        await module.readFile({ changeSetId: f.run.id, path: 'failed.ts', side: 'before' }),
      ).toMatchObject({ status: 'available', file: { content: before } })
    } finally {
      await module?.dispose()
      await f.module.dispose()
      if (!originalClosed) f.db.close()
      reopened?.close()
      await rm(f.directory, { recursive: true })
    }
  })

  it.each(['directory', 'symlink'] as const)(
    'refuses Undo after a file is replaced by a %s and preserves external content',
    async (type) => {
      const f = await fixture()
      try {
        await record(f, 'review.ts', before, after)
        await f.module.finish(f.run.id)
        await rm(join(f.root, 'review.ts'))
        if (type === 'directory') await mkdir(join(f.root, 'review.ts'))
        else {
          await writeFile(join(f.directory, 'external.ts'), 'outside-project\n')
          await symlink(join(f.directory, 'external.ts'), join(f.root, 'review.ts'))
        }
        await expect(f.module.undo(f.run.id)).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
        const protectedValue =
          type === 'directory'
            ? (await stat(join(f.root, 'review.ts'))).isDirectory()
            : await readFile(join(f.directory, 'external.ts'), 'utf8')
        expect(protectedValue).toBe(type === 'directory' ? true : 'outside-project\n')
        expect(f.db.workspaceChangesRepository.intents(f.run.id)).toEqual([])
      } finally {
        await f.close()
      }
    },
  )

  it('preserves external writes and recovery evidence when Undo installation is interrupted, including restart', async () => {
    let injectExternalWrite = false
    const f = await fixture(async (input, signal) => {
      if (injectExternalWrite && input.operation === 'install') {
        injectExternalWrite = false
        await writeFile(
          join(input.rootPath, ...input.directories, input.name),
          'external write after preflight\n',
        )
      }
      return runDirectoryWorker(input, signal)
    })
    let reopened: PactDatabase | undefined, module: WorkspaceChanges | undefined
    let originalClosed = false
    try {
      await record(f, 'race.ts', before, after)
      await f.module.finish(f.run.id)
      injectExternalWrite = true
      await expect(f.module.undo(f.run.id)).rejects.toMatchObject({
        code: 'WORKSPACE_RECOVERY_REQUIRED',
        message: expect.stringContaining('not a zero-change preflight refusal'),
      })
      const intent = f.db.workspaceChangesRepository.intents(f.run.id)[0]!
      expect(intent).toMatchObject({
        kind: 'undo',
        status: 'recovery_required',
        reconciledAt: null,
      })
      const files = intent.payload['files']
      if (
        !Array.isArray(files) ||
        !files[0] ||
        typeof files[0] !== 'object' ||
        !('backup' in files[0]) ||
        typeof files[0].backup !== 'string'
      )
        throw new Error('Missing durable backup reference')
      const backup = files[0].backup
      expect(await readFile(backup, 'utf8')).toBe(after)
      expect(await readFile(join(f.root, 'race.ts'), 'utf8')).toBe(
        'external write after preflight\n',
      )
      await f.module.dispose()
      f.db.close()
      originalClosed = true
      reopened = await PactDatabase.open({ filePath: f.filePath, migrationsFolder })
      module = new WorkspaceChanges(
        reopened.workspaceChangesRepository,
        reopened.sessionRepository,
        reopened.projectCatalogRepository,
        f.storage,
        runDirectoryWorker,
        f.filePath,
      )
      expect(await module.initialize()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: f.run.id, state: 'recovery_required' }),
        ]),
      )
      await expect(
        module.reserve(f.run.sessionId, 'recovery-observation', true),
      ).rejects.toMatchObject({
        code: 'WORKSPACE_RECOVERY_REQUIRED',
        message: expect.stringContaining('No Project files were changed'),
      })
      expect(await readFile(join(f.root, 'race.ts'), 'utf8')).toBe(
        'external write after preflight\n',
      )
      expect(await readFile(backup, 'utf8')).toBe(after)
      expect(reopened.workspaceChangesRepository.findIntent(intent.id)?.status).toBe(
        'recovery_required',
      )
    } finally {
      await module?.dispose()
      await f.module.dispose()
      if (!originalClosed) f.db.close()
      reopened?.close()
      await rm(f.directory, { recursive: true })
    }
  })
})
