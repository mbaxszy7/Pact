import { appendFile, readFile } from 'node:fs/promises'

import {
  ownerId,
  repository,
  repositoryId,
  requireCurrent,
  readCurrent,
  requireIdentity,
  requireSha,
} from './ci-identity.mjs'
import { requireRealScope } from './real-e2e-policy.mjs'
import { isScriptEntry } from './script-entry.mjs'

export const platformKeys = ['darwin-arm64', 'win32-x64', 'win32-arm64']
export const ciJobs = [
  'identity',
  'candidate-attestation',
  'publication',
  'quality',
  ...platformKeys.map((key) => `platform-${key}`),
]
export const providerJobs = platformKeys.map((key) => `provider-${key}`)

export function providerScopes(identity, requested = 'core') {
  requireIdentity(identity)
  requireRealScope(requested)
  // Release candidates retain every real-provider obligation regardless of dispatch input.
  return identity.channel === 'stable'
    ? { suite: 'full', gate: 'full' }
    : { suite: requested, gate: 'core' }
}
const releaseFiles = [
  'package.json',
  'apps/desktop/package.json',
  'version.json',
  '.release-please-manifest.json',
]

function requireFact(condition, message) {
  if (!condition) throw new Error(message)
}

export class CIAPI {
  constructor(token, fetchImpl = fetch) {
    requireFact(typeof token === 'string' && token.length > 0, 'CI control token is missing')
    this.token = token
    this.fetch = fetchImpl
  }

  path(suffix) {
    return `/repos/${repository}${suffix}`
  }

  async response(path, { method = 'GET', body } = {}) {
    requireFact(path.startsWith('/'), 'GitHub API path must be absolute')
    const response = await this.fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    })
    requireFact(response.ok, `CI control API failed (${response.status})`)
    let bytes = 0
    const chunks = []
    for await (const chunk of response.body) {
      bytes += chunk.length
      requireFact(bytes <= 2 * 1024 * 1024, 'CI API response exceeds 2 MiB')
      chunks.push(chunk)
    }
    return {
      data: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      link: response.headers.get('link'),
    }
  }

  async request(path, options) {
    return (await this.response(path, options)).data
  }

  async list(path, key) {
    const result = []
    const seen = new Set()
    let total
    let bytes = 0
    for (let page = 1; page <= 100; page++) {
      const pagePath = `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        expectedNext = `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page + 1}`
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each bounded page and its metadata establish completeness before the next request.
      const { data, link } = await this.response(pagePath)
      const next = nextPage(link, expectedNext)
      const batch = key ? data[key] : data
      requireFact(Array.isArray(batch) && batch.length <= 100, 'Invalid GitHub page')
      if (key) {
        requireFact(
          Number.isSafeInteger(data.total_count) &&
            data.total_count >= 0 &&
            data.total_count <= 10_000,
          'CI list total is incomplete or exceeds admission',
        )
        if (
          key === 'workflow_runs' &&
          data.total_count >= 1000 &&
          new URL(`https://api.github.com${path}`).search.length > 0
        )
          throw new Error(
            'Filtered Actions search reached its 1,000-result ceiling; completeness is unresolved',
          )
        if (total !== undefined)
          requireFact(total === data.total_count, 'CI list total changed during pagination')
        total = data.total_count
        for (const item of batch) {
          requireFact(
            Number.isSafeInteger(item?.id) && item.id >= 0 && !seen.has(item.id),
            'Invalid or duplicate CI list item identity',
          )
          seen.add(item.id)
        }
      }
      bytes += Buffer.byteLength(JSON.stringify(batch))
      requireFact(
        bytes <= 8 * 1024 * 1024,
        'CI list exceeds 8 MiB; incomplete evidence blocks admission',
      )
      result.push(...batch)
      if (key) {
        requireFact(result.length <= total, 'CI list exceeds its complete total')
        if (!next) {
          requireFact(result.length === total, 'CI list is incomplete; missing pagination link')
          return result
        }
        requireFact(
          result.length < total && batch.length > 0,
          'CI pagination disagrees with its total',
        )
      } else if (!next && batch.length < 100) return result
    }
    throw new Error('CI pagination exceeds 10,000 entries; incomplete evidence blocks admission')
  }

  async jsonAt(path, sha) {
    const file = await this.request(this.path(`/contents/${path}?ref=${requireSha(sha)}`))
    requireFact(
      file.type === 'file' && file.encoding === 'base64' && file.size <= 64 * 1024,
      'Invalid release source file',
    )
    const bytes = Buffer.from(file.content, 'base64')
    requireFact(bytes.length === file.size, 'Incomplete release source file')
    return JSON.parse(bytes.toString('utf8'))
  }
}

