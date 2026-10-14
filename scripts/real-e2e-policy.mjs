import { createHash } from 'node:crypto'
import { open, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, join } from 'node:path'

import { requireIdentity } from './ci-identity.mjs'
import { isScriptEntry } from './script-entry.mjs'

// Exact business cases, independent of a candidate's mutable tags or test outcome.
export const realCases = [
  {
    path: 'tests/e2e/anchored-comments.spec.ts',
    title: 'persists a Message Comment draft and restores its Composer chip after restart',
    tier: 'extended',
    scenario: 'comment-variants',
  },
  {
    path: 'tests/e2e/anchored-comments.spec.ts',
    title:
      'preserves an eleven-Comment draft bundle across restart without the retired ten-item limit',
    tier: 'extended',
    scenario: 'comment-variants',
  },
  {
    path: 'tests/e2e/appearance.spec.ts',
    title: 'previews and persists global Appearance settings across a real restart',
    tier: 'extended',
    scenario: 'appearance',
  },
  {
    path: 'tests/e2e/appearance.spec.ts',
    title: 'restores the last committed appearance when a save fails',
    tier: 'extended',
    scenario: 'appearance',
  },
  {
    path: 'tests/e2e/appearance.spec.ts',
    title: 'macOS page Alpha follows transparency strength while Solid stays opaque',
    tier: 'extended',
    platforms: ['darwin'],
    scenario: 'appearance',
  },
  {
    path: 'tests/e2e/collaboration-result-real.spec.ts',
    title: 'real codex submits a required plan in its first authorized root Turn @real',
    tier: 'core',
    scenario: 'collaboration',
  },
  {
    path: 'tests/e2e/collaboration-result-real.spec.ts',
    title: 'real claude submits a required plan in its first authorized root Turn @real',
    tier: 'core',
    scenario: 'collaboration',
  },
  {
    path: 'tests/e2e/conversation-history-performance.spec.ts',
    title: 'opens a 10,000-Message Session through bounded pages and keeps large bodies bounded',
    tier: 'extended',
    scenario: 'performance',
  },
  {
    path: 'tests/e2e/conversation-history-performance.spec.ts',
    title:
      'Comment navigation mounts the exact offscreen source and preserves its selection while scrolling',
    tier: 'extended',
    scenario: 'performance',
  },
  {
    path: 'tests/e2e/conversation-visibility.spec.ts',
    title: 'read Retry never resends and hidden detail cancellation permits another expansion',
    tier: 'extended',
    scenario: 'additional-regression',
  },
  {
    path: 'tests/e2e/default-session-settings.spec.ts',
    title: 'saves first-use defaults and reopens the singleton from Settings',
    tier: 'core',
    scenario: 'first-use',
  },
  {
    path: 'tests/e2e/project-catalog.spec.ts',
    title: 'adds, restores, collapses, archives, and re-adds a local Project',
    tier: 'extended',
    scenario: 'additional-regression',
  },
  {
    path: 'tests/e2e/project-file-performance.spec.ts',
    title: 'keeps maximum-size plain files complete while mounting only viewport code rows',
    tier: 'extended',
    scenario: 'performance',
  },
  {
    path: 'tests/e2e/project-file-performance.spec.ts',
    title:
      'recreates JSON language service across TypeScript and releases Workers after repeated views',
    tier: 'extended',
    scenario: 'performance',
  },
  {
    path: 'tests/e2e/project-file-performance.spec.ts',
    title: 'applies the same Comment quote limit to LF-normalized CRLF files',
    tier: 'extended',
    scenario: 'performance',
  },
  {
    path: 'tests/e2e/real-context.spec.ts',
    title: 'real explicit Claude request after peer failure never reruns Codex',
    tier: 'extended',
    scenario: 'fault-and-capacity-variants',
  },
  {
    path: 'tests/e2e/real-context.spec.ts',
    title: 'real large text exceeds the old Composer ceiling and preserves original Comments',
    tier: 'extended',
    scenario: 'fault-and-capacity-variants',
  },
  {
    path: 'tests/e2e/real-context.spec.ts',
    title: 'real background model failure remains attached to its Session Run',
    tier: 'extended',
    scenario: 'fault-and-capacity-variants',
  },
  {
    path: 'tests/e2e/real-context.spec.ts',
    title: 'real Fork refuses a source without peer Native history',
    tier: 'extended',
    scenario: 'fault-and-capacity-variants',
  },
  {
    path: 'tests/e2e/real-environment.spec.ts',
    title: 'real CLIs report independent readiness and first-use gating',
    tier: 'core',
    scenario: 'first-use',
  },
  {
    path: 'tests/e2e/real-environment.spec.ts',
    title: 'real configuration loss offers configuration recovery',
    tier: 'extended',
    scenario: 'additional-regression',
  },
  {
    path: 'tests/e2e/real-environment.spec.ts',
    title: 'real configuration loss keeps existing work readable',
    tier: 'core',
    scenario: 'recovery',
  },
  {
    path: 'tests/e2e/real-image-input.spec.ts',
    title: 'real @all Agents read the same code that exists only in attached image pixels',
    tier: 'extended',
    scenario: 'image-input',
  },
  {
    path: 'tests/e2e/real-initialization.spec.ts',
    title:
      'real unconfirmed Fork keeps the committed child locked and resumes the same candidate once after restart',
    tier: 'extended',
    scenario: 'candidate-recovery-variants',
  },
  {
    path: 'tests/e2e/real-initialization.spec.ts',
    title:
      'real unconfirmed rebuild checks its actual candidate before one confirmed replacement and never replays',
    tier: 'extended',
    scenario: 'candidate-recovery-variants',
  },
  {
    path: 'tests/e2e/real-input-return.spec.ts',
    title: 'real occupied writer returns frozen Codex input and Comments; new draft empty',
    tier: 'extended',
    scenario: 'additional-regression',
  },
  {
    path: 'tests/e2e/real-input-return.spec.ts',
    title: 'real occupied writer returns frozen Codex input and Comments; new draft preserved',
    tier: 'core',
    scenario: 'draft-integrity',
  },
  {
    path: 'tests/e2e/real-inspection-fault.spec.ts',
    title: 'real silent Retry reads actual evidence without authorizing generation',
    tier: 'extended',
    scenario: 'inspection-fault-variants',
  },
  {
    path: 'tests/e2e/real-lifecycle.spec.ts',
    title: 'real lost ACK recovers the actual completed result without resend; warm inspection',
    tier: 'extended',
    scenario: 'additional-regression',
  },
  {
    path: 'tests/e2e/real-lifecycle.spec.ts',
    title: 'real lost ACK recovers the actual completed result without resend; cold inspection',
    tier: 'core',
    scenario: 'recovery',
  },
  {
    path: 'tests/e2e/real-lifecycle.spec.ts',
    title: 'real absence and empty interruption never authorize replay or old-task rebuild',
    tier: 'core',
    scenario: 'recovery',
  },
  {
    path: 'tests/e2e/real-lifecycle.spec.ts',
    title: 'real completion releases the Composer while Native title evidence is delayed',
    tier: 'extended',
    scenario: 'additional-regression',
  },
  {
    path: 'tests/e2e/real-lifecycle.spec.ts',
    title:
      'real graceful quit preserves interrupted text through a new explicit request and cold restart',
    tier: 'core',
    scenario: 'recovery',
  },
  {
    path: 'tests/e2e/real-native.spec.ts',
    title: 'real @all completes each Agent once and keeps ordered distinct response rows',
    tier: 'core',
    scenario: 'routing',
  },
  {
    path: 'tests/e2e/real-native.spec.ts',
    title: 'real Claude follow-ups do not rerun Codex and both peer answers reach its next task',
    tier: 'core',
    scenario: 'continuation',
  },
  {
    path: 'tests/e2e/real-native.spec.ts',
    title:
      'real Native first title accepts an IPC rename and cold resume preserves title and identity',
    tier: 'extended',
    scenario: 'additional-regression',
  },
  {
    path: 'tests/e2e/real-peer-assistance.spec.ts',
    title:
      'real claude structured peer request stays inert until Ask and executes the other Agent once',
    tier: 'core',
    scenario: 'collaboration',
  },
  {
    path: 'tests/e2e/real-peer-assistance.spec.ts',
    title:
      'real codex structured peer request stays inert until Ask and executes the other Agent once',
    tier: 'core',
    scenario: 'collaboration',
  },
  {
    path: 'tests/e2e/real-peer-assistance.spec.ts',
    title:
      'real Not now dismisses the proposal without a peer task and plain mention text cannot create one',
    tier: 'core',
    scenario: 'collaboration',
  },
  {
    path: 'tests/e2e/real-performance.spec.ts',
    title: 'real five active Sessions reject a sixth without accepting input',
    tier: 'extended',
    scenario: 'performance',
  },
  {
    path: 'tests/e2e/real-performance.spec.ts',
    title: 'real sequential Sessions bound Adapter retention',
    tier: 'extended',
    scenario: 'performance',
  },
  {
    path: 'tests/e2e/real-performance.spec.ts',
    title: 'real inactive Session streaming retains completion, unread and Selection',
    tier: 'extended',
    scenario: 'performance',
  },
  {
    path: 'tests/e2e/real-permissions.spec.ts',
    title: 'real once permission executes its actual command and does not grant a new Session',
    tier: 'core',
    scenario: 'permissions',
  },
  {
    path: 'tests/e2e/real-permissions.spec.ts',
    title: 'real session permission executes its actual command and does not grant a new Session',
    tier: 'core',
    scenario: 'permissions',
  },
  {
    path: 'tests/e2e/real-recovery.spec.ts',
    title:
      'real Fork preserves both Native histories and the source draft through cold initialization without a Model task',
    tier: 'core',
    scenario: 'recovery',
  },
  {
    path: 'tests/e2e/real-recovery.spec.ts',
    title:
      'real Retry inspection of a moved Native record keeps the draft read-only and rebuilds once without replay',
    tier: 'extended',
    scenario: 'additional-regression',
  },
  {
    path: 'tests/e2e/real-routing.spec.ts',
    title:
      'real @all preserves distinct ordered rows while the second Agent waits for actual permission',
    tier: 'core',
    scenario: 'routing',
  },
  {
    path: 'tests/e2e/real-settings.spec.ts',
    title:
      'real defaults and Session overrides preserve frozen native settings, next-task routing and cold copies',
    tier: 'core',
    scenario: 'settings',
  },
  {
    path: 'tests/e2e/real-source-read.spec.ts',
    title: 'real source-read refusal remains distinct and accepts no input',
    tier: 'core',
    scenario: 'source-integrity',
  },
  {
    path: 'tests/e2e/real-startup.spec.ts',
    title: 'real Session startup closes its native catalog processes without a Model Turn',
    tier: 'core',
    scenario: 'first-use',
  },
  {
    path: 'tests/e2e/real-stop.spec.ts',
    title:
      'real codex UI Stop preserves received text and unsent input before one explicit continuation; @all never starts its secondary',
    tier: 'core',
    scenario: 'stop',
  },
  {
    path: 'tests/e2e/real-stop.spec.ts',
    title:
      'real claude UI Stop preserves received text and unsent input before one explicit continuation',
    tier: 'core',
    scenario: 'stop',
  },
  {
    path: 'tests/e2e/real-stop.spec.ts',
    title:
      'real codex UI Stop retires an unanswered native permission without executing its command',
    tier: 'core',
    scenario: 'stop',
  },
  {
    path: 'tests/e2e/real-stop.spec.ts',
    title:
      'real codex UI Stop interrupts its foreground command before the delayed filesystem effect',
    tier: 'core',
    scenario: 'stop',
  },
  {
    path: 'tests/e2e/real-stop.spec.ts',
    title:
      'real claude UI Stop retires an unanswered native permission without executing its command',
    tier: 'core',
    scenario: 'stop',
  },
  {
    path: 'tests/e2e/real-stop.spec.ts',
    title:
      'real claude UI Stop interrupts its foreground command before the delayed filesystem effect',
    tier: 'core',
    scenario: 'stop',
  },
  {
    path: 'tests/e2e/real-workspace-changes.spec.ts',
    title:
      'real Claude edits preserve native versions and whole-card Undo rejects conflicts without partial writes',
    tier: 'core',
    scenario: 'changes',
  },
  {
    path: 'tests/e2e/real-workspace-changes.spec.ts',
    title: 'real Codex applied patch remains reviewable while unavailable history disables Undo',
    tier: 'core',
    scenario: 'changes',
  },
  {
    path: 'tests/e2e/session-catalog-performance.spec.ts',
    title: 'loads five Sessions at a time and preserves activity and unread state after restart',
    tier: 'extended',
    scenario: 'performance',
  },
  {
    path: 'tests/e2e/session-catalog-performance.spec.ts',
    title: 'bounds Project DOM and preserves keyboard focus after scrolling a large Catalog',
    tier: 'extended',
    scenario: 'performance',
  },
  {
    path: 'tests/e2e/session-workspace.spec.ts',
    title: 'keeps Project context while creating, reopening, archiving, and restoring a Session',
    tier: 'extended',
    scenario: 'additional-regression',
  },
]

