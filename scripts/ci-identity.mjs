import { execFile } from 'node:child_process'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import { isScriptEntry } from './script-entry.mjs'

const exec = promisify(execFile)
export const repository = 'mbaxszy7/Pact'
export const repositoryId = 1416403312
export const ownerId = 31481964
const shaPattern = /^[a-f\d]{40}$/u
const initialCandidate = '0.1.0-unreleased'
const productVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

function productMetadata(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.version !== 'string' ||
    value.version.length > 64 ||
    !productVersionPattern.test(value.version) ||
    (value.candidateVersion !== value.version &&
      !(value.version === '0.1.0' && value.candidateVersion === initialCandidate))
  )
    throw new Error('Product version and candidate intent are missing, invalid or unsynchronized')
  return { version: value.version, candidateVersion: value.candidateVersion }
}

function compareProductVersions(left, right) {
  const a = left.split('.').map(BigInt),
    b = right.split('.').map(BigInt)
  for (let index = 0; index < 3; index++) {
    if (a[index] > b[index]) return 1
    if (a[index] < b[index]) return -1
  }
  return 0
}

/** One content policy is shared by CI, the PR generator and formal publication. */
export function classifyProductTransition(before, after, { allowInitialization = false } = {}) {
  const next = productMetadata(after)
  if (before === null) {
    if (
      !allowInitialization ||
      next.version !== '0.1.0' ||
      next.candidateVersion !== initialCandidate
    )
      throw new Error('Product initialization requires the explicitly trusted bootstrap source')
    return { kind: 'initialization', channel: 'dev', version: next.version }
  }
  const prior = productMetadata(before)
  if (prior.version === next.version && prior.candidateVersion === next.candidateVersion)
    return { kind: 'development', channel: 'dev', version: next.version }
  if (
    next.candidateVersion === initialCandidate ||
    next.candidateVersion === prior.candidateVersion
  )
    throw new Error(
      'Release intent must advance with its version; restoration and unchanged intent are blocked',
    )
  if (prior.candidateVersion === initialCandidate) {
    if (next.version !== '0.1.0') throw new Error('The initial release must be exactly 0.1.0')
  } else if (compareProductVersions(next.version, prior.version) <= 0) {
    throw new Error(
      'Release version must strictly increase; same-version and rollback candidates are blocked',
    )
  }
  return { kind: 'release', channel: 'stable', version: next.version }
}
export function requireSha(value) {
  if (typeof value !== 'string' || !shaPattern.test(value))
    throw new Error('Invalid commit identity')
  return value
}

export function candidateIdentity(pr, commit, mainSha) {
  if (
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1 ||
    !Number.isSafeInteger(pr.user?.id) ||
    pr.user.id < 1 ||
    !Number.isSafeInteger(pr.head?.repo?.id) ||
    pr.head.repo.id < 1 ||
    pr.state !== 'open' ||
    pr.base?.ref !== 'main' ||
    pr.base.repo?.id !== repositoryId
  )
    throw new Error('PR is not an open Pact main candidate')
  const headSha = requireSha(pr.head.sha),
    baseSha = requireSha(pr.base.sha),
    candidateSha = requireSha(pr.merge_commit_sha)
  if (requireSha(mainSha) !== baseSha)
    throw new Error('Main changed; candidate evidence is obsolete')
  if (
    commit?.sha !== candidateSha ||
    commit.parents?.length !== 2 ||
    commit.parents[0].sha !== baseSha ||
    commit.parents[1].sha !== headSha
  )
    throw new Error('Merge candidate does not have the exact current base and head parents')
  return {
    schemaVersion: 3,
    repository,
    repositoryId,
    pullRequest: pr.number,
    headRepositoryId: pr.head.repo.id,
    headSha,
    baseSha,
    candidateSha,
    treeSha: requireSha(commit.tree?.sha),
    policySha: baseSha,
    sourceKind: 'main',
    controllerSha: baseSha,
    controllerRef: 'refs/heads/main',
    authorId: pr.user.id,
  }
}

export function requireCurrent(identity, pr, commit, mainSha) {
  requireIdentity(identity)
  const current = candidateIdentity(pr, commit, mainSha)
  if (
    [
      'repositoryId',
      'pullRequest',
      'headRepositoryId',
      'headSha',
      'baseSha',
      'treeSha',
      'authorId',
    ].some((key) => current[key] !== identity[key])
  )
    throw new Error(
      'Current PR, head, base, tree or policy changed; candidate evidence is obsolete',
    )
  return current
}

