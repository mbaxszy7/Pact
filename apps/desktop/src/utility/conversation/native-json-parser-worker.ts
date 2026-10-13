import { parentPort, workerData } from 'node:worker_threads'

import { freezeNativeJsonFrame } from './native-json-encoder'

if (!parentPort) throw new Error('Native JSON parser has no owner.')
try {
  if (!(workerData instanceof Uint8Array)) throw new Error('Invalid Native parser bytes.')
  const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(workerData))
  const heldBytes = freezeNativeJsonFrame(message)
  parentPort.postMessage({ message, heldBytes })
} catch {
  parentPort.postMessage({ error: 'Native returned invalid JSON, UTF-8 or an unsupported DTO.' })
}
