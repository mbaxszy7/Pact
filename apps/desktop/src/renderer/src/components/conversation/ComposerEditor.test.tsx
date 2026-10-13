// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComposerEditCommand } from '@pact/contracts'

import type { ComposerDocument } from './composer-document'

import { composerBridgeFixture } from './composer.test-helper'
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor'

const rectangle = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
beforeEach(() => {
  // jsdom has no layout. These tests cover editing facts; Electron covers native caret placement.
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (rectangle) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rectangle)
  else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
})

function mount(value: ComposerDocument = { text: 'kept', skills: [] }) {
  const bridge = composerBridgeFixture()
  vi.stubGlobal('pact', bridge)
  const ref = createRef<ComposerEditorHandle>()
  const onNotice = vi.fn<(message: string) => void>(),
    onChange = vi.fn<(document: ComposerDocument, cursor: number, composing: boolean) => void>(),
    onCursor = vi.fn<(cursor: number) => void>(),
    onSkillOpen = vi.fn<(skill: ComposerDocument['skills'][number]) => void>()
  const onKeyDown = vi.fn<(event: KeyboardEvent) => void>((event) => {
    if (event.key.startsWith('Arrow')) event.preventDefault()
  })
  const rendered = render(
    <ComposerEditor
      value={value}
      disabled={false}
      placeholder="Message"
      onChange={onChange}
      onNotice={onNotice}
      onCursor={onCursor}
      onKeyDown={onKeyDown}
      onSkillOpen={onSkillOpen}
      expanded={false}
      editorRef={ref}
    />,
  )
  const editor = screen.getByRole('combobox', { name: 'Message' })
  act(() => ref.current!.focus())
  const select = (start: number, end = start) => act(() => ref.current!.select(start, end))
  const paste = (text: string) =>
    fireEvent.paste(editor, {
      clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') },
    })
  return {
    ...rendered,
    bridge,
    ref,
    editor,
    select,
    paste,
    onNotice,
    onChange,
    onCursor,
    onSkillOpen,
  }
}

function beforeInput(
  editor: HTMLElement,
  inputType: string,
  cancelable = true,
  data: string | null = null,
) {
  const event = new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable })
  Object.defineProperty(event, 'getTargetRanges', { value: () => [] })
  fireEvent(editor, event)
  return event
}

