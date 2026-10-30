import { randomUUID } from 'node:crypto'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import {
  assertDecisionEnvironment,
  retainCodexInstallationId,
  resolveDecisionNativeExecutable,
} from './decision-native-isolation'

it.runIf(process.platform === 'darwin')(
  'retains an existing native ID without changing it and detects replacement through its original descriptor',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-id-proof-')),
      path = join(root, 'installation_id'),
      value = randomUUID()
    await writeFile(path, value, { mode: 0o644 })
    const before = await stat(path),
      retained = await retainCodexInstallationId(root)
    try {
      expect(await retained.current()).toBe(true)
      expect(await readFile(path, 'utf8')).toBe(value)
      const observed = await stat(path)
      expect([observed.ino, observed.mtimeMs, observed.ctimeMs]).toEqual([
        before.ino,
        before.mtimeMs,
        before.ctimeMs,
      ])
      await rename(path, join(root, 'old'))
      await writeFile(path, value, { mode: 0o644 })
      expect(await retained.current()).toBe(false)
    } finally {
      await retained.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
it
  .runIf(process.platform === 'darwin')
  .each(['missing', 'malformed', 'mode', 'symlink', 'hardlink'] as const)(
  'rejects %s native ID without repairing or creating native state',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-id-refusal-')),
      path = join(root, 'installation_id')
    try {
      if (kind !== 'missing')
        await writeFile(path, kind === 'malformed' ? 'invalid' : randomUUID(), { mode: 0o644 })
      if (kind === 'mode') await chmod(path, 0o600)
      if (kind === 'symlink') {
        await rename(path, join(root, 'target'))
        await symlink(join(root, 'target'), path)
      }
      if (kind === 'hardlink') await link(path, join(root, 'other'))
      const before = await readFile(path).catch(() => null)
      await expect(retainCodexInstallationId(root)).rejects.toThrow(
        /unsupported_protocol|ENOENT|ELOOP/u,
      )
      expect(await readFile(path).catch(() => null)).toEqual(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
it.runIf(process.platform === 'darwin')(
  'detects same-inode native ID data mutation and permission changes',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-id-mutation-')),
      path = join(root, 'installation_id')
    await writeFile(path, randomUUID(), { mode: 0o644 })
    const retained = await retainCodexInstallationId(root)
    try {
      await writeFile(path, randomUUID())
      expect(await retained.current()).toBe(false)
      await chmod(path, 0o600)
      expect(await retained.current()).toBe(false)
    } finally {
      await retained.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
it('rejects inherited code injection while retaining ordinary native credentials', () => {
  expect(() =>
    assertDecisionEnvironment({ ANTHROPIC_AUTH_TOKEN: 'owned', OPENAI_API_KEY: 'owned' }),
  ).not.toThrow()
  for (const key of [
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'LD_PRELOAD',
    'NODE_OPTIONS',
    'BUN_OPTIONS',
  ])
    expect(() => assertDecisionEnvironment({ [key]: 'owned' })).toThrow('unsupported_protocol')
})
it.runIf(process.platform === 'darwin')(
  'refuses an unknown launcher instead of executing it outside containment',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-wrapper-refusal-')),
      path = join(root, 'unknown')
    try {
      await mkdir(join(root, 'unused'))
      await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      await expect(resolveDecisionNativeExecutable(path, 'codex')).rejects.toThrow(
        'unsupported_protocol',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
