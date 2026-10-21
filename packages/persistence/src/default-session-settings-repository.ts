import { eq } from 'drizzle-orm'

import type { DefaultSessionSettings, DefaultSessionSettingsState } from '@pact/contracts'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { appSetupState, defaultSessionSettings } from './schema/index.js'

const DEFAULT_SESSION_SETTINGS_ID = 1

type DefaultSessionSettingsRow = typeof defaultSessionSettings.$inferSelect
type DefaultSessionSettingsValues = typeof defaultSessionSettings.$inferInsert

export class DefaultSessionSettingsRepository {
  constructor(private readonly database: PactDrizzleDatabase) {}

  read(): DefaultSessionSettingsState | undefined {
    const row = this.database
      .select()
      .from(defaultSessionSettings)
      .where(eq(defaultSessionSettings.id, DEFAULT_SESSION_SETTINGS_ID))
      .get()

    return row ? DefaultSessionSettingsRepository.toState(row) : undefined
  }

  save(settings: DefaultSessionSettings): DefaultSessionSettingsState {
    return this.database.transaction((transaction) => {
      const updatedAt = new Date().toISOString()
      const values: DefaultSessionSettingsValues = {
        id: DEFAULT_SESSION_SETTINGS_ID,
        primaryAgentId: settings.primaryAgentId,
        claudeModel: settings.agents.claude.model,
        claudeEffort: settings.agents.claude.effort,
        claudeSpeed: 'native',
        codexModel: settings.agents.codex.model,
        codexEffort: settings.agents.codex.effort,
        codexSpeed: 'native',
        maxDiscussionRounds: settings.maxDiscussionRounds,
        runningMessagePolicy: 'next_round',
        maxReviewCycles: settings.maxReviewCycles,
        maxRepairAttempts: settings.maxRepairAttempts,
        updatedAt,
      }

      const saved = transaction
        .insert(defaultSessionSettings)
        .values(values)
        .onConflictDoUpdate({
          target: defaultSessionSettings.id,
          set: {
            primaryAgentId: values.primaryAgentId,
            claudeModel: values.claudeModel,
            claudeEffort: values.claudeEffort,
            claudeSpeed: values.claudeSpeed,
            codexModel: values.codexModel,
            codexEffort: values.codexEffort,
            codexSpeed: values.codexSpeed,
            maxDiscussionRounds: values.maxDiscussionRounds,
            runningMessagePolicy: values.runningMessagePolicy,
            maxReviewCycles: values.maxReviewCycles,
            maxRepairAttempts: values.maxRepairAttempts,
            updatedAt: values.updatedAt,
          },
        })
        .returning()
        .get()
      if (!saved) throw new Error('Default Session Settings were not saved.')

      const setupUpdate = transaction
        .update(appSetupState)
        .set({ completedAt: updatedAt })
        .where(eq(appSetupState.id, 1))
        .run()
      if (setupUpdate.changes !== 1) {
        throw new Error('App setup state is missing after migration.')
      }

      return DefaultSessionSettingsRepository.toState(saved)
    })
  }

  private static toState(row: DefaultSessionSettingsRow): DefaultSessionSettingsState {
    return {
      settings: {
        primaryAgentId: row.primaryAgentId,
        agents: {
          claude: { model: row.claudeModel, effort: row.claudeEffort, speed: 'native' },
          codex: { model: row.codexModel, effort: row.codexEffort, speed: 'native' },
        },
        maxDiscussionRounds: row.maxDiscussionRounds,
        maxReviewCycles: row.maxReviewCycles,
        maxRepairAttempts: row.maxRepairAttempts,
      },
      updatedAt: row.updatedAt,
    }
  }
}
