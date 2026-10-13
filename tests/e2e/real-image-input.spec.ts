import { expect } from '@playwright/test'
import { randomInt } from 'node:crypto'

import {
  closeRealWorkspace,
  launchRealWorkspace,
  sendRealMessage,
  waitForRealCompletion,
} from './real-harness.js'
import { test } from './runtime-fixture.js'

test(
  'real @all Agents read the same code that exists only in attached image pixels',
  { tag: '@real' },
  async () => {
    test.setTimeout(240_000)
    const ctx = await launchRealWorkspace('real-image-input')
    try {
      const code = String(randomInt(100_000, 1_000_000))
      const png = await ctx.page.evaluate((digits) => {
        const canvas = document.createElement('canvas')
        canvas.width = 640
        canvas.height = 240
        const paint = canvas.getContext('2d')!
        paint.fillStyle = '#ffffff'
        paint.fillRect(0, 0, 640, 240)
        paint.fillStyle = '#101820'
        paint.font = 'bold 100px sans-serif'
        paint.textAlign = 'center'
        paint.fillText(digits, 320, 158)
        return canvas.toDataURL('image/png').split(',')[1]!
      }, code)
      await ctx.page.getByRole('combobox', { name: 'Message' }).evaluate((editor, encoded) => {
        const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
        const clipboard = new DataTransfer()
        clipboard.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }))
        editor.dispatchEvent(
          new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard,
          }),
        )
      }, png)
      await expect(
        ctx.page
          .getByLabel('Attached images')
          .getByRole('button', { name: 'Preview screenshot.png' }),
      ).toBeEnabled()
      await sendRealMessage(
        ctx,
        'Read the attached image and reply with only its six-digit number. Do not use tools, read files or write files.',
        'all',
      )
      const saved = await waitForRealCompletion(ctx, 2)
      const answers = saved.messages.filter((message) => message.role === 'assistant')
      expect(answers).toHaveLength(2)
      expect(new Set(answers.map((answer) => answer.agentId))).toEqual(new Set(['codex', 'claude']))
      for (const answer of answers) expect(answer.content.trim()).toContain(code)
      expect(saved.messages.find((message) => message.role === 'user')?.images).toHaveLength(1)
      expect(saved.runs.every((run) => run.status === 'completed')).toBe(true)
      expect(saved.activities.some((activity) => activity.kind === 'tool')).toBe(false)
    } finally {
      await closeRealWorkspace(ctx)
    }
  },
)
