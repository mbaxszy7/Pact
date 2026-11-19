import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type {
  DefaultSessionSettings,
  DesktopBridge,
  RuntimeAgentId,
} from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { quitPact } from './native-quit.js'
import { ReadonlyFixtureDatabase } from './readonly-fixture-database.js'
import {
  copyIsolatedAgyAuthConfig,
  createRuntimeFixture,
  isUnsafeWindowsCmdPath,
  requireExplicitAgyAuthDir,
  test,
  verifyAgyMinimumVersion,
  type RuntimeFixture,
} from './runtime-fixture.js'
import { writeWindowsNodeLauncher } from './windows-cli-launcher.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
const persistencePackageJsonPath = resolve(
  import.meta.dirname,
  '../../packages/persistence/package.json',
)
const requireFromPersistence = createRequire(persistencePackageJsonPath)

interface ReadonlySqliteStatement {
  get(...parameters: unknown[]): unknown
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

type AgyReadinessMode =
  | 'ready'
  | 'unsupported_version'
  | 'authentication_required'
  | 'startup_failed'
type AgyPromptScenario =
  | 'complete'
  | 'slow_turn'
  | 'permission_and_elicitation'
  | 'file_change_undo'

interface AgyControlConfig {
  readonly readiness: AgyReadinessMode
  readonly scenario: AgyPromptScenario
  readonly holdTurn?: boolean
  readonly holdUsage?: boolean
  readonly usageHoldMs?: number
  readonly sharedUsageLogPath?: string
  readonly editFileName?: string
  readonly editNextContent?: string
  readonly customAnswer?: string
}

interface AgyFixtureHandle {
  readonly executablePath: string
  readonly appDataDir: string
  readonly controlPath: string
  readonly factsPath: string
  updateControl(patch: Partial<AgyControlConfig>): Promise<void>
  readFacts(): Promise<{
    promptTurns: number
    sessionNewCount: number
    sessionLoadCount: number
    peakUsageConcurrent: number
    usageCalls: number
    permissionChoices: string[]
    elicitationAnswers: Array<Record<string, unknown>>
    fixtureError?: string
  }>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaultThreeAgentSettings(
  primaryAgentId: RuntimeAgentId = 'claude',
  secondaryAgentId: RuntimeAgentId = 'codex',
): DefaultSessionSettings {
  return {
    primaryAgentId,
    secondaryAgentId,
    agents: {
      claude: { model: null, effort: null, speed: 'native' },
      codex: { model: null, effort: null, speed: 'native' },
      agy: { model: null, effort: null, speed: 'native' },
    },
    maxDiscussionRounds: 6,
    maxReviewCycles: 3,
    maxRepairAttempts: 3,
  }
}

async function writeAgyCliFixture(
  fixture: RuntimeFixture,
  name: string,
  initialControl: AgyControlConfig,
): Promise<AgyFixtureHandle> {
  const controlPath = join(fixture.directory, `${name}-control.json`)
  const factsPath = join(fixture.directory, `${name}-facts.json`)
  const scriptPath = join(fixture.directory, `${name}-script.mjs`)
  const appDataDir = join(fixture.directory, 'home', '.gemini', 'antigravity-cli')

  await mkdir(join(appDataDir, 'conversations'), { recursive: true, mode: 0o700 })
  await mkdir(join(appDataDir, 'brain'), { recursive: true, mode: 0o700 })
  await writeFile(controlPath, JSON.stringify(initialControl), { mode: 0o600 })
  await writeFile(
    factsPath,
    JSON.stringify({
      promptTurns: 0,
      sessionNewCount: 0,
      sessionLoadCount: 0,
      activeUsageConcurrent: 0,
      peakUsageConcurrent: 0,
      usageCalls: 0,
      permissionChoices: [],
      elicitationAnswers: [],
    }),
    { mode: 0o600 },
  )

  const scriptSource = `import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const requirePersistence = createRequire(${JSON.stringify(persistencePackageJsonPath)})
const Database = requirePersistence('better-sqlite3')
const controlPath = ${JSON.stringify(controlPath)}
const factsPath = ${JSON.stringify(factsPath)}

function readControl() {
  return JSON.parse(readFileSync(controlPath, 'utf8'))
}

function mutateFacts(mutator) {
  const current = existsSync(factsPath)
    ? JSON.parse(readFileSync(factsPath, 'utf8'))
    : {
        promptTurns: 0,
        sessionNewCount: 0,
        sessionLoadCount: 0,
        activeUsageConcurrent: 0,
        peakUsageConcurrent: 0,
        usageCalls: 0,
        permissionChoices: [],
        elicitationAnswers: [],
      }
  mutator(current)
  const tmp = factsPath + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(current), { mode: 0o600 })
  renameSync(tmp, factsPath)
  return current
}

process.once('uncaughtException', (error) => {
  try {
    mutateFacts((f) => {
      f.fixtureError = String(error?.message ?? error).slice(0, 512)
    })
  } catch {}
  process.stderr.write(String(error?.message ?? error) + '\\n')
  process.exit(1)
})

function writeVarint(value) {
  let v = BigInt(value)
  const out = []
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
  return Buffer.from(out)
}

function pbVarint(fieldNumber, value) {
  return Buffer.concat([writeVarint((BigInt(fieldNumber) << 3n) | 0n), writeVarint(value)])
}

function pbBytes(fieldNumber, buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')
  return Buffer.concat([
    writeVarint((BigInt(fieldNumber) << 3n) | 2n),
    writeVarint(bytes.length),
    bytes,
  ])
}

function readVarintAt(buf, offset) {
  let result = 0n
  let shift = 0n
  let pos = offset
  while (pos < buf.length) {
    const b = buf[pos]
    pos += 1
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value: result, next: pos }
    shift += 7n
  }
  throw new Error('Truncated varint')
}

function decodeFields(buf) {
  const out = []
  let offset = 0
  while (offset < buf.length) {
    const tag = readVarintAt(buf, offset)
    offset = tag.next
    const fieldNumber = Number(tag.value >> 3n)
    const wireType = Number(tag.value & 7n)
    if (wireType === 0) {
      const v = readVarintAt(buf, offset)
      offset = v.next
      out.push({ fieldNumber, wireType, varint: v.value })
    } else if (wireType === 1) {
      out.push({ fieldNumber, wireType, bytes: buf.subarray(offset, offset + 8) })
      offset += 8
    } else if (wireType === 2) {
      const len = readVarintAt(buf, offset)
      const n = Number(len.value)
      offset = len.next
      out.push({ fieldNumber, wireType, bytes: buf.subarray(offset, offset + n) })
      offset += n
    } else if (wireType === 5) {
      out.push({ fieldNumber, wireType, bytes: buf.subarray(offset, offset + 4) })
      offset += 4
    } else {
      throw new Error('Unsupported wire type: ' + wireType)
    }
  }
  return out
}

function resolveAppDataDir() {
  const customGemini = process.env.ANTIGRAVITY_GEMINI_DIR
  const geminiRoot = customGemini || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.gemini')
  const root = join(geminiRoot, 'antigravity-cli')
  mkdirSync(join(root, 'conversations'), { recursive: true, mode: 0o700 })
  mkdirSync(join(root, 'brain'), { recursive: true, mode: 0o700 })
  return root
}

function ensureSummariesTable(appDataDir) {
  const db = new Database(join(appDataDir, 'conversation_summaries.db'))
  db.pragma('journal_mode = WAL')
  db.exec(\`
    CREATE TABLE IF NOT EXISTS "conversation_summaries" (
      "conversation_id" TEXT PRIMARY KEY,
      "title" TEXT,
      "step_count" INTEGER NOT NULL DEFAULT 0,
      "last_user_input_step_index" INTEGER NOT NULL DEFAULT 0,
      "raw_summary" BLOB,
      "parent_conversation_id" TEXT
    );
  \`)
  return db
}

function createZeroTurnDb(appDataDir, sessionId) {
  const trajectoryId = randomUUID()
  const dbPath = join(appDataDir, 'conversations', sessionId + '.db')
  const db = new Database(dbPath)
  try {
    db.pragma('page_size = 32768')
    db.pragma('journal_mode = WAL')
    db.exec(\`
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
        "error_details" BLOB,
        "permissions" BLOB,
        "task_details" BLOB,
        "render_info" BLOB,
        "step_payload" BLOB,
        "step_format" INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE "gen_metadata" (
        "idx" INTEGER PRIMARY KEY,
        "data" BLOB NOT NULL,
        "size" INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE "executor_metadata" (
        "idx" INTEGER PRIMARY KEY,
        "data" BLOB NOT NULL,
        "size" INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE "trajectory_metadata_blob" (
        "id" INTEGER PRIMARY KEY,
        "data" BLOB
      );
    \`)
    db.prepare(
      'INSERT INTO "trajectory_meta" ("trajectory_id", "cascade_id", "step_format") VALUES (?, ?, 0)',
    ).run(trajectoryId, sessionId)
    const metaBlob = pbBytes(6, sessionId)
    db.prepare('INSERT INTO "trajectory_metadata_blob" ("id", "data") VALUES (1, ?)').run(metaBlob)
  } finally {
    db.close()
  }

  const rawSummary = Buffer.concat([
    pbBytes(4, trajectoryId),
    pbBytes(15, Buffer.alloc(0)),
    pbBytes(17, Buffer.concat([pbBytes(6, sessionId), pbBytes(90, Buffer.alloc(560, 0x2a))])),
    pbVarint(22, 1),
  ])
  const sumDb = ensureSummariesTable(appDataDir)
  try {
    sumDb
      .prepare(
        'INSERT OR REPLACE INTO "conversation_summaries" ("conversation_id", "title", "step_count", "last_user_input_step_index", "raw_summary", "parent_conversation_id") VALUES (?, ?, 0, 0, ?, ?)',
      )
      .run(sessionId, '', rawSummary, '')
  } finally {
    sumDb.close()
  }
  return trajectoryId
}

function appendTurnToDb(appDataDir, sessionId, userText, assistantText) {
  const dbPath = join(appDataDir, 'conversations', sessionId + '.db')
  const executionId = 'agy-exec-' + randomUUID()
  let stepCountAfter = 0
  let userStepIdx = 0
  const db = new Database(dbPath)
  try {
    const metaRow = db.prepare('SELECT trajectory_id FROM "trajectory_meta" LIMIT 1').get()
    const trajectoryId = metaRow.trajectory_id
    const nextStep = db.prepare('SELECT COALESCE(MAX(idx) + 1, 0) AS n FROM "steps"').get().n
    const nextGen = db.prepare('SELECT COALESCE(MAX(idx) + 1, 0) AS n FROM "gen_metadata"').get().n
    const nextExec = db.prepare('SELECT COALESCE(MAX(idx) + 1, 0) AS n FROM "executor_metadata"').get().n

    userStepIdx = nextStep
    const assistantStepIdx = nextStep + 1
    stepCountAfter = assistantStepIdx + 1

    const makeMeta = (stepIdx, source) => {
      const stepInfo = Buffer.concat([
        pbBytes(1, trajectoryId),
        ...(stepIdx > 0 ? [pbVarint(2, stepIdx)] : []),
        pbBytes(4, sessionId),
      ])
      return Buffer.concat([
        pbBytes(1, pbVarint(1, 1710000000 + stepIdx)),
        pbVarint(3, source),
        pbBytes(12, executionId),
        pbBytes(20, stepInfo),
        pbBytes(35, randomUUID()),
      ])
    }

    const uMeta = makeMeta(userStepIdx, 1)
    const uInput = Buffer.concat([
      pbBytes(2, userText),
      pbBytes(3, pbBytes(1, userText)),
    ])
    const uPayload = Buffer.concat([
      pbVarint(1, 14),
      pbVarint(4, 3),
      pbBytes(5, uMeta),
      pbBytes(19, uInput),
    ])

    const aMeta = makeMeta(assistantStepIdx, 2)
    const aPlanner = pbBytes(1, assistantText)
    const aPayload = Buffer.concat([
      pbVarint(1, 15),
      pbVarint(4, 3),
      pbBytes(5, aMeta),
      pbBytes(20, aPlanner),
    ])

    const insertStep = db.prepare(
      'INSERT INTO "steps" ("idx", "step_type", "status", "has_subtrajectory", "metadata", "step_payload", "step_format") VALUES (?, ?, 3, 0, ?, ?, 0)',
    )
    insertStep.run(userStepIdx, 14, uMeta, uPayload)
    insertStep.run(assistantStepIdx, 15, aMeta, aPayload)

    const genInner = Buffer.concat([
      pbBytes(20, Buffer.concat([pbBytes(1, 'trajectory_id'), pbBytes(2, trajectoryId)])),
      pbBytes(20, Buffer.concat([pbBytes(1, 'cascade_id'), pbBytes(2, sessionId)])),
      pbBytes(20, Buffer.concat([pbBytes(1, 'root_cascade_id'), pbBytes(2, sessionId)])),
    ])
    const genBlob = Buffer.concat([
      pbBytes(1, genInner),
      pbVarint(2, assistantStepIdx),
      pbBytes(4, executionId),
    ])
    db.prepare('INSERT INTO "gen_metadata" ("idx", "data", "size") VALUES (?, ?, ?)').run(
      nextGen,
      genBlob,
      genBlob.length,
    )

    const execBlob = Buffer.concat([
      pbVarint(1, 4),
      pbVarint(2, 1),
      pbVarint(3, assistantStepIdx),
      pbBytes(9, executionId),
    ])
    db.prepare('INSERT INTO "executor_metadata" ("idx", "data", "size") VALUES (?, ?, ?)').run(
      nextExec,
      execBlob,
      execBlob.length,
    )
  } finally {
    db.close()
  }

  const sumDb = ensureSummariesTable(appDataDir)
  try {
    sumDb
      .prepare(
        'UPDATE "conversation_summaries" SET "step_count" = ?, "last_user_input_step_index" = ?, "title" = ? WHERE "conversation_id" = ?',
      )
      .run(stepCountAfter, userStepIdx, 'Turn-' + stepCountAfter, sessionId)
  } finally {
    sumDb.close()
  }
}

function replayStoredSteps(appDataDir, sessionId, send) {
  const dbPath = join(appDataDir, 'conversations', sessionId + '.db')
  if (!existsSync(dbPath)) return
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db
      .prepare('SELECT idx, step_type, step_payload FROM "steps" ORDER BY idx ASC')
      .all()
    for (const row of rows) {
      if (!Buffer.isBuffer(row.step_payload)) continue
      const stepFields = decodeFields(row.step_payload)
      if (row.step_type === 14) {
        const userField = stepFields.find((f) => f.fieldNumber === 19)
        const textField = userField ? decodeFields(userField.bytes).find((f) => f.fieldNumber === 2) : undefined
        const text = textField ? textField.bytes.toString('utf8') : ''
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              messageId: 'replay-user-' + row.idx,
              content: { type: 'text', text },
            },
          },
        })
      } else if (row.step_type === 15) {
        const plannerField = stepFields.find((f) => f.fieldNumber === 20)
        const respField = plannerField ? decodeFields(plannerField.bytes).find((f) => f.fieldNumber === 1) : undefined
        const text = respField ? respField.bytes.toString('utf8') : ''
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'replay-agent-' + row.idx,
              content: { type: 'text', text },
            },
          },
        })
      }
    }
  } finally {
    db.close()
  }
}

const args = process.argv.slice(2)
const initial = readControl()

if (args[0] === '--version') {
  if (initial.readiness === 'startup_failed') process.exit(2)
  const ver = initial.readiness === 'unsupported_version' ? '1.5.8' : '1.5.9'
  process.stdout.write('agy version ' + ver + '\\n')
  process.exit(0)
}

if (args[0] === '-p' && args[1] === '/usage') {
  const sharedLog = typeof initial.sharedUsageLogPath === 'string' ? initial.sharedUsageLogPath : ''
  let loggedEnd = false
  const logShared = (event) => {
    if (!sharedLog) return
    appendFileSync(
      sharedLog,
      JSON.stringify({ provider: 'agy', event, pid: process.pid, at: Date.now() }) + '\\n',
    )
  }
  const logEndOnce = () => {
    if (loggedEnd) return
    loggedEnd = true
    logShared('end')
  }
  logShared('start')
  process.on('exit', logEndOnce)
  try {
    mutateFacts((f) => {
      f.usageCalls += 1
      f.activeUsageConcurrent += 1
      if (f.activeUsageConcurrent > f.peakUsageConcurrent) {
        f.peakUsageConcurrent = f.activeUsageConcurrent
      }
    })
    if (typeof initial.usageHoldMs === 'number' && initial.usageHoldMs > 0) {
      await new Promise((r) => setTimeout(r, initial.usageHoldMs))
    }
    while (readControl().holdUsage) {
      await new Promise((r) => setTimeout(r, 40))
    }
  } finally {
    mutateFacts((f) => {
      f.activeUsageConcurrent = Math.max(0, f.activeUsageConcurrent - 1)
    })
  }
  if (initial.readiness === 'authentication_required') {
    process.stderr.write('Authentication required. Run agy to sign in.\\n')
    logEndOnce()
    process.exit(1)
  }
  const nowSec = Math.floor(Date.now() / 1000)
  process.stdout.write(
    JSON.stringify({
      account: {
        email: 'private-agy-owner@example.com',
        userId: 'agy-user-991',
        authMethod: 'google-login',
        tier: 'pro',
      },
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            {
              id: 'gemini-5h',
              name: '5-hour window',
              remaining_fraction: 0.72,
              reset_time: new Date((nowSec + 7200) * 1000).toISOString(),
            },
            {
              id: 'gemini-weekly',
              name: 'Weekly window',
              remaining_fraction: 0.85,
              reset_time: new Date((nowSec + 172800) * 1000).toISOString(),
            },
          ],
        },
        {
          name: 'Claude & GPT-OSS',
          buckets: [
            {
              id: 'partner-weekly',
              name: 'Partner weekly',
              remaining_fraction: 0.6,
              reset_time: new Date((nowSec + 172800) * 1000).toISOString(),
            },
          ],
        },
      ],
    }) + '\\n',
  )
  process.exit(0)
}

if (args[0] === '-p' && args[1] === '/skills') {
  process.stdout.write(JSON.stringify({ skills: [] }) + '\\n')
  process.exit(0)
}

if (args[0] === 'acp') {
  const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
  const rl = createInterface({ input: process.stdin })
  const pendingClientWaiters = new Map()
  let currentMode = 'default'
  let currentModel = 'gemini-4-carbon'
  let currentEffort = 'high'

  const sessionNewPayload = (sessionId) => ({
    sessionId,
    modes: {
      currentModeId: currentMode,
      availableModes: ['default', 'accept-edits', 'auto', 'plan'],
    },
    models: {
      currentModelId: currentModel + '-' + currentEffort,
      availableModels: [
        { modelId: 'gemini-4-carbon-low', name: 'Gemini 4 Carbon (Low)' },
        { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
        { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
        { modelId: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      ],
    },
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: currentModel,
        options: [
          { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
          { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        ],
      },
      ...(currentModel === 'gemini-4-carbon'
        ? [
            {
              id: 'thought_level',
              name: 'Thought Level',
              type: 'select',
              currentValue: currentEffort,
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
              ],
            },
          ]
        : []),
    ],
  })

  const callClient = (method, params) => {
    const id = 'srv-' + randomUUID()
    return new Promise((resolveReply) => {
      pendingClientWaiters.set(id, resolveReply)
      send({ jsonrpc: '2.0', id, method, params })
    })
  }

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const frame = JSON.parse(trimmed)
    if (!frame.method && frame.id !== undefined) {
      const waiter = pendingClientWaiters.get(frame.id)
      if (waiter) {
        pendingClientWaiters.delete(frame.id)
        waiter(frame)
      }
      return
    }
    void (async () => {
      const ctrl = readControl()
      if (frame.method === 'initialize') {
        if (ctrl.readiness === 'authentication_required') {
          send({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32000, message: 'Authentication required. Please sign in.' },
          })
          return
        }
        send({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'antigravity-cli', version: '1.5.11' },
            capabilities: { loadSession: true },
          },
        })
        return
      }
      if (frame.method === 'session/new') {
        const sid = randomUUID()
        createZeroTurnDb(resolveAppDataDir(), sid)
        mutateFacts((f) => {
          f.sessionNewCount += 1
        })
        send({ jsonrpc: '2.0', id: frame.id, result: sessionNewPayload(sid) })
        return
      }
      if (frame.method === 'session/load') {
        const sid = frame.params.sessionId
        mutateFacts((f) => {
          f.sessionLoadCount += 1
        })
        replayStoredSteps(resolveAppDataDir(), sid, send)
        send({ jsonrpc: '2.0', id: frame.id, result: sessionNewPayload(sid) })
        return
      }
      if (frame.method === 'session/set_mode') {
        currentMode = frame.params.modeId || currentMode
        send({ jsonrpc: '2.0', id: frame.id, result: { currentModeId: currentMode } })
        return
      }
      if (frame.method === 'session/set_config_option') {
        if (frame.params.configId === 'model') {
          if (!['gemini-4-carbon', 'gemini-3.8-flash'].includes(frame.params.value)) {
            send({
              jsonrpc: '2.0',
              id: frame.id,
              error: { code: -32602, message: 'Unsupported selectable model option.' },
            })
            return
          }
          currentModel = frame.params.value
        } else if (frame.params.configId === 'thought_level') {
          currentEffort = frame.params.value
        }
        send({
          jsonrpc: '2.0',
          id: frame.id,
          result: { configOptions: sessionNewPayload(frame.params.sessionId).configOptions },
        })
        return
      }
      if (frame.method === 'session/set_model') {
        currentModel = frame.params.modelId
        send({
          jsonrpc: '2.0',
          id: frame.id,
          result: { configOptions: sessionNewPayload(frame.params.sessionId).configOptions },
        })
        return
      }
      if (frame.method === 'session/close') {
        send({ jsonrpc: '2.0', id: frame.id, result: {} })
        return
      }
      if (frame.method === 'session/prompt') {
        const sid = frame.params.sessionId
        const blocks = Array.isArray(frame.params.prompt) ? frame.params.prompt : []
        const userText = blocks
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\\n')

        const turnFacts = mutateFacts((f) => {
          f.promptTurns += 1
        })
        const turnNo = turnFacts.promptTurns
        const activeCtrl = readControl()

        if (activeCtrl.scenario === 'slow_turn') {
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: 'msg-slow-' + turnNo,
                content: { type: 'text', text: 'Antigravity working on turn... ' },
              },
            },
          })
          while (readControl().holdTurn) {
            await new Promise((r) => setTimeout(r, 40))
          }
          const finalAnswer = 'Antigravity working on turn... Completed cleanly.'
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: 'msg-slow-' + turnNo,
                content: { type: 'text', text: 'Completed cleanly.' },
              },
            },
          })
          appendTurnToDb(resolveAppDataDir(), sid, userText, finalAnswer)
          send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
          return
        }

        if (activeCtrl.scenario === 'permission_and_elicitation') {
          const permReply = await callClient('session/request_permission', {
            sessionId: sid,
            toolCall: {
              toolCallId: 'tc-perm-1',
              name: 'run_command',
              title: 'Inspect repository status',
              args: { CommandLine: 'git status --short' },
            },
            options: [
              { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'deny', name: 'Decline', kind: 'reject_once' },
            ],
          })
          const chosenOption = permReply?.result?.outcome?.optionId ?? 'none'
          mutateFacts((f) => {
            f.permissionChoices.push(chosenOption)
          })

          const elicitReply = await callClient('elicitation/create', {
            sessionId: sid,
            mode: 'form',
            message: 'Select the verification module scope',
            requestedSchema: {
              type: 'object',
              required: ['module_scope'],
              properties: {
                module_scope: {
                  type: 'string',
                  title: 'Module scope',
                  description: 'Target module to verify',
                  default: 'storage-engine',
                },
              },
            },
          })
          const content = elicitReply?.result?.content ?? {}
          mutateFacts((f) => {
            f.elicitationAnswers.push(content)
          })

          const answer =
            activeCtrl.customAnswer ??
            'CODE_ALPHA_42 verified for ' + String(content.module_scope ?? 'default') + '.'
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: 'msg-pe-' + turnNo,
                content: { type: 'text', text: answer },
              },
            },
          })
          appendTurnToDb(resolveAppDataDir(), sid, userText, answer)
          send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
          return
        }

        if (activeCtrl.scenario === 'file_change_undo') {
          const targetName = activeCtrl.editFileName ?? 'agy-target.ts'
          const targetPath = join(process.cwd(), targetName)
          const oldText = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : ''
          const newText =
            activeCtrl.editNextContent ?? 'export const agyState = "modified-by-agy"\\n'
          writeFileSync(targetPath, newText, 'utf8')

          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-edit-' + turnNo,
                name: 'edit_file',
                title: 'Edit ' + targetName,
                status: 'completed',
                args: { Path: targetPath, Target: oldText, Replacement: newText },
                content: [{ type: 'diff', path: targetPath, oldText, newText }],
              },
            },
          })

          const answer = activeCtrl.customAnswer ?? 'CODE_BETA_99 updated ' + targetName + '.'
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                messageId: 'msg-undo-' + turnNo,
                content: { type: 'text', text: answer },
              },
            },
          })
          appendTurnToDb(resolveAppDataDir(), sid, userText, answer)
          send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
          return
        }

        const answer =
          activeCtrl.customAnswer ?? 'Antigravity fixture response #' + turnNo + '.'
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'msg-std-' + turnNo,
              content: { type: 'text', text: answer },
            },
          },
        })
        appendTurnToDb(resolveAppDataDir(), sid, userText, answer)
        send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } })
      }
    })()
  })
}
`

  await writeFile(scriptPath, scriptSource, { mode: 0o600 })

  let executablePath: string
  if (process.platform === 'win32') {
    executablePath = await writeWindowsNodeLauncher(fixture.directory, name, [scriptPath])
  } else {
    executablePath = join(fixture.directory, name)
    const quotedExec = process.execPath.replace(/'/gu, "'\\''")
    const quotedScript = scriptPath.replace(/'/gu, "'\\''")
    await writeFile(executablePath, `#!/bin/sh\nexec '${quotedExec}' '${quotedScript}' "$@"\n`, {
      mode: 0o755,
    })
    await chmod(executablePath, 0o755)
  }

  return {
    executablePath,
    appDataDir,
    controlPath,
    factsPath,
    async updateControl(patch) {
      const currentRaw: unknown = JSON.parse(await readFile(controlPath, 'utf8'))
      const current = isPlainRecord(currentRaw) ? currentRaw : {}
      const next = { ...current, ...patch }
      const tmp = `${controlPath}.next`
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600 })
      const { rename } = await import('node:fs/promises')
      await rename(tmp, controlPath)
    },
    async readFacts() {
      const parsed: unknown = JSON.parse(await readFile(factsPath, 'utf8'))
      if (!isPlainRecord(parsed)) throw new Error('Malformed Antigravity fixture facts.')
      return {
        promptTurns: Number(parsed['promptTurns'] ?? 0),
        sessionNewCount: Number(parsed['sessionNewCount'] ?? 0),
        sessionLoadCount: Number(parsed['sessionLoadCount'] ?? 0),
        peakUsageConcurrent: Number(parsed['peakUsageConcurrent'] ?? 0),
        usageCalls: Number(parsed['usageCalls'] ?? 0),
        permissionChoices: Array.isArray(parsed['permissionChoices'])
          ? parsed['permissionChoices'].map(String)
          : [],
        elicitationAnswers: Array.isArray(parsed['elicitationAnswers'])
          ? parsed['elicitationAnswers'].filter(isPlainRecord)
          : [],
        ...(typeof parsed['fixtureError'] === 'string'
          ? { fixtureError: parsed['fixtureError'] }
          : {}),
      }
    },
  }
}

async function writeSharedUsagePeerClis(
  directory: string,
  sharedUsageLogPath: string,
  holdMs = 250,
  postReplyExitDelayMs = 120,
): Promise<{ codexPath: string; claudePath: string }> {
  const codexScriptPath = join(directory, 'codex-shared-usage-script.mjs')
  const claudeScriptPath = join(directory, 'claude-shared-usage-script.mjs')

  await writeFile(
    codexScriptPath,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const sharedLog = ${JSON.stringify(sharedUsageLogPath)}
const holdMs = ${JSON.stringify(holdMs)}
const postReplyExitDelayMs = ${JSON.stringify(postReplyExitDelayMs)}
const logShared = (event) =>
  appendFileSync(
    sharedLog,
    JSON.stringify({ provider: 'codex', event, pid: process.pid, at: Date.now() }) + '\\n',
  )

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('codex-cli 0.159.2')
  process.exit(0)
}
if (args[0] === 'login' && args[1] === 'status') process.exit(0)
if (args[0] === 'features' && args[1] === 'list') {
  console.log('shell_tool stable true')
  process.exit(0)
}
if (args[0] !== 'app-server') process.exit(2)

let loggedEnd = false
let exiting = false
const logEndOnce = () => {
  if (loggedEnd) return
  loggedEnd = true
  logShared('end')
}
logShared('start')
process.on('exit', logEndOnce)
process.on('SIGTERM', () => {
  if (exiting) return
  exiting = true
  setTimeout(() => {
    logEndOnce()
    process.exit(0)
  }, postReplyExitDelayMs)
})

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  const req = JSON.parse(line)
  if (req.method === 'initialize') {
    send({ id: req.id, result: {} })
  } else if (req.method === 'account/read') {
    send({
      id: req.id,
      result: {
        account: { type: 'chatgpt', email: 'codex-e2e@example.invalid' },
        userId: 'e2e-codex-user',
        requiresOpenaiAuth: false,
      },
    })
  } else if (req.method === 'account/rateLimits/read') {
    await new Promise((r) => setTimeout(r, holdMs))
    const futureFiveHour = Math.floor(Date.now() / 1000) + 90 * 60
    send({
      id: req.id,
      result: {
        rateLimitsByLimitId: {
          codex: {
            primary: { windowDurationMins: 300, usedPercent: 40, resetsAt: futureFiveHour },
          },
        },
      },
    })
  } else if (req.method === 'model/list') {
    send({ id: req.id, result: { data: [] } })
  }
}
if (!exiting) {
  exiting = true
  await new Promise((r) => setTimeout(r, postReplyExitDelayMs))
  logEndOnce()
  process.exit(0)
}
`,
    { mode: 0o755 },
  )

  await writeFile(
    claudeScriptPath,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const sharedLog = ${JSON.stringify(sharedUsageLogPath)}
const holdMs = ${JSON.stringify(holdMs)}
const postReplyExitDelayMs = ${JSON.stringify(postReplyExitDelayMs)}
const logShared = (event) =>
  appendFileSync(
    sharedLog,
    JSON.stringify({ provider: 'claude', event, pid: process.pid, at: Date.now() }) + '\\n',
  )

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('2.1.272 (Claude Code)')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') process.exit(0)

let loggedEnd = false
let exiting = false
const logEndOnce = () => {
  if (loggedEnd) return
  loggedEnd = true
  logShared('end')
}
logShared('start')
process.on('exit', logEndOnce)
process.on('SIGTERM', () => {
  if (exiting) return
  exiting = true
  setTimeout(() => {
    logEndOnce()
    process.exit(0)
  }, postReplyExitDelayMs)
})

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  const msg = JSON.parse(line)
  if (msg.type !== 'control_request') continue
  if (msg.request.subtype === 'initialize') {
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: {
          commands: [],
          agents: [],
          output_style: 'default',
          available_output_styles: ['default'],
          models: [],
          account: {
            email: 'claude-e2e@example.invalid',
            organization: 'Secret E2E Org',
            apiProvider: 'firstParty',
            subscriptionType: 'max',
          },
          hooks_applied: true,
          current_permission_mode: 'dontAsk',
        },
      },
    })
  } else if (msg.request.subtype === 'get_usage') {
    await new Promise((r) => setTimeout(r, holdMs))
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: {
          subscription_type: 'max',
          rate_limits_available: true,
          rate_limits: {
            five_hour: {
              utilization: 30,
              resets_at: new Date(Date.now() + 45 * 60_000).toISOString(),
            },
            seven_day: {
              utilization: 20,
              resets_at: new Date(Date.now() + 72 * 3600_000).toISOString(),
            },
          },
        },
      },
    })
  }
}
if (!exiting) {
  exiting = true
  await new Promise((r) => setTimeout(r, postReplyExitDelayMs))
  logEndOnce()
  process.exit(0)
}
`,
    { mode: 0o755 },
  )

