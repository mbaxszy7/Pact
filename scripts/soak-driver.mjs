/* oxlint-disable eslint/no-await-in-loop -- One owner sequences bounded launch observation, genuine UI operations and physical cleanup; overlapping them changes the workload and ownership proof. */
/* oxlint-disable unicorn/consistent-function-scoping -- Browser-serialized callbacks must define their measurement helpers in the Renderer realm. */

import { chromium } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { PactDatabase } from '../packages/persistence/src/index.ts'
import { conversationMessages } from '../packages/persistence/src/schema/index.ts'
import { prepareDeterministicSoakEnvironment } from '../tests/e2e/runtime-fixture.ts'
import { ciEnvironment } from './ci.mjs'
import { run } from './run-e2e.mjs'
import {
  histogram,
  observe,
  validateReceipt,
  resourceReportProjection,
} from './soak-statistics.mjs'

const exec = promisify(execFile)
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const migrationsFolder = resolve(import.meta.dirname, '../packages/persistence/drizzle')

async function boundedJson(path, limit = 4096) {
  const descriptor = await open(
    path,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  )
  try {
    const info = await descriptor.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Unsafe private observation record')
    const buffer = Buffer.alloc(limit + 1),
      { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0)
    if (bytesRead > limit) throw new Error('Private observation record grew beyond its bound')
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await descriptor.close()
  }
}

async function availablePort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback CDP port available')
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())))
  return address.port
}

async function seed(root, environment) {
  const database = await PactDatabase.open({
    filePath: join(root, 'pact.sqlite'),
    migrationsFolder,
  })
  const projectId = randomUUID(),
    sessionIds = [randomUUID(), randomUUID()],
    createdAt = new Date().toISOString()
  const directory = join(root, 'benchmark-project')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(directory, { mode: 0o700 })
  await Promise.all([
    writeFile(join(directory, 'soak.json'), '{"name":"isolated benchmark","enabled":true}\n'),
    writeFile(join(directory, 'soak.ts'), 'export const fixture = true\n'.repeat(1000)),
  ])
  try {
    database.runtimePreparationRepository.saveSelectedExecutablePath(
      'claude',
      environment.claudePath,
    )
    database.runtimePreparationRepository.saveSelectedExecutablePath('codex', environment.codexPath)
    const settings = {
      primaryAgentId: 'codex',
      agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
      maxDiscussionRounds: 6,
      runningMessagePolicy: 'immediate_safe_point',
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    }
    database.defaultSessionSettingsRepository.save(settings)
    database.projectCatalogRepository.add({
      id: projectId,
      name: 'Soak fixture',
      directoryPath: directory,
      kind: 'directory',
      createdAt,
    })
    for (let index = 0; index < 2; index++) {
      const id = sessionIds[index],
        title = `Soak Session ${index + 1}`
      database.sessionRepository.create({ id, projectId, title, createdAt }, settings)
      database.sessionRepository.rename(id, title)
      const messages = Array.from({ length: 1000 }, (_, sequence) => ({
        id: randomUUID(),
        sessionId: id,
        role: sequence % 2 === 0 ? 'user' : 'assistant',
        ...(sequence % 2 === 1 ? { agentId: 'codex' } : {}),
        content: `Retained deterministic fixture ${sequence}\n\nNo user conversation or paid generation.${sequence === 999 ? '\n\n[soak.json](soak.json) · [soak.ts](soak.ts)' : ''}`,
        contentRevision: 0,
        state: 'complete',
        sequence,
        createdAt,
        updatedAt: createdAt,
      }))
      database.drizzle.transaction((transaction) => {
        for (let offset = 0; offset < messages.length; offset += 50)
          transaction
            .insert(conversationMessages)
            .values(messages.slice(offset, offset + 50))
            .run()
      })
    }
  } finally {
    database.close()
  }
  return { sessionIds, projectId }
}

