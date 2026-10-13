import { sql } from 'drizzle-orm'

import type { PactDrizzleDatabase } from './drizzle-database.js'

import { agentEventJournal } from './schema/index.js'

/** Allocate at insertion, so a nested fact cannot consume a caller's reserved sequence. */
export function appendAgentEvent(
  database: Pick<PactDrizzleDatabase, 'insert'>,
  event: Omit<typeof agentEventJournal.$inferInsert, 'sequence'>,
): number {
  const row = database
    .insert(agentEventJournal)
    .values({
      ...event,
      sequence: sql<number>`(SELECT coalesce(max(${agentEventJournal.sequence}), -1) + 1
        FROM ${agentEventJournal} WHERE ${agentEventJournal.sessionId} = ${event.sessionId})`,
    })
    .returning({ sequence: agentEventJournal.sequence })
    .get()
  if (!row) throw new Error('The Event Journal fact was not appended.')
  return row.sequence
}