// The merge SHA is an execution receipt. Freshness is established from the current
// main ref and the exact ordered parents and tree of GitHub's current candidate.
export async function readCurrent(identity, request = api) {
  requireIdentity(identity)
  if (identity.pullRequest === null) throw new Error('A current PR identity is required')
  const pr = await request(`/repos/${repository}/pulls/${identity.pullRequest}`)
  const [commit, mainRef] = await Promise.all([
    request(`/repos/${repository}/git/commits/${requireSha(pr.merge_commit_sha)}`),
    request(`/repos/${repository}/git/ref/heads/main`),
  ])
  if (mainRef.ref !== 'refs/heads/main' || mainRef.object?.type !== 'commit')
    throw new Error('Current main identity is unresolved')
  const current = requireCurrent(identity, pr, commit, mainRef.object.sha)
  const baseCommit = await request(`/repos/${repository}/git/commits/${identity.baseSha}`)
  if (baseCommit.sha !== identity.baseSha || requireSha(baseCommit.tree?.sha) === commit.tree.sha)
    throw new Error('Candidate has no actual change to the current protected main tree')
  const [owner, ownership] = await Promise.all([
    request('/users/mbaxszy7'),
    request(`/repos/${repository}/contents/.github/CODEOWNERS?ref=${commit.sha}`),
  ])
  if (
    owner.id !== ownerId ||
    owner.login !== 'mbaxszy7' ||
    owner.type !== 'User' ||
    ownership.type !== 'file' ||
    ownership.encoding !== 'base64' ||
    !Number.isSafeInteger(ownership.size) ||
    ownership.size < 1 ||
    ownership.size > 4096
  )
    throw new Error('The stable owner or candidate CODEOWNERS policy is invalid')
  const ownerBytes = Buffer.from(ownership.content, 'base64')
  if (
    ownerBytes.length !== ownership.size ||
    !Buffer.from(ownerBytes.toString('utf8')).equals(ownerBytes)
  )
    throw new Error('CODEOWNERS policy bytes are invalid')
  const declarations = ownerBytes
    .toString('utf8')
    .split(/\r?\n/u)
    .map((line) => line.split('#')[0].trim())
    .filter(Boolean)
  if (declarations.length !== 1 || !/^\*\s+@mbaxszy7$/u.test(declarations[0]))
    throw new Error('Candidate must preserve the sole stable owner for every path')
  const [before, after] = await Promise.all([
    readProductMetadataAt(identity.baseSha, request, {
      allowMissing: identity.sourceKind === 'bootstrap',
    }),
    readProductMetadataAt(commit.sha, request),
  ])
  if (JSON.stringify({ before, after }) !== JSON.stringify(identity.product))
    throw new Error('Current merged product intent differs from its tested content')
  if (identity.sourceKind === 'bootstrap') {
    const ref = await request(
      `/repos/${repository}/git/ref/${identity.controllerRef.slice('refs/'.length)}`,
    )
    if (
      ref.ref !== identity.controllerRef ||
      ref.object?.type !== 'commit' ||
      ref.object.sha !== identity.controllerSha
    )
      throw new Error('Frozen bootstrap controller identity changed')
  }
  return { pr, current, commit, mainSha: mainRef.object.sha }
}

export async function readPullRequest(number, token = process.env.GITHUB_TOKEN) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid PR number')
  return api(`/repos/${repository}/pulls/${number}`, token)
}

export function requireIdentity(identity) {
  if (
    identity.schemaVersion !== 3 ||
    identity.repository !== repository ||
    identity.repositoryId !== repositoryId ||
    !['dev', 'stable'].includes(identity.channel)
  )
    throw new Error('Invalid CI identity schema or channel')
  requireSha(identity.headSha)
  requireSha(identity.candidateSha)
  requireSha(identity.treeSha)
  requireSha(identity.policySha)
  requireSha(identity.controllerSha)
  if (identity.policySha !== identity.controllerSha)
    throw new Error('Controller policy identity is invalid')
  if (identity.pullRequest !== null) {
    requireSha(identity.baseSha)
    if (
      !Number.isSafeInteger(identity.pullRequest) ||
      identity.pullRequest < 1 ||
      !Number.isSafeInteger(identity.authorId) ||
      identity.authorId < 1 ||
      !Number.isSafeInteger(identity.headRepositoryId) ||
      identity.headRepositoryId < 1 ||
      !['main', 'bootstrap'].includes(identity.sourceKind)
    )
      throw new Error('Invalid CI PR identity')
    if (
      identity.sourceKind === 'main' &&
      (identity.controllerSha !== identity.baseSha || identity.controllerRef !== 'refs/heads/main')
    )
      throw new Error('Invalid trusted main controller identity')
    if (
      identity.sourceKind === 'bootstrap' &&
      (identity.controllerSha !== identity.headSha ||
        identity.controllerRef !==
          `refs/heads/codex/pact-ci-bootstrap-${identity.headSha.slice(0, 12)}`)
    )
      throw new Error('Invalid frozen bootstrap controller identity')
    const classification = classifyProductTransition(
      identity.product?.before,
      identity.product?.after,
      { allowInitialization: identity.sourceKind === 'bootstrap' },
    )
    if (classification.channel !== identity.channel)
      throw new Error('CI channel disagrees with immutable product content')
  } else if (
    identity.baseSha !== null ||
    identity.headRepositoryId !== repositoryId ||
    identity.headSha !== identity.candidateSha ||
    identity.policySha !== identity.headSha ||
    identity.channel !== 'dev' ||
    identity.sourceKind !== 'branch' ||
    identity.controllerRef !== null ||
    identity.product !== null
  )
    throw new Error('Invalid branch-push identity')
  return identity
}

