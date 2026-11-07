import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { projectFileSchema, type AnchoredComment, type FileCommentAnchor } from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import { ProjectFileReader } from './project-file-reader'

vi.mock('node:fs/promises', { spy: true })

const text = '# Local file\n\nRead only\n'
const contentHash = createHash('sha256').update(text).digest('hex')
let directory: string
let project: string
let external: string
let sessionId: string
let database: PactDatabase
let reader: ProjectFileReader

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'pact-local-file-reader-'))
  project = join(directory, 'project')
  external = join(directory, 'SKILL.md')
  await fs.mkdir(project)
  await fs.writeFile(external, text)
  database = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
  })
  const projectId = randomUUID()
  sessionId = randomUUID()
  const createdAt = new Date().toISOString()
  database.projectCatalogRepository.add({
    id: projectId,
    name: 'Reader fixture',
    directoryPath: project,
    kind: 'directory',
    createdAt,
  })
  database.sessionRepository.create(
    { id: sessionId, projectId, title: 'Reader fixture', createdAt },
    {
      primaryAgentId: 'codex',
      agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
      maxDiscussionRounds: 6,

      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  reader = new ProjectFileReader(
    database.sessionRepository,
    database.projectCatalogRepository,
    runDirectoryWorker,
  )
})

afterEach(async () => {
  vi.restoreAllMocks()
  database?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

describe('Session-bound local file preview', () => {
  it('reads the native URL pathname inside the Project on either host platform', async () => {
    const file = join(project, 'source.ts')
    await fs.writeFile(file, text)

    const result = await reader.read({
      sessionId,
      path: pathToFileURL(file).pathname,
      lineStart: 3,
    })

    expect(result).toMatchObject({
      ok: true,
      value: { relativePath: 'source.ts', content: text, lineStart: 3, lineEnd: 3 },
    })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.isExternal).toBeUndefined()
  })

  it.each(['space name.ts', 'hash#name.ts', 'literal%20.ts', 'source #%.ts', '源文件.ts'])(
    'decodes the file URL for %s exactly once',
    async (name) => {
      const file = join(project, name)
      await fs.writeFile(file, text)

      const result = await reader.read({ sessionId, path: pathToFileURL(file).href, lineStart: 3 })

      expect(result).toMatchObject({
        ok: true,
        value: { relativePath: name, content: text, contentHash, lineStart: 3, lineEnd: 3 },
      })
      if (!result.ok) throw new Error(result.error.message)
      expect(result.value.isExternal).toBeUndefined()
    },
  )

  it('classifies an explicit external file URL as external and refuses file Comments', async () => {
    const path = pathToFileURL(external).href
    expect(await reader.read({ sessionId, path })).toMatchObject({
      ok: true,
      value: { isExternal: true, absolutePath: await fs.realpath(external), content: text },
    })
    await expect(
      reader.validateCommentAnchor(sessionId, {
        type: 'file',
        path,
        contentHash,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 13,
        quote: '# Local file',
      }),
    ).rejects.toThrow('File Comments must refer to a file inside this Project.')
  })

  it.each(['file:///source%2Fname.ts', 'file:///source%GG.ts'])(
    'refuses an invalid file URL without opening a different path: %s',
    async (path) => {
      const open = vi.mocked(fs.open)
      expect(await reader.read({ sessionId, path })).toMatchObject({ ok: false })
      expect(open).not.toHaveBeenCalled()
    },
  )

  it('returns the complete external UTF-8 source and line link through the typed contract', async () => {
    const result = await reader.read({ sessionId, path: external, lineStart: 3 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    expect(projectFileSchema.parse(result.value)).toMatchObject({
      isExternal: true,
      absolutePath: await fs.realpath(external),
      content: text,
      contentHash,
      lineStart: 3,
      lineEnd: 3,
    })
  })

  it.each([{ absolute: false }, { absolute: true }])(
    'keeps names beginning with two dots valid through a $absolute path',
    async ({ absolute }) => {
      await fs.writeFile(join(project, '..notes.md'), text)
      const result = await reader.read({
        sessionId,
        path: absolute ? join(project, '..notes.md') : '..notes.md',
      })
      expect(result).toMatchObject({
        ok: true,
        value: { relativePath: '..notes.md', content: text },
      })
      if (!result.ok) throw new Error(result.error.message)
      expect(result.value.isExternal).toBeUndefined()
    },
  )

  it.each(['../SKILL.md', 'linked.md'])(
    'requires an explicit absolute path for %s',
    async (path) => {
      const link = join(project, 'linked.md')
      await fs.rm(link, { force: true })
      await fs.symlink(external, link, 'file')
      expect(await reader.read({ sessionId, path })).toMatchObject({
        ok: false,
        error: { message: 'Use an absolute path to preview a file outside this Project.' },
      })
      expect(await reader.read({ sessionId, path: link })).toMatchObject({
        ok: true,
        value: { isExternal: true, absolutePath: await fs.realpath(external), content: text },
      })
    },
  )

  it('refuses binary, invalid UTF-8, non-files, missing files and invalid line links', async () => {
    const binary = join(directory, 'binary.bin')
    const invalid = join(directory, 'invalid.txt')
    await fs.writeFile(binary, Buffer.from([0, 1]))
    await fs.writeFile(invalid, Buffer.from([0xff]))
    expect(await reader.read({ sessionId, path: binary })).toMatchObject({
      ok: false,
      error: { message: 'Binary files cannot be previewed.' },
    })
    expect(await reader.read({ sessionId, path: invalid })).toMatchObject({
      ok: false,
      error: { message: 'This file is not valid UTF-8 text.' },
    })
    expect(await reader.read({ sessionId, path: directory })).toMatchObject({ ok: false })
    expect(await reader.read({ sessionId, path: join(directory, 'missing.md') })).toMatchObject({
      ok: false,
    })
    expect(await reader.read({ sessionId, path: external, lineStart: 20 })).toMatchObject({
      ok: false,
      error: { message: 'The linked line is outside this file.' },
    })
  })

  it('bounds both source bytes and JSON escaping instead of returning a truncated preview', async () => {
    for (const oversized of ['x'.repeat(1024 * 1024 + 1), '"'.repeat(600_000)]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Replace the same owned file before reading each size boundary.
      await fs.writeFile(external, oversized)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Verify each replacement before the next mutation of the same file.
      expect(await reader.read({ sessionId, path: external })).toMatchObject({
        ok: false,
        error: { message: 'This file is too large to preview.' },
      })
    }
  })

  it('settles a growing file with a visible error and closes its descriptor inside the real worker', async () => {
    const evidence = join(directory, 'grow-evidence.txt')
    const faultReader = new ProjectFileReader(
      database.sessionRepository,
      database.projectCatalogRepository,
      (input, signal) => runDirectoryWorker(input, signal, { kind: 'preview-grow', evidence }),
    )
    expect(await faultReader.read({ sessionId, path: external })).toMatchObject({
      ok: false,
      error: { message: 'This file changed while being read. Try again.' },
    })
    expect(await fs.readFile(evidence, 'utf8')).toContain('closed')
  })

  it('preserves Project Comment validation and rejects external Comment creation/navigation', async () => {
    const anchor: FileCommentAnchor = {
      type: 'file',
      path: external,
      contentHash,
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 13,
      quote: '# Local file',
    }
    await expect(reader.validateCommentAnchor(sessionId, anchor)).rejects.toThrow(
      'File Comments must refer to a file inside this Project.',
    )
    const now = new Date().toISOString()
    const comment: AnchoredComment = {
      id: randomUUID(),
      sessionId,
      anchor,
      body: 'Review this line',
      status: 'draft',
      position: 0,
      createdAt: now,
      updatedAt: now,
    }
    expect(await reader.resolveCommentSource(sessionId, comment)).toMatchObject({
      ok: true,
      value: { status: 'outdated', quote: anchor.quote },
    })
    await fs.writeFile(join(project, 'inside.md'), text)
    const projectAnchor = { ...anchor, path: 'inside.md' }
    await expect(reader.validateCommentAnchor(sessionId, projectAnchor)).resolves.toBeUndefined()
    expect(
      await reader.resolveCommentSource(sessionId, { ...comment, anchor: projectAnchor }),
    ).toMatchObject({ ok: true, value: { status: 'resolved' } })
  })

  it('keeps the existing Session existence check for external files', async () => {
    expect(await reader.read({ sessionId: randomUUID(), path: external })).toMatchObject({
      ok: false,
      error: { message: 'This Session is unavailable.' },
    })
  })

  it.each([
    { label: 'nested', path: 'sub/dir/nested.md' },
    { label: 'inside-Project symlink', path: 'inside-link.md' },
    { label: 'hardlink', path: 'hardlinked.md' },
  ])('reads a $label file through the anchored worker', async ({ label, path }) => {
    await fs.mkdir(join(project, 'sub', 'dir'), { recursive: true })
    await fs.writeFile(join(project, 'sub', 'dir', 'nested.md'), text)
    if (label === 'inside-Project symlink')
      await fs.symlink('sub/dir/nested.md', join(project, 'inside-link.md'), 'file')
    if (label === 'hardlink')
      await fs.link(join(project, 'sub', 'dir', 'nested.md'), join(project, 'hardlinked.md'))
    const relativePath = label === 'hardlink' ? 'hardlinked.md' : join('sub', 'dir', 'nested.md')
    expect(await reader.read({ sessionId, path })).toMatchObject({
      ok: true,
      value: { relativePath, content: text },
    })
  })

  it.skipIf(process.platform === 'win32')(
    'reads a POSIX backslash file name through the anchored worker',
    async () => {
      await fs.writeFile(join(project, 'a\\b.md'), text)
      expect(await reader.read({ sessionId, path: 'a\\b.md' })).toMatchObject({
        ok: true,
        value: { relativePath: 'a\\b.md', content: text },
      })
    },
  )

  it('admits exactly one in-flight read and refuses a second until it settles', async () => {
    const held = Promise.withResolvers<import('@pact/contracts').DirectoryFileOperationResult>()
    const busyReader = new ProjectFileReader(
      database.sessionRepository,
      database.projectCatalogRepository,
      () => held.promise,
    )
    const first = busyReader.read({ sessionId, path: external })
    expect(await busyReader.read({ sessionId, path: external })).toMatchObject({
      ok: false,
      error: {
        code: 'RUNTIME_UNAVAILABLE',
        message: 'File preview is busy or closing. Try again.',
      },
    })
    held.resolve({
      ok: true,
      existed: true,
      hash: contentHash,
      bytes: Buffer.byteLength(text),
      mode: 0o644,
      preview: { content: text, updatedAt: new Date().toISOString() },
    })
    await expect(first).resolves.toMatchObject({ ok: true, value: { content: text } })
    expect(await busyReader.read({ sessionId, path: external })).toMatchObject({ ok: true })
    await busyReader.dispose()
  })

  it('retains its slot past the abort deadline while physical work is pending and reports TIMEOUT', async () => {
    vi.useFakeTimers()
    const held = Promise.withResolvers<import('@pact/contracts').DirectoryFileOperationResult>()
    let seen: AbortSignal | undefined
    const busyReader = new ProjectFileReader(
      database.sessionRepository,
      database.projectCatalogRepository,
      (_input, signal) => {
        seen = signal
        return held.promise
      },
    )
    try {
      const first = busyReader.read({ sessionId, path: external })
      await vi.waitFor(() => expect(seen).toBeDefined())
      expect(seen?.aborted).toBe(false)
      let settled = false
      void first.then(() => (settled = true))
      await vi.advanceTimersToNextTimerAsync()
      expect(seen?.aborted).toBe(true)
      expect(settled).toBe(false)
      expect(await busyReader.read({ sessionId, path: external })).toMatchObject({
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE' },
      })
      held.resolve({
        ok: true,
        existed: true,
        hash: contentHash,
        bytes: Buffer.byteLength(text),
        mode: 0o644,
        preview: { content: text, updatedAt: new Date().toISOString() },
      })
      await expect(first).resolves.toMatchObject({
        ok: false,
        error: { code: 'TIMEOUT', message: 'File preview timed out.' },
      })
      await busyReader.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps its slot while pre-worker metadata I/O outlives the abort deadline', async () => {
    vi.useFakeTimers()
    const held = Promise.withResolvers<string>()
    vi.mocked(fs.realpath).mockImplementation(() => held.promise)
    const busyReader = new ProjectFileReader(
      database.sessionRepository,
      database.projectCatalogRepository,
      vi.fn<() => Promise<import('@pact/contracts').DirectoryFileOperationResult>>(),
    )
    try {
      const first = busyReader.read({ sessionId, path: external })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await busyReader.read({ sessionId, path: external })).toMatchObject({
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE' },
      })
      held.resolve(external)
      await expect(first).resolves.toMatchObject({
        ok: false,
        error: { code: 'TIMEOUT', message: 'File preview timed out.' },
      })
      await busyReader.dispose()
    } finally {
      vi.mocked(fs.realpath).mockRestore()
      vi.useRealTimers()
    }
  })

  it('aborts a hung operation on dispose and keeps admission closed forever', async () => {
    const held = Promise.withResolvers<import('@pact/contracts').DirectoryFileOperationResult>()
    let seen: AbortSignal | undefined
    const busyReader = new ProjectFileReader(
      database.sessionRepository,
      database.projectCatalogRepository,
      (_input, signal) => {
        seen = signal
        return held.promise
      },
    )
    const first = busyReader.read({ sessionId, path: external })
    await vi.waitFor(() => expect(seen).toBeDefined())
    const disposed = busyReader.dispose()
    expect(seen?.aborted).toBe(true)
    let disposeSettled = false
    void disposed.then(() => (disposeSettled = true))
    await Promise.resolve()
    expect(disposeSettled).toBe(false)
    held.resolve({
      ok: true,
      existed: true,
      hash: contentHash,
      bytes: Buffer.byteLength(text),
      mode: 0o644,
      preview: { content: text, updatedAt: new Date().toISOString() },
    })
    await disposed
    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { code: 'RUNTIME_UNAVAILABLE', message: 'File preview is closing.' },
    })
    expect(await busyReader.read({ sessionId, path: external })).toMatchObject({
      ok: false,
      error: {
        code: 'RUNTIME_UNAVAILABLE',
        message: 'File preview is busy or closing. Try again.',
      },
    })
  })

  it.each(['leaf', 'ancestor', 'root'] as const)(
    'never returns an external marker when the %s is replaced after canonical resolution',
    async (target) => {
      const mirror = join(directory, 'outside-mirror')
      await fs.mkdir(join(mirror, 'swapproot', 'inner'), { recursive: true })
      await fs.writeFile(join(mirror, 'swapproot', 'inner', 'race.md'), 'external marker')
      const nested = join(project, 'swapproot', 'inner')
      await fs.mkdir(nested, { recursive: true })
      await fs.writeFile(join(nested, 'race.md'), text)
      const swaps: string[] = []
      const raced = new ProjectFileReader(
        database.sessionRepository,
        database.projectCatalogRepository,
        async (input, signal) => {
          if (target === 'leaf') {
            await fs.rm(join(nested, 'race.md'))
            await fs.symlink(
              join(mirror, 'swapproot', 'inner', 'race.md'),
              join(nested, 'race.md'),
              'file',
            )
          } else if (target === 'ancestor') {
            const dir = join(project, 'swapproot')
            await fs.rename(dir, `${dir}.orig`)
            await fs.symlink(join(mirror, 'swapproot'), dir, 'dir')
          } else {
            await fs.rename(project, `${project}.orig`)
            await fs.symlink(mirror, project, 'dir')
          }
          swaps.push(target)
          return runDirectoryWorker(input, signal)
        },
      )
      const result = await raced.read({
        sessionId,
        path: join('swapproot', 'inner', 'race.md'),
      })
      expect(swaps).toEqual([target])
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain('external marker')
      await fs.rename(`${project}.orig`, project).catch(() => {})
      expect(await reader.read({ sessionId, path: external })).toMatchObject({
        ok: true,
        value: { isExternal: true },
      })
    },
  )

  it('rejects a leaf swapped for an external symlink during open inside the real worker', async () => {
    const marker = join(directory, 'outside-marker.md')
    await fs.writeFile(marker, 'external marker')
    const nested = join(project, 'intra')
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(join(nested, 'raceleaf'), text)
    const evidence = join(directory, 'leaf-swap-evidence.txt')
    const faultReader = new ProjectFileReader(
      database.sessionRepository,
      database.projectCatalogRepository,
      (input, signal) =>
        runDirectoryWorker(input, signal, {
          kind: 'preview-leaf-swap',
          evidence,
          target: marker,
        }),
    )
    const result = await faultReader.read({ sessionId, path: join('intra', 'raceleaf') })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('external marker')
    expect(await fs.readFile(evidence, 'utf8')).toContain('swapped')
  })

  it('rejects an ancestor swapped for an external directory between lstat and chdir', async () => {
    const mirror = join(directory, 'mirror-swapdir')
    await fs.mkdir(mirror, { recursive: true })
    await fs.writeFile(join(mirror, 'race.md'), 'external marker')
    await fs.mkdir(join(project, 'swapdir'), { recursive: true })
    await fs.writeFile(join(project, 'swapdir', 'race.md'), text)
    const evidence = join(directory, 'ancestor-swap-evidence.txt')
    const faultReader = new ProjectFileReader(
      database.sessionRepository,
      database.projectCatalogRepository,
      (input, signal) =>
        runDirectoryWorker(input, signal, {
          kind: 'preview-ancestor-swap',
          evidence,
          target: mirror,
        }),
    )
    const result = await faultReader.read({ sessionId, path: join('swapdir', 'race.md') })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('external marker')
    expect(await fs.readFile(evidence, 'utf8')).toContain('swapped')
  })
})
