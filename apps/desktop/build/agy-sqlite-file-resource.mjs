import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const desktop = resolve(import.meta.dirname, '..')
const root = resolve(desktop, '../..')
const MAX_BINARY_BYTES = 4 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/u
const LC_SEGMENT_64 = 0x19
const LC_CODE_SIGNATURE = 0x1d
const MAX_MACHO_LOAD_COMMANDS = 1024
const IMAGE_FILE_DLL = 0x2000
const IMAGE_NT_OPTIONAL_HDR64_MAGIC = 0x020b
const IMAGE_DLLCHARACTERISTICS_GUARD_CF = 0x4000
const IMAGE_GUARD_CF_INSTRUMENTED = 0x00000100
const MIN_PE_OPTIONAL_HEADER_BYTES = 200
const MIN_LOAD_CONFIG64_BYTES = 148
const LINKEDIT_SEGNAME = Buffer.from('__LINKEDIT\0\0\0\0\0\0', 'ascii')
const SUPPORTED_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64',
])
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function agySqliteFileFilename(platform, arch) {
  if (!SUPPORTED_TARGETS.has(`${platform}-${arch}`)) {
    throw new Error(`Unsupported agy-sqlite-file target: ${platform}-${arch}.`)
  }
  return `agy-sqlite-file-${platform}-${arch}.node`
}

export function agySqliteFileResourcePrefix(platform) {
  return platform === 'darwin' ? 'Contents/Resources/native' : 'resources/native'
}

