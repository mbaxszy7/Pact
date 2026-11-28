import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import {
  collaborationPlanSettlementSchema,
  collaborationTaskSchema,
  collaborationTurnAuthorizationSchema,
  type AgentRun,
  type CollaborationPlanSettlement,
  type CollaborationTask,
  type CollaborationTurnAuthorization,
  type DesktopBridge,
  type RuntimeAgentId,
  type WorkspaceChangeSet,
  type WorkspaceFileChange,
} from '../../packages/contracts/src/index.js'
import { workflowTurns } from '../../packages/persistence/src/schema/index.js'
import {
  isExternalPullRequestEnvironment,
  runIsolatedKeylessProjectNode,
} from './provider-environment.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import {
  closeRealWorkspace,
  launchRealWorkspace,
  readRealConversation,
  resolveRealModelAndEffortTarget,
  restartRealWorkspace,
  selectRealAskPermission,
  sendRealMessage,
  type RealWorkspace,
} from './real-harness.js'
import { test } from './runtime-fixture.js'
import { stageRoleApprovalLabel } from './stage-role-approval.js'

const persistencePackageJsonPath = resolve(
  import.meta.dirname,
  '../../packages/persistence/package.json',
)
const requireFromPersistence = createRequire(persistencePackageJsonPath)
const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true })

const REAL_CASE_A_TIMEOUT_MS = 1_080_000
const REAL_CASE_B_TIMEOUT_MS = 720_000
const POLL_DEADLINE_RESERVE_MS = 30_000
const STAGE_POLL_TIMEOUT_MS = 300_000
const TWO_TURN_STAGE_POLL_TIMEOUT_MS = 480_000
const MAX_TRAJECTORY_STEPS = 4096
const MAX_WORKSPACE_PAGES = 32
const MAX_APPROVALS = 8
const CORTEX_STEP_USER_INPUT = 14
const CORTEX_STEP_PLANNER_RESPONSE = 15
const CORTEX_STEP_STATUS_DONE = 3
const STRICT_UUID_DB_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db(?:-wal|-shm)?$/iu
const ABNORMAL_ATTENTION_STATES = new Set([
  'recovering',
  'approval',
  'input',
  'running',
  'preparing',
])

const INITIAL_PORT_CODE = 'export function parsePort(value) {\n  return value\n}\n'
const IMMUTABLE_PORT_TESTS = `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePort } from './parse-port.mjs'

test('accepts integers and whitespace-free decimal strings in 1..65535 and returns null otherwise', () => {
  assert.equal(parsePort(1), 1)
  assert.equal(parsePort(80), 80)
  assert.equal(parsePort(65535), 65535)
  assert.equal(parsePort('443'), 443)
  assert.equal(parsePort('65535'), 65535)
  assert.equal(parsePort(0), null)
  assert.equal(parsePort(-1), null)
  assert.equal(parsePort(65536), null)
  assert.equal(parsePort(3.14), null)
  assert.equal(parsePort(Number.NaN), null)
  assert.equal(parsePort('0'), null)
  assert.equal(parsePort('080'), null)
  assert.equal(parsePort('+80'), null)
  assert.equal(parsePort('65536'), null)
  assert.equal(parsePort(' 80'), null)
  assert.equal(parsePort('80 '), null)
  assert.equal(parsePort(''), null)
  assert.equal(parsePort('abc'), null)
  assert.equal(parsePort('80abc'), null)
  assert.equal(parsePort(null), null)
  assert.equal(parsePort(undefined), null)
})
`

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

type WireField =
  | { fieldNumber: number; wireType: 0; varint: bigint }
  | { fieldNumber: number; wireType: 1 }
  | { fieldNumber: number; wireType: 2; bytes: Buffer }
  | { fieldNumber: number; wireType: 5 }

interface SafeDecodedStepSummary {
  idx: number
  stepType: number
  status: number
  userInputSha256: string | null
  plannerResponseSha256: string | null
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

interface ApprovedInteractionRecord {
  id: string
  agentId: RuntimeAgentId
  operationId: string
  label: string
}

interface PermissionEventRow {
  runId: string
  eventType: string
  payload: Record<string, unknown>
}

interface CollaborationDbFacts {
  snapshot: ReturnType<ReadonlyFixtureDatabase['conversationRepository']['read']>
  task: CollaborationTask | null
  turnAuthByRunId: Map<string, CollaborationTurnAuthorization>
  turnMetaByRunId: Map<
    string,
    {
      turnVerdict: 'accepted' | 'changes_requested' | 'needs_user' | 'incomplete' | null
      verdictConflict: boolean
      turnApplied: boolean
      hasReportBody: boolean
    }
  >
  sqlFailureKindsByRunId: Map<string, string | null>
  eventCountsByRunId: Map<string, Record<string, number>>
  runTimingAndToolsByRunId: Map<
    string,
    { firstEventAt: string | null; lastEventAt: string | null; toolNames: string[] }
  >
  planSettledEvents: Array<{ runId: string; payload: CollaborationPlanSettlement }>
  permissionEvents: PermissionEventRow[]
}

export function isRealAgyCollaborationAuthorized(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['PACT_E2E_REAL_AGY_COLLAB'] !== '1') return false
  if (isExternalPullRequestEnvironment(env)) {
    throw new Error('Paid real Antigravity E2E cannot be authorized on external pull requests.')
  }
  return true
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReadonlySqliteConstructor(value: unknown): value is ReadonlySqliteConstructor {
  return typeof value === 'function'
}

function openReadonlySqlite(filePath: string): ReadonlySqliteDatabase {
  const ctor: unknown = requireFromPersistence('better-sqlite3')
  if (!isReadonlySqliteConstructor(ctor)) {
    throw new Error('Owned better-sqlite3 constructor is unavailable')
  }
  return new ctor(filePath, { readonly: true, fileMustExist: true, timeout: 0 })
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
  }
}

async function readQuiescentTrajectoryCopy(
  fixtureDir: string,
  geminiHome: string,
  nativeSessionId: string,
  label: string,
): Promise<{ trajectory: SafeTrajectorySummary; summaryStepCount: number | null }> {
  const agyRoot = join(geminiHome, 'antigravity-cli')
  const conversationsDir = join(agyRoot, 'conversations')
  const entries = (await readdir(conversationsDir)).toSorted()
  for (const entry of entries) {
    if (!STRICT_UUID_DB_RE.test(entry)) {
      throw new Error(`Unexpected Antigravity conversations artifact: ${entry}`)
    }
  }

  const sourceDbPath = join(conversationsDir, `${nativeSessionId}.db`)
  const summariesDbPath = join(agyRoot, 'conversation_summaries.db')
  const scratchDir = join(fixtureDir, 'readonly-sqlite-copies', `${label}-${Date.now()}`)
  await mkdir(scratchDir, { recursive: true, mode: 0o700 })
  await chmod(scratchDir, 0o700)
  const copyDbPath = join(scratchDir, 'trajectory.db')
  const copySummaryPath = join(scratchDir, 'conversation_summaries.db')
  try {
    await copyFile(sourceDbPath, copyDbPath)
    for (const suffix of ['-wal', '-shm']) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Copy optional SQLite sidecars sequentially before opening read-only.
      if (await hasRegularNonSymlinkFile(`${sourceDbPath}${suffix}`)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Bounded SQLite sidecar copy.
        await copyFile(`${sourceDbPath}${suffix}`, `${copyDbPath}${suffix}`)
      }
    }
    let trajectory: SafeTrajectorySummary
    const trajDb = openReadonlySqlite(copyDbPath)
    try {
      const columns = trajDb
        .prepare('PRAGMA table_info("steps")')
        .all()
        .filter(isPlainRecord)
        .map((row) => (typeof row['name'] === 'string' ? row['name'] : ''))
      const steps = trajDb
        .prepare(
          `SELECT idx, step_type, status, step_payload FROM "steps" ORDER BY idx ASC LIMIT ${MAX_TRAJECTORY_STEPS}`,
        )
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
      trajectory = {
        columns,
        stepCount: steps.length,
        cutStepIdx: steps.at(-1)?.idx ?? -1,
        steps,
        userSteps,
        plannerSteps,
        terminalPlannerStep: plannerSteps.at(-1),
      }
    } finally {
      trajDb.close()
    }

    let summaryStepCount: number | null = null
    if (await hasRegularNonSymlinkFile(summariesDbPath)) {
      await copyFile(summariesDbPath, copySummaryPath)
      for (const suffix of ['-wal', '-shm']) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Copy optional SQLite sidecars sequentially before opening read-only.
        if (await hasRegularNonSymlinkFile(`${summariesDbPath}${suffix}`)) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Bounded SQLite sidecar copy.
          await copyFile(`${summariesDbPath}${suffix}`, `${copySummaryPath}${suffix}`)
        }
      }
      const summaryDb = openReadonlySqlite(copySummaryPath)
      try {
        const row = summaryDb
          .prepare('SELECT step_count FROM "conversation_summaries" WHERE "conversation_id" = ?')
          .all(nativeSessionId)
          .find(isPlainRecord)
        summaryStepCount = row && typeof row['step_count'] === 'number' ? row['step_count'] : null
      } finally {
        summaryDb.close()
      }
    }
    return { trajectory, summaryStepCount }
  } finally {
    await rm(scratchDir, { recursive: true, force: true })
  }
}

