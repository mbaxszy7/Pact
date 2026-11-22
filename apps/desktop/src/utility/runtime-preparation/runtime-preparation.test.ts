import Database from 'better-sqlite3'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeAgentId } from '@pact/contracts'
import type { RuntimePreparationRepository } from '@pact/persistence'

import { OwnedProcessGroup } from '../owned-process-group.js'
import { isSafeAgyProbeSessionId, isUnsafeWindowsCmdPath } from './agy-acp-probe.js'
import { type AgyReadinessSessionHook, RuntimePreparation } from './runtime-preparation.js'

const temporaryDirectories: string[] = []
const activePreparations: RuntimePreparation[] = []

interface AgyMockOptions {
  cliVersion?: string
  versionExit?: number
  acpVersion?: string
  behavior?:
    | 'ready'
    | 'unauthenticated'
    | 'timeout'
    | 'overflow'
    | 'invalid_json'
    | 'create_probe_db'
    | 'create_probe_db_no_workspace_uri'
    | 'create_probe_db_with_journal'
    | 'close_error'
    | 'create_nonempty_probe_db'
    | 'create_foreign_workspace_probe_db'
    | 'lock_probe_root'
  probeSessionId?: string
  lockOnceFlagPath?: string
}

const DYNAMIC_PROBE_CWD_PLACEHOLDER = '__PACT_DYNAMIC_PROBE_CWD_URI_SLOT__'.padEnd(256, '\0')

