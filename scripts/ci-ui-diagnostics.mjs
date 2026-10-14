import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

import { publicReportIdentity, readE2EJson, writeE2EReport } from './e2e-report.mjs'
import { isScriptEntry } from './script-entry.mjs'

export const diagnosticLimits = Object.freeze({
  cases: 128,
  entriesPerCase: 8,
  files: 128,
  contextBytes: 256 * 1024,
  traceBytes: 16 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
})

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino
}

function contains(parent, child) {
  const local = relative(parent, child)
  return !local || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local))
}

async function unchangedDirectory(path, expected) {
  const actual = await lstat(path)
  if (!actual.isDirectory() || actual.isSymbolicLink() || !sameIdentity(actual, expected))
    throw new Error('UI diagnostic directory identity changed')
}

async function copyDiagnostic(source, target, limit) {
  const identity = await lstat(source)
  if (!identity.isFile() || identity.isSymbolicLink() || identity.size > limit)
    throw new Error('UI diagnostic is not a bounded regular file')
  const input = await open(
    source,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  )
  let output
  try {
    const initial = await input.stat()
    if (!initial.isFile() || !sameIdentity(initial, identity) || initial.size !== identity.size)
      throw new Error('UI diagnostic file identity changed before reading')
    output = await open(target, 'wx', 0o600)
    const buffer = Buffer.alloc(64 * 1024)
    const digest = createHash('sha256')
    let bytes = 0
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Copy the same bounded descriptor in order, including its EOF proof.
      const read = await input.read(buffer, 0, Math.min(buffer.length, limit - bytes + 1), bytes)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      if (bytes > limit) throw new Error('UI diagnostic grew beyond its byte bound')
      digest.update(buffer.subarray(0, read.bytesRead))
      let written = 0
      while (written < read.bytesRead) {
        // oxlint-disable-next-line no-await-in-loop -- Complete partial writes without recopying the source file or retrying an uncertain publication.
        const result = await output.write(buffer, written, read.bytesRead - written)
        if (!result.bytesWritten) throw new Error('UI diagnostic copy made no progress')
        written += result.bytesWritten
      }
    }
    const final = await input.stat()
    const current = await lstat(source)
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameIdentity(current, initial) ||
      !sameIdentity(final, initial) ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs ||
      bytes !== initial.size
    )
      throw new Error('UI diagnostic changed during copying')
    return { bytes, sha256: digest.digest('hex') }
  } finally {
    try {
      await input.close()
    } finally {
      await output?.close()
    }
  }
}

