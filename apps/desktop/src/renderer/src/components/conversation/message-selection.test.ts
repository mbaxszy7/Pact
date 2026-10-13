// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearProjectionHighlight,
  focusProjectionRange,
  selectedTextRange,
} from './message-selection'

afterEach(() => {
  clearProjectionHighlight()
  document.body.replaceChildren()
})

describe('message projection selection', () => {
  it('keeps body offsets separate from a nested plan while pulsing the original message owner', () => {
    const message = projectionHost(),
      plan = document.createElement('div')
    plan.dataset.pactPlanRunId = 'frozen-plan'
    plan.innerHTML =
      '<span data-pact-projection-start="0" data-pact-projection-end="5">Delta</span>'
    message.append(plan)
    expect(focusProjectionRange(message, 0, 5, { scroll: false })).toBe(true)
    expect(window.getSelection()?.toString()).toBe('alpha')
    expect(message.dataset.pactCommentPulse).toBe('true')
    expect(plan.dataset.pactCommentPulse).toBeUndefined()
    expect(focusProjectionRange(plan, 0, 5, { scroll: false })).toBe(true)
    expect(window.getSelection()?.toString()).toBe('Delta')
    expect(message.dataset.pactCommentPulse).toBeUndefined()
    expect(plan.dataset.pactCommentPulse).toBe('true')
  })

  it('converts a selection spanning rendered Markdown nodes into its exact projection range', () => {
    const host = projectionHost()
    const selection = window.getSelection()
    const [first, second] = projectionTextNodes(host)
    const range = document.createRange()
    range.setStart(first, 1)
    range.setEnd(second, 2)
    selection?.removeAllRanges()
    selection?.addRange(range)

    expect(selection && selectedTextRange(host, selection)).toEqual({
      startOffset: 1,
      endOffset: 7,
      quote: 'lpha b',
    })
  })

  it('restores only the requested character range instead of selecting an entire projection span', () => {
    const host = projectionHost()
    const scrollIntoView = vi.fn<() => void>()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(),
    })

    focusProjectionRange(host, 2, 7)

    const selection = window.getSelection()
    expect(selection?.toString()).toBe('pha b')
    expect(selection?.getRangeAt(0).startOffset).toBe(2)
    expect(selection?.getRangeAt(0).endOffset).toBe(2)
    expect(scrollIntoView).toHaveBeenCalledOnce()
  })
})

function projectionHost(): HTMLDivElement {
  const host = document.createElement('div')
  host.innerHTML = [
    '<span data-pact-projection-start="0" data-pact-projection-end="5">alpha</span>',
    '<strong><span data-pact-projection-start="5" data-pact-projection-end="11"> bravo</span></strong>',
  ].join('')
  document.body.append(host)
  return host
}

function projectionTextNodes(host: HTMLElement): [Text, Text] {
  const spans = host.querySelectorAll('span')
  const [first, second] = [...spans].map((span) => span.firstChild)
  if (!(first instanceof Text) || !(second instanceof Text)) throw new Error('Expected text nodes.')
  return [first, second]
}
