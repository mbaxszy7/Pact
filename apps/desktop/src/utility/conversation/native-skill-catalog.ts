import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'

import {
  nativeSkillSchema,
  SKILL_CATALOG_BYTES,
  SKILL_CATALOG_ITEMS,
  type SkillBinding,
} from '@pact/contracts'

/** Normalize only provider-advertised metadata. No Skill/configuration files are scanned. */
export function nativeSkillCatalog(
  agentId: 'claude' | 'codex',
  cwd: string,
  executablePath: string,
  records: Array<{
    name: string
    description: string
    argumentHint?: string
    path?: string
    scope?: string
    enabled?: boolean
    pluginId?: unknown
  }>,
): SkillBinding[] {
  if (records.length > SKILL_CATALOG_ITEMS)
    throw new Error('The native Skill catalog exceeds its item capacity.')
  const executable = realpathSync(executablePath)
  const info = statSync(executable)
  const executableGeneration = [executable, info.size, info.mtimeMs]
  const result: SkillBinding[] = []
  const names = new Set<string>()
  let bytes = 0
  for (const record of records) {
    if (record.enabled === false) continue
    // Native dispatch by name must have one effective definition, not an invented source picker.
    if (names.has(record.name))
      throw new Error(`The native Skill name /${record.name} is ambiguous.`)
    names.add(record.name)
    const source = record.pluginId
      ? 'plugin'
      : record.scope === 'repo'
        ? 'project'
        : record.scope === 'system' || record.scope === 'user'
          ? record.scope
          : 'native'
    const value = nativeSkillSchema.parse({
      id: createHash('sha256')
        .update(JSON.stringify([agentId, cwd, executableGeneration, record]))
        .digest('hex'),
      agentId,
      name: record.name,
      description: record.description,
      argumentHint: record.argumentHint ?? '',
      source,
    })
    const binding = { ...value, ...(record.path ? { path: record.path } : {}) }
    bytes += Buffer.byteLength(JSON.stringify(binding))
    if (bytes > SKILL_CATALOG_BYTES)
      throw new Error('The native Skill catalog exceeds its byte capacity.')
    result.push(binding)
  }
  // Project Skills are user-authored; keep unknown Native provenance explicit and last.
  const priority = { user: 0, project: 0, system: 1, plugin: 2, native: 3 }
  return result.toSorted(
    (a, b) => priority[a.source] - priority[b.source] || a.name.localeCompare(b.name),
  )
}
