import { resolve } from 'node:path'
import { expect, it } from 'vitest'

import type { NativeApprovalDetails, RuntimeAgentId } from '../../packages/contracts/src/index.js'

import { stageRoleApprovalLabel } from './stage-role-approval.js'

const directory = resolve('owned-stage-role-fixture')
const scope = (agent: RuntimeAgentId) => ({
  directory,
  stage: 'implement' as const,
  actor: agent,
  requestedAgent: agent,
  secondary: agent,
})
const command = (agent: RuntimeAgentId): NativeApprovalDetails => ({
  kind: 'approval',
  title: agent === 'claude' ? 'Claude Code wants to use Bash' : 'Codex wants to run a command',
  detail: `Command: node --test clamp.test.mjs\nWorking directory: ${directory}`,
  actions: [
    {
      id: 'once',
      kind: 'allow',
      label: agent === 'claude' ? 'Allow this tool call' : 'Allow this command',
    },
  ],
})
const makeAgyEdit = (
  tool: 'edit_file' | 'write_file',
  pathLine = 'parse-port.mjs',
): NativeApprovalDetails => ({
  kind: 'approval',
  title: 'File parse-port.mjs',
  detail: `Tool: ${tool}\nPath: ${pathLine}`,
  actions: [
    { id: 'agy-allow-once', kind: 'allow', label: 'Allow once' },
    { id: 'agy-reject-once', kind: 'decline', label: 'Decline and continue' },
  ],
})
it.each(['codex', 'claude'] as const)(
  'allows only the exact %s owned verification action',
  (agent) => {
    expect(stageRoleApprovalLabel(command(agent), scope(agent))).toBe(
      command(agent).actions[0]!.label,
    )
    expect(stageRoleApprovalLabel(command(agent), { ...scope(agent), stage: 'code_review' })).toBe(
      command(agent).actions[0]!.label,
    )
    expect(
      stageRoleApprovalLabel(command(agent), { ...scope(agent), stage: 'plan' }),
    ).toBeUndefined()
    expect(
      stageRoleApprovalLabel(command(agent), {
        ...scope(agent),
        actor: agent === 'claude' ? 'codex' : 'claude',
      }),
    ).toBeUndefined()
    expect(
      stageRoleApprovalLabel(
        {
          ...command(agent),
          actions: [{ id: 'rule', kind: 'rule', label: command(agent).actions[0]!.label }],
        },
        scope(agent),
      ),
    ).toBeUndefined()
    expect(
      stageRoleApprovalLabel(
        {
          ...command(agent),
          detail: command(agent).detail.replace(
            'node --test clamp.test.mjs',
            'node --test clamp.test.mjs && echo outside',
          ),
        },
        scope(agent),
      ),
    ).toBeUndefined()
    expect(
      stageRoleApprovalLabel(
        { ...command(agent), title: 'Claude Code wants to use mcp__external__Bash' },
        scope(agent),
      ),
    ).toBeUndefined()
  },
)
it.each([
  'Network enabled: true',
  'Network enabled: false',
  'Network host: example.invalid',
  'Filesystem write: /outside',
  'Filesystem write special scope: root',
  'Filesystem read: /outside',
  'Requested write root: /outside',
])('refuses additional native authority even with the exact command: %s', (profile) => {
  const details = command('codex')
  expect(
    stageRoleApprovalLabel({ ...details, detail: details.detail + '\n' + profile }, scope('codex')),
  ).toBeUndefined()
})
it.each([
  { agent: 'claude', title: 'Claude Code wants to use Edit', label: 'Allow this tool call' },
  { agent: 'claude', title: 'Claude Code wants to use Write', label: 'Allow this tool call' },
  { agent: 'codex', title: 'Codex wants to apply file changes', label: 'Allow these file changes' },
] as const)('limits $title to the sole implementation target', ({ agent, title, label }) => {
  const details: NativeApprovalDetails = {
    kind: 'approval',
    title,
    detail: `File: ${resolve(directory, 'clamp.mjs')}\nSession directory: ${directory}`,
    actions: [{ id: 'once', label, kind: 'allow' }],
  }
  expect(stageRoleApprovalLabel(details, scope(agent))).toBe(label)
  expect(stageRoleApprovalLabel(details, { ...scope(agent), stage: 'code_review' })).toBeUndefined()
  expect(
    stageRoleApprovalLabel(
      { ...details, title: 'Claude Code wants to use mcp__external__WriteAnything' },
      scope(agent),
    ),
  ).toBeUndefined()
  expect(
    stageRoleApprovalLabel(
      { ...details, detail: details.detail.replace('clamp.mjs', 'clamp.test.mjs') },
      scope(agent),
    ),
  ).toBeUndefined()
  expect(
    stageRoleApprovalLabel(
      { ...details, detail: details.detail + `\nFile: ${resolve(directory, 'other.mjs')}` },
      scope(agent),
    ),
  ).toBeUndefined()
  expect(
    stageRoleApprovalLabel(
      { ...details, detail: details.detail + `\nWorking directory: ${directory}` },
      scope(agent),
    ),
  ).toBeUndefined()
})