export const realPolicyHash = createHash('sha256').update(JSON.stringify(realCases)).digest('hex')
const caseKey = (path, title) => JSON.stringify([path, title])
const registered = new Map(realCases.map((item) => [caseKey(item.path, item.title), item]))
const maxReportBytes = 8 * 1024 * 1024

async function readJson(path, limit) {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 1 || info.size > limit)
      throw new Error('Invalid bounded evidence file')
    const buffer = Buffer.alloc(info.size + 1)
    let size = 0
    while (size < buffer.length) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Read one bounded evidence file to EOF; no unbounded readFile allocation.
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size !== info.size) throw new Error('Evidence file changed or is incomplete')
    return JSON.parse(buffer.subarray(0, size).toString('utf8'))
  } finally {
    await file.close()
  }
}

export function requireRealScope(scope) {
  if (!['core', 'full'].includes(scope)) throw new Error('Real E2E scope must be core or full')
  return scope
}

export function realCaseRequired(target, scope, platform = process.platform) {
  requireRealScope(scope)
  if (target.project !== 'real') return true
  const item = registered.get(caseKey(target.path, target.title))
  if (!item) throw new Error('Real E2E case has no reviewed core/extended classification')
  return (
    (!item.platforms || item.platforms.includes(platform)) &&
    (scope === 'full' || item.tier === 'core')
  )
}

