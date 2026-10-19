import { describe, expect, it } from 'vitest'

import { githubLatestReleaseSchema, isNewerRelease } from './app-updates.js'

const release = {
  draft: false,
  prerelease: false,
  tag_name: 'v0.3.0',
  published_at: '2026-10-18T00:00:00Z',
  html_url: 'https://github.com/mbaxszy7/Pact/releases/tag/v0.3.0',
}

describe('official release checks', () => {
  it('accepts the formal release facts without retaining its body or assets', () => {
    expect(
      githubLatestReleaseSchema.parse({ ...release, body: 'Release notes', assets: [] }),
    ).toEqual({
      version: '0.3.0',
      publishedAt: release.published_at,
      url: release.html_url,
    })
  })

  it.each([
    { draft: true },
    { prerelease: true },
    { tag_name: 'v01.3.0' },
    { tag_name: 'v0.03.0' },
    { tag_name: 'v0.3.00' },
    { tag_name: 'v0.3.0-beta.1' },
    { tag_name: 'v0.3' },
    { tag_name: '0.3.0' },
    { tag_name: 'v9007199254740992.0.0' },
    { published_at: 'not a date' },
    { html_url: 'https://github.com/another/Pact/releases/tag/v0.3.0' },
    { html_url: 'https://github.com/mbaxszy7/Pact/releases/tag/v0.4.0' },
    { html_url: 'https://github.com.example.invalid/mbaxszy7/Pact/releases/tag/v0.3.0' },
    { html_url: 'https://user:password@github.com/mbaxszy7/Pact/releases/tag/v0.3.0' },
  ])('rejects an untrusted or non-formal candidate: %j', (invalid) => {
    expect(githubLatestReleaseSchema.safeParse({ ...release, ...invalid }).success).toBe(false)
  })

  it('compares numeric version components and never recommends an equal or older release', () => {
    expect(isNewerRelease('0.10.0', '0.9.0')).toBe(true)
    expect(isNewerRelease('1.0.0', '0.99.99')).toBe(true)
    expect(isNewerRelease('0.3.0', '0.3.0')).toBe(false)
    expect(isNewerRelease('0.3.0', '0.4.0')).toBe(false)
    expect(isNewerRelease('0.3.0-beta.1', '0.2.0')).toBe(false)
  })
})