function nextPage(link, expectedPath) {
  if (link === null) return false
  requireFact(
    typeof link === 'string' && Buffer.byteLength(link) <= 4096,
    'Invalid CI pagination metadata',
  )
  const parts = link.split(',')
  requireFact(parts.length <= 4, 'Invalid CI pagination metadata')
  let next
  const relations = new Set()
  for (const part of parts) {
    const match = /^\s*<([^<>]+)>;\s*rel="(next|prev|first|last)"\s*$/u.exec(part)
    requireFact(match && !relations.has(match[2]), 'Invalid CI pagination link')
    relations.add(match[2])
    if (match[2] === 'next') next = match[1]
  }
  if (!next) return false
  const actual = new URL(next),
    expected = new URL(`https://api.github.com${expectedPath}`)
  actual.searchParams.sort()
  expected.searchParams.sort()
  requireFact(
    actual.origin === expected.origin &&
      !actual.username &&
      !actual.password &&
      !actual.hash &&
      actual.pathname === expected.pathname &&
      actual.searchParams.toString() === expected.searchParams.toString(),
    'CI pagination changed origin, query or sequence',
  )
  return true
}

export function requiredJobsPassed(jobs, expected) {
  requireFact(Array.isArray(jobs) && jobs.length <= 1024, 'Invalid CI job inventory')
  return expected.every((name) => {
    const matching = jobs.filter((job) => job.name === name)
    return (
      matching.length === 1 &&
      matching[0].status === 'completed' &&
      matching[0].conclusion === 'success'
    )
  })
}

export function validateSourceRun(run, identity, workflowId, { allowRunning = false } = {}) {
  requireIdentity(identity)
  requireRunScope(run)
  requireFact(
    Number.isSafeInteger(workflowId) && workflowId > 0,
    'Trusted CI workflow identity is unresolved',
  )
  requireFact(identity.pullRequest !== null, 'Provider control requires a PR identity')
  requireFact(
    run.repository?.id === repositoryId &&
      run.repository.full_name === repository &&
      run.workflow_id === workflowId &&
      run.path === '.github/workflows/ci.yml',
    'CI evidence has an unknown repository or workflow',
  )
  requireFact(
    run.event === 'pull_request_target' &&
      (run.status === 'completed' ||
        (allowRunning && ['queued', 'in_progress'].includes(run.status))) &&
      run.head_sha === identity.baseSha,
    'CI was not controlled by the exact trusted base',
  )
  if (run.pull_requests?.length)
    requireFact(
      run.pull_requests.some(
        (pr) =>
          pr.number === identity.pullRequest &&
          pr.head.sha === identity.headSha &&
          pr.base.sha === identity.baseSha,
      ),
      'CI PR association disagrees with the captured candidate',
    )
  requireFact(validGenerationIdentity(run), 'CI run identity is incomplete')
}

function validGenerationIdentity(run) {
  return ['id', 'run_number', 'run_attempt'].every(
    (field) => Number.isSafeInteger(run[field]) && run[field] > 0,
  )
}

