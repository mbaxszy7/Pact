import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { ClaudeNativePlan, isClaudePlanState } from './claude-native-plan'

const binding = { promptId: 'root-prompt', path: '/native/plans/current.md' }
const write = (plan: ClaudeNativePlan, id: string, text: string) =>
  plan.acknowledge(
    'Write',
    id,
    { file_path: binding.path, content: text },
    { filePath: binding.path, content: text, userModified: false },
  )
const edit = (plan: ClaudeNativePlan, id: string, before: string, after: string, all = false) =>
  plan.acknowledge(
    'Edit',
    id,
    { file_path: binding.path, old_string: before, new_string: after, replace_all: all },
    {
      filePath: binding.path,
      oldString: before,
      newString: after,
      replaceAll: all,
      userModified: false,
    },
  )

describe('Acknowledged Claude native plan operations', () => {
  it('requires an exact bound path and matching native acknowledgement before publishing', () => {
    const plan = new ClaudeNativePlan(binding)
    expect(
      plan.begin('Write', 'foreign', { file_path: '/project/source.ts', content: 'wrong' }),
    ).toBe(false)
    expect(plan.plan).toBeUndefined()
    plan.begin('Write', 'write', { file_path: binding.path, content: 'Scope' })
    expect(plan.plan).toBeUndefined()
    write(plan, 'write', 'Scope')
    expect(plan.plan).toEqual({ nativeId: 'write', text: 'Scope' })
    expect(plan.unavailable).toBe(false)
  })
  it.each([
    { filePath: '/other.md', content: 'Scope', userModified: false },
    { filePath: binding.path, content: 'Changed', userModified: false },
    { filePath: binding.path, content: 'Scope', userModified: true },
    { filePath: binding.path, content: 'Scope' },
  ])('rejects mismatched or unverified acknowledgement %j', (response) => {
    const plan = new ClaudeNativePlan(binding)
    plan.acknowledge('Write', 'write', { file_path: binding.path, content: 'Scope' }, response)
    expect(plan.plan).toBeUndefined()
    expect(plan.unavailable).toBe(true)
  })
  it('keeps duplicate receipts idempotent and rejects conflicting reuse of an operation identity', () => {
    const plan = new ClaudeNativePlan(binding)
    write(plan, 'write', 'Scope')
    write(plan, 'write', 'Scope')
    expect(plan.plan?.text).toBe('Scope')
    write(plan, 'write', 'Changed')
    expect(plan.plan).toBeUndefined()
    expect(plan.unavailable).toBe(true)
    write(plan, 'replacement', 'Complete replacement')
    expect(plan.plan?.text).toBe('Complete replacement')
  })
  it('applies replacement strings literally and supports explicit replace-all', () => {
    const plan = new ClaudeNativePlan(binding)
    write(plan, 'write', 'one one')
    edit(plan, 'edit', 'one', "$& $'", true)
    expect(plan.plan?.text).toBe("$& $' $& $'")
  })
  it('rejects ambiguous edits and does not reconstruct later edits from an invalid prefix', () => {
    const plan = new ClaudeNativePlan(binding)
    write(plan, 'write', 'one one')
    edit(plan, 'ambiguous', 'one', 'two')
    expect(plan.plan).toBeUndefined()
    edit(plan, 'later', 'one one', 'three')
    expect(plan.plan).toBeUndefined()
    write(plan, 'reset', 'A complete new plan')
    expect(plan.plan?.text).toBe('A complete new plan')
  })
  it('rejects overlapping writes even if both report success', () => {
    const plan = new ClaudeNativePlan(binding)
    plan.begin('Write', 'first', { file_path: binding.path, content: 'First' })
    plan.begin('Write', 'second', { file_path: binding.path, content: 'Second' })
    write(plan, 'first', 'First')
    write(plan, 'second', 'Second')
    expect(plan.plan).toBeUndefined()
    expect(plan.unavailable).toBe(true)
  })
  it('invalidates an unfinished or failed operation at native termination', () => {
    const plan = new ClaudeNativePlan(binding, undefined, 'Ancestor')
    plan.begin('Write', 'pending', { file_path: binding.path, content: 'New' })
    plan.finish()
    expect(plan.plan).toBeUndefined()
    expect(plan.unavailable).toBe(true)
    plan.reject('pending')
    expect(plan.isPending('pending')).toBe(false)
  })
  it('retains verified ancestor bytes only on an explicit unchanged submission', () => {
    const plan = new ClaudeNativePlan(binding, undefined, '完整计划')
    expect(plan.plan).toBeUndefined()
    expect(plan.retained('exit')).toBeUndefined()
    plan.noteSubmission('exit', {})
    expect(plan.retained('exit')).toEqual({
      nativeId: 'exit',
      sha256: createHash('sha256').update('完整计划').digest('hex'),
      bytes: Buffer.byteLength('完整计划'),
      chars: '完整计划'.length,
    })
    write(plan, 'write', 'Changed plan')
    expect(plan.retained('exit')).toBeUndefined()
  })
  it('restores pending prefixes without accepting them as complete and isolates snapshots', () => {
    const plan = new ClaudeNativePlan(binding)
    write(plan, 'first', 'Prefix')
    plan.begin('Edit', 'edit', {
      file_path: binding.path,
      old_string: 'Prefix',
      new_string: 'Next',
      replace_all: false,
    })
    const state = plan.snapshot()
    expect(isClaudePlanState(state)).toBe(true)
    const restored = ClaudeNativePlan.restore(binding, state, () => {})
    expect(restored.plan).toBeUndefined()
    edit(restored, 'edit', 'Prefix', 'Next')
    expect(restored.plan?.text).toBe('Next')
    expect(plan.plan).toBeUndefined()
    expect(state.pending).toEqual(['edit'])
  })
  it('rejects invalid persisted state and bounds operation identities', () => {
    const plan = new ClaudeNativePlan(binding)
    for (let i = 0; i < 64; i++) plan.noteSubmission(`exit-${i}`, {})
    expect(() => plan.noteSubmission('overflow', {})).toThrow(/bound/u)
    expect(() => plan.noteSubmission('x'.repeat(1025), {})).toThrow(/bound/u)
    const state = plan.snapshot()
    expect(isClaudePlanState({ ...state, pending: ['unknown'] })).toBe(false)
    expect(isClaudePlanState({ ...state, complete: true })).toBe(false)
    expect(
      isClaudePlanState({ ...state, operations: [...state.operations, state.operations[0]] }),
    ).toBe(false)
  })
  it('reserves full content before publishing and does not truncate a large plan', () => {
    const reserve = vi.fn<(bytes: number) => void>()
    const plan = new ClaudeNativePlan(binding, reserve)
    const text = '完整计划\n'.repeat(10000)
    write(plan, 'write', text)
    expect(plan.plan?.text).toBe(text)
    expect(reserve).toHaveBeenCalledWith(4096 + Buffer.byteLength(text) * 4 + text.length * 2)
    const denied = new ClaudeNativePlan(binding, () => {
      throw new Error('Reservation exhausted')
    })
    expect(() => write(denied, 'write', text)).toThrow('Reservation exhausted')
    expect(denied.plan).toBeUndefined()
  })
})
