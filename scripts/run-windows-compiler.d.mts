export class WindowsCompilerError extends Error {
  constructor(
    reason: string,
    physicalReleased: boolean,
    preserveWorkspace: boolean,
    rootExitCode?: number | null,
  )
  readonly physicalReleased: boolean
  readonly preserveWorkspace: boolean
  readonly rootExitCode: number | null
}

export function runWindowsCompiler(
  args: string[],
  options: {
    cwd: string
    timeout: number
    maxBuffer: number
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
  },
): Promise<{ stdout: string; stderr: string }>
