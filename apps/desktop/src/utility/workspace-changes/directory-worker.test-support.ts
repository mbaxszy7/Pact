import { spawn } from 'node:child_process'
import { join } from 'node:path'

import {
  directoryFileOperationResultSchema,
  PROJECT_FILE_PREVIEW_BYTES,
  type DirectoryFileOperationInput,
  type DirectoryFileOperationResult,
} from '@pact/contracts'

export type DirectoryWorkerFault = 'preview-grow' | 'preview-leaf-swap' | 'preview-ancestor-swap'

const leafSwapSource = `import fs from 'node:fs';
const real = fs.promises;
export const link = real.link, lstat = real.lstat, rename = real.rename, stat = real.stat;
let swapped = false;
export async function open(path, ...args) {
  if (!swapped && path === './' + process.env.PACT_TEST_FAULT_LEAF) {
    swapped = true;
    fs.renameSync(path, path + '.owned-original');
    fs.symlinkSync(process.env.PACT_TEST_FAULT_TARGET, path, 'file');
    fs.appendFileSync(process.env.PACT_TEST_FAULT_EVIDENCE, 'swapped\\n');
  }
  return real.open(path, ...args);
}`

const source = join(__dirname, 'workspace-directory-worker.ts')
const bootstrap = (leafSwap: boolean) => `
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const fault = process.env.PACT_TEST_DIRECTORY_FAULT;
const evidence = process.env.PACT_TEST_FAULT_EVIDENCE;
const faultLeaf = process.env.PACT_TEST_FAULT_LEAF || '';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      ${leafSwap} &&
      specifier === 'node:fs/promises' &&
      context.parentURL &&
      context.parentURL.endsWith('/workspace-directory-worker.ts')
    )
      return { url: 'pact-fault://leaf-swap.mjs', format: 'module', shortCircuit: true };
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw error;
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
  },
  load(url, context, nextLoad) {
    if (url === 'pact-fault://leaf-swap.mjs')
      return { format: 'module', source: ${JSON.stringify(leafSwapSource)}, shortCircuit: true };
    return nextLoad(url, context);
  },
});
if (fault) {
  const fsSync = await import('node:fs');
  const fsModule = (await import('node:fs/promises')).default;
  const note = event => { if (evidence) fsSync.appendFileSync(evidence, event + '\\n'); };
  if (fault === 'preview-grow') {
    const probe = await fsModule.open(process.argv[1]);
    const handleProto = Object.getPrototypeOf(probe);
    await probe.close();
    const leaf = './' + faultLeaf;
    const originalRead = handleProto.read;
    let grown = false;
    handleProto.read = async function (...args) {
      if (!grown) {
        grown = true;
        fsSync.appendFileSync(leaf, 'x');
      }
      if (!this.__pactCloseWrapped) {
        this.__pactCloseWrapped = true;
        const ownClose = this.close;
        this.close = async () => {
          const result = await ownClose.call(this);
          note('closed');
          return result;
        };
      }
      return originalRead.apply(this, args);
    };
  } else if (fault === 'preview-ancestor-swap') {
    const originalChdir = process.chdir;
    process.chdir = directory => {
      if (String(directory).endsWith('swapdir')) {
        fsSync.renameSync('./swapdir', './swapdir.orig');
        fsSync.symlinkSync(process.env.PACT_TEST_FAULT_TARGET, './swapdir', 'dir');
        note('swapped');
      }
      return originalChdir(directory);
    };
  }
}
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
  fault?: { kind: DirectoryWorkerFault; evidence: string; target?: string },
): Promise<DirectoryFileOperationResult> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    delete env.PACT_TEST_DIRECTORY_FAULT
    delete env.PACT_TEST_FAULT_EVIDENCE
    delete env.PACT_TEST_FAULT_LEAF
    delete env.PACT_TEST_FAULT_TARGET
    if (fault) {
      env.PACT_TEST_DIRECTORY_FAULT = fault.kind
      env.PACT_TEST_FAULT_EVIDENCE = fault.evidence
      env.PACT_TEST_FAULT_LEAF = input.name
      if (fault.target) env.PACT_TEST_FAULT_TARGET = fault.target
    }
    const budget = input.operation === 'preview' ? PROJECT_FILE_PREVIEW_BYTES + 1 : 64 * 1024
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--input-type=module',
        '--eval',
        bootstrap(fault?.kind === 'preview-leaf-swap'),
        source,
        JSON.stringify(input),
      ],
      {
        cwd: input.rootPath,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      },
    )
    let stdout = '',
      stderr = '',
      stdoutBytes = 0,
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
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const chunkBytes = Buffer.byteLength(chunk, 'utf8')
      if (stdoutBytes + chunkBytes > budget) {
        stop(new Error('Directory fixture output exceeded its budget.'))
        return
      }
      stdoutBytes += chunkBytes
      stdout += chunk
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