export function coreRealGrep() {
  return '@real-core\\b'
}

export function validateRealTags(listed) {
  for (const [key, test] of listed) {
    const item = registered.get(key)
    if (!item) throw new Error('Real E2E case has no reviewed core/extended classification')
    const tags = new Set((test.tags ?? []).map((tag) => (tag.startsWith('@') ? tag : `@${tag}`)))
    if (
      !tags.has(`@real-${item.tier}`) ||
      tags.has(`@real-${item.tier === 'core' ? 'extended' : 'core'}`)
    )
      throw new Error('Real E2E tag disagrees with the reviewed business classification')
  }
}

export function realReportCases(report, workspace) {
  const items = new Map()
  let count = 0
  function visit(suite, depth = 0) {
    if (depth > 32) throw new Error('Real E2E report nesting exceeds its bound')
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (++count > 256) throw new Error('Real E2E report exceeds 256 cases')
        if (test.projectName !== 'real') continue
        const file = isAbsolute(spec.file) ? relative(workspace, spec.file) : spec.file
        const normalized = file.replaceAll('\\', '/')
        const path = normalized.startsWith('tests/e2e/') ? normalized : `tests/e2e/${normalized}`
        const key = caseKey(path, spec.title)
        if (items.has(key)) throw new Error('Duplicate real E2E result identity')
        items.set(key, { ...test, tags: spec.tags })
      }
    }
    for (const child of suite.suites ?? []) visit(child, depth + 1)
  }
  for (const suite of report.suites ?? []) visit(suite)
  return items
}

