import { join } from 'node:path'

import {
  publicReportIdentity,
  readCiReportIdentity,
  readE2EJson,
  reportIdentityMarkdown,
  writeE2EReport,
} from './e2e-report.mjs'
import {
  nativeProfile,
  nativeProfileSupports,
  windowsOwnerHostCases,
  windowsOwnerNativeCases,
} from './native-profiles.mjs'
import { isScriptEntry } from './script-entry.mjs'

/** Protocol fixtures have no model credentials. Raw errors and attachments never leave this owner. */
export function nativeReport(
  raw,
  {
    completed,
    exitCode,
    identity = null,
    profile: name = 'legacy',
    verifiedCodexVersion = null,
    verifiedClaudeVersion = null,
    requireIdentity = false,
  } = {},
) {
  const profile = nativeProfile(name)
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
  if (profile.files) {
    const files = Array.isArray(raw?.testResults)
      ? raw.testResults.map((file) =>
          typeof file?.name === 'string' ? file.name.replaceAll('\\', '/') : '',
        )
      : []
    valid &&=
      nativeProfileSupports(profile) &&
      (!profile.codexVersion || verifiedCodexVersion === profile.codexVersion) &&
      (!profile.claudeVersion || verifiedClaudeVersion === profile.claudeVersion) &&
      (!requireIdentity || publicReportIdentity(identity)?.kind === 'ci') &&
      files.length === profile.files.length &&
      profile.files.every(
        (expected) =>
          files.filter((file) => file === expected || file.endsWith('/' + expected)).length === 1,
      )
    if (profile.cases)
      valid &&=
        cases.length === profile.cases.length && profile.cases.every((title) => names.has(title))
  }
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
    profile: profile.name,
    requiredCodexVersion: profile.codexVersion,
    verifiedCodexVersion:
      verifiedCodexVersion === profile.codexVersion ? verifiedCodexVersion : null,
    requiredClaudeVersion: profile.claudeVersion ?? null,
    verifiedClaudeVersion:
      profile.claudeVersion && verifiedClaudeVersion === profile.claudeVersion
        ? verifiedClaudeVersion
        : null,
    ...(profile.name === 'windows-owner'
      ? {
          windowsOwnerEvidence: {
            nativeRequired: windowsOwnerNativeCases.length,
            hostSeamRequired: windowsOwnerHostCases.length,
            nativeAcceptance: passed && process.platform === 'win32',
          },
        }
      : {}),
    status: passed ? 'passed' : completed === true && valid ? 'failed' : 'blocked',
    executionCompleted: completed === true,
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    evidenceValid: valid,
    identity: publicReportIdentity(identity),
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
      ...(profile.name === 'decision-claude'
        ? [
            'Owned loopback and synthetic catalog evidence does not establish real Haiku entitlement or benefit.',
          ]
        : profile.name === 'windows-owner'
          ? ['Host OS-seam assertions do not establish Windows Job or installed-helper acceptance.']
          : []),
    ],
  }
}

const cell = (value) => String(value).replace(/[\\`*_[\]<>|]/gu, '\\$&')
export function nativeMarkdown(report) {
  const lines = [
    '# Native CLI protocol report',
    '',
    `Result: **${report.status}** · ${report.platform}/${report.arch}.`,
    report.requiredClaudeVersion
      ? `Profile: ${report.profile}; required Claude ${report.requiredClaudeVersion}; verified ${report.verifiedClaudeVersion ?? 'not recorded'}.`
      : report.profile === 'windows-owner'
        ? `Profile: windows-owner; ${report.windowsOwnerEvidence.nativeRequired} native Windows and ${report.windowsOwnerEvidence.hostSeamRequired} host OS-seam cases required.`
        : `Profile: ${report.profile}; required Codex ${report.requiredCodexVersion}; verified ${report.verifiedCodexVersion ?? 'not recorded'}.`,
    '',
  ]
  lines.push(reportIdentityMarkdown(report.identity), '')
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
  summary,
  artifactName,
  profile,
  verifiedCodexVersion,
  verifiedClaudeVersion,
  requireIdentity,
}) {
  let raw
  try {
    raw = await readE2EJson(rawPath)
  } catch {
    /* Missing or invalid execution must still leave a safe blocked report. */
  }
  const identity = identityPath ? await readCiReportIdentity(identityPath) : null
  return writeE2EReport(
    nativeReport(raw, {
      completed,
      exitCode,
      identity,
      profile,
      verifiedCodexVersion,
      verifiedClaudeVersion,
      requireIdentity,
    }),
    {
      directory,
      workspace,
      basename: 'native-summary',
      markdown: nativeMarkdown,
      summary,
      artifactName,
    },
  )
}

/** Setup/cancellation still leaves evidence; an existing execution report is never replaced. */
export async function ensureUnexecutedNativeReport(options) {
  let identity = null
  if (options.identityPath) {
    try {
      identity = await readCiReportIdentity(options.identityPath)
    } catch {
      /* No identity or execution can satisfy a gate; still report the missing lane. */
    }
  }
  try {
    const existing = await readE2EJson(join(options.directory, 'native-summary.json'))
    if (
      existing?.schemaVersion !== 1 ||
      existing.lane !== 'native' ||
      existing.platform !== process.platform ||
      existing.arch !== process.arch ||
      (options.profile !== undefined && existing.profile !== nativeProfile(options.profile).name) ||
      !['passed', 'failed', 'blocked'].includes(existing.status) ||
      existing.reportFiles?.artifactName !== options.artifactName ||
      (options.identityPath &&
        (JSON.stringify(publicReportIdentity(existing.identity)) !== JSON.stringify(identity) ||
          (existing.status === 'passed' && !identity)))
    )
      throw new Error('Existing native evidence has an unexpected identity')
    return existing
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const report = nativeReport(undefined, { completed: false, identity, profile: options.profile })
  report.limitations.push(
    'Native execution was unavailable; no case is reported as passing. Inspect setup and cancellation diagnostics.',
  )
  return writeE2EReport(report, {
    directory: options.directory,
    workspace: options.workspace,
    basename: 'native-summary',
    markdown: nativeMarkdown,
    summary: options.summary,
    artifactName: options.artifactName,
  })
}

if (isScriptEntry(import.meta.url))
  ensureUnexecutedNativeReport({
    directory: process.env.PACT_CI_NATIVE_REPORT_DIR,
    workspace: process.env.PACT_CI_WORKSPACE,
    identityPath: process.env.PACT_CI_NATIVE_IDENTITY_FILE,
    artifactName: process.env.PACT_CI_NATIVE_ARTIFACT,
    summary: process.env.GITHUB_STEP_SUMMARY,
    profile: process.env.PACT_CI_NATIVE_PROFILE,
  }).catch(() => {
    console.error('Native evidence could not be safely preserved.')
    process.exitCode = 1
  })
