import { parentPort } from 'node:worker_threads'

import { markdownProjectionPages } from '../../shared/message-anchor-text'

if (!parentPort) throw new Error('Markdown projection requires its document owner.')
const port = parentPort
const parts: string[] = []
let iterator: ReturnType<typeof markdownProjectionPages> | undefined
port.on('message', (input: { type: 'append' | 'compile' | 'next'; text?: string }) => {
  try {
    if (input.type === 'append') {
      if (typeof input.text !== 'string' || input.text.length > 8192 || iterator)
        throw new Error('Invalid projection input segment.')
      parts.push(input.text)
      port.postMessage({ type: 'appended' })
      return
    }
    if (input.type === 'compile') {
      const markdown = parts.join('')
      parts.length = 0
      iterator = markdownProjectionPages(markdown)
    }
    const item = iterator?.next()
    if (!item) throw new Error('Projection input is not sealed.')
    port.postMessage(item.done ? { type: 'complete' } : { type: 'page', page: item.value })
  } catch (error) {
    port.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Markdown projection failed.',
    })
  }
})
