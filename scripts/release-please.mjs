import { appendFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { Manifest, GitHub as ReleasePleaseGitHub } from 'release-please'

import { classifyProductTransition } from './ci-identity.mjs'
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

const versionPaths = [
  'version.json',
  'package.json',
  'apps/desktop/package.json',
  '.release-please-manifest.json',
]
const releasePaths = new Set([...versionPaths, 'CHANGELOG.md'])
const shaPattern = /^[a-f\d]{40}$/u

function requireFact(condition, message) {
  if (!condition) throw new Error(message)
}

/** Preview once, then give the pinned library the exact validated updates to write. */
export async function createValidatedPullRequests(
  plan,
  github,
  { sourceSha, productMetadata, approvedMajor = '', verifySource },
) {
  requireFact(shaPattern.test(sourceSha), 'Release PR source SHA is unresolved')
  requireFact(typeof verifySource === 'function', 'Release PR requires a current main source guard')
  await verifySource()
  const candidates = await plan.buildPullRequests()
  requireFact(
    Array.isArray(candidates) && candidates.length <= 1,
    'Release Please must produce a single product candidate',
  )
  for (const candidate of candidates) {
    requireFact(
      candidate.headRefName === 'release-please--branches--main' &&
        Buffer.byteLength(candidate.body.toString()) <= 64 * 1024,
      'Release PR branch or notes exceed the admitted product scope',
    )
    // oxlint-disable-next-line eslint/no-await-in-loop -- The single candidate is rendered from an immutable main source before any write.
    const changes = await github.buildChangeSet(candidate.updates, sourceSha)
    requireFact(
      changes instanceof Map &&
        changes.size <= releasePaths.size &&
        [...changes.keys()].every((path) => releasePaths.has(path)) &&
        versionPaths.every((path) => changes.has(path)) &&
        changes.has('CHANGELOG.md'),
      'Release PR changes unexpected source or omits a version authority/changelog',
    )
    const before = {},
      after = {}
    for (const path of versionPaths) {
      const change = changes.get(path)
      requireFact(
        typeof change.originalContent === 'string' &&
          typeof change.content === 'string' &&
          Buffer.byteLength(change.originalContent) <= 64 * 1024 &&
          Buffer.byteLength(change.content) <= 64 * 1024,
        'Release PR version metadata is missing or exceeds its bound',
      )
      before[path] = JSON.parse(change.originalContent)
      after[path] = JSON.parse(change.content)
    }
    requireFact(
      isDeepStrictEqual(before['version.json'], productMetadata),
      'Release PR preview product metadata differs from its immutable source',
    )
    const transition = classifyProductTransition(before['version.json'], after['version.json'])
    requireFact(transition.kind === 'release', 'Release PR preview has no new release intent')
    const version = releaseVersion(transition.version, approvedMajor)
    requireFact(
      candidate.title.toString() === `chore(main): release ${version}`,
      'Release PR preview title disagrees with its product version',
    )
    for (const path of versionPaths) {
      const key = path === '.release-please-manifest.json' ? '.' : 'version'
      requireFact(
        before[path]?.[key] === productMetadata.version && after[path]?.[key] === version,
        'Product, desktop, root package and Release Please preview versions disagree',
      )
      const expected = { ...before[path], [key]: version }
      if (path === 'version.json') expected.candidateVersion = version
      requireFact(
        isDeepStrictEqual(after[path], expected),
        'Release PR preview modifies non-version product metadata',
      )
    }
    candidate.updates = [...changes].map(([path, change]) => {
      requireFact(
        typeof change.content === 'string' && Buffer.byteLength(change.content) <= 64 * 1024,
        'Release PR output exceeds its admitted content bound',
      )
      const beforeContent = change.originalContent ?? undefined
      const afterContent = change.content
      return Object.freeze({
        path,
        createIfMissing: beforeContent === undefined,
        updater: Object.freeze({
          updateContent(content) {
            requireFact(
              content === beforeContent,
              'Release PR source changed after preview; rerun from current main',
            )
            return afterContent
          },
        }),
      })
    })
    Object.freeze(candidate.updates)
    Object.freeze(candidate)
  }
  Object.freeze(candidates)
  await verifySource()
  const originalBuild = plan.buildPullRequests
  plan.buildPullRequests = async () => candidates
  try {
    return await plan.createPullRequests()
  } finally {
    plan.buildPullRequests = originalBuild
  }
}

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
  productMetadata,
  releaseMerge = false,
  approvedMajor = '',
}) {
  releaseVersion(manifestVersion, approvedMajor)
  classifyProductTransition(productMetadata, productMetadata)
  requireFact(
    productMetadata.version === manifestVersion,
    'Product and Release Please manifest versions disagree',
  )
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
    if (productMetadata.candidateVersion !== '0.1.0-unreleased')
      return { pendingRelease: true, releaseAs: '' }
    return { pendingRelease: false, releaseAs: '0.1.0' }
  }
  requireFact(
    productMetadata.candidateVersion === manifestVersion,
    'Published product cannot restore an unreleased version marker',
  )
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
  const mainRef = await api.request(api.path('/git/ref/heads/main'))
  const sourceSha = mainRef.object?.sha
  requireFact(shaPattern.test(sourceSha), 'Release Please main source SHA is unresolved')
  const [manifest, productMetadata] = await Promise.all([
    api.jsonAt('.release-please-manifest.json', sourceSha),
    api.jsonAt('version.json', sourceSha),
  ])
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
    productMetadata,
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
    await createValidatedPullRequests(releasePlan, github, {
      sourceSha,
      productMetadata,
      approvedMajor: environment.PACT_APPROVED_MAJOR_VERSION,
      async verifySource() {
        const current = await api.request(api.path('/git/ref/heads/main'))
        requireFact(
          current.object?.sha === sourceSha,
          'Release Please main source changed; rerun before writing a version PR',
        )
      },
    })
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
