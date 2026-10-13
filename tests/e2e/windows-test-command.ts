import { win32 } from 'node:path'

/** The complete rendered request must describe only this command, CWD and owned output file. */
export function matchesWindowsCommandApproval(
  detail: string,
  command: string,
  cwd: string,
  outputPath: string,
): boolean {
  if (detail.length > 4096 || detail.includes('\r')) return false
  const lines = detail.split('\n')
  if (
    lines.length < 2 ||
    lines.length > 5 ||
    !lines[0]!.startsWith('Command: ') ||
    !matchesWindowsCommandPreview(lines[0]!.slice('Command: '.length), command) ||
    lines[1] !== `Working directory: ${cwd}`
  )
    return false
  const scopes = new Set([
    `Filesystem write: ${outputPath}`,
    `Filesystem write path: ${outputPath}`,
  ])
  const seen = new Set<string>()
  for (let index = 2; index < lines.length; index++) {
    const line = lines[index]!
    if (line.startsWith('Reason: ') && index === lines.length - 1) continue
    if (!scopes.has(line) || seen.has(line)) return false
    seen.add(line)
  }
  return true
}

/** Compare a Native PowerShell preview to the one authorized command, including its whole argv. */
export function matchesWindowsCommandPreview(preview: string, command: string): boolean {
  if (preview.length > 4096 || command.length > 4096) return false
  if (preview === command) return true
  const match = /^("(?:[^"\\]|\\.)+") -Command ("(?:[^"\\]|\\.)*")$/u.exec(preview)
  if (!match) return false
  try {
    const executable: unknown = JSON.parse(match[1]!)
    const actualCommand: unknown = JSON.parse(match[2]!)
    if (typeof executable !== 'string' || actualCommand !== command) return false
    const searchPath = process.env['PATH'] ?? ''
    const directories = searchPath.split(';')
    if (searchPath.length > 32 * 1024 || directories.length > 128) return false
    const expected = directories.flatMap((directory) =>
      ['pwsh.exe', 'powershell.exe'].map((name) => win32.join(directory, name)),
    )
    expected.push(
      win32.join(
        process.env['SystemRoot'] ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
    )
    return (
      win32.isAbsolute(executable) &&
      expected.some(
        (path) => win32.normalize(path).toLowerCase() === win32.normalize(executable).toLowerCase(),
      )
    )
  } catch {
    return false
  }
}

/** The same bounded Node command runs under PowerShell and Git Bash. */
export function windowsTextCommand(
  marker: string,
  filename: string,
  options: { newline?: boolean; replace?: boolean } = {},
): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(marker) || !/^[A-Za-z0-9_.-]{1,200}$/u.test(filename))
    throw new Error('Unsafe Windows test command data')
  const method = options.replace ? 'writeFileSync' : 'appendFileSync'
  const text = marker + (options.newline ? '\\n' : '')
  return `node -e "require('node:fs').${method}('../${filename}','${text}')"`
}
