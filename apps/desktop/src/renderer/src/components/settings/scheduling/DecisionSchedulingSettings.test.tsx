// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DesktopBridge,
  RpcResult,
  RelayCredentialReceipt,
  SchedulingActivityPage,
  SchedulingActivityRow,
  SchedulingSettings,
  SchedulingState,
} from '@pact/contracts'

import { OPENAI_DECISION_MODEL, schedulingActivityPageSchema } from '@pact/contracts'

import { DecisionSchedulingSettings, useSchedulingSettings } from './DecisionSchedulingSettings'

const timestamp = '2026-10-22T00:00:00.000Z'
const settings = (overrides: Partial<SchedulingSettings> = {}): SchedulingSettings => ({
  enabled: false,
  provider: 'openai',
  model: OPENAI_DECISION_MODEL,
  credential: { configured: false, revision: 0 },
  showIndicator: true,
  revision: 0,
  updatedAt: timestamp,
  ...overrides,
})
const empty: SchedulingActivityPage = { asOf: timestamp, rows: [], nextCursor: null }
const observedState = (value: SchedulingSettings, sessionId?: string): SchedulingState => ({
  settings: value,
  configurationGeneration: value.revision,
  connection: { status: 'unconfirmed', checkedAt: null, expiresAt: null },
  context: sessionId
    ? {
        sessionId,
        eligibility: !value.enabled
          ? 'disabled'
          : value.credential.configured
            ? 'unconfirmed'
            : 'key_required',
      }
    : null,
  activity: { decision: { status: 'idle' }, check: { status: 'idle' } },
})
function row(index: number, overrides: Partial<SchedulingActivityRow> = {}): SchedulingActivityRow {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    createdAt: new Date(Date.parse(timestamp) - index * 1000).toISOString(),
    project: 'Project',
    session: 'Session',
    provider: 'openai',
    model: OPENAI_DECISION_MODEL,
    reason: 'workflow',
    result: 'not_sent',
    called: false,
    physicalUnconfirmed: false,
    suggestion: null,
    ...overrides,
  }
}
function fixture(initial = settings()) {
  let value = initial
  const listeners = new Set<() => void>()
  const bridge = {
    getSchedulingState: vi.fn<DesktopBridge['getSchedulingState']>(async (input) => ({
      ok: true as const,
      value: observedState(value, input?.sessionId),
    })),
    saveSchedulingSettings: vi.fn<DesktopBridge['saveSchedulingSettings']>(async (input) => {
      value = settings({
        ...value,
        enabled: input.enabled ?? value.enabled,
        showIndicator: input.showIndicator ?? value.showIndicator,
        revision: value.revision + 1,
      })
      return { ok: true as const, value }
    }),
    saveRelayApiKey: vi.fn<DesktopBridge['saveRelayApiKey']>(async (input) => {
      value = settings({
        ...value,
        credential: { configured: true, revision: value.credential.revision + 1 },
        revision: value.revision + 1,
      })
      return {
        ok: true as const,
        value: {
          nonce: input.nonce,
          operation: 'save' as const,
          revision: value.credential.revision,
          configured: true,
        } satisfies RelayCredentialReceipt,
      }
    }),
    removeRelayApiKey: vi.fn<DesktopBridge['removeRelayApiKey']>(async (input) => {
      value = settings({
        ...value,
        credential: { configured: false, revision: value.credential.revision + 1 },
        revision: value.revision + 1,
      })
      return {
        ok: true as const,
        value: {
          nonce: input.nonce,
          operation: 'remove' as const,
          revision: value.credential.revision,
          configured: false,
        } satisfies RelayCredentialReceipt,
      }
    }),
    revealRelayApiKey: vi.fn<DesktopBridge['revealRelayApiKey']>().mockResolvedValue({
      ok: true as const,
      value: { revision: 1, key: 'sk-synthetic-reveal-0000' },
    }),
    readRelayCredentialReceipt: vi
      .fn<DesktopBridge['readRelayCredentialReceipt']>()
      .mockResolvedValue({ ok: true as const, value: null }),
    readSchedulingActivity: vi
      .fn<DesktopBridge['readSchedulingActivity']>()
      .mockResolvedValue({ ok: true as const, value: empty }),
    onSchedulingChanged: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } satisfies Pick<
    DesktopBridge,
    | 'getSchedulingState'
    | 'saveSchedulingSettings'
    | 'saveRelayApiKey'
    | 'removeRelayApiKey'
    | 'revealRelayApiKey'
    | 'readRelayCredentialReceipt'
    | 'readSchedulingActivity'
    | 'onSchedulingChanged'
  >
  vi.stubGlobal('pact', bridge)
  return {
    bridge,
    listeners,
    publish: (next = value) => {
      value = next
      for (const listener of listeners) listener()
    },
  }
}
function Surface({
  active = true,
  sessionId,
  settingsVisible = active,
}: {
  active?: boolean
  sessionId?: string
  settingsVisible?: boolean
}) {
  const state = useSchedulingSettings(active, sessionId, settingsVisible)
  return <DecisionSchedulingSettings state={state} />
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Relay mounted App owner', () => {
  it('reads only state while Off, loads details when enabled and releases hidden subscriptions', async () => {
    const f = fixture(),
      hook = renderHook(({ active }) => useSchedulingSettings(active), {
        initialProps: { active: true },
      })
    await waitFor(() => expect(hook.result.current.settings?.enabled).toBe(false))
    expect(f.bridge.readSchedulingActivity).not.toHaveBeenCalled()
    await act(() => hook.result.current.save({ enabled: true }))
    await waitFor(() => expect(hook.result.current.settings?.enabled).toBe(true))
    await waitFor(() => expect(f.bridge.readSchedulingActivity).toHaveBeenCalledExactlyOnceWith({}))
    hook.rerender({ active: false })
    expect(f.listeners.size).toBe(0)
    const reads = f.bridge.getSchedulingState.mock.calls.length
    act(() => f.publish(settings({ enabled: false, revision: 2 })))
    expect(f.bridge.getSchedulingState).toHaveBeenCalledTimes(reads)
    hook.rerender({ active: true })
    await waitFor(() => expect(hook.result.current.settings?.revision).toBe(2))
    hook.unmount()
    expect(f.listeners.size).toBe(0)
  })

  it.each(['success', 'failure'] as const)(
    'keeps one state read and one latest intent across hidden %s',
    async (outcome) => {
      const f = fixture(),
        first = Promise.withResolvers<RpcResult<SchedulingState>>()
      f.bridge.getSchedulingState.mockReturnValueOnce(first.promise)
      const hook = renderHook(({ active }) => useSchedulingSettings(active), {
        initialProps: { active: true },
      })
      await waitFor(() => expect(f.bridge.getSchedulingState).toHaveBeenCalledOnce())
      hook.rerender({ active: false })
      hook.rerender({ active: true })
      await act(async () => {
        first.resolve(
          outcome === 'success'
            ? { ok: true, value: observedState(settings({ enabled: true, revision: 100 })) }
            : { ok: false, error: { code: 'INTERNAL', message: 'Obsolete read failure' } },
        )
      })
      await waitFor(() => expect(hook.result.current.settings?.revision).toBe(0))
      expect(f.bridge.getSchedulingState.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(hook.result.current.error).toBeUndefined()
      expect(hook.result.current.loading).toBe(false)
      hook.unmount()
    },
  )

  it('does not replay an uncertain save before authoritative readback succeeds', async () => {
    const f = fixture(),
      hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.settings).toBeDefined())
    const readback = Promise.withResolvers<RpcResult<SchedulingState>>()
    f.bridge.getSchedulingState.mockReturnValueOnce(readback.promise)
    f.bridge.saveSchedulingSettings.mockRejectedValueOnce(new Error('Lost save ACK'))
    await act(() => hook.result.current.save({ enabled: true }))
    await act(() => hook.result.current.save({ enabled: true }))
    expect(f.bridge.saveSchedulingSettings).toHaveBeenCalledOnce()
    await act(async () =>
      readback.resolve({
        ok: true,
        value: observedState(settings({ enabled: true, revision: 1 })),
      }),
    )
    await waitFor(() => expect(hook.result.current.settings?.revision).toBe(1))
    await act(() => hook.result.current.save({ showIndicator: false }))
    expect(f.bridge.saveSchedulingSettings).toHaveBeenLastCalledWith({
      expectedRevision: 1,
      showIndicator: false,
    })
    hook.unmount()
  })

  it('does not let a save ACK from a hidden epoch overwrite newer settings', async () => {
    const f = fixture(),
      hook = renderHook(({ active }) => useSchedulingSettings(active), {
        initialProps: { active: true },
      })
    await waitFor(() => expect(hook.result.current.settings).toBeDefined())
    const save = Promise.withResolvers<RpcResult<SchedulingSettings>>()
    f.bridge.saveSchedulingSettings.mockReturnValueOnce(save.promise)
    let pending!: Promise<void>
    act(() => {
      pending = hook.result.current.save({ enabled: true })
    })
    hook.rerender({ active: false })
    f.publish(settings({ enabled: false, revision: 3 }))
    hook.rerender({ active: true })
    await waitFor(() => expect(hook.result.current.settings?.revision).toBe(3))
    await act(async () => {
      save.resolve({ ok: true, value: settings({ enabled: true, revision: 1 }) })
      await pending
    })
    expect(hook.result.current.settings).toMatchObject({ enabled: false, revision: 3 })
    hook.unmount()
  })

  it('keeps uncertain writes blocked when readback fails and unlocks only after a later successful read', async () => {
    const f = fixture(),
      hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.settings).toBeDefined())
    f.bridge.saveSchedulingSettings.mockResolvedValueOnce({
      ok: false,
      error: { code: 'TIMEOUT', message: 'Save unconfirmed' },
    })
    f.bridge.getSchedulingState.mockResolvedValueOnce({
      ok: false,
      error: { code: 'INTERNAL', message: 'Readback failed' },
    })
    await act(() => hook.result.current.save({ enabled: true }))
    await waitFor(() => expect(hook.result.current.error).toBe('Readback failed'))
    await act(() => hook.result.current.save({ enabled: true }))
    expect(f.bridge.saveSchedulingSettings).toHaveBeenCalledOnce()
    act(() => f.publish(settings({ enabled: true, revision: 1 })))
    await waitFor(() => expect(hook.result.current.settings?.revision).toBe(1))
    await act(() => hook.result.current.save({ enabled: false }))
    expect(f.bridge.saveSchedulingSettings).toHaveBeenCalledTimes(2)
    hook.unmount()
  })

  it('retains a definite save failure after successful unchanged readback and clears it on an explicit successful retry', async () => {
    const f = fixture(),
      hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.settings).toBeDefined())
    f.bridge.saveSchedulingSettings.mockResolvedValueOnce({
      ok: false,
      error: { code: 'CONFLICT', message: 'The settings changed. Save again to retry.' },
    })
    await act(() => hook.result.current.save({ showIndicator: false }))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.settings?.revision).toBe(0)
    expect(hook.result.current.error).toBe('The settings changed. Save again to retry.')
    expect(hook.result.current.saveBlocked).toBe(false)
    await act(() => hook.result.current.save({ enabled: true }))
    expect(hook.result.current.error).toBeUndefined()
    expect(hook.result.current.settings?.enabled).toBe(true)
    hook.unmount()
  })

  it('keeps a delayed own-change read from rolling back an acknowledged save or leaving the editor busy', async () => {
    const f = fixture(),
      hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.settings).toBeDefined())
    const changeRead = Promise.withResolvers<RpcResult<SchedulingState>>()
    f.bridge.getSchedulingState.mockReturnValueOnce(changeRead.promise)
    act(() => f.publish())
    await act(() => hook.result.current.save({ enabled: true }))
    expect(hook.result.current.settings?.revision).toBe(1)
    await act(async () => changeRead.resolve({ ok: true, value: observedState(settings()) }))
    expect(hook.result.current.settings?.revision).toBe(1)
    expect(hook.result.current.saving).toBe(false)
    expect(hook.result.current.saveBlocked).toBe(false)
    await act(() => hook.result.current.save({ showIndicator: false }))
    expect(f.bridge.saveSchedulingSettings).toHaveBeenLastCalledWith({
      expectedRevision: 1,
      showIndicator: false,
    })
    hook.unmount()
  })

  it('coalesces Off/On detail intents without releasing a still pending activity read', async () => {
    const f = fixture(settings({ enabled: true })),
      activity = Promise.withResolvers<RpcResult<SchedulingActivityPage>>()
    f.bridge.readSchedulingActivity.mockReturnValueOnce(activity.promise)
    const hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(f.bridge.readSchedulingActivity).toHaveBeenCalledOnce())
    await act(() => hook.result.current.save({ enabled: false }))
    await act(() => hook.result.current.save({ enabled: true }))
    // The Off/On coalesced intents fired no second read while the first was pending.
    expect(f.bridge.readSchedulingActivity).toHaveBeenCalledOnce()
    f.bridge.readSchedulingActivity.mockResolvedValue({
      ok: true,
      value: { ...empty, rows: [row(999)] },
    })
    await act(async () => {
      activity.resolve({ ok: true, value: { ...empty, rows: [] } })
      await activity.promise
    })
    // The stale Off-window response is dropped; the re-enabled details reads afresh.
    await waitFor(() => expect(hook.result.current.rows.map((r) => r.id)).toEqual([row(999).id]))
    hook.unmount()
  })

  it('bounds resident history to 100 rows, deduplicates overlapping keysets and returns toward the latest edge', async () => {
    const f = fixture(settings({ enabled: true }))
    f.bridge.readSchedulingActivity.mockImplementation(async (input) => {
      const edge = Number(input.cursor?.id.slice(-12) ?? 0)
      const start =
        input.direction === 'older'
          ? edge
          : input.direction === 'newer'
            ? Math.max(0, edge - 26)
            : 0
      const rows = Array.from({ length: 25 }, (_, index) => row(start + index + 1))
      return {
        ok: true,
        value: {
          ...empty,
          rows,
          nextCursor: { asOf: timestamp, createdAt: rows.at(-1)!.createdAt, id: rows.at(-1)!.id },
        },
      }
    })
    const hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.rows).toHaveLength(25))
    for (const expected of [50, 75, 100, 100]) {
      // oxlint-disable-next-line no-await-in-loop -- Each keyset depends on the preceding acknowledged page.
      await act(async () => hook.result.current.readOlder())
      expect(hook.result.current.rows).toHaveLength(expected)
    }
    expect(new Set(hook.result.current.rows.map(({ id }) => id)).size).toBe(100)
    expect(hook.result.current.rows[0]?.id).toBe(row(26).id)
    await act(async () => hook.result.current.readNewer())
    expect(hook.result.current.rows).toHaveLength(100)
    expect(hook.result.current.rows[0]?.id).toBe(row(1).id)
    expect(JSON.stringify(hook.result.current.rows).length).toBeLessThan(400 * 1024)
  })

  it('keeps a continuous anchored window when the latest page no longer overlaps resident history', async () => {
    const f = fixture(settings({ enabled: true })),
      initialAsOf = row(51).createdAt,
      allRows = Array.from({ length: 100 }, (_, index) => row(index + 1))
    let published = false
    f.bridge.readSchedulingActivity.mockImplementation(async (input) => {
      const asOf = input.cursor?.asOf ?? (published ? timestamp : initialAsOf)
      const eligible = allRows.filter((entry) => entry.createdAt <= asOf)
      const candidates = input.cursor
        ? eligible.filter((entry) =>
            input.direction === 'newer'
              ? entry.createdAt > input.cursor!.createdAt
              : entry.createdAt < input.cursor!.createdAt,
          )
        : eligible
      const rows = input.direction === 'newer' ? candidates.slice(-25) : candidates.slice(0, 25)
      const edge = input.direction === 'newer' ? rows[0] : rows.at(-1)
      return {
        ok: true,
        value: {
          asOf,
          rows,
          nextCursor:
            candidates.length > rows.length && edge
              ? { asOf, createdAt: edge.createdAt, id: edge.id }
              : null,
        },
      }
    })
    const hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.rows).toEqual(allRows.slice(50, 75)))
    await act(async () => {
      published = true
      f.publish()
    })
    const afterLatest = hook.result.current.rows
    await act(async () => hook.result.current.readOlder())
    await act(async () => hook.result.current.readNewer())
    await act(async () => hook.result.current.readNewer())
    expect(hook.result.current.rows).toEqual(allRows)
    expect(afterLatest).toEqual(allRows.slice(50, 75))
    expect(
      f.bridge.readSchedulingActivity.mock.calls
        .map(([input]) => input)
        .filter((input) => input.direction === 'newer'),
    ).toEqual([
      {
        direction: 'newer',
        cursor: { asOf: timestamp, createdAt: row(51).createdAt, id: row(51).id },
      },
      {
        direction: 'newer',
        cursor: { asOf: timestamp, createdAt: row(26).createdAt, id: row(26).id },
      },
    ])
  })

  it.each(['empty', 'older-complete'] as const)(
    'rebuilds history from an authoritative %s latest page after retention changes',
    async (result) => {
      const f = fixture(settings({ enabled: true })),
        before = Array.from({ length: 25 }, (_, index) => row(index + 51)),
        after = result === 'empty' ? [] : Array.from({ length: 25 }, (_, index) => row(index + 76))
      f.bridge.readSchedulingActivity.mockResolvedValue({
        ok: true,
        value: { ...empty, rows: after },
      })
      f.bridge.readSchedulingActivity.mockResolvedValueOnce({
        ok: true,
        value: {
          ...empty,
          rows: before,
          nextCursor: { asOf: timestamp, createdAt: row(75).createdAt, id: row(75).id },
        },
      })
      const hook = renderHook(() => useSchedulingSettings(true))
      await waitFor(() => expect(hook.result.current.rows).toEqual(before))
      await act(async () => f.publish())
      expect(hook.result.current.rows).toEqual(after)
      await act(async () => hook.result.current.readNewer())
      await act(async () => hook.result.current.readOlder())
      expect(f.bridge.readSchedulingActivity).toHaveBeenCalledTimes(2)
    },
  )

  it('rebuilds the latest window when a clock rollback moves the authoritative asOf backward', async () => {
    const f = fixture(settings({ enabled: true })),
      allRows = Array.from({ length: 50 }, (_, index) => row(index + 51))
    let asOf = timestamp
    f.bridge.readSchedulingActivity.mockImplementation(async (input) => {
      const snapshot = input.cursor?.asOf ?? asOf
      const eligible = allRows.filter((entry) => entry.createdAt <= snapshot)
      const candidates = input.cursor
        ? eligible.filter((entry) => entry.createdAt < input.cursor!.createdAt)
        : eligible
      const rows = candidates.slice(0, 25),
        edge = rows.at(-1)
      return {
        ok: true,
        value: {
          asOf: snapshot,
          rows,
          nextCursor:
            candidates.length > rows.length && edge
              ? { asOf: snapshot, createdAt: edge.createdAt, id: edge.id }
              : null,
        },
      }
    })
    const hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.rows).toEqual(allRows.slice(0, 25)))
    await act(async () => {
      asOf = row(66).createdAt
      f.publish()
    })
    expect(hook.result.current.rows).toEqual(allRows.slice(15, 40))
    await act(async () => hook.result.current.readOlder())
    expect(hook.result.current.rows).toEqual(allRows.slice(15))
  })

  it('enforces the resident UTF-8 byte budget even when every received page fits its own budget', async () => {
    const f = fixture(settings({ enabled: true }))
    f.bridge.readSchedulingActivity.mockImplementation(async (input) => {
      const edge = Number(input.cursor?.id.slice(-12) ?? 0)
      const rows = Array.from({ length: 25 }, (_, index) => ({
        ...row(edge + index + 1),
        project: '界'.repeat(512),
        session: '界'.repeat(512),
        model: '界'.repeat(256),
        suggestion: 'Review the saved task context. '.repeat(20),
      }))
      const page = schedulingActivityPageSchema.parse({
        ...empty,
        rows,
        nextCursor: { asOf: timestamp, createdAt: rows.at(-1)!.createdAt, id: rows.at(-1)!.id },
      })
      return { ok: true, value: page }
    })
    const hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.rows).toHaveLength(25))
    for (let page = 0; page < 4; page++) {
      // oxlint-disable-next-line no-await-in-loop -- Each bounded page supplies the next keyset.
      await act(async () => hook.result.current.readOlder())
      expect(
        new TextEncoder().encode(JSON.stringify(hook.result.current.rows)).byteLength,
      ).toBeLessThanOrEqual(400 * 1024)
    }
    expect(hook.result.current.rows.length).toBeLessThan(100)
    expect(hook.result.current.rows.at(-1)?.id).toBe(row(125).id)
  })
})