/** Read bounded immutable product inputs, independently of PR author, labels or ref names. */
export async function readProductMetadataAt(sha, request = api, { allowMissing = false } = {}) {
  requireSha(sha)
  const read = async (path) => {
    const file = await request(`/repos/${repository}/contents/${path}?ref=${sha}`)
    if (
      file.type !== 'file' ||
      file.encoding !== 'base64' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      file.size > 64 * 1024
    )
      throw new Error('Product metadata must be a bounded immutable JSON file')
    const bytes = Buffer.from(file.content, 'base64')
    if (bytes.length !== file.size || !Buffer.from(bytes.toString('utf8')).equals(bytes))
      throw new Error('Product metadata bytes are incomplete or invalid')
    return JSON.parse(bytes.toString('utf8'))
  }
  let version
  try {
    version = await read('version.json')
  } catch (error) {
    if (allowMissing && error.status === 404) return null
    throw error
  }
  const product = productMetadata(version)
  const files = await Promise.all(
    ['package.json', 'apps/desktop/package.json', '.release-please-manifest.json'].map(read),
  )
  if (files.some((file, index) => (index === 2 ? file['.'] : file.version) !== product.version))
    throw new Error('Product, desktop and Release Please versions are not synchronized')
  return product
}

export function requireBootstrapSource(env, identity) {
  if (identity.sourceKind !== 'bootstrap') throw new Error('Bootstrap identity is required')
  if (
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_REPOSITORY_ID !== String(repositoryId) ||
    env.GITHUB_EVENT_NAME !== 'push' ||
    env.GITHUB_REF !== identity.controllerRef ||
    env.GITHUB_SHA !== identity.controllerSha ||
    env.PACT_CI_BOOTSTRAP_REF !== identity.controllerRef ||
    env.PACT_CI_BOOTSTRAP_HEAD !== identity.headSha ||
    env.PACT_CI_BOOTSTRAP_BASE !== identity.baseSha ||
    env.PACT_CI_BOOTSTRAP_TREE !== identity.treeSha ||
    Number(env.PACT_CI_BOOTSTRAP_PR) !== identity.pullRequest
  )
    throw new Error('This is not the explicitly reviewed frozen bootstrap source')
}

