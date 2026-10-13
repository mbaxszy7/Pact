import { describe, expect, it } from 'vitest'

import { nativeSkillCatalog } from './native-skill-catalog.js'

describe('provider-advertised Skill catalog', () => {
  it('excludes disabled entries and orders user/project, system, plugin, then unknown', () => {
    const entries = nativeSkillCatalog('codex', '/owned/project', process.execPath, [
      { name: 'unknown', description: 'Native metadata' },
      { name: 'plugin', description: '', scope: 'user', pluginId: 'fixture-plugin' },
      { name: 'system', description: '', scope: 'system' },
      { name: 'z-user', description: '', scope: 'user' },
      { name: 'a-project', description: '', scope: 'repo' },
      { name: 'disabled', description: '', scope: 'user', enabled: false },
    ])
    expect(entries.map((entry) => [entry.name, entry.source])).toEqual([
      ['a-project', 'project'],
      ['z-user', 'user'],
      ['system', 'system'],
      ['plugin', 'plugin'],
      ['unknown', 'native'],
    ])
  })

  it('keeps native identities stable and invalidates them when effective metadata or CWD changes', () => {
    const records = [
      { name: 'check', description: 'first', path: '/owned/SKILL.md', scope: 'repo' },
    ]
    const first = nativeSkillCatalog('codex', '/owned/project', process.execPath, records)
    expect(nativeSkillCatalog('codex', '/owned/project', process.execPath, records)).toEqual(first)
    expect(nativeSkillCatalog('codex', '/owned/other', process.execPath, records)[0]?.id).not.toBe(
      first[0]?.id,
    )
    expect(
      nativeSkillCatalog('codex', '/owned/project', process.execPath, [
        { ...records[0]!, description: 'changed' },
      ])[0]?.id,
    ).not.toBe(first[0]?.id)
  })

  it('refuses ambiguous names and oversized catalogs rather than truncating them', () => {
    const entry = { name: 'check', description: '' }
    expect(() => nativeSkillCatalog('claude', '/owned', process.execPath, [entry, entry])).toThrow(
      'ambiguous',
    )
    expect(() =>
      nativeSkillCatalog(
        'codex',
        '/owned',
        process.execPath,
        Array.from({ length: 4_097 }, () => entry),
      ),
    ).toThrow('item capacity')
    expect(() =>
      nativeSkillCatalog(
        'codex',
        '/owned',
        process.execPath,
        Array.from({ length: 300 }, (_, index) => ({
          name: `skill-${index}`,
          description: 'x'.repeat(4_096),
        })),
      ),
    ).toThrow('byte capacity')
  })
})