describe('Relay surface', () => {
  it('supports keyboard disclosure and restores focus without making activity actionable', async () => {
    fixture()
    render(<Surface />)
    const user = userEvent.setup()
    const toggle = screen.getByRole('switch', { name: 'Enable Relay' })
    await waitFor(() => expect(toggle.getAttribute('aria-disabled')).toBe('false'))
    expect(screen.getByRole('heading', { name: 'Relay' })).toBeDefined()
    expect(screen.queryByLabelText('OpenAI API key')).toBeNull()
    toggle.focus()
    await user.keyboard(' ')
    await screen.findByLabelText('OpenAI API key')
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByText('No activity yet.')).toBeDefined()
    expect(document.querySelector('.relay-activity-list a, .relay-activity-list button')).toBeNull()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByLabelText('OpenAI API key')).toBeNull())
    expect(document.activeElement).toBe(toggle)
    await user.tab()
    expect(document.activeElement?.closest('#relay-details')).toBeNull()
  })

  it('keeps the header, disclosure and read-only activity without model radios or action links', async () => {
    fixture(settings({ enabled: true, credential: { configured: false, revision: 0 } }))
    const { container } = render(<Surface active />)
    await waitFor(() => expect(container.querySelector('.relay-activity-list')).not.toBeNull())
    expect(container.textContent).toContain('Decisions API')
    expect(container.textContent).toContain('OpenAI API key')
    expect(container.textContent).toContain('Show activity indicator')
    expect(container.querySelector('input[type="radio"]')).toBeNull()
    expect(container.querySelector('.relay-activity-list a')).toBeNull()
  })

  it('clears the masked key when accepted and preserves invalid unsent input', async () => {
    const f = fixture(settings({ enabled: true }))
    const user = userEvent.setup()
    const { container } = render(<Surface active />)
    await waitFor(() => expect(container.querySelector('#relay-api-key')).not.toBeNull())
    const input = container.querySelector<HTMLInputElement>('#relay-api-key')!
    await user.type(input, 'sk-synthetic-preview-key-0000')
    await user.click(container.querySelector('.relay-key-controls button[type="submit"]')!)
    await waitFor(() => expect(f.bridge.saveRelayApiKey).toHaveBeenCalledOnce())
    expect(input.value).toBe('')
    await waitFor(() => expect(input.disabled).toBe(false))
    await user.type(input, 'invalid key with spaces')
    await user.click(container.querySelector('.relay-key-controls button[type="submit"]')!)
    expect(input.value).toBe('invalid key with spaces')
    expect(screen.getByText('Enter a valid API key.')).toBeDefined()
    expect(f.bridge.saveRelayApiKey).toHaveBeenCalledOnce()
  })

  it('clears unsent text on hide and disable and never rehydrates a stored key', async () => {
    const f = fixture(settings({ enabled: true, credential: { configured: true, revision: 1 } }))
    const user = userEvent.setup()
    const { container, rerender } = render(<Surface active />)
    await waitFor(() => expect(container.querySelector('#relay-api-key')).not.toBeNull())
    const input = container.querySelector<HTMLInputElement>('#relay-api-key')!
    await user.type(input, 'sk-unsent')
    rerender(<Surface active settingsVisible={false} />)
    await waitFor(() => expect(input.value).toBe(''))
    rerender(<Surface active />)
    const reopened = await screen.findByLabelText<HTMLInputElement>('OpenAI API key')
    expect(reopened.value).toBe('')
    await user.type(reopened, 'sk-unsent-again')
    await user.click(screen.getByRole('switch', { name: 'Enable Relay' }))
    await waitFor(() => expect(screen.queryByLabelText('OpenAI API key')).toBeNull())
    await user.click(screen.getByRole('switch', { name: 'Enable Relay' }))
    const enabledAgain = await screen.findByLabelText<HTMLInputElement>('OpenAI API key')
    expect(enabledAgain.value).toBe('')
    expect(screen.getByText('Saved')).toBeDefined()
    expect(f.bridge.saveRelayApiKey).not.toHaveBeenCalled()
    expect(f.bridge.removeRelayApiKey).not.toHaveBeenCalled()
  })

  it.each(['uncertain', 'throw'] as const)(
    'retains a late %s result across hide and session change until receipt readback',
    async (outcome) => {
      const f = fixture(settings({ enabled: true, credential: { configured: false, revision: 0 } }))
      const mutation = Promise.withResolvers<RpcResult<RelayCredentialReceipt>>()
      f.bridge.saveRelayApiKey.mockReturnValue(mutation.promise)
      const { container, rerender } = render(<Surface active />)
      const user = userEvent.setup()
      await waitFor(() => expect(container.querySelector('#relay-api-key')).not.toBeNull())
      const input = container.querySelector<HTMLInputElement>('#relay-api-key')!
      await user.type(input, 'sk-synthetic-preview-key-0000')
      await user.click(container.querySelector('.relay-key-controls button[type="submit"]')!)
      const nonce = f.bridge.saveRelayApiKey.mock.calls[0]?.[0]?.nonce
      rerender(<Surface active={false} settingsVisible={false} />)
      await act(async () => {
        if (outcome === 'throw') mutation.reject(new Error('Transport closed.'))
        else
          mutation.resolve({
            ok: false,
            error: { code: 'UNCERTAIN', message: 'The key change could not be confirmed.' },
          })
        await mutation.promise.catch(() => undefined)
      })
      rerender(<Surface active sessionId="11111111-1111-4111-8111-111111111111" />)
      await waitFor(() => expect(container.textContent).toContain('Check status'))
      act(() => f.publish())
      expect(f.bridge.saveRelayApiKey).toHaveBeenCalledOnce()
      expect(container.querySelector('#relay-api-key')?.getAttribute('value') ?? '').toBe('')
      f.bridge.readRelayCredentialReceipt.mockResolvedValue({
        ok: true,
        value: { nonce: nonce ?? '', operation: 'save', revision: 1, configured: true },
      })
      const check = [...container.querySelectorAll('button')].find(
        (b) => b.textContent === 'Check status',
      )!
      await user.click(check)
      await waitFor(() => expect(container.textContent).not.toContain('Check status'))
    },
  )

  it('keeps uncertainty when the bridge throws and after a changed event', async () => {
    const f = fixture(settings({ enabled: true }))
    f.bridge.saveRelayApiKey.mockRejectedValue(new Error('transport closed'))
    const { container } = render(<Surface active />)
    const user = userEvent.setup()
    await waitFor(() => expect(container.querySelector('#relay-api-key')).not.toBeNull())
    await user.type(
      container.querySelector<HTMLInputElement>('#relay-api-key')!,
      'sk-synthetic-preview-key-0000',
    )
    await user.click(container.querySelector('.relay-key-controls button[type="submit"]')!)
    await waitFor(() => expect(container.textContent).toContain('Check status'))
    act(() => f.publish())
    await waitFor(() => expect(container.textContent).toContain('Check status'))
    expect(f.bridge.saveRelayApiKey).toHaveBeenCalledOnce()
  })

  it.each([
    { field: 'nonce', value: { nonce: '99999999-9999-4999-8999-999999999999' } },
    { field: 'operation', value: { operation: 'remove' } },
    { field: 'revision', value: { revision: 9 } },
    { field: 'configured', value: { configured: false } },
  ] as const)('does not confirm a receipt with wrong $field', async ({ value }) => {
    const f = fixture(settings({ enabled: true, credential: { configured: false, revision: 0 } }))
    f.bridge.saveRelayApiKey.mockImplementation(async (input) => ({
      ok: true,
      value: {
        nonce: input.nonce,
        operation: 'save',
        revision: 1,
        configured: true,
        ...value,
      },
    }))
    const { container } = render(<Surface active />)
    const user = userEvent.setup()
    await waitFor(() => expect(container.querySelector('#relay-api-key')).not.toBeNull())
    await user.type(
      container.querySelector<HTMLInputElement>('#relay-api-key')!,
      'sk-synthetic-preview-key-0000',
    )
    await user.click(container.querySelector('.relay-key-controls button[type="submit"]')!)
    await waitFor(() => expect(container.textContent).toContain('Check status'))
    const nonce = f.bridge.saveRelayApiKey.mock.calls[0]?.[0]?.nonce
    expect(nonce).not.toBe('99999999-9999-4999-8999-999999999999')
    expect(container.textContent).not.toContain('Saved')
    expect(container.textContent).toContain('Not configured')
    f.bridge.readRelayCredentialReceipt.mockResolvedValue({
      ok: true,
      value: { nonce: nonce!, operation: 'save', revision: 1, configured: true, ...value },
    })
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    await waitFor(() => expect(f.bridge.readRelayCredentialReceipt).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Check status' })).toBeDefined()
    expect(f.bridge.saveRelayApiKey).toHaveBeenCalledOnce()
  })

  it('reports the deadline-passed missing receipt and unlocks a fresh attempt after readback', async () => {
    const f = fixture(settings({ enabled: true, credential: { configured: false, revision: 0 } }))
    f.bridge.saveRelayApiKey.mockResolvedValue({
      ok: false,
      error: { code: 'UNCERTAIN', message: 'unconfirmed' },
    })
    const { container } = render(<Surface active />)
    const user = userEvent.setup()
    await waitFor(() => expect(container.querySelector('#relay-api-key')).not.toBeNull())
    await user.type(
      container.querySelector<HTMLInputElement>('#relay-api-key')!,
      'sk-synthetic-preview-key-0000',
    )
    await user.click(container.querySelector('.relay-key-controls button[type="submit"]')!)
    await waitFor(() => expect(container.textContent).toContain('Check status'))
    const originalDeadline = f.bridge.saveRelayApiKey.mock.calls[0]![0].deadlineAt
    const spy = vi.spyOn(Date, 'now').mockReturnValue(originalDeadline - 1)
    f.bridge.readRelayCredentialReceipt.mockResolvedValue({ ok: true, value: null })
    const check = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Check status',
    )!
    await user.click(check)
    expect(screen.getByRole('button', { name: 'Check status' })).toBeDefined()
    expect(screen.queryByText('The key change was not saved.')).toBeNull()
    spy.mockReturnValue(originalDeadline)
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    await waitFor(() => expect(container.textContent).toContain('The key change was not saved.'))
    spy.mockRestore()
    expect(f.bridge.saveRelayApiKey).toHaveBeenCalledOnce()
    await user.type(
      container.querySelector<HTMLInputElement>('#relay-api-key')!,
      'sk-fresh-attempt',
    )
    await user.click(container.querySelector('.relay-key-controls button[type="submit"]')!)
    expect(f.bridge.saveRelayApiKey).toHaveBeenCalledTimes(2)
  })

  it('blocks key writes while ordinary save is in flight and vice versa', async () => {
    const f = fixture(settings({ enabled: true }))
    const save = Promise.withResolvers<RpcResult<SchedulingSettings>>()
    f.bridge.saveSchedulingSettings.mockReturnValueOnce(save.promise)
    const { container } = render(<Surface active />)
    const user = userEvent.setup()
    await waitFor(() => expect(container.querySelector('#relay-api-key')).not.toBeNull())
    const toggle = [...container.querySelectorAll('[role="switch"]')].find((b) =>
      b.textContent?.includes('Enable Relay'),
    )!
    await user.click(toggle)
    expect(container.querySelector<HTMLInputElement>('#relay-api-key')?.disabled).toBe(true)
    save.resolve({ ok: true, value: settings({ enabled: true, revision: 1 }) })
    await waitFor(() =>
      expect(container.querySelector<HTMLInputElement>('#relay-api-key')?.disabled).toBe(false),
    )
    const keyWrite = Promise.withResolvers<RpcResult<RelayCredentialReceipt>>()
    f.bridge.saveRelayApiKey.mockReturnValue(keyWrite.promise)
    await user.type(
      container.querySelector<HTMLInputElement>('#relay-api-key')!,
      'sk-synthetic-preview-key-0000',
    )
    await user.click(container.querySelector('.relay-key-controls button[type="submit"]')!)
    expect(f.bridge.saveSchedulingSettings).toHaveBeenCalledOnce()
    await user.click(toggle)
    expect(f.bridge.saveSchedulingSettings).toHaveBeenCalledOnce()
    keyWrite.resolve({
      ok: true,
      value: {
        nonce: f.bridge.saveRelayApiKey.mock.calls[0]?.[0]?.nonce ?? '',
        operation: 'save',
        revision: 1,
        configured: true,
      },
    })
  })

  it('labels Remove as Removing while pending and never Saving on the wrong button', async () => {
    const f = fixture(settings({ enabled: true, credential: { configured: true, revision: 1 } }))
    const pending = Promise.withResolvers<RpcResult<RelayCredentialReceipt>>()
    f.bridge.removeRelayApiKey.mockReturnValue(pending.promise)
    const { container } = render(<Surface active />)
    const user = userEvent.setup()
    await waitFor(() => expect(container.textContent).toContain('Saved'))
    const remove = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Remove',
    )!
    await user.click(remove)
    await waitFor(() => expect(container.textContent).toContain('Removing…'))
    expect(container.textContent).not.toContain('Saving…')
    pending.resolve({
      ok: true,
      value: {
        nonce: f.bridge.removeRelayApiKey.mock.calls[0]?.[0]?.nonce ?? '',
        operation: 'remove',
        revision: 2,
        configured: false,
      },
    })
  })

  it('keeps an uncertain Remove until its own receipt readback', async () => {
    const f = fixture(settings({ enabled: true, credential: { configured: true, revision: 1 } }))
    f.bridge.removeRelayApiKey.mockResolvedValue({
      ok: false,
      error: { code: 'UNCERTAIN', message: 'The key change could not be confirmed.' },
    })
    const { container } = render(<Surface active />)
    const user = userEvent.setup()
    await waitFor(() => expect(container.textContent).toContain('Saved'))
    const remove = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Remove',
    )!
    await user.click(remove)
    await waitFor(() => expect(container.textContent).toContain('Check status'))
    const nonce = f.bridge.removeRelayApiKey.mock.calls[0]?.[0]?.nonce
    expect(nonce).toBeDefined()
    f.bridge.readRelayCredentialReceipt.mockResolvedValue({
      ok: true,
      value: { nonce: nonce!, operation: 'remove', revision: 2, configured: false },
    })
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    await waitFor(() =>
      expect(f.bridge.readRelayCredentialReceipt).toHaveBeenCalledExactlyOnceWith({ nonce }),
    )
    await waitFor(() => expect(container.textContent).not.toContain('Check status'))
    expect(f.bridge.removeRelayApiKey).toHaveBeenCalledOnce()
  })

  it('shows Saved only as stored metadata with an unconfirmed connection', async () => {
    fixture(settings({ enabled: true, credential: { configured: true, revision: 1 } }))
    const { container } = render(<Surface active />)
    await waitFor(() => expect(container.textContent).toContain('Saved'))
    expect(container.textContent).not.toContain('verified')
    expect(container.textContent).not.toContain('ready')
  })

  it('fences all writes until a successful credential receipt receives authoritative state readback', async () => {
    const f = fixture(settings({ enabled: true }))
    const hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.settings).toBeDefined())
    const readback = Promise.withResolvers<RpcResult<SchedulingState>>()
    f.bridge.getSchedulingState.mockReturnValueOnce(readback.promise)
    act(() => {
      expect(hook.result.current.saveKey('sk-synthetic-first')).toBe(true)
    })
    await waitFor(() => expect(f.bridge.getSchedulingState).toHaveBeenCalledTimes(2))
    expect(hook.result.current.saveBlocked).toBe(true)
    act(() => {
      expect(hook.result.current.saveKey('sk-synthetic-second')).toBe(false)
    })
    await act(() => hook.result.current.save({ showIndicator: false }))
    expect(f.bridge.saveRelayApiKey).toHaveBeenCalledOnce()
    expect(f.bridge.saveSchedulingSettings).not.toHaveBeenCalled()
    await act(async () =>
      readback.resolve({
        ok: true,
        value: observedState(
          settings({
            enabled: true,
            revision: 1,
            credential: { configured: true, revision: 1 },
          }),
        ),
      }),
    )
    await waitFor(() => expect(hook.result.current.saveBlocked).toBe(false))
    act(() => {
      expect(hook.result.current.saveKey('sk-synthetic-second')).toBe(true)
    })
    await waitFor(() => expect(hook.result.current.credentialSaving).toBe(false))
    expect(f.bridge.saveRelayApiKey).toHaveBeenCalledTimes(2)
  })

  it('keeps one explicit status read and performs no follow-up work after unmount', async () => {
    const f = fixture(settings({ enabled: true }))
    f.bridge.saveRelayApiKey.mockResolvedValue({
      ok: false,
      error: { code: 'UNCERTAIN', message: 'Unconfirmed.' },
    })
    const hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.settings).toBeDefined())
    act(() => {
      hook.result.current.saveKey('sk-synthetic-key')
    })
    await waitFor(() => expect(hook.result.current.credentialUncertain).toBe(true))
    const status = Promise.withResolvers<RpcResult<RelayCredentialReceipt | null>>()
    f.bridge.readRelayCredentialReceipt.mockReturnValue(status.promise)
    act(() => {
      hook.result.current.checkCredentialStatus()
      hook.result.current.checkCredentialStatus()
    })
    expect(f.bridge.readRelayCredentialReceipt).toHaveBeenCalledOnce()
    const reads = f.bridge.getSchedulingState.mock.calls.length
    const nonce = f.bridge.saveRelayApiKey.mock.calls[0]![0].nonce
    hook.unmount()
    await act(async () =>
      status.resolve({
        ok: true,
        value: { nonce, operation: 'save', revision: 1, configured: true },
      }),
    )
    expect(f.listeners.size).toBe(0)
    expect(f.bridge.getSchedulingState).toHaveBeenCalledTimes(reads)
    expect(f.bridge.saveRelayApiKey).toHaveBeenCalledOnce()
  })
})

