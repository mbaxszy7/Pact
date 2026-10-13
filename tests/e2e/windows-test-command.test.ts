import { expect, it, vi } from 'vitest'

import {
  matchesWindowsCommandApproval,
  matchesWindowsCommandPreview,
  windowsTextCommand,
} from './windows-test-command.js'

it('requires complete command, exact CWD and exact file scope before a follow-up approval', () => {
  const command = windowsTextCommand('MARKER', 'owned.txt', { newline: true })
  const cwd = 'C:\\owned\\project',
    file = 'C:\\owned\\owned.txt'
  const base = `Command: ${command}\nWorking directory: ${cwd}`
  const details = `${base}\nFilesystem write: ${file}\nFilesystem write path: ${file}`
  expect(matchesWindowsCommandApproval(details, command, cwd, file)).toBe(true)
  expect(
    matchesWindowsCommandApproval(
      base + '\nReason: Execute the requested command.',
      command,
      cwd,
      file,
    ),
  ).toBe(true)
  expect(
    matchesWindowsCommandApproval(
      `Command: ${command}\nanother-command\nWorking directory: ${cwd}`,
      command,
      cwd,
      file,
    ),
  ).toBe(false)
  expect(
    matchesWindowsCommandApproval(base.replace(cwd, 'C:\\different'), command, cwd, file),
  ).toBe(false)
  expect(
    matchesWindowsCommandApproval(details + '\nFilesystem write: C:\\', command, cwd, file),
  ).toBe(false)
  expect(
    matchesWindowsCommandApproval(
      base + '\nNetwork host: example.test\nProtocol: https',
      command,
      cwd,
      file,
    ),
  ).toBe(false)
  expect(
    matchesWindowsCommandApproval(base + `\nWorking directory: ${cwd}`, command, cwd, file),
  ).toBe(false)
  expect(
    matchesWindowsCommandApproval(
      base + `\nFilesystem write: ${file}\nFilesystem write: ${file}`,
      command,
      cwd,
      file,
    ),
  ).toBe(false)
  expect(
    matchesWindowsCommandApproval(
      base + '\nReason: First line\nanother-command',
      command,
      cwd,
      file,
    ),
  ).toBe(false)
})

it('allows only the exact owned command inside the known PowerShell preview', () => {
  vi.stubEnv('PATH', 'C:\\trusted-shell')
  try {
    const command = windowsTextCommand('MARKER', 'owned.txt', { newline: true })
    const prefix = JSON.stringify('C:\\trusted-shell\\pwsh.exe') + ' -Command '
    expect(matchesWindowsCommandPreview(command, command)).toBe(true)
    expect(matchesWindowsCommandPreview(prefix + JSON.stringify(command), command)).toBe(true)
    expect(
      matchesWindowsCommandPreview(prefix + JSON.stringify(command + '; another-command'), command),
    ).toBe(false)
    expect(matchesWindowsCommandPreview(prefix + JSON.stringify(command) + ' extra', command)).toBe(
      false,
    )
    expect(
      matchesWindowsCommandPreview(
        JSON.stringify('C:\\other\\pwsh.exe') + ' -Command ' + JSON.stringify(command),
        command,
      ),
    ).toBe(false)
    expect(
      matchesWindowsCommandPreview(
        prefix + JSON.stringify(command.replace('owned.txt', 'other.txt')),
        command,
      ),
    ).toBe(false)
  } finally {
    vi.unstubAllEnvs()
  }
})