/** Collect only two named Playwright files from a no-credential executor. */
export async function collectUiDiagnostics(source, output) {
  if (
    !isAbsolute(source) ||
    !isAbsolute(output) ||
    basename(source) !== 'test-results' ||
    [source, output].some((path) => Buffer.byteLength(path) > 4096 || /[\r\n\0]/u.test(path)) ||
    contains(source, output) ||
    contains(output, source)
  )
    throw new Error('UI diagnostics need separate explicit source and output directories')
  // This directory is exclusively task-created. Existing evidence is never replaced.
  await mkdir(output, { mode: 0o700 })
  const records = []
  let totalBytes = 0
  let cases = 0
  let input
  try {
    let root
    try {
      root = await lstat(source)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await writeFile(join(output, 'inventory.json'), '{"files":[],"sourcePresent":false}\n', {
        flag: 'wx',
        mode: 0o600,
      })
      return { files: [], sourcePresent: false }
    }
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new Error('UI diagnostic root must be a regular directory')
    const canonical = await realpath(source)
    input = await opendir(source)
    let rootEntries = 0
    for await (const entry of input) {
      rootEntries++
      if (rootEntries > diagnosticLimits.cases + 8)
        throw new Error('UI diagnostic root exceeds its entry bound')
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.isSymbolicLink()) throw new Error('UI diagnostic directories cannot be symlinks')
      if (!/^[a-z\d._-]{1,160}$/iu.test(entry.name))
        throw new Error('UI diagnostic case name exceeds its path bound')
      cases++
      if (cases > diagnosticLimits.cases) throw new Error('UI diagnostics exceed their case bound')
      const directory = join(source, entry.name)
      const identity = await lstat(directory)
      if (
        !identity.isDirectory() ||
        identity.isSymbolicLink() ||
        (await realpath(directory)) !== join(canonical, entry.name)
      )
        throw new Error('UI diagnostic case escaped its source directory')
      const contents = await opendir(directory)
      let entries = 0
      for await (const file of contents) {
        entries++
        if (entries > diagnosticLimits.entriesPerCase)
          throw new Error('UI diagnostic case exceeds its entry bound')
        if (!['error-context.md', 'trace.zip'].includes(file.name)) continue
        if (!file.isFile() || file.isSymbolicLink())
          throw new Error('UI diagnostics cannot contain non-file sources')
        if (records.length >= diagnosticLimits.files)
          throw new Error('UI diagnostics exceed their file bound')
        const targetDirectory = join(output, entry.name)
        await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
        const copied = await copyDiagnostic(
          join(directory, file.name),
          join(targetDirectory, file.name),
          Math.min(
            file.name === 'trace.zip' ? diagnosticLimits.traceBytes : diagnosticLimits.contextBytes,
            diagnosticLimits.totalBytes - totalBytes,
          ),
        )
        totalBytes += copied.bytes
        records.push({ path: `${entry.name}/${file.name}`, ...copied })
      }
      await unchangedDirectory(directory, identity)
    }
    await unchangedDirectory(source, root)
    const inventory = { files: records, sourcePresent: true, totalBytes }
    await writeFile(join(output, 'inventory.json'), `${JSON.stringify(inventory)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    return inventory
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
}

function caseInventory(raw, lane, workspace) {
  if (!Array.isArray(raw?.suites)) throw new Error('Missing Playwright inventory')
  const items = new Map()
  let count = 0
  function visit(suite, depth = 0) {
    if (depth > 32) throw new Error('Playwright report nesting exceeds its bound')
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (++count > 256) throw new Error('Playwright report exceeds its case bound')
        if (test.projectName !== lane) continue
        const file = isAbsolute(spec.file) ? relative(workspace, spec.file) : spec.file
        const local = file.replaceAll('\\', '/')
        const path = local.startsWith('tests/e2e/') ? local : `tests/e2e/${local}`
        if (
          !/^tests\/e2e\/[a-z\d._-]+\.spec\.ts$/u.test(path) ||
          typeof spec.title !== 'string' ||
          !spec.title.length ||
          spec.title.length > 512 ||
          [...spec.title].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        )
          throw new Error('Invalid Playwright case identity')
        const key = JSON.stringify([path, spec.title])
        if (items.has(key)) throw new Error('Duplicate Playwright case identity')
        items.set(key, { path, title: spec.title, test })
      }
    }
    for (const child of suite.suites ?? []) visit(child, depth + 1)
  }
  for (const suite of raw.suites) visit(suite)
  return items
}

/** The no-credential report is informational; it never replaces the existing result gate. */
export function evaluateUiReport(
  raw,
  {
    lane,
    inventory,
    workspace,
    identity = null,
    execution = 'unavailable',
    platform = process.platform,
    architecture = process.arch,
  },
) {
  if (
    !['ui', 'deterministic'].includes(lane) ||
    !isAbsolute(workspace) ||
    !['completed', 'unavailable'].includes(execution) ||
    !['darwin-arm64', 'win32-x64', 'win32-arm64'].includes(`${platform}-${architecture}`)
  )
    throw new Error('Invalid no-credential report target')
  const issues = []
  let known = new Map(),
    observed = new Map(),
    publicIdentity = null
  try {
    known = caseInventory(inventory, lane, workspace)
    if (!known.size) throw new Error('Empty inventory')
  } catch {
    issues.push('missing-or-invalid-discovery-inventory')
  }
  try {
    observed = caseInventory(raw, lane, workspace)
    if (raw.errors?.length) issues.push('playwright-global-error')
  } catch {
    issues.push('missing-or-invalid-execution-evidence')
  }
  try {
    publicIdentity = publicReportIdentity(identity)
    if (!publicIdentity) issues.push('missing-or-invalid-ci-code-identity')
  } catch {
    issues.push('missing-or-invalid-ci-code-identity')
  }
  if (execution !== 'completed') issues.push('runner-or-preparation-failed')
  const cases = [...known].map(([key, item]) => {
    const result = observed.get(key)?.test
    let status = 'not-run',
      durationMs = 0,
      failureCategory = 'missing-result'
    const results = result?.results ?? []
    if (
      results.length === 1 &&
      ['passed', 'failed', 'timedOut', 'interrupted', 'skipped'].includes(results[0].status)
    ) {
      status = results[0].status
      if (
        status === 'passed' &&
        (result.expectedStatus !== 'passed' || result.status !== 'expected')
      )
        status = 'failed'
      const duration = results[0].duration
      if (Number.isFinite(duration) && duration >= 0 && duration <= 2 * 60 * 60_000)
        durationMs = duration
      else issues.push('invalid-case-duration')
      failureCategory = {
        passed: 'none',
        failed: 'case-failed',
        timedOut: 'case-timeout',
        interrupted: 'execution-interrupted',
        skipped: 'case-skipped',
      }[status]
    } else if (result) {
      failureCategory = 'invalid-evidence'
      issues.push('missing-result-or-retries')
    }
    const applicable = !(
      lane === 'ui' &&
      item.path === 'tests/e2e/appearance.spec.ts' &&
      item.title === 'Windows keeps page Alpha and native controls while Solid remains opaque' &&
      platform !== 'win32'
    )
    if (!applicable && ['not-run', 'skipped'].includes(status)) {
      status = 'not-applicable'
      failureCategory = 'other-platform'
    }
    return {
      path: item.path,
      title: item.title,
      tier: 'mandatory',
      required: applicable,
      applicable,
      status,
      durationMs,
      failureCategory,
    }
  })
  let unknown = 0
  for (const [key, item] of observed) {
    if (known.has(key)) continue
    unknown++
    const result = item.test.results?.[0]
    cases.push({
      path: null,
      title: `Unclassified case ${unknown}`,
      tier: 'mandatory',
      required: true,
      status: 'invalid-evidence',
      durationMs: 0,
      failureCategory: 'unclassified-case',
      // Unknown candidate-controlled names/output are never used in a public failure report.
      observedResult: ['passed', 'failed', 'timedOut', 'interrupted', 'skipped'].includes(
        result?.status,
      )
        ? result.status
        : 'not-run',
    })
  }
  if (unknown) issues.push('case-absent-from-discovery-inventory')
  const counts = Object.fromEntries(
    [
      'passed',
      'failed',
      'timedOut',
      'interrupted',
      'skipped',
      'not-run',
      'not-applicable',
      'invalid-evidence',
    ].map((status) => [status, cases.filter((item) => item.status === status).length]),
  )
  return {
    schemaVersion: 1,
    lane,
    informational: true,
    identity: publicIdentity,
    platform,
    architecture,
    execution,
    issues: [...new Set(issues)],
    counts,
    cases,
    diagnosticArtifact: `ui-diagnostics-${platform}-${architecture}`,
    resultGate:
      'The existing immutable coverage/result gate remains authoritative. This report never grants a passing check.',
  }
}

const markdownCell = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replaceAll('`', '\\`')

export function uiReportMarkdown(report) {
  const lines = [
    `# ${report.lane === 'ui' ? 'Electron UI' : 'Deterministic Electron'} E2E`,
    '',
    `Platform: ${report.platform}/${report.architecture}; execution: **${report.execution}**.`,
    report.resultGate,
  ]
  if (report.identity)
    lines.push(
      `PR: ${report.identity.pullRequest}; head: \`${report.identity.headSha}\`; base: \`${report.identity.baseSha}\`; tree: \`${report.identity.treeSha}\`; tested commit: \`${report.identity.candidateSha}\`.`,
    )
  else lines.push('Code identity is unavailable; this report cannot attest current CI execution.')
  if (report.issues.length) lines.push(`Evidence problems: ${report.issues.join(', ')}.`)
  if (report.reportFiles) {
    lines.push(
      '',
      `Report files: \`${report.reportFiles.json}\`, \`${report.reportFiles.markdown}\`.`,
    )
    if (report.reportFiles.artifactName)
      lines.push(`Actions artifact: **${report.reportFiles.artifactName}**, retained for 14 days.`)
    if (report.reportFiles.localDirectory)
      lines.push(`Persistent local report: \`${report.reportFiles.localDirectory}\`.`)
  }
  lines.push(
    `Failure snapshots/traces, when collection succeeded: **${report.diagnosticArtifact}**, retained for 14 days. Only the no-credential lane may publish these diagnostics.`,
    '',
    '| Case | Required | Result | Duration (s) | Failure category |',
    '| --- | --- | --- | ---: | --- |',
  )
  for (const item of report.cases)
    lines.push(
      `| ${markdownCell(item.title)} | ${item.required ? 'yes' : 'no'} | ${item.status} | ${(item.durationMs / 1000).toFixed(2)} | ${item.failureCategory} |`,
    )
  return `${lines.join('\n')}\n`
}

