import { parentPort, workerData } from 'node:worker_threads'

import { freezeNativeJsonFrame, measureNativeWorkerReply } from './native-json-encoder'

if (!parentPort) throw new Error('Native JSON parser has no owner.')
const measured =
  workerData !== null && typeof workerData === 'object' && workerData.measure === true
async function parse(): Promise<void> {
  let result: Record<string, unknown>
  try {
    const bytes: unknown = measured ? workerData.bytes : workerData
    if (!(bytes instanceof Uint8Array)) throw new Error('Invalid Native parser bytes.')
    const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    const heldBytes = freezeNativeJsonFrame(message)
    result = { message, heldBytes }
  } catch {
    result = { error: 'Native returned invalid JSON, UTF-8 or an unsupported DTO.' }
  }
  if (measured) {
    const ipcMeasurement = await measureNativeWorkerReply(result)
    parentPort!.postMessage({ ...result, ipcMeasurement })
  } else parentPort!.postMessage(result)
}
void parse()