function requireRunScope(run, provider = false) {
  requireFact(
    run &&
      Number.isSafeInteger(run.workflow_id) &&
      run.workflow_id > 0 &&
      typeof run.head_sha === 'string' &&
      /^[a-f\d]{40}$/u.test(run.head_sha) &&
      (provider
        ? typeof run.head_branch === 'string' &&
          run.head_branch.length > 0 &&
          run.head_branch.length <= 255 &&
          !/[\0\r\n]/u.test(run.head_branch)
        : typeof run.event === 'string' && /^[a-z_]{1,100}$/u.test(run.event)),
    'CI generation scope metadata is unresolved',
  )
}

export function requireLatestGeneration(runs, sourceRun, identity) {
  requireFact(Array.isArray(runs) && runs.length <= 10_000, 'CI generation inventory is incomplete')
  requireFact(validGenerationIdentity(sourceRun), 'Source CI generation identity is unresolved')
  requireRunScope(sourceRun)
  for (const run of runs) {
    requireRunScope(run)
    if (
      run.event !== 'pull_request_target' ||
      run.head_sha !== identity.baseSha ||
      run.workflow_id !== sourceRun.workflow_id
    )
      continue
    requireFact(validGenerationIdentity(run), 'CI generation identity is unresolved')
    if (run.id === sourceRun.id) {
      requireFact(run.run_number === sourceRun.run_number, 'CI generation identity disagrees')
      requireFact(run.run_attempt === sourceRun.run_attempt, 'CI attempt is obsolete')
      continue
    }
    requireFact(run.run_number !== sourceRun.run_number, 'CI generation identity is ambiguous')
    if (run.run_number < sourceRun.run_number) continue
    requireFact(
      Array.isArray(run.pull_requests) &&
        run.pull_requests.length > 0 &&
        run.pull_requests.length <= 1024 &&
        run.pull_requests.every((pr) => Number.isSafeInteger(pr?.number) && pr.number > 0),
      'A newer CI run has ambiguous PR association; success is blocked',
    )
    requireFact(
      !run.pull_requests.some((pr) => pr.number === identity.pullRequest),
      'A newer CI run supersedes this candidate result',
    )
  }
  requireFact(
    runs.some(
      (run) =>
        run.id === sourceRun.id &&
        run.run_number === sourceRun.run_number &&
        run.run_attempt === sourceRun.run_attempt,
    ),
    'Current CI generation is missing',
  )
}

export async function latestGeneration(api, identity, evidenceRun) {
  const run = await api.request(api.path(`/actions/runs/${evidenceRun.id}`))
  requireFact(
    run.id === evidenceRun.id &&
      run.run_number === evidenceRun.run_number &&
      run.run_attempt === evidenceRun.run_attempt &&
      run.workflow_id === evidenceRun.workflow_id,
    'CI attempt changed after evidence capture',
  )
  validateSourceRun(run, identity, evidenceRun.workflow_id, { allowRunning: true })
  const runs = await api.list(
    api.path(
      `/actions/workflows/${run.workflow_id}/runs?event=pull_request_target&head_sha=${identity.baseSha}`,
    ),
    'workflow_runs',
  )
  requireLatestGeneration(runs, run, identity)
  return run
}

export function requireLatestProviderGeneration(runs, evidenceRun) {
  requireFact(
    Array.isArray(runs) && runs.length <= 10_000,
    'Provider generation inventory is incomplete',
  )
  requireFact(
    validGenerationIdentity(evidenceRun),
    'Provider evidence generation identity is unresolved',
  )
  requireRunScope(evidenceRun, true)
  for (const run of runs) {
    requireRunScope(run, true)
    if (
      run.workflow_id !== evidenceRun.workflow_id ||
      run.head_branch !== 'main' ||
      run.head_sha !== evidenceRun.head_sha
    )
      continue
    requireFact(validGenerationIdentity(run), 'Provider generation identity is unresolved')
    if (run.id === evidenceRun.id) {
      requireFact(
        run.run_number === evidenceRun.run_number,
        'Provider generation identity disagrees',
      )
      requireFact(
        run.run_attempt === evidenceRun.run_attempt,
        'Provider evidence attempt is obsolete',
      )
      continue
    }
    requireFact(
      run.run_number !== evidenceRun.run_number,
      'Provider generation identity is ambiguous',
    )
    if (run.run_number > evidenceRun.run_number)
      throw new Error(
        'A newer Provider run has unresolved candidate association; old evidence cannot publish',
      )
  }
  requireFact(
    runs.some(
      (run) =>
        run.id === evidenceRun.id &&
        run.run_number === evidenceRun.run_number &&
        run.run_attempt === evidenceRun.run_attempt,
    ),
    'Provider evidence generation is missing',
  )
}