async function waitForSynchronizedQuiescentTrajectoryCopy(
  fixtureDir: string,
  geminiHome: string,
  nativeSessionId: string,
  label: string,
  timeoutMs = 15_000,
): Promise<Awaited<ReturnType<typeof readQuiescentTrajectoryCopy>>> {
  let latest: Awaited<ReturnType<typeof readQuiescentTrajectoryCopy>> | undefined
  await expect
    .poll(
      async () => {
        latest = await readQuiescentTrajectoryCopy(fixtureDir, geminiHome, nativeSessionId, label)
        return (
          latest.trajectory.terminalPlannerStep?.status === CORTEX_STEP_STATUS_DONE &&
          latest.summaryStepCount === latest.trajectory.stepCount
        )
      },
      { timeout: timeoutMs, intervals: [250, 500, 1000] },
    )
    .toBe(true)
  if (!latest) {
    throw new Error(`Trajectory snapshot was not captured for ${label}`)
  }
  return latest
}

async function runKeylessPortVerification(
  fixtureDir: string,
  projectDirectory: string,
  options: { verifyFallback?: boolean } = {},
): Promise<{ passed: boolean; assertionFailure: boolean }> {
  const configuredEnvDir = process.env['PACT_E2E_ENV_DIR'] ?? resolve(import.meta.dirname, 'env')
  const forbiddenPaths = [fixtureDir, configuredEnvDir]

  const baseTest = await runIsolatedKeylessProjectNode({
    projectDirectory,
    entry: { kind: 'test', file: 'parse-port.test.mjs' },
    forbiddenPaths,
    timeoutMs: 10_000,
  })
  if (baseTest.code !== 0) {
    const assertionFailure =
      baseTest.code === 1 &&
      !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(baseTest.combined) &&
      /AssertionError|ERR_ASSERTION|not strictly equal/iu.test(baseTest.combined)
    return { passed: false, assertionFailure }
  }

  if (options.verifyFallback) {
    const fallbackCheck = await runIsolatedKeylessProjectNode({
      projectDirectory,
      entry: {
        kind: 'eval',
        code: [
          "import assert from 'node:assert/strict';",
          "import { parsePort } from './parse-port.mjs';",
          "assert.equal(parsePort('bad', 8443), 8443);",
          'assert.equal(parsePort(0, 8080), 8080);',
          'assert.equal(parsePort(65536, 3000), 3000);',
          "assert.equal(parsePort('080', 9000), 9000);",
          "assert.equal(parsePort(null, 'none'), 'none');",
          "assert.equal(parsePort('443', 8443), 443);",
          'assert.equal(parsePort(80, 8443), 80);',
          "assert.equal(parsePort('bad'), null);",
          "assert.equal(parsePort('bad', undefined), null);",
        ].join(' '),
      },
      forbiddenPaths,
      timeoutMs: 10_000,
    })
    return { passed: fallbackCheck.code === 0, assertionFailure: false }
  }

  return { passed: true, assertionFailure: false }
}

function readCollaborationDbFacts(ctx: RealWorkspace): CollaborationDbFacts {
  const db = ReadonlyFixtureDatabase.open(ctx.fixture)
  try {
    const snapshot = db.conversationRepository.read(ctx.sessionId)
    const taskRow = db.drizzle.query.collaborationTasks
      .findFirst({
        where: (table, { eq }) => eq(table.sessionId, ctx.sessionId),
      })
      .sync()
    const task = taskRow ? collaborationTaskSchema.parse(JSON.parse(taskRow.stateJson)) : null

    const turnAuthByRunId = new Map<string, CollaborationTurnAuthorization>()
    const turnMetaByRunId = new Map<
      string,
      {
        turnVerdict: 'accepted' | 'changes_requested' | 'needs_user' | 'incomplete' | null
        verdictConflict: boolean
        turnApplied: boolean
        hasReportBody: boolean
      }
    >()
    const runIdSet = new Set(snapshot.runs.map((run) => run.id))
    if (runIdSet.size > 0) {
      const turnRows = db.drizzle
        .select({
          runId: workflowTurns.runId,
          authorizationJson: workflowTurns.authorizationJson,
          verdict: workflowTurns.verdict,
          verdictConflict: workflowTurns.verdictConflict,
          applied: workflowTurns.applied,
          reportBodyId: workflowTurns.reportBodyId,
        })
        .from(workflowTurns)
        .all()
      for (const row of turnRows) {
        if (!runIdSet.has(row.runId)) continue
        turnAuthByRunId.set(
          row.runId,
          collaborationTurnAuthorizationSchema.parse(JSON.parse(row.authorizationJson)),
        )
        turnMetaByRunId.set(row.runId, {
          turnVerdict: row.verdict ?? null,
          verdictConflict: row.verdictConflict,
          turnApplied: row.applied,
          hasReportBody: Boolean(row.reportBodyId),
        })
      }
    }

    const sqlFailureKindsByRunId = new Map<string, string | null>()
    const runRows = db.drizzle.query.agentRuns
      .findMany({
        columns: { id: true, failureKind: true },
        where: (table, { eq }) => eq(table.sessionId, ctx.sessionId),
      })
      .sync()
    for (const row of runRows) {
      sqlFailureKindsByRunId.set(row.id, row.failureKind ?? null)
    }

    const journalRows = db.drizzle.query.agentEventJournal
      .findMany({
        columns: { runId: true, eventType: true, payload: true, createdAt: true },
        where: (table, { eq }) => eq(table.sessionId, ctx.sessionId),
        orderBy: (table, { asc }) => [asc(table.sequence)],
      })
      .sync()

    const eventCountsByRunId = new Map<string, Record<string, number>>()
    const runTimingAndToolsByRunId = new Map<
      string,
      { firstEventAt: string | null; lastEventAt: string | null; toolNames: string[] }
    >()
    const planSettledEvents: Array<{ runId: string; payload: CollaborationPlanSettlement }> = []
    const permissionEvents: PermissionEventRow[] = []
    for (const row of journalRows) {
      let counts = eventCountsByRunId.get(row.runId)
      if (!counts) {
        counts = {}
        eventCountsByRunId.set(row.runId, counts)
      }
      if (row.eventType !== '__proto__') {
        const prev = Object.hasOwn(counts, row.eventType) ? (counts[row.eventType] ?? 0) : 0
        counts[row.eventType] = prev + 1
      }
      let timing = runTimingAndToolsByRunId.get(row.runId)
      if (!timing) {
        timing = {
          firstEventAt: row.createdAt,
          lastEventAt: row.createdAt,
          toolNames: [],
        }
        runTimingAndToolsByRunId.set(row.runId, timing)
      } else {
        timing.lastEventAt = row.createdAt
      }
      if (row.eventType === 'tool.started' && timing.toolNames.length < 16) {
        try {
          const parsed: unknown = JSON.parse(row.payload)
          if (isPlainRecord(parsed) && typeof parsed['toolName'] === 'string') {
            timing.toolNames.push(parsed['toolName'].slice(0, 80))
          }
        } catch {
          // Ignore malformed event payloads in diagnostic telemetry.
        }
      }
      if (row.eventType === 'workflow.plan_settled') {
        const parsed: unknown = JSON.parse(row.payload)
        planSettledEvents.push({
          runId: row.runId,
          payload: collaborationPlanSettlementSchema.parse(parsed),
        })
      } else if (
        row.eventType === 'native.permission_requested' ||
        row.eventType === 'native.permission_decided'
      ) {
        const parsed: unknown = JSON.parse(row.payload)
        if (isPlainRecord(parsed)) {
          permissionEvents.push({
            runId: row.runId,
            eventType: row.eventType,
            payload: parsed,
          })
        }
      }
    }

    return {
      snapshot,
      task,
      turnAuthByRunId,
      turnMetaByRunId,
      sqlFailureKindsByRunId,
      eventCountsByRunId,
      runTimingAndToolsByRunId,
      planSettledEvents,
      permissionEvents,
    }
  } finally {
    db.close()
  }
}