describe('Relay activity display', () => {
  it('preserves selected text and the same row node when updated activity reorders its stable ID', async () => {
    const f = fixture(settings({ enabled: true }))
    const first = row(1),
      selected = { ...row(2), project: 'Selected project' }
    f.bridge.readSchedulingActivity.mockResolvedValueOnce({
      ok: true,
      value: { ...empty, rows: [first, selected] },
    })
    render(<Surface />)
    await waitFor(() => expect(document.querySelectorAll('[data-activity-row]')).toHaveLength(2))
    const element = document.querySelector(`[data-activity-row="${selected.id}"]`)!
    const text = element.querySelector('[data-activity-text="project"]')!.firstChild!
    const selection = document.getSelection()!
    act(() => {
      selection.setBaseAndExtent(text, 0, text, 8)
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(selection.toString()).toBe('Selected')
    f.bridge.readSchedulingActivity.mockResolvedValue({
      ok: true,
      value: {
        ...empty,
        rows: [
          {
            ...selected,
            createdAt: timestamp,
            result: 'completed',
            called: true,
            action: 'plan_review',
            actionResult: 'completed',
          },
          first,
        ],
      },
    })
    act(() => f.publish())
    await screen.findByText('Completed')
    expect(document.querySelector('[data-activity-row]')).toBe(element)
    expect(selection.toString()).toBe('Selected')
    expect(selection.anchorNode).toBe(text)
    expect(selection.anchorOffset).toBe(0)
    expect(selection.focusNode).toBe(text)
    expect(selection.focusOffset).toBe(8)
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Show activity indicator' }))
    expect(document.querySelector(`[data-activity-row="${selected.id}"]`)).toBe(element)
  })

  const activityRows = (rows: SchedulingActivityRow[]): SchedulingActivityPage => ({
    asOf: timestamp,
    rows,
    nextCursor: null,
  })
  const renderActivity = async (rows: SchedulingActivityRow[]) => {
    const f = fixture(settings({ enabled: true }))
    f.bridge.readSchedulingActivity.mockResolvedValue({ ok: true, value: activityRows(rows) })
    const { container } = render(<Surface active />)
    await waitFor(() =>
      expect(container.querySelectorAll('[data-activity-row]').length).toBe(rows.length),
    )
    return [...container.querySelectorAll('[data-activity-row]')]
  }

  it('labels each row action first and outcome second, scoped per row', async () => {
    const els = await renderActivity([
      row(1, {
        reason: 'input',
        action: 'route_claude',
        actionResult: 'dispatched',
        suggestionState: 'adopted',
        result: 'completed',
      }),
      row(2, {
        action: 'code_review',
        actionResult: 'completed',
        suggestionState: 'adopted',
        result: 'completed',
      }),
      row(3, {
        action: 'repair',
        actionResult: null,
        suggestionState: 'awaiting_user',
        result: 'completed',
      }),
      row(4, {
        reason: 'input',
        action: null,
        actionResult: null,
        suggestionState: 'fallback',
        result: 'failed',
      }),
      row(5, {
        reason: 'input',
        action: null,
        actionResult: null,
        suggestionState: 'none',
        result: 'failed',
      }),
      row(6, { action: 'code_review', actionResult: 'failed', result: 'completed' }),
      row(7, { result: 'completed', suggestion: null, suggestionState: 'none' }),
    ])
    const text = els.map((el) => el.textContent ?? '')
    expect(text[0]).toContain('Route to Claude Code')
    expect(text[0]).toContain('Pending')
    expect(text[1]).toContain('Review code')
    expect(text[1]).toContain('Completed')
    expect(text[2]).toContain('Repair code')
    expect(text[2]).toContain('Needs attention')
    expect(text[2]).toContain('Your confirmation is needed')
    expect(text[3]).toContain('Relay decision')
    expect(text[3]).toContain('Default workflow')
    expect(text[4]).toContain('Relay decision')
    expect(text[4]).toContain('Failed')
    expect(text[5]).toContain('Failed')
    expect(text[5]).not.toContain('Completed')
    expect(els[5]?.querySelector('.text-danger')).not.toBeNull()
    expect(els[4]?.querySelector('.text-danger')).not.toBeNull()
    expect(text[6]).toContain('Completed')
    expect(text[6]).toContain('Relay decision')
  })

  it('keeps failed Relay decisions separate from dispatch results and never presents adopted advice as completed work', async () => {
    const els = await renderActivity([
      row(1, {
        action: 'plan_review',
        actionResult: 'completed',
        suggestionState: 'fallback',
        called: true,
        result: 'failed',
      }),
      row(2, {
        action: 'plan_review',
        actionResult: 'not_sent',
        suggestionState: 'fallback',
        called: true,
        result: 'failed',
      }),
      row(3, {
        action: 'plan_review',
        actionResult: null,
        suggestionState: 'adopted',
        called: true,
        result: 'completed',
      }),
      row(4, { action: 'plan_review', actionResult: 'unconfirmed', result: 'completed' }),
      row(5, { action: 'plan_review', actionResult: 'reserved' }),
      row(6, { action: 'plan_review', actionResult: 'superseded' }),
    ])
    expect(
      els.map((el) => el.querySelector('[data-activity-text="outcome"]')?.textContent),
    ).toEqual(['Completed', 'Not sent', 'Pending', 'Needs attention', 'Pending', 'Stopped'])
    for (const el of els.slice(0, 2)) {
      expect(el.textContent).toContain('Relay failed · Default workflow')
      expect(
        el.querySelector('[data-activity-text="decision"]')?.classList.contains('text-danger'),
      ).toBe(true)
      expect(el.querySelector('[data-activity-text="review"]')).toBeNull()
    }
    expect(els[2]?.textContent).toContain('Relay: Applied')
    expect(els[2]?.textContent).not.toContain('Completed')
    expect(els[3]?.textContent).toContain('Result unconfirmed')
  })

  it('outcomes truthfully mark failed runs and omit suggestion prose and provider model text', async () => {
    const els = await renderActivity([
      row(1, {
        reason: 'native_check',
        action: 'native_check',
        actionResult: null,
        suggestionState: 'none',
        result: 'failed',
        physicalUnconfirmed: true,
        originalUnconfirmed: true,
        suggestion: 'generated suggestion prose that must not display',
      }),
      row(2, {
        reason: 'input',
        action: 'clarify_prepared_input',
        actionResult: null,
        suggestionState: 'awaiting_user',
        result: 'completed',
        suggestion: 'generated suggestion prose that must not display',
      }),
      row(3, {
        reason: 'input',
        action: null,
        actionResult: null,
        suggestionState: 'adopted',
        result: 'completed',
        suggestion: 'generated suggestion prose that must not display',
      }),
    ])
    const [failed, clarify, applied] = els
    expect(failed?.textContent).toContain('Check agent session')
    expect(failed?.textContent).toContain('Failed')
    expect(failed?.querySelector('.text-danger')).not.toBeNull()
    expect(failed?.textContent).toContain('Previous work unconfirmed')
    expect(failed?.textContent).toContain('Cleanup unconfirmed')
    expect(clarify?.textContent).toContain('Clarify input')
    expect(clarify?.textContent).toContain('Needs attention')
    expect(clarify?.textContent).toContain('Your input is needed')
    expect(applied?.textContent).toContain('Relay decision')
    expect(applied?.textContent).toContain('Applied')
    expect(applied?.textContent).toContain('Completed')
    for (const el of els) {
      expect(el.textContent).not.toContain('generated suggestion prose')
      expect(el.textContent).not.toContain('OpenAI')
      expect(el.textContent).not.toContain('gpt-6-luna')
    }
    expect(clarify?.querySelector('.text-danger')).toBeNull()
    expect(applied?.querySelector('.text-danger')).toBeNull()
  })
})

const findKey = async (container: HTMLElement): Promise<HTMLInputElement> => {
  let input: HTMLInputElement | null = null
  await waitFor(() => {
    input = container.querySelector<HTMLInputElement>('#relay-api-key')
    expect(input).not.toBeNull()
  })
  return input!
}

describe('Saved key reveal', () => {
  beforeEach(() => {
    // Simulated active window; afterEach restores.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })
  const configured = () =>
    fixture(settings({ enabled: true, credential: { configured: true, revision: 1 } }))

  it('masks the saved key, reveals on explicit click only and hides again', async () => {
    const user = userEvent.setup()
    const f = configured()
    const { container } = render(<Surface />)
    const input = await findKey(container)
    // Saved configured revision1: dots placeholder, password, zero calls on mount.
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('••••••••••••')
    expect(input.type).toBe('password')
    expect(f.bridge.revealRelayApiKey).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Show API key' }))
    await waitFor(() => expect(input.type).toBe('text'))
    expect(input.value).toBe('sk-synthetic-reveal-0000')
    expect(f.bridge.revealRelayApiKey).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        expectedRevision: 1,
        deadlineAt: expect.any(Number),
      }),
    )
    // Reveal alone does not enable Replace.
    expect(screen.getByRole('button', { name: 'Replace key' }).getAttribute('disabled')).toBe('')
    await user.click(screen.getByRole('button', { name: 'Hide API key' }))
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('••••••••••••')
    expect(f.bridge.revealRelayApiKey).toHaveBeenCalledOnce()
    // A typed draft toggles locally without any stored-key read and enables Replace.
    await user.type(input, 'sk-synthetic-draft')
    await user.click(screen.getByRole('button', { name: 'Show API key' }))
    expect(input.type).toBe('text')
    expect(f.bridge.revealRelayApiKey).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Replace key' }).getAttribute('disabled')).toBeNull()
  })

  it('shows a generic inline error on rejection and allows a successful retry', async () => {
    const user = userEvent.setup()
    const f = configured()
    f.bridge.revealRelayApiKey.mockRejectedValueOnce(new Error('private-detail'))
    const { container } = render(<Surface />)
    await waitFor(() => expect(container.querySelector('#relay-api-key')).not.toBeNull())
    await user.click(screen.getByRole('button', { name: 'Show API key' }))
    const error = await screen.findByText(/Couldn't show the saved API key/u)
    expect(error.textContent).not.toContain('private-detail')
    await user.click(screen.getByRole('button', { name: 'Show API key' }))
    await waitFor(() =>
      expect(container.querySelector<HTMLInputElement>('#relay-api-key')!.type).toBe('text'),
    )
    expect(container.querySelector<HTMLInputElement>('#relay-api-key')!.value).toBe(
      'sk-synthetic-reveal-0000',
    )
  })

  it('keeps a typed draft when a pending reveal resolves late and admits one request', async () => {
    const user = userEvent.setup()
    const f = configured()
    const deferred =
      Promise.withResolvers<Awaited<ReturnType<DesktopBridge['revealRelayApiKey']>>>()
    f.bridge.revealRelayApiKey.mockReturnValueOnce(deferred.promise)
    const { container } = render(<Surface />)
    const input = await findKey(container)
    const eye = screen.getByRole('button', { name: 'Show API key' })
    await user.click(eye)
    await user.click(eye)
    await user.type(input, 'sk-synthetic-draft')
    await act(async () => {
      deferred.resolve({ ok: true, value: { revision: 1, key: 'sk-synthetic-reveal-0000' } })
      await deferred.promise
    })
    expect(f.bridge.revealRelayApiKey).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Show API key' }).getAttribute('disabled'),
      ).toBeNull(),
    )
    expect(input.value).toBe('sk-synthetic-draft')
    expect(input.type).toBe('password')
  })

  it('ignores a reply settled while hidden and can reveal anew after returning', async () => {
    const user = userEvent.setup()
    const f = configured()
    const deferred =
      Promise.withResolvers<Awaited<ReturnType<DesktopBridge['revealRelayApiKey']>>>()
    f.bridge.revealRelayApiKey.mockReturnValueOnce(deferred.promise)
    const { container, rerender } = render(<Surface />)
    await waitFor(() => expect(container.querySelector('#relay-api-key')).not.toBeNull())
    await user.click(screen.getByRole('button', { name: 'Show API key' }))
    rerender(<Surface settingsVisible={false} />)
    await act(async () => {
      deferred.resolve({ ok: true, value: { revision: 1, key: 'sk-synthetic-reveal-0000' } })
      await deferred.promise
    })
    expect(f.bridge.revealRelayApiKey).toHaveBeenCalledOnce()
    rerender(<Surface settingsVisible={true} />)
    const input = container.querySelector<HTMLInputElement>('#relay-api-key')
    await waitFor(() => expect(input?.type).toBe('password'))
    expect(input?.value).toBe('')
    expect(input?.placeholder).toBe('••••••••••••')
    expect(screen.getByRole('button', { name: 'Show API key' }).getAttribute('disabled')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show API key' }))
    await waitFor(() => expect(input?.type).toBe('text'))
    expect(f.bridge.revealRelayApiKey).toHaveBeenCalledTimes(2)
  })

  it('ignores a reply whose revision changed while pending', async () => {
    const user = userEvent.setup()
    const f = configured()
    const deferred =
      Promise.withResolvers<Awaited<ReturnType<DesktopBridge['revealRelayApiKey']>>>()
    f.bridge.revealRelayApiKey.mockReturnValueOnce(deferred.promise)
    const { container } = render(<Surface />)
    const input = await findKey(container)
    await user.click(screen.getByRole('button', { name: 'Show API key' }))
    act(() => f.publish(settings({ enabled: true, credential: { configured: true, revision: 2 } })))
    await act(async () => {
      deferred.resolve({ ok: true, value: { revision: 1, key: 'sk-synthetic-reveal-0000' } })
      await deferred.promise
    })
    expect(f.bridge.revealRelayApiKey).toHaveBeenCalledOnce()
    await waitFor(() => expect(input.type).toBe('password'))
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('••••••••••••')
    expect(screen.getByRole('button', { name: 'Show API key' }).getAttribute('disabled')).toBeNull()
  })

  it('masks the revealed value on blur or document hidden', async () => {
    const user = userEvent.setup()
    configured()
    const { container } = render(<Surface />)
    const input = await findKey(container)
    await user.click(screen.getByRole('button', { name: 'Show API key' }))
    await waitFor(() => expect(input.type).toBe('text'))
    fireEvent(window, new Event('blur'))
    await waitFor(() => expect(input.type).toBe('password'))
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('••••••••••••')
    await user.click(screen.getByRole('button', { name: 'Show API key' }))
    await waitFor(() => expect(input.type).toBe('text'))
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(input.type).toBe('password'))
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('••••••••••••')
    hiddenSpy.mockRestore()
  })

  it('removes this surface window listeners on unmount and ignores a late pending reply', async () => {
    const user = userEvent.setup()
    const f = configured()
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const deferred =
      Promise.withResolvers<Awaited<ReturnType<DesktopBridge['revealRelayApiKey']>>>()
    f.bridge.revealRelayApiKey.mockReturnValueOnce(deferred.promise)
    const { container, unmount } = render(<Surface />)
    await findKey(container)
    // Find this surface's blur listener added after mount.
    const blurAdd = addSpy.mock.calls.find((call) => call[0] === 'blur')
    expect(blurAdd).toBeDefined()
    const handler = blurAdd![1]
    await user.click(screen.getByRole('button', { name: 'Show API key' }))
    expect(f.bridge.revealRelayApiKey).toHaveBeenCalledOnce()
    unmount()
    expect(removeSpy.mock.calls.some((call) => call[0] === 'blur' && call[1] === handler)).toBe(
      true,
    )
    await act(async () => {
      deferred.resolve({ ok: true, value: { revision: 1, key: 'sk-synthetic-reveal-0000' } })
      await deferred.promise
    })
    // Fresh configured surface mounts masked with no extra stored-key read.
    const { container: fresh } = render(<Surface />)
    const next = await findKey(fresh)
    expect(next.value).toBe('')
    expect(next.placeholder).toBe('••••••••••••')
    expect(next.type).toBe('password')
    expect(f.bridge.revealRelayApiKey).toHaveBeenCalledOnce()
  })
})
