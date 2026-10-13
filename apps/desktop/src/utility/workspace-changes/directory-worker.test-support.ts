import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  directoryFileOperationResultSchema,
  type DirectoryFileOperationInput,
  type DirectoryFileOperationResult,
} from '@pact/contracts'

const source = fileURLToPath(new URL('./workspace-directory-worker.ts', import.meta.url))
const bootstrap = `
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw error;
    return nextResolve(specifier.slice(0, -3) + '.ts', context);
  }
} });
const port = new EventEmitter();
port.postMessage = result => process.stdout.write(JSON.stringify(result) + '\\n');
Object.defineProperty(process, 'parentPort', { value: port });
await import(pathToFileURL(process.argv[1]).href);
port.emit('message', { data: JSON.parse(process.argv[2]) });
`

/** Real production directory worker in its own cwd; only Electron's port is adapted. */
export async function runDirectoryWorker(
  input: DirectoryFileOperationInput,
  signal: AbortSignal,
): Promise<DirectoryFileOperationResult> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--input-type=module',
        '--eval',
        bootstrap,
        source,
        JSON.stringify(input),
      ],
      {
        cwd: input.rootPath,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = '',
      stderr = '',
      stopped: Error | undefined
    const stop = (reason: Error) => {
      stopped = reason
      child.kill('SIGKILL')
    }
    const abort = () => stop(new Error('Directory fixture cancelled.'))
    const deadline = setTimeout(
      () => stop(new Error('Directory fixture exceeded its 5-second deadline.')),
      5_000,
    )
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > 64 * 1024)
        stop(new Error('Directory fixture output exceeded its budget.'))
      else stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString().slice(0, 16 * 1024 - stderr.length)
    })
    child.once('error', (error) => {
      stopped = error
    })
    child.once('close', (code) => {
      clearTimeout(deadline)
      signal.removeEventListener('abort', abort)
      if (stopped) {
        reject(stopped)
        return
      }
      if (code !== 0) {
        reject(new Error(`Directory fixture failed (${code}): ${stderr}`))
        return
      }
      try {
        resolve(directoryFileOperationResultSchema.parse(JSON.parse(stdout.trim())))
      } catch (error) {
        reject(error)
      }
    })
  })
}