async function readCollaborationView(ctx: RealWorkspace) {
  return ctx.page.evaluate(async (sessionId) => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    const result = await bridge.getConversation({ scope: 'collaboration', sessionId })
    if (!result.ok || result.value.scope !== 'collaboration') {
      throw new Error('Workflow view unavailable')
    }
    return result.value.view
  }, ctx.sessionId)
}

async function readPendingInteractionSummaries(ctx: RealWorkspace) {
  return ctx.page.evaluate(async (sessionId) => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    const page = await bridge.getConversation({ scope: 'messages', sessionId })
    if (!page.ok || page.value.scope !== 'messages') {
      return []
    }
    return (page.value.header.pendingNativeInteractions ?? []).map((entry) => ({
      agent: entry.agentId,
      kind: entry.request.kind,
    }))
  }, ctx.sessionId)
}

async function readWorkflowFailure(
  ctx: RealWorkspace,
  phase: string,
  cause?: unknown,
): Promise<Error> {
  const [facts, currentView, pendingInteractions] = await Promise.all([
    Promise.resolve(readCollaborationDbFacts(ctx)),
    readCollaborationView(ctx),
    readPendingInteractionSummaries(ctx),
  ])
  return new Error(
    ctx.fixture.redactDiagnostic(
      JSON.stringify({
        phase,
        task: currentView.task
          ? {
              status: currentView.task.status,
              stage: currentView.task.stage,
              notice: currentView.task.notice,
              verdict: currentView.task.review?.verdict,
              pauseReason: currentView.task.pauseReason,
              discussionRounds: currentView.task.discussionRounds,
              reviewCycles: currentView.task.reviewCycles,
              repairAttempts: currentView.task.repairAttempts,
              hasDecision: Boolean(currentView.task.inputProcessing?.decision),
            }
          : null,
        pendingInteractions,
        runs: facts.snapshot.runs.map((run) => {
          const turnMeta = facts.turnMetaByRunId.get(run.id)
          const timing = facts.runTimingAndToolsByRunId.get(run.id)
          return {
            agent: run.agentId,
            stage: run.collaboration?.stage,
            status: run.status,
            dispatchPhase: run.dispatchPhase,
            nativeOutcome: run.nativeOutcome,
            effects: run.nativeEffectsState,
            failureKind: run.failureKind,
            startedAt: run.createdAt,
            firstEventAt: timing?.firstEventAt ?? null,
            lastEventAt: timing?.lastEventAt ?? null,
            toolNames: timing?.toolNames ?? [],
            turnVerdict: turnMeta?.turnVerdict ?? null,
            verdictConflict: turnMeta?.verdictConflict ?? false,
            turnApplied: turnMeta?.turnApplied ?? false,
            hasReportBody: turnMeta?.hasReportBody ?? false,
            eventCounts: facts.eventCountsByRunId.get(run.id) ?? {},
            failureMessage: run.failureMessage
              ? ctx.fixture.redactDiagnostic(run.failureMessage).slice(0, 600)
              : undefined,
          }
        }),
      }),
    ),
    cause !== undefined ? { cause } : undefined,
  )
}

async function pollStageUntil(
  ctx: RealWorkspace,
  phase: string,
  deadlineAt: number,
  intervals: number[],
  check: (current: Awaited<ReturnType<typeof readCollaborationView>>) => Promise<boolean> | boolean,
  stageTimeoutMs = STAGE_POLL_TIMEOUT_MS,
): Promise<void> {
  let terminalFailure: Error | undefined
  try {
    await expect
      .poll(
        async () => {
          const current = await readCollaborationView(ctx)
          if (current.task?.status === 'failed' || current.task?.status === 'questions') {
            terminalFailure = await readWorkflowFailure(ctx, phase)
            return 'failed' as const
          }
          try {
            return (await check(current)) ? ('done' as const) : ('pending' as const)
          } catch (error) {
            terminalFailure = error instanceof Error ? error : new Error(String(error))
            return 'failed' as const
          }
        },
        {
          timeout: Math.min(stageTimeoutMs, Math.max(5_000, deadlineAt - Date.now())),
          intervals,
        },
      )
      .not.toBe('pending')
  } catch (error) {
    throw await readWorkflowFailure(ctx, `${phase} (stage poll timeout)`, error)
  }
  if (terminalFailure) {
    throw terminalFailure
  }
}

async function assertHealthyCheckpoint(ctx: RealWorkspace): Promise<void> {
  const state = await ctx.page.evaluate(async (sessionId) => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    const [collab, messages, attention] = await Promise.all([
      bridge.getConversation({ scope: 'collaboration', sessionId }),
      bridge.getConversation({ scope: 'messages', sessionId }),
      bridge.readNativeAttention({}),
    ])
    return { collab, messages, attention }
  }, ctx.sessionId)

  expect(state.collab.ok).toBe(true)
  if (!state.collab.ok || state.collab.value.scope !== 'collaboration') {
    throw new Error('Collaboration view unavailable at checkpoint')
  }
  expect(state.collab.value.view.planSync).toBeUndefined()
  expect(state.collab.value.view.task?.status).not.toBe('failed')

  expect(state.messages.ok).toBe(true)
  if (!state.messages.ok || state.messages.value.scope !== 'messages') {
    throw new Error('Messages view unavailable at checkpoint')
  }
  expect(state.messages.value.header.pendingNativeInteractions ?? []).toEqual([])
  await expect(ctx.page.getByRole('combobox', { name: 'Message' })).toBeEnabled()

  expect(state.attention.ok).toBe(true)
  if (!state.attention.ok) {
    throw new Error('Native attention read failed at checkpoint')
  }
  const badRows = state.attention.value.sessions.filter(
    (row) => row.sessionId === ctx.sessionId && ABNORMAL_ATTENTION_STATES.has(row.state),
  )
  expect(badRows).toEqual([])
}

async function readAllWorkspaceChangesForRun(
  ctx: RealWorkspace,
  run: AgentRun,
): Promise<{
  hasChangeSet: boolean
  changeSet: WorkspaceChangeSet | null
  files: WorkspaceFileChange[]
}> {
  if (!run.workspaceChanges) {
    const absentResult = await ctx.page.evaluate(async (runId) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      return bridge.readWorkspaceChanges({ changeSetId: runId })
    }, run.id)
    expect(absentResult.ok).toBe(false)
    await expect(
      ctx.page.locator(`[data-pact-workspace-changes=${JSON.stringify(run.id)}]`),
    ).toHaveCount(0)
    return { hasChangeSet: false, changeSet: null, files: [] }
  }

  const collected: WorkspaceFileChange[] = []
  let afterPath: string | undefined
  let latestChangeSet: WorkspaceChangeSet | null = null
  for (let pageIndex = 0; pageIndex < MAX_WORKSPACE_PAGES; pageIndex += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Paginate bounded workspace changes sequentially via afterPath cursor.
    const result = await ctx.page.evaluate(
      async ({ changeSetId, cursor }) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.readWorkspaceChanges({
          changeSetId,
          ...(cursor !== undefined ? { afterPath: cursor } : {}),
        })
      },
      { changeSetId: run.workspaceChanges.id, cursor: afterPath },
    )
    if (!result.ok) {
      throw new Error(`Failed reading workspace changeSet ${run.workspaceChanges.id}`)
    }
    latestChangeSet = result.value.changeSet
    collected.push(...result.value.files)
    if (result.value.nextPath === null) break
    afterPath = result.value.nextPath
  }
  if (run.agentId === 'codex') {
    expect(['ready', 'mixed']).toContain(latestChangeSet?.state)
  } else {
    expect(latestChangeSet?.state).toBe('ready')
  }
  return { hasChangeSet: true, changeSet: latestChangeSet, files: collected }
}

