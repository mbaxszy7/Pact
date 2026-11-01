import { join, resolve } from 'node:path'

import type {
  CollaborationStage,
  NativeApprovalDetails,
  RuntimeAgentId,
} from '../../packages/contracts/src/index.js'

/** One-call UI approval for this owned fixture, never a native profile or Session grant. */
export function stageRoleApprovalLabel(
  details: NativeApprovalDetails,
  scope: {
    directory: string
    stage: CollaborationStage | undefined
    actor: RuntimeAgentId | undefined
    secondary: RuntimeAgentId
    requestedAgent: RuntimeAgentId
  },
): string | undefined {
  if (
    scope.requestedAgent !== scope.actor ||
    !['implement', 'code_review'].includes(scope.stage ?? '') ||
    /^(?:Network (?:enabled|host):|Filesystem\b|Requested write root:)/imu.test(details.detail)
  )
    return undefined
  const directories = [...details.detail.matchAll(/^(?:Session|Working) directory: (.+)$/gmu)]
  if (directories.length !== 1 || resolve(directories[0]![1]!) !== resolve(scope.directory))
    return undefined
  const paths = [...details.detail.matchAll(/^File: (.+)$/gmu)].map((match) => match[1]!)
  const command = /^Command: ([\s\S]*?)\n(?:Session|Working) directory:/u.exec(details.detail)?.[1]
  const claude = scope.requestedAgent === 'claude'
  const editTitle = claude
    ? ['Claude Code wants to use Edit', 'Claude Code wants to use Write'].includes(details.title)
    : details.title === 'Codex wants to apply file changes'
  const fileEdit =
    command === undefined &&
    !details.detail.includes('Command:') &&
    paths.length === 1 &&
    resolve(scope.directory, paths[0]!) === join(scope.directory, 'clamp.mjs') &&
    editTitle &&
    scope.stage === 'implement' &&
    scope.requestedAgent === scope.secondary
  const commandTitle =
    details.title === (claude ? 'Claude Code wants to use Bash' : 'Codex wants to run a command')
  const commands = new Set([
    'node --test clamp.test.mjs',
    `node --test ${join(scope.directory, 'clamp.test.mjs')}`,
    `node --test "${join(scope.directory, 'clamp.test.mjs')}"`,
    `cd "${scope.directory}" && node --test clamp.test.mjs`,
    `cd '${scope.directory}' && node --test clamp.test.mjs`,
    `cd ${scope.directory} && node --test clamp.test.mjs`,
    '"node" "--test" "clamp.test.mjs"',
  ])
  const verification =
    command !== undefined && commands.has(command) && paths.length === 0 && commandTitle
  if (!fileEdit && !verification) return undefined
  const label = claude
    ? 'Allow this tool call'
    : fileEdit
      ? 'Allow these file changes'
      : 'Allow this command'
  return details.actions.some((action) => action.kind === 'allow' && action.label === label)
    ? label
    : undefined
}
