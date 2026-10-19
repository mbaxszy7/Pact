import { and, eq, sql } from 'drizzle-orm'

import {
  updateStoredStateSchema,
  type ReleaseInfo,
  type UpdatePreferencesInput,
  type UpdateStoredState,
} from '@pact/contracts'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { appUpdateNotices, appUpdateSettings } from './schema/index.js'

/** One singleton and indexed per-version receipts; no retained history scan. */
export class AppUpdatesRepository {
  constructor(private readonly database: PactDrizzleDatabase) {}

  read(): UpdateStoredState {
    const row = this.database
      .select()
      .from(appUpdateSettings)
      .where(eq(appUpdateSettings.id, 1))
      .get()
    if (!row) throw new Error('Update settings are missing.')
    const latest =
      row.releaseVersion === null
        ? null
        : {
            version: row.releaseVersion,
            publishedAt: row.releasePublishedAt,
            url: row.releaseUrl,
          }
    const notified =
      latest &&
      this.database
        .select({ version: appUpdateNotices.version })
        .from(appUpdateNotices)
        .where(eq(appUpdateNotices.version, latest.version))
        .get()
    return updateStoredStateSchema.parse({
      autoCheck: row.autoCheck,
      revision: row.revision,
      latest,
      checkedAt: row.checkedAt,
      retryAt: row.retryAt,
      noticePending: Boolean(latest && !notified),
    })
  }

  update(input: UpdatePreferencesInput): boolean {
    return Boolean(
      this.database
        .update(appUpdateSettings)
        .set({
          autoCheck: input.autoCheck,
          revision: sql`${appUpdateSettings.revision} + 1`,
        })
        .where(
          and(eq(appUpdateSettings.id, 1), eq(appUpdateSettings.revision, input.expectedRevision)),
        )
        .returning({ id: appUpdateSettings.id })
        .get(),
    )
  }

  saveRelease(release: ReleaseInfo): void {
    this.database
      .update(appUpdateSettings)
      .set({
        releaseVersion: release.version,
        releasePublishedAt: release.publishedAt,
        releaseUrl: release.url,
        checkedAt: new Date().toISOString(),
        retryAt: null,
      })
      .where(eq(appUpdateSettings.id, 1))
      .run()
  }

  deferUntil(retryAt: string): void {
    this.database
      .update(appUpdateSettings)
      .set({ retryAt })
      .where(eq(appUpdateSettings.id, 1))
      .run()
  }

  claimNotice(version: string): boolean {
    return Boolean(
      this.database
        .insert(appUpdateNotices)
        .values({ version, notifiedAt: new Date().toISOString() })
        .onConflictDoNothing()
        .returning({ version: appUpdateNotices.version })
        .get(),
    )
  }
}