async function approvePendingStageRequest(
  ctx: RealWorkspace,
  currentTask: CollaborationTask | null | undefined,
  implementer: RuntimeAgentId,
  approved: Map<string, ApprovedInteractionRecord>,
  options?: { allowCollaborateEdit?: boolean },
): Promise<void> {
  const requests = await ctx.page.evaluate(async (sessionId) => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    const page = await bridge.getConversation({ scope: 'messages', sessionId })
    if (!page.ok || page.value.scope !== 'messages') {
      throw new Error('Native approval state unavailable')
    }
    const pending = page.value.header.pendingNativeInteractions ?? []
    if (pending.length > 8) {
      throw new Error('Native approvals exceed the bounded interaction limit')
    }
    return Promise.all(
      pending.map(async ({ agentId, request }) => {
        if (!request.operationId) {
          throw new Error('Native approval has no owned operation identity')
        }
        const details = await bridge.readNativeInput({
          operationId: request.operationId,
          requestId: request.id,
        })
        return {
          agentId,
          id: request.id,
          operationId: request.operationId,
          details: details.ok ? details.value : undefined,
        }
      }),
    )
  }, ctx.sessionId)

  for (const request of requests) {
    if (!request.details || approved.has(request.id)) continue
    if (request.details.kind !== 'approval' || approved.size >= MAX_APPROVALS) {
      throw new Error('Unexpected native input or exceeded approval bound; fail closed')
    }
    const label = stageRoleApprovalLabel(request.details, {
      directory: ctx.projectDirectory,
      stage: currentTask?.stage,
      actor: currentTask?.actor,
      secondary: implementer,
      requestedAgent: request.agentId,
      targetFile: 'parse-port.mjs',
      testFile: 'parse-port.test.mjs',
      allowCollaborateEdit: options?.allowCollaborateEdit === true,
      allowImplementer: implementer,
    })
    if (!label) {
      throw new Error(
        ctx.fixture.redactDiagnostic(
          `Native approval rejected as out-of-scope: agent=${request.agentId}, stage=${currentTask?.stage ?? 'none'}, detail=${request.details.detail}`,
        ),
      )
    }
    approved.set(request.id, {
      id: request.id,
      agentId: request.agentId,
      operationId: request.operationId,
      label,
    })
    // oxlint-disable-next-line eslint/no-await-in-loop -- Inspect and click one live permission card sequentially.
    await ctx.page
      .locator(`[data-pact-native-permission=${JSON.stringify(request.id)}]`)
      .getByRole('button', { name: label, exact: true })
      .click()
  }
}

function agentButtonLabel(agent: RuntimeAgentId): string {
  return agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'Antigravity'
}

async function driveImplementAndCodeReviewToAcceptance(
  ctx: RealWorkspace,
  options: {
    implementer: RuntimeAgentId
    codeReviewer: RuntimeAgentId
    deadlineAt: number
    approved: Map<string, ApprovedInteractionRecord>
    verifyFallback: boolean
    testSha256: string
  },
): Promise<void> {
  const implementButton = ctx.page.getByRole('button', {
    name: `Implement plan · ${agentButtonLabel(options.implementer)}`,
    exact: true,
  })
  await expect(implementButton).toBeEnabled()
  await implementButton.click()

  await pollStageUntil(
    ctx,
    'implementation',
    options.deadlineAt,
    [250, 500, 1000],
    async (current) => {
      await approvePendingStageRequest(ctx, current.task, options.implementer, options.approved)
      return current.task?.stage === 'implement' && current.task.status === 'waiting'
    },
  )

  expect(sha256Hex(await readFile(join(ctx.projectDirectory, 'parse-port.test.mjs'), 'utf8'))).toBe(
    options.testSha256,
  )
  const verifiedAfterImplement = await runKeylessPortVerification(
    ctx.fixture.directory,
    ctx.projectDirectory,
    { verifyFallback: options.verifyFallback },
  )
  expect(verifiedAfterImplement.passed).toBe(true)

  const reviewButton = ctx.page.getByRole('button', {
    name: `Review code · ${agentButtonLabel(options.codeReviewer)}`,
    exact: true,
  })
  await expect(reviewButton).toBeEnabled()
  await reviewButton.click()

  await pollStageUntil(
    ctx,
    'code review',
    options.deadlineAt,
    [250, 500, 1000],
    async (current) => {
      await approvePendingStageRequest(ctx, current.task, options.implementer, options.approved)
      return (
        current.task?.stage === 'code_review' &&
        (current.task.status === 'waiting' || current.task.status === 'complete')
      )
    },
  )

  for (let repairCycle = 0; repairCycle < 3; repairCycle += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Inspect review state sequentially across bounded repair cycles.
    const afterReview = await readCollaborationView(ctx)
    if (
      afterReview.task?.review?.verdict !== 'changes_requested' ||
      !afterReview.availableActions.includes('fix')
    ) {
      break
    }
    const preFixRunId = afterReview.task.runId
    const fixButton = ctx.page.getByRole('button', {
      name: `Fix issues · ${agentButtonLabel(options.implementer)}`,
      exact: true,
    })
    // oxlint-disable-next-line eslint/no-await-in-loop -- Ensure Fix issues action is enabled sequentially per cycle.
    await expect(fixButton).toBeEnabled()
    // oxlint-disable-next-line eslint/no-await-in-loop -- Trigger Fix issues sequentially per cycle.
    await fixButton.click()
    // oxlint-disable-next-line eslint/no-await-in-loop -- Poll sequential Fix issues turn until settled.
    await pollStageUntil(ctx, 'repair', options.deadlineAt, [250, 500, 1000], async (current) => {
      await approvePendingStageRequest(ctx, current.task, options.implementer, options.approved, {
        allowCollaborateEdit: true,
      })
      return (
        current.task?.runId !== preFixRunId &&
        (current.task?.stage === 'collaborate' || current.task?.stage === 'repair') &&
        current.task.status === 'waiting'
      )
    })

    // oxlint-disable-next-line eslint/no-await-in-loop -- Read immutable test file sequentially after each repair cycle.
    const repairedTestSource = await readFile(
      join(ctx.projectDirectory, 'parse-port.test.mjs'),
      'utf8',
    )
    expect(sha256Hex(repairedTestSource)).toBe(options.testSha256)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Verify repaired code externally before sequential re-review.
    const verifiedAfterRepair = await runKeylessPortVerification(
      ctx.fixture.directory,
      ctx.projectDirectory,
      { verifyFallback: options.verifyFallback },
    )
    expect(verifiedAfterRepair.passed).toBe(true)

    const reReviewButton = ctx.page.getByRole('button', {
      name: `Review code · ${agentButtonLabel(options.codeReviewer)}`,
      exact: true,
    })
    // oxlint-disable-next-line eslint/no-await-in-loop -- Ensure Review code action is enabled sequentially after repair.
    await expect(reReviewButton).toBeEnabled()
    // oxlint-disable-next-line eslint/no-await-in-loop -- Trigger re-review sequentially after repair verification.
    await reReviewButton.click()
    // oxlint-disable-next-line eslint/no-await-in-loop -- Poll sequential re-review turn until settled.
    await pollStageUntil(
      ctx,
      'code re-review',
      options.deadlineAt,
      [250, 500, 1000],
      async (current) => {
        await approvePendingStageRequest(ctx, current.task, options.implementer, options.approved)
        return (
          current.task?.stage === 'code_review' &&
          (current.task.status === 'waiting' || current.task.status === 'complete')
        )
      },
    )
  }

  const finalView = await readCollaborationView(ctx)
  expect(finalView.task?.review).toMatchObject({
    actor: options.codeReviewer,
    stage: 'code_review',
    verdict: 'accepted',
  })
}

