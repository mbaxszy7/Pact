import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  e2eBusinessExpansionTargets,
  e2eMigrationBaseline,
  e2eMigrationCases,
  e2eMigrationOriginalAssertions,
} from '../tests/e2e/coverage-manifest.ts'
import { readE2EBaseline } from './e2e-baseline.mjs'
import { isScriptEntry } from './script-entry.mjs'

const selectedWorkspace = process.env.PACT_CI_WORKSPACE
if (selectedWorkspace !== undefined && !isAbsolute(selectedWorkspace))
  throw new Error('Coverage workspace must be an explicit absolute path.')
const root = selectedWorkspace ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
const controllerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootRequire = createRequire(join(controllerRoot, 'package.json'))
const maxSourceBytes = 512 * 1024
const maxReportBytes = 8 * 1024 * 1024
const maxResultReports = 8
const maxTotalReportBytes = 16 * 1024 * 1024
// Reuse the parser already required by the desktop's React build; add no dependency.
const desktopRequire = createRequire(join(controllerRoot, 'apps/desktop/package.json'))
const reactRequire = createRequire(desktopRequire.resolve('@vitejs/plugin-react'))
const babelRequire = createRequire(reactRequire.resolve('@babel/core'))
const { parse } = babelRequire('@babel/parser')

function options(argv) {
  const result = { json: false, requireResults: false, results: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') result.json = true
    else if (argument === '--require-results') result.requireResults = true
    else if (argument === '--list-json' || argument === '--results-json') {
      const path = argv[++index]
      if (!path || path.startsWith('--')) throw new Error(`${argument} requires a file path`)
      if (argument === '--list-json') result.list = resolve(root, path)
      else {
        if (result.results.length >= maxResultReports)
          throw new Error('At most eight execution reports may be combined')
        result.results.push(resolve(root, path))
      }
    } else throw new Error(`Unknown option: ${argument}`)
  }
  return result
}

function boundedText(text, maximum) {
  if (Buffer.byteLength(text) > maximum) throw new Error('Coverage input exceeds its byte bound')
  return text
}

function reportFile(path) {
  if (statSync(path).size > maxReportBytes)
    throw new Error('Coverage report exceeds its byte bound')
  return JSON.parse(boundedText(readFileSync(path, 'utf8'), maxReportBytes))
}

function canonical(node) {
  if (Array.isArray(node)) return node.map(canonical)
  if (!node || typeof node !== 'object') return node
  if (['TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(node.type))
    return canonical(node.expression)
  return Object.fromEntries(
    Object.entries(node)
      .filter(
        ([key]) =>
          ![
            'start',
            'end',
            'loc',
            'extra',
            'leadingComments',
            'trailingComments',
            'innerComments',
            'typeAnnotation',
            'typeParameters',
            'typeArguments',
          ].includes(key),
      )
      .map(([key, value]) => [key, canonical(value)]),
  )
}

// The editor changed from textarea.value to contenteditable.textContent.
// Recognize only the exact same locator and string equality, without executing
// either expression or accepting a changed expected value/negative matcher.
function assertionCanonical(node) {
  if (
    node?.type === 'CallExpression' &&
    node.arguments.length === 1 &&
    node.arguments[0]?.type === 'StringLiteral' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property.name === 'toBe'
  ) {
    const poll = node.callee.object
    const callback = poll?.arguments?.[0]
    const body = callback?.body
    if (
      poll?.type === 'CallExpression' &&
      poll.arguments.length === 1 &&
      poll.callee.type === 'MemberExpression' &&
      !poll.callee.computed &&
      poll.callee.object.name === 'expect' &&
      poll.callee.property.name === 'poll' &&
      callback?.type === 'ArrowFunctionExpression' &&
      !callback.async &&
      callback.params.length === 0 &&
      body?.type === 'CallExpression' &&
      body.arguments.length === 0 &&
      body.callee.type === 'MemberExpression' &&
      !body.callee.computed &&
      body.callee.property.name === 'textContent'
    ) {
      return canonical({
        type: 'CallExpression',
        callee: {
          type: 'MemberExpression',
          object: {
            type: 'CallExpression',
            callee: { type: 'Identifier', name: 'expect' },
            arguments: [body.callee.object],
          },
          computed: false,
          property: { type: 'Identifier', name: 'toHaveValue' },
        },
        arguments: node.arguments,
      })
    }
  }
  return canonical(node)
}

function replaceLegacyRecoveryLabel(value) {
  if (Array.isArray(value)) return value.map(replaceLegacyRecoveryLabel)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'value' && value.type === 'StringLiteral' && child === 'Retry'
        ? 'Check session'
        : replaceLegacyRecoveryLabel(child),
    ]),
  )
}

