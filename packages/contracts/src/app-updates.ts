import { z } from 'zod'

export const PACT_RELEASES_URL = 'https://github.com/mbaxszy7/Pact/releases/latest'
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
export const UPDATE_CHECK_TIMEOUT_MS = 30_000

export function releaseVersion(value: string): number[] | null {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) return null
  const parts = value.split('.').map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}

export function isNewerRelease(latest: string, current: string): boolean {
  const next = releaseVersion(latest),
    previous = releaseVersion(current)
  if (!next || !previous) return false
  for (let i = 0; i < 3; i++) {
    if (next[i] !== previous[i]) return next[i]! > previous[i]!
  }
  return false
}

export const releaseVersionSchema = z
  .string()
  .max(128)
  .refine((v) => releaseVersion(v) !== null)
export const releaseInfoSchema = z
  .strictObject({
    version: releaseVersionSchema,
    publishedAt: z.iso.datetime(),
    url: z.string().max(512),
  })
  .refine(
    (release) =>
      release.url === `https://github.com/mbaxszy7/Pact/releases/tag/v${release.version}`,
  )
export const githubLatestReleaseSchema = z
  .object({
    draft: z.literal(false),
    prerelease: z.literal(false),
    tag_name: z.string().max(129).startsWith('v'),
    published_at: z.iso.datetime(),
    html_url: z.string().max(512),
  })
  .transform((raw) => ({
    version: raw.tag_name.slice(1),
    publishedAt: raw.published_at,
    url: raw.html_url,
  }))
  .pipe(releaseInfoSchema)

export type ReleaseInfo = z.infer<typeof releaseInfoSchema>

export const updatePreferencesInputSchema = z.strictObject({
  autoCheck: z.boolean(),
  expectedRevision: z.number().int().nonnegative(),
})
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesInputSchema>
export const updateNoticeInputSchema = z.strictObject({ version: releaseVersionSchema })
export const updateStoredStateSchema = z.strictObject({
  autoCheck: z.boolean(),
  revision: z.number().int().nonnegative(),
  latest: releaseInfoSchema.nullable(),
  checkedAt: z.iso.datetime().nullable(),
  retryAt: z.iso.datetime().nullable(),
  noticePending: z.boolean(),
})
export type UpdateStoredState = z.infer<typeof updateStoredStateSchema>
export const updateStateSchema = updateStoredStateSchema.extend({
  enabled: z.boolean(),
  preferencesReady: z.boolean(),
  currentVersion: z.string().max(128),
  checking: z.boolean(),
  error: z.string().max(256).nullable(),
  updateAvailable: z.boolean(),
  stateVersion: z.number().int().nonnegative(),
  settingsRequest: z.number().int().nonnegative(),
})
export type UpdateState = z.infer<typeof updateStateSchema>
export const updateNoticeResultSchema = z.strictObject({ claimed: z.boolean() })
