import { describe, expect, it } from 'vitest'

import {
  directoryFileOperationInputSchema,
  directoryFileOperationResultSchema,
  PROJECT_FILE_PREVIEW_BYTES,
  PROJECT_FILE_PREVIEW_TIMEOUT_MS,
} from './directory-file-operations.js'

const root = {
  rootPath: '/',
  rootDevice: '1',
  rootInode: '2',
}

describe('directoryFileOperationInputSchema', () => {
  it.each(['capture', 'stash', 'install', 'absent'] as const)(
    'still accepts the %s mutation variant unchanged',
    (operation) => {
      const parsed = directoryFileOperationInputSchema.safeParse({
        operation,
        ...root,
        directories: ['a'],
        name: 'file.txt',
        auxiliaryPath: '/tmp/aux',
        maximumBytes: 8,
      })
      expect(parsed.success).toBe(true)
    },
  )

  it('accepts a bounded preview request with its own deadline', () => {
    const parsed = directoryFileOperationInputSchema.parse({
      operation: 'preview',
      ...root,
      directories: ['project', 'sub'],
      name: 'file name.md',
      deadlineAt: Date.now() + PROJECT_FILE_PREVIEW_TIMEOUT_MS,
    })
    expect(parsed.operation).toBe('preview')
  })

  it.each([
    { name: '..' },
    { name: '.' },
    { name: 'a/b' },
    { name: 'a\0b' },
    { name: '' },
    { directories: ['..'] },
    { auxiliaryPath: '/tmp/aux' },
    { linkedCandidatePath: '/tmp/aux' },
    { maximumBytes: 8 },
  ])('rejects the preview variant with forbidden input %j', (invalid) => {
    expect(
      directoryFileOperationInputSchema.safeParse({
        operation: 'preview',
        ...root,
        directories: ['project'],
        name: 'file.md',
        deadlineAt: Date.now() + 5_000,
        ...invalid,
      }).success,
    ).toBe(false)
  })

  it('keeps POSIX backslash names in the preview component but not the mutation component', () => {
    const backslash = { ...root, directories: [] as string[], name: 'a\\b.md' }
    expect(
      directoryFileOperationInputSchema.safeParse({
        operation: 'preview',
        ...backslash,
        deadlineAt: Date.now() + 5_000,
      }).success,
    ).toBe(true)
    expect(
      directoryFileOperationInputSchema.safeParse({
        operation: 'capture',
        ...backslash,
      }).success,
    ).toBe(false)
  })
})

describe('directoryFileOperationResultSchema', () => {
  it('admits a preview payload only inside the success variant within its byte bound', () => {
    const base = { existed: true, hash: 'a'.repeat(64), bytes: 4, mode: 0o644 }
    expect(
      directoryFileOperationResultSchema.safeParse({
        ok: true,
        ...base,
        preview: { content: 'text', updatedAt: new Date().toISOString() },
      }).success,
    ).toBe(true)
    expect(
      directoryFileOperationResultSchema.safeParse({
        ok: true,
        ...base,
        preview: {
          content: 'x'.repeat(PROJECT_FILE_PREVIEW_BYTES + 1),
          updatedAt: new Date().toISOString(),
        },
      }).success,
    ).toBe(false)
  })
})
