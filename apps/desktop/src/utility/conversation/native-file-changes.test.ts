import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  agyFileChanges,
  AgyRoundEffectsTracker,
  isAgyBrainArtifactPath,
  isAgyCommandProvablyDisjoint,
} from './native-file-changes.js'

function systemBin(name: string): string {
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
    const candidate = `${dir}/${name}`
    if (existsSync(candidate)) return candidate
  }
  return `/usr/bin/${name}`
}

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createWorkspaceAndAppData(): Promise<{ cwd: string; appDataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pact-agy-file-changes-'))
  tempDirs.push(root)
  const cwd = join(root, 'workspace')
  const appDataDir = join(root, 'antigravity-cli')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(appDataDir, 'brain', 'sid-123'), { recursive: true })
  return { cwd, appDataDir }
}

describe('Antigravity native file changes and Undo evidence (Module 6 / B9)', () => {
  it('extracts complete before and after texts from completed edit_file and overwrite write_file diffs', async () => {
    const { cwd } = await createWorkspaceAndAppData()
    const target = join(cwd, 'src', 'feature.ts')

    const edited = agyFileChanges(
      {
        name: 'edit_file',
        status: 'completed',
        args: { Path: target },
        content: [
          {
            type: 'diff',
            path: target,
            oldText: 'export const x = 1\n',
            newText: 'export const x = 2\n',
          },
        ],
      },
      cwd,
    )
    expect(edited).toEqual({
      changes: [
        {
          path: 'src/feature.ts',
          kind: 'modified',
          before: 'export const x = 1\n',
          after: 'export const x = 2\n',
        },
      ],
    })

    const overwritten = agyFileChanges(
      {
        name: 'write_file',
        status: 'completed',
        args: { Path: target, Content: 'next\n', Overwrite: true },
        content: [
          {
            type: 'diff',
            path: target,
            oldText: 'prev\n',
            newText: 'next\n',
          },
        ],
      },
      cwd,
    )
    expect(overwritten).toEqual({
      changes: [
        {
          path: 'src/feature.ts',
          kind: 'modified',
          before: 'prev\n',
          after: 'next\n',
        },
      ],
    })
  })

  it('requires positive new-file creation proof when oldText is absent', async () => {
    const { cwd } = await createWorkspaceAndAppData()
    const target = join(cwd, 'src', 'created.ts')

    // Accepted: write_file with args present and neither Overwrite nor Append set.
    const provenCreate = agyFileChanges(
      {
        name: 'write_file',
        status: 'completed',
        args: { Path: target, Content: 'export const fresh = true\n' },
        content: [{ type: 'diff', path: target, newText: 'export const fresh = true\n' }],
      },
      cwd,
    )
    expect(provenCreate).toEqual({
      changes: [
        {
          path: 'src/created.ts',
          kind: 'added',
          before: null,
          after: 'export const fresh = true\n',
        },
      ],
    })

    // Rejected for reliable Undo: Overwrite=true without oldText cannot prove prior absence!
    const overwriteWithoutOld = agyFileChanges(
      {
        name: 'write_file',
        status: 'completed',
        args: { Path: target, Content: 'v2\n', Overwrite: true },
        content: [{ type: 'diff', path: target, newText: 'v2\n' }],
      },
      cwd,
    )
    expect(overwriteWithoutOld.invalidatesPriorEvidence).toBe(true)
    expect(overwriteWithoutOld.uncertain).toMatch(/new-file creation proof/u)
    expect(overwriteWithoutOld.changes[0]?.unavailableReason).toMatch(/new-file creation proof/u)

    // Rejected for reliable Undo: Append=true without oldText.
    const appendWithoutOld = agyFileChanges(
      {
        name: 'write_file',
        status: 'completed',
        args: { Path: target, Content: 'tail\n', Append: true },
        content: [{ type: 'diff', path: target, newText: 'head\ntail\n' }],
      },
      cwd,
    )
    expect(appendWithoutOld.invalidatesPriorEvidence).toBe(true)

    // Rejected for reliable Undo: edit_file missing oldText.
    const editWithoutOld = agyFileChanges(
      {
        name: 'edit_file',
        status: 'completed',
        args: { Path: target },
        content: [{ type: 'diff', path: target, newText: 'edited\n' }],
      },
      cwd,
    )
    expect(editWithoutOld.invalidatesPriorEvidence).toBe(true)
  })

  it('excludes <appDataDir>/brain/<sessionId>/* artifacts while recording workspace brain/* files normally', async () => {
    const { cwd, appDataDir } = await createWorkspaceAndAppData()
    const brainPlan = join(appDataDir, 'brain', 'sid-123', 'implementation_plan.md')
    const workspaceBrain = join(cwd, 'brain', 'sid-123', 'implementation_plan.md')

    expect(isAgyBrainArtifactPath(brainPlan, cwd, appDataDir, 'sid-123')).toBe(true)
    expect(isAgyBrainArtifactPath(workspaceBrain, cwd, appDataDir, 'sid-123')).toBe(false)

    const ignoredArtifact = agyFileChanges(
      {
        name: 'write_file',
        status: 'completed',
        args: {
          Path: brainPlan,
          Content: '# Plan\n',
          ArtifactMetadata: { Summary: 'Plan', UserFacing: true, RequestFeedback: true },
        },
        content: [{ type: 'diff', path: brainPlan, newText: '# Plan\n' }],
      },
      cwd,
      { appDataDir, nativeSessionId: 'sid-123' },
    )
    expect(ignoredArtifact).toEqual({ changes: [] })

    const recordedWorkspaceFile = agyFileChanges(
      {
        name: 'write_file',
        status: 'completed',
        args: { Path: workspaceBrain, Content: '# Real workspace doc\n' },
        content: [{ type: 'diff', path: workspaceBrain, newText: '# Real workspace doc\n' }],
      },
      cwd,
      { appDataDir, nativeSessionId: 'sid-123' },
    )
    expect(recordedWorkspaceFile.changes).toHaveLength(1)
    expect(recordedWorkspaceFile.changes[0]?.path).toBe('brain/sid-123/implementation_plan.md')
  })

  it('disables reliable Undo on failed/partial edits, deletions, renames, and content mismatches', async () => {
    const { cwd } = await createWorkspaceAndAppData()
    const fileA = join(cwd, 'src', 'a.ts')

    const failed = agyFileChanges(
      {
        name: 'edit_file',
        status: 'failed',
        args: { Path: fileA },
      },
      cwd,
    )
    expect(failed.invalidatesPriorEvidence).toBe(true)
    expect(failed.changes).toEqual([
      expect.objectContaining({
        path: 'src/a.ts',
        kind: 'modified',
        invalidateOnly: true,
      }),
    ])

    const deleted = agyFileChanges(
      {
        name: 'delete_file',
        status: 'completed',
        args: { Path: fileA },
      },
      cwd,
    )
    expect(deleted.uncertain).toMatch(/deletions and renames/u)
    expect(deleted.changes[0]).toMatchObject({
      path: 'src/a.ts',
      kind: 'deleted',
      after: null,
    })
    expect(deleted.changes[0]?.unavailableReason).toBeDefined()

    const renamed = agyFileChanges(
      {
        name: 'rename_file',
        status: 'completed',
        args: { Path: fileA, Destination: join(cwd, 'src', 'b.ts') },
      },
      cwd,
    )
    expect(renamed.uncertain).toMatch(/deletions and renames/u)
    expect(renamed.changes.map((c) => c.kind)).toEqual(['renamed', 'renamed'])

    const mismatchedWrite = agyFileChanges(
      {
        name: 'write_file',
        status: 'completed',
        args: { Path: fileA, Content: 'requested\n', Overwrite: true },
        content: [{ type: 'diff', path: fileA, oldText: 'old\n', newText: 'different\n' }],
      },
      cwd,
    )
    expect(mismatchedWrite.invalidatesPriorEvidence).toBe(true)
    expect(mismatchedWrite.changes[0]?.unavailableReason).toMatch(/did not match/u)
  })
})

