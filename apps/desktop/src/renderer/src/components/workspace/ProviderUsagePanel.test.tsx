// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DesktopBridge,
  Project,
  ProviderUsageProvider,
  ProviderUsageSnapshot,
  RpcResult,
} from '@pact/contracts'

import type { SessionWorkspaceFlow } from './useSessionWorkspace'

import { ProjectNavigation } from './ProjectNavigation'
import { ProviderUsagePanel } from './ProviderUsagePanel'
import { useProviderUsage } from './useProviderUsage'

function UsageStatusHarness() {
  const state = useProviderUsage(true)
  return (
    <div>
      <output aria-label="Codex status">{state.snapshots.codex.status}</output>
      <output aria-label="Codex 5h">{state.snapshots.codex.fiveHour?.usedPercent ?? 'none'}</output>
    </div>
  )
}

function UsageRefreshHarness() {
  const state = useProviderUsage(true)
  return (
    <div>
      <button type="button" onClick={() => state.refresh('codex')}>
        Refresh
      </button>
      <output aria-label="Status">{state.snapshots.codex.status}</output>
      <output aria-label="Percent">{state.snapshots.codex.fiveHour?.usedPercent ?? 'none'}</output>
    </div>
  )
}

function makeSnapshot(
  provider: ProviderUsageProvider,
  overrides: Partial<ProviderUsageSnapshot> = {},
): ProviderUsageSnapshot {
  return {
    provider,
    revision: 1,
    status: 'idle',
    fiveHour: null,
    sevenDay: null,
    checkedAt: null,
    cooldownUntil: null,
    identityConfirmed: false,
    ...overrides,
  }
}

