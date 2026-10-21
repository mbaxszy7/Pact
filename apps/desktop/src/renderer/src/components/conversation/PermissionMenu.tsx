import {
  Check,
  ChevronDown,
  Hand,
  LoaderCircle,
  Settings2,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type {
  AgentRun,
  CollaborationSession,
  RuntimeAgentId,
  SessionPermissionMode,
  SessionPermissionSaveInput,
} from '@pact/contracts'

const modes = {
  native: {
    label: 'Native settings',
    description: 'Use your native permission configuration.',
    Icon: Settings2,
  },
  ask: {
    label: 'Ask for approval',
    description: 'Ask when an action needs your permission.',
    Icon: Hand,
  },
  auto: {
    label: 'Auto',
    description: 'Let the native reviewer assess approval requests.',
    Icon: ShieldCheck,
  },
  full: {
    label: 'Full access',
    description: 'No tool-approval prompts. Task and native policy limits still apply.',
    Icon: ShieldAlert,
  },
}

function focusConfirmationCancel(button: HTMLButtonElement | null): void {
  button?.focus()
}

/** One next-task choice, with the active Run's frozen scope described in existing help. */
export function PermissionMenu({
  session,
  agent = session.settings.primaryAgentId,
  run,
  busy,
  disabled,
  visible = true,
  onSave,
  onNotice,
}: {
  session: CollaborationSession
  agent?: RuntimeAgentId | undefined
  run?: AgentRun | undefined
  busy?: boolean | undefined
  disabled?: boolean | undefined
  visible?: boolean | undefined
  onSave: (input: SessionPermissionSaveInput) => Promise<boolean>
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const open = useRef(false)
  const resumeFocus = useRef(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
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
  const selected =
    session.settings.permissionModes?.[agent] ?? (agent === 'claude' ? 'ask' : 'native')
  const { label, Icon } = modes[selected]
  const current =
    run?.agentId === agent && (busy || ['starting', 'running', 'recovering'].includes(run.status))
      ? run
      : undefined
  const currentMode = current
    ? modes[current.permissionMode ?? (agent === 'claude' ? 'ask' : 'native')].label
    : undefined
  const readOnly =
    current?.collaboration && !['implement', 'repair'].includes(current.collaboration.stage)
  const currentScope = currentMode
    ? `Current task: ${currentMode}.${readOnly ? ' Project changes are blocked during this planning or review task.' : ''}`
    : ''
  const pending =
    run?.agentId === agent &&
    (busy || ['starting', 'running', 'recovering'].includes(run.status)) &&
    (run.permissionMode ?? (agent === 'claude' ? 'ask' : 'native')) !== selected
  const choose = async (
    mode: SessionPermissionMode,
    confirmedFullAccess = false,
  ): Promise<void> => {
    if (inFlight.current) return
    if (mode === selected) {
      panel.current?.hidePopover()
      return
    }
    if (mode === 'full' && !confirmedFullAccess) {
      setConfirming(true)
      return
    }
    if (mode !== 'full') setConfirming(false)
    inFlight.current = true
    setSaving(true)
    try {
      const saved = await onSave({
        sessionId: session.id,
        agentId: agent,
        mode,
        expectedRevision: session.settingsRevision,
        confirmedFullAccess,
      })
      if (!mounted.current) return
      if (saved) {
        panel.current?.hidePopover()
      } else
        onNotice(
          'Permission change was not confirmed. Check the refreshed selection before trying again.',
        )
    } finally {
      inFlight.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const id = `permissions-${session.id}-${agent}`
  const anchor = `--${id}`
  return (
    <div className="flex min-h-8 min-w-0 max-w-full items-center text-caption">
      <button
        ref={trigger}
        type="button"
        popoverTarget={id}
        disabled={disabled || saving}
        title={`Permissions for the next task: ${label}.${currentScope ? ` ${currentScope}` : ''}`}
        aria-label={`${agent === 'claude' ? 'Claude Code' : 'Codex'} permissions for the next task: ${label}`}
        aria-haspopup="menu"
        aria-expanded={expanded}
        style={{ anchorName: anchor }}
        className="pact-agent-trigger max-w-full"
      >
        <Icon
          aria-hidden="true"
          className={`size-3.5 shrink-0 ${selected === 'full' ? 'text-status-warning-foreground' : ''}`}
          strokeWidth={1.75}
        />
        <span className={`truncate ${selected === 'full' ? 'text-status-warning-foreground' : ''}`}>
          {agent === 'claude' ? 'Claude' : 'Codex'} · {label}
        </span>
        <ChevronDown aria-hidden="true" className="pact-agent-chevron size-3 shrink-0" />
      </button>
      {pending ? (
        <output className="truncate text-tertiary" title="Pending · next task">
          &nbsp; Pending · next task
        </output>
      ) : null}
      <div
        id={id}
        ref={panel}
        popover="auto"
        onBeforeToggle={(event) => {
          open.current = event.newState === 'open'
          setExpanded(open.current)
          if (event.newState === 'open') setConfirming(false)
        }}
        style={{
          positionAnchor: anchor,
          left: 'anchor(left)',
          bottom: 'anchor(top)',
          top: 'auto',
          margin: '0 0 8px',
          width: 'min(360px, calc(100vw - 32px))',
          maxHeight: 'calc(100dvh - 64px)',
        }}
        className="pact-agent-popover pact-composer-popover"
        aria-label={`${agent === 'claude' ? 'Claude Code' : 'Codex'} permissions`}
      >
        <p className="pact-composer-menu-heading">
          {agent === 'claude' ? 'Claude Code' : 'Codex'} permissions
        </p>
        {!confirming &&
          (['native', 'ask', 'auto', 'full'] as const).map((mode) => {
            const option = modes[mode]
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={mode === selected}
                aria-expanded={mode === 'full' ? confirming : undefined}
                aria-controls={mode === 'full' ? `${id}-confirmation` : undefined}
                disabled={disabled || saving}
                onClick={() => void choose(mode)}
                className={`pact-composer-menu-item ${mode === 'full' ? 'text-status-warning-foreground' : ''}`}
              >
                <option.Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{option.label}</span>
                  <span className="mt-0.5 block text-secondary">{option.description}</span>
                </span>
                {mode === selected ? (
                  <Check aria-hidden="true" className="size-4 shrink-0" />
                ) : null}
              </button>
            )
          })}
        {confirming ? (
          <section id={`${id}-confirmation`} className="mt-1 px-3 pt-1 pb-1">
            <p className="font-medium text-status-warning-foreground">
              Enable Full access for {agent === 'claude' ? 'Claude Code' : 'Codex'}?
            </p>
            <p className="mt-1.5 leading-relaxed text-secondary">
              Allow files and network access beyond this project without tool-approval prompts. Task
              limits and native policy still apply. Questions and implementation decisions still
              need your response.
            </p>
            <p className="mt-1.5 leading-relaxed text-secondary">
              Only this Agent in this session, including restarts and rebuilds.
            </p>
            <div className="mt-2.5 flex justify-end gap-1.5">
              <button
                type="button"
                ref={focusConfirmationCancel}
                disabled={saving}
                onClick={() => setConfirming(false)}
                className="h-7 cursor-pointer rounded-control px-2.5 text-caption text-secondary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                aria-label={saving ? 'Saving…' : 'Enable Full access'}
                onClick={() => void choose('full', true)}
                className="h-7 cursor-pointer rounded-control bg-surface-inverse px-3 text-caption font-medium text-inverse hover:opacity-90 focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Enable'}
              </button>
            </div>
          </section>
        ) : (
          <p className="pact-composer-menu-detail">
            {saving ? (
              <>
                <LoaderCircle aria-hidden="true" className="mr-1 inline size-3 animate-spin" />
                Saving…
              </>
            ) : (
              `Applies to the next task. ${currentScope || 'Current work is unchanged.'}`
            )}
          </p>
        )}
      </div>
    </div>
  )
}
