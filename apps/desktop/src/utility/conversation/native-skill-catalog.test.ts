/* oxlint-disable typescript/no-unsafe-type-assertion -- Child-process stream stubs intentionally model Node ChildProcessWithoutNullStreams. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AGY_SKILL_DISCOVERY_MAX_BYTES,
  AGY_SKILL_DISCOVERY_TIMEOUT_MS,
  bindAgySkillSelections,
  discoverAgySkills,
  nativeSkillCatalog,
} from './native-skill-catalog.js'

const tempDirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function fakeProbeChild() {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  const childRecord = Object.assign(emitter, {
    stdout,
    stderr,
    stdin,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(sig: NodeJS.Signals = 'SIGTERM') {
      childRecord.signalCode = sig
      emitter.emit('close', null, sig)
      return true
    },
  })
  const child = childRecord as unknown as ChildProcessWithoutNullStreams

  return {
    child,
    finish(code: number, payload?: string | Buffer) {
      if (payload !== undefined) stdout.write(payload)
      stdout.end()
      childRecord.exitCode = code
      emitter.emit('close', code, null)
    },
  }
}

describe('provider-advertised Skill catalog', () => {
  it('excludes disabled entries and orders user/project, system, plugin, then unknown', () => {
    const entries = nativeSkillCatalog('codex', '/owned/project', process.execPath, [
      { name: 'unknown', description: 'Native metadata' },
      { name: 'plugin', description: '', scope: 'user', pluginId: 'fixture-plugin' },
      { name: 'system', description: '', scope: 'system' },
      { name: 'z-user', description: '', scope: 'user' },
      { name: 'a-project', description: '', scope: 'repo' },
      { name: 'disabled', description: '', scope: 'user', enabled: false },
    ])
    expect(entries.map((entry) => [entry.name, entry.source])).toEqual([
      ['a-project', 'project'],
      ['z-user', 'user'],
      ['system', 'system'],
      ['plugin', 'plugin'],
      ['unknown', 'native'],
    ])
  })

  it('maps Antigravity builtin, project, user, and plugin SKILL.md paths accurately', () => {
    const entries = nativeSkillCatalog('agy', '/owned/project', process.execPath, [
      {
        name: 'antigravity-guide',
        description: 'Builtin guide',
        path: '/Users/dev/.gemini/antigravity/builtin/skills/antigravity_guide/SKILL.md',
        builtin: true,
      },
      {
        name: 'repo-lint',
        description: 'Project skill',
        path: '/owned/project/.agents/skills/repo-lint/SKILL.md',
        builtin: false,
      },
      {
        name: 'personal-style',
        description: 'User skill',
        path: '/Users/dev/.gemini/config/skills/personal-style/SKILL.md',
        builtin: false,
      },
      {
        name: 'figma-helper',
        description: 'Plugin skill',
        path: '/Users/dev/.gemini/antigravity/plugins/figma/skills/figma-helper/SKILL.md',
        builtin: false,
      },
    ])
    expect(entries.map((entry) => [entry.name, entry.source, Boolean(entry.path)])).toEqual([
      ['personal-style', 'user', true],
      ['repo-lint', 'project', true],
      ['antigravity-guide', 'system', true],
      ['figma-helper', 'plugin', true],
    ])
  })

  it('keeps native identities stable and invalidates them when effective metadata or CWD changes', () => {
    const records = [
      { name: 'check', description: 'first', path: '/owned/SKILL.md', scope: 'repo' },
    ]
    const first = nativeSkillCatalog('codex', '/owned/project', process.execPath, records)
    expect(nativeSkillCatalog('codex', '/owned/project', process.execPath, records)).toEqual(first)
    expect(nativeSkillCatalog('codex', '/owned/other', process.execPath, records)[0]?.id).not.toBe(
      first[0]?.id,
    )
    expect(
      nativeSkillCatalog('codex', '/owned/project', process.execPath, [
        { ...records[0]!, description: 'changed' },
      ])[0]?.id,
    ).not.toBe(first[0]?.id)
  })

  it('refuses ambiguous names and oversized catalogs rather than truncating them', () => {
    const entry = { name: 'check', description: '' }
    expect(() => nativeSkillCatalog('claude', '/owned', process.execPath, [entry, entry])).toThrow(
      'ambiguous',
    )
    expect(() =>
      nativeSkillCatalog(
        'codex',
        '/owned',
        process.execPath,
        Array.from({ length: 4_097 }, () => entry),
      ),
    ).toThrow('item capacity')
    expect(() =>
      nativeSkillCatalog(
        'codex',
        '/owned',
        process.execPath,
        Array.from({ length: 300 }, (_, index) => ({
          name: `skill-${index}`,
          description: 'x'.repeat(4_096),
        })),
      ),
    ).toThrow('byte capacity')
  })
})

describe('Antigravity zero-Turn /skills discovery and binding', () => {
  it('runs agy -p /skills --output-format json in the canonical target project CWD and preserves project skill identity across symlinked CWD paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-agy-skill-cwd-'))
    tempDirs.push(root)
    const projectDir = join(root, 'real-project')
    const symlinkProjectDir = join(root, 'symlink-project')
    await mkdir(join(projectDir, '.agents', 'skills', 'repo-lint'), { recursive: true })
    await symlink(projectDir, symlinkProjectDir)
    const canonicalProjectDir = await realpath(projectDir)
    const projectSkillPath = join(canonicalProjectDir, '.agents', 'skills', 'repo-lint', 'SKILL.md')

    const observedCwds: string[] = []
    let observedArgs: readonly string[] = []

    const runDiscovery = (targetCwd: string) =>
      discoverAgySkills(targetCwd, process.execPath, new AbortController().signal, {
        spawnProcess(_exe, args, probeCwd) {
          observedArgs = args
          observedCwds.push(probeCwd)
          const proc = fakeProbeChild()
          proc.child.stdin.once('finish', () => {
            proc.finish(
              0,
              JSON.stringify({
                status: 'SUCCESS',
                num_turns: 0,
                command: {
                  name: 'skills',
                  data: {
                    skills: [
                      {
                        name: 'impeccable',
                        description: 'Frontend polish skill',
                        path: '/Users/dev/.gemini/config/skills/impeccable/SKILL.md',
                        builtin: false,
                        model_invocable: true,
                      },
                      {
                        name: 'repo-lint',
                        description: 'Project lint skill',
                        path: projectSkillPath,
                        builtin: false,
                        model_invocable: true,
                      },
                    ],
                  },
                },
              }),
            )
          })
          return { child: proc.child }
        },
      })

    const fromSymlink = await runDiscovery(symlinkProjectDir)
    const fromCanonical = await runDiscovery(canonicalProjectDir)

    expect(observedArgs).toEqual(['-p', '/skills', '--output-format', 'json'])
    expect(observedCwds).toEqual([canonicalProjectDir, canonicalProjectDir])
    // Target project directory remains intact on disk!
    expect((await stat(canonicalProjectDir)).isDirectory()).toBe(true)

    expect(fromSymlink).toEqual(fromCanonical)
    expect(fromSymlink).toHaveLength(2)
    expect(fromSymlink.find((b) => b.name === 'repo-lint')).toMatchObject({
      agentId: 'agy',
      name: 'repo-lint',
      source: 'project',
      path: projectSkillPath,
    })

    // Pre-send / Steer rebind succeeds identically across symlinked and canonical CWDs!
    expect(
      bindAgySkillSelections(
        [{ id: fromSymlink[0]!.id, agentId: 'agy', name: fromSymlink[0]!.name }],
        fromCanonical,
      ),
    ).toEqual([fromCanonical[0]!])
    expect(() =>
      bindAgySkillSelections(
        [{ id: '0'.repeat(64), agentId: 'agy', name: 'impeccable' }],
        fromCanonical,
      ),
    ).toThrow(/changed or is unavailable/u)
  })

  it('rejects non-zero num_turns, 256 KiB overflow, and 4-second hangs cleanly', async () => {
    await expect(
      discoverAgySkills('/owned/project', process.execPath, new AbortController().signal, {
        spawnProcess() {
          const proc = fakeProbeChild()
          proc.child.stdin.once('finish', () => {
            proc.finish(
              0,
              JSON.stringify({
                status: 'SUCCESS',
                num_turns: 1,
                command: { name: 'skills', data: { skills: [] } },
              }),
            )
          })
          return { child: proc.child }
        },
      }),
    ).rejects.toThrow(/unexpected \/skills payload/u)

    await expect(
      discoverAgySkills('/owned/project', process.execPath, new AbortController().signal, {
        spawnProcess() {
          const proc = fakeProbeChild()
          proc.child.stdin.once('finish', () => {
            proc.finish(0, Buffer.alloc(AGY_SKILL_DISCOVERY_MAX_BYTES + 1, 0x61))
          })
          return { child: proc.child }
        },
      }),
    ).rejects.toThrow(/256 KiB/u)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let notifyTimerArmed!: () => void
    const timerArmed = new Promise<void>((resolveArmed) => {
      notifyTimerArmed = resolveArmed
    })
    const hung = discoverAgySkills(
      '/owned/project',
      process.execPath,
      new AbortController().signal,
      {
        spawnProcess() {
          const proc = fakeProbeChild()
          proc.child.stdin.once('finish', () => notifyTimerArmed())
          return {
            child: proc.child,
            async close() {
              proc.child.kill('SIGKILL')
            },
          }
        },
      },
    )
    const caughtError = hung.catch((error: unknown) => error)
    await timerArmed
    await vi.advanceTimersByTimeAsync(AGY_SKILL_DISCOVERY_TIMEOUT_MS + 50)
    expect(await caughtError).toMatchObject({
      message: expect.stringMatching(/four-second deadline/u),
    })
  })
})
