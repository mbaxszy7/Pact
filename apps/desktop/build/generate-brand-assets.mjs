import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

const args = process.argv.slice(2)
if (args.length > 1 || args.some((argument) => argument !== '--installer-artwork'))
  throw new Error('Brand generation accepts only --installer-artwork.')
const installerArtwork = args[0] === '--installer-artwork'
if (installerArtwork && process.platform !== 'win32')
  throw new Error('Generate and review installer artwork on Windows before committing it.')

const buildDirectory = import.meta.dirname
const resourcesDirectory = join(buildDirectory, '../resources')
const icon = await readFile(join(resourcesDirectory, 'icon.svg'))
const iconDataUri = `data:image/svg+xml;base64,${icon.toString('base64')}`
const renderedSizes = new Map()
const renderIcon = (size) => {
  if (!renderedSizes.has(size)) {
    renderedSizes.set(
      size,
      sharp(icon, { density: Math.max(72, (size / 512) * 72) })
        .resize(size, size)
        .png()
        .toBuffer(),
    )
  }
  return renderedSizes.get(size)
}

// macOS displays app artwork inside the icon canvas. Keep the shared mark intact
// and give Dock PNG and ICNS frames the same transparent optical margin.
const renderMacIcon = async (size) => {
  const inset = Math.round(size * 0.08)
  return sharp(await renderIcon(size - inset * 2))
    .extend({
      top: inset,
      bottom: inset,
      left: inset,
      right: inset,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()
}

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const images = await Promise.all(sizes.map(renderIcon))

// ICO directory entries point to PNG frames, retaining alpha at every Windows scale.
function createIco(frameSizes, frames) {
  const header = Buffer.alloc(6 + frames.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  let offset = header.length
  for (let index = 0; index < frames.length; index += 1) {
    const entry = 6 + index * 16
    header[entry] = frameSizes[index] === 256 ? 0 : frameSizes[index]
    header[entry + 1] = header[entry]
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(frames[index].length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += frames[index].length
  }
  return Buffer.concat([header, ...frames])
}
await writeFile(join(buildDirectory, 'icon.ico'), createIco(sizes, images))
const png = await renderIcon(512)
await writeFile(join(resourcesDirectory, 'icon.png'), png)
await writeFile(join(buildDirectory, 'icon.png'), png)
await writeFile(join(buildDirectory, 'icon-mac.png'), await renderMacIcon(512))

// Modern ICNS frames store PNG data; include normal and Retina sizes through 1024px.
const macFrames = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
]
const macChunks = (
  await Promise.all(
    macFrames.map(async ([type, size]) => {
      const frame = await renderMacIcon(size)
      const chunkHeader = Buffer.alloc(8)
      chunkHeader.write(type, 0, 'ascii')
      chunkHeader.writeUInt32BE(frame.length + 8, 4)
      return [chunkHeader, frame]
    }),
  )
).flat()
const macHeader = Buffer.alloc(8)
macHeader.write('icns', 0, 'ascii')
macHeader.writeUInt32BE(8 + macChunks.reduce((bytes, chunk) => bytes + chunk.length, 0), 4)
await writeFile(join(buildDirectory, 'icon.icns'), Buffer.concat([macHeader, ...macChunks]))

const tray = await readFile(join(resourcesDirectory, 'tray.svg'))
const trayFrames = await Promise.all(
  sizes.map((size) => sharp(tray).resize(size, size).png().toBuffer()),
)
await writeFile(join(buildDirectory, 'tray.ico'), createIco(sizes, trayFrames))
const trayTemplate = await readFile(join(resourcesDirectory, 'trayTemplate.svg'))
await Promise.all(
  [1, 2].map(async (scale) => {
    const frame = await sharp(trayTemplate, { density: 72 * scale })
      .resize(16 * scale, 16 * scale)
      .withMetadata({ density: 72 * scale })
      .png()
      .toBuffer()
    await writeFile(
      join(buildDirectory, scale === 1 ? 'trayTemplate.png' : 'trayTemplate@2x.png'),
      frame,
    )
  }),
)

// NSIS bitmaps depend on installed Windows fonts. Ordinary builds consume the
// reviewed committed artwork instead of rewriting it with another host's fonts.
if (installerArtwork)
  await Promise.all(
    ['installer-sidebar', 'installer-header'].map(async (name) => {
      const template = await readFile(join(buildDirectory, `${name}.svg`), 'utf8')
      const { data, info } = await sharp(
        Buffer.from(template.replaceAll('__PACT_ICON__', iconDataUri)),
      )
        .flatten({ background: '#ffffff' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const stride = Math.ceil((info.width * 3) / 4) * 4
      const bitmap = Buffer.alloc(54 + stride * info.height)
      bitmap.write('BM')
      bitmap.writeUInt32LE(bitmap.length, 2)
      bitmap.writeUInt32LE(54, 10)
      bitmap.writeUInt32LE(40, 14)
      bitmap.writeInt32LE(info.width, 18)
      bitmap.writeInt32LE(info.height, 22)
      bitmap.writeUInt16LE(1, 26)
      bitmap.writeUInt16LE(24, 28)
      bitmap.writeUInt32LE(stride * info.height, 34)
      for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          const source = (y * info.width + x) * 3
          const target = 54 + (info.height - y - 1) * stride + x * 3
          bitmap[target] = data[source + 2]
          bitmap[target + 1] = data[source + 1]
          bitmap[target + 2] = data[source]
        }
      }
      await writeFile(join(buildDirectory, `${name}.bmp`), bitmap)
    }),
  )
