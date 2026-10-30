// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { InputReplacement } from './InputReplacement'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn<() => void>(),
    removeEventListener: vi.fn<() => void>(),
  }))
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(
    Object.assign([new DOMRect(0, 0, 100, 30)], {
      item: (index: number) => (index === 0 ? new DOMRect(0, 0, 100, 30) : null),
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('keeps the ordinary draft mounted and moves owned focus to the question and back', () => {
  const editor = <textarea aria-label="Message" defaultValue="My unfinished draft" />
  const replacement = { key: 'decision-1', content: <textarea aria-label="Answer" /> }
  const view = render(<InputReplacement>{editor}</InputReplacement>)
  const message = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' })
  message.focus()
  message.setSelectionRange(3, 8)
  view.rerender(<InputReplacement replacement={replacement}>{editor}</InputReplacement>)
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Answer' }))
  expect(message.closest('[inert]')).not.toBeNull()
  expect(message.value).toBe('My unfinished draft')
  view.rerender(<InputReplacement>{editor}</InputReplacement>)
  expect(document.activeElement).toBe(message)
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(message)
  expect(message.value).toBe('My unfinished draft')
  expect(view.container.querySelector('[aria-label="Answer"]')?.closest('[inert]')).not.toBeNull()
  act(() => {
    vi.advanceTimersByTime(220)
  })
  expect(view.container.querySelector('[aria-label="Answer"]')).toBeNull()
})
it('does not steal focus from an outside editor and cancels obsolete exit cleanup on a new decision', () => {
  const editor = <textarea aria-label="Message" defaultValue="Saved" />
  const first = { key: 'first', content: <textarea aria-label="First answer" /> }
  const view = render(
    <>
      <button>Outside</button>
      <InputReplacement>{editor}</InputReplacement>
    </>,
  )
  screen.getByRole('button', { name: 'Outside' }).focus()
  view.rerender(
    <>
      <button>Outside</button>
      <InputReplacement replacement={first}>{editor}</InputReplacement>
    </>,
  )
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Outside' }))
  view.rerender(
    <>
      <button>Outside</button>
      <InputReplacement>{editor}</InputReplacement>
    </>,
  )
  const next = { key: 'next', content: <textarea aria-label="Next answer" /> }
  view.rerender(
    <>
      <button>Outside</button>
      <InputReplacement replacement={next}>{editor}</InputReplacement>
    </>,
  )
  act(() => {
    vi.advanceTimersByTime(500)
  })
  expect(screen.getByRole('textbox', { name: 'Next answer' })).toBeDefined()
  expect(view.container.querySelector('[aria-label="First answer"]')).toBeNull()
})
it('skips disabled controls, focuses status-only replacements, and respects outside pointer intent', () => {
  const editor = <textarea aria-label="Message" />
  const view = render(<InputReplacement>{editor}</InputReplacement>)
  screen.getByRole('textbox').focus()
  view.rerender(
    <InputReplacement
      replacement={{
        key: 'blocked',
        content: (
          <>
            <input aria-label="Disabled" disabled />
            <p>Waiting for receipt</p>
          </>
        ),
      }}
    >
      {editor}
    </InputReplacement>,
  )
  expect(document.activeElement?.getAttribute('data-active')).toBe('true')
  fireEvent.pointerDown(document.body)
  view.rerender(<InputReplacement>{editor}</InputReplacement>)
  expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Message' }))
})
