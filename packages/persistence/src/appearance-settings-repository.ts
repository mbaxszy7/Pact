import { and, eq, sql } from 'drizzle-orm'

import type {
  AppearanceSettings,
  AppearanceSettingsReset,
  AppearanceSettingsUpdate,
} from '@pact/contracts'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { appearanceSettings } from './schema/index.js'

const APPEARANCE_SETTINGS_ID = 1
const DEFAULT_APPEARANCE_SETTINGS = {
  theme: 'system',
  windowMaterial: 'system',
  materialOpacity: 85,
} as const
const appearanceSettingsColumns = {
  theme: appearanceSettings.theme,
  windowMaterial: appearanceSettings.windowMaterial,
  materialOpacity: appearanceSettings.materialOpacity,
  revision: appearanceSettings.revision,
}

export type AppearanceSettingsMutation =
  | { status: 'updated'; settings: AppearanceSettings }
  | { status: 'conflict'; currentRevision: number }

export interface AppearanceSettingsRepository {
  read(): AppearanceSettings
  update(input: AppearanceSettingsUpdate): AppearanceSettingsMutation
  reset(input: AppearanceSettingsReset): AppearanceSettingsMutation
}

export class DrizzleAppearanceSettingsRepository implements AppearanceSettingsRepository {
  constructor(private readonly database: PactDrizzleDatabase) {}

  read(): AppearanceSettings {
    const row = this.database
      .select(appearanceSettingsColumns)
      .from(appearanceSettings)
      .where(eq(appearanceSettings.id, APPEARANCE_SETTINGS_ID))
      .get()

    if (!row) throw new Error('Appearance settings singleton is missing after migration.')
    return row
  }

  update(input: AppearanceSettingsUpdate): AppearanceSettingsMutation {
    const current = this.read()
    return this.write(input.expectedRevision, {
      theme: input.theme ?? current.theme,
      windowMaterial: input.windowMaterial ?? current.windowMaterial,
      materialOpacity: input.materialOpacity ?? current.materialOpacity,
    })
  }

  reset(input: AppearanceSettingsReset): AppearanceSettingsMutation {
    return this.write(input.expectedRevision, DEFAULT_APPEARANCE_SETTINGS)
  }

  private write(
    expectedRevision: number,
    next: Omit<AppearanceSettings, 'revision'>,
  ): AppearanceSettingsMutation {
    const updated = this.database
      .update(appearanceSettings)
      .set({
        ...next,
        revision: sql`${appearanceSettings.revision} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(appearanceSettings.id, APPEARANCE_SETTINGS_ID),
          eq(appearanceSettings.revision, expectedRevision),
        ),
      )
      .returning(appearanceSettingsColumns)
      .get()

    if (!updated) {
      return { status: 'conflict', currentRevision: this.read().revision }
    }
    return { status: 'updated', settings: updated }
  }
}

export { DEFAULT_APPEARANCE_SETTINGS }
