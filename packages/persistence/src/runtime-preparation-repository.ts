import { eq } from 'drizzle-orm'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { appSetupState, runtimeCliPaths } from './schema/index.js'

export type RuntimeAgentId = 'claude' | 'codex'

export interface RuntimePreparationRepository {
  hasCompletedFirstUseSetup(): boolean
  readSelectedExecutablePath(agentId: RuntimeAgentId): string | undefined
  saveSelectedExecutablePath(agentId: RuntimeAgentId, executablePath: string): void
}

export class DrizzleRuntimePreparationRepository implements RuntimePreparationRepository {
  constructor(private readonly database: PactDrizzleDatabase) {}

  hasCompletedFirstUseSetup(): boolean {
    const row = this.database
      .select({ completedAt: appSetupState.completedAt })
      .from(appSetupState)
      .where(eq(appSetupState.id, 1))
      .get()

    if (!row) throw new Error('App setup state is missing after migration.')
    return row.completedAt !== null
  }

  readSelectedExecutablePath(agentId: RuntimeAgentId): string | undefined {
    return this.database
      .select({ executablePath: runtimeCliPaths.executablePath })
      .from(runtimeCliPaths)
      .where(eq(runtimeCliPaths.agentId, agentId))
      .get()?.executablePath
  }

  saveSelectedExecutablePath(agentId: RuntimeAgentId, executablePath: string): void {
    const updatedAt = new Date().toISOString()
    this.database
      .insert(runtimeCliPaths)
      .values({ agentId, executablePath, updatedAt })
      .onConflictDoUpdate({
        target: runtimeCliPaths.agentId,
        set: { executablePath, updatedAt },
      })
      .run()
  }
}
