import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RuntimePreparation } from './runtime-preparation'

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pact-desktop-cli-discovery-'))
  roots.push(root)
  const inherited = join(root, 'path', 'claude.exe')
  await mkdir(dirname(inherited), { recursive: true })
  await writeFile(inherited, 'Owned lookup fixture; never executed.')
  vi.stubEnv('LOCALAPPDATA', root)
  vi.stubEnv('PATH', dirname(inherited))
  const selected: Record<string, string | undefined> = {}
  const save = vi.fn<(agentId: 'claude' | 'codex', executablePath: string) => void>()
  const runtime = new RuntimePreparation({
    hasCompletedFirstUseSetup: () => true,
    readSelectedExecutablePath: (id) => selected[id],
    saveSelectedExecutablePath: save,
  })
  const versions = join(root, 'Claude-Data', 'claude_ownedfixture', 'claude-code')
  const install = async (version: string, complete = true) => {
    const executable = join(versions, version, 'abcdef012345', 'claude.exe')
    await mkdir(dirname(executable), { recursive: true })
    if (complete) await writeFile(executable, 'Owned lookup fixture; never executed.')
    return executable
  }
  const find = () => runtime.findRecoveryExecutable('claude', new AbortController().signal)
  return { root, inherited, selected, save, versions, install, find, runtime }
}

describe.runIf(process.platform === 'win32')('Claude Desktop native executable discovery', () => {
  it('uses the newest completed Desktop installation instead of an older PATH CLI without saving a manual choice', async () => {
    const f = await fixture()
    await f.install('2.1.9')
    const newest = await f.install('2.1.309')
    await f.install('2.1.310', false)
    await f.install('not-a-version')
    expect(await f.find()).toBe(newest)
    expect(f.save).not.toHaveBeenCalled()
  })

  it('preserves an existing explicit choice and rediscovers when that file disappears', async () => {
    const f = await fixture()
    const newest = await f.install('2.1.309')
    f.selected.claude = f.inherited
    expect(await f.find()).toBe(f.inherited)
    await rm(f.inherited)
    expect(await f.find()).toBe(newest)
    expect(f.save).not.toHaveBeenCalled()
  })

  it('retains PATH discovery when Desktop has no completed native runtime', async () => {
    const f = await fixture()
    expect(await f.find()).toBe(f.inherited)
    await f.install('2.1.309', false)
    expect(await f.find()).toBe(f.inherited)
  })

  it('refuses discovery overflow instead of selecting a truncated or older catalog', async () => {
    const f = await fixture()
    await f.install('2.1.309')
    await Promise.all(
      Array.from({ length: 129 }, (_, index) => mkdir(join(f.versions, `unrecognized-${index}`))),
    )
    await expect(f.find()).rejects.toThrow(/capacity/u)
    expect(f.save).not.toHaveBeenCalled()
  })

  it('honors cancellation before filesystem discovery or changing selection', async () => {
    const f = await fixture(),
      controller = new AbortController()
    controller.abort()
    await expect(
      f.runtime.findRecoveryExecutable('claude', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.save).not.toHaveBeenCalled()
  })

  it('invalidates model catalog identity when the native installation root changes', async () => {
    const f = await fixture(),
      before = f.runtime.catalogIdentity(f.root)
    vi.stubEnv('LOCALAPPDATA', join(f.root, 'different-profile'))
    expect(f.runtime.catalogIdentity(f.root)).not.toBe(before)
  })

  it('rejects a missing directory returned after the lookup deadline instead of falling back to PATH', async () => {
    const f = await fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    const finding = f.find()
    vi.setSystemTime(1001)
    await expect(finding).rejects.toThrow(/timed out/u)
    expect(f.save).not.toHaveBeenCalled()
  })
})
