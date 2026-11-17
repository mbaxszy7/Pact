// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionReminder as SessionReminderModel } from '@pact/contracts'

import { SessionReminder } from './SessionReminder'

function makeReminder(overrides: Partial<SessionReminderModel> = {}): SessionReminderModel {
  return {
    id: overrides.id ?? `evt:${crypto.randomUUID()}`,
    sessionId: overrides.sessionId ?? crypto.randomUUID(),
    sessionTitle: overrides.sessionTitle ?? 'Auth fix',
    agentId: overrides.agentId ?? 'codex',
    category: overrides.category ?? 'completed',
    priority: overrides.priority ?? 1,
    createdAt: overrides.createdAt ?? '2026-11-16T10:00:00.000Z',
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SessionReminder rail UI', () => {
  it('renders categories, secondary status, overflow badge (+99+ cap), and animation classes', () => {
    const onView = vi.fn<() => void>()
    const onDismiss = vi.fn<() => void>()

    const view = render(
      <SessionReminder
        reminder={makeReminder({
          id: 'rem-1',
          sessionTitle: 'Refactor runtime',
          agentId: 'claude',
          category: 'needs_input',
          priority: 3,
          secondaryCategory: 'completed',
        })}
        pendingCount={4}
        onView={onView}
        onDismiss={onDismiss}
      />,
    )

    const card = screen.getByRole('status')
    expect(card.getAttribute('data-session-reminder')).toBe('needs_input')
    expect(card.className).toContain('pact-session-reminder')
    expect(card.querySelector('.pact-reminder-icon-pop')).not.toBeNull()
    expect(screen.getByText('Refactor runtime')).not.toBeNull()
    expect(screen.getByText('Claude Code · Needs your input · Finished')).not.toBeNull()

    const badge = screen.getByLabelText('3 more pending')
    expect(badge.textContent).toBe('+3')
    expect(badge.className).toContain('pact-reminder-badge')

    fireEvent.click(screen.getByRole('button', { name: 'View Session' }))
    expect(onView).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Session reminder' }))
    expect(onDismiss).toHaveBeenCalledOnce()

    // Pending count > 99 caps overflow badge at +99+; single pending omits badge.
    view.rerender(
      <SessionReminder
        reminder={makeReminder({
          id: 'rem-2',
          category: 'failure',
          priority: 2,
          agentId: 'codex',
        })}
        pendingCount={120}
        onView={onView}
        onDismiss={onDismiss}
      />,
    )
    expect(screen.getByLabelText('119 more pending').textContent).toBe('+99+')
    expect(screen.getByText('Codex · Failed')).not.toBeNull()

    view.rerender(
      <SessionReminder
        reminder={makeReminder({
          id: 'rem-3',
          category: 'completed',
          priority: 1,
          agentId: 'codex',
        })}
        pendingCount={1}
        onView={onView}
        onDismiss={onDismiss}
      />,
    )
    expect(screen.queryByLabelText(/more pending/u)).toBeNull()
  })

  it('renders overflow summary targets (Review vs View workspace) without pending badge', () => {
    const onView = vi.fn<() => void>()
    const onDismiss = vi.fn<() => void>()

    const view = render(
      <SessionReminder
        reminder={makeReminder({
          id: 'summary:attention',
          sessionTitle: 'More Session updates',
          category: 'needs_input',
          summary: true,
          summaryAttention: 2,
          summaryCompleted: 3,
          summaryTarget: 'attention',
        })}
        pendingCount={5}
        onView={onView}
        onDismiss={onDismiss}
      />,
    )
    expect(screen.getByText('2 need attention · 3 completed')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Review' })).not.toBeNull()
    expect(screen.queryByLabelText(/more pending/u)).toBeNull()

    view.rerender(
      <SessionReminder
        reminder={makeReminder({
          id: 'summary:attention',
          sessionTitle: 'More replies are ready',
          category: 'completed',
          summary: true,
          summaryAttention: 0,
          summaryCompleted: 4,
          summaryTarget: 'workspace',
        })}
        pendingCount={5}
        onView={onView}
        onDismiss={onDismiss}
      />,
    )
    expect(screen.getByText('4 completed')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'View workspace' })).not.toBeNull()
  })

  it('auto-dismisses after 8 seconds, pauses on hover/focus, and resets timer on reminder identity change', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn<() => void>()

    const view = render(
      <SessionReminder
        reminder={makeReminder({ id: 'rem-timer-1' })}
        onView={vi.fn<() => void>()}
        onDismiss={onDismiss}
      />,
    )

    const card = screen.getByRole('status')
    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    expect(onDismiss).not.toHaveBeenCalled()

    // Hovering pauses the timer.
    fireEvent.mouseEnter(card)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(onDismiss).not.toHaveBeenCalled()

    // Focusing while leaving hover still keeps timer paused until blur.
    fireEvent.focus(screen.getByRole('button', { name: 'View Session' }))
    fireEvent.mouseLeave(card)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(onDismiss).not.toHaveBeenCalled()

    // Changing reminder.id resets the full 8-second timer.
    fireEvent.blur(screen.getByRole('button', { name: 'View Session' }))
    view.rerender(
      <SessionReminder
        reminder={makeReminder({ id: 'rem-timer-2' })}
        onView={vi.fn<() => void>()}
        onDismiss={onDismiss}
      />,
    )
    act(() => {
      vi.advanceTimersByTime(7_900)
    })
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('positions above the composer input clearance when aboveComposer is enabled', () => {
    const queued = document.createElement('div')
    queued.className = 'pact-queued-input'
    Object.defineProperty(queued, 'getBoundingClientRect', {
      value: () => ({ top: 700, height: 120, bottom: 820, left: 0, right: 800, width: 800 }),
    })
    document.body.appendChild(queued)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })

    try {
      render(
        <SessionReminder
          reminder={makeReminder({ id: 'rem-composer' })}
          aboveComposer
          onView={vi.fn<() => void>()}
          onDismiss={vi.fn<() => void>()}
        />,
      )
      expect(screen.getByRole('status').style.bottom).toBe('212px')
    } finally {
      queued.remove()
    }
  })
})