async function latestProviderGeneration(api, evidenceRun) {
  const run = await api.request(api.path(`/actions/runs/${evidenceRun.id}`))
  requireFact(
    run.id === evidenceRun.id &&
      run.run_number === evidenceRun.run_number &&
      run.run_attempt === evidenceRun.run_attempt &&
      run.workflow_id === evidenceRun.workflow_id,
    'Provider attempt changed after evidence capture',
  )
  const runs = await api.list(
    api.path(`/actions/workflows/${evidenceRun.workflow_id}/runs?head_sha=${evidenceRun.head_sha}`),
    'workflow_runs',
  )
  requireLatestProviderGeneration(runs, evidenceRun)
}

export function executionAdmission(
  identity,
  pr,
  {
    manual,
    actorId,
    headSha,
    baseSha,
    treeSha,
    commit,
    mainSha,
    authorizedRelease: releaseSourceAuthorized = false,
  } = {},
) {
  requireCurrent(identity, pr, commit, mainSha)
  if (manual) {
    requireFact(actorId === ownerId, 'Only the verified owner can authorize paid execution')
    requireFact(
      headSha === identity.headSha && baseSha === identity.baseSha && treeSha === identity.treeSha,
      'Paid execution authorization is obsolete or incomplete',
    )
    return { allowed: true, kind: 'owner-reviewed-code-identity' }
  }
  if (pr.user.id === ownerId && pr.head.repo?.id === repositoryId)
    return { allowed: true, kind: 'trusted-owner-source' }
  if (releaseSourceAuthorized) return { allowed: true, kind: 'verified-release-only-source' }
  return { allowed: false, kind: 'explicit-owner-execution-authorization-required' }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

export function verifyReleaseOnlyChanges(before, after) {
  const version = after['version.json']?.version
  requireFact(
    typeof version === 'string' &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) &&
      version !== '0.0.0',
    'Invalid Release candidate version',
  )
  for (const path of releaseFiles) {
    const key = path === '.release-please-manifest.json' ? '.' : 'version'
    requireFact(
      after[path]?.[key] === version &&
        canonical({ ...before[path], [key]: version }) === canonical(after[path]),
      'Bot source contains changes beyond synchronized release versions',
    )
  }
  return version
}