async function stopReceipt(receiptFile, nonce, mainPid) {
  const temporary = `${receiptFile}.stop-${randomUUID()}`
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, nonce, mainPid }), {
      flag: 'wx',
      mode: 0o600,
    })
    await link(temporary, `${receiptFile}.stop`)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function connectTarget(port, receipt, deadline, observeDiscovery) {
  let browser
  while (performance.now() < deadline) {
    const discovery = { stage: 'version-response' }
    try {
      // No URI/token reaches stdout, exceptions or public reports.
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
        redirect: 'error',
      })
      discovery.httpStatus = response.status
      const bytes = await response.arrayBuffer()
      if (bytes.byteLength > 4096) throw new Error('CDP discovery exceeds its byte bound')
      const url = new URL(JSON.parse(Buffer.from(bytes).toString('utf8')).webSocketDebuggerUrl)
      discovery.stage = 'version-url'
      if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port)
        throw new Error('CDP endpoint is outside the proved loopback listener')
      discovery.stage = 'connect-browser'
      browser = await chromium.connectOverCDP(url.href, {
        timeout: Math.min(5000, Math.max(1, deadline - performance.now())),
      })
      discovery.stage = 'page-enumeration'
      const pages = browser.contexts().flatMap((context) => context.pages())
      discovery.pageCount = pages.length
      if (pages.length > 16) throw new Error('Soak renderer target capacity exceeded')
      for (const page of pages) {
        discovery.stage = 'target-session'
        const session = await page.context().newCDPSession(page)
        try {
          discovery.stage = 'target-info'
          const { targetInfo } = await session.send('Target.getTargetInfo')
          discovery.targetMatch = targetInfo.targetId === receipt.targetId
          discovery.urlMatch = page.url() === receipt.url
          if (targetInfo.targetId === receipt.targetId && page.url() === receipt.url)
            return { browser, page }
        } finally {
          await session.detach()
        }
      }
      throw new Error('Owned renderer target was not found')
    } catch (error) {
      discovery.errorClass = ['TypeError', 'Error', 'TimeoutError', 'SyntaxError'].includes(
        error.name,
      )
        ? error.name
        : 'unknown'
      const protocol = /^Protocol error \(([A-Za-z]+\.[A-Za-z]+)\)/u.exec(error.message)
      if (protocol) discovery.protocolMethod = protocol[1]
      observeDiscovery(discovery)
      await browser?.close().catch(() => undefined)
      await pause(100)
    }
  }
  throw new Error('The exact owned CDP target could not be admitted before startup deadline')
}

