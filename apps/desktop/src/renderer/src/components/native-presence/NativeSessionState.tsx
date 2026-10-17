import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Hourglass,
  LoaderCircle,
  MessageSquare,
} from 'lucide-react'

import type { NativeSessionRow } from '@pact/contracts'

export function nativeSessionStateLabel(state: NativeSessionRow['state']): string {
  const labels: Record<NativeSessionRow['state'], string> = {
    preparing: 'Starting',
    running: 'Running',
    recovering: 'Recovering',
    approval: 'Needs approval',
    input: 'Needs your answer',
    attention: 'Needs attention',
    idle: 'Idle',
  }
  return labels[state]
}

export function NativeSessionState({
  state,
}: {
  state: NativeSessionRow['state']
}): React.JSX.Element {
  const Icon =
    state === 'preparing'
      ? Hourglass
      : state === 'running' || state === 'recovering'
        ? LoaderCircle
        : state === 'approval'
          ? CircleHelp
          : state === 'input'
            ? MessageSquare
            : state === 'attention'
              ? CircleAlert
              : CircleCheck
  return (
    <span className="pact-native-session-state text-caption text-secondary">
      <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
      {nativeSessionStateLabel(state)}
    </span>
  )
}