/** Static case names and fixed reasons only: never export errors, attachments, output or config. */
export function evaluateRealReport(
  report,
  {
    suite = 'core',
    gate = suite,
    workspace = resolve(import.meta.dirname, '..'),
    identity = null,
    execution = 'completed',
    platform = process.platform,
  } = {},
) {
  requireRealScope(suite)
  requireRealScope(gate)
  if (suite === 'core' && gate === 'full') throw new Error('Full gate cannot use a core-only suite')
  if (!['completed', 'unavailable'].includes(execution))
    throw new Error('Invalid real execution state')
  const issues = []
  let observed = new Map()
  try {
    if (!report || !Array.isArray(report.suites)) throw new Error('Missing execution evidence')
    observed = realReportCases(report, workspace)
    if (report.errors?.length) issues.push('playwright-global-error')
  } catch {
    issues.push('missing-or-invalid-execution-evidence')
  }
  let publicIdentity = null
  if (identity !== null) {
    requireIdentity(identity)
    publicIdentity = Object.fromEntries(
      [
        'schemaVersion',
        'repository',
        'repositoryId',
        'pullRequest',
        'headRepositoryId',
        'headSha',
        'baseSha',
        'candidateSha',
        'treeSha',
        'policySha',
        'authorId',
        'channel',
      ]
        .filter(
          (name) =>
            Object.hasOwn(identity, name) && (name !== 'authorId' || identity.pullRequest !== null),
        )
        .map((name) => [name, identity[name]]),
    )
  }
  if (execution !== 'completed') issues.push('runner-or-preparation-failed')
  if ([...observed.keys()].some((key) => !registered.has(key)))
    issues.push('unclassified-real-case')
  if (suite === 'core' && [...observed.keys()].some((key) => registered.get(key)?.tier !== 'core'))
    issues.push('unexpected-case-outside-selected-suite')
  const cases = realCases.map((item) => {
    const test = observed.get(caseKey(item.path, item.title))
    const applicable = !item.platforms || item.platforms.includes(platform)
    let status = 'not-run',
      durationMs = 0
    let reason =
      item.tier === 'extended' && suite === 'core'
        ? 'Deferred to explicitly authorized full regression and release verification.'
        : 'No execution result; missing prerequisites, cancellation or early failure cannot pass.'
    if (test) {
      const results = test.results ?? []
      if (
        results.length === 1 &&
        ['passed', 'failed', 'timedOut', 'interrupted', 'skipped'].includes(results[0].status)
      ) {
        status = results[0].status
        const duration = results[0].duration
        if (Number.isFinite(duration) && duration >= 0 && duration <= 2 * 60 * 60_000)
          durationMs = duration
        else issues.push('invalid-case-duration')
        if (status === 'passed' && (test.expectedStatus !== 'passed' || test.status !== 'expected'))
          status = 'failed'
        reason =
          status === 'passed'
            ? 'All original case assertions passed.'
            : status === 'skipped'
              ? 'Skipped execution does not satisfy a required case.'
              : 'Execution failed or was interrupted; private diagnostics are withheld.'
      } else {
        issues.push('missing-result-or-retries')
      }
    }
    if (!applicable && ['not-run', 'skipped'].includes(status)) {
      status = 'not-applicable'
      reason = 'This native case is required on its declared target platform, not this runner.'
    }
    return Object.assign({}, item, {
      applicable,
      required: applicable && (gate === 'full' || item.tier === 'core'),
      status,
      durationMs,
      reason,
    })
  })
  const count = (tier, status) =>
    cases.filter((item) => item.tier === tier && item.status === status).length
  const tiers = Object.fromEntries(
    ['core', 'extended'].map((tier) => [
      tier,
      {
        total: cases.filter((item) => item.tier === tier).length,
        passed: count(tier, 'passed'),
        failed: cases.filter(
          (item) =>
            item.tier === tier && ['failed', 'timedOut', 'interrupted'].includes(item.status),
        ).length,
        skipped: count(tier, 'skipped'),
        notApplicable: count(tier, 'not-applicable'),
        notRun: count(tier, 'not-run'),
      },
    ]),
  )
  return {
    schemaVersion: 1,
    policyHash: realPolicyHash,
    suite,
    gate,
    identity: publicIdentity,
    platform,
    architecture: process.arch,
    issues: [...new Set(issues)],
    tiers,
    cases,
    gatePassed:
      issues.length === 0 &&
      cases.filter((item) => item.required).every((item) => item.status === 'passed'),
    fullSuitePassed:
      issues.length === 0 && cases.every((item) => !item.applicable || item.status === 'passed'),
  }
}