describe('AgyRoundEffectsTracker and command disjointness classification', () => {
  it.skipIf(process.platform === 'win32')(
    'classifies provably disjoint verified system-binary commands as unlisted and bare/overlapping/arbitrary commands as recorded_files',
    async () => {
      const { cwd, appDataDir } = await createWorkspaceAndAppData()
      const recorded = new Set(['src/app.ts'])
      const gitBin = systemBin('git')
      const lsBin = systemBin('ls')
      const touchBin = systemBin('touch')
      const rmBin = systemBin('rm')
      const chmodBin = systemBin('chmod')

      // Explicit verified system binary paths that are provably disjoint -> true (`unlisted`).
      expect(isAgyCommandProvablyDisjoint(`${gitBin} status --short`, recorded, cwd)).toBe(true)
      expect(isAgyCommandProvablyDisjoint(`${lsBin} -la src`, recorded, cwd)).toBe(true)
      expect(isAgyCommandProvablyDisjoint(`${touchBin} src/other.ts`, recorded, cwd)).toBe(true)

      // Bare command names rely on mutable PATH / shell functions -> conservatively NOT disjoint!
      expect(isAgyCommandProvablyDisjoint('git status --short', recorded, cwd)).toBe(false)
      expect(isAgyCommandProvablyDisjoint('ls -la src', recorded, cwd)).toBe(false)
      expect(isAgyCommandProvablyDisjoint('touch src/other.ts', recorded, cwd)).toBe(false)
      expect(isAgyCommandProvablyDisjoint('/bin/nonexistent-inspection-tool', recorded, cwd)).toBe(
        false,
      )

      // Overlapping file, parent directory, shell redirect, wildcard, or interpreter -> NOT disjoint!
      expect(isAgyCommandProvablyDisjoint(`${rmBin} src/app.ts`, recorded, cwd)).toBe(false)
      expect(isAgyCommandProvablyDisjoint(`${rmBin} -rf src`, recorded, cwd)).toBe(false)
      expect(isAgyCommandProvablyDisjoint(`${rmBin} -rf .`, recorded, cwd)).toBe(false)
      expect(isAgyCommandProvablyDisjoint('echo hi > src/other.ts', recorded, cwd)).toBe(false)
      expect(isAgyCommandProvablyDisjoint('node -e "fs.writeFileSync()"', recorded, cwd)).toBe(
        false,
      )
      expect(isAgyCommandProvablyDisjoint(`${gitBin} checkout -- src/app.ts`, recorded, cwd)).toBe(
        false,
      )

      const tracker = new AgyRoundEffectsTracker(cwd, 'pact_peer_abc123', appDataDir, 'sid-123')
      const writeRes = tracker.observeFileTool({
        name: 'write_file',
        status: 'completed',
        args: { Path: join(cwd, 'src', 'app.ts'), Content: 'v1\n' },
        content: [{ type: 'diff', path: join(cwd, 'src', 'app.ts'), newText: 'v1\n' }],
      })
      expect(writeRes.uncertain).toBeUndefined()

      // Read-only built-in and authorized Pact MCP tools introduce zero uncertainty.
      expect(tracker.observeNonFileTool({ name: 'read_file' })).toEqual({
        uncertain: false,
        scope: 'unlisted',
      })
      expect(
        tracker.observeNonFileTool({ name: 'mcp_pact_peer_abc123_read_collaboration_source' }),
      ).toEqual({
        uncertain: false,
        scope: 'unlisted',
      })

      // Disjoint verified system-binary touch -> `unlisted` uncertainty (preserves Undo on src/app.ts).
      expect(
        tracker.observeNonFileTool({
          name: 'run_command',
          args: { CommandLine: `${touchBin} notes/scratch.txt` },
        }),
      ).toMatchObject({
        uncertain: true,
        scope: 'unlisted',
      })

      // Bare `ls` or `git status` -> conservatively classified under `recorded_files`!
      expect(
        tracker.observeNonFileTool({
          name: 'run_command',
          args: { CommandLine: 'ls -la' },
        }),
      ).toMatchObject({
        uncertain: true,
        scope: 'recorded_files',
      })

      // Overlapping command -> upgrades to `recorded_files` uncertainty (disables Undo!).
      expect(
        tracker.observeNonFileTool({
          name: 'run_command',
          args: { CommandLine: `${chmodBin} 644 src/app.ts` },
        }),
      ).toMatchObject({
        uncertain: true,
        scope: 'recorded_files',
      })
    },
  )

  it('rejects project-local executables and external-processor/write flags even when basename matches inspection commands', async () => {
    const { cwd, appDataDir } = await createWorkspaceAndAppData()
    const recorded = new Set(['src/app.ts'])
    const workspaceBin = join(cwd, 'bin', 'ls')

    const unsafeCommands = [
      './ls -la',
      '../ls',
      'scripts/rg pattern',
      `${workspaceBin} -la`,
      '/tmp/untrusted/cat src/app.ts',
      'find . -exec rm {} +',
      'find . -delete',
      'sed -i "s/a/b/" src/app.ts',
      'git -c core.fsmonitor=./evil status',
      'git diff --ext-diff',
      'git diff -opatch.diff',
      'env ls',
      'rg --pre ./evil pattern',
      'rg -z pattern',
      'file -C magic',
    ]

    for (const cmd of unsafeCommands) {
      expect(isAgyCommandProvablyDisjoint(cmd, recorded, cwd)).toBe(false)
      expect(isAgyCommandProvablyDisjoint(cmd, new Set(), cwd)).toBe(false)
    }

    // Even when no file has been edited yet in the tracker, unsafe commands classify as `recorded_files`.
    const freshTracker = new AgyRoundEffectsTracker(cwd, undefined, appDataDir, 'sid-123')
    for (const cmd of [
      './ls',
      'find . -delete',
      'sed -i "s/x/y/" f.txt',
      'git -c alias.status=!evil status',
      'env pwd',
    ]) {
      expect(
        freshTracker.observeNonFileTool({
          name: 'run_command',
          args: { CommandLine: cmd },
        }),
      ).toMatchObject({
        uncertain: true,
        scope: 'recorded_files',
      })
    }
  })

  it('catches command -> write ordering when an earlier non-disjoint command preceded a file edit', async () => {
    const { cwd } = await createWorkspaceAndAppData()
    const tracker = new AgyRoundEffectsTracker(cwd)

    // Command runs BEFORE any file is recorded in the round.
    const firstCmd = tracker.observeNonFileTool({
      name: 'run_command',
      args: { CommandLine: 'python3 scripts/codegen.py' },
    })
    expect(firstCmd.uncertain).toBe(true)

    // Subsequent edit_file on src/gen.ts must invalidate prior evidence because python3 ran earlier in the round!
    const editAfterCmd = tracker.observeFileTool({
      name: 'edit_file',
      status: 'completed',
      args: { Path: join(cwd, 'src', 'gen.ts') },
      content: [
        {
          type: 'diff',
          path: join(cwd, 'src', 'gen.ts'),
          oldText: 'a\n',
          newText: 'b\n',
        },
      ],
    })
    expect(editAfterCmd.invalidatesPriorEvidence).toBe(true)
    expect(editAfterCmd.uncertain).toMatch(/earlier command or tool/u)
  })
})