export async function writeUiReports({
  evidence,
  workspace,
  identityPath,
  inventoryPath,
  summary,
  execution = {},
  platform = process.platform,
  architecture = process.arch,
}) {
  let identity = null,
    inventory = null
  try {
    identity = await readE2EJson(identityPath, 4096)
  } catch {
    /* Fixed safe issue is projected below. */
  }
  try {
    inventory = await readE2EJson(inventoryPath)
  } catch {
    /* Missing inventory cannot fabricate results. */
  }
  const reports = []
  for (const lane of ['ui', 'deterministic']) {
    let raw = null
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Read and retain each independent native lane even when the other lane failed early.
      raw = await readE2EJson(join(evidence, `${lane}.json`))
    } catch {
      /* Safe failure report still includes every discovered case. */
    }
    const report = evaluateUiReport(raw, {
      lane,
      inventory,
      workspace,
      identity,
      execution: execution[lane] ?? 'unavailable',
      platform,
      architecture,
    })
    reports.push(
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each lane has immutable distinct files and the shared Actions summary preserves their order.
      await writeE2EReport(report, {
        directory: evidence,
        basename: `${lane}-summary`,
        markdown: uiReportMarkdown,
        summary,
        workspace,
        artifactName: `e2e-${platform}-${architecture}`,
      }),
    )
  }
  return reports
}

