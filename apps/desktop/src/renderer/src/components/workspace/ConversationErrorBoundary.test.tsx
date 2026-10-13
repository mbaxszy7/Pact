// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConversationErrorBoundary } from './ConversationErrorBoundary'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function ConversationRow({ failed }: { failed: boolean }): React.JSX.Element {
  if (failed) throw new Error('Private Message body must not enter recovery UI')
  return <p>Stored answer</p>
}

function Workspace({ failed }: { failed: boolean }): React.JSX.Element {
  const [draft, setDraft] = useState('Unsent draft')
  return (
    <>
      <nav aria-label="Projects">Project navigation</nav>
      <input
        aria-label="Composer"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <ConversationErrorBoundary>
        <ConversationRow failed={failed} />
      </ConversationErrorBoundary>
    </>
  )
}

describe('Conversation render recovery', () => {
  it('keeps App-owned draft/navigation and remounts only the failed view', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { rerender } = render(<Workspace failed={false} />)
    const composer = screen.getByRole('textbox', { name: 'Composer' })
    if (!(composer instanceof HTMLInputElement)) throw new Error('Composer fixture is missing')
    fireEvent.change(composer, {
      target: { value: 'Draft kept through the fault' },
    })

    rerender(<Workspace failed={true} />)
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t display this conversation')
    expect(screen.queryByText('Private Message body must not enter recovery UI')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Projects' })).not.toBeNull()
    expect(composer.value).toBe('Draft kept through the fault')

    rerender(<Workspace failed={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('Stored answer')).not.toBeNull()
    expect(composer.value).toBe('Draft kept through the fault')
  })

  it('stops local retries after three failures inside one minute', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(
      <ConversationErrorBoundary>
        <ConversationRow failed />
      </ConversationErrorBoundary>,
    )

    now += 1_000
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    now += 1_000
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reload app' })).not.toBeNull()
    expect(screen.getByText('Reloading may discard unsent text.')).not.toBeNull()
  })

  it('does not count failures older than the one-minute window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    render(
      <ConversationErrorBoundary>
        <ConversationRow failed />
      </ConversationErrorBoundary>,
    )

    now += 61_000
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    now += 61_000
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Reload app' })).toBeNull()
  })
})