function assertRunsHealthyAndNoClaude(facts: CollaborationDbFacts): void {
  expect(facts.snapshot.runs.some((run) => run.agentId === 'claude')).toBe(false)
  for (const run of facts.snapshot.runs) {
    expect({
      status: run.status,
      nativeOutcome: run.nativeOutcome,
      dispatchPhase: run.dispatchPhase,
      nativeEffectsState: run.nativeEffectsState,
      failureKindPresent: run.failureKind !== undefined,
      sqlFailureKind: facts.sqlFailureKindsByRunId.get(run.id) ?? null,
    }).toEqual({
      status: 'completed',
      nativeOutcome: 'completed',
      dispatchPhase: 'ended',
      nativeEffectsState: 'settled',
      failureKindPresent: false,
      sqlFailureKind: null,
    })
  }
}

function assertAgyPermissionAuditPairs(
  permissionEvents: PermissionEventRow[],
  expectedRunIds: Set<string>,
  minCount: number,
): void {
  const requested = new Map<string, { runId: string; permissionId: string }>()
  const decided = new Map<
    string,
    {
      runId: string
      source: unknown
      decision: unknown
      actionId: unknown
      actionKind: unknown
    }
  >()

  for (const event of permissionEvents) {
    if (event.payload['agentId'] !== 'agy') continue
    if (
      event.eventType === 'native.permission_requested' &&
      Array.isArray(event.payload['requests'])
    ) {
      for (const req of event.payload['requests']) {
        if (!isPlainRecord(req) || typeof req['id'] !== 'string') continue
        requested.set(`${event.runId}:${req['id']}`, {
          runId: event.runId,
          permissionId: req['id'],
        })
      }
    } else if (
      event.eventType === 'native.permission_decided' &&
      isPlainRecord(event.payload['decision'])
    ) {
      const dec = event.payload['decision']
      const permissionId = dec['permissionId']
      if (typeof permissionId !== 'string') continue
      decided.set(`${event.runId}:${permissionId}`, {
        runId: event.runId,
        source: dec['source'],
        decision: dec['decision'],
        actionId: dec['actionId'],
        actionKind: dec['actionKind'],
      })
    }
  }

  expect(requested.size).toBeGreaterThanOrEqual(minCount)
  for (const [key, req] of requested) {
    expect(expectedRunIds.has(req.runId)).toBe(true)
    const match = decided.get(key)
    expect(match).toEqual({
      runId: req.runId,
      source: 'user',
      decision: 'accept',
      actionId: 'agy-allow-once',
      actionKind: 'allow',
    })
  }
}

async function safelyCloseWorkspace(
  ctx: RealWorkspace,
  cleanupFallbackMessage: string,
): Promise<void> {
  await closeRealWorkspace(ctx).catch((error) => {
    throw new Error(
      ctx.fixture.redactDiagnostic(error instanceof Error ? error.message : cleanupFallbackMessage),
      { cause: error },
    )
  })
}

async function selectAgentModelAndEffortInSettings(
  panel: ReturnType<RealWorkspace['page']['getByRole']>,
  agentId: RuntimeAgentId,
  modelId: string,
  effort: string | null,
): Promise<void> {
  const regionName =
    agentId === 'claude' ? 'Claude Code' : agentId === 'codex' ? 'Codex' : 'Antigravity'
  const region = panel.getByRole('region', { name: regionName, exact: true })
  const modelSelect = region.getByRole('combobox', { name: 'Model', exact: true })
  await expect(modelSelect).toBeEnabled({ timeout: 15_000 })
  await modelSelect.selectOption(modelId)
  const effortSelect = region.getByRole('combobox', { name: 'Effort', exact: true })
  if (effort !== null) {
    await expect(effortSelect).toBeEnabled({ timeout: 15_000 })
    await effortSelect.selectOption(effort)
  } else if (await effortSelect.isEnabled()) {
    await effortSelect.selectOption('')
  }
}

async function configureRealPairSettingsAndPermissions(
  ctx: RealWorkspace,
  pair: readonly [RuntimeAgentId, RuntimeAgentId],
): Promise<void> {
  const state = await ctx.page.evaluate(async (sessionId) => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    return bridge.getSessionSettings(sessionId)
  }, ctx.sessionId)
  if (!state.ok) throw new Error('Actual Session settings are unavailable')

  const models = ctx.fixture.readConfigurationModels()
  const targets = pair.map((agentId) => {
    const catalog = state.value.modelCatalogs[agentId]
    if (!catalog) throw new Error(`Missing model catalog for ${agentId}`)
    const currentAgent = state.value.session.settings.agents[agentId]
    const configuredModel =
      agentId === 'claude'
        ? models.claude
        : agentId === 'codex'
          ? models.codex
          : (models.agy ?? null)
    const { model, effort } = resolveRealModelAndEffortTarget(
      agentId,
      catalog,
      configuredModel,
      currentAgent.model,
    )
    return { agentId, modelId: model.id, effort }
  })

  await ctx.page.getByRole('button', { name: 'Session settings', exact: true }).click()
  const panel = ctx.page.getByRole('region', { name: 'Session settings', exact: true })
  await expect(panel).toBeVisible()
  const saveButton = panel.getByRole('button', { name: 'Save changes', exact: true })
  await expect(saveButton).toBeVisible({ timeout: 15_000 })

  await selectAgentModelAndEffortInSettings(
    panel,
    targets[0]!.agentId,
    targets[0]!.modelId,
    targets[0]!.effort,
  )
  await selectAgentModelAndEffortInSettings(
    panel,
    targets[1]!.agentId,
    targets[1]!.modelId,
    targets[1]!.effort,
  )

  if (await saveButton.isEnabled()) {
    await saveButton.click()
    await expect(saveButton).toBeDisabled({ timeout: 15_000 })
  }
  await panel.getByRole('button', { name: 'Close Session settings', exact: true }).click()
  await expect(panel).toBeHidden()

  await selectRealAskPermission(ctx, pair[0])
  await selectRealAskPermission(ctx, pair[1])
}

