import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, mkdir, lstat, realpath, rename, rm, opendir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { Worker } from 'node:worker_threads'

import type {
  ConversationImage,
  ImageWriteInput,
  ImageWriteState,
  ImageReadInput,
  ImageReadPart,
} from '@pact/contracts/images'

import { imageCodecResultSchema } from '@pact/contracts/images'
import { ConversationRepository } from '@pact/persistence'

/* oxlint-disable no-await-in-loop -- Ordered byte writes, bounded cleanup pages and physical codec settlement belong to one finite image I/O owner. */
import { LogicalIpcWorkerTraffic, observeWorkerTraffic } from '../../shared/logical-ipc-traffic'

const PART = 32 * 1024,
  FILE = 64 * 1024 * 1024,
  DEADLINE = 10_000
const uuid = /^[a-f0-9-]{36}$/iu
const suffix = (mime: string): string =>
  mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp'
/** Owns only Pact image files and finite I/O/codec operations. SQLite owns immutable refs. */
export class ConversationImages {
  private active = 0
  private codecs = 0
  private disposed = false
  private readonly controllers = new Set<AbortController>()
  private readonly busy = new Set<string>()
  private readonly held = new Map<string, number>()
  private readonly releasedOwners = new Set<string>()
  private folder: string
  constructor(
    private readonly repository: ConversationRepository,
    root: string,
    private readonly ipcTraffic?: LogicalIpcWorkerTraffic,
  ) {
    this.folder = join(root, 'images')
  }
  async initialize(): Promise<void> {
    await mkdir(this.folder, { recursive: true, mode: 0o700 })
    if ((await lstat(this.folder)).isSymbolicLink())
      throw new Error('Image storage is unavailable.')
    this.folder = await realpath(this.folder)
    // Recover only our UUID-named orphan files, never persistent records or unrelated paths.
    const entries = await opendir(this.folder)
    for await (const entry of entries) {
      const match = /^([a-f0-9-]{36})\.(part|png|jpg|webp|thumb\.webp)$/iu.exec(entry.name)
      if (match && entry.isFile() && !this.repository.imageRecord(match[1]!))
        await rm(join(this.folder, entry.name), { force: true })
    }
    for (;;) {
      const rows = this.repository.temporaryImages(undefined, true)
      if (!rows.length) break
      for (const row of rows) await this.release(row.ownerSessionId, row.id, row.ownerKey)
    }
  }
  private path(id: string, ext: string): string {
    if (!uuid.test(id)) throw new Error('Invalid image identity.')
    return join(this.folder, `${id}.${ext}`)
  }
  private async operation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed || this.active >= 4)
      throw new Error('Image preparation is busy. Try again shortly.')
    this.active += 1
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), DEADLINE)
    try {
      return await work(controller.signal)
    } finally {
      clearTimeout(timer)
      this.controllers.delete(controller)
      this.active -= 1
    }
  }
  async write(input: ImageWriteInput, owner: string): Promise<ImageWriteState> {
    if (input.type === 'release') {
      await this.release(input.sessionId, input.imageId, owner)
      return { imageId: input.imageId, offset: 0, ready: false }
    }
    const id = input.type === 'begin' ? input.clientImageId : input.imageId
    if (this.busy.has(id)) throw new Error('Wait for the current image segment.')
    this.busy.add(id)
    try {
      return await this.operation(async (signal) => {
        signal.throwIfAborted()
        if (input.type === 'begin') {
          const row = this.repository.beginImage(input.sessionId, id, input.name, owner)
          if (row.ready)
            return { imageId: id, offset: row.bytes, ready: true, image: this.meta(row) }
          const path = this.path(id, 'part')
          let fd
          try {
            fd = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
          }
          await fd?.close()
          return { imageId: id, offset: row.bytes, ready: false }
        }
        const row = this.repository.imageRecord(id)
        if (!row || row.ownerSessionId !== input.sessionId || row.ownerKey !== owner)
          throw new Error('This image belongs to another input.')
        if (row.ready) return { imageId: id, offset: row.bytes, ready: true, image: this.meta(row) }
        if (input.type === 'append') {
          if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(input.data)) throw new Error('Invalid image segment.')
          const data = Buffer.from(input.data, 'base64')
          if (
            !data.length ||
            data.length > PART ||
            data.toString('base64') !== input.data ||
            input.offset !== row.bytes ||
            row.bytes + data.length > FILE
          )
            throw new Error('Invalid image offset or preparation capacity.')
          this.repository.assertImageCapacity(owner, data.length)
          const fd = await open(this.path(id, 'part'), constants.O_WRONLY | constants.O_NOFOLLOW)
          try {
            let written = 0
            while (written < data.length) {
              signal.throwIfAborted()
              const result = await fd.write(
                data,
                written,
                data.length - written,
                input.offset + written,
              )
              if (!result.bytesWritten) throw new Error('Image write stopped.')
              written += result.bytesWritten
            }
          } finally {
            await fd.close()
          }
          signal.throwIfAborted()
          const next = this.repository.advanceImage(
            id,
            input.sessionId,
            owner,
            row.bytes,
            row.bytes + data.length,
          )
          return { imageId: id, offset: next.bytes, ready: false }
        }
        const source = this.path(id, 'part'),
          thumbnail = this.path(id, 'thumb.webp')
        const named =
          process.platform === 'win32' ? await lstat(source, { bigint: true }) : undefined
        if (named && (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n))
          throw new Error('The complete image changed.')
        const fd = await open(
          source,
          (process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) |
            (constants.O_NOFOLLOW ?? 0),
        )
        let bytes = 0
        const hash = createHash('sha256')
        try {
          const stat = await fd.stat()
          if (!stat.isFile() || stat.size !== row.bytes || !stat.size)
            throw new Error('The complete image changed.')
          const opened = named ? await fd.stat({ bigint: true }) : undefined
          if (
            named &&
            opened &&
            (named.dev !== opened.dev ||
              named.ino !== opened.ino ||
              named.size !== opened.size ||
              named.mtimeNs !== opened.mtimeNs ||
              named.ctimeNs !== opened.ctimeNs)
          )
            throw new Error('The complete image changed.')
          const buffer = Buffer.allocUnsafe(PART)
          for (;;) {
            signal.throwIfAborted()
            const part = await fd.read(buffer, 0, PART, bytes)
            if (!part.bytesRead) break
            hash.update(buffer.subarray(0, part.bytesRead))
            bytes += part.bytesRead
          }
          if (opened) {
            const after = await fd.stat({ bigint: true })
            const current = await lstat(source, { bigint: true })
            if (
              !current.isFile() ||
              current.isSymbolicLink() ||
              current.nlink !== 1n ||
              after.nlink !== 1n ||
              current.dev !== after.dev ||
              current.ino !== after.ino ||
              current.size !== after.size ||
              current.mtimeNs !== after.mtimeNs ||
              current.ctimeNs !== after.ctimeNs ||
              opened.size !== after.size ||
              opened.mtimeNs !== after.mtimeNs ||
              opened.ctimeNs !== after.ctimeNs ||
              bytes !== row.bytes
            )
              throw new Error('The complete image changed.')
          }
          await fd.sync()
        } finally {
          await fd.close()
        }
        const decoded = await this.decode(source, thumbnail, signal)
        signal.throwIfAborted()
        if (!this.repository.imageRecord(id)) throw new Error('Image preparation was cancelled.')
        await rename(source, this.path(id, suffix(decoded.mediaType)))
        const image: ConversationImage = {
          id,
          name: row.name,
          bytes,
          sha256: hash.digest('hex'),
          mediaType: decoded.mediaType,
          width: decoded.width,
          height: decoded.height,
        }
        this.repository.sealImage(id, input.sessionId, owner, image, decoded.thumbnailBytes)
        return { imageId: id, offset: bytes, ready: true, image }
      })
    } catch (error) {
      if (input.type === 'seal') await this.release(input.sessionId, id, owner)
      throw error
    } finally {
      this.busy.delete(id)
    }
  }
  private meta(
    row: NonNullable<ReturnType<ConversationRepository['imageRecord']>>,
  ): ConversationImage {
    if (!row.ready || !row.mediaType || !row.width || !row.height || !row.sha256)
      throw new Error('This image is not ready.')
    return {
      id: row.id,
      name: row.name,
      mediaType: row.mediaType,
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      sha256: row.sha256,
    }
  }
  private async decode(
    source: string,
    thumbnail: string,
    signal: AbortSignal,
  ): Promise<{
    mediaType: ConversationImage['mediaType']
    width: number
    height: number
    thumbnailBytes: number
  }> {
    if (this.codecs >= 2) throw new Error('Image decoding is busy. Try again shortly.')
    this.codecs += 1
    let worker: Worker | undefined
    try {
      worker = new Worker(join(__dirname, 'image-codec-worker.js'), {
        workerData: { source, thumbnail },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      })
      const traffic = this.ipcTraffic?.collector('utility-image')
      traffic?.record('utility-image.init', 'business', { source, thumbnail })
      observeWorkerTraffic(worker, traffic, 'utility-image.init', 'image-utility.reply')
      const owned = worker
      return await new Promise((accept, reject) => {
        const cancel = () => reject(new Error('Image preparation was cancelled or timed out.'))
        signal.addEventListener('abort', cancel, { once: true })
        const finish = (error: unknown, value?: unknown): void => {
          signal.removeEventListener('abort', cancel)
          if (error) {
            reject(error)
            return
          }
          const parsed = imageCodecResultSchema.safeParse(value)
          if (!parsed.success) reject(new Error('The image codec returned invalid metadata.'))
          else accept(parsed.data)
        }
        owned.once('message', (value: unknown) => {
          if (value && typeof value === 'object' && 'error' in value)
            finish(new Error(String(value.error)))
          else finish(undefined, value)
        })
        owned.once('error', (error) => finish(error))
        owned.once('exit', () => finish(new Error('Image codec closed before completing.')))
        if (signal.aborted) cancel()
      })
    } finally {
      if (worker) await worker.terminate()
      this.codecs -= 1
    }
  }
  async choose(session: string, paths: string[], owner: string): Promise<ConversationImage[]> {
    return this.operation(async (signal) => {
      const images: ConversationImage[] = []
      const created: string[] = []
      try {
        for (const source of paths) {
          signal.throwIfAborted()
          const id = randomUUID()
          created.push(id)
          await this.write(
            {
              type: 'begin',
              sessionId: session,
              clientImageId: id,
              name: basename(source).slice(0, 255),
            },
            owner,
          )
          const fd = await open(await realpath(source), constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const stat = await fd.stat()
            if (!stat.isFile() || stat.size > FILE)
              throw new Error('Choose an image within available preparation capacity.')
            const buffer = Buffer.allocUnsafe(PART)
            let offset = 0
            for (;;) {
              signal.throwIfAborted()
              const part = await fd.read(buffer, 0, PART, offset)
              if (!part.bytesRead) break
              await this.write(
                {
                  type: 'append',
                  sessionId: session,
                  imageId: id,
                  offset,
                  data: buffer.subarray(0, part.bytesRead).toString('base64'),
                },
                owner,
              )
              offset += part.bytesRead
            }
          } finally {
            await fd.close()
          }
          const ready = await this.write({ type: 'seal', sessionId: session, imageId: id }, owner)
          signal.throwIfAborted()
          images.push(ready.image!)
        }
        return images
      } catch (error) {
        for (const id of created) await this.release(session, id, owner)
        throw error
      }
    })
  }
  async read(input: ImageReadInput, owner: string): Promise<ImageReadPart> {
    return this.operation(async (signal) => {
      if (!this.repository.imageAccessible(input.sessionId, input.imageId, owner))
        throw new Error('This image is unavailable in this Session.')
      const row = this.repository.imageRecord(input.imageId)!
      const image = this.meta(row)
      const thumbnail = input.variant === 'thumbnail'
      const total = thumbnail ? row.thumbnailBytes : image.bytes
      if (input.offset > total) throw new Error('Invalid image read offset.')
      const fd = await open(
        this.path(image.id, thumbnail ? 'thumb.webp' : suffix(image.mediaType)),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      try {
        signal.throwIfAborted()
        const data = Buffer.allocUnsafe(Math.min(PART, total - input.offset))
        const result = await fd.read(data, 0, data.length, input.offset)
        const next = input.offset + result.bytesRead
        if (next < total && !result.bytesRead) throw new Error('The saved image is incomplete.')
        return {
          imageId: image.id,
          offset: input.offset,
          nextOffset: next,
          totalBytes: total,
          mediaType: thumbnail ? 'image/webp' : image.mediaType,
          data: data.subarray(0, result.bytesRead).toString('base64'),
          hasMore: next < total,
        }
      } finally {
        await fd.close()
      }
    })
  }
  resolve(
    session: string,
    image: ConversationImage,
    owner?: string,
  ): ConversationImage & { path: string } {
    if (!this.repository.imageAccessible(session, image.id, owner))
      throw new Error('This image source is unavailable.')
    return { ...image, path: this.path(image.id, suffix(image.mediaType)) }
  }
  hold(ids: string[]): () => void {
    if (this.held.size + new Set(ids.filter((id) => !this.held.has(id))).size > 512)
      throw new Error('Image preparation references are full.')
    for (const id of ids) this.held.set(id, (this.held.get(id) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      for (const id of ids) {
        const count = (this.held.get(id) ?? 1) - 1
        if (count) this.held.set(id, count)
        else this.held.delete(id)
      }
      void this.cleanReleasedOwners().catch(() => undefined)
    }
  }
  async release(session: string, id: string, owner: string): Promise<void> {
    if (this.held.has(id)) return
    if (this.repository.releaseImage(id, session, owner)) {
      await Promise.all(
        ['part', 'png', 'jpg', 'webp', 'thumb.webp'].map((ext) =>
          rm(this.path(id, ext), { force: true }),
        ),
      )
    }
  }
  async releaseOwner(owner: string): Promise<void> {
    if (!this.releasedOwners.has(owner) && this.releasedOwners.size >= 512)
      throw new Error('Image cleanup owner capacity is full.')
    this.releasedOwners.add(owner)
    await this.cleanReleasedOwners()
  }
  private async cleanReleasedOwners(): Promise<void> {
    for (const owner of this.releasedOwners) {
      for (;;) {
        const rows = this.repository.temporaryImages(owner)
        let released = 0
        for (const row of rows) {
          if (this.held.has(row.id)) continue
          await this.release(row.ownerSessionId, row.id, owner)
          released += 1
        }
        if (!rows.length || !released) break
      }
      if (!this.repository.temporaryImages(owner).length) this.releasedOwners.delete(owner)
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    for (const controller of this.controllers) controller.abort()
    while (this.active || this.codecs) await new Promise<void>((done) => setTimeout(done, 10))
    await this.cleanReleasedOwners()
  }
}
