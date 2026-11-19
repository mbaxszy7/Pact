import { expect, type ElectronApplication } from '@playwright/test'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import {
  copyIsolatedAgyAuthConfig,
  createRuntimeFixture,
  isUnsafeWindowsCmdPath,
  redactRealAgyText,
  requireExplicitAgyAuthDir,
  test,
  verifyAgyMinimumVersion,
  type CopiedAgyAuthManifest,
} from './runtime-fixture.js'

export {
  copyIsolatedAgyAuthConfig,
  isUnsafeWindowsCmdPath,
  requireExplicitAgyAuthDir,
  verifyAgyMinimumVersion,
  type CopiedAgyAuthManifest as CopiedAuthManifest,
}

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
const persistencePackageJsonPath = resolve(
  import.meta.dirname,
  '../../packages/persistence/package.json',
)
const requireFromPersistence = createRequire(persistencePackageJsonPath)
const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true })
const SMOKE_TOKEN = 'PACT_REAL_AGY_SMOKE_OK'
const CORTEX_STEP_USER_INPUT = 14
const CORTEX_STEP_PLANNER_RESPONSE = 15
const CORTEX_STEP_STATUS_DONE = 3

interface ReadonlySqliteStatement {
  all(...parameters: unknown[]): unknown[]
}
interface ReadonlySqliteDatabase {
  prepare(sql: string): ReadonlySqliteStatement
  close(): void
}
type ReadonlySqliteConstructor = new (
  file: string,
  options: { readonly: true; fileMustExist: true; timeout: 0 },
) => ReadonlySqliteDatabase

interface SafeDecodedStepSummary {
  idx: number
  stepType: number
  status: number
  userInputSha256: string | null
  plannerResponseSha256: string | null
  userContainsSmokeToken: boolean
  plannerContainsSmokeToken: boolean
}

interface SafeTrajectorySummary {
  columns: string[]
  stepCount: number
  cutStepIdx: number
  steps: SafeDecodedStepSummary[]
  userSteps: SafeDecodedStepSummary[]
  plannerSteps: SafeDecodedStepSummary[]
  terminalPlannerStep: SafeDecodedStepSummary | undefined
}

type WireField =
  | { fieldNumber: number; wireType: 0; varint: bigint }
  | { fieldNumber: number; wireType: 1 }
  | { fieldNumber: number; wireType: 2; bytes: Buffer }
  | { fieldNumber: number; wireType: 5 }

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function readVarintWire(buffer: Buffer, start: number): { value: bigint; nextOffset: number } {
  let result = 0n
  let shift = 0n
  for (let index = 0; index < 10; index += 1) {
    const position = start + index
    if (position >= buffer.length) {
      throw new Error('Truncated Protobuf varint in Antigravity trajectory step.')
    }
    const byte = buffer[position]!
    if (index === 9 && byte > 0x01) {
      throw new Error('Overflowing Protobuf varint in Antigravity trajectory step.')
    }
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: result, nextOffset: position + 1 }
    shift += 7n
  }
  throw new Error('Unterminated Protobuf varint in Antigravity trajectory step.')
}

function decodeWireFields(buffer: Buffer): WireField[] {
  const fields: WireField[] = []
  let offset = 0
  while (offset < buffer.length) {
    const tag = readVarintWire(buffer, offset)
    offset = tag.nextOffset
    const wireType = Number(tag.value & 0x07n)
    const fieldNumber = Number(tag.value >> 3n)
    if (fieldNumber <= 0) {
      throw new Error('Invalid Protobuf field number in Antigravity trajectory step.')
    }
    if (wireType === 0) {
      const val = readVarintWire(buffer, offset)
      offset = val.nextOffset
      fields.push({ fieldNumber, wireType: 0, varint: val.value })
    } else if (wireType === 1) {
      if (offset + 8 > buffer.length) {
        throw new Error('Truncated fixed64 field in Antigravity trajectory step.')
      }
      offset += 8
      fields.push({ fieldNumber, wireType: 1 })
    } else if (wireType === 2) {
      const lenRead = readVarintWire(buffer, offset)
      offset = lenRead.nextOffset
      const byteLength = Number(lenRead.value)
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength < 0 ||
        offset + byteLength > buffer.length
      ) {
        throw new Error('Truncated length-delimited field in Antigravity trajectory step.')
      }
      fields.push({
        fieldNumber,
        wireType: 2,
        bytes: buffer.subarray(offset, offset + byteLength),
      })
      offset += byteLength
    } else if (wireType === 5) {
      if (offset + 4 > buffer.length) {
        throw new Error('Truncated fixed32 field in Antigravity trajectory step.')
      }
      offset += 4
      fields.push({ fieldNumber, wireType: 5 })
    } else {
      throw new Error('Unsupported Protobuf wire type in Antigravity trajectory step.')
    }
  }
  return fields
}