export function realReportMarkdown(report) {
  const lines = [
    '# Real Provider E2E',
    '',
    `Selected suite: **${report.suite}**; required gate: **${report.gate}**; gate: **${report.gatePassed ? 'PASS' : 'FAIL'}**; full suite: **${report.fullSuitePassed ? 'PASS' : 'NOT PASSED'}**.`,
    `Platform: ${report.platform}/${report.architecture}; policy: \`${report.policyHash}\`.`,
  ]
  if (report.identity)
    lines.push(
      `PR: ${report.identity.pullRequest}; head: \`${report.identity.headSha}\`; base: \`${report.identity.baseSha}\`; tree: \`${report.identity.treeSha}\`; tested commit: \`${report.identity.candidateSha}\`.`,
    )
  else
    lines.push(
      'Code identity is unavailable; this report is informational and cannot attest current CI execution.',
    )
  lines.push(
    '',
    '| Tier | Passed | Failed/interrupted | Skipped | Not run | Other platform | Total |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  )
  for (const [tier, counts] of Object.entries(report.tiers))
    lines.push(
      `| ${tier} | ${counts.passed} | ${counts.failed} | ${counts.skipped} | ${counts.notRun} | ${counts.notApplicable} | ${counts.total} |`,
    )
  if (report.issues.length) lines.push('', `Evidence problems: ${report.issues.join(', ')}.`)
  lines.push(
    '',
    '| Tier / scenario | Case | Result | Duration (s) | Reason |',
    '| --- | --- | --- | ---: | --- |',
  )
  for (const item of report.cases)
    lines.push(
      `| ${item.tier} / ${item.scenario} | ${item.title.replaceAll('|', '\\|')} | ${item.status} | ${(item.durationMs / 1000).toFixed(2)} | ${item.reason} |`,
    )
  return `${lines.join('\n')}\n`
}

export async function writeRealReport(report, directory, summary) {
  if (!isAbsolute(directory)) throw new Error('Real report directory must be absolute')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const markdown = realReportMarkdown(report)
  await writeFile(join(directory, 'real-summary.json'), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  })
  await writeFile(join(directory, 'real-summary.md'), markdown, { flag: 'wx', mode: 0o600 })
  if (summary) await appendFile(summary, markdown)
}

