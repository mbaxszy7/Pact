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