async function instrument(page) {
  await page.evaluate(() => {
    const make = () => ({ bins: Array.from({ length: 1001 }, () => 0), count: 0, maximum: 0 })
    const record = (target, value) => {
      if (!Number.isFinite(value) || value < 0 || target.count >= 1_000_000)
        throw new Error('Renderer sample bound exceeded')
      target.bins[Math.min(1000, Math.ceil(value))]++
      target.count++
      target.maximum = Math.max(target.maximum, value)
    }
    const state = {
      inputPaint: make(),
      rendererEventLoop: make(),
      frames: make(),
      terminalEnabledAt: [],
      ipcBytes: 0,
      sustainedLongTasks: 0,
      unexplainedLongTasksOver200Ms: 0,
      lastLongTask: -Infinity,
      repeatedLongTasks: 0,
      raf: 0,
      timer: 0,
      stopped: false,
    }
    const endedTurns = new Set()
    const composer = () => document.querySelector('[role="combobox"][aria-label="Message"]')
    const input = (event) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[role="combobox"][aria-label="Message"]')
      )
        return
      const at = performance.now()
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!state.stopped) record(state.inputPaint, performance.now() - at)
        }),
      )
    }
    // Composer handles and prevents native beforeinput; its genuine event is the
    // start of input-to-paint even when no subsequent DOM input event is emitted.
    document.addEventListener('beforeinput', input, true)
    let lastFrame = performance.now()
    const frame = (at) => {
      record(state.frames, at - lastFrame)
      lastFrame = at
      state.raf = requestAnimationFrame(frame)
    }
    state.raf = requestAnimationFrame(frame)
    let expected = performance.now() + 100
    const tick = () => {
      const now = performance.now()
      record(state.rendererEventLoop, Math.max(0, now - expected))
      expected = now + 100
      state.timer = setTimeout(tick, 100)
    }
    state.timer = setTimeout(tick, 100)
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 200) state.unexplainedLongTasksOver200Ms++
        if (entry.duration <= 50) continue
        state.repeatedLongTasks =
          entry.startTime - state.lastLongTask < 1000 ? state.repeatedLongTasks + 1 : 1
        state.lastLongTask = entry.startTime
        if (state.repeatedLongTasks >= 3) state.sustainedLongTasks++
      }
    })
    observer.observe({ type: 'longtask', buffered: false })
    const remove = globalThis.pact.onConversationChanged((patch) => {
      state.ipcBytes += new TextEncoder().encode(JSON.stringify(patch)).byteLength
      for (const execution of patch.runs) {
        if (
          !['completed', 'failed', 'interrupted'].includes(execution.status) ||
          !execution.nativeTurnId ||
          !execution.nativeSessionId
        )
          continue
        const key = `${execution.nativeSessionId}/${execution.nativeTurnId}`
        if (endedTurns.has(key)) continue
        if (endedTurns.size >= 128) throw new Error('Native terminal identity capacity exceeded')
        endedTurns.add(key)
        const settle = () => {
          if (state.stopped) return
          const element = composer()
          if (
            element &&
            element.isContentEditable &&
            element.getAttribute('aria-disabled') !== 'true'
          ) {
            if (state.terminalEnabledAt.length >= 256)
              throw new Error('Terminal observation capacity exceeded')
            state.terminalEnabledAt.push({
              threadId: execution.nativeSessionId,
              turnId: execution.nativeTurnId,
              enabledAt: Date.now(),
            })
          } else requestAnimationFrame(settle)
        }
        requestAnimationFrame(settle)
      }
    })
    Reflect.set(globalThis, '__pactSoak', {
      state,
      stop: () => {
        state.stopped = true
        cancelAnimationFrame(state.raf)
        clearTimeout(state.timer)
        observer.disconnect()
        document.removeEventListener('beforeinput', input, true)
        remove()
      },
    })
  })
}

async function resourceSample(browser) {
  const session = await browser.newBrowserCDPSession()
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo')
    if (
      !Array.isArray(processInfo) ||
      processInfo.length < 1 ||
      processInfo.length > 256 ||
      processInfo.some(
        (item) => !Number.isSafeInteger(item.id) || item.id < 1 || !Number.isFinite(item.cpuTime),
      )
    )
      throw new Error('Invalid browser process observation')
    const ids = processInfo.map((item) => item.id)
    let rss
    if (process.platform === 'darwin') {
      const { stdout } = await exec('/bin/ps', ['-p', ids.join(','), '-o', 'pid=,rss='], {
        shell: false,
        timeout: 1000,
        maxBuffer: 16 * 1024,
      })
      rss = stdout
        .trim()
        .split('\n')
        .map((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line)
          if (!match) throw new Error('Invalid RSS observation')
          return { pid: Number(match[1]), rssBytes: Number(match[2]) * 1024 }
        })
    } else {
      const { stdout } = await exec(
        process.env.PACT_E2E_POWERSHELL_EXECUTABLE ?? 'pwsh.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `@(Get-Process -Id ${ids.join(',')} -ErrorAction Stop | Select-Object Id,WorkingSet64) | ConvertTo-Json -Compress`,
        ],
        { shell: false, timeout: 1000, maxBuffer: 16 * 1024, windowsHide: true },
      )
      const rows = JSON.parse(stdout)
      rss = (Array.isArray(rows) ? rows : [rows]).map((row) => ({
        pid: row.Id,
        rssBytes: row.WorkingSet64,
      }))
    }
    if (
      rss.length !== ids.length ||
      rss.some(
        (row) => !ids.includes(row.pid) || !Number.isFinite(row.rssBytes) || row.rssBytes < 0,
      )
    )
      throw new Error('Incomplete RSS observation')
    return processInfo.map((item) => ({
      pid: item.id,
      type: item.type,
      cpuSeconds: item.cpuTime,
      rssBytes: rss.find((row) => row.pid === item.id).rssBytes,
    }))
  } finally {
    await session.detach()
  }
}