test(
  'opt-in real Primary agy authors multi-round Brain Plans v1 and v2 while Secondary codex reviews plans, implements after cold restart, and agy reviews code',
  { tag: ['@real', '@real-extended'] },
  async ({ browserName: _browserName }, testInfo) => {
    if (!isRealAgyCollaborationAuthorized(process.env)) {
      test.skip(
        true,
        'Opt-in paid real Antigravity collaboration E2E requires PACT_E2E_REAL_AGY_COLLAB=1.',
      )
      return
    }
    test.setTimeout(REAL_CASE_A_TIMEOUT_MS)
    expect(testInfo.project.name).toBe('real')
    expect(testInfo.project.use.trace).toBe('off')
    expect(testInfo.project.use.screenshot).toBe('off')
    expect(testInfo.project.use.video).toBe('off')

    const deadlineAt = Date.now() + REAL_CASE_A_TIMEOUT_MS - POLL_DEADLINE_RESERVE_MS
    const ctx = await launchRealWorkspace('real-agy-codex-case-a', {
      activePair: ['agy', 'codex'],
      strictInitialReadiness: true,
    })
    const testSha256 = sha256Hex(IMMUTABLE_PORT_TESTS)
    const approved = new Map<string, ApprovedInteractionRecord>()

    try {
      await writeFile(join(ctx.projectDirectory, 'parse-port.mjs'), INITIAL_PORT_CODE)
      await writeFile(join(ctx.projectDirectory, 'parse-port.test.mjs'), IMMUTABLE_PORT_TESTS)
      const red = await runKeylessPortVerification(ctx.fixture.directory, ctx.projectDirectory)
      expect(red).toEqual({ passed: false, assertionFailure: true })

      await configureRealPairSettingsAndPermissions(ctx, ['agy', 'codex'])

      // Plan v1 by Agy + Plan Review v1 by Codex
      await sendRealMessage(
        ctx,
        [
          '/plan Implement parsePort(value) in only parse-port.mjs.',
          'Exact specification: return integer value if Number.isInteger(value) && value >= 1 && value <= 65535;',
          'or if typeof value === "string" && /^[1-9]\\d{0,4}$/.test(value) and Number(value) <= 65535, return Number(value);',
          'for every other input (0, negatives, floats, leading zeros like "080", "+80", whitespace, empty strings, non-digits, objects, null, undefined) return null.',
          'The file parse-port.test.mjs is immutable acceptance evidence and must never be modified.',
          'During implementation, Codex edits parse-port.mjs using native file patching and runs exactly node --test parse-port.test.mjs for verification (do not invoke node -e; if a read-only reviewer cannot execute runtime test commands, label runtime execution Unverified rather than blocking or incomplete).',
          'All edge cases are fixed; do not ask questions.',
          'Write the concise (under 2,500 characters), complete official Markdown plan to <appDataDir>/brain/<sessionId>/implementation_plan.md using write_file (with Overwrite: true if the file already exists; never call retain_current_plan after changes_requested) or edit_file with ArtifactMetadata (Summary, UserFacing: true, RequestFeedback: true), then write a short assistant summary and end this turn without editing workspace files.',
        ].join(' '),
        'primary',
      )

      await pollStageUntil(
        ctx,
        'case-a plan v1 or review v1',
        deadlineAt,
        [500, 1000, 2000],
        (current) => current.accepted && current.task?.status === 'ready',
        TWO_TURN_STAGE_POLL_TIMEOUT_MS,
      )

      const afterV1 = readCollaborationDbFacts(ctx)
      expect(afterV1.task).not.toBeNull()
      const v1Task = afterV1.task!
      expect(v1Task).toMatchObject({
        rolePolicy: 'split-stages-v1',
        owner: 'agy',
        reviewer: 'codex',
        review: { actor: 'codex', stage: 'plan_review', verdict: 'accepted' },
      })
      expect(v1Task.planReference).toBeDefined()
      const v1Plan = v1Task.planReference!
      expect(v1Plan.author).toBe('agy')
      expect(v1Plan.version).toBeGreaterThanOrEqual(1)
      expect(v1Task.planInputSequence).toBeDefined()
      const v1PlanInputSequence = v1Task.planInputSequence!
      expect(
        afterV1.planSettledEvents.some(
          (event) =>
            event.runId === v1Plan.sourceRunId &&
            event.payload.kind === 'published' &&
            event.payload.planReference.document.sha256 === v1Plan.document.sha256,
        ),
      ).toBe(true)
      expect(
        afterV1.permissionEvents.filter((event) => event.payload['agentId'] === 'agy'),
      ).toHaveLength(0)
      expect(await readFile(join(ctx.projectDirectory, 'parse-port.mjs'), 'utf8')).toBe(
        INITIAL_PORT_CODE,
      )
      await assertHealthyCheckpoint(ctx)

      // Plan v2 via Composer follow-up -> Codex Plan Review v2
      const v1ReadyRevision = v1Task.revision
      await sendRealMessage(
        ctx,
        [
          'Update the official plan to Revision v2 before implementation:',
          'extend parsePort(value, fallback = null) with a second optional parameter using JavaScript default value null',
          '(so both parsePort("bad") and parsePort("bad", undefined) return null, while parsePort("bad", 8443) or parsePort(null, "none") returns fallback).',
          'Keep the exact v1 validation rule: valid integers 1..65535 and /^[1-9]\\d{0,4}$/ strings <= 65535 always return the parsed integer regardless of fallback.',
          'parse-port.test.mjs is immutable acceptance evidence that intentionally tests only 1-arg calls while Pact verifies 2-arg fallback calls externally; during implementation, Codex edits only parse-port.mjs and runs only node --test parse-port.test.mjs (do not invoke node -e; code_review verifies both 1-arg and 2-arg fallback = null logic by static inspection of parse-port.mjs, labels runtime test execution Unverified, and submits accepted without needs_user when static logic matches).',
          'All choices are completely fixed; do not ask questions and do not edit workspace files yet.',
          'Write the concise (under 2,500 characters), complete updated Revision v2 official Markdown plan to <appDataDir>/brain/<sessionId>/implementation_plan.md using write_file (with Overwrite: true) or edit_file with ArtifactMetadata (Summary, UserFacing: true, RequestFeedback: true), then write a short assistant summary and end this turn.',
        ].join(' '),
        'primary',
      )

      await pollStageUntil(
        ctx,
        'case-a plan v2 or review v2',
        deadlineAt,
        [500, 1000, 2000],
        (current) => {
          if (
            current.task &&
            current.task.revision > v1ReadyRevision &&
            current.task.status === 'ready' &&
            (current.task.planReference?.version ?? 0) <= v1Plan.version
          ) {
            throw new Error(
              'Plan author settled reply without producing a new official Plan version/SHA',
            )
          }
          return (
            current.accepted &&
            current.task?.status === 'ready' &&
            (current.task.planReference?.version ?? 0) > v1Plan.version
          )
        },
        TWO_TURN_STAGE_POLL_TIMEOUT_MS,
      )

      const afterV2 = readCollaborationDbFacts(ctx)
      const v2Task = afterV2.task!
      expect(v2Task.planReference).toBeDefined()
      const v2Plan = v2Task.planReference!
      expect(v2Plan.author).toBe('agy')
      expect(v2Plan.version).toBeGreaterThan(v1Plan.version)
      expect(v2Plan.document.sha256).not.toBe(v1Plan.document.sha256)
      expect(v2Task.planInputSequence).toBeGreaterThan(v1PlanInputSequence)
      expect(v2Task.review).toMatchObject({
        actor: 'codex',
        stage: 'plan_review',
        verdict: 'accepted',
        inputSequence: v2Task.planInputSequence,
      })
      expect(v2Task.review?.planReference?.document.sha256).toBe(v2Plan.document.sha256)

      const agyReplyPlanRuns = afterV2.snapshot.runs.filter(
        (run) =>
          run.agentId === 'agy' &&
          run.collaboration?.stage === 'reply' &&
          afterV2.turnAuthByRunId.get(run.id)?.replyMode === 'plan',
      )
      expect(agyReplyPlanRuns.length).toBeGreaterThanOrEqual(1)
      expect(
        afterV2.planSettledEvents.some(
          (event) =>
            event.payload.kind === 'published' &&
            event.payload.planReference.document.sha256 === v2Plan.document.sha256,
        ),
      ).toBe(true)
      const codexPlanReviewRuns = afterV2.snapshot.runs.filter(
        (run) =>
          run.agentId === 'codex' &&
          run.collaboration?.stage === 'plan_review' &&
          run.status === 'completed',
      )
      expect(codexPlanReviewRuns.length).toBeGreaterThanOrEqual(2)
      expect(
        afterV2.permissionEvents.filter((event) => event.payload['agentId'] === 'agy'),
      ).toHaveLength(0)
      expect(await readFile(join(ctx.projectDirectory, 'parse-port.mjs'), 'utf8')).toBe(
        INITIAL_PORT_CODE,
      )
      await assertHealthyCheckpoint(ctx)

      const agyContextBeforeRestart = afterV2.snapshot.nativeContexts.find(
        (c) => c.agentId === 'agy',
      )
      const codexContextBeforeRestart = afterV2.snapshot.nativeContexts.find(
        (c) => c.agentId === 'codex',
      )
      expect(agyContextBeforeRestart?.nativeSessionId).toBeDefined()
      expect(codexContextBeforeRestart?.nativeSessionId).toBeDefined()
      const agyNativeSid = agyContextBeforeRestart!.nativeSessionId

      const v2Quiescent = await waitForSynchronizedQuiescentTrajectoryCopy(
        ctx.fixture.directory,
        ctx.fixture.geminiHome,
        agyNativeSid,
        'case-a-after-v2',
      )
      expect(v2Quiescent.trajectory.stepCount).toBeGreaterThanOrEqual(4)
      expect(v2Quiescent.trajectory.terminalPlannerStep?.status).toBe(CORTEX_STEP_STATUS_DONE)
      expect(v2Quiescent.summaryStepCount).toBe(v2Quiescent.trajectory.stepCount)

      // Cold restart before implementation
      const preRestartRunIds = afterV2.snapshot.runs.map((run) => run.id).toSorted()
      await restartRealWorkspace(ctx)

      const afterRestartFacts = readCollaborationDbFacts(ctx)
      expect(afterRestartFacts.snapshot.runs.map((run) => run.id).toSorted()).toEqual(
        preRestartRunIds,
      )
      expect(afterRestartFacts.task?.planReference).toEqual(v2Plan)
      expect(
        afterRestartFacts.snapshot.nativeContexts.find((c) => c.agentId === 'agy')?.nativeSessionId,
      ).toBe(agyNativeSid)
      expect(
        afterRestartFacts.snapshot.nativeContexts.find((c) => c.agentId === 'codex')
          ?.nativeSessionId,
      ).toBe(codexContextBeforeRestart!.nativeSessionId)
      expect(await readFile(join(ctx.projectDirectory, 'parse-port.mjs'), 'utf8')).toBe(
        INITIAL_PORT_CODE,
      )
      await assertHealthyCheckpoint(ctx)

      // Codex implements v2 -> keyless verifier checks v1 + v2 -> Agy reviews code
      await driveImplementAndCodeReviewToAcceptance(ctx, {
        implementer: 'codex',
        codeReviewer: 'agy',
        deadlineAt,
        approved,
        verifyFallback: true,
        testSha256,
      })

      const finalFacts = readCollaborationDbFacts(ctx)
      assertRunsHealthyAndNoClaude(finalFacts)
      expect(finalFacts.task?.planReference).toEqual(v2Plan)
      expect(
        finalFacts.permissionEvents.filter((event) => event.payload['agentId'] === 'agy'),
      ).toHaveLength(0)

      expect(finalFacts.snapshot.runs.some((run) => run.collaboration?.stage === 'implement')).toBe(
        true,
      )
      for (const run of finalFacts.snapshot.runs) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Inspect each run changeSet sequentially after completion.
        const ws = await readAllWorkspaceChangesForRun(ctx, run)
        if (run.collaboration?.stage === 'implement') {
          expect(run.agentId).toBe('codex')
          expect(ws.hasChangeSet).toBe(true)
          expect(ws.files.map((file) => file.path)).toEqual(['parse-port.mjs'])
          expect(ws.files[0]?.patchVersions?.length).toBeGreaterThan(0)
        } else if (
          run.collaboration?.stage === 'repair' ||
          run.collaboration?.stage === 'collaborate'
        ) {
          expect(run.agentId).toBe('codex')
          if (ws.hasChangeSet) {
            expect(ws.files.map((file) => file.path)).toEqual(['parse-port.mjs'])
            expect(ws.files[0]?.patchVersions?.length).toBeGreaterThan(0)
          }
        } else {
          expect({
            stage: run.collaboration?.stage,
            agent: run.agentId,
            hasChangeSet: ws.hasChangeSet,
            fileCount: ws.changeSet?.fileCount,
          }).toEqual({
            stage: run.collaboration?.stage,
            agent: run.agentId,
            hasChangeSet: false,
            fileCount: undefined,
          })
        }
      }

      const finalQuiescent = await waitForSynchronizedQuiescentTrajectoryCopy(
        ctx.fixture.directory,
        ctx.fixture.geminiHome,
        agyNativeSid,
        'case-a-final',
      )
      expect(finalQuiescent.trajectory.stepCount).toBeGreaterThan(v2Quiescent.trajectory.stepCount)
      expect(finalQuiescent.trajectory.terminalPlannerStep?.status).toBe(CORTEX_STEP_STATUS_DONE)
      expect(finalQuiescent.summaryStepCount).toBe(finalQuiescent.trajectory.stepCount)
      await assertHealthyCheckpoint(ctx)
    } finally {
      await safelyCloseWorkspace(ctx, 'Real Case A collaboration cleanup failed')
    }
  },
)