it('limits agy approvals strictly to Allow once on parameterized single-file edits without commands or path traversal', () => {
  const agyScope = {
    directory,
    stage: 'implement' as const,
    actor: 'agy' as const,
    secondary: 'agy' as const,
    requestedAgent: 'agy' as const,
    targetFile: 'parse-port.mjs',
    testFile: 'parse-port.test.mjs',
  }

  expect(stageRoleApprovalLabel(makeAgyEdit('edit_file'), agyScope)).toBe('Allow once')
  expect(stageRoleApprovalLabel(makeAgyEdit('write_file'), agyScope)).toBe('Allow once')
  expect(
    stageRoleApprovalLabel(makeAgyEdit('edit_file'), {
      ...agyScope,
      stage: 'collaborate',
      allowCollaborateEdit: true,
    }),
  ).toBe('Allow once')
  expect(
    stageRoleApprovalLabel(makeAgyEdit('edit_file'), {
      ...agyScope,
      stage: 'collaborate',
      allowCollaborateEdit: false,
    }),
  ).toBeUndefined()

  // Reject wrong stage, wrong test file, traversal, absolute paths, commands, and non-once actions.
  expect(
    stageRoleApprovalLabel(makeAgyEdit('edit_file'), { ...agyScope, stage: 'plan_review' }),
  ).toBeUndefined()
  expect(
    stageRoleApprovalLabel(makeAgyEdit('edit_file'), { ...agyScope, stage: 'code_review' }),
  ).toBeUndefined()
  expect(
    stageRoleApprovalLabel(makeAgyEdit('edit_file', 'parse-port.test.mjs'), agyScope),
  ).toBeUndefined()
  expect(
    stageRoleApprovalLabel(makeAgyEdit('edit_file', '../outside.mjs'), agyScope),
  ).toBeUndefined()
  expect(
    stageRoleApprovalLabel(
      makeAgyEdit('edit_file', resolve(directory, 'parse-port.mjs')),
      agyScope,
    ),
  ).toBeUndefined()
  expect(
    stageRoleApprovalLabel(
      {
        kind: 'approval',
        title: 'Run command',
        detail: 'Tool: run_command\nCommand: node --test parse-port.test.mjs',
        actions: [{ id: 'agy-allow-once', kind: 'allow', label: 'Allow once' }],
      },
      agyScope,
    ),
  ).toBeUndefined()
  expect(
    stageRoleApprovalLabel(
      {
        ...makeAgyEdit('edit_file'),
        actions: [{ id: 'other-allow', kind: 'allow', label: 'Allow once' }],
      },
      agyScope,
    ),
  ).toBeUndefined()
})

it('supports parameterized Codex file and test targets in dual-agent implement/code_review stages', () => {
  const codexScope = {
    directory,
    stage: 'implement' as const,
    actor: 'codex' as const,
    secondary: 'codex' as const,
    requestedAgent: 'codex' as const,
    targetFile: 'parse-port.mjs',
    testFile: 'parse-port.test.mjs',
  }
  expect(
    stageRoleApprovalLabel(
      {
        kind: 'approval',
        title: 'Codex wants to apply file changes',
        detail: `File: ${resolve(directory, 'parse-port.mjs')}\nWorking directory: ${directory}`,
        actions: [{ id: 'once', kind: 'allow', label: 'Allow these file changes' }],
      },
      codexScope,
    ),
  ).toBe('Allow these file changes')
  expect(
    stageRoleApprovalLabel(
      {
        kind: 'approval',
        title: 'Codex wants to run a command',
        detail: `Command: node --test parse-port.test.mjs\nWorking directory: ${directory}`,
        actions: [{ id: 'once', kind: 'allow', label: 'Allow this command' }],
      },
      { ...codexScope, stage: 'code_review' },
    ),
  ).toBe('Allow this command')
})