async function publishOutputs(identity) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `candidate=${identity.candidateSha}\nhead=${identity.headSha}\nbase=${identity.baseSha ?? ''}\ntree=${identity.treeSha}\npolicy=${identity.policySha}\nchannel=${identity.channel}\npull_request=${identity.pullRequest ?? ''}\ncontroller=${identity.controllerSha}\nsource_kind=${identity.sourceKind}\n`,
    )
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Test identity: head=${identity.headSha}; base=${identity.baseSha ?? 'branch push'}; tree=${identity.treeSha}; policy=${identity.policySha}; tested candidate=${identity.candidateSha}; channel=${identity.channel}\n`,
    )
}

async function api(path, token = process.env.GITHUB_TOKEN) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  })
  if (!response.ok)
    throw Object.assign(new Error(`CI identity API failed (${response.status})`), {
      status: response.status,
    })
  let size = 0
  const chunks = []
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('CI identity metadata exceeds 1 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function main() {
  const [mode, path] = process.argv.slice(2)
  if (!path) throw new Error('An explicit identity report path is required')
  if (mode === 'capture' || mode === 'capture-api') {
    const number = Number(process.env.PACT_CI_PR_NUMBER)
    let revision
    if (mode === 'capture')
      revision = (
        await exec('git', ['show', '-s', '--format=%H %T %P', 'HEAD'], {
          cwd: process.env.PACT_CI_WORKSPACE,
          shell: false,
          maxBuffer: 4096,
          timeout: 5000,
        })
      ).stdout
        .trim()
        .split(' ')
    let identity
    if (number) {
      const pr = await readPullRequest(number)
      if (
        !/^(feat|fix|perf|refactor|chore|ci|docs|style|build|test|revert)(\([^\r\n]{1,100}\))?!?: [^\r\n]{1,200}$/u.test(
          pr.title,
        )
      )
        throw new Error('PR title must follow Conventional Commits')
      const [mainRef, merge] = await Promise.all([
        api(`/repos/${repository}/git/ref/heads/main`),
        api(`/repos/${repository}/git/commits/${requireSha(pr.merge_commit_sha)}`),
      ])
      if (mainRef.ref !== 'refs/heads/main' || mainRef.object?.type !== 'commit')
        throw new Error('Current main identity is unresolved')
      if (mode === 'capture-api') {
        if (
          process.env.GITHUB_EVENT_NAME !== 'push' &&
          pr.base.sha !== process.env.PACT_CI_CONTROL_SHA
        )
          throw new Error('Trusted base changed; rerun CI from its current identity')
      } else if (
        revision.length !== 4 ||
        revision[0] !== merge.sha ||
        revision[1] !== merge.tree?.sha ||
        revision[2] !== pr.base.sha ||
        revision[3] !== pr.head.sha
      ) {
        throw new Error('Workspace does not contain the actual tested merge content')
      }
      identity = { ...candidateIdentity(pr, merge, mainRef.object.sha), channel: 'dev' }
      if (process.env.GITHUB_EVENT_NAME === 'push') {
        identity.sourceKind = 'bootstrap'
        identity.controllerSha = identity.headSha
        identity.policySha = identity.headSha
        identity.controllerRef = process.env.GITHUB_REF
        requireBootstrapSource(process.env, identity)
      }
      const [before, after] = await Promise.all([
        readProductMetadataAt(identity.baseSha, api, {
          allowMissing: identity.sourceKind === 'bootstrap',
        }),
        readProductMetadataAt(identity.candidateSha, api),
      ])
      identity.product = { before, after }
      identity.channel = classifyProductTransition(before, after, {
        allowInitialization: identity.sourceKind === 'bootstrap',
      }).channel
    } else {
      const candidateSha =
        mode === 'capture-api' ? requireSha(process.env.PACT_CI_PUSH_SHA) : requireSha(revision[0])
      const treeSha =
        mode === 'capture-api'
          ? requireSha((await api(`/repos/${repository}/git/commits/${candidateSha}`)).tree?.sha)
          : requireSha(revision[1])
      identity = {
        schemaVersion: 3,
        repository,
        repositoryId,
        headRepositoryId: repositoryId,
        pullRequest: null,
        headSha: candidateSha,
        baseSha: null,
        candidateSha,
        treeSha,
        policySha: candidateSha,
        sourceKind: 'branch',
        controllerSha: candidateSha,
        controllerRef: null,
        product: null,
        channel: 'dev',
      }
    }
    requireIdentity(identity)
    if (identity.pullRequest !== null) await readCurrent(identity)
    await writeFile(path, JSON.stringify(identity, null, 2) + '\n', { flag: 'wx' })
    await publishOutputs(identity)
  } else if (mode === 'verify') {
    const contents = await readFile(path)
    if (contents.byteLength > 4096) throw new Error('Identity report exceeds 4 KiB')
    const identity = requireIdentity(JSON.parse(contents))
    if (identity.pullRequest) await readCurrent(identity)
    if (process.env.PACT_CI_WORKSPACE) {
      const { stdout } = await exec('git', ['show', '-s', '--format=%H %T %P', 'HEAD'], {
        cwd: process.env.PACT_CI_WORKSPACE,
        shell: false,
        timeout: 5000,
        maxBuffer: 4096,
      })
      const [sha, tree, ...parents] = stdout.trim().split(' ')
      if (
        sha !== identity.candidateSha ||
        tree !== identity.treeSha ||
        (identity.pullRequest !== null &&
          (parents.length !== 2 ||
            parents[0] !== identity.baseSha ||
            parents[1] !== identity.headSha))
      )
        throw new Error('Workspace does not contain the exact tested content and execution SHA')
    }
  } else throw new Error('Expected capture or verify')
}

if (isScriptEntry(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
