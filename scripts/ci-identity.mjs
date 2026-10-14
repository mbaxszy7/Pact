import { execFile } from 'node:child_process'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import { isScriptEntry } from './script-entry.mjs'

const exec = promisify(execFile)
export const repository = 'mbaxszy7/Pact'
export const repositoryId = 1416403312
export const ownerId = 31481964
const shaPattern = /^[a-f\d]{40}$/u
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
    schemaVersion: 2,
    repository,
    repositoryId,
    pullRequest: pr.number,
    headRepositoryId: pr.head.repo.id,
    headSha,
    baseSha,
    candidateSha,
    treeSha: requireSha(commit.tree?.sha),
    policySha: baseSha,
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
      'policySha',
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
  return { pr, current, commit, mainSha: mainRef.object.sha }
}

export async function readPullRequest(number, token = process.env.GITHUB_TOKEN) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid PR number')
  return api(`/repos/${repository}/pulls/${number}`, token)
}

export function requireIdentity(identity) {
  if (
    identity.schemaVersion !== 2 ||
    identity.repository !== repository ||
    identity.repositoryId !== repositoryId ||
    !['dev', 'stable'].includes(identity.channel)
  )
    throw new Error('Invalid CI identity schema or channel')
  requireSha(identity.headSha)
  requireSha(identity.candidateSha)
  requireSha(identity.treeSha)
  requireSha(identity.policySha)
  if (identity.pullRequest !== null) {
    requireSha(identity.baseSha)
    if (
      !Number.isSafeInteger(identity.pullRequest) ||
      identity.pullRequest < 1 ||
      !Number.isSafeInteger(identity.authorId) ||
      identity.authorId < 1 ||
      !Number.isSafeInteger(identity.headRepositoryId) ||
      identity.headRepositoryId < 1 ||
      identity.policySha !== identity.baseSha
    )
      throw new Error('Invalid CI PR identity')
  } else if (
    identity.baseSha !== null ||
    identity.headRepositoryId !== repositoryId ||
    identity.headSha !== identity.candidateSha ||
    identity.policySha !== identity.headSha ||
    identity.channel !== 'dev'
  )
    throw new Error('Invalid branch-push identity')
  return identity
}

async function publishOutputs(identity) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `candidate=${identity.candidateSha}\nhead=${identity.headSha}\nbase=${identity.baseSha ?? ''}\ntree=${identity.treeSha}\npolicy=${identity.policySha}\nchannel=${identity.channel}\npull_request=${identity.pullRequest ?? ''}\n`,
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
  if (!response.ok) throw new Error(`CI identity API failed (${response.status})`)
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
        if (pr.base.sha !== process.env.PACT_CI_CONTROL_SHA)
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
      if (pr.head.ref === 'release-please--branches--main') {
        const botId = Number(process.env.PACT_RELEASE_APP_BOT_ID)
        const slug = process.env.PACT_RELEASE_APP_SLUG
        if (!Number.isSafeInteger(botId) || botId < 1 || !/^[a-z0-9-]+$/u.test(slug ?? ''))
          throw new Error('A Release candidate requires a verified dedicated App identity')
        const bot = await api(`/users/${encodeURIComponent(`${slug}[bot]`)}`)
        if (
          bot.id !== botId ||
          bot.type !== 'Bot' ||
          pr.user.id !== botId ||
          pr.user.type !== 'Bot' ||
          pr.head.repo?.id !== repositoryId
        )
          throw new Error('Release candidate author or repository is not the dedicated App')
        identity.channel = 'stable'
      }
    } else {
      const candidateSha =
        mode === 'capture-api' ? requireSha(process.env.PACT_CI_PUSH_SHA) : requireSha(revision[0])
      const treeSha =
        mode === 'capture-api'
          ? requireSha((await api(`/repos/${repository}/git/commits/${candidateSha}`)).tree?.sha)
          : requireSha(revision[1])
      identity = {
        schemaVersion: 2,
        repository,
        repositoryId,
        headRepositoryId: repositoryId,
        pullRequest: null,
        headSha: candidateSha,
        baseSha: null,
        candidateSha,
        treeSha,
        policySha: candidateSha,
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