async function authorizedRelease(api, identity, pr, env) {
  if (identity.channel !== 'stable') return false
  const botId = Number(env.PACT_RELEASE_APP_BOT_ID),
    slug = env.PACT_RELEASE_APP_SLUG
  requireFact(
    Number.isSafeInteger(botId) && botId > 0 && /^[a-z0-9-]+$/u.test(slug ?? ''),
    'Dedicated Release App identity is not configured',
  )
  const bot = await api.request(`/users/${encodeURIComponent(`${slug}[bot]`)}`)
  requireFact(
    bot.type === 'Bot' &&
      bot.id === botId &&
      pr.user.id === botId &&
      pr.user.type === 'Bot' &&
      pr.head.repo?.id === repositoryId &&
      pr.head.ref === 'release-please--branches--main',
    'Release author is not the fixed App',
  )
  const files = await api.list(api.path(`/pulls/${pr.number}/files`))
  requireFact(
    Number.isSafeInteger(pr.changed_files) &&
      pr.changed_files > 0 &&
      pr.changed_files <= releaseFiles.length + 1 &&
      files.length === pr.changed_files &&
      new Set(files.map((file) => file.filename)).size === files.length,
    'Release file inventory is incomplete, duplicate or unexpected',
  )
  requireFact(
    files.length > 0 &&
      files.length <= releaseFiles.length + 1 &&
      files.every(
        (file) =>
          (releaseFiles.includes(file.filename) && file.status === 'modified') ||
          (file.filename === 'CHANGELOG.md' && ['added', 'modified'].includes(file.status)),
      ),
    'Release PR changes executable or unexpected source',
  )
  if (files.some((file) => file.filename === 'CHANGELOG.md')) {
    const file = await api.request(api.path(`/contents/CHANGELOG.md?ref=${identity.headSha}`))
    requireFact(
      file.type === 'file' && file.encoding === 'base64' && file.size > 0 && file.size <= 64 * 1024,
      'Release changelog must be bounded plain text',
    )
    const bytes = Buffer.from(file.content, 'base64')
    requireFact(
      bytes.length === file.size &&
        Buffer.from(bytes.toString('utf8')).equals(bytes) &&
        !bytes.includes(0),
      'Release changelog has invalid text bytes',
    )
  }
  const before = {},
    after = {}
  for (const path of releaseFiles) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Four source pairs are read at immutable identities before any credential is released.
    const [oldFile, newFile] = await Promise.all([
      api.jsonAt(path, identity.baseSha),
      api.jsonAt(path, identity.headSha),
    ])
    before[path] = oldFile
    after[path] = newFile
  }
  const version = verifyReleaseOnlyChanges(before, after)
  requireFact(
    pr.title === `chore(main): release ${version}`,
    'Release title does not match its synchronized version',
  )
  return true
}

export function verifyCandidateAttestation(checks, identity, run, expectedAppId) {
  requireFact(
    Number.isSafeInteger(expectedAppId) && expectedAppId > 0,
    'Fixed CI App identity is missing',
  )
  const matching = checks.filter(
    (check) =>
      check.name === 'pact-candidate-identity' &&
      check.external_id === `pact-ci:${run.id}:${run.run_attempt}:candidate` &&
      check.app?.id === expectedAppId,
  )
  requireFact(
    matching.length === 1,
    'The exact CI run has no unique fixed-App candidate attestation',
  )
  const proof = matching[0]
  requireFact(
    proof.status === 'completed' &&
      proof.conclusion === 'neutral' &&
      proof.head_sha === identity.candidateSha &&
      typeof proof.output?.summary === 'string' &&
      Buffer.byteLength(proof.output.summary) <= 4096,
    'Candidate attestation is incomplete or has a different content identity',
  )
  const payload = JSON.parse(proof.output.summary)
  requireFact(
    payload.schemaVersion === 1 &&
      payload.workflowRunId === run.id &&
      payload.workflowAttempt === run.run_attempt &&
      canonical(payload.identity) === canonical(identity),
    'Candidate artifact disagrees with the authenticated workflow output identity',
  )
}

async function context(api, identity, runId, expectedAppId) {
  const [run, workflow] = await Promise.all([
    api.request(api.path(`/actions/runs/${runId}`)),
    api.request(api.path('/actions/workflows/ci.yml')),
  ])
  validateSourceRun(run, identity, workflow.id)
  await latestGeneration(api, identity, run)
  const facts = await readCurrent(identity, (path) => api.request(path))
  const proofs = await api.list(
    api.path(`/commits/${identity.candidateSha}/check-runs?filter=all`),
    'check_runs',
  )
  verifyCandidateAttestation(proofs, identity, run, expectedAppId)
  return { run, ...facts }
}

async function readIdentity(path) {
  const bytes = await readFile(path)
  requireFact(bytes.length <= 4096, 'CI identity exceeds 4 KiB')
  return requireIdentity(JSON.parse(bytes.toString('utf8')))
}