if (isScriptEntry(import.meta.url)) {
  // Report completion runs even when the private executor failed before emitting JSON.
  // An absent report is a visible failure, never fabricated passing evidence.
  void (async () => {
    const [suite, gate, directory, identityPath] = process.argv.slice(2)
    if (!directory || !isAbsolute(directory))
      throw new Error('Explicit real evidence directory is required')
    let raw = null
    try {
      raw = await readJson(join(directory, 'real.json'), maxReportBytes)
    } catch {
      // Admission/run failure is represented below without copying any unsafe exception.
    }
    let identity = null,
      identityUnavailable = false
    if (identityPath) {
      try {
        identity = requireIdentity(await readJson(identityPath, 4096))
      } catch {
        identityUnavailable = true
      }
    }
    const report = evaluateRealReport(raw, {
      suite,
      gate,
      identity,
      workspace: process.env.PACT_CI_WORKSPACE,
      execution: process.env.PACT_REAL_EXECUTION_COMPLETED === 'true' ? 'completed' : 'unavailable',
    })
    if (identityUnavailable) {
      report.issues.push('missing-or-invalid-ci-code-identity')
      report.gatePassed = false
      report.fullSuitePassed = false
    }
    await writeRealReport(report, directory, process.env.GITHUB_STEP_SUMMARY)
    if (!report.gatePassed) process.exitCode = 1
  })().catch(() => {
    console.error('Real E2E report could not be completed; gate remains failed.')
    process.exitCode = 1
  })
}
