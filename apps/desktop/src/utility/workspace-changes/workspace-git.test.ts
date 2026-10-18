import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { workspaceGit } from './workspace-git'

it('uses an empty global configuration through real Git without inheriting caller overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pact-workspace-git-'))
  try {
    const configuration = join(directory, 'caller.config')
    await writeFile(configuration, '[pact]\ncaller = must-not-read\n')
    vi.stubEnv('GIT_CONFIG_GLOBAL', configuration)
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'pact.caller')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'must-not-read-command-config')

    expect(
      await workspaceGit(['config', '--global', '--list'], directory, new AbortController().signal),
    ).toEqual({ code: 0, output: '' })
    expect(
      await workspaceGit(
        ['config', '--get', 'pact.caller'],
        directory,
        new AbortController().signal,
      ),
    ).toEqual({ code: 1, output: '' })
  } finally {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
})
