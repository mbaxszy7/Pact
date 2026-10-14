import { appendFile, readFile } from 'node:fs/promises'
import { Manifest, GitHub as ReleasePleaseGitHub } from 'release-please'

import {
  compareVersions,
  decodeIdentity,
  GitHub,
  releaseVersion,
  verifyTag,
  verifyReleaseState,
  verifyPublishedRelease,
} from './release-control.mjs'
import { verifyStagingRelease } from './release-staging.mjs'
import { isScriptEntry } from './script-entry.mjs'

export async function releaseManifest(github, releaseAs = '') {
  return Manifest.fromManifest(
    github,
    'main',
    'release-please-config.json',
    '.release-please-manifest.json',
    {},
    undefined,
    releaseAs || undefined,
  )
}

export async function authenticatePublishedReleases(api, releases, context) {
  for (const release of releases.filter((candidate) => !candidate.draft && !candidate.prerelease)) {
    const identity = decodeIdentity(release.body)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Authenticate every completed release before any label write.
    await verifyPublishedRelease(api, release, identity, context)
  }
}

/** A one-run override only. Never persist release-as into the repository configuration. */
export function bootstrapDecision({
  tags,
  releases,
  manifestVersion,
  releaseMerge = false,
  approvedMajor = '',
}) {
  releaseVersion(manifestVersion, approvedMajor)
  const productTags = tags.filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag.name))
  const published = releases.filter((release) => !release.draft && !release.prerelease)
  for (const release of releases) {
    if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
      throw new Error('An unknown release/tag prevents automatic version inference')
    }
    if (!productTags.some((tag) => tag.name === release.tag_name)) {
      throw new Error('Release tag is missing; recover the release identity first')
    }
  }
  for (const tag of tags) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag.name)) {
      throw new Error('An unknown tag prevents automatic version inference')
    }
  }
  if (
    releaseMerge ||
    releases.some((release) => release.draft) ||
    productTags.some((tag) => !published.some((release) => release.tag_name === tag.name))
  ) {
    return { pendingRelease: true, releaseAs: '' }
  }
  if (published.length === 0) {
    if (manifestVersion !== '0.1.0') throw new Error('The initial product version must be 0.1.0')
    return { pendingRelease: false, releaseAs: '0.1.0' }
  }
  const latest = published
    .map((release) => release.tag_name.slice(1))
    .toSorted(compareVersions)
    .at(-1)
  if (compareVersions(manifestVersion, latest) < 0)
    throw new Error('Release manifest is older than published versions')
  if (manifestVersion !== latest) return { pendingRelease: true, releaseAs: '' }
  return { pendingRelease: false, releaseAs: '' }
}