async function main() {
  const settings = await boundedJson(process.argv[2], 16 * 1024)
  if (
    settings.schemaVersion !== 1 ||
    !Number.isSafeInteger(settings.durationMs) ||
    settings.durationMs < 1000 ||
    settings.durationMs > 7_200_000
  )
    throw new Error('Invalid driver duration')
  const environment = await prepareDeterministicSoakEnvironment(
    settings.dataRoot,
    ciEnvironment(process.env),
  )
  settings.dataRoot = await realpath(settings.dataRoot)
  const seeded = await seed(settings.dataRoot, environment)
  const resourceProjection = resourceReportProjection()
  const evidence = {
    durationMs: 0,
    retainedMessages: 1000,
    terminalEnable: histogram(),
    utilityEventLoopLagP95Ms: null,
    cleanupVerified: false,
    recoveryVerified: false,
    resourceLifecycleVerified: false,
    missingObservations: [
      'react-commit-counts',
      'all-owner-timer-listener-model-reservations',
      'ten-times-inactive-history-comparison',
      'complete-ipc-traffic',
    ],
    resourceSamples: [],
    sqliteQueryPlanDictionary: resourceProjection.queryPlans,
    resourceHighWater: {},
    resourceFinal: {},
    conversationPatchIpcBytes: 0,
  }
  let iteration = 0,
    lastState,
    ownedHighWater = 0,
    failure,
    lastTurnSession = 0,
    measurementStarted,
    stage = 'launch'
  const receiptFile = join(settings.dataRoot, 'soak-receipt.json')
  const launch = async () => {
    const nonce = randomBytes(32).toString('hex'),
      port = await availablePort(),
      abort = new AbortController()
    const appEnvironment = {
      ...environment.env,
      PACT_E2E_ROOT: settings.dataRoot,
      PACT_SOAK_NONCE: nonce,
      PACT_SOAK_CDP_PORT: String(port),
      PACT_SOAK_RECEIPT_FILE: receiptFile,
    }
    const completion = run([], settings.durationMs + 5 * 60_000, {
      executable: settings.executable,
      cwd: settings.dataRoot,
      env: appEnvironment,
      signal: abort.signal,
      write: async () => {},
      onState: (state) => {
        lastState = state
        ownedHighWater = Math.max(ownedHighWater, state.ownedProcessCount)
      },
    })
    void completion.catch(() => undefined)
    let receipt, connection
    try {
      stage = 'main-receipt'
      const deadline = performance.now() + 30_000
      while (performance.now() < deadline) {
        try {
          receipt = await boundedJson(receiptFile)
          break
        } catch (error) {
          if (!['ENOENT', 'SyntaxError'].includes(error.code ?? error.name)) throw error
        }
        await pause(100)
      }
      if (!receipt || !lastState?.pid) throw new Error('Missing Main ownership receipt')
      validateReceipt(receipt, { nonce, mainPid: lastState.pid, port, manifest: settings.manifest })
      stage = 'exact-cdp-target'
      connection = await connectTarget(port, receipt, deadline, (discovery) => {
        evidence.cdpDiscovery = discovery
      })
      stage = 'registered-bridge-identity'
      const info = await connection.page.evaluate(() => globalThis.pact.getAppInfo())
      if (
        !info.ok ||
        !info.value.packaged ||
        info.value.version !== settings.manifest.version ||
        info.value.platform !== settings.manifest.platform ||
        info.value.arch !== settings.manifest.arch
      )
        throw new Error('Actual registered Bridge package identity mismatch')
      return { ...connection, receipt, nonce, completion, abort }
    } catch {
      abort.abort()
      await connection?.browser.close().catch(() => undefined)
      await completion.catch(() => undefined)
      throw new Error('Packaged application launch/receipt/target admission failed')
    }
  }
  let active
  try {
    active = await launch()
    const { page, browser } = active
    stage = 'select-session'
    await page
      .getByRole('button', { name: 'Soak Session 1', exact: true })
      .click({ timeout: 15_000 })
    await page.getByRole('combobox', { name: 'Message', exact: true }).waitFor({ state: 'visible' })
    await instrument(page)
    const started = performance.now()
    measurementStarted = started
    let nextTurn = started
    while (performance.now() - started < settings.durationMs) {
      stage = 'session-switch'
      const index = iteration % 2
      await page.getByRole('button', { name: `Soak Session ${index + 1}`, exact: true }).click()
      const composer = page.getByRole('combobox', { name: 'Message', exact: true })
      stage = 'composer-input'
      await composer.click()
      await composer.press('ControlOrMeta+A')
      await page.keyboard.insertText(`Deterministic soak cycle ${iteration}`)
      if (performance.now() >= nextTurn) {
        stage = 'deterministic-turn'
        lastTurnSession = index
        const before = await page.evaluate(async (sessionId) => {
          const result = await globalThis.pact.getConversation({ sessionId, scope: 'messages' })
          if (!result.ok || result.value.scope !== 'messages')
            throw new Error('Current conversation could not be read')
          return result.value.header.latestRun?.id ?? null
        }, seeded.sessionIds[index])
        await composer.press('Enter')
        nextTurn = performance.now() + 60_000
        await page.waitForFunction(
          async ({ sessionId, priorRunId }) => {
            const result = await globalThis.pact.getConversation({ sessionId, scope: 'messages' })
            return (
              result.ok &&
              result.value.scope === 'messages' &&
              result.value.header.latestRun?.id !== priorRunId &&
              result.value.header.latestRun?.status === 'completed'
            )
          },
          { sessionId: seeded.sessionIds[index], priorRunId: before },
          { timeout: 15_000 },
        )
      } else {
        await composer.fill('')
      }
      const file = iteration % 2 === 0 ? 'soak.json' : 'soak.ts'
      stage = 'file-preview'
      await page.getByRole('button', { name: file, exact: true }).last().click({ timeout: 15_000 })
      await page
        .locator('.monaco-editor .view-line')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
      await page.getByRole('button', { name: 'Close file preview' }).click()
      if (iteration % 6 === 0) {
        stage = 'resource-health'
        const health = await page.evaluate(() => globalThis.pact.getRuntimeHealth())
        if (!health.ok || !health.value.conversation)
          throw new Error('Real Utility health observation is missing')
        for (const [key, value] of Object.entries(health.value.conversation))
          if (Number.isFinite(value))
            evidence.resourceHighWater[key] = Math.max(evidence.resourceHighWater[key] ?? 0, value)
        const performanceHealth = health.value.performance
        if (Number.isFinite(performanceHealth?.eventLoopLagP95Ms))
          evidence.utilityEventLoopLagP95Ms = Math.max(
            evidence.utilityEventLoopLagP95Ms ?? 0,
            performanceHealth.eventLoopLagP95Ms,
          )
        if (
          !performanceHealth ||
          performanceHealth.resourceCapacityExceeded ||
          performanceHealth.sqlite?.planOverflow ||
          performanceHealth.sqlite?.unsupportedOperations > 0
        ) {
          if (!evidence.missingObservations.includes('complete-utility-and-sqlite-observation'))
            evidence.missingObservations.push('complete-utility-and-sqlite-observation')
        }
        if (evidence.resourceSamples.length >= 256)
          throw new Error('Resource snapshot capacity exceeded')
        let processes
        try {
          processes = await resourceSample(browser)
        } catch {
          if (!evidence.missingObservations.includes('per-process-rss-cpu'))
            evidence.missingObservations.push('per-process-rss-cpu')
        }
        evidence.resourceSamples.push({
          elapsedMs: Math.floor(performance.now() - started),
          ...(processes ? { processes } : {}),
          conversation: health.value.conversation,
          ...(performanceHealth ? { utility: resourceProjection.project(performanceHealth) } : {}),
        })
      }
      iteration++
      await pause(Math.min(5000, Math.max(1, settings.durationMs - (performance.now() - started))))
    }
    evidence.durationMs = Math.floor(performance.now() - started)
    stage = 'renderer-and-native-observations'
    const renderer = await page.evaluate(() => {
      const value = Reflect.get(globalThis, '__pactSoak')
      value.stop()
      return value.state
    })
    Object.assign(evidence, {
      inputPaint: renderer.inputPaint,
      rendererEventLoop: renderer.rendererEventLoop,
      frameIntervals: renderer.frames,
      sustainedLongTasks: renderer.sustainedLongTasks,
      unexplainedLongTasksOver200Ms: renderer.unexplainedLongTasksOver200Ms,
      conversationPatchIpcBytes: renderer.ipcBytes,
      conversationPatchIpcBytesPerSecond: renderer.ipcBytes / (evidence.durationMs / 1000),
    })
    const terminalPath = join(settings.dataRoot, 'soak-native-terminals.jsonl'),
      info = await lstat(terminalPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024)
      throw new Error('Native terminal facts exceed their bound')
    const nativeTerminals = (await readFile(terminalPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    if (nativeTerminals.length > 128)
      throw new Error('Native terminal sample count exceeds its bound')
    for (const terminal of nativeTerminals) {
      const enabled = renderer.terminalEnabledAt.find(
        (row) => row.turnId === terminal.turnId && row.threadId === terminal.threadId,
      )
      if (enabled) observe(evidence.terminalEnable, enabled.enabledAt - terminal.terminalAt)
    }
    const final = await page.evaluate(() => globalThis.pact.getRuntimeHealth())
    if (!final.ok) throw new Error('Final Utility health is missing')
    evidence.resourceFinal = final.value.conversation ?? {}
    if (!final.value.performance || final.value.performance.eventLoopSamples < 100)
      evidence.missingObservations.push('complete-utility-event-loop-sampling')
    if (!final.value.performance?.sqlite?.queryPlans?.length)
      evidence.missingObservations.push('representative-sqlite-query-plans')
    const recoveryPage = async (currentPage) =>
      currentPage.evaluate(async (sessionId) => {
        const result = await globalThis.pact.getConversation({ sessionId, scope: 'messages' })
        if (
          !result.ok ||
          result.value.scope !== 'messages' ||
          result.value.header.latestRun?.status !== 'completed'
        )
          throw new Error('Missing durable terminal Run')
        return {
          runId: result.value.header.latestRun.id,
          nativeSessionId: result.value.header.latestRun.nativeSessionId,
          nativeTurnId: result.value.header.latestRun.nativeTurnId,
          messages: result.value.messages.map((row) => ({
            id: row.message.id,
            state: row.message.state,
            contentRevision: row.message.contentRevision,
            content: row.kind === 'complete' ? row.message.content : row.preview,
          })),
        }
      }, seeded.sessionIds[lastTurnSession])
    const beforeRecovery = await recoveryPage(page)
    const durableHash = createHash('sha256').update(JSON.stringify(beforeRecovery)).digest('hex')
    stage = 'first-shutdown'
    await stopReceipt(receiptFile, active.nonce, active.receipt.mainPid)
    const firstCode = await active.completion
    await browser.close().catch(() => undefined)
    if (firstCode !== 0 || !lastState?.groupGone || lastState.ownedProcessCount !== 0)
      throw new Error('First packaged process tree did not release naturally')
    await Promise.all([rm(receiptFile), rm(`${receiptFile}.stop`)])
    active = await launch()
    stage = 'cold-restart'
    await active.page
      .getByRole('button', { name: `Soak Session ${lastTurnSession + 1}`, exact: true })
      .click({ timeout: 15_000 })
    const afterRecovery = await recoveryPage(active.page)
    const coldHash = createHash('sha256').update(JSON.stringify(afterRecovery)).digest('hex')
    await active.page
      .getByText('Bounded lifecycle response.', { exact: true })
      .last()
      .waitFor({ state: 'visible', timeout: 15_000 })
    evidence.recoveryVerified = coldHash === durableHash
    evidence.recovery = {
      beforeHash: durableHash,
      afterHash: coldHash,
      latestRunId: beforeRecovery.runId,
      nativeSessionId: beforeRecovery.nativeSessionId,
      nativeTurnId: beforeRecovery.nativeTurnId,
      changed: ['runId', 'nativeSessionId', 'nativeTurnId', 'messages'].filter(
        (key) => JSON.stringify(beforeRecovery[key]) !== JSON.stringify(afterRecovery[key]),
      ),
    }
    stage = 'final-shutdown'
    await stopReceipt(receiptFile, active.nonce, active.receipt.mainPid)
    const finalCode = await active.completion
    await active.browser.close().catch(() => undefined)
    evidence.cleanupVerified =
      finalCode === 0 && lastState?.groupGone === true && lastState.ownedProcessCount === 0
    evidence.ownedProcessHighWater = ownedHighWater
    evidence.ownedProcessFinal = lastState?.ownedProcessCount ?? null
  } catch {
    if (measurementStarted !== undefined)
      evidence.durationMs = Math.floor(performance.now() - measurementStarted)
    failure = 'Continuous packaged workload or recovery observation failed'
    evidence.failureStage = stage
    if (active?.page) {
      try {
        evidence.rendererFailureState = await active.page.evaluate(() => {
          const panel = document.querySelector('#project-file-title')?.closest('section')
          return {
            previewMounted: Boolean(panel),
            previewUnavailable: Boolean(panel?.querySelector('[role="alert"]')),
            monacoEditors: panel?.querySelectorAll('.monaco-editor').length ?? 0,
            monacoRows: panel?.querySelectorAll('.view-line').length ?? 0,
            plainEditors: panel?.querySelectorAll('textarea').length ?? 0,
            composerEnabled:
              document
                .querySelector('[role="combobox"][aria-label="Message"]')
                ?.getAttribute('contenteditable') === 'true',
          }
        })
      } catch {
        /* No raw page/connection failure text may expose the CDP capability. */
      }
    }
  } finally {
    if (active && !lastState?.groupGone) {
      try {
        await stopReceipt(receiptFile, active.nonce, active.receipt.mainPid)
      } catch {
        active.abort.abort()
      }
      await active.completion.catch(() => undefined)
    }
    await active?.browser.close().catch(() => undefined)
    evidence.cleanupVerified = lastState?.groupGone === true && lastState.ownedProcessCount === 0
    evidence.ownedProcessHighWater = ownedHighWater
    evidence.ownedProcessFinal = lastState?.ownedProcessCount ?? null
    if (failure) evidence.failure = failure
    // No claim about unobserved product timers/listeners/retained objects is made.
    if (Buffer.byteLength(JSON.stringify(evidence)) > 768 * 1024) {
      failure = 'Continuous observation report exceeded its byte bound'
      evidence.failure = failure
      evidence.resourceSamples = []
      evidence.missingObservations.push('resource-snapshot-byte-overflow')
    }
    await writeFile(settings.observation, JSON.stringify(evidence), { flag: 'wx', mode: 0o600 })
  }
  if (failure) process.exitCode = 1
}

main().catch(() => {
  console.error('The bounded continuous soak driver failed.')
  process.exitCode = 1
})