function decodeStepTextsSafely(
  idx: number,
  rowStepType: number,
  rowStatus: number,
  payload: Buffer,
): SafeDecodedStepSummary {
  const topFields = decodeWireFields(payload)
  let userText: string | undefined
  let plannerText: string | undefined

  if (rowStepType === CORTEX_STEP_USER_INPUT) {
    const userField = topFields.find(
      (field): field is Extract<WireField, { wireType: 2 }> =>
        field.wireType === 2 && field.fieldNumber === 19,
    )
    if (userField) {
      const inner = decodeWireFields(userField.bytes)
      let userResponse = ''
      const itemParts: string[] = []
      for (const field of inner) {
        if (field.wireType !== 2) continue
        if (field.fieldNumber === 2) {
          userResponse = utf8FatalDecoder.decode(field.bytes)
        } else if (field.fieldNumber === 3) {
          for (const itemField of decodeWireFields(field.bytes)) {
            if (itemField.wireType === 2 && itemField.fieldNumber === 1) {
              itemParts.push(utf8FatalDecoder.decode(itemField.bytes))
            }
          }
        }
      }
      userText = userResponse.length > 0 ? userResponse : itemParts.join('')
    }
  } else if (rowStepType === CORTEX_STEP_PLANNER_RESPONSE) {
    const plannerField = topFields.find(
      (field): field is Extract<WireField, { wireType: 2 }> =>
        field.wireType === 2 && field.fieldNumber === 20,
    )
    if (plannerField) {
      const inner = decodeWireFields(plannerField.bytes)
      let response = ''
      let modifiedResponse = ''
      for (const field of inner) {
        if (field.wireType !== 2) continue
        if (field.fieldNumber === 1) {
          response = utf8FatalDecoder.decode(field.bytes)
        } else if (field.fieldNumber === 8) {
          modifiedResponse = utf8FatalDecoder.decode(field.bytes)
        }
      }
      plannerText = modifiedResponse.length > 0 ? modifiedResponse : response
    }
  }

  return {
    idx,
    stepType: rowStepType,
    status: rowStatus,
    userInputSha256: userText !== undefined ? sha256Hex(userText) : null,
    plannerResponseSha256: plannerText !== undefined ? sha256Hex(plannerText) : null,
    userContainsSmokeToken: userText !== undefined && userText.includes(SMOKE_TOKEN),
    plannerContainsSmokeToken: plannerText !== undefined && plannerText.includes(SMOKE_TOKEN),
  }
}

function isReadonlySqliteConstructor(value: unknown): value is ReadonlySqliteConstructor {
  return typeof value === 'function'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function openReadonlySqlite(filePath: string): ReadonlySqliteDatabase {
  const ctor: unknown = requireFromPersistence('better-sqlite3')
  if (!isReadonlySqliteConstructor(ctor)) {
    throw new Error('Owned better-sqlite3 constructor is unavailable')
  }
  return new ctor(filePath, { readonly: true, fileMustExist: true, timeout: 0 })
}

export function isExternalPullRequestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.GITHUB_EVENT_NAME === 'pull_request' || env.GITHUB_EVENT_NAME === 'pull_request_target') {
    return true
  }
  if (
    Boolean(env.CI) &&
    Boolean(env.GITHUB_HEAD_REF) &&
    Boolean(env.GITHUB_HEAD_REPOSITORY) &&
    env.GITHUB_REPOSITORY !== env.GITHUB_HEAD_REPOSITORY
  ) {
    return true
  }
  return false
}

export function isRealAgySmokeAuthorized(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PACT_E2E_REAL_AGY !== '1') return false
  if (isExternalPullRequestEnvironment(env)) {
    throw new Error('Paid real Antigravity E2E cannot be authorized on external pull requests.')
  }
  return true
}