function evaluate(node, bindings) {
  if (node.type === 'TSAsExpression') return evaluate(node.expression, bindings)
  if (['StringLiteral', 'BooleanLiteral', 'NumericLiteral'].includes(node.type)) return node.value
  if (node.type === 'Identifier' && Object.hasOwn(bindings, node.name)) return bindings[node.name]
  if (node.type === 'ArrayExpression') return node.elements.map((item) => evaluate(item, bindings))
  if (node.type === 'BinaryExpression' && node.operator === '===')
    return evaluate(node.left, bindings) === evaluate(node.right, bindings)
  if (node.type === 'ConditionalExpression')
    return evaluate(evaluate(node.test, bindings) ? node.consequent : node.alternate, bindings)
  if (node.type === 'TemplateLiteral')
    return node.quasis
      .map(
        (quasi, index) =>
          quasi.value.cooked +
          (node.expressions[index] ? evaluate(node.expressions[index], bindings) : ''),
      )
      .join('')
  throw new Error(`Unsupported immutable baseline title expression: ${node.type}`)
}

export function sourceEvidence(path, text, { baseline = false } = {}) {
  boundedText(text, maxSourceBytes)
  const ast = parse(text, { sourceType: 'module', plugins: ['typescript'] })
  const assertions = []
  const titles = []
  const skipSites = []
  function visit(node, ancestors = []) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression') {
      const callee = node.callee
      if (
        (callee.type === 'Identifier' && callee.name === 'expect') ||
        (callee.type === 'MemberExpression' &&
          callee.object.name === 'expect' &&
          callee.property.name === 'poll')
      ) {
        let chain = node
        for (const parent of ancestors.toReversed()) {
          if (
            (parent.type === 'MemberExpression' && parent.object === chain) ||
            (parent.type === 'CallExpression' && parent.callee === chain)
          )
            chain = parent
          else break
        }
        const owner = ancestors
          .toReversed()
          .find(
            (parent) =>
              parent.type === 'CallExpression' &&
              parent.callee.type === 'Identifier' &&
              parent.callee.name === 'test',
          )
        const helper = ancestors
          .toReversed()
          .find((parent) => parent.type === 'FunctionDeclaration')
        let ownerNode = owner?.arguments[0]
        if (ownerNode?.type === 'StringLiteral') {
          const revised = e2eMigrationCases.find(
            (item) => item.originalPath === path && item.currentTitle === ownerNode.value,
          )
          if (revised) ownerNode = { ...ownerNode, value: revised.originalTitle }
        }
        // Only the two immutable recovery visibility sites changed their UI
        // label; leave every other string, selector and matcher exact.
        if (
          baseline &&
          path === 'tests/e2e/agent-lifecycle.spec.ts' &&
          [257, 368].includes(node.loc.start.line)
        ) {
          chain = replaceLegacyRecoveryLabel(chain)
        }
        assertions.push({
          line: node.loc.start.line,
          ownerSource: ownerNode
            ? text.slice(owner.arguments[0].start, owner.arguments[0].end)
            : undefined,
          ownerHelper: !owner && helper?.id?.name ? helper.id.name : undefined,
          signature: JSON.stringify([
            owner ? canonical(ownerNode) : (helper?.id?.name ?? 'module'),
            assertionCanonical(chain),
          ]),
        })
      }
      if (
        callee.type === 'MemberExpression' &&
        callee.object.name === 'test' &&
        ['skip', 'fixme'].includes(callee.property.name)
      )
        skipSites.push(node.loc.start.line)
      if (callee.type === 'Identifier' && callee.name === 'test') {
        let environments = [{}]
        for (const loop of ancestors.filter((parent) => parent.type === 'ForOfStatement')) {
          const binding = loop.left.declarations?.[0]?.id?.name
          if (!binding) throw new Error('Unsupported immutable baseline loop binding')
          environments = environments.flatMap((environment) =>
            evaluate(loop.right, environment).map((value) =>
              Object.assign({}, environment, { [binding]: value }),
            ),
          )
        }
        for (const environment of environments)
          titles.push(evaluate(node.arguments[0], environment))
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens'].includes(key)) continue
      if (Array.isArray(value)) for (const child of value) visit(child, [...ancestors, node])
      else if (value && typeof value === 'object' && 'type' in value)
        visit(value, [...ancestors, node])
    }
  }
  visit(ast)
  return { path, assertions, titles, skipSites }
}

