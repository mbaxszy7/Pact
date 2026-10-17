// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopBridge, NativeAttentionPage, NativeSessionRow } from '@pact/contracts'

import { NativeAttentionView } from './NativeAttentionView'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function fixture() {
  const version = { incarnation: crypto.randomUUID(), revision: 1 }
  const rows: NativeSessionRow[] = Array.from({ length: 8 }, (_, index) => ({
    sessionId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    title: `Attention ${index + 1}`,
    projectName: `Project ${(index % 2) + 1}`,
    state: (['approval', 'input', 'recovering', 'attention'] as const)[index % 4]!,
    unread: false,
    jumpListSuppressed: false,
    jumpListRemovalObserved: false,
  }))
  const cursor = { ...version, liveOffset: 5 }
  const first: NativeAttentionPage = {
    version,
    sessions: rows.slice(0, 5),
    total: 8,
    nextCursor: cursor,
  }
  const second: NativeAttentionPage = { version, sessions: rows.slice(5), total: 8 }
  const read = vi
    .fn<DesktopBridge['readNativeAttention']>()
    .mockResolvedValue({ ok: true, value: first })
  const unsubscribe = vi.fn<() => void>()
  let receive: Parameters<DesktopBridge['onNativePresenceChanged']>[0] | undefined
  const subscribe = vi.fn<DesktopBridge['onNativePresenceChanged']>((listener) => {
    receive = listener
    return unsubscribe
  })
  vi.stubGlobal('pact', { readNativeAttention: read, onNativePresenceChanged: subscribe })
  const onBack = vi.fn<() => void>(),
    onOpenSession = vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined)
  return {
    version,
    rows,
    cursor,
    first,
    second,
    read,
    unsubscribe,
    notify: (revision: number) => receive?.({ ...version, revision }),
    onBack,
    onOpenSession,
  }
}

describe('Native attention view through DesktopBridge', () => {
  it('pages mixed pending states five at a time and returns to the first page', async () => {
    const f = fixture()
    render(<NativeAttentionView onBack={f.onBack} onOpenSession={f.onOpenSession} />)
    await screen.findByText('Attention 1')
    expect(
      within(screen.getByRole('list', { name: 'Sessions needing attention' })).getAllByRole(
        'button',
      ),
    ).toHaveLength(5)
    expect(screen.getByText('1–5 of 8')).not.toBeNull()
    f.read.mockResolvedValueOnce({ ok: true, value: f.second })
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByText('Attention 8')
    expect(screen.queryByText('Attention 1')).toBeNull()
    expect(f.read).toHaveBeenNthCalledWith(2, { cursor: f.cursor })
    expect(screen.getByText('6–8 of 8')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'First page' }))
    await screen.findByText('Attention 1')
    expect(f.read).toHaveBeenNthCalledWith(3, {})
  })

  it('coalesces version changes behind one pending read and never publishes its stale page', async () => {
    const f = fixture()
    const oldRead =
      Promise.withResolvers<Awaited<ReturnType<DesktopBridge['readNativeAttention']>>>()
    const freshRead =
      Promise.withResolvers<Awaited<ReturnType<DesktopBridge['readNativeAttention']>>>()
    f.read.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(freshRead.promise)
    render(<NativeAttentionView onBack={f.onBack} onOpenSession={f.onOpenSession} />)
    act(() => {
      f.notify(2)
      f.notify(3)
    })
    expect(f.read).toHaveBeenCalledOnce()
    await act(async () => {
      oldRead.resolve({ ok: true, value: f.first })
    })
    await waitFor(() => expect(f.read).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Attention 1')).toBeNull()
    await act(async () => {
      freshRead.resolve({
        ok: true,
        value: { version: { ...f.version, revision: 3 }, sessions: [f.rows[7]!], total: 1 },
      })
    })
    await screen.findByText('Attention 8')
    expect(screen.getByText('1 Session needs attention')).not.toBeNull()
    expect(f.read).toHaveBeenLastCalledWith({})
  })

  it('opens only the chosen Session once while its navigation is pending', async () => {
    const f = fixture(),
      opening = Promise.withResolvers<void>()
    f.onOpenSession.mockReturnValue(opening.promise)
    render(<NativeAttentionView onBack={f.onBack} onOpenSession={f.onOpenSession} />)
    await screen.findByText('Attention 1')
    const button = screen.getByRole('button', { name: /Attention 1/u })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(f.onOpenSession).toHaveBeenCalledExactlyOnceWith(f.rows[0]!.sessionId)
    expect(screen.getByRole('button', { name: /Attention 2/u }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      opening.resolve()
    })
    expect(screen.getByRole('button', { name: /Attention 2/u }).hasAttribute('disabled')).toBe(
      false,
    )
  })

  it('retries a failed read without navigation and releases its subscription and trigger focus', async () => {
    const f = fixture()
    f.read.mockResolvedValueOnce({
      ok: false,
      error: { code: 'TIMEOUT', message: 'Metadata read timed out.' },
    })
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const view = render(<NativeAttentionView onBack={f.onBack} onOpenSession={f.onOpenSession} />)
    await screen.findByRole('alert')
    expect(screen.getByText('Metadata read timed out.')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }))
    await screen.findByText('Attention 1')
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.onOpenSession).not.toHaveBeenCalled()
    view.unmount()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
