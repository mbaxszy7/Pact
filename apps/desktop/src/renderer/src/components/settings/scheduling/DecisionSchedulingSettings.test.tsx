// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  DesktopBridge,
  RpcResult,
  SchedulingActivityPage,
  SchedulingActivityRow,
  SchedulingModels,
  SchedulingSettings,
  SchedulingState,
} from '@pact/contracts'

import { schedulingActivityPageSchema } from '@pact/contracts'

import { DecisionSchedulingSettings, useSchedulingSettings } from './DecisionSchedulingSettings'

const timestamp = '2026-10-22T00:00:00.000Z'
const settings = (overrides: Partial<SchedulingSettings> = {}): SchedulingSettings => ({
  enabled: false,
  selection: null,
  showIndicator: true,
  revision: 0,
  updatedAt: timestamp,
  ...overrides,
})
const models: SchedulingModels = {
  catalogIdentity: 'a'.repeat(64),
  models: [
    {
      target: 'codex_luna',
      status: 'found',
      selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
      checkedAt: timestamp,
    },
    { target: 'claude_haiku_5_5', status: 'not_found', selection: null, checkedAt: timestamp },
  ],
}
const empty: SchedulingActivityPage = { asOf: timestamp, rows: [], nextCursor: null }
const observedState = (value: SchedulingSettings): SchedulingState => ({
  settings: value,
  configurationGeneration: value.revision,
  host: { status: 'unconfirmed', capability: null, expiresAt: null },
  context: null,
  activity: { decision: { status: 'idle' }, check: { status: 'idle' } },
})
function row(index: number): SchedulingActivityRow {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    createdAt: new Date(Date.parse(timestamp) - index * 1000).toISOString(),
    project: 'Project',
    session: 'Session',
    provider: 'codex',
    model: 'gpt-6-luna',
    reason: 'workflow',
    result: 'not_sent',
    called: false,
    physicalUnconfirmed: false,
    suggestion: null,
  }
}
function fixture(initial = settings()) {
  let value = initial
  const listeners = new Set<() => void>()
  const readSettings = vi.fn<DesktopBridge['getSchedulingSettings']>(async () => ({
    ok: true,
    value,
  }))
  const bridge = {
    getSchedulingSettings: readSettings,
    getSchedulingState: vi.fn<DesktopBridge['getSchedulingState']>(async () => {
      const result = await readSettings()
      return result.ok ? { ok: true, value: observedState(result.value) } : result
    }),
    refreshSchedulingState: vi.fn<DesktopBridge['refreshSchedulingState']>(async () => {
      const result = await readSettings()
      return result.ok ? { ok: true, value: observedState(result.value) } : result
    }),
    saveSchedulingSettings: vi.fn<DesktopBridge['saveSchedulingSettings']>(async (input) => {
      value = settings({
        ...value,
        enabled: input.enabled ?? value.enabled,
        selection: input.selection === undefined ? value.selection : input.selection,
        showIndicator: input.showIndicator ?? value.showIndicator,
        revision: value.revision + 1,
      })
      return { ok: true, value }
    }),
    refreshSchedulingModels: vi
      .fn<DesktopBridge['refreshSchedulingModels']>()
      .mockResolvedValue({ ok: true, value: models }),
    readSchedulingActivity: vi
      .fn<DesktopBridge['readSchedulingActivity']>()
      .mockResolvedValue({ ok: true, value: empty }),
    onSchedulingChanged: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } satisfies Pick<
    DesktopBridge,
    | 'getSchedulingSettings'
    | 'getSchedulingState'
    | 'refreshSchedulingState'
    | 'saveSchedulingSettings'
    | 'refreshSchedulingModels'
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
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Relay mounted App owner', () => {
  it('reads only settings while Off, discovers only expanded details and releases hidden subscriptions', async () => {
    const f = fixture(),
      hook = renderHook(({ active }) => useSchedulingSettings(active), {
        initialProps: { active: true },
      })
    await waitFor(() => expect(hook.result.current.settings?.enabled).toBe(false))
    expect(f.bridge.refreshSchedulingModels).not.toHaveBeenCalled()
    expect(f.bridge.readSchedulingActivity).not.toHaveBeenCalled()
    await act(() => hook.result.current.save({ enabled: true }))
    await waitFor(() => expect(hook.result.current.models).toEqual(models))
    expect(f.bridge.refreshSchedulingModels).toHaveBeenCalledOnce()
    expect(f.bridge.readSchedulingActivity).toHaveBeenCalledExactlyOnceWith({})
    hook.rerender({ active: false })
    expect(f.listeners.size).toBe(0)
    const reads = f.bridge.getSchedulingSettings.mock.calls.length
    act(() => f.publish(settings({ enabled: false, revision: 2 })))
    expect(f.bridge.getSchedulingSettings).toHaveBeenCalledTimes(reads)
    hook.rerender({ active: true })
    await waitFor(() => expect(hook.result.current.settings?.revision).toBe(2))
    expect(f.bridge.refreshSchedulingModels).toHaveBeenCalledOnce()
    expect(f.bridge.readSchedulingActivity).toHaveBeenCalledOnce()
    hook.unmount()
    expect(f.listeners.size).toBe(0)
  })

  it.each(['success', 'failure'] as const)(
    'keeps one settings read and one latest intent across hidden %s',
    async (outcome) => {
      const f = fixture(),
        first = Promise.withResolvers<RpcResult<SchedulingSettings>>()
      f.bridge.getSchedulingSettings.mockReturnValueOnce(first.promise)
      const hook = renderHook(({ active }) => useSchedulingSettings(active), {
        initialProps: { active: true },
      })
      await waitFor(() => expect(f.bridge.getSchedulingSettings).toHaveBeenCalledOnce())
      hook.rerender({ active: false })
      hook.rerender({ active: true })
      await act(async () => {
        first.resolve(
          outcome === 'success'
            ? { ok: true, value: settings({ enabled: true, revision: 100 }) }
            : { ok: false, error: { code: 'INTERNAL', message: 'Obsolete read failure' } },
        )
      })
      await waitFor(() => expect(hook.result.current.settings?.revision).toBe(0))
      expect(f.bridge.getSchedulingSettings).toHaveBeenCalledTimes(2)
      expect(hook.result.current.error).toBeUndefined()
      expect(hook.result.current.loading).toBe(false)
      expect(f.bridge.refreshSchedulingModels).not.toHaveBeenCalled()
    },
  )

  it.each(['success', 'failure'] as const)(
    'retains physical detail reservations and drops obsolete %s after hide/reopen',
    async (outcome) => {
      const f = fixture(settings({ enabled: true })),
        catalog = Promise.withResolvers<RpcResult<SchedulingModels>>(),
        activity = Promise.withResolvers<RpcResult<SchedulingActivityPage>>()
      f.bridge.refreshSchedulingModels.mockReturnValueOnce(catalog.promise)
      f.bridge.readSchedulingActivity.mockReturnValueOnce(activity.promise)
      const hook = renderHook(({ active }) => useSchedulingSettings(active), {
        initialProps: { active: true },
      })
      await waitFor(() => expect(f.bridge.readSchedulingActivity).toHaveBeenCalledOnce())
      hook.rerender({ active: false })
      hook.rerender({ active: true })
      await act(async () => {
        expect(f.bridge.refreshSchedulingModels).toHaveBeenCalledOnce()
        expect(f.bridge.readSchedulingActivity).toHaveBeenCalledOnce()
        catalog.resolve(
          outcome === 'success'
            ? { ok: true, value: { ...models, catalogIdentity: 'b'.repeat(64) } }
            : { ok: false, error: { code: 'INTERNAL', message: 'Obsolete catalog' } },
        )
        activity.resolve(
          outcome === 'success'
            ? { ok: true, value: { ...empty, rows: [row(999)] } }
            : { ok: false, error: { code: 'INTERNAL', message: 'Obsolete activity' } },
        )
      })
      await waitFor(() => expect(hook.result.current.models).toEqual(models))
      expect(f.bridge.refreshSchedulingModels).toHaveBeenCalledTimes(2)
      expect(f.bridge.readSchedulingActivity).toHaveBeenCalledTimes(2)
      expect(hook.result.current.rows).toEqual([])
      expect(hook.result.current.modelError).toBeUndefined()
      expect(hook.result.current.activityError).toBeUndefined()
    },
  )

  it('does not replay an uncertain save before authoritative readback succeeds', async () => {
    const f = fixture(),
      hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.settings).toBeDefined())
    const readback = Promise.withResolvers<RpcResult<SchedulingSettings>>()
    f.bridge.getSchedulingSettings.mockReturnValueOnce(readback.promise)
    f.bridge.saveSchedulingSettings.mockRejectedValueOnce(new Error('Lost save ACK'))
    await act(() => hook.result.current.save({ enabled: true }))
    await act(() => hook.result.current.save({ enabled: true }))
    expect(f.bridge.saveSchedulingSettings).toHaveBeenCalledOnce()
    await act(async () =>
      readback.resolve({ ok: true, value: settings({ enabled: true, revision: 1 }) }),
    )
    await waitFor(() => expect(hook.result.current.settings?.revision).toBe(1))
    await act(() => hook.result.current.save({ showIndicator: false }))
    expect(f.bridge.saveSchedulingSettings).toHaveBeenLastCalledWith({
      expectedRevision: 1,
      showIndicator: false,
    })
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
  })

  it('keeps uncertain writes blocked when readback fails and unlocks only after a later successful read', async () => {
    const f = fixture(),
      hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.settings).toBeDefined())
    f.bridge.saveSchedulingSettings.mockResolvedValueOnce({
      ok: false,
      error: { code: 'TIMEOUT', message: 'Save unconfirmed' },
    })
    f.bridge.getSchedulingSettings.mockResolvedValueOnce({
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
  })

  it('retains a definite save failure after successful unchanged readback and clears it on an explicit successful retry', async () => {
    const f = fixture(),
      hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.settings).toBeDefined())
    f.bridge.saveSchedulingSettings.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'The native model configuration changed. Refresh models before selecting again.',
      },
    })
    await act(() =>
      hook.result.current.save({
        selection: models.models[0]!.selection,
        catalogIdentity: models.catalogIdentity,
      }),
    )
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.settings?.revision).toBe(0)
    expect(hook.result.current.error).toBe(
      'The native model configuration changed. Refresh models before selecting again.',
    )
    expect(hook.result.current.saveBlocked).toBe(false)
    await act(() => hook.result.current.save({ enabled: true }))
    expect(hook.result.current.error).toBeUndefined()
    expect(hook.result.current.settings?.enabled).toBe(true)
  })

  it('keeps a delayed own-change read from rolling back an acknowledged save or leaving the editor busy', async () => {
    const f = fixture(),
      hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(hook.result.current.settings).toBeDefined())
    const changeRead = Promise.withResolvers<RpcResult<SchedulingSettings>>()
    f.bridge.getSchedulingSettings.mockReturnValueOnce(changeRead.promise)
    act(() => f.publish())
    await act(() => hook.result.current.save({ enabled: true }))
    expect(hook.result.current.settings?.revision).toBe(1)
    await act(async () => changeRead.resolve({ ok: true, value: settings() }))
    expect(hook.result.current.settings?.revision).toBe(1)
    expect(hook.result.current.saving).toBe(false)
    expect(hook.result.current.saveBlocked).toBe(false)
    await act(() => hook.result.current.save({ showIndicator: false }))
    expect(f.bridge.saveSchedulingSettings).toHaveBeenLastCalledWith({
      expectedRevision: 1,
      showIndicator: false,
    })
  })

  it('coalesces Off/On detail intents without releasing still pending catalog or activity reads', async () => {
    const f = fixture(settings({ enabled: true })),
      catalog = Promise.withResolvers<RpcResult<SchedulingModels>>(),
      activity = Promise.withResolvers<RpcResult<SchedulingActivityPage>>()
    f.bridge.refreshSchedulingModels.mockReturnValueOnce(catalog.promise)
    f.bridge.readSchedulingActivity.mockReturnValueOnce(activity.promise)
    const hook = renderHook(() => useSchedulingSettings(true))
    await waitFor(() => expect(f.bridge.readSchedulingActivity).toHaveBeenCalledOnce())
    await act(() => hook.result.current.save({ enabled: false }))
    await act(() => hook.result.current.save({ enabled: true }))
    expect(f.bridge.readSchedulingActivity).toHaveBeenCalledOnce()
    expect(f.bridge.refreshSchedulingModels).toHaveBeenCalledOnce()
    await act(async () => {
      catalog.resolve({ ok: true, value: { ...models, catalogIdentity: 'c'.repeat(64) } })
      activity.resolve({ ok: true, value: { ...empty, rows: [row(999)] } })
    })
    await waitFor(() => expect(hook.result.current.models).toEqual(models))
    expect(hook.result.current.rows).toEqual([])
    expect(f.bridge.readSchedulingActivity).toHaveBeenCalledTimes(2)
    expect(f.bridge.refreshSchedulingModels).toHaveBeenCalledTimes(2)
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

function Surface() {
  return <DecisionSchedulingSettings state={useSchedulingSettings(true)} />
}
describe('Relay surface', () => {
  it('labels native rebuild decisions and native initialization separately from business completion, with no invented model provenance', async () => {
    const f = fixture(settings({ enabled: true }))
    f.bridge.readSchedulingActivity.mockResolvedValue({
      ok: true,
      value: {
        ...empty,
        rows: [
          {
            ...row(1),
            provider: null,
            model: null,
            reason: 'native_rebuild',
            suggestionState: 'awaiting_user',
            action: 'rebuild_native_context',
            actionResult: null,
            originalUnconfirmed: true,
          },
          {
            ...row(2),
            provider: null,
            model: null,
            reason: 'native_rebuild',
            suggestionState: 'adopted',
            action: 'rebuild_native_context',
            actionResult: 'completed',
            originalUnconfirmed: true,
          },
          {
            ...row(3),
            provider: null,
            model: null,
            reason: 'native_rebuild',
            suggestionState: 'adopted',
            action: 'rebuild_native_context',
            actionResult: 'superseded',
          },
        ],
      },
    })
    render(<Surface />)
    await screen.findByText('Result: Awaiting your rebuild decision; original work unconfirmed')
    expect(
      screen.getByText('Result: Native context rebuilt; original work unconfirmed'),
    ).toBeDefined()
    expect(screen.getByText('Result: Native rebuild superseded')).toBeDefined()
    expect(screen.queryByText('Result: Business turn completed')).toBeNull()
    expect(screen.queryByText('Codex · gpt-6-luna')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('keeps the accepted header, disables unavailable models and supports keyboard disclosure without activity actions', async () => {
    fixture()
    render(<Surface />)
    const user = userEvent.setup()
    const toggle = screen.getByRole('switch', { name: 'Enable Relay' })
    await waitFor(() => expect(toggle.getAttribute('aria-disabled')).toBe('false'))
    expect(screen.getByRole('heading', { name: 'Relay' })).toBeDefined()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    toggle.focus()
    await user.keyboard(' ')
    await screen.findByRole('radiogroup', { name: 'Model' })
    expect(
      screen.getByRole('radio', { name: 'Haiku 5.5 · Claude Code' }).hasAttribute('disabled'),
    ).toBe(true)
    expect(screen.getByText('Choose a model to use Relay.')).toBeDefined()
    expect(screen.getByText('No activity yet.')).toBeDefined()
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Refresh models and compatibility'])
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('radiogroup')).toBeNull())
    expect(document.activeElement).toBe(toggle)
    await user.tab()
    expect(document.activeElement?.closest('#relay-details')).toBeNull()
  })

  it('distinguishes suggested, accepted and dispatched work and omits model provenance for native checks', async () => {
    const f = fixture(settings({ enabled: true }))
    f.bridge.readSchedulingActivity.mockResolvedValue({
      ok: true,
      value: {
        ...empty,
        rows: [
          {
            ...row(1),
            called: true,
            model: 'historical-native-model',
            result: 'completed',
            suggestion: 'Continue the fixed Plan review.',
            suggestionState: 'adopted',
            action: 'plan_review',
            actionResult: 'reserved',
          },
          {
            ...row(2),
            provider: null,
            model: null,
            reason: 'native_check',
            result: 'failed',
            physicalUnconfirmed: true,
            originalUnconfirmed: true,
            action: 'native_check',
            actionResult: 'failed',
          },
          {
            ...row(3),
            called: true,
            result: 'completed',
            suggestion: 'Request one read-only Plan clarification.',
            suggestionState: 'discarded',
            action: 'supplement_plan',
            actionResult: 'not_sent',
          },
        ],
      },
    })
    render(<Surface />)
    await screen.findByText('Codex · historical-native-model')
    expect(screen.getByText('Suggestion accepted: Continue the fixed Plan review.')).toBeDefined()
    expect(screen.getByText('Result: Action prepared; not started')).toBeDefined()
    expect(
      screen.getByText('Result: Check failed; original work unconfirmed; cleanup unconfirmed'),
    ).toBeDefined()
    expect(
      screen.getByText('Suggestion not used: Request one read-only Plan clarification.'),
    ).toBeDefined()
    expect(screen.queryByText('Result: Business turn completed')).toBeNull()
    const check = screen.getByText('Native session check').closest('[data-activity-row]')
    expect(check?.textContent).not.toContain('Codex')
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Refresh models and compatibility'])
  })

  it('preserves the selected text and row node when updated activity moves the same stable ID', async () => {
    const f = fixture(settings({ enabled: true })),
      first = row(1),
      selected = { ...row(2), project: 'Selected project' }
    f.bridge.readSchedulingActivity.mockResolvedValueOnce({
      ok: true,
      value: { ...empty, rows: [first, selected] },
    })
    render(<Surface />)
    const text = await screen.findByText('Selected project · Session'),
      element = text.closest('[data-activity-row]'),
      selection = document.getSelection()!
    act(() => {
      selection.setBaseAndExtent(text.firstChild!, 0, text.firstChild!, 8)
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
    await screen.findByText('Result: Business turn completed')
    expect(screen.getByText('Selected project · Session').closest('[data-activity-row]')).toBe(
      element,
    )
    expect(document.getSelection()?.toString()).toBe('Selected')
    expect(selection.anchorNode).toBe(text.firstChild)
    expect(selection.anchorOffset).toBe(0)
    expect(selection.focusNode).toBe(text.firstChild)
    expect(selection.focusOffset).toBe(8)
    expect(document.querySelector('[data-activity-row]')).toBe(element)
  })
})