export function compareAssertions(path, baseline, current, updates = []) {
  const problems = []
  if (updates.length > 64) throw new Error('Too many assertion contract updates')
  const updateByLine = new Map()
  for (const update of updates) {
    if (
      updateByLine.has(update.originalLine) ||
      !baseline.assertions.some((item) => item.line === update.originalLine) ||
      !update.reason ||
      !update.replacementAssertions?.length ||
      update.replacementAssertions.length > 8
    )
      throw new Error('Invalid assertion contract update')
    updateByLine.set(update.originalLine, update)
  }
  const remaining = new Map()
  for (const item of current.assertions)
    remaining.set(item.signature, (remaining.get(item.signature) ?? 0) + 1)
  for (const assertion of baseline.assertions) {
    const update = updateByLine.get(assertion.line)
    let required = [assertion.signature]
    if (update) {
      if (!assertion.ownerSource && !/^[A-Za-z_$][A-Za-z\d_$]*$/u.test(assertion.ownerHelper ?? ''))
        throw new Error('Contract update requires an exact test or named helper owner')
      required = update.replacementAssertions.map((expression) => {
        if (Buffer.byteLength(expression) > 8192)
          throw new Error('Assertion replacement exceeds its byte bound')
        const parsed = sourceEvidence(
          path,
          assertion.ownerSource
            ? `test(${assertion.ownerSource}, async () => { ${expression} })`
            : `async function ${assertion.ownerHelper}() { ${expression} }`,
        )
        if (parsed.assertions.length !== 1)
          throw new Error('Each replacement must contain exactly one assertion')
        return parsed.assertions[0].signature
      })
    }
    const needed = new Map()
    for (const signature of required) needed.set(signature, (needed.get(signature) ?? 0) + 1)
    if ([...needed].some(([signature, count]) => (remaining.get(signature) ?? 0) < count))
      problems.push({
        type: update
          ? 'contract-replacement-changed-or-removed'
          : 'original-assertion-changed-or-removed',
        path,
        baselineLine: assertion.line,
      })
    else
      for (const [signature, count] of needed)
        remaining.set(signature, remaining.get(signature) - count)
  }
  return problems
}

function relativeSpec(path) {
  const normalized = (isAbsolute(path) ? relative(root, path) : path).replaceAll('\\', '/')
  return normalized.startsWith('tests/e2e/') ? normalized : `tests/e2e/${normalized}`
}

function identity(path, title, project = '') {
  return JSON.stringify([relativeSpec(path), title, project])
}

function reportCases(report) {
  const items = new Map()
  function visit(suite) {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? []) {
        const key = identity(spec.file, spec.title, test.projectName)
        if (items.has(key)) throw new Error('Duplicate Playwright coverage identity')
        items.set(key, {
          path: relativeSpec(spec.file),
          title: spec.title,
          project: test.projectName,
          expectedStatus: test.expectedStatus,
          statuses: (test.results ?? []).map((result) => result.status),
          outcome: test.status,
        })
      }
    for (const child of suite.suites ?? []) visit(child)
  }
  for (const suite of report.suites ?? []) visit(suite)
  if (items.size > 256) throw new Error('Playwright coverage exceeds 256 cases')
  return items
}

function targetStatus(target, listed, results) {
  const key = identity(target.path, target.title, target.project)
  const list = listed.get(key)
  if (!list) return 'missing'
  const result = results.get(key)
  if (!result?.statuses.length) return list.expectedStatus === 'skipped' ? 'skipped' : 'unverified'
  if (result.expectedStatus === 'skipped' || result.statuses.includes('skipped')) return 'skipped'
  if (result.expectedStatus !== 'passed') return 'failed'
  if (result.statuses.some((status) => status !== 'passed') || result.outcome !== 'expected')
    return 'failed'
  return 'passed'
}