  if (process.platform === 'win32') {
    const [codexPath, claudePath] = await Promise.all([
      writeWindowsNodeLauncher(directory, 'codex-shared-usage', [codexScriptPath]),
      writeWindowsNodeLauncher(directory, 'claude-shared-usage', [claudeScriptPath]),
    ])
    return { codexPath, claudePath }
  }

  await chmod(codexScriptPath, 0o755)
  await chmod(claudeScriptPath, 0o755)
  return { codexPath: codexScriptPath, claudePath: claudeScriptPath }
}

async function configureAgyDatabase(
  fixture: RuntimeFixture,
  options: {
    agyExecutablePath?: string
    codexExecutablePath?: string
    claudeExecutablePath?: string
    defaults?: DefaultSessionSettings
  },
): Promise<void> {
  const db = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
  try {
    if (options.codexExecutablePath) {
      db.runtimePreparationRepository.saveSelectedExecutablePath(
        'codex',
        options.codexExecutablePath,
      )
    }
    if (options.claudeExecutablePath) {
      db.runtimePreparationRepository.saveSelectedExecutablePath(
        'claude',
        options.claudeExecutablePath,
      )
    }
    if (options.agyExecutablePath) {
      db.runtimePreparationRepository.saveSelectedExecutablePath('agy', options.agyExecutablePath)
    }
    if (options.defaults) {
      db.defaultSessionSettingsRepository.save(options.defaults)
    }
  } finally {
    db.close()
  }
}

