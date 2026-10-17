// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceArchivePreview } from '@pact/contracts'

import { ArchiveNotice, type ArchiveResult } from './ArchiveNotice'

afterEach(cleanup)

function archived(title: string): ArchiveResult {
  return {
    id: crypto.randomUUID(),
    item: { kind: 'session', id: crypto.randomUUID(), projectId: crypto.randomUUID(), title },
    state: 'archived',
  }
}

function mixedResults(): ArchiveResult[] {
  const success = archived('Saved work')
  const partial = archived('Project with partial stops')
  const projectId = crypto.randomUUID()
  const preview: WorkspaceArchivePreview = {
    operationId: crypto.randomUUID(),
    scope: { kind: 'project', projectId },
    projectId,
    title: partial.item.title,
    expiresAt: '2026-10-14T06:00:00.000Z',
    tasks: ['Finished reply', 'Stopped reply', 'Unconfirmed reply'].map((title) => ({
      sessionId: crypto.randomUUID(),
      title,
      identity: crypto.randomUUID(),
      state: 'running',
    })),
  }
  const failed: ArchiveResult = {
    ...partial,
    item: { kind: 'project', id: projectId, title: preview.title },
    state: 'failed',
    preview,
    receipt: {
      preview,
      state: 'not_archived',
      message: 'One native task still needs checking.',
      tasks: preview.tasks.map((task, index) => ({
        sessionId: task.sessionId,
        outcome: index === 0 ? 'finished' : index === 1 ? 'stopped' : 'failed',
      })),
    },
  }
  return [success, failed, { ...archived('Lost receipt'), state: 'unresolved' }]
}

function props(results = mixedResults()) {
  return {
    results,
    action: undefined,
    blocked: false,
    onUndo: vi.fn<(result: ArchiveResult) => void>(),
    onCheck: vi.fn<(result: ArchiveResult) => void>(),
    onReview: vi.fn<(result: ArchiveResult) => void>(),
    onDismiss: vi.fn<(id?: string) => void>(),
  }
}

describe('Archive result notice', () => {
  it('summarizes mixed results and routes each visible action to its own item', () => {
    const callbacks = props()
    render(<ArchiveNotice {...callbacks} />)
    expect(screen.getByRole('status').textContent).toBe('1 archived · 1 failed · 1 to check')
    expect(screen.queryByRole('list', { name: 'Individual archive results' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo archive of Saved work' }))
    fireEvent.click(screen.getByRole('button', { name: 'Check archive status of Lost receipt' }))
    expect(callbacks.onUndo).toHaveBeenCalledExactlyOnceWith(callbacks.results[0])
    expect(callbacks.onCheck).toHaveBeenCalledExactlyOnceWith(callbacks.results[2])
    expect(
      screen.queryByRole('button', { name: 'Dismiss archive result for Lost receipt' }),
    ).toBeNull()
  })

  it('shows partial Project Stop outcomes before offering a fresh review', () => {
    const callbacks = props()
    render(<ArchiveNotice {...callbacks} />)
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'View archive failure for Project with partial stops' }),
    )
    const outcomes = screen.getByRole('list', {
      name: 'Stop results for Project with partial stops',
    })
    expect(within(outcomes).getByText('Finished')).not.toBeNull()
    expect(within(outcomes).getByText('Stopped')).not.toBeNull()
    expect(within(outcomes).getByText('Needs checking')).not.toBeNull()
    expect(screen.getByText('One native task still needs checking.')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review again' }))
    expect(callbacks.onReview).toHaveBeenCalledExactlyOnceWith(callbacks.results[1])
    expect(callbacks.onUndo).not.toHaveBeenCalled()
  })

  it('hides previously expanded uncertainty details when the same result becomes archived', () => {
    const previous = archived('Previously uncertain work')
    const uncertain: ArchiveResult = { ...previous, state: 'unresolved' }
    const other = archived('Other saved work')
    const callbacks = props([uncertain, other])
    const view = render(<ArchiveNotice {...callbacks} />)
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    const details = screen.getByRole('button', { name: 'View details' })
    fireEvent.click(details)
    const panelId = details.getAttribute('aria-controls')!
    const panel = document.getElementById(panelId)!
    expect(panel.hidden).toBe(false)
    expect(panel.textContent).toContain('This item has not been archived.')

    view.rerender(<ArchiveNotice {...callbacks} results={[previous, other]} />)

    expect(panel.isConnected).toBe(true)
    expect(panel.hidden).toBe(true)
    expect(screen.queryByRole('button', { name: 'Hide details' })).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Undo archive of Previously uncertain work' }),
    ).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Undo archive of Other saved work' })).not.toBeNull()
    expect(screen.getByRole('status').textContent).toBe('2 archived')
  })

  it('disables mutations while an action is pending and keeps result errors visible', () => {
    const callbacks = props()
    const result = callbacks.results[0]!
    render(
      <ArchiveNotice
        {...callbacks}
        results={[{ ...result, actionError: 'Restore could not be confirmed.' }]}
        action={{ id: result.id, kind: 'restoring' }}
        blocked
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    const undo = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Undo archive of Saved work',
    })
    expect(undo.disabled).toBe(true)
    expect(undo.textContent).toContain('Restoring…')
    fireEvent.click(undo)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss completed archive results' }))
    expect(callbacks.onUndo).not.toHaveBeenCalled()
    expect(callbacks.onDismiss).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Restore could not be confirmed.')
  })

  it('retains access to all 50 results through bounded pages', () => {
    const results = Array.from({ length: 50 }, (_, index) => archived(`Work ${index + 1}`))
    render(<ArchiveNotice {...props(results)} />)
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    const list = screen.getByRole('list', { name: 'Individual archive results' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(10)
    expect(screen.getByText('1–10 of 50')).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Previous' }).disabled).toBe(true)
    for (let page = 0; page < 4; page += 1)
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('41–50 of 50')).not.toBeNull()
    expect(within(list).getByText('Work 50')).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(screen.getByText('31–40 of 50')).not.toBeNull()
  })

  it('clamps the last page after a result is removed', () => {
    const callbacks = props(Array.from({ length: 11 }, (_, index) => archived(`Work ${index + 1}`)))
    const view = render(<ArchiveNotice {...callbacks} />)
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('11–11 of 11')).not.toBeNull()
    view.rerender(<ArchiveNotice {...callbacks} results={callbacks.results.slice(0, 10)} />)
    expect(screen.getByRole('button', { name: 'Undo archive of Work 1' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
  })

  it('collapses with Escape and returns focus to the summary toggle', () => {
    render(<ArchiveNotice {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    const undo = screen.getByRole('button', { name: 'Undo archive of Saved work' })
    undo.focus()
    fireEvent.keyDown(undo, { key: 'Escape' })
    expect(screen.queryByRole('list', { name: 'Individual archive results' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View' }))
  })

  it('restores focus when the currently focused result leaves the list', () => {
    const callbacks = props()
    const view = render(<ArchiveNotice {...callbacks} />)
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    screen.getByRole('button', { name: 'Dismiss archive result for Saved work' }).focus()
    view.rerender(<ArchiveNotice {...callbacks} results={callbacks.results.slice(1)} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Hide' }))
  })
})
