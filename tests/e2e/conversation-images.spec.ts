import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { ConversationImage } from '../../packages/contracts/src/images.js'
import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { PactDatabase } from '../../packages/persistence/src/index.js'
import { createRuntimeFixture, test, type RuntimeFixture } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')

interface ImageFile {
  name: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  data: string
  path: string
  sha256: string
}

async function createImageSession(
  fixture: RuntimeFixture,
): Promise<{ sessionId: string; otherId: string }> {
  const directoryPath = await fixture.createProjectDirectory('conversation-images')
  const db = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    otherId = randomUUID(),
    createdAt = new Date().toISOString()
  try {
    db.projectCatalogRepository.add({
      id: projectId,
      name: 'Image workspace',
      directoryPath,
      kind: 'directory',
      createdAt,
    })
    for (const [id, title] of [
      [sessionId, 'Image inputs'],
      [otherId, 'Other draft'],
    ] as const)
      db.sessionRepository.create(
        { id, projectId, title, createdAt },
        {
          primaryAgentId: 'claude',
          agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
          maxDiscussionRounds: 3,
          runningMessagePolicy: 'next_round',
          maxReviewCycles: 3,
          maxRepairAttempts: 3,
        },
      )
  } finally {
    db.close()
  }
  return { sessionId, otherId }
}

async function selectSession(page: Page, sessionId: string): Promise<void> {
  // Native auto-title may change image-only titles. The persisted identity remains stable.
  await page.locator(`[data-session-menu="${sessionId}"] > button`).first().click()
  await expect(page.getByRole('combobox', { name: 'Message', exact: true })).toBeEnabled()
}

async function imageFiles(page: Page, directory: string, count = 3): Promise<ImageFile[]> {
  const encoded = await page.evaluate((items) => {
    return Array.from({ length: items }, (_, index) => {
      const mediaType = (['image/png', 'image/jpeg', 'image/webp'] as const)[index % 3]!
      const canvas = document.createElement('canvas')
      canvas.width = 720
      canvas.height = 480
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Image fixture canvas is unavailable.')
      context.fillStyle = ['#d3f6e3', '#f1e6ff', '#fff2eb'][index % 3]!
      context.fillRect(0, 0, 720, 480)
      context.fillStyle = '#0a0d12'
      context.font = '24px sans-serif'
      context.fillText(`Design ${index + 1}`, 24, 48)
      context.font = '13px sans-serif'
      context.fillText('Layout detail 3179 · original pixels', 24, 96)
      const extension = mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice(6)
      return {
        name: `design-${index + 1}.${extension}`,
        mediaType,
        data: canvas.toDataURL(mediaType).split(',')[1]!,
      }
    })
  }, count)
  await mkdir(directory)
  return Promise.all(
    encoded.map(async (image) => {
      const bytes = Buffer.from(image.data, 'base64'),
        path = join(directory, image.name)
      await writeFile(path, bytes)
      return Object.assign({}, image, {
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }),
  )
}

async function recordClaudeImageInputs(fixture: RuntimeFixture): Promise<void> {
  const path = join(fixture.directory, 'claude-sdk-fixture.mjs')
  const source = await readFile(path, 'utf8')
  if (!source.includes('const count = facts.count + 1'))
    throw new Error('Owned Claude fixture marker is unavailable.')
  await writeFile(
    path,
    source
      .replace('import { randomUUID }', 'import { randomUUID, createHash }')
      .replace(
        'const count = facts.count + 1',
        `const content = message.message?.content; (facts.imageInputs ??= []).push(Array.isArray(content) ? content.filter(block => block.type === 'image').map(block => ({ mediaType: block.source.media_type, sha256: createHash('sha256').update(Buffer.from(block.source.data, 'base64')).digest('hex') })) : []); const count = facts.count + 1`,
      ),
  )
}

async function pickImages(
  app: ElectronApplication,
  page: Page,
  files: readonly ImageFile[],
): Promise<void> {
  // Only the owned App's native dialog result is controlled. Main/Utility file reading,
  // codec validation, persistence and Renderer thumbnails use the real product paths.
  await app.evaluate(
    ({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
    },
    files.map((file) => file.path),
  )
  await page.getByRole('button', { name: 'Add images', exact: true }).click()
}

async function addFile(target: Locator, file: ImageFile, kind: 'paste' | 'drop'): Promise<void> {
  await target.evaluate(
    (element, input) => {
      const bytes = Uint8Array.from(atob(input.data), (character) => character.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], input.name, { type: input.mediaType }))
      const event =
        input.kind === 'paste'
          ? new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              clipboardData: transfer,
            })
          : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
      element.dispatchEvent(event)
    },
    { name: file.name, mediaType: file.mediaType, data: file.data, kind },
  )
}