async function ensureWideWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setSize(1440, 920)
  })
}

async function addProjectViaDialog(
  app: ElectronApplication,
  window: Page,
  projectDirectory: string,
  projectName: string,
): Promise<string> {
  await app.evaluate(({ dialog }, selectedPath) => {
    Reflect.set(dialog, 'showOpenDialog', async () => ({
      canceled: false,
      filePaths: [selectedPath],
    }))
  }, projectDirectory)
  await window.getByRole('button', { name: 'Add project', exact: true }).click()
  await expect(
    window.getByRole('button', { name: `Rename Project ${projectName}`, exact: true }),
  ).toBeVisible()

  return window.evaluate(async (expectedDir) => {
    const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
    const catalog = await bridge.getProjectCatalog()
    if (!catalog.ok) throw new Error('Project catalog unavailable')
    const found = catalog.value.projects.find((row) => row.directoryPath === expectedDir)
    if (!found) throw new Error('Created project was not found in catalog')
    return found.id
  }, projectDirectory)
}

test(
  'onboarding renders 3 CLI cards, blocks Continue below 2 ready, unlocks at 2 of 3 ready, and pre-selects the ready pair',
  { tag: '@ui' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({
      mode: 'ui',
      firstUse: true,
      claude: 'ready',
      codex: 'authentication_required',
    })
    let app: ElectronApplication | undefined

    try {
      const outdatedAgy = await writeAgyCliFixture(fixture, 'agy-outdated', {
        readiness: 'unsupported_version',
        scenario: 'complete',
      })
      const readyAgy = await writeAgyCliFixture(fixture, 'agy-ready', {
        readiness: 'ready',
        scenario: 'complete',
      })
      await configureAgyDatabase(fixture, { agyExecutablePath: outdatedAgy.executablePath })

      app = await fixture.launch()
      const window = await app.firstWindow()

      await expect(
        window.getByRole('heading', { name: 'Connect your coding agents' }),
      ).toBeVisible()
      await expect(window.locator('article[data-agent="claude"]')).toHaveAttribute(
        'data-state',
        'ready',
      )
      await expect(window.locator('article[data-agent="codex"]')).toHaveAttribute(
        'data-state',
        'authentication_required',
      )
      await expect(window.locator('article[data-agent="agy"]')).toHaveAttribute(
        'data-state',
        'unsupported_version',
      )
      await expect(window.getByText('1 of 3 ready · Minimum 2 required')).toBeVisible()

      const continueButton = window.getByRole('button', { name: 'Continue', exact: true })
      await expect(continueButton).toHaveCount(0)
      await expect(window.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled()

      await app.evaluate(({ dialog }, replacementPath) => {
        Reflect.set(dialog, 'showOpenDialog', async () => ({
          canceled: false,
          filePaths: [replacementPath],
        }))
      }, readyAgy.executablePath)

      const agyCard = window.locator('article[data-agent="agy"]')
      await agyCard.hover()
      await agyCard.getByRole('button', { name: 'Change path…', exact: true }).click()

      await expect(window.locator('article[data-agent="agy"]')).toHaveAttribute(
        'data-state',
        'ready',
      )
      await expect(window.getByText('2 of 3 ready · Minimum 2 required')).toBeVisible()
      await expect(continueButton).toBeEnabled()

      await continueButton.click()
      await expect(
        window.getByRole('heading', { name: 'Set your collaboration defaults' }),
      ).toBeVisible()

      await expect(window.getByRole('radio', { name: /Claude Code.*Primary agent/u })).toBeChecked()
      await expect(window.getByRole('combobox', { name: 'Secondary agent' })).toHaveValue('agy')
      await expect(window.getByRole('radio', { name: /Codex.*Sign-in required/u })).toBeDisabled()

      await window.getByRole('button', { name: 'Save and enter Pact', exact: true }).click()
      await expect(window.getByRole('heading', { name: 'Start with a project' })).toBeVisible()

      const savedDefaults = await window.evaluate(async () => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const state = await bridge.getDefaultSessionSettingsEditorState()
        if (!state.ok) throw new Error('Default session settings unavailable')
        return state.value.current?.settings
      })
      expect(savedDefaults?.primaryAgentId).toBe('claude')
      expect(savedDefaults?.secondaryAgentId).toBe('agy')
    } finally {
      try {
        if (app) await quitPact(app)
      } finally {
        await fixture.dispose()
      }
    }
  },
)