export async function resolveRealAgyExecutable(env: NodeJS.ProcessEnv): Promise<string> {
  const explicit = env.PACT_E2E_AGY_EXECUTABLE
  if (explicit) {
    if (!isAbsolute(explicit) || /[\r\n\0]/u.test(explicit)) {
      throw new Error('PACT_E2E_AGY_EXECUTABLE must be an absolute path.')
    }
    return realpath(explicit)
  }
  const pathEntries = (env.PATH ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 128)
  const candidates = process.platform === 'win32' ? ['agy.cmd', 'agy.exe', 'agy'] : ['agy']
  for (const dir of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = join(dir, candidate)
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Ordered PATH executable lookup.
        const stat = await lstat(fullPath)
        if (stat.isFile() || stat.isSymbolicLink()) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Canonicalize matched executable once.
          return await realpath(fullPath)
        }
      } catch {
        /* Try next PATH entry. */
      }
    }
  }
  throw new Error(
    'Real Antigravity smoke test requires agy >= 1.5.9 via PACT_E2E_AGY_EXECUTABLE or PATH.',
  )
}

async function hasRegularNonSymlinkFile(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath)
    return info.isFile() && !info.isSymbolicLink()
  } catch (error) {
    if (isPlainRecord(error) && error['code'] === 'ENOENT') return false
    throw error
  }
}

/**
 * Reads an isolated trajectory SQLite copy and returns ONLY bounded structural facts and SHA-256
 * digests — raw trajectory text and buffers never leave this helper.
 */
async function readTrajectorySummaryCopy(
  fixtureDir: string,
  sourceDbPath: string,
  label: string,
): Promise<SafeTrajectorySummary> {
  const scratchDir = join(fixtureDir, 'readonly-sqlite-copies', `${label}-${Date.now()}`)
  await mkdir(scratchDir, { recursive: true, mode: 0o700 })
  await chmod(scratchDir, 0o700)
  const copyDbPath = join(scratchDir, 'trajectory.db')
  try {
    await copyFile(sourceDbPath, copyDbPath)
    for (const suffix of ['-wal', '-shm']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Copy optional SQLite sidecars sequentially before opening read-only.
      if (await hasRegularNonSymlinkFile(`${sourceDbPath}${suffix}`)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Bounded SQLite sidecar copy.
        await copyFile(`${sourceDbPath}${suffix}`, `${copyDbPath}${suffix}`)
      }
    }
    const trajDb = openReadonlySqlite(copyDbPath)
    try {
      const columns = trajDb
        .prepare('PRAGMA table_info("steps")')
        .all()
        .filter(isPlainRecord)
        .map((r) => (typeof r['name'] === 'string' ? r['name'] : ''))
      const steps = trajDb
        .prepare('SELECT idx, step_type, status, step_payload FROM "steps" ORDER BY idx ASC')
        .all()
        .filter(isPlainRecord)
        .map((row) => {
          const idx = Number(row['idx'] ?? -1)
          const stepType = Number(row['step_type'] ?? -1)
          const status = Number(row['status'] ?? -1)
          const rawPayload = Buffer.isBuffer(row['step_payload'])
            ? row['step_payload']
            : Buffer.alloc(0)
          return decodeStepTextsSafely(idx, stepType, status, rawPayload)
        })
      const userSteps = steps.filter((step) => step.stepType === CORTEX_STEP_USER_INPUT)
      const plannerSteps = steps.filter((step) => step.stepType === CORTEX_STEP_PLANNER_RESPONSE)
      const terminalPlannerStep = plannerSteps.at(-1)
      return {
        columns,
        stepCount: steps.length,
        cutStepIdx: steps.at(-1)?.idx ?? -1,
        steps,
        userSteps,
        plannerSteps,
        terminalPlannerStep,
      }
    } finally {
      trajDb.close()
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true })
  }
}

