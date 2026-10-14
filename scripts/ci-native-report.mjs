import { publicReportIdentity, readE2EJson, writeE2EReport } from './e2e-report.mjs'

/** Protocol fixtures have no model credentials. Raw errors and attachments never leave this owner. */
export function nativeReport(raw, { completed, exitCode, identity = null } = {}) {
  const cases = []
  const names = new Set()
  let valid = Boolean(raw && typeof raw.success === 'boolean' && Array.isArray(raw.testResults))
  if (valid && raw.testResults.length <= 32) {
    for (const file of raw.testResults) {
      if (!Array.isArray(file.assertionResults) || file.assertionResults.length > 256) {
        valid = false
        break
      }
      for (const item of file.assertionResults) {
        if (
          cases.length >= 256 ||
          typeof item.fullName !== 'string' ||
          item.fullName.length < 1 ||
          Buffer.byteLength(item.fullName) > 512 ||
          /[\r\n\0]/u.test(item.fullName) ||
          names.has(item.fullName) ||
          !['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled'].includes(item.status)
        ) {
          valid = false
          break
        }
        names.add(item.fullName)
        const errors = Array.isArray(item.failureMessages) ? item.failureMessages : []
        const cleanup = errors.some(
          (value) =>
            typeof value === 'string' &&
            /cleanup is unconfirmed|cleanup failed|retained while fixture cleanup/iu.test(value),
        )
        cases.push({
          name: item.fullName,
          status: item.status === 'passed' || item.status === 'failed' ? item.status : 'unexecuted',
          durationMs: Number.isFinite(item.duration) && item.duration >= 0 ? item.duration : null,
          failureCategory:
            item.status !== 'failed' ? null : cleanup ? 'physical-cleanup' : 'protocol-or-fixture',
        })
      }
      if (!valid) break
    }
  } else valid = false
  valid &&= Number.isSafeInteger(raw?.numTotalTests) && raw.numTotalTests === cases.length
  const passed =
    valid &&
    completed === true &&
    exitCode === 0 &&
    raw.success === true &&
    cases.length > 0 &&
    cases.every((item) => item.status === 'passed')
  return {
    schemaVersion: 1,
    lane: 'native',
    status: passed ? 'passed' : completed === true && valid ? 'failed' : 'blocked',
    executionCompleted: completed === true,
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    evidenceValid: valid,
    identity,
    platform: process.platform,
    arch: process.arch,
    cases: valid ? cases : [],
    counts: valid
      ? Object.fromEntries(
          ['passed', 'failed', 'unexecuted'].map((status) => [
            status,
            cases.filter((item) => item.status === status).length,
          ]),
        )
      : null,
    limitations: [
      'Informational report; the required native command and platform job remain the merge gate.',
      'Unexecuted cases require investigation; none are represented as passing.',
      'Raw native errors, stdout, configuration and credentials are excluded.',
    ],
  }
}

const cell = (value) => String(value).replace(/[\\`*_[\]<>|]/gu, '\\$&')
export function nativeMarkdown(report) {
  const lines = [
    '# Native CLI protocol report',
    '',
    `Result: **${report.status}** · ${report.platform}/${report.arch}.`,
    '',
  ]
  if (report.identity)
    lines.push(`Source: \`${report.identity.candidateSha ?? report.identity.sourceSha}\`.`, '')
  lines.push(
    `Report artifact: **${report.reportFiles?.artifactName ?? 'local report'}**; CI retention 14 days.`,
    '',
    '| Case | Result | Duration (ms) | Failure category |',
    '| --- | --- | ---: | --- |',
  )
  for (const item of report.cases)
    lines.push(
      `| ${cell(item.name)} | ${item.status} | ${item.durationMs ?? 'unknown'} | ${item.failureCategory ?? ''} |`,
    )
  lines.push('', ...report.limitations.map((item) => `- ${item}`), '')
  return lines.join('\n')
}

export async function writeNativeReport({
  rawPath,
  directory,
  workspace,
  completed,
  exitCode,
  identityPath,
  identityKind = 'ci',
  summary,
  artifactName,
}) {
  let raw
  try {
    raw = await readE2EJson(rawPath)
  } catch {
    /* Missing or invalid execution must still leave a safe blocked report. */
  }
  const identity = identityPath
    ? publicReportIdentity(await readE2EJson(identityPath, 16 * 1024), identityKind)
    : null
  return writeE2EReport(nativeReport(raw, { completed, exitCode, identity }), {
    directory,
    workspace,
    basename: 'native-summary',
    markdown: nativeMarkdown,
    summary,
    artifactName,
  })
}