test(
  'session creation supports all 6 (Primary, Secondary) permutations across Claude Code, Codex, and Antigravity',
  { tag: '@ui' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({
      mode: 'ui',
      firstUse: true,
      claude: 'ready',
      codex: 'ready',
      claudeConversation: 'complete',
      codexAppServer: 'complete',
    })
    let app: ElectronApplication | undefined

    try {
      const agy = await writeAgyCliFixture(fixture, 'agy-permutations', {
        readiness: 'ready',
        scenario: 'complete',
      })
      await configureAgyDatabase(fixture, {
        agyExecutablePath: agy.executablePath,
        defaults: defaultThreeAgentSettings('claude', 'codex'),
      })

      const projectName = 'six-pair-project'
      const projectDirectory = await fixture.createProjectDirectory(projectName)

      app = await fixture.launch()
      await ensureWideWindow(app)
      const window = await app.firstWindow()
      const projectId = await addProjectViaDialog(app, window, projectDirectory, projectName)

      const permutations: ReadonlyArray<readonly [RuntimeAgentId, RuntimeAgentId, string]> = [
        ['claude', 'codex', 'Claude Code'],
        ['codex', 'claude', 'Codex'],
        ['claude', 'agy', 'Claude Code'],
        ['agy', 'claude', 'Antigravity'],
        ['codex', 'agy', 'Codex'],
        ['agy', 'codex', 'Antigravity'],
      ]

      for (const [, secondaryId, primaryLabel] of permutations) {
        const newSessionBtn = window.getByRole('button', { name: `New Session in ${projectName}` })
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each permutation exercises the single SessionCreationView sequentially.
        await newSessionBtn.focus()
        // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential UI interaction.
        await newSessionBtn.click()
        // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential UI interaction.
        await expect(window.getByRole('heading', { name: 'Create a Session' })).toBeVisible()
        // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential UI interaction.
        await window.getByRole('button', { name: /Customize this Session/u }).click()

        const primaryRadio = window.getByRole('radio', {
          name: new RegExp(`^${primaryLabel}\\b`, 'u'),
        })
        // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential UI interaction.
        if (!(await primaryRadio.isChecked())) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential UI interaction.
          await primaryRadio.click()
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential UI interaction.
        await window
          .getByRole('combobox', { name: 'Secondary agent' })
          .selectOption({ value: secondaryId })
        // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential UI interaction.
        await window.getByRole('button', { name: 'Create Session', exact: true }).click()
        // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential UI interaction.
        await expect(window.getByRole('heading', { name: 'Create a Session' })).toHaveCount(0)
      }

      const persistedPairs = await window.evaluate(async (id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const collected: Array<[RuntimeAgentId, RuntimeAgentId]> = []
        let cursor: Parameters<DesktopBridge['getSessionCatalog']>[1]
        for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Paginated catalog read.
          const page = await bridge.getSessionCatalog(id, cursor)
          if (!page.ok) throw new Error('Session catalog unavailable')
          for (const session of page.value.sessions) {
            collected.push([session.settings.primaryAgentId, session.settings.secondaryAgentId])
          }
          if (!page.value.nextCursor) break
          cursor = page.value.nextCursor
        }
        return collected
      }, projectId)

      expect(persistedPairs).toHaveLength(6)
      for (const [primaryId, secondaryId] of permutations) {
        expect(persistedPairs).toContainEqual([primaryId, secondaryId])
      }
    } finally {
      try {
        if (app) await quitPact(app)
      } finally {
        await fixture.dispose()
      }
    }
  },
)

