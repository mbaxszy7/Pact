import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { ipcTrafficMeasurementSchema } from '@pact/contracts'

import {
  LogicalIpcWorkerTraffic,
  logicalIpcMeasurement,
  observeWorkerTraffic,
} from '../../shared/logical-ipc-traffic'
import { AgentExecutionError } from './agent-execution-error'

const PARSER_DEADLINE_MS = 10_000
const PARSER_WORKER_LIMIT = 5
const PARSER_WAITER_LIMIT = 8
let activeWorkers = 0
const waiting = new Set<() => void>()

const unavailable = (): AgentExecutionError =>
  new AgentExecutionError(
    'protocol_error',
    'Native frame parsing was interrupted or exceeded its deadline.',
    false,
  )

/** Large Native DTOs cross the existing process trust seam away from the Utility event loop.
 * One invocation owns its bytes, one Worker and a ten-second absolute deadline (including admission).
 * Caller reserves raw/decoded/Worker and returned-clone workspace before invoking. Success, abort,
 * OOM and timeout all await actual Worker termination before returning its capacity to the owner.
 */
export async function parseNativeJsonFrame(
  bytes: Buffer,
  signal: AbortSignal,
  ipcTraffic?: LogicalIpcWorkerTraffic,
): Promise<{ message: unknown; heldBytes: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PARSER_DEADLINE_MS)
  const observed = AbortSignal.any([signal, controller.signal])
  let worker: Worker | undefined
  let acquired = false
  try {
    observed.throwIfAborted()
    if (activeWorkers >= PARSER_WORKER_LIMIT) {
      if (waiting.size >= PARSER_WAITER_LIMIT)
        throw new AgentExecutionError(
          'runtime_incompatible',
          'Native parser capacity is full.',
          false,
        )
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          waiting.delete(available)
          observed.removeEventListener('abort', cancelled)
        }
        const available = (): void => {
          if (activeWorkers >= PARSER_WORKER_LIMIT) return
          cleanup()
          activeWorkers += 1
          acquired = true
          resolve()
        }
        const cancelled = (): void => {
          cleanup()
          reject(unavailable())
        }
        waiting.add(available)
        observed.addEventListener('abort', cancelled, { once: true })
        if (observed.aborted) cancelled()
      })
    } else {
      activeWorkers += 1
      acquired = true
    }
    observed.throwIfAborted()
    // Buffer.concat gives this large frame a dedicated backing buffer; copy only if an
    // unusual stream supplied a slab/shared view. Transfer prevents a second raw-frame copy.
    const data =
      bytes.byteOffset === 0 &&
      bytes.buffer.byteLength === bytes.length &&
      bytes.buffer instanceof ArrayBuffer
        ? bytes
        : Uint8Array.from(bytes)
    if (!(data.buffer instanceof ArrayBuffer)) throw unavailable()
    const traffic = ipcTraffic?.collector('utility-native-json')
    const initial = traffic ? { bytes: data, measure: true } : data
    const initMeasurement = traffic ? logicalIpcMeasurement(initial) : undefined
    worker = new Worker(join(__dirname, 'native-json-parser-worker.js'), {
      workerData: initial,
      transferList: [data.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
    })
    if (initMeasurement)
      traffic?.recordMeasurement('utility-native-json.init', 'business', initMeasurement)
    observeWorkerTraffic(
      worker,
      traffic,
      'utility-native-json.init',
      'native-json-utility.reply',
      'business',
      false,
    )
    const owned = worker
    return await new Promise<{ message: unknown; heldBytes: number }>((resolve, reject) => {
      const cancelled = (): void => reject(unavailable())
      observed.addEventListener('abort', cancelled, { once: true })
      owned.once('message', (result: unknown) => {
        if (traffic) {
          const measurement = ipcTrafficMeasurementSchema.safeParse(
            result && typeof result === 'object'
              ? Reflect.get(result, 'ipcMeasurement')
              : undefined,
          )
          if (measurement.success)
            traffic.recordMeasurement('native-json-utility.reply', 'business', measurement.data)
          else traffic.invalidate('unvalidated_message')
        }
        observed.removeEventListener('abort', cancelled)
        if (
          !result ||
          typeof result !== 'object' ||
          Object.hasOwn(result, 'error') ||
          typeof Reflect.get(result, 'heldBytes') !== 'number' ||
          !Number.isSafeInteger(Reflect.get(result, 'heldBytes')) ||
          Reflect.get(result, 'heldBytes') < 0
        )
          reject(
            new AgentExecutionError('protocol_error', 'Native returned an invalid frame.', false),
          )
        else
          resolve({
            message: Reflect.get(result, 'message'),
            heldBytes: Reflect.get(result, 'heldBytes'),
          })
      })
      owned.once('error', () => {
        observed.removeEventListener('abort', cancelled)
        reject(
          new AgentExecutionError(
            'protocol_error',
            'Native frame parsing failed within its working budget.',
            false,
          ),
        )
      })
      owned.once('exit', () => {
        observed.removeEventListener('abort', cancelled)
        reject(
          new AgentExecutionError(
            'protocol_error',
            'Native parser ended before producing a frame.',
            false,
          ),
        )
      })
      if (observed.aborted) cancelled()
    })
  } finally {
    if (worker) await worker.terminate()
    clearTimeout(timer)
    if (acquired) {
      activeWorkers -= 1
      for (const notify of waiting) {
        if (activeWorkers >= PARSER_WORKER_LIMIT) break
        notify()
      }
    }
  }
}
