/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Native popover contains keyboard-operated radio menu items. */
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import type {
  AgentRun,
  AgentSpeed,
  CollaborationSession,
  RuntimeAgentId,
  SessionSpeedSaveInput,
} from '@pact/contracts'

const speeds = {
  native: { label: 'Native', description: 'Follow the CLI speed setting.' },
  standard: { label: 'Standard', description: 'Request standard speed.' },
  fast: { label: 'Fast', description: 'Request native acceleration. May increase usage or cost.' },
}

/** Session preference only; admitted Runs retain their frozen settings revision. */
export function SpeedMenu({
  session,
  agent,
  run,
  busy,
  disabled,
  visible,
  onSave,
  onNotice,
}: {
  session: CollaborationSession
  agent: RuntimeAgentId
  run?: AgentRun | undefined
  busy?: boolean | undefined
  disabled?: boolean | undefined
  visible: boolean
  onSave: (input: SessionSpeedSaveInput) => Promise<boolean>
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const open = useRef(false)
  const resumeFocus = useRef(false)
  const returnFocus = useRef(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const selected = session.settings.agents[agent].speed ?? 'native'
  const name = agent === 'claude' ? 'Claude Code' : 'Codex'
  const id = `speed-${session.id}-${agent}`
  const pending =
    run?.agentId === agent &&
    (busy || ['starting', 'running', 'recovering'].includes(run.status)) &&
    (run.speed ?? 'native') !== selected
  const fallback =
    run?.agentId === agent &&
    run.speed === selected &&
    run.observedSpeed === 'standard' &&
    run.speedDetail

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!visible) {
      resumeFocus.current =
        open.current &&
        (panel.current?.contains(document.activeElement) ||
          document.activeElement === trigger.current)
      panel.current?.hidePopover()
    } else if (resumeFocus.current) {
      resumeFocus.current = false
      trigger.current?.focus({ preventScroll: true })
    }
  }, [visible])
  useEffect(() => {
    if (saving || disabled || !returnFocus.current) return
    returnFocus.current = false
    if (
      visible &&
      (document.activeElement === document.body ||
        document.activeElement === trigger.current ||
        panel.current?.contains(document.activeElement))
    )
      trigger.current?.focus({ preventScroll: true })
  }, [saving, disabled, visible])

  const choose = async (speed: AgentSpeed): Promise<void> => {
    if (inFlight.current || disabled) return
    if (speed === selected) {
      panel.current?.hidePopover()
      trigger.current?.focus({ preventScroll: true })
      return
    }
    const startedInMenu = panel.current?.contains(document.activeElement) ?? false
    inFlight.current = true
    setSaving(true)
    try {
      const saved = await onSave({
        sessionId: session.id,
        agentId: agent,
        speed,
        expectedRevision: session.settingsRevision,
      })
      if (!mounted.current) return
      if (saved) {
        returnFocus.current = startedInMenu
        panel.current?.hidePopover()
      } else
        onNotice(
          'Speed change was not confirmed. Check the refreshed selection before trying again.',
        )
    } finally {
      inFlight.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const focusChoice = (): void => {
    panel.current?.querySelector<HTMLButtonElement>(`[data-speed="${selected}"]`)?.focus()
  }
  const navigateChoices = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const choices = Array.from(
      panel.current?.querySelectorAll<HTMLButtonElement>('[data-speed]:not(:disabled)') ?? [],
    )
    if (!choices.length) return
    event.preventDefault()
    const current = choices.findIndex((choice) => choice === document.activeElement)
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? choices.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
    choices[index]?.focus()
  }

  return (
    <div className="shrink-0 text-caption">
      <button
        ref={trigger}
        type="button"
        popoverTarget={id}
        disabled={disabled || saving}
        className="pact-agent-trigger"
        style={{ anchorName: `--${id}` }}
        aria-label={`${name} speed: ${speeds[selected].label}`}
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-controls={id}
        title={`${name} speed for the next run: ${speeds[selected].label}`}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          panel.current?.showPopover()
          focusChoice()
        }}
      >
        <span className="whitespace-nowrap">Speed: {speeds[selected].label}</span>
        <ChevronDown aria-hidden="true" className="pact-agent-chevron size-3 shrink-0" />
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="menu"
        tabIndex={-1}
        aria-label={`${name} speed`}
        className="pact-agent-popover pact-composer-popover"
        style={{ positionAnchor: `--${id}` }}
        onBeforeToggle={(event) => {
          open.current = event.newState === 'open'
          setExpanded(open.current)
        }}
        onToggle={(event) => {
          if (event.newState === 'open') focusChoice()
        }}
        onKeyDown={navigateChoices}
      >
        <p className="pact-composer-menu-heading">{name} · Speed</p>
        {(['native', 'standard', 'fast'] as const).map((speed) => (
          <button
            key={speed}
            type="button"
            role="menuitemradio"
            aria-checked={selected === speed}
            data-speed={speed}
            disabled={disabled || saving}
            onClick={() => void choose(speed)}
            className="pact-composer-menu-item"
          >
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{speeds[speed].label}</span>
              <span className="mt-0.5 block text-secondary">{speeds[speed].description}</span>
            </span>
            {selected === speed ? <Check aria-hidden="true" className="size-4 shrink-0" /> : null}
          </button>
        ))}
        <div className="pact-composer-menu-detail" role="status">
          {saving ? (
            <>
              <LoaderCircle aria-hidden="true" className="mr-1 inline size-3 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <p>Next run · This Session</p>
              {pending ? <p className="mt-1">Current work keeps its original speed.</p> : null}
              {fallback ? <p className="mt-1 text-status-warning-foreground">{fallback}</p> : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
