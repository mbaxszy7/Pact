import { isAbsolute, join, resolve } from 'node:path'

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
    targetFile?: string
    testFile?: string
    allowCollaborateEdit?: boolean
    allowImplementer?: RuntimeAgentId
  },
): string | undefined {
  const targetFile = scope.targetFile ?? 'clamp.mjs'
  const testFile = scope.testFile ?? 'clamp.test.mjs'
  const allowCollaborateEdit = scope.allowCollaborateEdit === true
  const allowedEditStages = allowCollaborateEdit
    ? ['implement', 'collaborate', 'repair']
    : ['implement']
  const allowedCommandStages = allowCollaborateEdit
    ? ['implement', 'code_review', 'collaborate', 'repair']
    : ['implement', 'code_review']
  const expectedImplementer =
    scope.allowImplementer ?? (scope.stage === 'collaborate' ? scope.actor : scope.secondary)

  if (
    scope.requestedAgent !== scope.actor ||
    /^(?:Network (?:enabled|host):|Filesystem\b|Requested write root:)/imu.test(details.detail)
  ) {
    return undefined
  }

  if (scope.requestedAgent === 'agy') {
    if (
      !allowedEditStages.includes(scope.stage ?? '') ||
      scope.requestedAgent !== expectedImplementer
    ) {
      return undefined
    }
    const match = /^Tool: (?:write_file|edit_file)\nPath: ([^\r\n]+)$/u.exec(details.detail)
    if (!match) return undefined
    const rawDisplayPath = match[1]!
    if (
      isAbsolute(rawDisplayPath) ||
      rawDisplayPath.split(/[\\/]/u).includes('..') ||
      resolve(scope.directory, rawDisplayPath) !== resolve(scope.directory, targetFile)
    ) {
      return undefined
    }
    return details.actions.some(
      (action) =>
        action.id === 'agy-allow-once' && action.kind === 'allow' && action.label === 'Allow once',
    )
      ? 'Allow once'
      : undefined
  }

  if (!allowedCommandStages.includes(scope.stage ?? '')) return undefined
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
    resolve(scope.directory, paths[0]!) === resolve(scope.directory, targetFile) &&
    editTitle &&
    allowedEditStages.includes(scope.stage ?? '') &&
    scope.requestedAgent === expectedImplementer
  const commandTitle =
    details.title === (claude ? 'Claude Code wants to use Bash' : 'Codex wants to run a command')
  const commands = new Set([
    `node --test ${testFile}`,
    `node --test ${join(scope.directory, testFile)}`,
    `node --test "${join(scope.directory, testFile)}"`,
    `cd "${scope.directory}" && node --test ${testFile}`,
    `cd '${scope.directory}' && node --test ${testFile}`,
    `cd ${scope.directory} && node --test ${testFile}`,
    `"node" "--test" "${testFile}"`,
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