test(
  'opt-in real Primary codex plans and reviews code while Secondary agy reviews plan, implements under ask permissions, and cold session/load replay produces zero ghost edits',
  { tag: ['@real', '@real-extended'] },
  async ({ browserName: _browserName }, testInfo) => {
    if (!isRealAgyCollaborationAuthorized(process.env)) {
      test.skip(
        true,
        'Opt-in paid real Antigravity collaboration E2E requires PACT_E2E_REAL_AGY_COLLAB=1.',
      )
      return
    }
    test.setTimeout(REAL_CASE_B_TIMEOUT_MS)
    expect(testInfo.project.name).toBe('real')
    expect(testInfo.project.use.trace).toBe('off')
    expect(testInfo.project.use.screenshot).toBe('off')
    expect(testInfo.project.use.video).toBe('off')

    const deadlineAt = Date.now() + REAL_CASE_B_TIMEOUT_MS - POLL_DEADLINE_RESERVE_MS
    const ctx = await launchRealWorkspace('real-codex-agy-case-b', {
      activePair: ['codex', 'agy'],
      strictInitialReadiness: true,
    })
    const testSha256 = sha256Hex(IMMUTABLE_PORT_TESTS)
    const approved = new Map<string, ApprovedInteractionRecord>()

    try {
      await writeFile(join(ctx.projectDirectory, 'parse-port.mjs'), INITIAL_PORT_CODE)
      await writeFile(join(ctx.projectDirectory, 'parse-port.test.mjs'), IMMUTABLE_PORT_TESTS)
      const red = await runKeylessPortVerification(ctx.fixture.directory, ctx.projectDirectory)
      expect(red).toEqual({ passed: false, assertionFailure: true })

      await configureRealPairSettingsAndPermissions(ctx, ['codex', 'agy'])

      // Codex Plan + Agy Plan Review
      await sendRealMessage(
        ctx,
        [
          '/plan Implement parsePort(value) in only parse-port.mjs.',
          'Exact specification: return integer value if Number.isInteger(value) && value >= 1 && value <= 65535;',
          'or if typeof value === "string" && /^[1-9]\\d{0,4}$/.test(value) and Number(value) <= 65535, return Number(value);',
          'otherwise return null (reject 0, negatives, floats, leading zeros like "080", "+80", whitespace, empty strings, non-digits, non-number/non-string values).',
          'parse-port.test.mjs is immutable acceptance evidence and must never be edited.',
          'Constraint: Antigravity edits only parse-port.mjs using edit_file or write_file without running shell or terminal commands, and Pact runs node --test parse-port.test.mjs externally outside agent turns; therefore plan_review and code_review verify correctness by static source inspection of parse-port.mjs against parse-port.test.mjs and label runtime test execution Unverified rather than blocking or incomplete.',
          'All edge cases are fixed; do not ask questions, do not edit workspace files yet, and publish the complete official plan in the native <proposed_plan> block.',
        ].join(' '),
        'primary',
      )

      await pollStageUntil(
        ctx,
        'case-b codex plan or agy plan_review',
        deadlineAt,
        [500, 1000, 2000],
        (current) => current.accepted && current.task?.status === 'ready',
        TWO_TURN_STAGE_POLL_TIMEOUT_MS,
      )

      const afterPlan = readCollaborationDbFacts(ctx)
      const planTask = afterPlan.task!
      expect(planTask).toMatchObject({
        rolePolicy: 'split-stages-v1',
        owner: 'codex',
        reviewer: 'agy',
        review: { actor: 'agy', stage: 'plan_review', verdict: 'accepted' },
      })
      const agyContextAfterPlan = afterPlan.snapshot.nativeContexts.find((c) => c.agentId === 'agy')
      expect(agyContextAfterPlan?.nativeSessionId).toBeDefined()
      const agyNativeSid = agyContextAfterPlan!.nativeSessionId
      const agyBindingGen = agyContextAfterPlan!.bindingGeneration ?? 1
      expect(
        afterPlan.permissionEvents.filter((event) => event.payload['agentId'] === 'agy'),
      ).toHaveLength(0)
      expect(await readFile(join(ctx.projectDirectory, 'parse-port.mjs'), 'utf8')).toBe(
        INITIAL_PORT_CODE,
      )
      await assertHealthyCheckpoint(ctx)

      // Agy implements under ask permissions (plan -> default) -> Codex code review
      await driveImplementAndCodeReviewToAcceptance(ctx, {
        implementer: 'agy',
        codeReviewer: 'codex',
        deadlineAt,
        approved,
        verifyFallback: false,
        testSha256,
      })

      const agyApprovedRecords = [...approved.values()].filter((record) => record.agentId === 'agy')
      expect(agyApprovedRecords.length).toBeGreaterThanOrEqual(1)

      const afterReviewFacts = readCollaborationDbFacts(ctx)
      assertRunsHealthyAndNoClaude(afterReviewFacts)
      const agyImplementRuns = afterReviewFacts.snapshot.runs.filter(
        (run) => run.agentId === 'agy' && run.collaboration?.stage === 'implement',
      )
      expect(agyImplementRuns).toHaveLength(1)
      const agyImplementRun = agyImplementRuns[0]!
      const agyWriteRunIds = new Set(
        afterReviewFacts.snapshot.runs
          .filter(
            (run) =>
              run.agentId === 'agy' &&
              (run.collaboration?.stage === 'implement' ||
                run.collaboration?.stage === 'repair' ||
                run.collaboration?.stage === 'collaborate'),
          )
          .map((run) => run.id),
      )
      assertAgyPermissionAuditPairs(afterReviewFacts.permissionEvents, agyWriteRunIds, 1)

      const agyContextAfterWrite = afterReviewFacts.snapshot.nativeContexts.find(
        (c) => c.agentId === 'agy',
      )
      expect(agyContextAfterWrite?.nativeSessionId).toBe(agyNativeSid)
      expect(agyContextAfterWrite?.bindingGeneration).toBe(agyBindingGen)

      const implChanges = await readAllWorkspaceChangesForRun(ctx, agyImplementRun)
      expect(implChanges.hasChangeSet).toBe(true)
      expect(implChanges.files.map((file) => file.path)).toEqual(['parse-port.mjs'])
      const implementedCode = await readFile(join(ctx.projectDirectory, 'parse-port.mjs'), 'utf8')
      const preCollabRunCount = afterReviewFacts.snapshot.runs.length
      await assertHealthyCheckpoint(ctx)

      // Post-write cold restart -> same-binding @agy no-edit collaborate turn -> zero ghost edits!
      await restartRealWorkspace(ctx)
      await sendRealMessage(
        ctx,
        'In one short sentence, state what parsePort(0) returns according to parse-port.mjs. Do not edit or create any files, do not call write_file, edit_file, or publish_plan, and do not invoke shell commands.',
        'agy',
      )

      await expect
        .poll(
          async () => {
            const snapshot = await readRealConversation(ctx)
            const failedRun = snapshot.runs.find((run) => run.status === 'failed')
            if (failedRun) {
              throw await readWorkflowFailure(ctx, 'case-b post-write collaborate turn')
            }
            if (snapshot.runs.length <= preCollabRunCount) return false
            const latest = snapshot.runs.at(-1)!
            return (
              latest.agentId === 'agy' &&
              latest.status === 'completed' &&
              latest.nativeOutcome === 'completed' &&
              latest.dispatchPhase === 'ended' &&
              latest.nativeEffectsState === 'settled'
            )
          },
          { timeout: Math.max(1, deadlineAt - Date.now()), intervals: [500, 1000, 2000] },
        )
        .toBe(true)

      const afterCollabFacts = readCollaborationDbFacts(ctx)
      assertRunsHealthyAndNoClaude(afterCollabFacts)
      expect(afterCollabFacts.snapshot.runs).toHaveLength(preCollabRunCount + 1)
      const collabRun = afterCollabFacts.snapshot.runs.at(-1)!
      expect(collabRun.agentId).toBe('agy')
      expect(collabRun.collaboration?.stage).toBe('collaborate')
      expect(collabRun.nativeSessionId).toBe(agyNativeSid)
      expect(collabRun.bindingGeneration).toBe(agyBindingGen)
      expect(collabRun.workspaceChanges).toBeUndefined()
      expect(
        afterCollabFacts.permissionEvents.filter((event) => event.runId === collabRun.id),
      ).toHaveLength(0)

      // Crucial regression check: zero ghost edits on replay turn, while earlier implement record persists!
      const collabChanges = await readAllWorkspaceChangesForRun(ctx, collabRun)
      expect(collabChanges.hasChangeSet).toBe(false)
      const retainedImplChanges = await readAllWorkspaceChangesForRun(ctx, agyImplementRun)
      expect(retainedImplChanges.hasChangeSet).toBe(true)
      expect(retainedImplChanges.files.map((file) => file.path)).toEqual(['parse-port.mjs'])
      expect(await readFile(join(ctx.projectDirectory, 'parse-port.mjs'), 'utf8')).toBe(
        implementedCode,
      )
      expect(
        sha256Hex(await readFile(join(ctx.projectDirectory, 'parse-port.test.mjs'), 'utf8')),
      ).toBe(testSha256)
      await assertHealthyCheckpoint(ctx)

      const beforeInspectQuiescent = await waitForSynchronizedQuiescentTrajectoryCopy(
        ctx.fixture.directory,
        ctx.fixture.geminiHome,
        agyNativeSid,
        'case-b-before-inspect',
      )
      expect(beforeInspectQuiescent.trajectory.stepCount).toBeGreaterThanOrEqual(4)
      expect(beforeInspectQuiescent.trajectory.terminalPlannerStep?.status).toBe(
        CORTEX_STEP_STATUS_DONE,
      )
      expect(beforeInspectQuiescent.summaryStepCount).toBe(
        beforeInspectQuiescent.trajectory.stepCount,
      )

      // Cold restart -> Check session (intent: 'inspect') adds zero user steps or runs
      await restartRealWorkspace(ctx)
      const beforeInspectRunIds = (await readRealConversation(ctx)).runs.map((run) => run.id)
      const inspectResult = await ctx.page.evaluate(
        async ({ runId, sessionId }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.retryConversationRun(runId, {
            sessionId,
            agentId: 'agy',
            intent: 'inspect',
          })
        },
        { runId: collabRun.id, sessionId: ctx.sessionId },
      )
      expect(inspectResult.ok).toBe(true)

      await expect
        .poll(
          async () => {
            const snap = await readRealConversation(ctx)
            const agyCtx = snap.nativeContexts.find((c) => c.agentId === 'agy')
            return agyCtx?.continuationState !== 'checking'
          },
          { timeout: 30_000, intervals: [250, 500, 1000] },
        )
        .toBe(true)

      const afterInspectFacts = readCollaborationDbFacts(ctx)
      assertRunsHealthyAndNoClaude(afterInspectFacts)
      expect(afterInspectFacts.snapshot.runs.map((run) => run.id)).toEqual(beforeInspectRunIds)
      const agyContextAfterInspect = afterInspectFacts.snapshot.nativeContexts.find(
        (c) => c.agentId === 'agy',
      )
      expect(agyContextAfterInspect?.nativeSessionId).toBe(agyNativeSid)
      expect(agyContextAfterInspect?.bindingGeneration).toBe(agyBindingGen)

      const afterInspectQuiescent = await waitForSynchronizedQuiescentTrajectoryCopy(
        ctx.fixture.directory,
        ctx.fixture.geminiHome,
        agyNativeSid,
        'case-b-after-inspect',
      )
      expect(afterInspectQuiescent.trajectory.userSteps.length).toBe(
        beforeInspectQuiescent.trajectory.userSteps.length,
      )
      expect(afterInspectQuiescent.trajectory.stepCount).toBe(
        beforeInspectQuiescent.trajectory.stepCount,
      )
      expect(afterInspectQuiescent.trajectory.terminalPlannerStep?.status).toBe(
        CORTEX_STEP_STATUS_DONE,
      )
      expect(afterInspectQuiescent.summaryStepCount).toBe(
        afterInspectQuiescent.trajectory.stepCount,
      )
      await assertHealthyCheckpoint(ctx)
    } finally {
      await safelyCloseWorkspace(ctx, 'Real Case B collaboration cleanup failed')
    }
  },
)