test(
  'main Session swaps Primary and Secondary anytime, blocks 3rd-agent replacement while active, and resets Full access to Ask on idle replacement',
  { tag: '@deterministic' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({
      mode: 'deterministic',
      firstUse: true,
      claude: 'ready',
      codex: 'ready',
      claudeConversation: 'complete',
      codexAppServer: 'complete',
    })
    let app: ElectronApplication | undefined

    try {
      const agy = await writeAgyCliFixture(fixture, 'agy-replacement', {
        readiness: 'ready',
        scenario: 'slow_turn',
        holdTurn: true,
      })
      await configureAgyDatabase(fixture, {
        agyExecutablePath: agy.executablePath,
        defaults: defaultThreeAgentSettings('agy', 'claude'),
      })

      const projectName = 'replacement-gates'
      const projectDirectory = await fixture.createProjectDirectory(projectName)

      app = await fixture.launch()
      await ensureWideWindow(app)
      const window = await app.firstWindow()
      const projectId = await addProjectViaDialog(app, window, projectDirectory, projectName)

      await window.getByRole('button', { name: `New Session in ${projectName}` }).focus()
      await window.getByRole('button', { name: `New Session in ${projectName}` }).click()
      await window.getByRole('button', { name: 'Create Session', exact: true }).click()
      await expect(
        window
          .getByRole('region', { name: 'Workspace', exact: true })
          .getByRole('combobox', { name: 'Message' }),
      ).toBeVisible()

      const sessionId = await window.evaluate(async (id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const page = await bridge.getSessionCatalog(id)
        if (!page.ok || page.value.sessions.length !== 1) throw new Error('Expected 1 session')
        return page.value.sessions[0]!.id
      }, projectId)

      // Create a Side Chat while parent active pair is (agy, claude) so it locks (agy, claude)
      await window.getByRole('button', { name: 'Side chats', exact: true }).click()
      const sideChatsPanel = window.getByRole('region', { name: 'Side chats', exact: true })
      const activeStage = sideChatsPanel.locator('[data-stage-state="active"]')
      await activeStage.getByRole('button', { name: 'New side chat', exact: true }).click()
      await expect(
        activeStage.getByRole('heading', { name: 'New side chat', exact: true }),
      ).toBeVisible()
      await expect(
        activeStage.getByRole('button', { name: 'Session settings', exact: true }),
      ).toHaveCount(0)
      const lockedSideComposer = activeStage.getByRole('combobox', { name: 'Message' })
      await lockedSideComposer.click()
      await lockedSideComposer.fill('Keep locked (agy, claude) pair draft across navigation')

      // Grant Full access to Antigravity on the main Session
      const fullGranted = await window.evaluate(async (sid) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const current = await bridge.getSessionSettings(sid)
        if (!current.ok) throw new Error('Session settings unavailable')
        const updated = await bridge.saveSessionPermission({
          sessionId: sid,
          agentId: 'agy',
          mode: 'full',
          expectedRevision: current.value.session.settingsRevision,
          confirmedFullAccess: true,
        })
        return updated.ok ? updated.value.session.settings.permissionModes?.agy : null
      }, sessionId)
      expect(fullGranted).toBe('full')

      // Start an active Antigravity turn and verify 3rd-agent replacement (codex) is blocked while Primary<->Secondary swap stays allowed
      const mainWorkspace = window.getByRole('region', { name: 'Workspace', exact: true })
      const mainComposer = mainWorkspace.getByRole('combobox', { name: 'Message' })
      await mainComposer.click()
      await mainComposer.fill('@agy Hold active turn while checking replacement gate')
      await mainWorkspace.getByRole('button', { name: 'Send message', exact: true }).click()

      await expect(mainWorkspace.getByText('Antigravity working on turn...')).toBeVisible()

      await window.getByRole('button', { name: 'Session settings', exact: true }).click()
      const settingsSection = window.getByRole('region', { name: 'Session settings' })
      await expect(settingsSection).toBeVisible()
      await expect(
        settingsSection.getByText(
          'Primary and Secondary can swap anytime. Wait for active or recovering agent work to finish before bringing in the third agent.',
        ),
      ).toBeVisible()
      await expect(
        settingsSection.getByRole('radio', { name: /Codex.*Active pair locked/u }),
      ).toBeDisabled()

      // IPC transaction must also reject replacing an agent during an active turn
      const blockedIpc = await window.evaluate(async (sid) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const res = await bridge.saveSessionSettings({
          sessionId: sid,
          settings: {
            primaryAgentId: 'claude',
            secondaryAgentId: 'codex',
            agents: {
              claude: { model: null, effort: null, speed: 'native' },
              codex: { model: null, effort: null, speed: 'native' },
              agy: { model: null, effort: null, speed: 'native' },
            },
            maxDiscussionRounds: 6,
            maxReviewCycles: 3,
            maxRepairAttempts: 3,
          },
        })
        return res.ok ? 'unexpected-ok' : res.error.message
      }, sessionId)
      expect(blockedIpc).toContain('Wait until the current Agent turn finishes')

      // Primary <-> Secondary swap (agy, claude) -> (claude, agy) succeeds even while active!
      await settingsSection.getByRole('radio', { name: /^Claude Code/u }).click()
      await settingsSection.getByRole('button', { name: 'Save changes', exact: true }).click()
      await expect(
        settingsSection.getByRole('button', { name: 'Save changes', exact: true }),
      ).toBeDisabled()

      // Release the active Antigravity turn so the main Session returns to clean idle
      await agy.updateControl({ holdTurn: false, scenario: 'complete' })
      await expect(
        mainWorkspace.getByText('Antigravity working on turn... Completed cleanly.'),
      ).toBeVisible()

      // Now idle: replace Antigravity with Codex ((claude, agy) -> (claude, codex)) and verify Full access resets to Ask!
      await window.getByRole('button', { name: 'Session settings', exact: true }).click()
      await expect(settingsSection).toBeVisible()
      await expect(
        settingsSection.getByRole('radio', { name: /^Claude Code Primary agent/u }),
      ).toBeChecked()
      await settingsSection
        .getByRole('combobox', { name: 'Secondary agent' })
        .selectOption({ value: 'codex' })
      await expect(
        settingsSection.getByText(
          'Antigravity Full access resets to Ask when removed from this session’s active pair.',
        ),
      ).toBeVisible()
      await settingsSection.getByRole('button', { name: 'Save changes', exact: true }).click()
      await expect(
        settingsSection.getByRole('button', { name: 'Save changes', exact: true }),
      ).toBeDisabled()

      const sideChatsPage = await window.evaluate(async (parentId) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const result = await bridge.listSideChats({
          parentSessionId: parentId,
          direction: 'older',
          limit: 5,
        })
        if (!result.ok) throw new Error('Side chat list unavailable')
        return result.value
      }, sessionId)
      expect(sideChatsPage.items).toHaveLength(1)

      const db = ReadonlyFixtureDatabase.open(fixture)
      try {
        const updatedMain = db.sessionRepository.find(sessionId)
        expect(updatedMain?.settings.primaryAgentId).toBe('claude')
        expect(updatedMain?.settings.secondaryAgentId).toBe('codex')
        expect(updatedMain?.settings.permissionModes?.agy).toBe('ask')

        const lockedSideChat = db.sessionRepository.find(sideChatsPage.items[0]!.id)
        expect(lockedSideChat?.settings.primaryAgentId).toBe('agy')
        expect(lockedSideChat?.settings.secondaryAgentId).toBe('claude')
      } finally {
        db.close()
      }
    } finally {
      try {
        if (app) await quitPact(app)
      } finally {
        await fixture.dispose()
      }
    }
  },
)