async function buildProbeSqliteBytes(options: {
  sessionId: string
  stepCount?: number
  workspaceUri?: string
  dynamicProbeCwd?: boolean
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pact-probe-db-template-'))
  try {
    const dbPath = join(dir, 'template.db')
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE "trajectory_meta" (
          "trajectory_id" TEXT PRIMARY KEY,
          "cascade_id" TEXT NOT NULL,
          "step_format" INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE "steps" (
          "idx" INTEGER PRIMARY KEY,
          "step_type" INTEGER NOT NULL,
          "status" INTEGER NOT NULL,
          "has_subtrajectory" INTEGER NOT NULL DEFAULT 0,
          "metadata" BLOB,
          "step_payload" BLOB
        );
        CREATE TABLE "trajectory_metadata_blob" (
          "idx" INTEGER PRIMARY KEY,
          "data" BLOB
        );
      `)
      db.prepare(
        'INSERT INTO "trajectory_meta" ("trajectory_id", "cascade_id", "step_format") VALUES (?, ?, 0)',
      ).run('traj-probe-1', options.sessionId)
      if (options.dynamicProbeCwd) {
        db.prepare('INSERT INTO "trajectory_metadata_blob" ("idx", "data") VALUES (0, ?)').run(
          Buffer.from(DYNAMIC_PROBE_CWD_PLACEHOLDER, 'utf8'),
        )
      } else if (options.workspaceUri) {
        db.prepare('INSERT INTO "trajectory_metadata_blob" ("idx", "data") VALUES (0, ?)').run(
          Buffer.from(options.workspaceUri, 'utf8'),
        )
      }
      for (let idx = 0; idx < (options.stepCount ?? 0); idx += 1) {
        db.prepare(
          'INSERT INTO "steps" ("idx", "step_type", "status", "has_subtrajectory") VALUES (?, 1, 2, 0)',
        ).run(idx)
      }
    } finally {
      db.close()
    }
    return (await readFile(dbPath)).toString('hex')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function createIsolatedEnv(): Promise<{
  home: string
  geminiDir: string
  env: NodeJS.ProcessEnv
}> {
  const home = await mkdtemp(join(tmpdir(), 'pact-runtime-home-'))
  temporaryDirectories.push(home)
  const geminiDir = join(home, '.gemini')
  await mkdir(geminiDir, { recursive: true })
  return {
    home,
    geminiDir,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      PATH: join(home, 'empty-bin'),
    },
  }
}

function trackPreparation(instance: RuntimePreparation): RuntimePreparation {
  activePreparations.push(instance)
  return instance
}

async function executable(
  agentId: 'claude' | 'codex',
  versionExit: number,
  authExit: number,
  version = agentId === 'claude' ? '2.1.272 (Claude Code)' : 'codex-cli 0.159.2',
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pact-runtime-handler-'))
  temporaryDirectories.push(directory)
  const path = join(directory, agentId)
  const authCommand = agentId === 'claude' ? 'auth' : 'login'
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit ${versionExit}; fi\nif [ "$1" = "${authCommand}" ] && [ "$2" = "status" ]; then echo checked > '${join(directory, 'auth-called')}'; exit ${authExit}; fi\nexit 2\n`,
    { mode: 0o755 },
  )
  await chmod(path, 0o755)
  return path
}

async function agyExecutable(options: AgyMockOptions = {}): Promise<{
  path: string
  directory: string
  factsPath: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'pact-runtime-agy-'))
  temporaryDirectories.push(directory)
  const isWin = process.platform === 'win32'
  const scriptPath = join(directory, 'agy-mock.mjs')
  const factsPath = join(directory, 'agy-facts.jsonl')
  const cliVersion = options.cliVersion ?? '1.5.9'
  const versionExit = options.versionExit ?? 0
  const acpVersion = options.acpVersion ?? '1.5.11'
  const behavior = options.behavior ?? 'ready'
  const probeSessionId = options.probeSessionId ?? '550e8400-e29b-41d4-a716-446655440000'
  const lockOnceFlagPath = options.lockOnceFlagPath ?? null
  const zeroStepDbHex =
    behavior === 'create_probe_db' ||
    behavior === 'close_error' ||
    behavior === 'create_probe_db_with_journal'
      ? await buildProbeSqliteBytes({
          sessionId: probeSessionId,
          stepCount: 0,
          dynamicProbeCwd: true,
        })
      : behavior === 'create_probe_db_no_workspace_uri'
        ? await buildProbeSqliteBytes({ sessionId: probeSessionId, stepCount: 0 })
        : behavior === 'create_nonempty_probe_db'
          ? await buildProbeSqliteBytes({
              sessionId: probeSessionId,
              stepCount: 1,
              dynamicProbeCwd: true,
            })
          : behavior === 'create_foreign_workspace_probe_db'
            ? await buildProbeSqliteBytes({
                sessionId: probeSessionId,
                stepCount: 0,
                workspaceUri: pathToFileURL('/foreign/user/workspace').href,
              })
            : ''

  await writeFile(
    scriptPath,
    `#!${process.execPath}
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const factsPath = ${JSON.stringify(factsPath)}
const probeDbHex = ${JSON.stringify(zeroStepDbHex)}
const lockOnceFlagPath = ${JSON.stringify(lockOnceFlagPath)}
const placeholderSlot = Buffer.from(${JSON.stringify(DYNAMIC_PROBE_CWD_PLACEHOLDER)}, 'utf8')
const record = (entry) => appendFileSync(factsPath, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
const args = process.argv.slice(2)

if (args[0] === '--version') {
  process.stdout.write(${JSON.stringify(cliVersion)} + '\\n')
  process.exit(${versionExit})
}

if (args[0] === 'acp') {
  const cwdMode = statSync(process.cwd()).mode & 0o777
  record({ event: 'acp_spawn', args, cwd: process.cwd(), cwdMode })
  const behavior = ${JSON.stringify(behavior)}
  if (behavior === 'timeout') {
    setInterval(() => {}, 1000)
  } else if (behavior === 'overflow') {
    process.stdout.write('x'.repeat(70 * 1024))
  } else if (behavior === 'invalid_json') {
    process.stdout.write('not-json\\n')
    process.exit(1)
  } else {
    const rl = createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      const msg = JSON.parse(line)
      record({ method: msg.method, params: msg.params })
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: ${JSON.stringify(acpVersion)} },
          },
        }) + '\\n')
      } else if (msg.method === 'session/new') {
        if (behavior === 'unauthenticated') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: 'Authentication required' },
          }) + '\\n')
        } else {
          const sid = ${JSON.stringify(probeSessionId)}
          record({ event: 'probe_cwd_entries_at_session_new', entries: readdirSync(process.cwd()) })
          const geminiIdx = args.indexOf('--gemini-dir')
          const appDataIdx = args.indexOf('--app-data-dir')
          const logFileIdx = args.indexOf('--log-file')
          const effectiveGeminiDir = geminiIdx >= 0 ? args[geminiIdx + 1] : process.env.ANTIGRAVITY_GEMINI_DIR
          const effectiveAppDataDir = appDataIdx >= 0 ? args[appDataIdx + 1] : 'antigravity-cli'
          const logFilePath = logFileIdx >= 0 ? args[logFileIdx + 1] : null
          if (logFilePath) {
            mkdirSync(dirname(logFilePath), { recursive: true })
            writeFileSync(logFilePath, 'acp-probe-log\\n')
          }
          if (effectiveGeminiDir && effectiveAppDataDir) {
            const baseAgyDir = join(effectiveGeminiDir, effectiveAppDataDir)
            const convDir = join(baseAgyDir, 'conversations')
            const brainDir = join(baseAgyDir, 'brain', sid, 'scratch')
            mkdirSync(convDir, { recursive: true })
            mkdirSync(brainDir, { recursive: true })
            if (probeDbHex) {
              const dbBuf = Buffer.from(probeDbHex, 'hex')
              const slotIdx = dbBuf.indexOf(placeholderSlot)
              if (slotIdx >= 0 && typeof msg.params?.cwd === 'string') {
                const replacement = Buffer.from(pathToFileURL(msg.params.cwd).href.padEnd(256, '\\0'), 'utf8')
                replacement.copy(dbBuf, slotIdx, 0, 256)
              }
              writeFileSync(join(convDir, sid + '.db'), dbBuf)
              if (behavior === 'create_probe_db') {
                writeFileSync(join(convDir, sid + '.db-wal'), Buffer.alloc(0))
                writeFileSync(join(convDir, sid + '.db-shm'), 'probe-shm')
              } else if (behavior === 'create_probe_db_with_journal') {
                writeFileSync(join(convDir, sid + '.db-journal'), 'active-rollback-journal')
              }
            }
          }
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { sessionId: sid },
          }) + '\\n')
        }
      } else if (msg.method === 'session/close') {
        if (behavior === 'lock_probe_root' && (!lockOnceFlagPath || !existsSync(lockOnceFlagPath))) {
          const probeRootDir = dirname(process.cwd())
          writeFileSync(join(probeRootDir, 'locked-sentinel'), 'retain')
          if (lockOnceFlagPath) {
            writeFileSync(lockOnceFlagPath, 'locked')
          }
          chmodSync(probeRootDir, 0o500)
        }
        if (behavior === 'close_error') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: 'Close failed' },
          }) + '\\n')
        } else {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n')
        }
      }
    })
    rl.on('close', () => process.exit(0))
  }
} else {
  process.exit(2)
}
`,
    { mode: 0o755 },
  )
  await chmod(scriptPath, 0o755)

  if (!isWin) {
    return { path: scriptPath, directory, factsPath }
  }

  const cmdPath = join(directory, 'agy.cmd')
  await writeFile(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`)
  return { path: cmdPath, directory, factsPath }
}

async function windowsExecutable(
  agentId: 'claude' | 'codex',
  versionExit = 0,
  authExit = 0,
  extension = 'cmd',
  version = agentId === 'claude' ? '2.1.272 (Claude Code)' : 'codex-cli 0.159.2',
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pact runtime cmd '))
  temporaryDirectories.push(directory)
  const path = join(directory, `${agentId}.${extension}`)
  const authCommand = agentId === 'claude' ? 'auth' : 'login'
  await writeFile(
    path,
    `@echo off\r\nif "%~1"=="--version" (\r\n  echo ${version.replace(/[()]/gu, '^$&')}\r\n  exit /b ${versionExit}\r\n)\r\nif "%~1"=="${authCommand}" if "%~2"=="status" (\r\n  echo checked > "${join(directory, 'auth-called')}"\r\n  exit /b ${authExit}\r\n)\r\nexit /b 2\r\n`,
  )
  return path
}

function repository(paths: Partial<Record<RuntimeAgentId, string>>): RuntimePreparationRepository {
  return {
    hasCompletedFirstUseSetup: () => false,
    readSelectedExecutablePath: (agentId) => paths[agentId],
    saveSelectedExecutablePath: vi.fn<(agentId: RuntimeAgentId, executablePath: string) => void>(
      (agentId, executablePath) => {
        paths[agentId] = executablePath
      },
    ),
  }
}

interface AgyFactRecord {
  pid: number
  event?: string
  args?: string[]
  cwd?: string
  cwdMode?: number
  method?: string
  params?: Record<string, unknown>
}

function parseAgyFactLine(line: string): AgyFactRecord {
  const raw: unknown = JSON.parse(line)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Expected JSON object fact')
  }
  const pid = Reflect.get(raw, 'pid')
  const event = Reflect.get(raw, 'event')
  const args = Reflect.get(raw, 'args')
  const cwd = Reflect.get(raw, 'cwd')
  const cwdMode = Reflect.get(raw, 'cwdMode')
  const method = Reflect.get(raw, 'method')
  const params = Reflect.get(raw, 'params')
  return {
    pid: typeof pid === 'number' ? pid : 0,
    ...(typeof event === 'string' ? { event } : {}),
    ...(Array.isArray(args)
      ? { args: args.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(typeof cwd === 'string' ? { cwd } : {}),
    ...(typeof cwdMode === 'number' ? { cwdMode } : {}),
    ...(typeof method === 'string' ? { method } : {}),
    ...(typeof params === 'object' && params !== null && !Array.isArray(params)
      ? { params: Object.fromEntries(Object.entries(params)) }
      : {}),
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  await Promise.allSettled(activePreparations.splice(0).map((item) => item.dispose()))
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe.skipIf(process.platform === 'win32')('Runtime preparation utility', () => {
  it.each([
    ['warning before version', 'startup warning', 'codex-cli 0.159.2', 'ready'],
    ['version only in stderr', 'codex-cli 9.9.9', 'unknown CLI output', 'cannot_verify'],
  ])('uses stdout as the version result: %s', async (_label, stderr, stdout, state) => {
    const { env } = await createIsolatedEnv()
    const claude = await executable('claude', 0, 0)
    const codex = await executable('codex', 0, 0)
    const agy = await agyExecutable()
    await writeFile(
      codex,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${stderr}' >&2; sleep 0.05; echo '${stdout}'; exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit 0; fi\nexit 2\n`,
    )
    const result = await trackPreparation(
      new RuntimePreparation(repository({ claude, codex, agy: agy.path }), {
        env,
      }),
    ).inspectReadiness()
    expect(result).toMatchObject({
      ok: true,
      value: {
        agents: [
          { agentId: 'claude', state: 'ready' },
          { agentId: 'codex', state, version: stdout },
          { agentId: 'agy', state: 'ready', version: '1.5.9' },
        ],
      },
    })
  })

  it('probes claude, codex, and agy in parallel without sending a model prompt, recording CLI version separately from ACP agentInfo.version and isolating agy storage in probeRoot', async () => {
    const { env, geminiDir } = await createIsolatedEnv()
    const probeSid = '550e8400-e29b-41d4-a716-446655440000'
    const userSid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const conversationsDir = join(geminiDir, 'antigravity-cli', 'conversations')
    await mkdir(conversationsDir, { recursive: true })
    const userDbPath = join(conversationsDir, `${userSid}.db`)
    const summariesDbPath = join(geminiDir, 'antigravity-cli', 'conversation_summaries.db')
    await writeFile(userDbPath, 'user-conversation-keep-intact')
    await writeFile(summariesDbPath, 'user-summaries-keep-intact')

    const [claude, codex, agy] = await Promise.all([
      executable('claude', 0, 0),
      executable('codex', 0, 0),
      agyExecutable({
        cliVersion: '1.5.9',
        acpVersion: '1.5.11',
        behavior: 'create_probe_db',
        probeSessionId: probeSid,
      }),
    ])

    const runtime = trackPreparation(
      new RuntimePreparation(repository({ claude, codex, agy: agy.path }), {
        env,
      }),
    )
    const result = await runtime.inspectReadiness()

    expect(result).toMatchObject({
      ok: true,
      value: {
        firstUse: true,
        agents: [
          { agentId: 'claude', state: 'ready', version: '2.1.272 (Claude Code)' },
          { agentId: 'codex', state: 'ready', version: 'codex-cli 0.159.2' },
          { agentId: 'agy', state: 'ready', version: '1.5.9', agentInfoVersion: '1.5.11' },
        ],
      },
    })
    expect(runtime.readLastAcpAgentVersion()).toBe('1.5.11')

    const agyFacts = (await readFile(agy.factsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => parseAgyFactLine(line))

    const spawnFact = agyFacts.find((fact) => fact.event === 'acp_spawn')
    const probeRootFromCwd = dirname(spawnFact!.cwd!)
    expect(spawnFact?.args?.slice(0, 3)).toEqual(['acp', '--disable-telemetry', '--gemini-dir'])
    expect(spawnFact?.args?.[3]?.replace(/^\/private/u, '')).toBe(
      join(probeRootFromCwd, 'gemini').replace(/^\/private/u, ''),
    )
    expect(spawnFact?.args?.slice(4, 7)).toEqual(['--app-data-dir', 'probe', '--log-file'])
    expect(spawnFact?.args?.[7]?.replace(/^\/private/u, '')).toBe(
      join(probeRootFromCwd, 'acp-probe.log').replace(/^\/private/u, ''),
    )
    expect(spawnFact?.cwdMode).toBe(0o700)
    expect(await exists(probeRootFromCwd)).toBe(false)

    const methods = agyFacts.filter((fact) => fact.method).map((fact) => fact.method)
    expect(methods).toEqual(['initialize', 'session/new', 'session/close'])
    expect(agyFacts.find((fact) => fact.method === 'initialize')?.params?.clientInfo).toMatchObject(
      { name: 'pact' },
    )
    expect(agyFacts.find((fact) => fact.method === 'session/close')?.params?.sessionId).toBe(
      probeSid,
    )
    expect(() => process.kill(spawnFact!.pid, 0)).toThrow(/ESRCH/u)

    // Probe sessionId DB + WAL + SHM stayed inside isolated probeRoot and were deleted; shared user DBs remain untouched.
    expect(await exists(join(conversationsDir, `${probeSid}.db`))).toBe(false)
    expect(await exists(join(conversationsDir, `${probeSid}.db-wal`))).toBe(false)
    expect(await exists(join(conversationsDir, `${probeSid}.db-shm`))).toBe(false)
    expect(await readFile(userDbPath, 'utf8')).toBe('user-conversation-keep-intact')
    expect(await readFile(summariesDbPath, 'utf8')).toBe('user-summaries-keep-intact')
  })

  it(
    'distinguishes agy -32000 Authentication required with Run agy to sign in guidance, missing binary, upgrade required, output overflow, and unconfirmed cleanup',
    { timeout: 15_000 },
    async () => {
      const { env } = await createIsolatedEnv()
      const [claude, codex, unauthAgy, oldAgy, overflowAgy] = await Promise.all([
        executable('claude', 0, 1),
        executable('codex', 2, 0),
        agyExecutable({ behavior: 'unauthenticated' }),
        agyExecutable({ cliVersion: '1.5.8' }),
        agyExecutable({ behavior: 'overflow' }),
      ])

      const [unauthResult, missingResult, upgradeResult, overflowResult] = await Promise.all([
        trackPreparation(
          new RuntimePreparation(repository({ claude, codex, agy: unauthAgy.path }), { env }),
        ).inspectReadiness(),
        trackPreparation(
          new RuntimePreparation(repository({ claude, codex }), { env }),
        ).inspectReadiness(),
        trackPreparation(
          new RuntimePreparation(repository({ claude, codex, agy: oldAgy.path }), { env }),
        ).inspectReadiness(),
        trackPreparation(
          new RuntimePreparation(repository({ claude, codex, agy: overflowAgy.path }), { env }),
        ).inspectReadiness(),
      ])

      expect(unauthResult).toMatchObject({
        ok: true,
        value: {
          agents: [
            { agentId: 'claude', state: 'authentication_required' },
            { agentId: 'codex', state: 'startup_failed' },
            {
              agentId: 'agy',
              state: 'authentication_required',
              version: '1.5.9',
              detail: expect.stringContaining('Run agy to sign in'),
            },
          ],
        },
      })

      expect(missingResult).toMatchObject({
        ok: true,
        value: {
          agents: [
            { agentId: 'claude' },
            { agentId: 'codex' },
            { agentId: 'agy', state: 'missing' },
          ],
        },
      })

      expect(upgradeResult).toMatchObject({
        ok: true,
        value: {
          agents: [
            { agentId: 'claude' },
            { agentId: 'codex' },
            {
              agentId: 'agy',
              state: 'unsupported_version',
              version: '1.5.8',
              detail: expect.stringContaining('1.5.9'),
            },
          ],
        },
      })

      expect(overflowResult).toMatchObject({
        ok: true,
        value: {
          agents: [
            { agentId: 'claude' },
            { agentId: 'codex' },
            { agentId: 'agy', state: 'cannot_verify' },
          ],
        },
      })

      const readyAgy = await agyExecutable({ behavior: 'ready' })
      const origClose = Reflect.get(OwnedProcessGroup.prototype, 'close')
      let failAgyAcpCloseOnce = true
      vi.spyOn(OwnedProcessGroup.prototype, 'close').mockImplementation(async function (
        this: OwnedProcessGroup,
        deadline?: number,
      ) {
        await origClose.call(this, deadline)
        if (failAgyAcpCloseOnce && Reflect.get(this, 'onCloseInput') !== undefined) {
          failAgyAcpCloseOnce = false
          throw new Error('Synthetic close failure')
        }
      })
      const unconfirmedRuntime = trackPreparation(
        new RuntimePreparation(repository({ claude, codex, agy: readyAgy.path }), { env }),
      )
      expect(await unconfirmedRuntime.inspectReadiness()).toMatchObject({
        ok: true,
        value: {
          agents: [
            { agentId: 'claude' },
            { agentId: 'codex' },
            {
              agentId: 'agy',
              state: 'cannot_verify',
              detail: expect.stringContaining('could not be confirmed'),
            },
          ],
        },
      })
    },
  )

  it('unlocks onboarding when any >= 2 of the 3 CLIs are ready and validates distinct ready pairs', () => {
    const checkedAt = new Date().toISOString()
    const twoReady = {
      agents: [
        { agentId: 'claude' as const, state: 'missing' as const, checkedAt },
        { agentId: 'codex' as const, state: 'ready' as const, checkedAt },
        { agentId: 'agy' as const, state: 'ready' as const, checkedAt },
      ],
    }
    const oneReady = {
      agents: [
        { agentId: 'claude' as const, state: 'missing' as const, checkedAt },
        { agentId: 'codex' as const, state: 'authentication_required' as const, checkedAt },
        { agentId: 'agy' as const, state: 'ready' as const, checkedAt },
      ],
    }

    expect(RuntimePreparation.canCompleteOnboarding(twoReady)).toBe(true)
    expect(RuntimePreparation.canCompleteOnboarding(oneReady)).toBe(false)

    expect(RuntimePreparation.validateActivePairReadiness(twoReady, 'codex', 'agy')).toEqual({
      ok: true,
    })
    expect(RuntimePreparation.validateActivePairReadiness(twoReady, 'agy', 'agy')).toMatchObject({
      ok: false,
      code: 'VALIDATION',
    })
    expect(RuntimePreparation.validateActivePairReadiness(twoReady, 'claude', 'agy')).toMatchObject(
      {
        ok: false,
        code: 'RUNTIME_UNAVAILABLE',
      },
    )
    expect(RuntimePreparation.validateActivePairReadiness(oneReady, 'codex', 'agy')).toMatchObject({
      ok: false,
      code: 'RUNTIME_UNAVAILABLE',
    })

    // Probe sessionId and Windows .cmd path guards reject traversal and shell metacharacters.
    expect(isSafeAgyProbeSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isSafeAgyProbeSessionId('../user-conversation')).toBe(false)
    expect(isSafeAgyProbeSessionId('foo/bar')).toBe(false)
    expect(isSafeAgyProbeSessionId('foo\\bar')).toBe(false)
    expect(isUnsafeWindowsCmdPath('C:\\Program Files\\Antigravity\\agy.cmd')).toBe(false)
    expect(isUnsafeWindowsCmdPath('C:\\Tools\\agy&calc.cmd')).toBe(true)
    expect(isUnsafeWindowsCmdPath('C:\\Tools\\agy%PATH%.cmd')).toBe(true)
  })

  it(
    'bounds a hanging agy ACP authentication probe to the 4s timeout and kills the child process',
    { timeout: 10_000 },
    async () => {
      const { env } = await createIsolatedEnv()
      const [claude, codex, hangingAgy] = await Promise.all([
        executable('claude', 0, 0),
        executable('codex', 0, 0),
        agyExecutable({ behavior: 'timeout' }),
      ])
      const runtime = trackPreparation(
        new RuntimePreparation(repository({ claude, codex, agy: hangingAgy.path }), { env }),
      )
      const startedAt = Date.now()
      const result = await runtime.inspectReadiness()
      expect(Date.now() - startedAt).toBeLessThan(6_500)
      expect(result).toMatchObject({
        ok: true,
        value: {
          agents: [
            { agentId: 'claude', state: 'ready' },
            { agentId: 'codex', state: 'ready' },
            {
              agentId: 'agy',
              state: 'startup_failed',
              version: '1.5.9',
              detail: 'Authentication check timed out.',
            },
          ],
        },
      })
      const facts = (await readFile(hangingAgy.factsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => parseAgyFactLine(line))
      const spawnPid = facts.find((fact) => fact.event === 'acp_spawn')?.pid
      expect(spawnPid).toBeDefined()
      expect(() => process.kill(spawnPid!, 0)).toThrow(/ESRCH/u)
    },
  )

  it('fails closed to cannot_verify without spawning ACP when the agy --version probe close is unconfirmed', async () => {
    const { env } = await createIsolatedEnv()
    const [claude, codex, agy] = await Promise.all([
      executable('claude', 0, 0),
      executable('codex', 0, 0),
      agyExecutable({ cliVersion: '1.5.9' }),
    ])
    const runtime = trackPreparation(
      new RuntimePreparation(repository({ claude, codex, agy: agy.path }), { env }),
    )
    const origClose = Reflect.get(OwnedProcessGroup.prototype, 'close')
    let failVersionCloseOnce = true
    vi.spyOn(OwnedProcessGroup.prototype, 'close').mockImplementation(async function (
      this: OwnedProcessGroup,
      deadline?: number,
    ) {
      await origClose.call(this, deadline)
      if (failVersionCloseOnce && Reflect.get(this, 'onCloseInput') === undefined) {
        failVersionCloseOnce = false
        throw new Error('Synthetic --version close failure')
      }
    })

    const result = await runtime.inspectProviderReadiness('agy')
    expect(result).toMatchObject({
      ok: true,
      value: {
        agentId: 'agy',
        state: 'cannot_verify',
        detail: expect.stringContaining('could not be confirmed'),
      },
    })
    expect(await exists(agy.factsPath)).toBe(false)
  })

  it('tracks unconfirmed agy probeRoot directories across dispose rejection and subsequent admission cleanup retry', async () => {
    const { env } = await createIsolatedEnv()
    const [claude, codex] = await Promise.all([
      executable('claude', 0, 0),
      executable('codex', 0, 0),
    ])

    // Part 1: Failed probeRoot deletion causes dispose() to reject cleanly instead of leaking silently.
    const lockedAgy = await agyExecutable({ behavior: 'lock_probe_root' })
    const runtimeA = trackPreparation(
      new RuntimePreparation(repository({ claude, codex, agy: lockedAgy.path }), { env }),
    )
    let lockedRootA: string | undefined
    try {
      expect(await runtimeA.inspectProviderReadiness('agy')).toMatchObject({
        ok: true,
        value: { agentId: 'agy', state: 'ready', version: '1.5.9' },
      })
      const factsA = (await readFile(lockedAgy.factsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => parseAgyFactLine(line))
      lockedRootA = dirname(factsA.find((fact) => fact.event === 'acp_spawn')!.cwd!)
      expect(await exists(lockedRootA)).toBe(true)
      await expect(runtimeA.dispose()).rejects.toThrow(/probes were not released/u)
    } finally {
      if (lockedRootA) {
        await chmod(lockedRootA, 0o700).catch(() => undefined)
        await rm(lockedRootA, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    // Part 2: Subsequent admission retries cleanup once the directory is removable and dispose() then succeeds.
    const flagDir = await mkdtemp(join(tmpdir(), 'pact-runtime-lock-flag-'))
    temporaryDirectories.push(flagDir)
    const lockOnceFlagPath = join(flagDir, 'locked-once')
    const retryAgy = await agyExecutable({ behavior: 'lock_probe_root', lockOnceFlagPath })
    const runtimeB = trackPreparation(
      new RuntimePreparation(repository({ claude, codex, agy: retryAgy.path }), { env }),
    )
    let lockedRootB: string | undefined
    let secondRootB: string | undefined
    try {
      expect(await runtimeB.inspectProviderReadiness('agy')).toMatchObject({
        ok: true,
        value: { agentId: 'agy', state: 'ready', version: '1.5.9' },
      })
      const firstFacts = (await readFile(retryAgy.factsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => parseAgyFactLine(line))
      const firstSpawn = firstFacts.find((fact) => fact.event === 'acp_spawn')
      lockedRootB = dirname(firstSpawn!.cwd!)
      expect(await exists(lockedRootB)).toBe(true)

      await chmod(lockedRootB, 0o700)

      expect(await runtimeB.inspectProviderReadiness('agy')).toMatchObject({
        ok: true,
        value: { agentId: 'agy', state: 'ready', version: '1.5.9' },
      })
      const secondFacts = (await readFile(retryAgy.factsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => parseAgyFactLine(line))
      const spawnsSecond = secondFacts.filter((fact) => fact.event === 'acp_spawn')
      secondRootB = spawnsSecond[1]?.cwd ? dirname(spawnsSecond[1].cwd) : undefined

      expect(await exists(lockedRootB)).toBe(false)
      expect(secondRootB).toBeDefined()
      expect(await exists(secondRootB!)).toBe(false)
      await expect(runtimeB.dispose()).resolves.toBeUndefined()
    } finally {
      if (lockedRootB) {
        await chmod(lockedRootB, 0o700).catch(() => undefined)
        await rm(lockedRootB, { recursive: true, force: true }).catch(() => undefined)
      }
      if (secondRootB) {
        await chmod(secondRootB, 0o700).catch(() => undefined)
        await rm(secondRootB, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  })
})

describe.runIf(process.platform === 'win32')('Windows Runtime Preparation', () => {
  it.each(['cmd', 'CMD'])(
    'starts .%s shims from a directory containing spaces',
    async (extension) => {
      const { env } = await createIsolatedEnv()
      const [claude, codex, agy] = await Promise.all([
        windowsExecutable('claude', 0, 0, extension),
        windowsExecutable('codex', 0, 0, extension),
        agyExecutable(),
      ])

      expect(
        await trackPreparation(
          new RuntimePreparation(repository({ claude, codex, agy: agy.path }), { env }),
        ).inspectReadiness(),
      ).toMatchObject({
        ok: true,
        value: {
          agents: [
            { agentId: 'claude', state: 'ready', version: '2.1.272 (Claude Code)' },
            { agentId: 'codex', state: 'ready', version: 'codex-cli 0.159.2' },
            { agentId: 'agy', state: 'ready', version: '1.5.9' },
          ],
        },
      })
    },
  )

  it('retains distinct authentication and startup failures for Windows shims', async () => {
    const { env } = await createIsolatedEnv()
    const [claude, codex, agy] = await Promise.all([
      windowsExecutable('claude', 0, 1),
      windowsExecutable('codex', 2, 0),
      agyExecutable({ behavior: 'unauthenticated' }),
    ])

    expect(
      await trackPreparation(
        new RuntimePreparation(repository({ claude, codex, agy: agy.path }), { env }),
      ).inspectReadiness(),
    ).toMatchObject({
      ok: true,
      value: {
        agents: [
          { agentId: 'claude', state: 'authentication_required' },
          { agentId: 'codex', state: 'startup_failed' },
          { agentId: 'agy', state: 'authentication_required' },
        ],
      },
    })
  })
})

async function versionExecutable(agentId: 'claude' | 'codex', version: string): Promise<string> {
  return process.platform === 'win32'
    ? windowsExecutable(agentId, 0, 0, 'cmd', version)
    : executable(agentId, 0, 0, version)
}

describe('Runtime version compatibility through real CLI probes', () => {
  it.each([
    ['minimum releases', '2.1.272 (Claude Code)', 'codex-cli 0.159.2', '1.5.9', 'ready'],
    [
      'older releases',
      '2.1.271 (Claude Code)',
      'codex-cli 0.159.1',
      '1.5.8',
      'unsupported_version',
    ],
    ['numeric ordering', '2.10.1 (Claude Code)', 'codex-cli 0.159.10', '1.5.11', 'ready'],
    ['major upgrades', '3.0.0 (Claude Code)', 'codex-cli 1.0.0', '2.0.0', 'ready'],
    [
      'older minor versions',
      '2.0.999 (Claude Code)',
      'codex-cli 0.158.999',
      '1.4.999',
      'unsupported_version',
    ],
    [
      'minimum prereleases',
      '2.1.272-rc.1 (Claude Code)',
      'codex-cli 0.159.2-alpha.1',
      '1.5.9-rc.1',
      'unsupported_version',
    ],
    [
      'newer prereleases',
      '2.1.273-rc.1 (Claude Code)',
      'codex-cli 0.160.0-alpha.1',
      '1.5.10-alpha.1',
      'ready',
    ],
    [
      'build metadata',
      '2.1.272+build.1 (Claude Code)',
      'codex-cli 0.159.2+build.1',
      '1.5.9+b1',
      'ready',
    ],
    [
      'unrecognized output',
      'unknown (Claude Code)',
      'codex-cli unknown',
      'unknown',
      'cannot_verify',
    ],
    ['partial version tokens', '2.1 (Claude Code)', 'codex-cli 0.159.2.1', '1.5', 'cannot_verify'],
  ])(
    'checks %s before authentication',
    async (_label, claudeVersion, codexVersion, agyVersion, state) => {
      const { env } = await createIsolatedEnv()
      const [claude, codex, agy] = await Promise.all([
        versionExecutable('claude', claudeVersion),
        versionExecutable('codex', codexVersion),
        agyExecutable({ cliVersion: agyVersion }),
      ])
      const result = await trackPreparation(
        new RuntimePreparation(repository({ claude, codex, agy: agy.path }), { env }),
      ).inspectReadiness()
      expect(result).toMatchObject({
        ok: true,
        value: {
          firstUse: true,
          agents: [
            { agentId: 'claude', state, version: claudeVersion },
            { agentId: 'codex', state, version: codexVersion },
            { agentId: 'agy', state, version: agyVersion },
          ],
        },
      })
      if (!result.ok) throw new Error(result.error.message)
      const authentication = await Promise.all(
        [claude, codex].map(async (path) => {
          try {
            return (await readFile(join(dirname(path), 'auth-called'), 'utf8')).trim()
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
            throw error
          }
        }),
      )
      expect(authentication).toEqual(state === 'ready' ? ['checked', 'checked'] : [null, null])
      expect(await exists(agy.factsPath)).toBe(state === 'ready')
      const minimums = ['2.1.272', '0.159.2', '1.5.9']
      expect(
        result.value.agents.map(
          (agent, index) => agent.detail?.includes(minimums[index]!) ?? false,
        ),
      ).toEqual([state !== 'ready', state !== 'ready', state !== 'ready'])
    },
  )

  it('rechecks a manually selected installation and recovers after an in-place upgrade', async () => {
    const { env } = await createIsolatedEnv()
    const [claude, codex, olderCodex, agy] = await Promise.all([
      versionExecutable('claude', '2.1.272 (Claude Code)'),
      versionExecutable('codex', 'codex-cli 0.159.2'),
      versionExecutable('codex', 'codex-cli 0.159.1'),
      agyExecutable(),
    ])
    const paths = repository({ claude, codex, agy: agy.path })
    const preparation = trackPreparation(new RuntimePreparation(paths, { env }))
    expect(
      await preparation.selectExecutable({ agentId: 'codex', executablePath: olderCodex }),
    ).toMatchObject({
      ok: true,
      value: {
        agents: [
          { state: 'ready' },
          { state: 'unsupported_version', executablePath: olderCodex },
          { state: 'ready' },
        ],
      },
    })
    expect(paths.readSelectedExecutablePath('codex')).toBe(olderCodex)
    await writeFile(olderCodex, (await readFile(olderCodex, 'utf8')).replace('0.159.1', '0.159.2'))
    expect(await preparation.inspectReadiness()).toMatchObject({
      ok: true,
      value: {
        agents: [
          { state: 'ready' },
          { state: 'ready', executablePath: olderCodex },
          { state: 'ready' },
        ],
      },
    })
  })

  it('isolates agy probes away from shared conversation_summaries.db and pre-existing user DBs with zero sidefiles while handling session/close errors cleanly', async () => {
    const { env, geminiDir } = await createIsolatedEnv()
    const appDataDir = join(geminiDir, 'antigravity-cli')
    const conversationsDir = join(appDataDir, 'conversations')
    await mkdir(conversationsDir, { recursive: true })
    // Unreadable/non-SQLite conversation_summaries.db proves probes NEVER read or copy global conversation_summaries.db!
    const summariesPath = join(appDataDir, 'conversation_summaries.db')
    await writeFile(summariesPath, 'do-not-touch-global-summaries', { mode: 0o000 })

    // Seed pre-existing shared DB fixtures (matching UUID, non-empty steps, rollback journal, foreign workspace).
    const preExistingSid = '22222222-3333-4444-8555-666666666666'
    const nonEmptySid = '33333333-4444-4555-8666-777777777777'
    const foreignSid = '44444444-5555-4666-8777-888888888888'
    const journalSid = '77777777-8888-4999-8aaa-bbbbbbbbbbbb'
    const preExistingDbPath = join(conversationsDir, `${preExistingSid}.db`)
    const nonEmptyDbPath = join(conversationsDir, `${nonEmptySid}.db`)
    const foreignDbPath = join(conversationsDir, `${foreignSid}.db`)
    const journalDbPath = join(conversationsDir, `${journalSid}.db`)
    const journalRollbackPath = join(conversationsDir, `${journalSid}.db-journal`)

    await writeFile(preExistingDbPath, 'pre-existing-user-db')
    await writeFile(
      nonEmptyDbPath,
      Buffer.from(
        await buildProbeSqliteBytes({
          sessionId: nonEmptySid,
          stepCount: 1,
          dynamicProbeCwd: true,
        }),
        'hex',
      ),
    )
    await writeFile(
      foreignDbPath,
      Buffer.from(
        await buildProbeSqliteBytes({
          sessionId: foreignSid,
          stepCount: 0,
          workspaceUri: pathToFileURL('/foreign/user/workspace').href,
        }),
        'hex',
      ),
    )
    await writeFile(journalDbPath, 'user-db-with-journal')
    await writeFile(journalRollbackPath, 'active-rollback-journal')
    const pastDate = new Date(Date.now() - 10_000)
    await utimes(preExistingDbPath, pastDate, pastDate)
    const preExistingStatBefore = await stat(preExistingDbPath)
    const entriesBefore = (await readdir(conversationsDir)).toSorted()

    const [claude, codex] = await Promise.all([
      versionExecutable('claude', '2.1.272 (Claude Code)'),
      versionExecutable('codex', 'codex-cli 0.159.2'),
    ])

    // (a) session/close error still leaves agy ready and deletes isolated probeRoot.
    const closeFailSid = '11111111-2222-4333-8444-555555555555'
    const closeFailAgy = await agyExecutable({
      behavior: 'close_error',
      probeSessionId: closeFailSid,
    })
    const closeFailResult = await trackPreparation(
      new RuntimePreparation(repository({ claude, codex, agy: closeFailAgy.path }), { env }),
    ).inspectReadiness()
    expect(closeFailResult).toMatchObject({
      ok: true,
      value: {
        agents: [
          { agentId: 'claude', state: 'ready' },
          { agentId: 'codex', state: 'ready' },
          { agentId: 'agy', state: 'ready' },
        ],
      },
    })
    const closeFailFacts = (await readFile(closeFailAgy.factsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => parseAgyFactLine(line))
    const closeFailRoot = dirname(closeFailFacts.find((fact) => fact.event === 'acp_spawn')!.cwd!)
    expect(await exists(closeFailRoot)).toBe(false)

    // (b) Running a probe configured with the same sessionId as a shared user DB never touches shared DBs.
    const sameSidAgy = await agyExecutable({
      behavior: 'create_probe_db',
      probeSessionId: preExistingSid,
    })
    const sameSidResult = await trackPreparation(
      new RuntimePreparation(repository({ claude, codex, agy: sameSidAgy.path }), { env }),
    ).inspectReadiness()
    expect(sameSidResult).toMatchObject({
      ok: true,
      value: {
        agents: [
          { agentId: 'claude', state: 'ready' },
          { agentId: 'codex', state: 'ready' },
          { agentId: 'agy', state: 'ready' },
        ],
      },
    })
    const sameSidFacts = (await readFile(sameSidAgy.factsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => parseAgyFactLine(line))
    expect(
      await exists(dirname(sameSidFacts.find((fact) => fact.event === 'acp_spawn')!.cwd!)),
    ).toBe(false)

    // Shared conversationsDir and pre-existing DBs + mtime + rollback journal remain completely untouched.
    expect((await readdir(conversationsDir)).toSorted()).toEqual(entriesBefore)
    expect(await readFile(preExistingDbPath, 'utf8')).toBe('pre-existing-user-db')
    expect((await stat(preExistingDbPath)).mtimeMs).toBe(preExistingStatBefore.mtimeMs)
    expect(await exists(nonEmptyDbPath)).toBe(true)
    expect(await exists(foreignDbPath)).toBe(true)
    expect(await exists(journalDbPath)).toBe(true)
    expect(await exists(journalRollbackPath)).toBe(true)
    await chmod(summariesPath, 0o600)
  })

  it('isolates per-agent discovery failures to cannot_verify without blocking >= 2 ready setup, and probes only one provider via inspectProviderReadiness', async () => {
    const { env } = await createIsolatedEnv()
    const [claude, codex, agy] = await Promise.all([
      versionExecutable('claude', '2.1.272 (Claude Code)'),
      versionExecutable('codex', 'codex-cli 0.159.2'),
      agyExecutable({ cliVersion: '1.5.9' }),
    ])

    // Simulate a local Claude discovery failure (such as Windows Claude Desktop 128-entry cap or unreadable directory).
    const paths: RuntimePreparationRepository = {
      hasCompletedFirstUseSetup: () => false,
      readSelectedExecutablePath: (agentId) => {
        if (agentId === 'claude') return undefined
        return agentId === 'codex' ? codex : agy.path
      },
      saveSelectedExecutablePath: vi.fn<() => void>(),
    }
    const preparation = trackPreparation(new RuntimePreparation(paths, { env }))
    vi.spyOn(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- White-box spy on private findExecutable discovery seam.
      preparation as unknown as { findExecutable: (agentId: RuntimeAgentId) => Promise<string> },
      'findExecutable',
    ).mockImplementation(async (agentId) => {
      if (agentId === 'claude') {
        throw new Error('Native installation discovery exceeds its capacity.')
      }
      return agentId === 'codex' ? codex : agy.path
    })

    const fullReadiness = await preparation.inspectReadiness()
    expect(fullReadiness).toMatchObject({
      ok: true,
      value: {
        firstUse: true,
        agents: [
          { agentId: 'claude', state: 'cannot_verify' },
          { agentId: 'codex', state: 'ready' },
          { agentId: 'agy', state: 'ready' },
        ],
      },
    })
    if (!fullReadiness.ok) throw new Error(fullReadiness.error.message)
    expect(RuntimePreparation.canCompleteOnboarding(fullReadiness.value)).toBe(true)

    // Single-provider readiness API probes ONLY the requested provider without spawning the other two CLIs!
    const singlePrep = trackPreparation(
      new RuntimePreparation(repository({ claude, codex, agy: agy.path }), { env }),
    )
    await rm(join(dirname(claude), 'auth-called'), { force: true })
    await rm(join(dirname(codex), 'auth-called'), { force: true })
    await rm(agy.factsPath, { force: true })

    const singleAgy = await singlePrep.inspectProviderReadiness('agy')
    expect(singleAgy).toMatchObject({
      ok: true,
      value: { agentId: 'agy', state: 'ready', version: '1.5.9' },
    })
    expect(await exists(join(dirname(claude), 'auth-called'))).toBe(false)
    expect(await exists(join(dirname(codex), 'auth-called'))).toBe(false)
    expect(await exists(agy.factsPath)).toBe(true)
  })

  it(
    'runs coalesced agySessionHook calls on 1 agy acp probe, detaches aborted subscriber hooks, and isolates hook errors from readiness',
    { timeout: 15_000 },
    async () => {
      const { env } = await createIsolatedEnv()
      const hookDir = await mkdtemp(join(tmpdir(), 'pact-agy-hook-test-'))
      temporaryDirectories.push(hookDir)
      const factsPath = join(hookDir, 'agy-hook-facts.jsonl')
      const gateFile = join(hookDir, 'gate')
      const agyHookScript = join(hookDir, 'agy-hook-bin.mjs')
      await writeFile(
        agyHookScript,
        `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
const factsPath = ${JSON.stringify(factsPath)}
const gateFile = ${JSON.stringify(gateFile)}
const record = (entry) => appendFileSync(factsPath, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('1.5.13\\n')
  process.exit(0)
}
if (args[0] === 'acp') {
  record({ event: 'acp_spawn' })
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const msg = JSON.parse(line)
    record({ method: msg.method, id: msg.id })
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.13' } } }) + '\\n')
    } else if (msg.method === 'session/new') {
      const reply = () => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } }) + '\\n')
      }
      if (!existsSync(gateFile)) reply()
      else {
        const timer = setInterval(() => {
          if (!existsSync(gateFile)) {
            clearInterval(timer)
            reply()
          }
        }, 15)
      }
    } else if (msg.method === 'hook/ping') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.params?.tag } }) + '\\n')
    } else if (msg.method === 'session/close') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n')
    }
  })
  rl.on('close', () => process.exit(0))
}
`,
        { mode: 0o755 },
      )
      await chmod(agyHookScript, 0o755)
      const [claude, codex] = await Promise.all([
        versionExecutable('claude', '2.1.272 (Claude Code)'),
        versionExecutable('codex', 'codex-cli 0.159.2'),
      ])
      const prep = trackPreparation(
        new RuntimePreparation(repository({ claude, codex, agy: agyHookScript }), { env }),
      )

      // Hold session/new so a throwing hook, an aborted subscriber hook, and a healthy concurrent hook coalesce cleanly.
      await writeFile(gateFile, 'hold', 'utf8')
      let thrownHookCalled = false
      let abortedHookCalled = false
      const healthyPayloads: Array<{
        sessionId: string
        cliVersion: string | undefined
        echoed: unknown
      }> = []

      const abortController = new AbortController()
      const throwingHook: AgyReadinessSessionHook = {
        inspectSession: async () => {
          thrownHookCalled = true
          throw new Error('Hook boom should not block readiness')
        },
      }
      const abortedHook: AgyReadinessSessionHook = {
        inspectSession: async () => {
          abortedHookCalled = true
        },
      }
      const healthyHook: AgyReadinessSessionHook = {
        inspectSession: async ({ sessionId, transport }, cliVersion) => {
          const reply = await transport.request('hook/ping', { tag: 'coalesced' })
          healthyPayloads.push({
            sessionId,
            cliVersion,
            echoed:
              typeof reply === 'object' && reply !== null
                ? Reflect.get(reply, 'echoed')
                : undefined,
          })
        },
      }

      const firstPromise = prep.inspectReadiness(undefined, ['agy'], Date.now() + 38_000, {
        agySessionHook: throwingHook,
      })
      await expect
        .poll(
          async () => {
            const text = await readFile(factsPath, 'utf8').catch(() => '')
            return text.includes('"session/new"')
          },
          { timeout: 5_000 },
        )
        .toBe(true)

      const secondPromise = prep.inspectReadiness(
        abortController.signal,
        ['agy'],
        Date.now() + 38_000,
        {
          agySessionHook: abortedHook,
        },
      )
      const thirdPromise = prep.inspectReadiness(undefined, ['agy'], Date.now() + 38_000, {
        agySessionHook: healthyHook,
      })
      await new Promise((r) => setTimeout(r, 20))
      abortController.abort()
      await rm(gateFile, { force: true })

      const [firstRes, secondRes, thirdRes] = await Promise.all([
        firstPromise,
        secondPromise,
        thirdPromise,
      ])
      expect(firstRes).toMatchObject({
        ok: true,
        value: { agents: [{ agentId: 'agy', state: 'ready', version: '1.5.13' }] },
      })
      expect(secondRes).toMatchObject({ ok: false })
      expect(thirdRes).toMatchObject({
        ok: true,
        value: { agents: [{ agentId: 'agy', state: 'ready', version: '1.5.13' }] },
      })
      expect(thrownHookCalled).toBe(true)
      expect(abortedHookCalled).toBe(false)
      expect(healthyPayloads).toEqual([
        {
          sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          cliVersion: '1.5.13',
          echoed: 'coalesced',
        },
      ])

      const facts = (await readFile(factsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => parseAgyFactLine(l))
      expect(facts.filter((f) => f.event === 'acp_spawn')).toHaveLength(1)
    },
  )

  it(
    'caches positive readiness with executable fingerprint & generation checks, bypasses cache on forceRefresh/invalidation, and absorbs only 1 returning-user agy probe timeout',
    { timeout: 25_000 },
    async () => {
      const { env } = await createIsolatedEnv()
      const dir = await mkdtemp(join(tmpdir(), 'pact-agy-cache-test-'))
      temporaryDirectories.push(dir)
      const modeFile = join(dir, 'agy-mode.txt')
      const factsPath = join(dir, 'agy-cache-facts.jsonl')
      const agyBin = join(dir, 'agy-dynamic.mjs')
      await writeFile(modeFile, 'ready', 'utf8')
      await writeFile(
        agyBin,
        `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const modeFile = ${JSON.stringify(modeFile)}
const factsPath = ${JSON.stringify(factsPath)}
const args = process.argv.slice(2)
const readMode = () => readFileSync(modeFile, 'utf8').trim()
if (args[0] === '--version') {
  const mode = readMode()
  if (mode === 'outdated') {
    process.stdout.write('1.5.8\\n')
  } else {
    process.stdout.write('1.5.14\\n')
  }
  process.exit(0)
}
if (args[0] === 'acp') {
  appendFileSync(factsPath, JSON.stringify({ event: 'acp_spawn' }) + '\\n')
  const mode = readMode()
  if (mode === 'timeout') {
    setInterval(() => {}, 1000)
  } else {
    const rl = createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      const msg = JSON.parse(line)
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.14' } } }) + '\\n')
      } else if (msg.method === 'session/new') {
        if (mode === 'unauthenticated') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } }) + '\\n')
        } else {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } }) + '\\n')
        }
      } else if (msg.method === 'session/close') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n')
      }
    })
    rl.on('close', () => process.exit(0))
  }
}
`,
        { mode: 0o755 },
      )
      await chmod(agyBin, 0o755)
      const [claude, codex] = await Promise.all([
        versionExecutable('claude', '2.1.272 (Claude Code)'),
        versionExecutable('codex', 'codex-cli 0.159.2'),
      ])
      const returningRepo: RuntimePreparationRepository = {
        ...repository({ claude, codex, agy: agyBin }),
        hasCompletedFirstUseSetup: () => true,
      }
      const prep = trackPreparation(new RuntimePreparation(returningRepo, { env }))

      let virtualNow = 1_700_000_000_000
      vi.spyOn(Date, 'now').mockImplementation(() => virtualNow)

      // 1. Initial probe spawns once; subsequent reads within TTL hit positive cache with zero extra spawns.
      expect(await prep.inspectProviderReadiness('agy')).toMatchObject({
        ok: true,
        value: { agentId: 'agy', state: 'ready', version: '1.5.14' },
      })
      expect(await prep.inspectProviderReadiness('agy')).toMatchObject({
        ok: true,
        value: { agentId: 'agy', state: 'ready', version: '1.5.14' },
      })
      const readSpawnCount = async (): Promise<number> => {
        const text = await readFile(factsPath, 'utf8').catch(() => '')
        return text.trim().split('\n').filter(Boolean).length
      }
      expect(await readSpawnCount()).toBe(1)

      // 2. forceRefresh bypasses cache; explicit invalidation clears cache.
      expect(
        await prep.inspectProviderReadiness('agy', undefined, { forceRefresh: true }),
      ).toMatchObject({
        ok: true,
        value: { agentId: 'agy', state: 'ready', version: '1.5.14' },
      })
      expect(await readSpawnCount()).toBe(2)

      prep.invalidateAgentReadiness('agy')
      expect(await prep.inspectProviderReadiness('agy')).toMatchObject({
        ok: true,
        value: { agentId: 'agy', state: 'ready', version: '1.5.14' },
      })
      expect(await readSpawnCount()).toBe(3)

      // 3. Past 180s positive TTL, 1 transient agy timeout is absorbed once (returning prior ready),
      //    expires positive cache so the next check probes fresh, and a 2nd consecutive timeout surfaces startup_failed!
      virtualNow += 181_000
      await writeFile(modeFile, 'timeout', 'utf8')
      expect(await prep.inspectProviderReadiness('agy')).toMatchObject({
        ok: true,
        value: { agentId: 'agy', state: 'ready', version: '1.5.14' },
      })
      expect(await readSpawnCount()).toBe(4)

      expect(await prep.inspectProviderReadiness('agy')).toMatchObject({
        ok: true,
        value: {
          agentId: 'agy',
          state: 'startup_failed',
          detail: 'Authentication check timed out.',
        },
      })
      expect(await readSpawnCount()).toBe(5)

      // 4. Re-warm ready cache, then fail with authentication_required -> NEVER absorbed!
      await writeFile(modeFile, 'ready', 'utf8')
      expect(await prep.inspectProviderReadiness('agy')).toMatchObject({
        ok: true,
        value: { agentId: 'agy', state: 'ready' },
      })
      expect(await readSpawnCount()).toBe(6)

      virtualNow += 181_000
      await writeFile(modeFile, 'unauthenticated', 'utf8')
      expect(await prep.inspectProviderReadiness('agy')).toMatchObject({
        ok: true,
        value: { agentId: 'agy', state: 'authentication_required' },
      })
      expect(await readSpawnCount()).toBe(7)

      // 5. Re-warm ready cache, then modify the on-disk executable -> stat fingerprint change invalidates cache even inside TTL!
      await writeFile(modeFile, 'ready', 'utf8')
      expect(await prep.inspectProviderReadiness('agy')).toMatchObject({
        ok: true,
        value: { agentId: 'agy', state: 'ready' },
      })
      expect(await readSpawnCount()).toBe(8)

      const oldText = await readFile(agyBin, 'utf8')
      await writeFile(agyBin, `${oldText}\n// bumped binary\n`, { mode: 0o755 })
      await writeFile(modeFile, 'outdated', 'utf8')
      expect(await prep.inspectProviderReadiness('agy')).toMatchObject({
        ok: true,
        value: { agentId: 'agy', state: 'unsupported_version', version: '1.5.8' },
      })
      expect(await readSpawnCount()).toBe(8)
    },
  )
})