function check(configuration) {
  const problems = []
  const skippedSources = []
  const original = readE2EBaseline(join(root, 'tests/e2e/baseline.json'))
  if (original.revision !== e2eMigrationBaseline.revision)
    throw new Error('E2E manifest and immutable source revision disagree')
  const baselinePaths = Object.keys(original.files).toSorted()
  let baselineCases = 0
  let baselineAssertions = 0
  const originals = new Set()
  for (const path of baselinePaths) {
    const baseline = sourceEvidence(path, original.files[path], { baseline: true })
    baselineCases += baseline.titles.length
    baselineAssertions += baseline.assertions.length
    for (const title of baseline.titles) originals.add(identity(path, title))
    const manifestLines = e2eMigrationOriginalAssertions[path.split('/').at(-1)] ?? []
    if (
      JSON.stringify(baseline.assertions.map((item) => item.line)) !== JSON.stringify(manifestLines)
    )
      problems.push({ type: 'baseline-assertion-index', path })
    const obligations = new Set(
      e2eMigrationCases
        .filter((item) => item.originalPath === path)
        .flatMap((item) => item.assertionGroups.flatMap((group) => group.originalAssertionLines)),
    )
    for (const line of manifestLines)
      if (!obligations.has(line))
        problems.push({ type: 'original-assertion-unmapped', path, baselineLine: line })
    let current
    try {
      current = sourceEvidence(path, readFileSync(join(root, path), 'utf8'))
    } catch {
      problems.push({ type: 'original-source-unavailable', path })
      continue
    }
    problems.push(
      ...compareAssertions(
        path,
        baseline,
        current,
        e2eMigrationCases
          .filter((item) => item.originalPath === path)
          .flatMap((item) => item.contractUpdates ?? []),
      ),
    )
    if (current.skipSites.length) skippedSources.push({ path, lines: current.skipSites })
  }
  const actualBaseline = {
    specCount: baselinePaths.length,
    caseCount: baselineCases,
    assertionSiteCount: baselineAssertions,
  }
  for (const [key, actual] of Object.entries(actualBaseline))
    if (actual !== e2eMigrationBaseline[key])
      problems.push({ type: 'baseline-count-mismatch', key, actual })
  const manifestIdentities = e2eMigrationCases.map((item) =>
    identity(item.originalPath, item.originalTitle),
  )
  if (new Set(manifestIdentities).size !== manifestIdentities.length)
    problems.push({ type: 'duplicate-manifest-original' })
  for (const key of originals)
    if (!manifestIdentities.includes(key))
      problems.push({ type: 'original-case-missing-from-manifest', identity: JSON.parse(key) })
  for (const key of manifestIdentities)
    if (!originals.has(key))
      problems.push({ type: 'manifest-original-not-in-baseline', identity: JSON.parse(key) })
  const listed = reportCases(
    configuration.list
      ? reportFile(configuration.list)
      : JSON.parse(
          boundedText(
            execFileSync(
              process.execPath,
              [rootRequire.resolve('@playwright/test/cli'), 'test', '--list', '--reporter=json'],
              {
                cwd: controllerRoot,
                encoding: 'utf8',
                timeout: 30_000,
                maxBuffer: maxReportBytes,
              },
            ),
            maxReportBytes,
          ),
        ),
  )
  const results = new Map()
  const executionReports = []
  let reportBytes = 0
  let previousStart = 0
  for (const path of configuration.results) {
    reportBytes += statSync(path).size
    if (reportBytes > maxTotalReportBytes)
      throw new Error('Combined execution reports exceed their byte bound')
    const resultReport = reportFile(path)
    const start = Date.parse(resultReport.stats?.startTime)
    if (!Number.isFinite(start) || start < previousStart)
      throw new Error('Execution reports must have valid start times in chronological order')
    previousStart = start
    const reportPath = relative(root, path)
    executionReports.push({ path: reportPath, stats: resultReport.stats })
    if (resultReport.errors?.length)
      problems.push({
        type: 'playwright-global-errors',
        report: reportPath,
        count: resultReport.errors.length,
      })
    for (const [key, result] of reportCases(resultReport)) {
      const prior = results.get(key)
      results.set(key, {
        ...result,
        history: [
          ...(prior?.history ?? []),
          { report: reportPath, statuses: result.statuses, outcome: result.outcome },
        ],
      })
    }
  }
  const cases = e2eMigrationCases.map((item) => {
    const originalListed = [...listed.values()].some(
      (test) =>
        identity(test.path, test.title) ===
        identity(item.originalPath, item.currentTitle ?? item.originalTitle),
    )
    if (!originalListed)
      problems.push({
        type: 'original-case-no-longer-registered',
        path: item.originalPath,
        title: item.originalTitle,
      })
    const targets = item.targets.map((target) => ({
      ...target,
      status: targetStatus(target, listed, results),
      executionHistory:
        results.get(identity(target.path, target.title, target.project))?.history ?? [],
    }))
    for (const target of targets)
      if (['missing', 'failed', 'skipped'].includes(target.status))
        problems.push({ type: `target-${target.status}`, ...target })
    const coveredLines = new Set(
      item.assertionGroups.flatMap((group) => group.originalAssertionLines),
    )
    if (!coveredLines.size)
      problems.push({
        type: 'original-case-has-no-assertion-obligation',
        path: item.originalPath,
        title: item.originalTitle,
      })
    const pending = item.pendingRealChecks ?? []
    if (pending.length)
      problems.push({
        type: 'pending-real-obligation',
        path: item.originalPath,
        title: item.originalTitle,
        checks: pending,
      })
    if (configuration.requireResults && targets.some((target) => target.status === 'unverified'))
      problems.push({
        type: 'results-required',
        path: item.originalPath,
        title: item.originalTitle,
      })
    return {
      originalPath: item.originalPath,
      originalTitle: item.originalTitle,
      currentTitle: item.currentTitle,
      contractUpdates: item.contractUpdates ?? [],
      status: pending.length
        ? 'pending'
        : targets.every((target) => target.status === 'passed')
          ? 'verified-by-results'
          : 'unverified',
      pendingRealChecks: pending,
      implementationNotes: item.implementationNotes ?? [],
      targets,
    }
  })
  const additionalBusinessCases = e2eBusinessExpansionTargets.map((target) => {
    const status = targetStatus(target, listed, results)
    if (
      ['missing', 'failed', 'skipped'].includes(status) ||
      (configuration.requireResults && status === 'unverified')
    )
      problems.push({ type: `additional-business-${status}`, ...target })
    return {
      ...target,
      status,
      executionHistory:
        results.get(identity(target.path, target.title, target.project))?.history ?? [],
    }
  })
  for (const path of new Set(e2eBusinessExpansionTargets.map((target) => target.path))) {
    const source = sourceEvidence(path, readFileSync(join(root, path), 'utf8'))
    if (source.skipSites.length)
      problems.push({ type: 'additional-business-source-skip', path, lines: source.skipSites })
  }
  return {
    baseline: { revision: e2eMigrationBaseline.revision, ...actualBaseline },
    registeredCaseCount: listed.size,
    resultsSupplied: executionReports.length > 0,
    executionReports,
    sourceSkipSites: skippedSources,
    // The original macOS accessibility branch may legitimately skip. It is still unverified.
    problems,
    cases,
    additionalBusinessCases,
    passedGate:
      problems.length === 0 &&
      cases.every((item) => item.status === 'verified-by-results') &&
      additionalBusinessCases.every((item) => item.status === 'passed'),
  }
}

if (isScriptEntry(import.meta.url))
  try {
    const configuration = options(process.argv.slice(2))
    const report = check(configuration)
    if (configuration.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else {
      console.log(
        `Immutable baseline: ${report.baseline.specCount} specs / ${report.baseline.caseCount} cases / ${report.baseline.assertionSiteCount} assertions.`,
      )
      console.log(
        `Registered: ${report.registeredCaseCount}; results supplied: ${report.resultsSupplied}; acceptance verified: ${report.passedGate}.`,
      )
      for (const problem of report.problems) console.log(JSON.stringify(problem))
      const unverified = report.cases.filter((item) => item.status === 'unverified').length
      console.log(
        `Unverified original obligations: ${unverified}. Listing and mappings are not execution evidence.`,
      )
    }
    process.exitCode =
      report.problems.length || (configuration.requireResults && !report.passedGate) ? 1 : 0
  } catch (error) {
    console.error(
      `E2E coverage check could not complete: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown input error'}`,
    )
    process.exitCode = 1
  }