async function loadedThumbnails(strip: Locator, count: number): Promise<void> {
  await expect(strip.locator('img')).toHaveCount(count)
  await expect
    .poll(() =>
      strip
        .locator('img')
        .evaluateAll((images) =>
          images.every(
            (image) =>
              image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
          ),
        ),
    )
    .toBe(true)
}

async function readSavedImage(
  page: Page,
  sessionId: string,
  image: ConversationImage,
): Promise<Buffer> {
  const parts = await page.evaluate(
    async (input) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const chunks: string[] = []
      let offset = 0
      while (offset < input.image.bytes) {
        // oxlint-disable-next-line no-await-in-loop -- The saved binary source supplies each next offset.
        const result = await bridge.readConversationImage({
          sessionId: input.sessionId,
          imageId: input.image.id,
          offset,
          variant: 'original',
        })
        if (!result.ok) throw new Error(result.error.message)
        if (result.value.offset !== offset || result.value.nextOffset <= offset)
          throw new Error('Image read did not advance.')
        chunks.push(result.value.data)
        offset = result.value.nextOffset
      }
      return chunks
    },
    { sessionId, image },
  )
  return Buffer.concat(parts.map((part) => Buffer.from(part, 'base64')))
}

test(
  'keeps image-only inputs durable and a later draft intact across ACK and restart',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({
      claudeConversation: 'complete',
      codexAppServer: 'complete',
    })
    let app: ElectronApplication | undefined
    try {
      const { sessionId, otherId } = await createImageSession(fixture)
      await recordClaudeImageInputs(fixture)
      app = await fixture.launch()
      let page = await app.firstWindow()
      await selectSession(page, sessionId)
      const source = join(fixture.directory, 'image-originals')
      const files = await imageFiles(page, source)
      const editor = () => page.getByRole('combobox', { name: 'Message', exact: true })
      const draft = () => page.getByLabel('Attached images')
      await pickImages(app, page, [files[0]!])
      await loadedThumbnails(draft(), 1)
      await editor().focus()
      await addFile(editor(), files[1]!, 'paste')
      await loadedThumbnails(draft(), 2)
      await addFile(draft(), files[2]!, 'drop')
      await loadedThumbnails(draft(), 3)
      await draft()
        .getByRole('button', { name: `Remove ${files[2]!.name}`, exact: true })
        .click()
      await loadedThumbnails(draft(), 2)
      await addFile(editor(), files[2]!, 'drop')
      await loadedThumbnails(draft(), 3)
      await selectSession(page, otherId)
      await expect(draft()).toHaveCount(0)
      await selectSession(page, sessionId)
      await loadedThumbnails(draft(), 3)

      const send = page.getByRole('button', { name: 'Send message', exact: true })
      await expect(editor()).toHaveText('')
      await expect(send).toBeEnabled()
      await send.click()
      await expect(page.getByText('Claude fixture response.', { exact: true })).toBeVisible()
      await expect(draft()).toHaveCount(0)
      const saved = await page.evaluate(async (id) => {
        const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
        const result = await bridge.getConversation({ scope: 'messages', sessionId: id })
        if (!result.ok || result.value.scope !== 'messages')
          throw new Error('Image history is unavailable.')
        const entry = result.value.messages.find((value) => value.message.role === 'user')
        if (entry?.kind !== 'complete') throw new Error('Expected a complete image-only Message.')
        return entry.message
      }, sessionId)
      expect(saved?.content).toBe('')
      expect(saved?.images?.map((image) => image.name)).toEqual(files.map((file) => file.name))
      await rm(source, { recursive: true })
      for (const [index, image] of saved.images!.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- Each immutable image is verified separately after original source deletion.
        const bytes = await readSavedImage(page, sessionId, image)
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(files[index]!.sha256)
      }
      expect((await fixture.readClaudeFacts()).count).toBe(1)
      const receipts: { imageInputs: Array<Array<{ mediaType: string; sha256: string }>> } =
        JSON.parse(await readFile(join(fixture.directory, 'claude-sdk-state.json'), 'utf8'))
      expect(receipts.imageInputs).toEqual([
        files.map(({ mediaType, sha256 }) => ({ mediaType, sha256 })),
      ])

      // Delay only this isolated App's typed Send handler before real processing. This leaves
      // one frozen input pending while the user continues editing through the actual Hook.
      await app.evaluate(({ ipcMain }) => {
        const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers')
        if (!(handlers instanceof Map)) throw new Error('Owned IPC handlers are unavailable.')
        const original: unknown = handlers.get('pact:conversation:send')
        if (typeof original !== 'function') throw new Error('Owned Send handler is unavailable.')
        ipcMain.removeHandler('pact:conversation:send')
        ipcMain.handle('pact:conversation:send', async (event, input: unknown) => {
          await new Promise<void>((done) => setTimeout(done, 1500))
          return Reflect.apply(original, ipcMain, [event, input])
        })
      })
      await addFile(editor(), files[0]!, 'paste')
      await loadedThumbnails(draft(), 1)
      await send.click()
      await addFile(editor(), files[1]!, 'paste')
      await editor().press('ControlOrMeta+ArrowRight')
      await page.keyboard.insertText('Keep this next question.')
      await expect(page.getByText('Claude fixture response.', { exact: true })).toHaveCount(2)
      await loadedThumbnails(draft(), 1)
      await expect(
        draft().getByRole('button', { name: `Preview ${files[1]!.name}`, exact: true }),
      ).toBeVisible()
      await expect(editor()).toHaveText('Keep this next question.')
      expect((await fixture.readClaudeFacts()).count).toBe(2)

      await app.close()
      app = await fixture.launch()
      page = await app.firstWindow()
      await selectSession(page, sessionId)
      await loadedThumbnails(page.getByLabel('Message images'), 4)
      await expect(draft()).toHaveCount(0)
      await expect(editor()).toHaveText('')
      const preview = page
        .getByLabel('Message images')
        .getByRole('button', { name: `Preview ${files[1]!.name}`, exact: true })
      await preview.click()
      const gallery = page.getByRole('dialog', { name: 'Image preview', exact: true })
      await expect(gallery.getByRole('img', { name: files[1]!.name, exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(gallery).toHaveCount(0)
      await expect(preview).toBeFocused()
      expect((await fixture.readClaudeFacts()).count).toBe(2)
    } finally {
      await app?.close()
      await fixture.dispose()
    }
  },
)

test(
  'keeps ten-image gallery navigation bounded, focused and reversible without covering input',
  { tag: '@deterministic' },
  async () => {
    const fixture = await createRuntimeFixture({
      claudeConversation: 'complete',
      codexAppServer: 'complete',
    })
    let app: ElectronApplication | undefined
    try {
      const { sessionId } = await createImageSession(fixture)
      app = await fixture.launch()
      const page = await app.firstWindow()
      await selectSession(page, sessionId)
      const files = await imageFiles(page, join(fixture.directory, 'gallery-originals'), 10)
      await pickImages(app, page, files)
      const draft = page.getByLabel('Attached images')
      await loadedThumbnails(draft, 10)
      const editor = page.getByRole('combobox', { name: 'Message', exact: true })
      await editor.fill('Review these screenshots.\nKeep all of this text visible.')
      const input = await editor.boundingBox(),
        add = await page.getByRole('button', { name: 'Add images', exact: true }).boundingBox(),
        send = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox()
      if (!input || !add || !send) throw new Error('Composer geometry is unavailable.')
      expect(add.y).toBeGreaterThanOrEqual(input.y + input.height)
      expect(send.y).toBeGreaterThanOrEqual(input.y + input.height)
      expect(Math.abs(add.x - input.x)).toBeLessThan(1)
      expect(Math.abs(send.x + send.width - input.x - input.width)).toBeLessThan(1)
      await expect(editor).toHaveText('Review these screenshots.\nKeep all of this text visible.')

      const trigger = draft.getByRole('button', { name: `Preview ${files[0]!.name}`, exact: true })
      await trigger.click()
      const gallery = page.getByRole('dialog', { name: 'Image preview', exact: true }),
        close = gallery.getByRole('button', { name: 'Close image preview', exact: true })
      await expect(gallery.locator('header button')).toHaveCount(1)
      await expect(gallery.getByRole('button', { name: /fit|100%|zoom/iu })).toHaveCount(0)
      await expect(gallery.locator('.pact-image-slide[aria-hidden="false"]')).toHaveAttribute(
        'data-visible',
        'true',
      )
      const motion = await gallery
        .locator('.pact-image-slide')
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            durations: style.transitionDuration.split(',').map((value) => Number.parseFloat(value)),
            offset: style.getPropertyValue('--pact-slide-offset').trim(),
          }
        })
      expect(motion.durations).toEqual([0.18, 0.18])
      expect(motion.offset).toBe('12px')
      await gallery.getByLabel('Image filmstrip').getByRole('button').first().focus()
      for (let index = 1; index < 10; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- Each key advances one user-selected image and checks the persistent dialog's focus boundary.
        await page.keyboard.press('ArrowRight')
        // oxlint-disable-next-line no-await-in-loop -- Observe each committed navigation before issuing the next key.
        await expect(gallery.locator('header')).toContainText(`${index + 1} / 10`)
        // oxlint-disable-next-line no-await-in-loop -- A two-slide bound must hold even during rapid pending image reads.
        expect(await gallery.locator('.pact-image-slide').count()).toBeLessThanOrEqual(2)
        // oxlint-disable-next-line no-await-in-loop -- Focus remains inside the native dialog when filmstrip entries are windowed out.
        expect(await gallery.evaluate((element) => element.contains(document.activeElement))).toBe(
          true,
        )
      }
      await expect(close).toBeFocused()
      for (let index = 8; index >= 0; index -= 1) {
        // oxlint-disable-next-line no-await-in-loop -- Reverse navigation is a real ordered keyboard journey.
        await page.keyboard.press('ArrowLeft')
        // oxlint-disable-next-line no-await-in-loop -- Confirm the intended image and continue without a fixed animation sleep.
        await expect(gallery.locator('header')).toContainText(`${index + 1} / 10`)
      }
      await expect(gallery.locator('.pact-image-slide')).toHaveCount(1)
      await expect(gallery.locator('.pact-image-slide[aria-hidden="false"]')).toHaveAttribute(
        'data-visible',
        'true',
      )

      await close.click()
      await trigger.click()
      await expect(gallery.locator('.pact-image-slide[aria-hidden="false"]')).toHaveAttribute(
        'data-visible',
        'true',
      )

      // Keep the next image pending at the browser resource seam. Its ready thumbnail
      // and original are both held; a load-capture listener alone cannot fence React's
      // direct load listener. Product navigation/read/persistence remain unchanged.
      await page.evaluate((name) => {
        const imageButton = [
          ...document.querySelectorAll('[aria-label="Attached images"] button'),
        ].find((button) => button.getAttribute('aria-label') === `Preview ${name}`)
        const thumbnail = imageButton?.querySelector('img')?.src
        if (!thumbnail) throw new Error('Controlled image thumbnail is unavailable.')
        const set: typeof HTMLImageElement.prototype.setAttribute = Reflect.get(
          HTMLImageElement.prototype,
          'setAttribute',
        )
        const create: typeof URL.createObjectURL = Reflect.get(URL, 'createObjectURL')
        const pending = create.call(URL, new Blob([], { type: 'image/jpeg' }))
        HTMLImageElement.prototype.setAttribute = function (attribute, value) {
          set.call(this, attribute, attribute === 'src' && value === thumbnail ? pending : value)
        }
        URL.createObjectURL = function (blob) {
          return Reflect.get(blob, 'type') === 'image/jpeg' ? pending : create.call(URL, blob)
        }
        Reflect.set(globalThis, 'restoreGalleryImageLoad', () => {
          HTMLImageElement.prototype.setAttribute = set
          URL.createObjectURL = create
          URL.revokeObjectURL(pending)
        })
      }, files[1]!.name)
      try {
        await page.keyboard.press('ArrowRight')
        await expect(gallery.locator('.pact-image-slide[aria-hidden="false"]')).toHaveAttribute(
          'data-visible',
          'false',
        )
        await expect(gallery.locator('.pact-image-slide[aria-hidden="true"]')).toHaveAttribute(
          'data-visible',
          'true',
        )
        await page.keyboard.press('ArrowLeft')
        await expect(gallery.locator('.pact-image-slide')).toHaveCount(1)
        await expect(gallery.getByRole('img', { name: files[0]!.name, exact: true })).toBeVisible()
      } finally {
        await page.evaluate(() => {
          const restore: unknown = Reflect.get(globalThis, 'restoreGalleryImageLoad')
          if (typeof restore === 'function') Reflect.apply(restore, globalThis, [])
          Reflect.deleteProperty(globalThis, 'restoreGalleryImageLoad')
        })
      }
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await trigger.click()
      await expect(gallery.locator('.pact-image-slide').first()).toHaveCSS(
        'transition-property',
        'none',
      )
      await close.click()
      await expect(trigger).toBeFocused()
      // No Model request launches the synthetic Claude protocol child in this UI-only journey.
      await expect(fixture.readClaudeFacts()).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await app?.close()
      await fixture.dispose()
    }
  },
)
