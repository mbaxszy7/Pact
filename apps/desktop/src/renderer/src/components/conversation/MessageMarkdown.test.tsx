// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { markdownVisibleProjection } from '../../../../shared/message-anchor-text'
import { MessageMarkdown, type ProjectFileTarget } from './MessageMarkdown'

afterEach(cleanup)

describe('MessageMarkdown anchor projection', () => {
  it('keeps completed text stable across parent updates and renders changed content', () => {
    const onOpenProjectFile = vi.fn<(target: ProjectFileTarget) => void>()
    const onCreateComment = vi.fn<(selection: unknown) => void>()
    const view = (content: string) => (
      <MessageMarkdown
        content={content}
        messageId="message-1"
        onOpenProjectFile={onOpenProjectFile}
        onCreateComment={onCreateComment}
      />
    )
    const { container, rerender } = render(view('Completed answer'))
    const originalText = container.querySelector('[data-pact-projection-start]')!.firstChild

    rerender(view('Completed answer'))
    expect(container.querySelector('[data-pact-projection-start]')!.firstChild).toBe(originalText)

    rerender(view('Updated answer'))
    expect(container.querySelector('[data-pact-projection-start]')!.textContent).toBe(
      'Updated answer',
    )
  })

  it('keeps completed text nodes and Selection stable when a navigation callback changes', () => {
    const first = vi.fn<(target: ProjectFileTarget) => void>()
    const latest = vi.fn<(target: ProjectFileTarget) => void>()
    const content = 'Selected text [source](src/index.ts)'
    const { container, rerender } = render(
      <MessageMarkdown content={content} onOpenProjectFile={first} />,
    )
    const text = container.querySelector('[data-pact-projection-start]')!.firstChild!
    const range = document.createRange()
    range.selectNodeContents(text)
    globalThis.getSelection()?.removeAllRanges()
    globalThis.getSelection()?.addRange(range)
    rerender(<MessageMarkdown content={content} onOpenProjectFile={latest} />)
    expect(container.querySelector('[data-pact-projection-start]')!.firstChild).toBe(text)
    expect(globalThis.getSelection()?.toString()).toBe('Selected text ')
    fireEvent.click(screen.getByRole('button', { name: 'source' }))
    expect(latest).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
  })
  it.each([
    '<span>hidden</span>\n\nVisible',
    '| Name | Value |\n| --- | --- |\n| one | two |',
    'Use `value_name`.\n\n```ts\nconst answer = 42\n```',
    'Fish &amp; chips 😀',
  ])('matches the durable markdown-visible-v2 projection for %s', (markdown) => {
    const { container } = render(
      <MessageMarkdown content={markdown} onOpenProjectFile={() => undefined} />,
    )
    const rendererProjection = [
      ...container.querySelectorAll<HTMLElement>('[data-pact-projection-start]'),
    ]
      .map((span) => span.textContent)
      .join('')

    expect(rendererProjection).toBe(markdownVisibleProjection(markdown))
  })

  it('closes the Add comment bubble when pointer interaction starts outside it', () => {
    const onCreateComment = vi.fn<(selection: unknown) => void>()
    const { container } = render(
      <MessageMarkdown
        content="Selectable text"
        messageId="message-1"
        onCreateComment={onCreateComment}
        onOpenProjectFile={() => undefined}
      />,
    )
    const host = container.firstElementChild
    const span = container.querySelector<HTMLElement>('[data-pact-projection-start]')
    const text = span?.firstChild
    if (!(host instanceof HTMLElement) || !(text instanceof Text)) {
      throw new Error('Message fixture did not render its projection.')
    }
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
    fireEvent.mouseDown(host)
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 10)
    installRangeGeometry(range)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.mouseUp(host)
    expect(screen.getByRole('button', { name: 'Comment on selected text' })).not.toBeNull()

    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('button', { name: 'Comment on selected text' })).toBeNull()
  })

  it('captures a complete Message selection when the mouse is released outside the Message', () => {
    const { container } = render(
      <MessageMarkdown
        content="Complete message selection"
        messageId="message-1"
        onCreateComment={() => undefined}
        onOpenProjectFile={() => undefined}
      />,
    )
    const host = container.firstElementChild
    const content = container.querySelector<HTMLElement>('[data-pact-message-content]')
    if (!(host instanceof HTMLElement) || !content) {
      throw new Error('Message fixture did not render its content.')
    }
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
    fireEvent.mouseDown(host)
    const range = document.createRange()
    range.selectNodeContents(content)
    installRangeGeometry(range)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.mouseUp(document.body)

    expect(screen.getByRole('button', { name: 'Comment on selected text' })).not.toBeNull()
  })
})

function installRangeGeometry(range: Range): void {
  Object.defineProperties(range, {
    getClientRects: {
      configurable: true,
      value: () => [{ left: 40, top: 40, right: 140, bottom: 60, width: 100, height: 20 }],
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ left: 40, top: 40, right: 140, bottom: 60, width: 100, height: 20 }),
    },
  })
}