async function boundedFile(
  path,
  maximum,
  { minimum = 1, label = 'agy-sqlite-file metadata' } = {},
) {
  const preStat = await lstat(path)
  if (!preStat.isFile() || preStat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`)
  }
  const openFlags =
    fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
  const file = await open(path, openFlags)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < minimum || info.size > maximum) {
      throw new Error(`${label} exceeds its byte bound.`)
    }
    const bytes = Buffer.allocUnsafe(info.size + 1)
    let size = 0
    while (size < bytes.length) {
      // oxlint-disable-next-line no-await-in-loop -- One bounded read from pinned FD, including overflow byte.
      const result = await file.read(bytes, size, bytes.length - size, size)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    if (size !== info.size || size > maximum) {
      throw new Error(`${label} changed during inspection.`)
    }
    return bytes.subarray(0, size)
  } finally {
    await file.close()
  }
}

export async function agySqliteFileSourceHash() {
  return hash(await boundedFile(join(desktop, 'native/agy-sqlite-file.c'), 1024 * 1024))
}

/**
 * Canonical pre-signature SHA-256 for 64-bit Mach-O bundles.
 * Hashes `[0 .. LC_CODE_SIGNATURE.dataoff)` with ONLY `__LINKEDIT.vmsize`, `__LINKEDIT.filesize`,
 * `LC_CODE_SIGNATURE.dataoff`, and `LC_CODE_SIGNATURE.datasize` zeroed, and verifies trailing
 * signature bounds. Returns `null` if the Mach-O header, `__LINKEDIT`, or `LC_CODE_SIGNATURE`
 * structure is missing or malformed.
 */
export function computeMachoPreSignatureSha256(bytes, arch) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 32) return null
  const expectedCpu = arch === 'arm64' ? 0x0100000c : arch === 'x64' ? 0x01000007 : 0
  if (expectedCpu === 0) return null
  if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== expectedCpu) {
    return null
  }
  const ncmds = bytes.readUInt32LE(16)
  const sizeofcmds = bytes.readUInt32LE(20)
  if (
    ncmds === 0 ||
    ncmds > MAX_MACHO_LOAD_COMMANDS ||
    sizeofcmds < 16 ||
    sizeofcmds > bytes.byteLength - 32
  ) {
    return null
  }
  const commandsEnd = 32 + sizeofcmds
  let offset = 32
  let linkeditOffset = -1
  let linkeditFileoff = 0n
  let linkeditFilesize = 0n
  let codeSigOffset = -1
  let dataoff = 0
  let datasize = 0

  for (let i = 0; i < ncmds; i += 1) {
    if (offset + 8 > commandsEnd) return null
    const cmd = bytes.readUInt32LE(offset)
    const cmdsize = bytes.readUInt32LE(offset + 4)
    if (cmdsize < 8 || cmdsize % 8 !== 0 || cmdsize > commandsEnd - offset) return null
    if (cmd === LC_SEGMENT_64) {
      if (cmdsize < 72) return null
      if (bytes.subarray(offset + 8, offset + 24).equals(LINKEDIT_SEGNAME)) {
        if (linkeditOffset !== -1) return null
        linkeditOffset = offset
        linkeditFileoff = bytes.readBigUInt64LE(offset + 40)
        linkeditFilesize = bytes.readBigUInt64LE(offset + 48)
      }
    } else if (cmd === LC_CODE_SIGNATURE) {
      if (cmdsize !== 16 || codeSigOffset !== -1) return null
      codeSigOffset = offset
      dataoff = bytes.readUInt32LE(offset + 8)
      datasize = bytes.readUInt32LE(offset + 12)
    }
    offset += cmdsize
  }
  if (linkeditOffset === -1 || codeSigOffset === -1) return null
  if (
    dataoff < commandsEnd ||
    datasize === 0 ||
    dataoff > bytes.byteLength ||
    datasize > bytes.byteLength - dataoff
  ) {
    return null
  }
  const totalBig = BigInt(bytes.byteLength)
  if (BigInt(dataoff) < linkeditFileoff || linkeditFileoff + linkeditFilesize !== totalBig) {
    return null
  }
  const trailing = bytes.byteLength - (dataoff + datasize)
  if (trailing < 0 || trailing >= 16) return null
  for (let i = dataoff + datasize; i < bytes.byteLength; i += 1) {
    if (bytes[i] !== 0) return null
  }

  const normalized = Buffer.from(bytes.subarray(0, dataoff))
  // Zero ONLY __LINKEDIT.vmsize (offset+32..40), __LINKEDIT.filesize (offset+48..56),
  // LC_CODE_SIGNATURE.dataoff (offset+8..12), and LC_CODE_SIGNATURE.datasize (offset+12..16).
  normalized.fill(0, linkeditOffset + 32, linkeditOffset + 40)
  normalized.fill(0, linkeditOffset + 48, linkeditOffset + 56)
  normalized.fill(0, codeSigOffset + 8, codeSigOffset + 16)
  return hash(normalized)
}

/**
 * @param {Buffer} bytes
 * @param {string} platform
 * @param {string} arch
 */
export function verifyAgySqliteBinaryHeader(bytes, platform, arch) {
  if (platform === 'darwin') {
    if (bytes.byteLength < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) {
      throw new Error('agy-sqlite-file macOS binary has no valid 64-bit Mach-O header.')
    }
    const expectedCpu = arch === 'arm64' ? 0x0100000c : 0x01000007
    if (bytes.readUInt32LE(4) !== expectedCpu) {
      throw new Error('agy-sqlite-file Mach-O architecture does not match its target.')
    }
    return
  }
  if (platform === 'win32') {
    if (bytes.byteLength < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('agy-sqlite-file Windows binary has no valid PE header.')
    }
    const peOffset = bytes.readUInt32LE(60)
    if (
      peOffset < 64 ||
      peOffset > bytes.byteLength - 24 ||
      bytes.readUInt32LE(peOffset) !== 0x4550
    ) {
      throw new Error('agy-sqlite-file Windows binary has no valid PE header.')
    }
    const machine = bytes.readUInt16LE(peOffset + 4)
    const expectedMachine = arch === 'arm64' ? 0xaa64 : 0x8664
    if (machine !== expectedMachine) {
      throw new Error('agy-sqlite-file PE architecture does not match its target.')
    }
    const numberOfSections = bytes.readUInt16LE(peOffset + 6)
    const sizeOfOptionalHeader = bytes.readUInt16LE(peOffset + 20)
    const characteristics = bytes.readUInt16LE(peOffset + 22)
    if ((characteristics & IMAGE_FILE_DLL) === 0) {
      throw new Error('agy-sqlite-file Windows PE binary is missing IMAGE_FILE_DLL.')
    }
    const optOffset = peOffset + 24
    if (
      numberOfSections < 1 ||
      numberOfSections > 96 ||
      sizeOfOptionalHeader < MIN_PE_OPTIONAL_HEADER_BYTES ||
      sizeOfOptionalHeader > bytes.byteLength - optOffset
    ) {
      throw new Error('agy-sqlite-file Windows PE optional header is missing or truncated.')
    }
    if (bytes.readUInt16LE(optOffset) !== IMAGE_NT_OPTIONAL_HDR64_MAGIC) {
      throw new Error('agy-sqlite-file Windows PE binary is not PE32+ (0x20b).')
    }
    const dllCharacteristics = bytes.readUInt16LE(optOffset + 70)
    if ((dllCharacteristics & IMAGE_DLLCHARACTERISTICS_GUARD_CF) === 0) {
      throw new Error('agy-sqlite-file Windows PE binary is missing GUARD_CF DllCharacteristics.')
    }
    const numberOfRvaAndSizes = bytes.readUInt32LE(optOffset + 108)
    if (numberOfRvaAndSizes < 11) {
      throw new Error('agy-sqlite-file Windows PE binary lacks DataDirectory[10] Load Config.')
    }
    const loadConfigRva = bytes.readUInt32LE(optOffset + 112 + 10 * 8)
    const loadConfigSize = bytes.readUInt32LE(optOffset + 112 + 10 * 8 + 4)
    if (loadConfigRva === 0 || loadConfigSize < MIN_LOAD_CONFIG64_BYTES) {
      throw new Error('agy-sqlite-file Windows PE Load Config directory is missing or too small.')
    }
    const sectionTableOffset = optOffset + sizeOfOptionalHeader
    const sectionTableBytes = numberOfSections * 40
    if (sectionTableBytes > bytes.byteLength - sectionTableOffset) {
      throw new Error('agy-sqlite-file Windows PE section table exceeds file bounds.')
    }
    const mapRvaToSection = (rva) => {
      for (let i = 0; i < numberOfSections; i += 1) {
        const s = sectionTableOffset + i * 40
        const virtualSize = bytes.readUInt32LE(s + 8)
        const virtualAddress = bytes.readUInt32LE(s + 12)
        const sizeOfRawData = bytes.readUInt32LE(s + 16)
        const pointerToRawData = bytes.readUInt32LE(s + 20)
        const span = Math.max(virtualSize, sizeOfRawData)
        if (rva >= virtualAddress && rva < virtualAddress + span) {
          const delta = rva - virtualAddress
          if (delta > sizeOfRawData) {
            return null
          }
          return {
            fileOffset: pointerToRawData + delta,
            sectionAvailable: sizeOfRawData - delta,
          }
        }
      }
      return null
    }
    const loadConfigLoc = mapRvaToSection(loadConfigRva)
    if (
      !loadConfigLoc ||
      loadConfigLoc.sectionAvailable < MIN_LOAD_CONFIG64_BYTES ||
      loadConfigLoc.fileOffset > bytes.byteLength - MIN_LOAD_CONFIG64_BYTES
    ) {
      throw new Error('agy-sqlite-file Windows PE Load Config RVA is out of section/file bounds.')
    }
    const loadConfigFileOffset = loadConfigLoc.fileOffset
    const loadConfigSectionAvailable = loadConfigLoc.sectionAvailable
    const structSize = bytes.readUInt32LE(loadConfigFileOffset)
    const requiredConfigBytes = Math.max(structSize, loadConfigSize)
    if (
      structSize < MIN_LOAD_CONFIG64_BYTES ||
      requiredConfigBytes > loadConfigSectionAvailable ||
      requiredConfigBytes > bytes.byteLength - loadConfigFileOffset
    ) {
      throw new Error('agy-sqlite-file Windows PE Load Config struct size is invalid or truncated.')
    }
    const guardFlags = bytes.readUInt32LE(loadConfigFileOffset + 144)
    if ((guardFlags & IMAGE_GUARD_CF_INSTRUMENTED) === 0) {
      throw new Error(
        'agy-sqlite-file Windows PE Load Config is missing IMAGE_GUARD_CF_INSTRUMENTED.',
      )
    }
    const guardCfFunctionTableVa = bytes.readBigUInt64LE(loadConfigFileOffset + 128)
    const guardCfFunctionCount = bytes.readBigUInt64LE(loadConfigFileOffset + 136)
    if (guardCfFunctionCount === 0n && guardCfFunctionTableVa !== 0n) {
      throw new Error(
        'agy-sqlite-file Windows PE Load Config declares GuardCFFunctionTable with zero count.',
      )
    }
    if (guardCfFunctionCount > 0n) {
      const imageBase = bytes.readBigUInt64LE(optOffset + 24)
      if (guardCfFunctionTableVa <= imageBase) {
        throw new Error('agy-sqlite-file Windows PE GuardCFFunctionTable VA lies below ImageBase.')
      }
      const tableRvaBig = guardCfFunctionTableVa - imageBase
      if (tableRvaBig > 0xffffffffn) {
        throw new Error('agy-sqlite-file Windows PE GuardCFFunctionTable RVA overflows 32 bits.')
      }
      const extraEntryBytes = BigInt((guardFlags >>> 28) & 0xf)
      const entryStride = 4n + extraEntryBytes
      if (guardCfFunctionCount > BigInt(MAX_BINARY_BYTES)) {
        throw new Error('agy-sqlite-file Windows PE GuardCFFunctionCount exceeds bounds.')
      }
      const tableBytesBig = guardCfFunctionCount * entryStride
      const tableLoc = mapRvaToSection(Number(tableRvaBig))
      if (
        !tableLoc ||
        tableBytesBig > BigInt(tableLoc.sectionAvailable) ||
        BigInt(tableLoc.fileOffset) + tableBytesBig > BigInt(bytes.byteLength)
      ) {
        throw new Error(
          'agy-sqlite-file Windows PE GuardCFFunctionTable exceeds section or file bounds.',
        )
      }
    }
    return
  }
  if (
    bytes.byteLength < 20 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 2 ||
    bytes.readUInt16LE(18) !== (arch === 'arm64' ? 183 : 62)
  ) {
    throw new Error('agy-sqlite-file ELF architecture does not match its target.')
  }
}

async function verifyDarwinCodeSignature(binaryPath) {
  await execute('/usr/bin/codesign', ['--verify', '--strict', binaryPath], {
    cwd: dirname(binaryPath),
    shell: false,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  })
}

export async function inspectAgySqliteFileResource(
  directory,
  platform,
  arch,
  expectedSourceSha256,
  { verifyLoad = false, allowSignedBinary = false } = {},
) {
  const filename = agySqliteFileFilename(platform, arch)
  const resourcePrefix = agySqliteFileResourcePrefix(platform)
  if (!SHA256.test(expectedSourceSha256)) {
    throw new Error('Invalid agy-sqlite-file source identity.')
  }
  const binaryPath = join(directory, filename)
  const identityBytes = await boundedFile(`${binaryPath}.json`, 4096)
  const identity = JSON.parse(identityBytes.toString('utf8'))
  if (
    identity.version !== 1 ||
    identity.platform !== platform ||
    identity.architecture !== arch ||
    identity.sourceSha256 !== expectedSourceSha256 ||
    !SHA256.test(identity.binarySha256) ||
    !Number.isSafeInteger(identity.binaryBytes) ||
    identity.binaryBytes < 64 ||
    identity.binaryBytes > MAX_BINARY_BYTES ||
    (identity.machoPreSigSha256 !== undefined && !SHA256.test(identity.machoPreSigSha256))
  ) {
    throw new Error('agy-sqlite-file identity metadata does not match its target/source/version.')
  }

  let binaryBuffer
  try {
    binaryBuffer = await boundedFile(binaryPath, MAX_BINARY_BYTES, {
      minimum: 64,
      label: 'agy-sqlite-file binary',
    })
  } catch {
    throw new Error('agy-sqlite-file binary is missing, redirected or has changed size.')
  }
  const bytes = binaryBuffer.byteLength
  if (!allowSignedBinary && bytes !== identity.binaryBytes) {
    throw new Error('agy-sqlite-file binary is missing, redirected or has changed size.')
  }
  verifyAgySqliteBinaryHeader(binaryBuffer, platform, arch)

  const actualSha256 = hash(binaryBuffer)
  const matchesPreSign = bytes === identity.binaryBytes && actualSha256 === identity.binarySha256
  let needsDarwinCodeSignatureCheck = false
  if (!matchesPreSign) {
    if (allowSignedBinary && platform === 'darwin' && process.platform === 'darwin') {
      if (!SHA256.test(identity.machoPreSigSha256)) {
        throw new Error(
          'agy-sqlite-file macOS metadata is missing machoPreSigSha256 for signed verification.',
        )
      }
      const actualPreSigSha256 = computeMachoPreSignatureSha256(binaryBuffer, arch)
      if (!actualPreSigSha256 || actualPreSigSha256 !== identity.machoPreSigSha256) {
        throw new Error(
          'agy-sqlite-file signed macOS binary pre-signature digest does not match its recorded build artifact.',
        )
      }
      needsDarwinCodeSignatureCheck = true
    } else {
      throw new Error(
        bytes !== identity.binaryBytes
          ? 'agy-sqlite-file binary is missing, redirected or has changed size.'
          : 'agy-sqlite-file binary does not match its recorded digest.',
      )
    }
  }

  if (needsDarwinCodeSignatureCheck || verifyLoad) {
    if (verifyLoad && (process.platform !== platform || process.arch !== arch)) {
      throw new Error('agy-sqlite-file load verification requires its native host architecture.')
    }
    // Stage the already-verified binary bytes into a private temp copy so codesign and dlopen
    // inspect the exact pinned bytes rather than re-opening the potentially mutable source path.
    const verifyStagingDir = await mkdtemp(join(tmpdir(), 'pact-agy-verify-'))
    try {
      if (process.platform !== 'win32') {
        await chmod(verifyStagingDir, 0o700)
      }
      const stagedBinaryPath = join(verifyStagingDir, filename)
      await writeFile(stagedBinaryPath, binaryBuffer, { flag: 'wx', mode: 0o500 })

      if (needsDarwinCodeSignatureCheck) {
        await verifyDarwinCodeSignature(stagedBinaryPath)
      }

      if (verifyLoad) {
        const probeScript = [
          'const mod = { exports: {} };',
          'process.dlopen(mod, process.argv[1]);',
          'process.stdout.write(JSON.stringify(mod.exports.moduleIdentity()));',
        ].join(' ')
        const response = await execute(process.execPath, ['-e', probeScript, stagedBinaryPath], {
          cwd: verifyStagingDir,
          shell: false,
          windowsHide: true,
          timeout: 5_000,
          maxBuffer: 4096,
          encoding: 'utf8',
        })
        const observed = JSON.parse(response.stdout)
        if (
          observed.version !== identity.version ||
          observed.platform !== platform ||
          observed.architecture !== arch ||
          observed.sourceSha256 !== identity.sourceSha256
        ) {
          throw new Error('agy-sqlite-file binary rejected its recorded source identity on load.')
        }
      }
    } finally {
      await rm(verifyStagingDir, { recursive: true, force: true })
    }
  }

  return {
    version: 1,
    platform,
    architecture: arch,
    sourceSha256: identity.sourceSha256,
    binary: {
      path: `${resourcePrefix}/${filename}`,
      sha256: actualSha256,
      bytes,
    },
    identity: {
      path: `${resourcePrefix}/${filename}.json`,
      sha256: hash(identityBytes),
      bytes: identityBytes.length,
    },
  }
}

/** One preparation entry for development, build, and every electron-builder target. */
export async function prepareAgySqliteFileResource(
  arch,
  platform = process.platform,
  { signal, autoMsvc = false } = {},
) {
  if (process.platform !== platform || process.arch !== arch) {
    throw new Error(
      `Build agy-sqlite-file for ${platform}-${arch} on a matching native host runner.`,
    )
  }
  agySqliteFileFilename(platform, arch)
  await execute(
    process.execPath,
    [join(root, 'scripts/build-agy-sqlite-file.mjs'), ...(autoMsvc ? ['--auto-msvc'] : [])],
    {
      cwd: root,
      shell: false,
      windowsHide: true,
      signal,
      timeout: 70_000,
      maxBuffer: 256 * 1024,
    },
  )
  return inspectAgySqliteFileResource(
    join(desktop, 'out/native'),
    platform,
    arch,
    await agySqliteFileSourceHash(),
    { verifyLoad: true },
  )
}

/** Bind agy-sqlite-file binary and metadata to the exact final distribution content inventory. */
export function validateAgySqliteFileManifest(manifest) {
  const record = manifest.agySqliteFile
  const entries = manifest.application?.entries
  if (!Array.isArray(entries) || entries.length > 16_384) {
    throw new Error('agy-sqlite-file requires a bounded application inventory.')
  }
  const filename = agySqliteFileFilename(manifest.platform, manifest.arch)
  const prefix = agySqliteFileResourcePrefix(manifest.platform)
  const found = entries.filter(
    (entry) =>
      typeof entry?.path === 'string' &&
      (entry.path.startsWith('resources/native/agy-sqlite-file-') ||
        entry.path.startsWith('Contents/Resources/native/agy-sqlite-file-')),
  )
  if (
    !record ||
    record.version !== 1 ||
    record.platform !== manifest.platform ||
    record.architecture !== manifest.arch ||
    !SHA256.test(record.sourceSha256) ||
    found.length !== 2
  ) {
    throw new Error('agy-sqlite-file manifest identity or inventory is invalid.')
  }
  for (const [key, expectedPath, maximum] of [
    ['binary', `${prefix}/${filename}`, MAX_BINARY_BYTES],
    ['identity', `${prefix}/${filename}.json`, 4096],
  ]) {
    const value = record[key]
    if (
      !value ||
      value.path !== expectedPath ||
      !SHA256.test(value.sha256) ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 1 ||
      value.bytes > maximum ||
      found.filter(
        (entry) =>
          entry.type === 'file' &&
          entry.path === expectedPath &&
          entry.sha256 === value.sha256 &&
          entry.bytes === value.bytes,
      ).length !== 1
    ) {
      throw new Error('agy-sqlite-file manifest does not match the packaged bytes.')
    }
  }
  return {
    version: 1,
    platform: manifest.platform,
    architecture: manifest.arch,
    sourceSha256: record.sourceSha256,
    binary: {
      path: record.binary.path,
      sha256: record.binary.sha256,
      bytes: record.binary.bytes,
    },
    identity: {
      path: record.identity.path,
      sha256: record.identity.sha256,
      bytes: record.identity.bytes,
    },
  }
}