async function publishCheck(
  api,
  identity,
  expectedAppId,
  name,
  passed,
  runId,
  explanation,
  evidenceRun,
  providerEvidence,
) {
  requireFact(
    Number.isSafeInteger(expectedAppId) && expectedAppId > 0,
    'Fixed CI App ID is missing',
  )
  await readCurrent(identity, (path) => api.request(path))
  await latestGeneration(api, identity, evidenceRun)
  if (providerEvidence) await latestProviderGeneration(api, providerEvidence)
  const check = await api.request(api.path('/check-runs'), {
    method: 'POST',
    body: {
      name,
      head_sha: identity.candidateSha,
      status: 'in_progress',
      external_id: `pact:${identity.pullRequest}:${identity.headSha}:${identity.baseSha}:${runId}:${name}`,
      details_url: `https://github.com/${repository}/actions/runs/${runId}`,
      output: {
        title: passed ? 'Current code identity evidence passed' : 'Required evidence is blocked',
        summary: `${explanation}\n\nPR #${identity.pullRequest}; head ${identity.headSha}; base ${identity.baseSha}; tree ${identity.treeSha}; policy ${identity.policySha}; tested candidate ${identity.candidateSha}.`,
      },
    },
  })
  if (check.app?.id !== expectedAppId) {
    await api.request(api.path(`/check-runs/${check.id}`), {
      method: 'PATCH',
      body: {
        status: 'completed',
        conclusion: 'failure',
        output: {
          title: 'Unexpected check writer',
          summary: 'The fixed App identity was not proven.',
        },
      },
    })
    throw new Error('The check was not issued by the required fixed App')
  }
  await readCurrent(identity, (path) => api.request(path))
  await latestGeneration(api, identity, evidenceRun)
  if (providerEvidence) await latestProviderGeneration(api, providerEvidence)
  await api.request(api.path(`/check-runs/${check.id}`), {
    method: 'PATCH',
    body: { status: 'completed', conclusion: passed ? 'success' : 'failure' },
  })
  try {
    await readCurrent(identity, (path) => api.request(path))
    await latestGeneration(api, identity, evidenceRun)
    if (providerEvidence) await latestProviderGeneration(api, providerEvidence)
  } catch {
    await api.request(api.path(`/check-runs/${check.id}`), {
      method: 'PATCH',
      body: {
        conclusion: 'failure',
        output: {
          title: 'Obsolete candidate',
          summary:
            'PR association, head, base, merge tree or trusted policy changed during publication.',
        },
      },
    })
    throw new Error('Candidate changed while its result was published')
  }
}

