// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceArchivePreview, WorkspaceArchiveReceipt } from '@pact/contracts'

import { ArchiveConfirmation } from './ArchiveConfirmation'

const showDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false
    },
  })
})
afterEach(() => {
  cleanup()
  for (const [name, descriptor] of [
    ['showModal', showDescriptor],
    ['close', closeDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  }
})

function props() {
  const projectId = crypto.randomUUID()
  const preview: WorkspaceArchivePreview = {
    operationId: crypto.randomUUID(),
    scope: { kind: 'project', projectId },
    projectId,
    title: 'Current Project',
    expiresAt: '2026-10-14T06:00:00.000Z',
    tasks: ['Reply in progress', 'Preparation in progress'].map((title, index) => ({
      sessionId: crypto.randomUUID(),
      title,
      identity: crypto.randomUUID(),
      state: index ? 'preparing' : 'running',
    })),
  }
  return {
    preview,
    busy: false,
    onCancel: vi.fn<() => void>(),
    onConfirm: vi.fn<() => void>(),
    onCheck: vi.fn<() => void>(),
    onReview: vi.fn<() => void>(),
  }
}

describe('Archive confirmation', () => {
  it('focuses Cancel, requires explicit confirmation, and restores the trigger focus', () => {
    const callbacks = props()
    const trigger = document.createElement('button')
    trigger.textContent = 'Archive Project'
    document.body.append(trigger)
    trigger.focus()
    const view = render(<ArchiveConfirmation {...callbacks} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      screen.getByText('Archiving this Project will stop its 2 active Sessions first.'),
    ).not.toBeNull()
    expect(callbacks.onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop and archive' }))
    expect(callbacks.onConfirm).toHaveBeenCalledOnce()
    view.unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('handles Escape as cancellation only before stopping begins', () => {
    const callbacks = props()
    const view = render(<ArchiveConfirmation {...callbacks} />)
    const dialog = screen.getByRole('dialog')
    const cancel = new Event('cancel', { bubbles: false, cancelable: true })
    fireEvent(dialog, cancel)
    expect(cancel.defaultPrevented).toBe(true)
    expect(callbacks.onCancel).toHaveBeenCalledOnce()
    view.rerender(<ArchiveConfirmation {...callbacks} busy />)
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stopping…' }))
    expect(callbacks.onCancel).toHaveBeenCalledOnce()
    expect(callbacks.onConfirm).not.toHaveBeenCalled()
    expect(dialog.getAttribute('aria-busy')).toBe('true')
    for (const button of within(dialog).getAllByRole<HTMLButtonElement>('button'))
      expect(button.disabled).toBe(true)
  })

  it('offers only a status read when the receipt is absent or unresolved', () => {
    const callbacks = props()
    const view = render(
      <ArchiveConfirmation {...callbacks} uncertain error="The result could not be confirmed." />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }))
    expect(callbacks.onCheck).toHaveBeenCalledOnce()
    expect(callbacks.onReview).not.toHaveBeenCalled()
    expect(callbacks.onConfirm).not.toHaveBeenCalled()
    const receipt: WorkspaceArchiveReceipt = {
      preview: callbacks.preview,
      state: 'unresolved',
      tasks: [],
    }
    view.rerender(<ArchiveConfirmation {...callbacks} receipt={receipt} />)
    expect(screen.getByRole('button', { name: 'Check status' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop and archive' })).toBeNull()
  })

  it('shows partial Stop results and asks to review again after a confirmed failure', () => {
    const callbacks = props()
    const receipt: WorkspaceArchiveReceipt = {
      preview: callbacks.preview,
      state: 'not_archived',
      message: 'Not all tasks could be stopped.',
      tasks: callbacks.preview.tasks.map((task, index) => ({
        sessionId: task.sessionId,
        outcome: index ? 'failed' : 'stopped',
      })),
    }
    render(<ArchiveConfirmation {...callbacks} receipt={receipt} />)
    expect(screen.getByText('Stopped')).not.toBeNull()
    expect(screen.getByText('Needs checking')).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(receipt.message)
    expect(screen.getByText(/Tasks already stopped will not restart automatically/)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review again' }))
    expect(callbacks.onReview).toHaveBeenCalledOnce()
    expect(callbacks.onConfirm).not.toHaveBeenCalled()
  })

  it('does not offer Stop when preflight finds unsupported native ownership', () => {
    const callbacks = props()
    render(
      <ArchiveConfirmation
        {...callbacks}
        preview={{ ...callbacks.preview, blockedReason: 'Check the detached native task first.' }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Cannot archive yet' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop and archive' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(callbacks.onCancel).toHaveBeenCalledOnce()
    expect(callbacks.onConfirm).not.toHaveBeenCalled()
  })
})