function setupUsageBridge(
  initial: Record<ProviderUsageProvider, ProviderUsageSnapshot>,
  refreshImpl?: (
    provider: ProviderUsageProvider,
    requestId: string,
  ) => Promise<RpcResult<ProviderUsageSnapshot>>,
) {
  const current = { ...initial }
  const getProviderUsage = vi.fn<DesktopBridge['getProviderUsage']>(async ({ provider }) => ({
    ok: true,
    value: current[provider],
  }))
  const refreshProviderUsage = vi.fn<DesktopBridge['refreshProviderUsage']>(
    async ({ provider, requestId }) => {
      if (refreshImpl) {
        const res = await refreshImpl(provider, requestId)
        if (res.ok) current[provider] = res.value
        return res
      }
      return { ok: true, value: current[provider] }
    },
  )
  const cancelProviderUsage = vi.fn<DesktopBridge['cancelProviderUsage']>(async () => ({
    ok: true,
    value: { cancelled: true, settled: true },
  }))
  vi.stubGlobal('pact', {
    getProviderUsage,
    refreshProviderUsage,
    cancelProviderUsage,
  })
  return { current, getProviderUsage, refreshProviderUsage, cancelProviderUsage }
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ProviderUsagePanel & useProviderUsage', () => {
  it('places Usage icon trigger directly above Settings in ProjectNavigation', () => {
    setupUsageBridge({
      codex: makeSnapshot('codex', {
        status: 'ready',
        fiveHour: { usedPercent: 10, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
        sevenDay: { usedPercent: 20, resetsAt: new Date(Date.now() + 7200_000).toISOString() },
        checkedAt: new Date().toISOString(),
        identityConfirmed: true,
      }),
      claude: makeSnapshot('claude', {
        status: 'ready',
        fiveHour: { usedPercent: 10, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
        sevenDay: { usedPercent: 20, resetsAt: new Date(Date.now() + 7200_000).toISOString() },
        checkedAt: new Date().toISOString(),
        identityConfirmed: true,
      }),
    })

    const project: Project = {
      id: crypto.randomUUID(),
      name: 'Demo',
      directoryPath: '/tmp/demo',
      kind: 'directory',
      createdAt: '2026-11-16T10:00:00.000Z',
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Controlled navigation workspace stub for layout verification.
    const workspace = {
      catalog: { navigation: { projects: {} }, sessions: [] },
      creating: false,
      writingOrganization: false,
      checkingWrite: false,
      setVisibleWindows: vi.fn<() => void>(),
    } as unknown as SessionWorkspaceFlow

    render(
      <ProjectNavigation
        projects={[project]}
        sessions={[]}
        workspace={workspace}
        loading={false}
        adding={false}
        settingsButtonRef={{ current: null }}
        onAddProject={vi.fn<() => void>()}
        onArchiveProject={vi.fn<() => void>()}
        onRenameProject={vi.fn<() => Promise<{ ok: true; value: never }>>()}
        onOpenSettings={vi.fn<() => void>()}
        onRetrySessions={vi.fn<() => void>()}
        onStartSession={vi.fn<() => void>()}
        onSelectSession={vi.fn<() => void>()}
        onArchiveSession={vi.fn<() => void>()}
      />,
    )

    const usageButton = screen.getByRole('button', { name: 'Usage' })
    const settingsButton = screen.getByRole('button', { name: 'Settings' })
    expect(usageButton.parentElement).toBe(settingsButton.parentElement)
    expect(usageButton.nextElementSibling).toBe(settingsButton)
  })

  it('displays % left with warning (<=20%) and danger (<=5%) thresholds, omits absent windows, and distinguishes hover compact vs click detailed popovers', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-11-16T10:00:00.000Z')
    vi.setSystemTime(now)
    const resetFive = new Date(now.getTime() + 90 * 60_000).toISOString()
    const resetSeven = new Date(now.getTime() + 3600_000).toISOString()

    setupUsageBridge({
      codex: makeSnapshot('codex', {
        status: 'partial',
        fiveHour: { usedPercent: 80, resetsAt: resetFive }, // 20% left -> warning
        sevenDay: null, // absent 7d omitted
        checkedAt: now.toISOString(),
        cooldownUntil: new Date(now.getTime() + 25_000).toISOString(),
        identityConfirmed: true,
      }),
      claude: makeSnapshot('claude', {
        status: 'partial',
        fiveHour: null, // absent 5h omitted
        sevenDay: { usedPercent: 95, resetsAt: resetSeven }, // 5% left -> danger
        checkedAt: now.toISOString(),
        identityConfirmed: true,
      }),
    })

    render(<ProviderUsagePanel visible />)
    await act(async () => {
      await Promise.resolve()
    })

    const trigger = screen.getByRole('button', { name: 'Usage' })
    // Danger (<=5%) takes precedence over warning (<=20%) on trigger dot.
    expect(trigger.querySelector('.bg-status-danger')).not.toBeNull()

    // Hover opens compact popover after 70ms without reset times or Refresh buttons.
    fireEvent.mouseEnter(trigger)
    act(() => {
      vi.advanceTimersByTime(75)
    })
    const compact = screen.getByRole('dialog', { name: 'Usage' })
    expect(compact.getAttribute('data-provider-usage-popover')).toBe('compact')
    expect(screen.getByText('Codex 5h: 20% left')).not.toBeNull()
    expect(screen.queryByText(/Codex 7d/u)).toBeNull()
    expect(screen.getByText('Claude Code 7d: 5% left')).not.toBeNull()
    expect(screen.queryByText(/Claude Code 5h/u)).toBeNull()
    expect(within(compact).queryByText(/Resets/u)).toBeNull()
    expect(within(compact).queryByRole('button', { name: /Refresh/u })).toBeNull()

    const codexSection = compact.querySelector('[data-provider-usage="codex"]')!
    expect(codexSection.querySelector('.bg-status-warning')).not.toBeNull()
    expect(codexSection.querySelector('.text-status-warning-foreground')).not.toBeNull()

    const claudeSection = compact.querySelector('[data-provider-usage="claude"]')!
    expect(claudeSection.querySelector('.bg-status-danger')).not.toBeNull()
    expect(claudeSection.querySelector('.text-status-danger-foreground')).not.toBeNull()

    // Leaving hover closes compact popover after 140ms.
    fireEvent.mouseLeave(trigger)
    act(() => {
      vi.advanceTimersByTime(145)
    })
    expect(screen.queryByRole('dialog', { name: 'Usage' })).toBeNull()

    // Clicking trigger opens detailed popover with reset times and Refresh controls.
    fireEvent.click(trigger)
    const detailed = screen.getByRole('dialog', { name: 'Usage' })
    expect(detailed.getAttribute('data-provider-usage-popover')).toBe('detailed')
    expect(within(detailed).getByText('Resets in 1h 30m')).not.toBeNull()
    expect(within(detailed).getByText('Resets in 1h')).not.toBeNull()
    const refreshCodex = within(detailed).getByRole<HTMLButtonElement>('button', {
      name: 'Refresh Codex',
    })
    expect(refreshCodex.disabled).toBe(true)
    expect(refreshCodex.title).toBe('Refresh available in 25s')
    expect(
      within(detailed).getByRole<HTMLButtonElement>('button', { name: 'Refresh Claude Code' })
        .disabled,
    ).toBe(false)

    // Escape closes detailed popover.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Usage' })).toBeNull()
  })

  it('persists initial failure snapshot across Settings round-trip during cooldown without re-probing', async () => {
    const now = Date.now()
    const cooldownUntil = new Date(now + 30_000).toISOString()
    const failedCodex = makeSnapshot('codex', {
      status: 'unavailable',
      checkedAt: new Date(now).toISOString(),
      cooldownUntil,
      identityConfirmed: false,
      message: 'Unavailable',
    })
    const readyClaude = makeSnapshot('claude', {
      status: 'ready',
      fiveHour: { usedPercent: 12, resetsAt: new Date(now + 3600_000).toISOString() },
      sevenDay: { usedPercent: 34, resetsAt: new Date(now + 7200_000).toISOString() },
      checkedAt: new Date(now).toISOString(),
      cooldownUntil,
      identityConfirmed: true,
    })

    const bridge = setupUsageBridge(
      {
        codex: makeSnapshot('codex'),
        claude: makeSnapshot('claude'),
      },
      async (provider) => ({
        ok: true,
        value: provider === 'codex' ? failedCodex : readyClaude,
      }),
    )

    // Passive mount must only read cached snapshots and never spawn external probes before user interaction.
    const view = render(<ProviderUsagePanel visible />)
    await waitFor(() => expect(bridge.getProviderUsage).toHaveBeenCalledTimes(2))
    expect(bridge.refreshProviderUsage).not.toHaveBeenCalled()

    // First click opens detailed popover and triggers initial probes -> unavailable during cooldown.
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))
    await waitFor(() => expect(bridge.refreshProviderUsage).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('Unavailable')).not.toBeNull())
    const refreshAfterFirst = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Refresh Codex',
    })
    expect(refreshAfterFirst.disabled).toBe(true)

    // Simulate navigating to Settings (unmounts ProjectNavigation/ProviderUsagePanel) and returning!
    view.unmount()
    render(<ProviderUsagePanel visible />)
    await waitFor(() => expect(bridge.getProviderUsage).toHaveBeenCalledTimes(4))

    // Must NOT start another refreshProviderUsage during cooldown, and must preserve 'Unavailable'!
    expect(bridge.refreshProviderUsage).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))
    expect(screen.getByText('Unavailable')).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh Codex' }).disabled).toBe(
      true,
    )
    expect(bridge.refreshProviderUsage).toHaveBeenCalledTimes(2)
  })

  it('recovers from cancelling with a single scheduler in useProviderUsage', async () => {
    vi.useFakeTimers()
    const snapshotsQueue: ProviderUsageSnapshot[] = [
      makeSnapshot('codex', { status: 'cancelling' }),
      makeSnapshot('codex', {
        status: 'ready',
        fiveHour: { usedPercent: 15, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
        sevenDay: null,
        checkedAt: new Date().toISOString(),
        identityConfirmed: true,
      }),
    ]

    const getProviderUsage = vi.fn<DesktopBridge['getProviderUsage']>(async ({ provider }) => {
      if (provider === 'codex') {
        return {
          ok: true,
          value: snapshotsQueue.shift() ?? makeSnapshot('codex', { status: 'ready' }),
        }
      }
      return {
        ok: true,
        value: makeSnapshot('claude', {
          status: 'ready',
          fiveHour: { usedPercent: 5, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
          sevenDay: null,
          checkedAt: new Date().toISOString(),
          identityConfirmed: true,
        }),
      }
    })
    const refreshProviderUsage = vi.fn<DesktopBridge['refreshProviderUsage']>(
      async ({ provider }) => ({
        ok: true,
        value: makeSnapshot(provider, { status: 'cancelling' }),
      }),
    )
    const cancelProviderUsage = vi.fn<DesktopBridge['cancelProviderUsage']>(async () => ({
      ok: true,
      value: { cancelled: true, settled: true },
    }))
    vi.stubGlobal('pact', {
      getProviderUsage,
      refreshProviderUsage,
      cancelProviderUsage,
    })

    render(<UsageStatusHarness />)

    // Initial getProviderUsage returns idle for codex? Here queue first returns 'cancelling'.
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('status', { name: 'Codex status' }).textContent).toBe('cancelling')
    expect(refreshProviderUsage).not.toHaveBeenCalled()

    // 350ms later, single scheduler polls getProviderUsage and recovers to 'ready'.
    await act(async () => {
      vi.advanceTimersByTime(355)
      await Promise.resolve()
    })
    expect(screen.getByRole('status', { name: 'Codex status' }).textContent).toBe('ready')
    expect(screen.getByRole('status', { name: 'Codex 5h' }).textContent).toBe('15')
    expect(getProviderUsage).toHaveBeenCalledTimes(3) // 1 initial codex + 1 initial claude + 1 scheduled codex

    // Advance well past 350ms: no duplicate/stray scheduler polls run once settled.
    await act(async () => {
      vi.advanceTimersByTime(1000)
      await Promise.resolve()
    })
    expect(getProviderUsage).toHaveBeenCalledTimes(3)

    // Also verify refreshProviderUsage -> 'cancelling' -> single 350ms sync -> 'idle' -> refreshes once.
    cleanup()
    const statesAfterCancel: ProviderUsageSnapshot[] = [
      makeSnapshot('codex', { status: 'cancelling' }),
      makeSnapshot('codex', {
        status: 'idle',
      }),
    ]
    const get2 = vi.fn<DesktopBridge['getProviderUsage']>(async ({ provider }) => ({
      ok: true,
      value:
        provider === 'codex'
          ? (statesAfterCancel.shift() ?? makeSnapshot('codex', { status: 'idle' }))
          : makeSnapshot('claude', {
              status: 'ready',
              fiveHour: { usedPercent: 5, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
              sevenDay: null,
              checkedAt: new Date().toISOString(),
              identityConfirmed: true,
            }),
    }))
    let codexRefreshCount = 0
    const refresh2 = vi.fn<DesktopBridge['refreshProviderUsage']>(async ({ provider }) => {
      if (provider === 'codex') {
        codexRefreshCount += 1
        return {
          ok: true,
          value:
            codexRefreshCount === 1
              ? makeSnapshot('codex', { status: 'cancelling' })
              : makeSnapshot('codex', {
                  status: 'ready',
                  fiveHour: {
                    usedPercent: 30,
                    resetsAt: new Date(Date.now() + 3600_000).toISOString(),
                  },
                  sevenDay: null,
                  checkedAt: new Date().toISOString(),
                  identityConfirmed: true,
                }),
        }
      }
      return { ok: true, value: makeSnapshot('claude', { status: 'ready' }) }
    })
    vi.stubGlobal('pact', {
      getProviderUsage: get2,
      refreshProviderUsage: refresh2,
      cancelProviderUsage,
    })

    render(<UsageRefreshHarness />)
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('status', { name: 'Status' }).textContent).toBe('cancelling')

    // Second cancelling poll at +350ms, then settles to idle at +700ms without auto-starting another CLI probe.
    await act(async () => {
      vi.advanceTimersByTime(355)
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(355)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('status', { name: 'Status' }).textContent).toBe('idle')
    expect(codexRefreshCount).toBe(1)

    // Subsequent user Refresh succeeds without getting stuck in cancelling.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('status', { name: 'Status' }).textContent).toBe('ready')
    expect(screen.getByRole('status', { name: 'Percent' }).textContent).toBe('30')
    expect(codexRefreshCount).toBe(2)

    // Verify close_unconfirmed uses exponential backoff and clears once resolved.
    cleanup()
    const closeQueue: ProviderUsageSnapshot[] = [
      makeSnapshot('codex', { status: 'close_unconfirmed', message: 'Wait to retry' }),
      makeSnapshot('codex', { status: 'close_unconfirmed', message: 'Wait to retry' }),
      makeSnapshot('codex', { status: 'idle' }),
    ]
    const getClose = vi.fn<DesktopBridge['getProviderUsage']>(async ({ provider }) => ({
      ok: true,
      value:
        provider === 'codex'
          ? (closeQueue.shift() ?? makeSnapshot('codex', { status: 'idle' }))
          : makeSnapshot('claude', { status: 'idle' }),
    }))
    vi.stubGlobal('pact', {
      getProviderUsage: getClose,
      refreshProviderUsage: refresh2,
      cancelProviderUsage,
    })

    render(<UsageStatusHarness />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('status', { name: 'Codex status' }).textContent).toBe(
      'close_unconfirmed',
    )
    await act(async () => {
      vi.advanceTimersByTime(355) // 1st backoff = 350ms
      await Promise.resolve()
    })
    expect(screen.getByRole('status', { name: 'Codex status' }).textContent).toBe(
      'close_unconfirmed',
    )
    await act(async () => {
      vi.advanceTimersByTime(705) // 2nd backoff = 700ms
      await Promise.resolve()
    })
    expect(screen.getByRole('status', { name: 'Codex status' }).textContent).toBe('idle')
  })
})