test(
  'routes @agy in main chat, hands off /btw @agy to a locked Side Chat, and places @Main below active mentions and @all',
  { tag: '@deterministic' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({
      mode: 'deterministic',
      firstUse: true,
      claude: 'ready',
      codex: 'ready',
      claudeConversation: 'complete',
      codexAppServer: 'complete',
    })
    let app: ElectronApplication | undefined

    try {
      const agy = await writeAgyCliFixture(fixture, 'agy-routing', {
        readiness: 'ready',
        scenario: 'complete',
      })
      await configureAgyDatabase(fixture, {
        agyExecutablePath: agy.executablePath,
        defaults: defaultThreeAgentSettings('claude', 'agy'),
      })

      const projectName = 'agy-side-chat-routing'
      const projectDirectory = await fixture.createProjectDirectory(projectName)

      app = await fixture.launch()
      await ensureWideWindow(app)
      const window = await app.firstWindow()
      const projectId = await addProjectViaDialog(app, window, projectDirectory, projectName)

      await window.getByRole('button', { name: `New Session in ${projectName}` }).focus()
      await window.getByRole('button', { name: `New Session in ${projectName}` }).click()
      await window.getByRole('button', { name: 'Create Session', exact: true }).click()
      await expect(
        window
          .getByRole('region', { name: 'Workspace', exact: true })
          .getByRole('combobox', { name: 'Message' }),
      ).toBeVisible()

      const sessionId = await window.evaluate(async (id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const page = await bridge.getSessionCatalog(id)
        if (!page.ok || page.value.sessions.length !== 1) throw new Error('Expected 1 session')
        return page.value.sessions[0]!.id
      }, projectId)

      const mainWorkspace = window.getByRole('region', { name: 'Workspace', exact: true })
      const mainComposer = mainWorkspace.getByRole('combobox', { name: 'Message' })

      // Verify main Session @ autocomplete shows ONLY active pair (@claude, @agy) + @all, never @codex or @gemini
      await mainComposer.click()
      await mainComposer.fill('@')
      const mainRecipients = mainWorkspace.getByRole('listbox', { name: 'Message recipients' })
      await expect(mainRecipients).toBeVisible()
      const mainOptionTexts = await mainRecipients.getByRole('option').allInnerTexts()
      expect(mainOptionTexts.some((t) => t.includes('@claude'))).toBe(true)
      expect(mainOptionTexts.some((t) => t.includes('@agy'))).toBe(true)
      expect(mainOptionTexts.some((t) => t.includes('@all'))).toBe(true)
      expect(mainOptionTexts.some((t) => t.includes('@codex'))).toBe(false)
      expect(mainOptionTexts.some((t) => t.includes('@gemini'))).toBe(false)

      await mainRecipients.getByRole('option', { name: /^Antigravity/u }).click()
      await window.keyboard.insertText('Verify main session @agy routing.')
      await mainWorkspace.getByRole('button', { name: 'Send message', exact: true }).click()

      await expect(
        mainWorkspace
          .locator('article[data-pact-speaker="agy"]')
          .getByText('Antigravity fixture response #1.'),
      ).toBeVisible()

      // Hand off /btw @agy draft to a new Side Chat without auto-sending, then send explicitly
      await mainComposer.click()
      await mainComposer.fill('/btw')
      const skillMenu = window.getByRole('listbox', { name: 'Native Skills' })
      await expect(skillMenu).toBeVisible()
      await window.locator('#skill-pact-btw').click()
      await expect(mainComposer.locator('[data-pact-command="btw"]')).toHaveText('pact:btw')
      await window.keyboard.insertText('@agy Check side-branch invariant')
      await mainWorkspace.getByRole('button', { name: 'Send message', exact: true }).click()

      const sideChatsPanel = window.getByRole('region', { name: 'Side chats', exact: true })
      const activeStage = sideChatsPanel.locator('[data-stage-state="active"]')
      await expect(activeStage).toBeVisible()
      await expect(
        activeStage.getByRole('heading', { name: 'New side chat', exact: true }),
      ).toBeVisible()
      const sideComposer = activeStage.getByRole('combobox', { name: 'Message' })
      await expect(sideComposer).toContainText('Check side-branch invariant')
      await expect(mainComposer).toBeEmpty()
      await expect(activeStage.locator('article[data-pact-speaker="agy"]')).toHaveCount(0)

      await activeStage.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect(
        activeStage
          .locator('article[data-pact-speaker="agy"]')
          .getByText('Antigravity fixture response #2.'),
      ).toBeVisible()

      // Verify Side Chat @ autocomplete places @Main strictly below the locked active pair (@claude, @agy) and @all
      await sideComposer.click()
      await sideComposer.fill('@')
      const sideRecipients = activeStage.getByRole('listbox', { name: 'Message recipients' })
      await expect(sideRecipients).toBeVisible()
      const sideOptionTexts = await sideRecipients.getByRole('option').allInnerTexts()
      const claudeIdx = sideOptionTexts.findIndex((t) => t.includes('@claude'))
      const agyIdx = sideOptionTexts.findIndex((t) => t.includes('@agy'))
      const allIdx = sideOptionTexts.findIndex((t) => t.includes('@all'))
      const mainIdx = sideOptionTexts.findIndex((t) => t.includes('@Main'))
      expect(claudeIdx).toBeGreaterThanOrEqual(0)
      expect(agyIdx).toBeGreaterThanOrEqual(0)
      expect(allIdx).toBeGreaterThan(Math.max(claudeIdx, agyIdx))
      expect(mainIdx).toBe(allIdx + 1)

      const allOption = sideRecipients.getByRole('option', { name: /@all/u })
      const mainOption = sideRecipients.getByRole('option', { name: /^Main chat/u })
      const allBounds = await allOption.boundingBox()
      const mainBounds = await mainOption.boundingBox()
      expect(allBounds).not.toBeNull()
      expect(mainBounds).not.toBeNull()
      expect(mainBounds!.y).toBeGreaterThan(allBounds!.y)

      // Replace parent Session active pair while idle to (codex, claude), then sync @Main from the (claude, agy) Side Chat!
      await window.evaluate(async (sid) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const res = await bridge.saveSessionSettings({
          sessionId: sid,
          settings: {
            primaryAgentId: 'codex',
            secondaryAgentId: 'claude',
            agents: {
              claude: { model: null, effort: null, speed: 'native' },
              codex: { model: null, effort: null, speed: 'native' },
              agy: { model: null, effort: null, speed: 'native' },
            },
            maxDiscussionRounds: 6,
            maxReviewCycles: 3,
            maxRepairAttempts: 3,
          },
        })
        if (!res.ok) throw new Error(res.error.message)
      }, sessionId)

      await mainOption.click()
      await window.keyboard.insertText('Sync verified Antigravity takeaway back to parent.')
      await activeStage.getByRole('button', { name: 'Send to main', exact: true }).click()

      await expect(activeStage.locator('.pact-side-chat-sync-bar')).toContainText(
        'Sent to main chat',
      )
      await expect(
        mainWorkspace.getByText('Sync verified Antigravity takeaway back to parent.'),
      ).toBeVisible()
      await expect(
        mainWorkspace.getByRole('button', { name: 'From side chat', exact: true }),
      ).toBeVisible()
      await expect(mainWorkspace.getByText('Bounded lifecycle response.')).toBeVisible()
    } finally {
      try {
        if (app) await quitPact(app)
      } finally {
        await fixture.dispose()
      }
    }
  },
)

