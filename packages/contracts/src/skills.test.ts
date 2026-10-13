import { describe, expect, it } from 'vitest'

import { conversationSendInputSchema } from './index.js'
import {
  frozenSkillInvocationSchema,
  parseComposerCommandPrefix,
  skillArguments,
  SKILL_CATALOG_ITEMS,
  type SkillSelection,
} from './skills.js'

const selected = (name: string, start: number): SkillSelection => ({
  id: 'a'.repeat(64),
  agentId: 'codex',
  name,
  start,
  end: start + name.length + 1,
})

describe('Composer command boundary', () => {
  it.each(['/first @claude /second', '@claude /first /second'])(
    'routes %s and shares the exact trailing task across all Skills',
    (commands) => {
      const content = `${commands} --flag 中文\nnext line`
      const prefix = parseComposerCommandPrefix(content)
      expect(prefix.error).toBeUndefined()
      expect(prefix.route).toEqual({ type: 'agent', agentId: 'claude' })
      expect(prefix.skills.map((entry) => entry.name)).toEqual(['first', 'second'])
      expect(skillArguments(content, [])).toBe('--flag 中文\nnext line')
    },
  )

  it('keeps body references and code text out of explicit command syntax', () => {
    const content = '请解释 /check 和 @claude，代码：`/other`'
    expect(parseComposerCommandPrefix(content)).toEqual({ skills: [], argumentsStart: 0 })
    expect(skillArguments(content, [])).toBe(content)
  })

  it('uses the opaque Skill range rather than absorbing an adjacent suffix', () => {
    const content = '/checkX @claude task'
    const selection = selected('check', 0)
    expect(parseComposerCommandPrefix(content, [selection]).route).toBeUndefined()
    expect(parseComposerCommandPrefix(content, [selection]).skills).toEqual([
      { name: 'check', start: 0, end: 6 },
    ])
    expect(skillArguments(content, [selection])).toBe('X @claude task')
    expect(parseComposerCommandPrefix(content).skills[0]?.name).toBe('checkX')
  })

  it('supports adjacent owned atoms and UTF-16 task text', () => {
    const content = '/check/other😀 task'
    const selections = [selected('check', 0), selected('other', 6)]
    expect(
      parseComposerCommandPrefix(content, selections).skills.map((entry) => entry.name),
    ).toEqual(['check', 'other'])
    expect(skillArguments(content, selections)).toBe('😀 task')
  })

  it('rejects conflicting targets and corrupted/overlapping selected ranges', () => {
    expect(parseComposerCommandPrefix('/check @codex @claude task').error).toContain('one target')
    const selection = selected('check', 0)
    for (const selections of [[selection, selection], [{ ...selection, end: 5 }]]) {
      expect(parseComposerCommandPrefix('/check task', selections).error).toBeDefined()
      expect(() => skillArguments('/check task', selections)).toThrow(
        'selected Skill token changed',
      )
    }
  })

  it('refuses a command area over its bound without silently dropping a Skill', () => {
    const content = '/x '.repeat(SKILL_CATALOG_ITEMS + 1) + 'task'
    expect(parseComposerCommandPrefix(content).error).toContain('capacity')
    expect(() => skillArguments(content, [])).toThrow('capacity')
  })
})

describe('Skill trust and payload bounds', () => {
  it('refuses private binding data supplied through Renderer selections', () => {
    expect(
      conversationSendInputSchema.safeParse({
        sessionId: 'ae0f7eea-9fdc-4fcd-9c38-4af81c0e41dc',
        clientMessageId: 'bcd5b50f-4fb1-45a1-8220-d828bb897551',
        content: '/check task',
        expectedCommentsRevision: 0,
        commentIds: [],
        skills: [{ ...selected('check', 0), path: '/private/SKILL.md' }],
      }).success,
    ).toBe(false)
  })

  it('bounds complete frozen metadata while retaining shared task arguments', () => {
    const invocation = {
      version: 'pact-skills-v1',
      arguments: 'task',
      selections: [],
      bindings: Array.from({ length: 20 }, (_, index) => ({
        id: 'a'.repeat(64),
        agentId: 'codex',
        name: `skill-${index}`,
        description: 'd'.repeat(4_096),
        argumentHint: '',
        source: 'user',
      })),
    }
    expect(frozenSkillInvocationSchema.safeParse(invocation).success).toBe(false)
    expect(
      frozenSkillInvocationSchema.parse({
        ...invocation,
        bindings: invocation.bindings.slice(0, 2),
      }).arguments,
    ).toBe('task')
  })
})
