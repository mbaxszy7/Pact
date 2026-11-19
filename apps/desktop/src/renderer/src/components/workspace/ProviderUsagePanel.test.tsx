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
import { isUsageSnapshotStale, useProviderUsage } from './useProviderUsage'

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
      agy: makeSnapshot('agy', {
        status: 'ready',
        fiveHour: { usedPercent: 15, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
        sevenDay: null,
        checkedAt: new Date().toISOString(),
        identityConfirmed: true,
        message: 'Gemini Models quota',
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
    const resetAgy = new Date(now.getTime() + 45 * 60_000).toISOString()

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
      agy: makeSnapshot('agy', {
        status: 'ready',
        fiveHour: { usedPercent: 30, resetsAt: resetAgy }, // 70% left -> normal
        sevenDay: null,
        checkedAt: now.toISOString(),
        identityConfirmed: true,
        message: 'Gemini Models quota',
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

    const agySection = compact.querySelector<HTMLElement>('[data-provider-usage="agy"]')!
    expect(within(agySection).getByText('Antigravity')).not.toBeNull()
    expect(within(agySection).getByText('Gemini Models quota')).not.toBeNull()
    expect(screen.getByText('Antigravity 5h: 70% left')).not.toBeNull()

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
    expect(within(detailed).getByText('Resets in 45m')).not.toBeNull()
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

    const readyAgy = makeSnapshot('agy', {
      status: 'ready',
      fiveHour: { usedPercent: 25, resetsAt: new Date(now + 3600_000).toISOString() },
      sevenDay: null,
      checkedAt: new Date(now).toISOString(),
      cooldownUntil,
      identityConfirmed: true,
      message: 'Gemini Models quota',
    })

    const bridge = setupUsageBridge(
      {
        codex: makeSnapshot('codex'),
        claude: makeSnapshot('claude'),
        agy: makeSnapshot('agy'),
      },
      async (provider) => ({
        ok: true,
        value: provider === 'codex' ? failedCodex : provider === 'agy' ? readyAgy : readyClaude,
      }),
    )

    // Passive mount must only read cached snapshots and never spawn external probes before user interaction.
    const view = render(<ProviderUsagePanel visible />)
    await waitFor(() => expect(bridge.getProviderUsage).toHaveBeenCalledTimes(3))
    expect(bridge.refreshProviderUsage).not.toHaveBeenCalled()

    // First click opens detailed popover and triggers initial probes -> unavailable during cooldown.
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))
    await waitFor(() => expect(bridge.refreshProviderUsage).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.getByText('Unavailable')).not.toBeNull())
    const refreshAfterFirst = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Refresh Codex',
    })
    expect(refreshAfterFirst.disabled).toBe(true)

    // Simulate navigating to Settings (unmounts ProjectNavigation/ProviderUsagePanel) and returning!
    view.unmount()
    render(<ProviderUsagePanel visible />)
    await waitFor(() => expect(bridge.getProviderUsage).toHaveBeenCalledTimes(6))

    // Must NOT start another refreshProviderUsage during cooldown, and must preserve 'Unavailable'!
    expect(bridge.refreshProviderUsage).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))
    expect(screen.getByText('Unavailable')).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh Codex' }).disabled).toBe(
      true,
    )
    expect(bridge.refreshProviderUsage).toHaveBeenCalledTimes(3)
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
    expect(getProviderUsage).toHaveBeenCalledTimes(4) // 1 initial codex + 1 initial claude + 1 initial agy + 1 scheduled codex

    // Advance well past 350ms: no duplicate/stray scheduler polls run once settled.
    await act(async () => {
      vi.advanceTimersByTime(1000)
      await Promise.resolve()
    })
    expect(getProviderUsage).toHaveBeenCalledTimes(4)

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

  it('renders multiple Antigravity quota pools in compact and detailed popovers, formats >24h resets in English, and aggregates badge/stale state across all pools', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-11-19T17:20:00.000Z')
    vi.setSystemTime(now)
    const resetFive = new Date(now.getTime() + 4 * 60 * 60_000).toISOString()
    const resetSevenGemini = new Date(now.getTime() + 5 * 86_400_000).toISOString()
    const resetSevenPartner = new Date(now.getTime() + 6 * 86_400_000).toISOString()

    setupUsageBridge({
      codex: makeSnapshot('codex', {
        status: 'ready',
        fiveHour: null,
        sevenDay: { usedPercent: 22, resetsAt: resetSevenGemini },
        checkedAt: now.toISOString(),
        identityConfirmed: true,
      }),
      claude: makeSnapshot('claude', {
        status: 'not_applicable',
        checkedAt: now.toISOString(),
        identityConfirmed: true,
        message: 'No plan limits',
      }),
      agy: makeSnapshot('agy', {
        status: 'ready',
        fiveHour: { usedPercent: 1, resetsAt: resetFive },
        sevenDay: { usedPercent: 54, resetsAt: resetSevenGemini },
        pools: [
          {
            id: 'gemini',
            label: 'Gemini Models',
            fiveHour: { usedPercent: 1, resetsAt: resetFive },
            sevenDay: { usedPercent: 54, resetsAt: resetSevenGemini },
          },
          {
            id: 'claude-gpt',
            label: 'Claude & GPT',
            fiveHour: { usedPercent: 0, resetsAt: resetFive },
            sevenDay: { usedPercent: 96, resetsAt: resetSevenPartner }, // 4% left -> danger
          },
        ],
        checkedAt: now.toISOString(),
        identityConfirmed: false,
        message: 'Gemini Models quota',
      }),
    })

    render(<ProviderUsagePanel visible />)
    await act(async () => {
      await Promise.resolve()
    })

    // Danger dot reflects <=5% left in the secondary Claude & GPT pool even when Gemini is 99% left.
    const trigger = screen.getByRole('button', { name: 'Usage' })
    expect(trigger.querySelector('.bg-status-danger')).not.toBeNull()

    // Compact hover popover shows both pools without duplicating the single-pool message caption.
    fireEvent.mouseEnter(trigger)
    act(() => {
      vi.advanceTimersByTime(75)
    })
    const compact = screen.getByRole('dialog', { name: 'Usage' })
    const compactAgy = compact.querySelector<HTMLElement>('[data-provider-usage="agy"]')!
    expect(within(compactAgy).getByText('Gemini Models')).not.toBeNull()
    expect(within(compactAgy).getByText('Claude & GPT')).not.toBeNull()
    expect(within(compactAgy).queryByText('Gemini Models quota')).toBeNull()
    expect(within(compactAgy).getByText('Antigravity Gemini Models 5h: 99% left')).not.toBeNull()
    expect(within(compactAgy).getByText('Antigravity Gemini Models 7d: 46% left')).not.toBeNull()
    expect(within(compactAgy).getByText('Antigravity Claude & GPT 5h: 100% left')).not.toBeNull()
    expect(within(compactAgy).getByText('Antigravity Claude & GPT 7d: 4% left')).not.toBeNull()

    // Detailed click popover shows English weekday + 24h reset times (never Chinese locale text).
    fireEvent.click(trigger)
    const detailed = screen.getByRole('dialog', { name: 'Usage' })
    expect(detailed.getAttribute('data-provider-usage-popover')).toBe('detailed')
    const resetLines = within(detailed).getAllByText(/^Resets /u)
    expect(resetLines.length).toBeGreaterThanOrEqual(3)
    const weekdayLines = resetLines.filter((el) => !el.textContent?.startsWith('Resets in '))
    expect(weekdayLines.length).toBeGreaterThanOrEqual(3)
    for (const el of weekdayLines) {
      expect(el.textContent).toMatch(/^Resets (?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}$/u)
    }

    // Secondary pool reset expiry triggers stale detection via isUsageSnapshotStale.
    const expiredSecondary = makeSnapshot('agy', {
      status: 'ready',
      fiveHour: { usedPercent: 1, resetsAt: new Date(now.getTime() + 600_000).toISOString() },
      sevenDay: { usedPercent: 50, resetsAt: new Date(now.getTime() + 600_000).toISOString() },
      pools: [
        {
          id: 'gemini',
          label: 'Gemini Models',
          fiveHour: { usedPercent: 1, resetsAt: new Date(now.getTime() + 600_000).toISOString() },
          sevenDay: { usedPercent: 50, resetsAt: new Date(now.getTime() + 600_000).toISOString() },
        },
        {
          id: 'claude-gpt',
          label: 'Claude & GPT',
          fiveHour: { usedPercent: 10, resetsAt: new Date(now.getTime() - 1_000).toISOString() },
          sevenDay: { usedPercent: 20, resetsAt: new Date(now.getTime() + 600_000).toISOString() },
        },
      ],
      checkedAt: now.toISOString(),
      identityConfirmed: false,
    })
    expect(isUsageSnapshotStale(expiredSecondary, now.getTime())).toBe(true)
  })
})
