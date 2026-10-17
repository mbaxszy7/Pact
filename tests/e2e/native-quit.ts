import { expect, type ElectronApplication, type Page } from '@playwright/test'

import type { WindowsJobMembers, WindowsLaunchOwner } from './windows-cli-launcher.js'

type ReadJobDiagnostic = () => ReturnType<WindowsLaunchOwner['diagnostic']> | undefined

function emitQuitDiagnostic(output: string): void {
  try {
    console.error('[pact-e2e-quit]', output)
  } catch {
    // Observation cannot replace the original lifecycle failure.
  }
}

function projectJobMembers(value: WindowsJobMembers | undefined) {
  if (!value) return undefined
  if (value.members.length > 16) throw new Error('Observation bound')
  return {
    membersIncomplete: value.membersIncomplete,
    members: value.members.map(({ pid, createdMs, role, image }) => ({
      pid,
      createdMs,
      role,
      image,
    })),
  }
}

/** Fixed lifecycle facts only; never publish paths, arguments, native output or raw failures. */
export function recordQuitFailure(
  app: ElectronApplication,
  readJobDiagnostic: ReadJobDiagnostic,
  phase: 'before-dispose' | 'after-dispose',
): void {
  try {
    const child = app.process()
    const job = readJobDiagnostic()
    const stages = [
      'prepared',
      'armed',
      'connected',
      'authenticated',
      'go',
      'started',
      'empty',
      'failed',
    ] as const
    const output = JSON.stringify({
      phase,
      wrapper: { pid: child.pid, exitCode: child.exitCode, signal: child.signalCode },
      job: job
        ? {
            generation: job.generation,
            stages: Object.fromEntries(stages.map((name) => [name, job.stages[name]])),
            controlFailed: Boolean(job.firstFailure),
            nativeErrorCode: job.nativeErrorCode,
            lastActive: job.lastActive,
            exitCode: job.exitCode,
            stoppingReason: job.stoppingReason,
            rootExit: job.rootExit
              ? {
                  pid: job.rootExit.pid,
                  exitCode: job.rootExit.exitCode,
                  elapsedMs: job.rootExit.elapsedMs,
                  natural: job.rootExit.natural,
                  active: job.rootExit.active,
                  ...projectJobMembers(job.rootExit),
                }
              : undefined,
            membersBeforeStop: projectJobMembers(job.membersBeforeStop),
          }
        : null,
    })
    emitQuitDiagnostic(
      Buffer.byteLength(output) <= 8 * 1024
        ? output
        : JSON.stringify({ phase, status: 'overflow' }),
    )
  } catch {
    emitQuitDiagnostic(JSON.stringify({ phase, status: 'unavailable' }))
  }
}

/** Exercise normal Pact shutdown, including an unsettled background-operation confirmation. */
export async function quitPact(
  app: ElectronApplication,
  page?: Page,
  readJobDiagnostic?: ReadJobDiagnostic,
): Promise<void> {
  try {
    const child = app.process()
    if (child.exitCode !== null || child.signalCode !== null) {
      expect(child.exitCode).toBe(0)
      return
    }
    const currentPage = page ?? (await app.firstWindow())
    const closed = app.waitForEvent('close', { timeout: 15_000 })
    const exit = currentPage.getByRole('button', { name: 'Exit Pact', exact: true })
    await app.evaluate(({ app: nativeApp }) => {
      setImmediate(() => nativeApp.quit())
    })
    const confirm = await Promise.race([
      closed.then(() => false),
      exit
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch((error) => {
          if (currentPage.isClosed()) return false
          throw error
        }),
    ])
    if (confirm) await exit.click()
    await closed
    expect(child.exitCode).toBe(0)
  } catch (error) {
    if (readJobDiagnostic) recordQuitFailure(app, readJobDiagnostic, 'before-dispose')
    throw error
  }
}