function flags(args) {
  const result = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    requireFact(
      ['--identity', '--run', '--provider-run'].includes(name) && args[index + 1] && !result[name],
      'Invalid CI control arguments',
    )
    result[name] = args[index + 1]
  }
  requireFact(/^[1-9]\d*$/u.test(result['--run'] ?? ''), 'An exact original CI run ID is required')
  return result
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const [mode, ...rest] = args,
    options = flags(rest)
  const identity = await readIdentity(options['--identity'])
  if (identity.pullRequest === null) {
    if (mode === 'admit' && env.GITHUB_OUTPUT)
      await appendFile(env.GITHUB_OUTPUT, 'applicable=false\nallowed=false\n')
    return
  }
  const api = new CIAPI(env.GH_TOKEN)
  if (mode === 'attest') {
    const [sourceRun, workflow] = await Promise.all([
      api.request(api.path(`/actions/runs/${options['--run']}`)),
      api.request(api.path('/actions/workflows/ci.yml')),
    ])
    validateSourceRun(sourceRun, identity, workflow.id, { allowRunning: true })
    await readCurrent(identity, (path) => api.request(path))
    await latestGeneration(api, identity, sourceRun)
    requireFact(
      String(sourceRun.id) === env.GITHUB_RUN_ID &&
        Number(env.GITHUB_RUN_ATTEMPT) === sourceRun.run_attempt &&
        Number(env.PACT_CI_PR_NUMBER) === identity.pullRequest &&
        env.PACT_CI_HEAD_SHA === identity.headSha &&
        env.PACT_CI_BASE_SHA === identity.baseSha &&
        env.PACT_CI_CANDIDATE_SHA === identity.candidateSha &&
        env.PACT_CI_TREE_SHA === identity.treeSha &&
        env.PACT_CI_POLICY_SHA === identity.policySha &&
        env.PACT_CI_CHANNEL === identity.channel,
      'Artifact identity disagrees with the trusted GitHub job outputs',
    )
    // This is an asynchronous invalidation. Cancellation before this job runs remains a delivery blocker.
    for (const name of ['pact-ci', 'provider-e2e', 'owner-approval'])
      // oxlint-disable-next-line eslint/no-await-in-loop -- Invalidate each fixed-App required context before attesting the new generation.
      await publishCheck(
        api,
        identity,
        Number(env.PACT_CI_APP_ID),
        name,
        false,
        sourceRun.id,
        'The latest candidate run has not completed all mandatory evidence.',
        sourceRun,
      )
    const check = await api.request(api.path('/check-runs'), {
      method: 'POST',
      body: {
        name: 'pact-candidate-identity',
        head_sha: identity.candidateSha,
        status: 'in_progress',
        external_id: `pact-ci:${sourceRun.id}:${sourceRun.run_attempt}:candidate`,
        output: {
          title: 'Authenticated CI candidate identity; not a merge approval',
          summary: JSON.stringify({
            schemaVersion: 1,
            workflowRunId: sourceRun.id,
            workflowAttempt: sourceRun.run_attempt,
            identity,
          }),
        },
      },
    })
    requireFact(
      check.app?.id === Number(env.PACT_CI_APP_ID),
      'Candidate attestation was not issued by the fixed App',
    )
    await readCurrent(identity, (path) => api.request(path))
    await api.request(api.path(`/check-runs/${check.id}`), {
      method: 'PATCH',
      body: { status: 'completed', conclusion: 'neutral' },
    })
    return
  }
  const { run, pr, commit, mainSha } = await context(
    api,
    identity,
    options['--run'],
    Number(env.PACT_CI_APP_ID),
  )
  const jobs = await api.list(
    api.path(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`),
    'jobs',
  )
  const ciPassed = run.conclusion === 'success' && requiredJobsPassed(jobs, ciJobs)
  if (mode === 'provider-start') {
    const providerRun = await api.request(api.path(`/actions/runs/${env.GITHUB_RUN_ID}`))
    const providerWorkflow = await api.request(api.path('/actions/workflows/provider-e2e.yml'))
    requireFact(
      providerRun.repository?.id === repositoryId &&
        providerRun.workflow_id === providerWorkflow.id &&
        providerRun.path === '.github/workflows/provider-e2e.yml' &&
        providerRun.head_branch === 'main' &&
        providerRun.run_attempt === Number(env.GITHUB_RUN_ATTEMPT),
      'Provider invalidation must belong to the exact current trusted workflow attempt',
    )
    await publishCheck(
      api,
      identity,
      Number(env.PACT_CI_APP_ID),
      'provider-e2e',
      false,
      providerRun.id,
      'The new Provider dispatch or rerun must complete every mandatory platform before this context may pass.',
      run,
      providerRun,
    )
    return
  } else if (mode === 'preflight') {
    requireFact(
      Number(env.PACT_EXPECTED_CI_ATTEMPT) === run.run_attempt,
      'Paid execution authorization belongs to an obsolete CI attempt',
    )
    requireFact(ciPassed, 'Latest mandatory uncredentialed CI did not pass before paid execution')
    await latestGeneration(api, identity, run)
    return
  } else if (mode === 'admit') {
    const manual = env.PACT_PROVIDER_MANUAL === 'true'
    const scopes = providerScopes(identity, manual ? (env.PACT_PROVIDER_SUITE ?? 'core') : 'core')
    let actorId
    if (manual) {
      const ownRun = await api.request(api.path(`/actions/runs/${env.GITHUB_RUN_ID}`))
      requireFact(
        ownRun.event === 'workflow_dispatch' && ownRun.head_branch === 'main',
        'Paid authorization must originate from the trusted main dispatch',
      )
      actorId = ownRun.actor.id
      requireFact(
        Number(env.PACT_PROVIDER_PR_NUMBER) === identity.pullRequest &&
          env.PACT_PROVIDER_AUTHORIZE === 'true',
        'Owner must explicitly authorize this PR execution',
      )
    }
    const admission = ciPassed
      ? executionAdmission(identity, pr, {
          manual,
          actorId,
          headSha: env.PACT_PROVIDER_HEAD_SHA,
          baseSha: env.PACT_PROVIDER_BASE_SHA,
          treeSha: env.PACT_PROVIDER_TREE_SHA,
          commit,
          mainSha,
          authorizedRelease: await authorizedRelease(api, identity, pr, env),
        })
      : { allowed: false, kind: 'required-uncredentialed-ci-failed' }
    if (env.GITHUB_OUTPUT)
      await appendFile(
        env.GITHUB_OUTPUT,
        `applicable=true\nallowed=${admission.allowed}\nsuite=${scopes.suite}\nreal_gate=${scopes.gate}\ncandidate=${identity.candidateSha}\nbase=${identity.baseSha}\ntree=${identity.treeSha}\npolicy=${identity.policySha}\npull_request=${identity.pullRequest}\nci_run=${run.id}\nci_attempt=${run.run_attempt}\n`,
      )
    if (env.GITHUB_STEP_SUMMARY)
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `Paid provider admission: ${admission.kind}; head=${identity.headSha}; base=${identity.baseSha}; tree=${identity.treeSha}; policy=${identity.policySha}; tested candidate=${identity.candidateSha}.\n`,
      )
  } else if (mode === 'publish') {
    requireFact(
      /^[1-9]\d*$/u.test(options['--provider-run'] ?? ''),
      'An exact provider workflow run is required',
    )
    const providerRun = await api.request(api.path(`/actions/runs/${options['--provider-run']}`))
    const providerWorkflow = await api.request(api.path('/actions/workflows/provider-e2e.yml'))
    requireFact(
      providerRun.repository?.id === repositoryId &&
        providerRun.workflow_id === providerWorkflow.id &&
        providerRun.path === '.github/workflows/provider-e2e.yml' &&
        providerRun.head_branch === 'main',
      'Provider evidence has an untrusted workflow identity',
    )
    const providerTasks = await api.list(
      api.path(`/actions/runs/${providerRun.id}/attempts/${providerRun.run_attempt}/jobs`),
      'jobs',
    )
    await latestProviderGeneration(api, providerRun)
    const passed =
      ciPassed &&
      env.PACT_PROVIDER_ALLOWED === 'true' &&
      requiredJobsPassed(providerTasks, ['check-start', 'admission', ...providerJobs])
    await publishCheck(
      api,
      identity,
      Number(env.PACT_CI_APP_ID),
      'pact-ci',
      ciPassed,
      run.id,
      'Publication, all static/unit/script checks and each target architecture must actually complete successfully.',
      run,
      providerRun,
    )
    await publishCheck(
      api,
      identity,
      Number(env.PACT_CI_APP_ID),
      'provider-e2e',
      passed,
      providerRun.id,
      'Claude and Codex core business cases are required on each target architecture for ordinary PRs. Release PRs require the full suite. Extended ordinary-PR failures remain visible in reports. Missing authorization, core failures, cancellation or unavailable evidence block this check.',
      run,
      providerRun,
    )
    // Native PR rules must own atomic diff-based approval and its revocation.
    // SHA-associated checks do not provide per-PR authorization or latest-attempt isolation.
    // Keep this gate blocked until the revised policy and trusted bootstrap are verified.
    await publishCheck(
      api,
      identity,
      Number(env.PACT_CI_APP_ID),
      'owner-approval',
      false,
      providerRun.id,
      'BLOCKED: revised diff-based owner approval is not yet enforced on main. Candidate-only check freshness, shared-SHA association, latest-attempt isolation and trusted-workflow bootstrap remain unverified.',
      run,
      providerRun,
    )
    if (!passed) throw new Error('Required Provider evidence did not pass')
  } else throw new Error('Expected CI admission or publication')
}

if (isScriptEntry(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
