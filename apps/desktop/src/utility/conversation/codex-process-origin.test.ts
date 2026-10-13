import { afterEach, expect, it, vi } from 'vitest'

const nativeProcess = vi.hoisted(() => ({
  spawn: vi.fn<typeof import('node:child_process').spawn>(),
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: nativeProcess.spawn,
}))

import { CodexAgentAdapter } from './codex-agent-adapter'

afterEach(() => {
  vi.unstubAllEnvs()
  nativeProcess.spawn.mockReset()
})

it('starts the production Codex process with Pact identity despite Desktop launch attribution', async () => {
  vi.stubEnv('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'Codex Desktop')
  nativeProcess.spawn.mockImplementation(() => {
    throw new Error('Owned process boundary: no child was started')
  })
  const adapter = new CodexAgentAdapter('/owned/codex')
  try {
    await expect(
      adapter.prepareNativeFork(
        {
          cwd: '/owned/project',
          nativeSessionId: 'owned-thread',
          nativeTurnId: 'owned-turn',
          runId: 'owned-run',
          bindingGeneration: 1,
          throughSequence: 1,
          deliveryCursor: 0,
          responseHash: 'a'.repeat(64),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('interruption capabilities could not be verified')
    expect(nativeProcess.spawn).toHaveBeenCalledOnce()
    expect(nativeProcess.spawn).toHaveBeenCalledWith(
      '/owned/codex',
      ['features', 'list'],
      expect.objectContaining({
        cwd: '/owned/project',
        shell: false,
        env: expect.objectContaining({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'pact' }),
      }),
    )
    expect(process.env['CODEX_INTERNAL_ORIGINATOR_OVERRIDE']).toBe('Codex Desktop')
  } finally {
    await adapter.dispose()
  }
})
