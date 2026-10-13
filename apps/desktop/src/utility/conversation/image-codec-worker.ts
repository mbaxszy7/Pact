import { stat } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import sharp from 'sharp'

import { imageCodecInputSchema } from '@pact/contracts/images'

async function run(): Promise<void> {
  const { source, thumbnail } = imageCodecInputSchema.parse(workerData)
  sharp.cache(false)
  sharp.concurrency(1)
  const info = await stat(source)
  if (!info.isFile() || info.size > 64 * 1024 * 1024)
    throw new Error('This image exceeds the available image preparation capacity.')
  const image = sharp(source, { limitInputPixels: 48 * 1024 * 1024, failOn: 'warning', pages: 1 })
  const metadata = await image.metadata()
  const mediaType =
    metadata.format === 'png'
      ? 'image/png'
      : metadata.format === 'jpeg'
        ? 'image/jpeg'
        : metadata.format === 'webp'
          ? 'image/webp'
          : undefined
  if (!mediaType || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1)
    throw new Error('Choose a static PNG, JPEG or WebP image.')
  if (
    metadata.width * metadata.height * (metadata.depth === 'ushort' ? 8 : 4) + info.size >
    256 * 1024 * 1024
  )
    throw new Error('This image needs too much decoding memory.')
  const output = await image
    .autoOrient()
    .resize(384, 384, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .timeout({ seconds: 8 })
    .toFile(thumbnail)
  const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1)
  parentPort?.postMessage({
    mediaType,
    width: rotated ? metadata.height : metadata.width,
    height: rotated ? metadata.width : metadata.height,
    thumbnailBytes: output.size,
  })
}
void run().catch((error: unknown) =>
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : 'This image could not be prepared.',
  }),
)
