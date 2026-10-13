import { describe, expect, it } from 'vitest'

import {
  composerHasContent,
  composerListCommand,
  editComposerDocument,
  indexComposerLists,
  releaseComposerRoute,
  resolveComposerRoute,
  type ComposerDocument,
} from './composer-document'

const document = (text: string): ComposerDocument => ({ text, skills: [] })
function command(
  value: ComposerDocument,
  start: number,
  action: Parameters<typeof composerListCommand>[2],
) {
  const result = composerListCommand(value, { start, end: start }, action)
  if (!result) throw new Error('Expected an owned list transaction')
  return result
}

describe('canonical list editing', () => {
  it('keeps an arbitrary start and renumbers an inserted middle item', () => {
    const value = document('7. first\n8. second')
    const next = command(value, '7. first'.length, 'break')
    expect(next.document.text).toBe('7. first\n8. \n9. second')
    expect(next.selection).toEqual({ start: 12, end: 12 })
    expect(value.text).toBe('7. first\n8. second')
  })

  it('increments long decimal starts without numeric precision loss', () => {
    const value = document('999999999999999999999999. work')
    expect(command(value, value.text.length, 'break').document.text).toBe(
      '999999999999999999999999. work\n1000000000000000000000000. ',
    )
  })

  it('requires a parent, supports indent/outdent, and refuses a third level', () => {
    const first = document('1. first')
    expect(command(first, first.text.length, 'indent').document).toEqual(first)
    const value = document('1. first\n2. second')
    const child = command(value, value.text.length, 'indent')
    expect(child.document.text).toBe('1. first\n    a. second')
    expect(command(child.document, child.selection.start, 'indent').document).toEqual(
      child.document,
    )
    expect(command(child.document, child.selection.start, 'outdent').document.text).toBe(value.text)
  })

  it('continues child letters from z to aa', () => {
    const value = document(
      '1. parent\n' +
        Array.from(
          { length: 26 },
          (_, index) => `    ${String.fromCharCode(97 + index)}. child`,
        ).join('\n'),
    )
    expect(command(value, value.text.length, 'break').document.text).toBe(value.text + '\n    aa. ')
  })

  it('lifts an empty child and then exits an empty top-level item', () => {
    const value = document('1. parent\n    a. ')
    const lifted = command(value, value.text.length, 'break')
    expect(lifted.document.text).toBe('1. parent\n2. ')
    expect(command(lifted.document, lifted.selection.start, 'break').document.text).toBe(
      '1. parent\n',
    )
    expect(composerHasContent('1. \n    a. ')).toBe(false)
  })

  it('preserves body text when Backspace lifts or removes the list prefix', () => {
    const value = document('1. parent\n    a. child')
    const lifted = command(value, '1. parent\n    a. '.length, 'backspace')
    expect(lifted.document.text).toBe('1. parent\n2. child')
    const plain = command(lifted.document, '1. parent\n2. '.length, 'backspace')
    expect(plain.document.text).toBe('1. parent\nchild')
  })

  it('moves opaque Skill facts with numbering and deletes the whole atom on partial replacement', () => {
    const text = '9. parent\n10. /check body'
    const start = text.indexOf('/check')
    const value: ComposerDocument = {
      text,
      route: { type: 'agent', agentId: 'codex' },
      returnedInputOperationId: '094bfd68-9cc5-44b2-b26e-b5da8569d6d7',
      skills: [{ id: 'a'.repeat(64), agentId: 'codex', name: 'check', start, end: start + 6 }],
    }
    const child = command(value, value.text.length, 'indent').document
    expect(child.text).toBe('9. parent\n    a. /check body')
    expect(child.skills).toEqual([{ ...value.skills[0]!, start: 17, end: 23 }])
    expect(child.route).toEqual(value.route)
    expect(child.returnedInputOperationId).toBe(value.returnedInputOperationId)
    const removed = editComposerDocument(child, { start: 18, end: 19, text: '' }).document
    expect(removed.text).toBe('9. parent\n    a.  body')
    expect(removed.skills).toEqual([])
    expect(value.skills[0]?.start).toBe(start)
  })

  it('refuses oversized list structure without changing the original draft', () => {
    const value = document('1. kept')
    const pasted = Array.from({ length: 1_025 }, (_, index) => `${index + 1}. task`).join('\n')
    expect(() => indexComposerLists(pasted)).toThrow('1,024')
    expect(() =>
      editComposerDocument(value, { start: 0, end: value.text.length, text: pasted }),
    ).toThrow('1,024')
    expect(value).toEqual(document('1. kept'))
  })
})

describe('routing current and returned drafts', () => {
  it('uses current explicit syntax on a new Send of returned input', () => {
    expect(
      resolveComposerRoute(
        {
          ...document('/check @claude task'),
          route: { type: 'primary', agentId: 'codex' },
          returnedInputOperationId: '094bfd68-9cc5-44b2-b26e-b5da8569d6d7',
        },
        'codex',
      ),
    ).toEqual({
      route: { type: 'agent', agentId: 'claude' },
      targets: ['claude'],
      sendRoute: { type: 'agent', agentId: 'claude' },
    })
  })

  it('retains fixed fallback targets until receipt release and then uses current primary', () => {
    const value: ComposerDocument = {
      ...document('task'),
      route: { type: 'primary', agentId: 'codex' },
      returnedInputOperationId: '094bfd68-9cc5-44b2-b26e-b5da8569d6d7',
    }
    expect(resolveComposerRoute(value, 'claude').targets).toEqual(['codex'])
    expect(
      resolveComposerRoute(
        { ...value, route: releaseComposerRoute(value.route), returnedInputOperationId: undefined },
        'claude',
      ).targets,
    ).toEqual(['claude'])
  })
})
