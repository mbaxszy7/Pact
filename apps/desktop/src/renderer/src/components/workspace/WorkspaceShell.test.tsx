// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { WorkspaceShell } from './WorkspaceShell'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn<() => void>(),
    removeEventListener: vi.fn<() => void>(),
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Owner({
  host,
  mounted,
  disposed,
}: {
  host: HTMLElement | null
  mounted: () => void
  disposed: () => void
}) {
  const [draft, setDraft] = useState('')
  useEffect(() => {
    mounted()
    return disposed
  }, [mounted, disposed])
  return (
    <>
      <p>Conversation owner</p>
      {host
        ? createPortal(
            <label>
              Plan comment
              <input value={draft} onChange={(event) => setDraft(event.target.value)} />
            </label>,
            host,
          )
        : null}
    </>
  )
}
function Fixture({
  expanded,
  mounted,
  disposed,
}: {
  expanded: boolean
  mounted: () => void
  disposed: () => void
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  return (
    <WorkspaceShell
      navigation={<p>Sessions</p>}
      workspace={<Owner host={host} mounted={mounted} disposed={disposed} />}
      contextPanel={<div ref={setHost} />}
      contextPanelOpen
      contextPanelExpanded={expanded}
      contextPanelWidthLimited={false}
    />
  )
}

it.each([1440, 1000, 800])(
  'keeps the workspace portal owner and document mounted through expand and restore at %i px',
  (width) => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: width >= (query.includes('1100') ? 1100 : 860),
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    }))
    vi.stubGlobal('scrollTo', vi.fn<() => void>())
    const mounted = vi.fn<() => void>()
    const disposed = vi.fn<() => void>()
    const view = render(<Fixture expanded={false} mounted={mounted} disposed={disposed} />)
    const editor = screen.getByRole<HTMLInputElement>('textbox', { name: 'Plan comment' })
    fireEvent.change(editor, { target: { value: 'Unsaved comment' } })
    for (const expanded of [true, false, true, false]) {
      act(() =>
        view.rerender(<Fixture expanded={expanded} mounted={mounted} disposed={disposed} />),
      )
      expect(screen.getByRole('textbox', { name: 'Plan comment' })).toBe(editor)
      expect(editor.value).toBe('Unsaved comment')
      expect(mounted).toHaveBeenCalledOnce()
      expect(disposed).not.toHaveBeenCalled()
      const center = view.container.querySelector('#workspace-center')!
      expect(center.getAttribute('aria-hidden')).toBe(String(expanded))
      expect(center.hasAttribute('inert')).toBe(expanded)
      const surface =
        width >= 1100
          ? screen.getByRole('separator', { name: 'Resize context panel' })
          : screen.getByRole('dialog', { name: 'Context panel' })
      expect(surface.getAttribute(width >= 1100 ? 'data-open' : 'data-expanded')).toBe(
        String(width >= 1100 ? !expanded : expanded),
      )
    }
    view.unmount()
    expect(disposed).toHaveBeenCalledOnce()
  },
)