export async function main(argv = process.argv.slice(2), source = process.env) {
  if (argv[0] === '--reports') {
    if (
      argv.length !== 9 ||
      argv[1] !== '--evidence' ||
      argv[3] !== '--workspace' ||
      argv[5] !== '--identity' ||
      argv[7] !== '--inventory' ||
      source.GITHUB_ACTIONS !== 'true' ||
      source.PACT_CI_DIAGNOSTIC_LANE !== 'uncredentialed'
    )
      throw new Error('UI reports require the explicit no-credential CI lane')
    const reports = await writeUiReports({
      evidence: argv[2],
      workspace: argv[4],
      identityPath: argv[6],
      inventoryPath: argv[8],
      summary: source.GITHUB_STEP_SUMMARY,
      execution: {
        ui: source.PACT_UI_EXECUTION_COMPLETED === 'true' ? 'completed' : 'unavailable',
        deterministic:
          source.PACT_DETERMINISTIC_EXECUTION_COMPLETED === 'true' ? 'completed' : 'unavailable',
      },
    })
    for (const report of reports)
      console.log(
        `Safe ${report.report.lane} E2E report: ${report.report.reportFiles.localDirectory}/${report.report.reportFiles.markdown}`,
      )
    return
  }
  if (
    argv.length !== 4 ||
    argv[0] !== '--source' ||
    argv[2] !== '--output' ||
    source.GITHUB_ACTIONS !== 'true' ||
    source.PACT_CI_DIAGNOSTIC_LANE !== 'uncredentialed'
  )
    throw new Error('UI diagnostics require the explicit no-credential CI lane')
  const report = await collectUiDiagnostics(argv[1], argv[3])
  console.log(JSON.stringify({ files: report.files.length, bytes: report.totalBytes ?? 0 }))
}

if (isScriptEntry(import.meta.url)) {
  try {
    await main()
  } catch {
    console.error('Bounded no-credential UI diagnostics could not be collected')
    process.exitCode = 1
  }
}