export async function main(environment = process.env) {
  if (environment.PACT_GOVERNANCE_READY !== 'true')
    throw new Error('Exact repository governance has not been verified')
  const botId = Number(environment.PACT_RELEASE_APP_BOT_ID)
  if (!Number.isSafeInteger(botId) || botId <= 0) throw new Error('Verified App bot ID is missing')
  const api = new GitHub(environment.GITHUB_REPOSITORY, environment.GH_TOKEN)
  const manifest = JSON.parse(await readFile('.release-please-manifest.json', 'utf8'))
  const [allTags, allReleases] = await Promise.all([
    api.list(api.path('/tags')),
    api.list(api.path('/releases')),
  ])
  const stagingTags = new Set()
  for (const release of allReleases.filter((candidate) =>
    candidate.tag_name.startsWith('pact-stage-'),
  )) {
    const state = decodeIdentity(release.body)
    // Authenticate auxiliary drafts; a name prefix alone never exempts unknown releases.
    verifyStagingRelease(release, state, {
      signingKey: environment.PACT_RELEASE_SIGNING_KEY,
      botId,
    })
    // oxlint-disable-next-line eslint/no-await-in-loop -- Auxiliary state must point to an authenticated formal Release ID.
    const formal = await api.request(api.path(`/releases/${state.releaseId}`))
    verifyReleaseState(formal, state, environment.PACT_RELEASE_SIGNING_KEY, botId)
    stagingTags.add(release.tag_name)
  }
  const releases = allReleases.filter((release) => !stagingTags.has(release.tag_name))
  const tags = allTags.filter((tag) => !stagingTags.has(tag.name))
  await authenticatePublishedReleases(api, releases, {
    signingKey: environment.PACT_RELEASE_SIGNING_KEY,
    botId,
  })
  // Release Please would otherwise keep every merged PR pending forever: tagging is
  // owned by the publication controller, so this PR-only token owns label settlement.
  const publishedPRs = new Set()
  for (const release of releases.filter((candidate) => !candidate.draft && !candidate.prerelease)) {
    const identity = decodeIdentity(release.body)
    if (
      identity.repository !== api.repository ||
      identity.tag !== release.tag_name ||
      identity.version !== release.tag_name.slice(1)
    )
      throw new Error('Published release identity is unresolved')
    // oxlint-disable-next-line eslint/no-await-in-loop -- Verify one durable tag before changing its PR labels.
    await verifyTag(api, identity)
    // oxlint-disable-next-line eslint/no-await-in-loop -- The published identity selects exactly one merged PR.
    const pr = await api.request(api.path(`/pulls/${identity.releasePR}`))
    if (
      pr.user?.id !== botId ||
      pr.user.type !== 'Bot' ||
      pr.merged !== true ||
      pr.merged_by?.id !== 31481964 ||
      pr.merge_commit_sha !== identity.sourceSha ||
      pr.base?.ref !== 'main' ||
      pr.head?.ref !== 'release-please--branches--main' ||
      pr.base.repo.full_name !== api.repository ||
      pr.head.repo.full_name !== api.repository
    ) {
      throw new Error('Published Release PR author/merge identity changed')
    }
    publishedPRs.add(pr.number)
    if (!pr.labels.some((label) => label.name === 'autorelease: tagged')) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Set the replacement before removing pending; interruption stays recoverable.
      await api.request(api.path(`/issues/${pr.number}/labels`), {
        method: 'POST',
        body: { labels: ['autorelease: tagged'] },
      })
    }
    if (pr.labels.some((label) => label.name === 'autorelease: pending')) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Remove only the owned label, preserving concurrent user labels.
      await api.request(
        api.path(`/issues/${pr.number}/labels/${encodeURIComponent('autorelease: pending')}`),
        { method: 'DELETE' },
      )
    }
  }
  let releaseMerge = false
  if (environment.GITHUB_SHA) {
    if (!/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA)) throw new Error('Unknown push SHA')
    const prs = await api.list(api.path(`/commits/${environment.GITHUB_SHA}/pulls`))
    releaseMerge = prs.some(
      (pr) =>
        pr.merged_at !== null &&
        pr.base?.ref === 'main' &&
        pr.head?.ref === 'release-please--branches--main' &&
        pr.user?.id === Number(environment.PACT_RELEASE_APP_BOT_ID) &&
        !publishedPRs.has(pr.number),
    )
  }
  const decision = bootstrapDecision({
    tags,
    releases,
    manifestVersion: manifest['.'],
    releaseMerge,
    approvedMajor: environment.PACT_APPROVED_MAJOR_VERSION,
  })
  if (environment.GITHUB_OUTPUT)
    await appendFile(
      environment.GITHUB_OUTPUT,
      `pending_release=${decision.pendingRelease}\nrelease_as=${decision.releaseAs}\n`,
    )
  if (!decision.pendingRelease) {
    const [owner, repo] = api.repository.split('/')
    const github = await ReleasePleaseGitHub.create({ owner, repo, token: environment.GH_TOKEN })
    const releasePlan = await releaseManifest(github, decision.releaseAs)
    await releasePlan.createPullRequests()
  }
  return decision
}

if (isScriptEntry(import.meta.url)) {
  main()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(`Release Please blocked: ${error.message}`)
      process.exitCode = 1
    })
}