test(
  'Usage popover displays Codex, Claude Code, and Antigravity 5h/7d windows, multi-pool scope note, <= 2 concurrent probe cap, and zero PII',
  { tag: '@deterministic' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({
      mode: 'deterministic',
      firstUse: true,
      claude: 'ready',
      codex: 'ready',
      claudeConversation: 'complete',
      codexAppServer: 'complete',
    })
    let app: ElectronApplication | undefined

    try {
      const sharedUsageLogPath = join(fixture.directory, 'shared-provider-usage-events.jsonl')
      await writeFile(sharedUsageLogPath, '', { mode: 0o600 })
      const peerUsageClis = await writeSharedUsagePeerClis(
        fixture.directory,
        sharedUsageLogPath,
        250,
      )
      const agy = await writeAgyCliFixture(fixture, 'agy-usage', {
        readiness: 'ready',
        scenario: 'complete',
        usageHoldMs: 250,
        sharedUsageLogPath,
      })
      await configureAgyDatabase(fixture, {
        codexExecutablePath: peerUsageClis.codexPath,
        claudeExecutablePath: peerUsageClis.claudePath,
        agyExecutablePath: agy.executablePath,
        defaults: defaultThreeAgentSettings('agy', 'codex'),
      })

      const usageProjectDir = await fixture.createProjectDirectory('agy-usage-project')
      app = await fixture.launch()
      await ensureWideWindow(app)
      const window = await app.firstWindow()
      await addProjectViaDialog(app, window, usageProjectDir, 'agy-usage-project')

      // Trigger concurrent refresh across all 3 providers for one owner and verify App-wide <= 2 admission
      const refreshed = await window.evaluate(async () => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const [codex, claude, agySnap] = await Promise.all([
          bridge.refreshProviderUsage({
            provider: 'codex',
            requestId: crypto.randomUUID(),
          }),
          bridge.refreshProviderUsage({
            provider: 'claude',
            requestId: crypto.randomUUID(),
          }),
          bridge.refreshProviderUsage({
            provider: 'agy',
            requestId: crypto.randomUUID(),
          }),
        ])
        return { codex, claude, agySnap }
      })

      expect(refreshed.codex.ok).toBe(true)
      expect(refreshed.claude.ok).toBe(true)
      expect(refreshed.agySnap.ok).toBe(true)

      const facts = await agy.readFacts()
      expect(facts.usageCalls).toBeGreaterThanOrEqual(1)
      expect(facts.peakUsageConcurrent).toBeLessThanOrEqual(2)

      // Compute true physical process-lifecycle active count from the single shared JSONL log!
      const rawSharedLog = await readFile(sharedUsageLogPath, 'utf8')
      expect(Buffer.byteLength(rawSharedLog, 'utf8')).toBeLessThanOrEqual(16 * 1024)
      const events = rawSharedLog
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
          const parsed: unknown = JSON.parse(line)
          if (!isPlainRecord(parsed)) throw new Error('Invalid shared usage event row.')
          const rawProvider = parsed['provider']
          const rawEvent = parsed['event']
          const rawAt = parsed['at']
          return {
            provider: typeof rawProvider === 'string' ? rawProvider : '',
            event: typeof rawEvent === 'string' ? rawEvent : '',
            at: typeof rawAt === 'number' && Number.isFinite(rawAt) ? rawAt : 0,
            index,
          }
        })
        .toSorted((left, right) => left.at - right.at || left.index - right.index)
      const starts = events.filter((entry) => entry.event === 'start')
      const ends = events.filter((entry) => entry.event === 'end')
      expect(starts.length).toBe(3)
      expect(ends.length).toBe(3)
      const startedProviders = new Set(starts.map((entry) => entry.provider))
      expect(startedProviders).toEqual(new Set(['codex', 'claude', 'agy']))
      // 3rd usage subprocess must not spawn until one of the first 2 physically exited!
      expect(starts[2]!.at).toBeGreaterThanOrEqual(ends[0]!.at)
      let simultaneousActive = 0
      let crossProviderPeak = 0
      for (const entry of events) {
        if (entry.event === 'start') {
          simultaneousActive += 1
          if (simultaneousActive > crossProviderPeak) {
            crossProviderPeak = simultaneousActive
          }
        } else if (entry.event === 'end') {
          simultaneousActive = Math.max(0, simultaneousActive - 1)
        }
      }
      expect(simultaneousActive).toBe(0)
      expect(crossProviderPeak).toBeGreaterThanOrEqual(1)
      expect(crossProviderPeak).toBeLessThanOrEqual(2)

      // Open and pin the 3-provider Usage popover inside ProjectNavigation
      const trigger = window.getByRole('button', { name: 'Usage', exact: true })
      await expect(trigger).toBeVisible()
      await trigger.click()
      const dialog = window.getByRole('dialog', { name: 'Usage' })
      await expect(dialog).toBeVisible()

      await expect(dialog.locator('[data-provider-usage="codex"]')).toBeVisible()
      await expect(dialog.locator('[data-provider-usage="claude"]')).toBeVisible()
      const agySection = dialog.locator('[data-provider-usage="agy"]')
      await expect(agySection).toBeVisible()
      await expect(agySection).toContainText('Antigravity')
      await expect(agySection).toContainText('Gemini Models')
      await expect(agySection).toContainText('Claude & GPT')
      await expect(agySection).toContainText('72% left')
      await expect(agySection).toContainText('85% left')
      await expect(agySection).toContainText('60% left')
      await expect(agySection).not.toContainText(/[\u4e00-\u9fff]/u)
      await expect(agySection.getByRole('button', { name: 'Refresh Antigravity' })).toBeVisible()

      // Verify zero PII leak from untrusted CLI JSON payload
      const dialogText = await dialog.innerText()
      expect(dialogText).not.toContain('private-agy-owner@example.com')
      expect(dialogText).not.toContain('agy-user-991')
    } finally {
      try {
        if (app) await quitPact(app)
      } finally {
        await fixture.dispose()
      }
    }
  },
)