describe('native Composer editing boundary', () => {
  it('publishes an empty draft after native Delete leaves BR with an empty Text sibling', () => {
    const value = mount()
    value.select(0, 4)
    beforeInput(value.editor, 'deleteContentForward')
    value.editor.replaceChildren(
      window.document.createElement('br'),
      window.document.createTextNode(''),
    )
    fireEvent.input(value.editor)
    expect(value.ref.current!.document().text).toBe('')
    expect(value.onChange.mock.lastCall?.[0].text).toBe('')
    expect(value.ref.current!.selection()).toEqual({ start: 0, end: 0 })
  })

  it.each(['\n', ' '])('preserves a meaningful %j Text sibling beside a native BR', (text) => {
    const value = mount()
    value.editor.replaceChildren(
      window.document.createElement('br'),
      window.document.createTextNode(text),
    )
    value.select(2)
    fireEvent.input(value.editor)
    expect(value.ref.current!.document().text).toBe('\n' + text)
    expect(value.ref.current!.selection()).toEqual({ start: 2, end: 2 })
  })

  it('suppresses repeated refused edits, preserves the draft, and resets after a valid edit', () => {
    const value = mount()
    const oversized = Array.from({ length: 1_025 }, (_, index) => `${index + 1}. task`).join('\n')
    value.select(0, 4)
    value.paste(oversized)
    value.paste(oversized)
    value.paste(oversized)
    expect(value.onNotice).toHaveBeenCalledTimes(1)
    expect(value.ref.current!.document().text).toBe('kept')
    expect(value.onChange).not.toHaveBeenCalled()
    value.paste('fixed')
    expect(value.ref.current!.document().text).toBe('fixed')
    value.select(0, 5)
    value.paste(oversized)
    expect(value.onNotice).toHaveBeenCalledTimes(2)
    expect(value.ref.current!.document().text).toBe('fixed')
  })

  it('preserves target facts during native formatting while genuine same-text paste replaces them', () => {
    const document: ComposerDocument = {
      text: '@claude task',
      skills: [],
      route: { type: 'agent', agentId: 'claude' },
      mention: { token: '@claude', start: 0, end: 7, route: { type: 'agent', agentId: 'claude' } },
    }
    const value = mount(document)
    value.select(0, 7)
    expect(beforeInput(value.editor, 'formatBold').defaultPrevented).toBe(true)
    expect(value.ref.current!.document()).toEqual(document)
    beforeInput(value.editor, 'formatBold', false)
    const bold = window.document.createElement('b')
    bold.textContent = document.text
    value.editor.replaceChildren(bold)
    fireEvent.input(value.editor)
    expect(value.ref.current!.document()).toEqual(document)
    expect(value.onChange).not.toHaveBeenCalled()
    expect(value.onNotice).not.toHaveBeenCalled()
    value.select(0, 7)
    value.paste('@claude')
    expect(value.ref.current!.document()).toMatchObject({
      text: document.text,
      route: { type: 'primary' },
    })
    expect(value.ref.current!.document().mention).toBeUndefined()
    fireEvent.keyDown(value.editor, { key: 'z', ctrlKey: true })
    expect(value.ref.current!.document()).toEqual(document)
  })

  it('opens and atomically deletes only the focused repeated Skill, then restores both with Undo', () => {
    const document: ComposerDocument = {
      text: '/check /check body',
      skills: [0, 7].map((start) => ({
        id: 'a'.repeat(64),
        agentId: 'codex',
        name: 'check',
        start,
        end: start + 6,
      })),
    }
    const value = mount(document)
    const buttons = screen.getAllByRole('button', { name: 'Open Codex Skill check' })
    fireEvent.click(buttons[1]!)
    expect(value.onSkillOpen).toHaveBeenCalledWith(document.skills[1])
    fireEvent.keyDown(buttons[1]!, { key: 'Backspace' })
    expect(value.ref.current!.document().text).toBe('/check  body')
    expect(value.ref.current!.document().skills).toEqual([document.skills[0]])
    fireEvent.keyDown(value.editor, { key: 'z', ctrlKey: true })
    expect(value.ref.current!.document()).toEqual(document)
    expect(screen.getAllByRole('button', { name: 'Open Codex Skill check' })).toHaveLength(2)
  })

  it('ignores the owned trailing placeholder BR without discarding an authored LF', () => {
    const skill = { id: 'a'.repeat(64), agentId: 'codex' as const, name: 'check', start: 0, end: 6 }
    const value = mount({ text: '/check ', skills: [skill] })
    value.select(6, 7)
    beforeInput(value.editor, 'deleteContentBackward')
    value.editor.lastChild!.remove()
    value.editor.appendChild(window.document.createElement('br'))
    fireEvent.input(value.editor)
    expect(value.ref.current!.document()).toEqual({
      text: '/check',
      skills: [skill],
      mention: undefined,
      route: undefined,
    })
    value.select(6)
    // Noncancelable native input owns the following DOM mutation; cancelable
    // text input is already applied by the editor and must not be applied twice.
    beforeInput(value.editor, 'insertText', false, 'X')
    value.editor.lastChild!.remove()
    value.editor.appendChild(window.document.createTextNode('X'))
    fireEvent.input(value.editor)
    expect(value.ref.current!.document().text).toBe('/checkX')
    value.select(7)
    beforeInput(value.editor, 'insertLineBreak')
    expect(value.ref.current!.document().text).toBe('/checkX\n')
    value.select(8)
    beforeInput(value.editor, 'insertText', false, 'next')
    value.editor.lastChild!.before(window.document.createTextNode('next'))
    fireEvent.input(value.editor)
    expect(value.ref.current!.document().text).toBe('/checkX\nnext')
    expect(value.ref.current!.document().skills).toEqual([skill])
    expect(value.onNotice).not.toHaveBeenCalled()
  })

  it('notifies cursor changes only after the position changes, preserving consumed menu navigation', () => {
    const value = mount({ text: '/', skills: [] })
    value.select(1)
    fireEvent.keyDown(value.editor, { key: 'ArrowDown' })
    fireEvent.keyUp(value.editor, { key: 'ArrowDown' })
    expect(value.onCursor).not.toHaveBeenCalled()
    value.select(0)
    fireEvent.keyUp(value.editor, { key: 'ArrowLeft' })
    fireEvent.keyUp(value.editor, { key: 'ArrowUp' })
    expect(value.onCursor.mock.calls).toEqual([[0]])
  })

  it('settles native Undo once and releases the subscription and editing state on unmount', () => {
    const value = mount()
    const unsubscribe = value.bridge.onComposerEditCommand.mock.results[0]!.value
    value.select(0, 4)
    value.paste('new')
    const ownerId = value.bridge.setComposerEditingState.mock.lastCall![0].ownerId
    const command: ComposerEditCommand = {
      ownerId,
      requestId: crypto.randomUUID(),
      action: 'undo',
      expiresAt: Date.now() + 1_000,
    }
    act(() => value.bridge.onComposerEditCommand.mock.calls[0]![0](command))
    expect(value.ref.current!.document().text).toBe('kept')
    expect(value.bridge.settleComposerEdit).toHaveBeenCalledWith({
      ownerId,
      requestId: command.requestId,
      disposition: 'handled',
    })
    value.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(value.bridge.setComposerEditingState.mock.lastCall![0]).toMatchObject({
      focused: false,
      editable: false,
      composing: false,
      canUndo: false,
      canRedo: false,
    })
  })

  it('does not send or alter canonical history while composition is active', () => {
    const value = mount()
    value.select(4)
    fireEvent.compositionStart(value.editor)
    fireEvent.keyDown(value.editor, { key: 'Enter', isComposing: true })
    expect(value.onChange).not.toHaveBeenCalled()
    fireEvent.compositionEnd(value.editor)
    expect(value.ref.current!.document().text).toBe('kept')
    expect(value.onNotice).not.toHaveBeenCalled()
  })
})
