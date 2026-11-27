import {
  type DecodedProtobufTimestamp,
  MAX_PROTOBUF_FIELD_NUMBER,
  PROTOBUF_WIRE_BYTES,
  PROTOBUF_WIRE_FIXED32,
  PROTOBUF_WIRE_FIXED64,
  PROTOBUF_WIRE_VARINT,
  type ProtobufWireField,
} from './constants-and-types'

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export function decodeUtf8Strict(bytes: Buffer): string {
  try {
    return utf8Decoder.decode(bytes)
  } catch {
    throw new Error('Invalid UTF-8 string in Antigravity Protobuf field.')
  }
}

export function readVarint(buffer: Buffer, start: number): { value: bigint; nextOffset: number } {
  let result = 0n
  let shift = 0n
  for (let index = 0; index < 10; index += 1) {
    const position = start + index
    if (position >= buffer.length)
      throw new Error('Truncated Protobuf varint in Antigravity record.')
    const byte = buffer[position]!
    if (index === 9 && byte > 0x01)
      throw new Error('Overflowing 64-bit Protobuf varint in Antigravity record.')
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: result, nextOffset: position + 1 }
    shift += 7n
  }
  throw new Error('Unterminated Protobuf varint in Antigravity record.')
}

function writeVarint(value: bigint): Buffer {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new Error('Protobuf varint is outside unsigned 64-bit bounds.')
  const bytes: number[] = []
  let remaining = value
  while (remaining >= 0x80n) {
    bytes.push(Number(remaining & 0x7fn) | 0x80)
    remaining >>= 7n
  }
  bytes.push(Number(remaining))
  return Buffer.from(bytes)
}

export function toSafeUint32(value: bigint, label: string): number {
  if (value < 0n || value > 0xffff_ffffn)
    throw new Error(`Invalid uint32 value in Antigravity ${label}.`)
  return Number(value)
}

export function toSafeInt32(value: bigint, label: string): number {
  const signed = BigInt.asIntN(32, value)
  if (
    value > 0x7fff_ffffn &&
    !(value >= 0xffff_ffff_8000_0000n && value <= 0xffff_ffff_ffff_ffffn)
  ) {
    throw new Error(`Invalid int32 varint encoding in Antigravity ${label}.`)
  }
  return Number(signed)
}

export function decodeProtobufFields(buffer: Buffer): ProtobufWireField[] {
  const fields: ProtobufWireField[] = []
  let offset = 0
  while (offset < buffer.length) {
    const fieldStart = offset
    const tagRead = readVarint(buffer, offset)
    offset = tagRead.nextOffset
    const wireType = Number(tagRead.value & 0x07n)
    const fieldNumberBig = tagRead.value >> 3n
    if (fieldNumberBig <= 0n || fieldNumberBig > BigInt(MAX_PROTOBUF_FIELD_NUMBER))
      throw new Error('Invalid Protobuf field number in Antigravity record.')
    const fieldNumber = Number(fieldNumberBig)
    if (wireType === PROTOBUF_WIRE_VARINT) {
      const valueRead = readVarint(buffer, offset)
      offset = valueRead.nextOffset
      fields.push({
        fieldNumber,
        wireType: PROTOBUF_WIRE_VARINT,
        varint: valueRead.value,
        rawBytes: buffer.subarray(fieldStart, offset),
      })
    } else if (wireType === PROTOBUF_WIRE_FIXED64) {
      if (offset + 8 > buffer.length)
        throw new Error('Truncated Protobuf fixed64 field in Antigravity record.')
      const fixed64 = buffer.subarray(offset, offset + 8)
      offset += 8
      fields.push({
        fieldNumber,
        wireType: PROTOBUF_WIRE_FIXED64,
        fixed64,
        rawBytes: buffer.subarray(fieldStart, offset),
      })
    } else if (wireType === PROTOBUF_WIRE_BYTES) {
      const lengthRead = readVarint(buffer, offset)
      offset = lengthRead.nextOffset
      if (lengthRead.value > BigInt(buffer.length - offset))
        throw new Error('Truncated Protobuf length-delimited field in Antigravity record.')
      const byteLength = Number(lengthRead.value)
      const bytes = buffer.subarray(offset, offset + byteLength)
      offset += byteLength
      fields.push({
        fieldNumber,
        wireType: PROTOBUF_WIRE_BYTES,
        bytes,
        rawBytes: buffer.subarray(fieldStart, offset),
      })
    } else if (wireType === PROTOBUF_WIRE_FIXED32) {
      if (offset + 4 > buffer.length)
        throw new Error('Truncated Protobuf fixed32 field in Antigravity record.')
      const fixed32 = buffer.subarray(offset, offset + 4)
      offset += 4
      fields.push({
        fieldNumber,
        wireType: PROTOBUF_WIRE_FIXED32,
        fixed32,
        rawBytes: buffer.subarray(fieldStart, offset),
      })
    } else {
      throw new Error(`Unsupported Protobuf wire type (${wireType}) in Antigravity record.`)
    }
  }
  return fields
}