test(
  'Antigravity ACP run completes permission approval, structured elicitation, file-change Undo, typed cut-point Fork, and zero-Turn Rebuild',
  { tag: '@deterministic' },
  async () => {
    test.setTimeout(150_000)
    const fixture = await createRuntimeFixture({
      mode: 'deterministic',
      firstUse: true,
      claude: 'ready',
      codex: 'ready',
      codexAppServer: 'fork_complete',
    })
    let app: ElectronApplication | undefined

    try {
      const agy = await writeAgyCliFixture(fixture, 'agy-lifecycle', {
        readiness: 'ready',
        scenario: 'permission_and_elicitation',
      })
      await configureAgyDatabase(fixture, {
        agyExecutablePath: agy.executablePath,
        defaults: defaultThreeAgentSettings('agy', 'codex'),
      })

      const projectName = 'agy-full-lifecycle'
      const projectDirectory = await fixture.createProjectDirectory(projectName)
      const targetFilePath = join(projectDirectory, 'agy-target.ts')
      const originalFileContent = 'export const agyState = "initial"\n'
      await writeFile(targetFilePath, originalFileContent, 'utf8')

      app = await fixture.launch()
      await ensureWideWindow(app)
      const window = await app.firstWindow()
      const projectId = await addProjectViaDialog(app, window, projectDirectory, projectName)

      await window.getByRole('button', { name: `New Session in ${projectName}` }).focus()
      await window.getByRole('button', { name: `New Session in ${projectName}` }).click()
      await window.getByRole('button', { name: 'Create Session', exact: true }).click()
      await expect(
        window
          .getByRole('region', { name: 'Workspace', exact: true })
          .getByRole('combobox', { name: 'Message' }),
      ).toBeVisible()

      const sessionId = await window.evaluate(async (id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const page = await bridge.getSessionCatalog(id)
        if (!page.ok || page.value.sessions.length !== 1) throw new Error('Expected 1 session')
        return page.value.sessions[0]!.id
      }, projectId)

      const mainWorkspace = window.getByRole('region', { name: 'Workspace', exact: true })
      const composer = mainWorkspace.getByRole('combobox', { name: 'Message' })

      // 1. Run Codex turn first so both active pair members (agy, codex) have native history for Fork
      await composer.click()
      await composer.fill('@codex Establish peer baseline before Antigravity turn.')
      await mainWorkspace.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect(mainWorkspace.getByText('Bounded lifecycle response.')).toBeVisible()

      // 2. Run Antigravity Turn 1 with permission approval + structured elicitation + literal UUID in prose
      const proseCanaryUuid = randomUUID()
      await composer.click()
      await composer.fill(`@agy Audit module with literal UUID ${proseCanaryUuid} preserved.`)
      await mainWorkspace.getByRole('button', { name: 'Send message', exact: true }).click()

      const permCard = mainWorkspace.getByRole('region', {
        name: 'Antigravity permission request',
      })
      await expect(permCard).toBeVisible()
      await expect(permCard).toContainText('Antigravity needs approval')
      await permCard.getByRole('button', { name: 'Allow once', exact: true }).click()

      await expect(mainWorkspace.getByText('Antigravity needs your input')).toBeVisible()
      await mainWorkspace.getByRole('button', { name: 'Submit details', exact: true }).click()

      await expect(
        mainWorkspace.getByText('CODE_ALPHA_42 verified for storage-engine.'),
      ).toBeVisible()

      const factsAfterTurn1 = await agy.readFacts()
      expect(factsAfterTurn1.permissionChoices).toEqual(['allow'])
      expect(factsAfterTurn1.elicitationAnswers[0]).toMatchObject({
        module_scope: 'storage-engine',
      })

      // 3. Run Antigravity Turn 2 with workspace file edit + three-way reverse Undo
      await agy.updateControl({
        scenario: 'file_change_undo',
        editFileName: 'agy-target.ts',
        editNextContent: 'export const agyState = "modified-by-agy"\n',
      })
      await composer.click()
      await composer.fill('@agy Update agy-target.ts for Undo verification.')
      await mainWorkspace.getByRole('button', { name: 'Send message', exact: true }).click()

      await expect(mainWorkspace.getByText('CODE_BETA_99 updated agy-target.ts.')).toBeVisible()
      expect(await readFile(targetFilePath, 'utf8')).toBe(
        'export const agyState = "modified-by-agy"\n',
      )

      const changesCard = mainWorkspace.getByRole('region', {
        name: 'Changes from this response',
      })
      await expect(changesCard).toContainText('Edited 1 file')
      await changesCard.getByRole('button', { name: 'Undo', exact: true }).click()
      await expect(changesCard).toContainText('Undone')
      expect(await readFile(targetFilePath, 'utf8')).toBe(originalFileContent)

      // 4. Typed cut-point Fork at Turn 1 (CODE_ALPHA_42), proving Turn 2 (CODE_BETA_99) is excluded and prose UUID survives!
      await agy.updateControl({ scenario: 'complete', customAnswer: 'Forked branch follow-up.' })
      const turn1Reply = mainWorkspace
        .locator('article[data-pact-speaker="agy"]')
        .filter({ hasText: 'CODE_ALPHA_42 verified for storage-engine.' })
      await turn1Reply.hover()
      await turn1Reply
        .getByRole('button', { name: 'Fork conversation from this reply', exact: true })
        .click()

      const forkDialog = window.getByRole('dialog', { name: 'Fork conversation' })
      await expect(forkDialog).toBeVisible()
      await expect(forkDialog.getByRole('alert')).toHaveCount(0)
      await forkDialog.getByRole('button', { name: 'Create fork', exact: true }).click()
      await expect(forkDialog).toHaveCount(0, { timeout: 20_000 })

      // Forked Session shows Turn 1 (CODE_ALPHA_42) and excludes Turn 2 (CODE_BETA_99)
      await expect(
        mainWorkspace.getByText('CODE_ALPHA_42 verified for storage-engine.'),
      ).toBeVisible()
      await expect(mainWorkspace.getByText('CODE_BETA_99 updated agy-target.ts.')).toHaveCount(0)

      // Inspect cold SQLite database of the forked Antigravity session in isolated HOME
      const forkedSessionId = await window.evaluate(
        async ({ targetProjectId, sourceSessionId }) => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          const catalog = await bridge.getSessionCatalog(targetProjectId)
          if (!catalog.ok) throw new Error('Session catalog unavailable')
          const found = catalog.value.sessions.find((s) => s.id !== sourceSessionId)
          if (!found) throw new Error('Forked session was not created')
          return found.id
        },
        { targetProjectId: projectId, sourceSessionId: sessionId },
      )
      const forkedAgyContext = (() => {
        const db = ReadonlyFixtureDatabase.open(fixture)
        try {
          const snapshot = db.conversationRepository.read(forkedSessionId)
          const ctx = snapshot.nativeContexts.find((c) => c.agentId === 'agy')
          return { forkedSessionId, nativeSessionId: ctx?.nativeSessionId }
        } finally {
          db.close()
        }
      })()
      expect(forkedAgyContext.nativeSessionId).toBeDefined()

      const forkedDbPath = join(
        agy.appDataDir,
        'conversations',
        `${forkedAgyContext.nativeSessionId!}.db`,
      )
      const rawForkDb = openReadonlySqlite(forkedDbPath)
      try {
        const stepCountRow = rawForkDb.prepare('SELECT COUNT(*) AS count FROM "steps"').get()
        expect(isPlainRecord(stepCountRow) ? stepCountRow['count'] : undefined).toBe(2)
        const payloadRows = rawForkDb
          .prepare('SELECT step_payload, step_format FROM "steps" ORDER BY idx ASC')
          .all()
          .filter(isPlainRecord)
        expect(payloadRows.map((r) => r['step_format'])).toEqual([0, 0])
        const firstPayload = payloadRows[0]?.['step_payload']
        const secondPayload = payloadRows[1]?.['step_payload']
        expect(Buffer.isBuffer(firstPayload) ? firstPayload.toString('utf8') : '').toContain(
          proseCanaryUuid,
        )
        expect(Buffer.isBuffer(secondPayload) ? secondPayload.toString('utf8') : '').toContain(
          'CODE_ALPHA_42',
        )
        expect(Buffer.isBuffer(secondPayload) ? secondPayload.toString('utf8') : '').not.toContain(
          'CODE_BETA_99',
        )
      } finally {
        rawForkDb.close()
      }

      // 5. Simulate missing native <forkSid>.db and execute zero-Turn Rebuild seed + cold session/load verification
      await rm(forkedDbPath, { force: true })
      await rm(`${forkedDbPath}-wal`, { force: true })
      await rm(`${forkedDbPath}-shm`, { force: true })

      const turnsBeforeRebuild = (await agy.readFacts()).promptTurns
      const rebuildResult = await window.evaluate(async (forkSid) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        return bridge.rebuildNativeContext({
          sessionId: forkSid,
          agentId: 'agy',
          clientOperationId: crypto.randomUUID(),
        })
      }, forkedAgyContext.forkedSessionId)
      expect(rebuildResult.ok).toBe(true)

      await expect(
        window.getByText('Antigravity native session rebuilt', { exact: true }),
      ).toBeVisible({ timeout: 15_000 })
      expect((await agy.readFacts()).promptTurns).toBe(turnsBeforeRebuild)

      const rebuiltNativeSid = (() => {
        const db = ReadonlyFixtureDatabase.open(fixture)
        try {
          const snapshot = db.conversationRepository.read(forkedAgyContext.forkedSessionId)
          return snapshot.nativeContexts.find((c) => c.agentId === 'agy')?.nativeSessionId
        } finally {
          db.close()
        }
      })()
      expect(rebuiltNativeSid).toBeDefined()
      expect(rebuiltNativeSid).not.toBe(forkedAgyContext.nativeSessionId)
      const rebuiltStat = await lstat(
        join(agy.appDataDir, 'conversations', `${rebuiltNativeSid!}.db`),
      )
      expect(rebuiltStat.isFile()).toBe(true)
      expect(createHash('sha256').update(rebuiltNativeSid!).digest('hex')).toHaveLength(64)
    } finally {
      try {
        if (app) await quitPact(app)
      } finally {
        await fixture.dispose()
      }
    }
  },
)

test(
  'real-provider prechecks reject synthetic options.agy in real mode, missing PACT_E2E_AGY_AUTH_DIR without reading sentinel HOME, and unsafe Windows .cmd paths',
  { tag: '@deterministic' },
  async () => {
    await expect(createRuntimeFixture({ mode: 'real', agy: 'ready' })).rejects.toThrow(
      'A real E2E fixture cannot select synthetic CLI or protocol behavior.',
    )

    const scratchRoot = await mkdtemp(join(tmpdir(), 'pact-agy-precheck-'))
    const sentinelHome = join(scratchRoot, 'sentinel-host-home')
    const isolatedHome = join(scratchRoot, 'isolated-home')
    await mkdir(join(sentinelHome, '.gemini', 'antigravity-cli'), {
      recursive: true,
      mode: 0o700,
    })
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      await chmod(sentinelHome, 0o000)
    }
    try {
      expect(() =>
        requireExplicitAgyAuthDir({
          HOME: sentinelHome,
          USERPROFILE: sentinelHome,
        }),
      ).toThrow(/PACT_E2E_AGY_AUTH_DIR/u)

      await expect(
        copyIsolatedAgyAuthConfig(isolatedHome, {
          HOME: sentinelHome,
          USERPROFILE: sentinelHome,
        }),
      ).rejects.toThrow(/PACT_E2E_AGY_AUTH_DIR/u)

      const unsafePaths = [
        'C:\\Tools\\bad&calc\\agy.cmd',
        'C:\\Tools\\bad|pipe\\agy.cmd',
        'C:\\Tools\\bad%env%\\agy.cmd',
        'C:\\Tools\\bad!bang\\agy.cmd',
        'C:\\Tools\\bad"quote\\agy.cmd',
      ]
      for (const unsafePath of unsafePaths) {
        expect(isUnsafeWindowsCmdPath(unsafePath)).toBe(true)
      }
      await Promise.all(
        unsafePaths.map((unsafePath) =>
          expect(verifyAgyMinimumVersion(unsafePath, {}, 'win32')).rejects.toThrow(
            'Unsafe Windows native probe arguments',
          ),
        ),
      )
    } finally {
      if (process.platform !== 'win32') {
        await chmod(sentinelHome, 0o700).catch(() => undefined)
      }
      await rm(scratchRoot, { recursive: true, force: true })
    }
  },
)
