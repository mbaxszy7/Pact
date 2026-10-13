// SHA-256 over explicit UTF-16LE code units preserves lone surrogates as well as normal text.
// A synchronous, bounded encoder is required while ClipboardEvent.clipboardData is valid.
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const rotate = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))

export function composerClipboardDigest(text: string): string {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const words = new Uint32Array(64)
  const block = new Uint8Array(64)
  let used = 0
  const compress = (): void => {
    for (let index = 0; index < 16; index += 1) {
      const at = index * 4
      words[index] =
        (block[at]! << 24) | (block[at + 1]! << 16) | (block[at + 2]! << 8) | block[at + 3]!
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]!,
        y = words[index - 2]!
      words[index] =
        words[index - 16]! +
        (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
        words[index - 7]! +
        (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))
    }
    let a = state[0]!,
      b = state[1]!,
      c = state[2]!,
      d = state[3]!,
      e = state[4]!,
      f = state[5]!,
      g = state[6]!,
      h = state[7]!
    for (let index = 0; index < 64; index += 1) {
      const first =
        h +
        (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
        ((e & f) ^ (~e & g)) +
        ROUND_CONSTANTS[index]! +
        words[index]!
      const second = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))
      h = g
      g = f
      f = e
      e = (d + first) >>> 0
      d = c
      c = b
      b = a
      a = (first + second) >>> 0
    }
    for (const [index, value] of [a, b, c, d, e, f, g, h].entries())
      state[index] = state[index]! + value
    used = 0
  }
  const push = (byte: number): void => {
    block[used++] = byte
    if (used === 64) compress()
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    push(code & 0xff)
    push(code >>> 8)
  }
  push(0x80)
  const padding = (56 - used + 64) % 64
  for (let index = 0; index < padding; index += 1) push(0)
  const bits = text.length * 16
  const high = Math.floor(bits / 0x1_0000_0000),
    low = bits >>> 0
  for (const word of [high, low])
    for (let shift = 24; shift >= 0; shift -= 8) push((word >>> shift) & 0xff)
  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('')
}