export function encodeProtobufFields(fields: readonly ProtobufWireField[]): Buffer {
  if (fields.length === 0) return Buffer.alloc(0)
  return Buffer.concat(fields.map((field) => field.rawBytes))
}

function assertValidFieldNumber(fieldNumber: number): void {
  if (
    !Number.isSafeInteger(fieldNumber) ||
    fieldNumber <= 0 ||
    fieldNumber > MAX_PROTOBUF_FIELD_NUMBER
  ) {
    throw new Error('Invalid Protobuf field number.')
  }
}

export function encodeVarintField(fieldNumber: number, value: bigint | number): ProtobufWireField {
  assertValidFieldNumber(fieldNumber)
  const unsigned =
    typeof value === 'bigint'
      ? value < 0n
        ? BigInt.asUintN(64, value)
        : value
      : value < 0
        ? BigInt.asUintN(64, BigInt(value))
        : BigInt(value)
  const tag = writeVarint((BigInt(fieldNumber) << 3n) | BigInt(PROTOBUF_WIRE_VARINT))
  const encoded = writeVarint(unsigned)
  return {
    fieldNumber,
    wireType: PROTOBUF_WIRE_VARINT,
    varint: unsigned,
    rawBytes: Buffer.concat([tag, encoded]),
  }
}

export function encodeBytesField(fieldNumber: number, payload: Buffer): ProtobufWireField {
  assertValidFieldNumber(fieldNumber)
  const tag = writeVarint((BigInt(fieldNumber) << 3n) | BigInt(PROTOBUF_WIRE_BYTES))
  const length = writeVarint(BigInt(payload.byteLength))
  const copied = Buffer.from(payload)
  return {
    fieldNumber,
    wireType: PROTOBUF_WIRE_BYTES,
    bytes: copied,
    rawBytes: Buffer.concat([tag, length, copied]),
  }
}

export function encodeStringField(fieldNumber: number, text: string): ProtobufWireField {
  return encodeBytesField(fieldNumber, Buffer.from(text, 'utf8'))
}

export function encodeFixed64Field(fieldNumber: number, fixed64: Buffer): ProtobufWireField {
  assertValidFieldNumber(fieldNumber)
  if (fixed64.byteLength !== 8) throw new Error('Protobuf fixed64 payload must be 8 bytes.')
  const tag = writeVarint((BigInt(fieldNumber) << 3n) | BigInt(PROTOBUF_WIRE_FIXED64))
  const copied = Buffer.from(fixed64)
  return {
    fieldNumber,
    wireType: PROTOBUF_WIRE_FIXED64,
    fixed64: copied,
    rawBytes: Buffer.concat([tag, copied]),
  }
}

export function encodeFixed32Field(fieldNumber: number, fixed32: Buffer): ProtobufWireField {
  assertValidFieldNumber(fieldNumber)
  if (fixed32.byteLength !== 4) throw new Error('Protobuf fixed32 payload must be 4 bytes.')
  const tag = writeVarint((BigInt(fieldNumber) << 3n) | BigInt(PROTOBUF_WIRE_FIXED32))
  const copied = Buffer.from(fixed32)
  return {
    fieldNumber,
    wireType: PROTOBUF_WIRE_FIXED32,
    fixed32: copied,
    rawBytes: Buffer.concat([tag, copied]),
  }
}

export function decodeRepeatedUint32(
  fields: readonly ProtobufWireField[],
  fieldNumber: number,
): number[] {
  const values: number[] = []
  for (const field of fields) {
    if (field.fieldNumber !== fieldNumber) continue
    if (field.wireType === PROTOBUF_WIRE_VARINT) {
      values.push(toSafeUint32(field.varint, `field ${fieldNumber}`))
    } else if (field.wireType === PROTOBUF_WIRE_BYTES) {
      let offset = 0
      while (offset < field.bytes.length) {
        const next = readVarint(field.bytes, offset)
        offset = next.nextOffset
        values.push(toSafeUint32(next.value, `packed field ${fieldNumber}`))
      }
    } else {
      throw new Error(`Invalid wire type for repeated uint32 field ${fieldNumber}.`)
    }
  }
  return values
}

export function decodeTimestamp(buffer: Buffer): DecodedProtobufTimestamp {
  const fields = decodeProtobufFields(buffer)
  let seconds = 0n
  let nanos = 0
  for (const field of fields) {
    if (field.fieldNumber === 1) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT)
        throw new Error('Invalid Timestamp.seconds wire type.')
      seconds = BigInt.asIntN(64, field.varint)
    } else if (field.fieldNumber === 2) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT)
        throw new Error('Invalid Timestamp.nanos wire type.')
      nanos = toSafeInt32(field.varint, 'Timestamp.nanos')
    }
  }
  return { seconds, nanos }
}

export function encodeTimestamp(seconds: bigint, nanos = 0): Buffer {
  const fields: ProtobufWireField[] = []
  if (seconds !== 0n) fields.push(encodeVarintField(1, seconds))
  if (nanos !== 0) fields.push(encodeVarintField(2, nanos))
  return encodeProtobufFields(fields)
}
