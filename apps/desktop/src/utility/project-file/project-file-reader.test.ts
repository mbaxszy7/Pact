import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { projectFileSchema, type AnchoredComment, type FileCommentAnchor } from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

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
  reader = new ProjectFileReader(database.sessionRepository, database.projectCatalogRepository)
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

  it('keeps relative Project files and names beginning with two dots valid', async () => {
    await fs.writeFile(join(project, '..notes.md'), text)
    await Promise.all(
      ['..notes.md', join(project, '..notes.md')].map(async (path) => {
        const result = await reader.read({ sessionId, path })
        expect(result).toMatchObject({
          ok: true,
          value: { relativePath: '..notes.md', content: text },
        })
        if (!result.ok) throw new Error(result.error.message)
        expect(result.value.isExternal).toBeUndefined()
      }),
    )
  })

  it('requires an explicit absolute path for traversal and external symlink targets', async () => {
    const link = join(project, 'linked.md')
    await fs.symlink(external, link, 'file')
    await Promise.all(
      ['../SKILL.md', 'linked.md'].map(async (path) => {
        expect(await reader.read({ sessionId, path })).toMatchObject({
          ok: false,
          error: { message: 'Use an absolute path to preview a file outside this Project.' },
        })
      }),
    )
    expect(await reader.read({ sessionId, path: link })).toMatchObject({
      ok: true,
      value: { isExternal: true, absolutePath: await fs.realpath(external), content: text },
    })
  })

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

  it('settles a growing file with a visible error and closes its descriptor', async () => {
    const handle = await fs.open(external, 'r')
    const metadata = await handle.stat()
    metadata.size = 0
    vi.spyOn(handle, 'stat').mockResolvedValue(metadata)
    const close = vi.spyOn(handle, 'close')
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    try {
      expect(await reader.read({ sessionId, path: external })).toMatchObject({
        ok: false,
        error: { message: 'This file changed while being read. Try again.' },
      })
      expect(close).toHaveBeenCalledOnce()
    } finally {
      await handle.close()
    }
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
})