test(
  'opt-in local real Antigravity CLI smoke completes readiness, @agy prompt, cold SQLite verification, and Fork in isolated HOME',
  { tag: ['@real', '@real-extended'] },
  async ({ browserName: _browserName }, testInfo) => {
    if (!isRealAgySmokeAuthorized(process.env)) {
      test.skip(true, 'Opt-in paid real Antigravity smoke requires PACT_E2E_REAL_AGY=1.')
      return
    }
    test.setTimeout(180_000)

    // Real-provider artifact suppression: traces, screenshots, and video must remain off.
    expect(testInfo.project.name).toBe('real')
    expect(testInfo.project.use.trace).toBe('off')
    expect(testInfo.project.use.screenshot).toBe('off')
    expect(testInfo.project.use.video).toBe('off')

    requireExplicitAgyAuthDir(process.env)
    const agyExecutable = await resolveRealAgyExecutable(process.env)

    let authManifest: CopiedAgyAuthManifest | undefined
    const sanitizeError = (message: string): string =>
      authManifest ? authManifest.redact(message) : redactRealAgyText(message)

    const fixture = await createRuntimeFixture({
      mode: 'deterministic',
      realProviderProtection: true,
      redactText: sanitizeError,
      firstUse: true,
      claude: 'ready',
      codex: 'ready',
      codexAppServer: 'fork_complete',
      ...(process.platform === 'darwin' && process.env.PACT_E2E_AGY_NATIVE_CREDENTIAL_STORE === '1'
        ? { nativeCredentialStore: true }
        : {}),
    })
    let app: ElectronApplication | undefined

    try {
      // 1. Validate & copy explicit PACT_E2E_AGY_AUTH_DIR into the isolated fixture FIRST,
      //    then probe agy --version inside the isolated project cwd + strict allowlist env!
      const isolatedHome = join(fixture.directory, 'home')
      authManifest = await copyIsolatedAgyAuthConfig(isolatedHome, process.env)

      const projectName = 'real-agy-smoke'
      const projectDirectory = await fixture.createProjectDirectory(projectName)
      await verifyAgyMinimumVersion(agyExecutable, process.env, {
        cwd: projectDirectory,
        isolatedRoot: isolatedHome,
      })

      const db = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
      try {
        db.runtimePreparationRepository.saveSelectedExecutablePath('agy', agyExecutable)
        db.defaultSessionSettingsRepository.save({
          primaryAgentId: 'agy',
          secondaryAgentId: 'codex',
          agents: {
            claude: { model: null, effort: null, speed: 'native' },
            codex: { model: null, effort: null, speed: 'native' },
            agy: { model: null, effort: null, speed: 'native' },
          },
          maxDiscussionRounds: 4,
          maxReviewCycles: 2,
          maxRepairAttempts: 2,
        })
      } finally {
        db.close()
      }

      app = await fixture.launch()
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(1440, 920)
      })
      const window = await app.firstWindow()
      await expect(window.getByRole('button', { name: 'Add project', exact: true })).toBeVisible({
        timeout: 30_000,
      })

      await expect
        .poll(
          async () =>
            window.evaluate(async () => {
              const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
              const state = await bridge.getRuntimePreparation()
              if (!state.ok) return 'error'
              return state.value.agents.find((a) => a.agentId === 'agy')?.state ?? 'missing'
            }),
          { timeout: 30_000, intervals: [500, 1000, 2000] },
        )
        .toBe('ready')
      await window.evaluate(() => {
        globalThis.dispatchEvent(new Event('focus'))
      })

      await app.evaluate(({ dialog }, selectedPath) => {
        Reflect.set(dialog, 'showOpenDialog', async () => ({
          canceled: false,
          filePaths: [selectedPath],
        }))
      }, projectDirectory)
      await window.getByRole('button', { name: 'Add project', exact: true }).click()
      await expect(
        window.getByRole('button', { name: `Rename Project ${projectName}`, exact: true }),
      ).toBeVisible({ timeout: 15_000 })
      await window.getByRole('button', { name: `New Session in ${projectName}` }).focus()
      await window.getByRole('button', { name: `New Session in ${projectName}` }).click()
      const createSessionButton = window.getByRole('button', {
        name: 'Create Session',
        exact: true,
      })
      await expect(createSessionButton).toBeEnabled({ timeout: 30_000 })
      await createSessionButton.click()
      await expect(
        window
          .getByRole('region', { name: 'Workspace', exact: true })
          .getByRole('combobox', { name: 'Message' }),
      ).toBeVisible({ timeout: 30_000 })

      const mainWorkspace = window.getByRole('region', { name: 'Workspace', exact: true })
      const composer = mainWorkspace.getByRole('combobox', { name: 'Message' })
      await expect(composer).toBeEnabled({ timeout: 15_000 })

      // Establish peer Codex baseline so active-pair Fork has both sides
      await composer.click()
      await composer.fill('@codex Baseline check.')
      await mainWorkspace.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect(mainWorkspace.getByText('Bounded lifecycle response.')).toBeVisible({
        timeout: 15_000,
      })
      await expect(composer).toBeEnabled({ timeout: 15_000 })

      // Send real @agy prompt inside isolated HOME/.gemini/antigravity-cli
      await composer.click()
      await composer.fill(
        '@agy Reply with the single token PACT_REAL_AGY_SMOKE_OK and do not edit any files.',
      )
      await mainWorkspace.getByRole('button', { name: 'Send message', exact: true }).click()

      const agyReply = mainWorkspace
        .locator('article[data-pact-speaker="agy"]')
        .filter({ hasText: SMOKE_TOKEN })
      await expect(agyReply).toBeVisible({ timeout: 90_000 })

      const { projectId, activeSessionId } = await window.evaluate(async () => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const projects = await bridge.getProjectCatalog()
        if (!projects.ok || projects.value.projects.length === 0) {
          throw new Error('Project catalog unavailable')
        }
        const pid = projects.value.projects[0]!.id
        const sessions = await bridge.getSessionCatalog(pid)
        if (!sessions.ok || sessions.value.sessions.length === 0) {
          throw new Error('Session catalog unavailable')
        }
        return { projectId: pid, activeSessionId: sessions.value.sessions[0]!.id }
      })
      const nativeSid = (() => {
        const readDb = ReadonlyFixtureDatabase.open(fixture)
        try {
          const snapshot = readDb.conversationRepository.read(activeSessionId)
          return snapshot.nativeContexts.find((c) => c.agentId === 'agy')?.nativeSessionId
        } finally {
          readDb.close()
        }
      })()
      expect(nativeSid).toBeDefined()

      const isolatedConversationsDir = join(
        isolatedHome,
        '.gemini',
        'antigravity-cli',
        'conversations',
      )
      const isolatedDbPath = join(isolatedConversationsDir, `${nativeSid!}.db`)
      const parentTrajectory = await readTrajectorySummaryCopy(
        fixture.directory,
        isolatedDbPath,
        'parent',
      )
      expect(parentTrajectory.columns).toContain('step_payload')
      expect(parentTrajectory.columns).toContain('step_format')
      expect(parentTrajectory.stepCount).toBeGreaterThanOrEqual(2)
      expect(parentTrajectory.userSteps.length).toBeGreaterThanOrEqual(1)
      expect(parentTrajectory.plannerSteps.length).toBeGreaterThanOrEqual(1)
      const parentUserStep = parentTrajectory.userSteps[0]!
      const parentPlannerStep = parentTrajectory.terminalPlannerStep!
      expect(
        {
          stepCount: parentTrajectory.stepCount,
          cutStepIdx: parentTrajectory.cutStepIdx,
          plannerIdx: parentPlannerStep.idx,
          plannerStatus: parentPlannerStep.status,
          plannerDigestPresent: Boolean(parentPlannerStep.plannerResponseSha256),
          distinctFromUserPrompt:
            parentPlannerStep.plannerResponseSha256 !== parentUserStep.userInputSha256,
          plannerContainsSmokeToken: parentPlannerStep.plannerContainsSmokeToken,
        },
        `Parent trajectory planner_response verification failed: ${JSON.stringify({
          stepCount: parentTrajectory.stepCount,
          cutStepIdx: parentTrajectory.cutStepIdx,
          plannerStatus: parentPlannerStep.status,
          userDigest: parentUserStep.userInputSha256,
          plannerDigest: parentPlannerStep.plannerResponseSha256,
        })}`,
      ).toEqual({
        stepCount: parentTrajectory.stepCount,
        cutStepIdx: parentPlannerStep.idx,
        plannerIdx: parentPlannerStep.idx,
        plannerStatus: CORTEX_STEP_STATUS_DONE,
        plannerDigestPresent: true,
        distinctFromUserPrompt: true,
        plannerContainsSmokeToken: true,
      })

      // Fork at the real Antigravity reply
      await agyReply.hover()
      await agyReply
        .getByRole('button', { name: 'Fork conversation from this reply', exact: true })
        .click()
      const forkDialog = window.getByRole('dialog', { name: 'Fork conversation' })
      await expect(forkDialog).toBeVisible()
      await forkDialog.getByRole('button', { name: 'Create fork', exact: true }).click()
      await expect(forkDialog).toHaveCount(0, { timeout: 30_000 })

      let childSessionId: string | undefined
      await expect
        .poll(
          async () => {
            childSessionId = await window.evaluate(
              async ({ pid, parentId }) => {
                const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
                const sessions = await bridge.getSessionCatalog(pid)
                if (!sessions.ok) return undefined
                return sessions.value.sessions.find((s) => s.id !== parentId)?.id
              },
              { pid: projectId, parentId: activeSessionId },
            )
            return childSessionId
          },
          { timeout: 30_000, intervals: [250, 500, 1000] },
        )
        .toBeDefined()

      let childNativeSid: string | undefined
      await expect
        .poll(
          () => {
            const readDb = ReadonlyFixtureDatabase.open(fixture)
            try {
              const childSnapshot = readDb.conversationRepository.read(childSessionId!)
              const forkOp = childSnapshot.forkOperation
              if (!forkOp || !forkOp.ready || forkOp.sides.length !== 2) {
                return 'pending'
              }
              const agySide = forkOp.sides.find((s) => s.agentId === 'agy')
              const codexSide = forkOp.sides.find((s) => s.agentId === 'codex')
              if (agySide?.state !== 'ready' || codexSide?.state !== 'ready') {
                return 'sides_not_ready'
              }
              childNativeSid = childSnapshot.nativeContexts.find(
                (c) => c.agentId === 'agy',
              )?.nativeSessionId
              return childNativeSid ? 'ready' : 'missing_context'
            } finally {
              readDb.close()
            }
          },
          { timeout: 30_000, intervals: [250, 500, 1000] },
        )
        .toBe('ready')

      expect(childNativeSid).toBeDefined()
      expect(childNativeSid).not.toBe(nativeSid)

      const childDbPath = join(isolatedConversationsDir, `${childNativeSid!}.db`)
      const childTrajectory = await readTrajectorySummaryCopy(
        fixture.directory,
        childDbPath,
        'child',
      )
      const childUserStep = childTrajectory.userSteps[0]
      const childPlannerStep = childTrajectory.terminalPlannerStep
      expect(
        {
          stepCount: childTrajectory.stepCount,
          cutStepIdx: childTrajectory.cutStepIdx,
          firstStepType: childTrajectory.steps[0]?.stepType ?? -1,
          lastStepType: childTrajectory.steps.at(-1)?.stepType ?? -1,
          plannerStatus: childPlannerStep?.status ?? -1,
          userDigest: childUserStep?.userInputSha256 ?? null,
          plannerDigest: childPlannerStep?.plannerResponseSha256 ?? null,
          plannerContainsSmokeToken: childPlannerStep?.plannerContainsSmokeToken ?? false,
        },
        `Forked child trajectory planner_response verification failed: ${JSON.stringify({
          parentStepCount: parentTrajectory.stepCount,
          childStepCount: childTrajectory.stepCount,
          parentCutStepIdx: parentTrajectory.cutStepIdx,
          childCutStepIdx: childTrajectory.cutStepIdx,
          childPlannerStatus: childPlannerStep?.status ?? null,
          parentPlannerDigest: parentPlannerStep.plannerResponseSha256,
          childPlannerDigest: childPlannerStep?.plannerResponseSha256 ?? null,
        })}`,
      ).toEqual({
        stepCount: parentTrajectory.stepCount,
        cutStepIdx: parentTrajectory.cutStepIdx,
        firstStepType: CORTEX_STEP_USER_INPUT,
        lastStepType: CORTEX_STEP_PLANNER_RESPONSE,
        plannerStatus: CORTEX_STEP_STATUS_DONE,
        userDigest: parentUserStep.userInputSha256,
        plannerDigest: parentPlannerStep.plannerResponseSha256,
        plannerContainsSmokeToken: true,
      })
    } catch (error) {
      // oxlint-disable-next-line eslint/preserve-caught-error -- Sanitize real-provider error text without retaining credential-bearing causes.
      throw new Error(sanitizeError(error instanceof Error ? error.message : 'Real smoke failed'))
    } finally {
      let cleanupError: unknown
      for (const cleanupStep of [
        async () => {
          if (app) await quitPact(app)
        },
        async () => fixture.dispose(),
        async () => authManifest?.assertSourceIntegrity(),
      ]) {
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Settle app shutdown, fixture disposal, and source integrity in order without skipping later steps.
          await cleanupStep()
        } catch (stepError) {
          cleanupError ??= stepError
        }
      }
      if (cleanupError !== undefined) {
        // oxlint-disable-next-line eslint/no-unsafe-finally -- Surface redacted cleanup or integrity failure rather than masking leaked resources.
        throw new Error(
          sanitizeError(
            cleanupError instanceof Error ? cleanupError.message : 'Real smoke cleanup failed',
          ),
        )
      }
    }
  },
)
