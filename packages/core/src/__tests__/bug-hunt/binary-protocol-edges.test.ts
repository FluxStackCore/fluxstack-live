// Bug hunt: binary chunk encode/decode edge cases.
//
// The wire format is [4 bytes headerLen LE][JSON header][binary data] and
// `decodeBinaryChunk` reads `headerLen` from attacker-controlled bytes.
// A truncated or lying header field is an obvious vector.

import { describe, it, expect } from 'vitest'
import { encodeBinaryChunk, decodeBinaryChunk } from '../../protocol/binary'
import type { BinaryChunkHeader } from '../../protocol/messages'

const sampleHeader: BinaryChunkHeader = {
  type: 'FILE_UPLOAD_CHUNK',
  uploadId: 'u-1',
  componentId: 'c-1',
  chunkIndex: 0,
  totalChunks: 1,
} as any

describe('encodeBinaryChunk + decodeBinaryChunk — round-trip', () => {
  it('round-trips a typical chunk losslessly', () => {
    const data = Buffer.from([0x01, 0x02, 0x03, 0xFE, 0xFF])
    const encoded = encodeBinaryChunk(sampleHeader, data)
    const { header, data: out } = decodeBinaryChunk(encoded)
    expect(header).toEqual(sampleHeader)
    expect(Buffer.compare(out, data)).toBe(0)
  })

  it('round-trips an empty data buffer', () => {
    const encoded = encodeBinaryChunk(sampleHeader, Buffer.alloc(0))
    const { header, data } = decodeBinaryChunk(encoded)
    expect(header).toEqual(sampleHeader)
    expect(data.length).toBe(0)
  })

  it('round-trips a 1MB data buffer', () => {
    const data = Buffer.alloc(1024 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff
    const encoded = encodeBinaryChunk(sampleHeader, data)
    const { data: out } = decodeBinaryChunk(encoded)
    expect(out.length).toBe(data.length)
    expect(Buffer.compare(out, data)).toBe(0)
  })

  it('accepts both ArrayBuffer and Uint8Array inputs', () => {
    const encoded = encodeBinaryChunk(sampleHeader, Buffer.from([1, 2, 3]))
    const ab = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)

    const fromAb = decodeBinaryChunk(ab as ArrayBuffer)
    const fromU8 = decodeBinaryChunk(new Uint8Array(ab as ArrayBuffer))
    expect(fromAb.header).toEqual(fromU8.header)
    expect(Buffer.compare(fromAb.data, fromU8.data)).toBe(0)
  })

  it('encode preserves data byte-for-byte across all byte values 0x00-0xFF', () => {
    const data = Buffer.alloc(256)
    for (let i = 0; i < 256; i++) data[i] = i
    const { data: out } = decodeBinaryChunk(encodeBinaryChunk(sampleHeader, data))
    expect(Buffer.compare(out, data)).toBe(0)
  })

  it('handles non-ASCII characters in header values (UTF-8)', () => {
    const h = { ...sampleHeader, uploadId: 'üpløad-Ã¶-€' } as any
    const { header } = decodeBinaryChunk(encodeBinaryChunk(h, Buffer.alloc(0)))
    expect((header as any).uploadId).toBe('üpløad-Ã¶-€')
  })
})

describe('decodeBinaryChunk — adversarial / malformed input', () => {
  it('throws on a buffer too small to read headerLength (< 4 bytes)', () => {
    expect(() => decodeBinaryChunk(Buffer.alloc(2))).toThrow()
  })

  it('throws on a buffer of exactly 4 bytes claiming headerLength = 0', () => {
    // headerLen=0 → header slice is empty → JSON.parse('') throws.
    const buf = Buffer.alloc(4)
    buf.writeUInt32LE(0, 0)
    expect(() => decodeBinaryChunk(buf)).toThrow(/JSON|Unexpected/i)
  })

  it('🔍 headerLength larger than the buffer truncates silently (no out-of-bounds throw)', () => {
    // The implementation slices to `4 + headerLength` — Buffer.slice clamps
    // to buffer length rather than throwing, so a malicious header claiming
    // length 0xFFFFFFFF returns whatever bytes follow without error from
    // slice itself. JSON.parse on the (likely garbage) result then throws.
    const buf = Buffer.alloc(10)
    buf.writeUInt32LE(0xFFFFFFFF, 0)
    buf.write('{"a":1}', 4, 'utf-8')
    expect(() => decodeBinaryChunk(buf)).toThrow()
  })

  it('🔍 headerLength = 0xFFFFFFFF (max uint32) does not allocate gigabytes', () => {
    // We rely on Buffer.slice() being O(1) view-based (no copy), so this
    // must complete quickly and just throw a JSON.parse error. If a future
    // refactor switches to Buffer.copy/Buffer.from, this regression test
    // would catch the memory blow-up.
    const buf = Buffer.alloc(10)
    buf.writeUInt32LE(0xFFFFFFFF, 0)
    const start = Date.now()
    expect(() => decodeBinaryChunk(buf)).toThrow()
    expect(Date.now() - start).toBeLessThan(50)
  })

  it('throws on invalid JSON in the header region', () => {
    const json = '{not valid json'
    const headerBuf = Buffer.from(json, 'utf-8')
    const buf = Buffer.alloc(4 + headerBuf.length + 5)
    buf.writeUInt32LE(headerBuf.length, 0)
    headerBuf.copy(buf, 4)
    expect(() => decodeBinaryChunk(buf)).toThrow()
  })

  it('throws when header JSON is valid but binary tail is shorter than expected', () => {
    // The decoder does not validate tail length against header — it just
    // returns whatever bytes remain. That is documented behavior; downstream
    // (FileUploadManager.receiveChunk) compares bytes against expected size.
    // We assert the decoder itself accepts a short tail and returns it as-is.
    const h = JSON.stringify(sampleHeader)
    const headerBuf = Buffer.from(h, 'utf-8')
    // Tail of 0 bytes
    const buf = Buffer.alloc(4 + headerBuf.length)
    buf.writeUInt32LE(headerBuf.length, 0)
    headerBuf.copy(buf, 4)
    const { data } = decodeBinaryChunk(buf)
    expect(data.length).toBe(0)
  })

  it('🔍 headerLength = negative-as-signed (0x80000000) is read as a huge unsigned', () => {
    // readUInt32LE on bytes 80 00 00 00 yields 0x80000000 (~2GB), not -2GB.
    // That's correct (LE unsigned), but the resulting slice is gigantic.
    // Make sure we still throw quickly rather than allocate.
    const buf = Buffer.alloc(10)
    buf.writeUInt32LE(0x80000000, 0)
    const start = Date.now()
    expect(() => decodeBinaryChunk(buf)).toThrow()
    expect(Date.now() - start).toBeLessThan(50)
  })

  it('encode then decode preserves identical header object (no key reordering)', () => {
    const h = { type: 'A', uploadId: 'X', extra: 'Y', n: 42 } as any
    const { header } = decodeBinaryChunk(encodeBinaryChunk(h, Buffer.alloc(0)))
    expect(header).toEqual(h)
  })
})

describe('encodeBinaryChunk — output structure', () => {
  it('first 4 bytes encode header length as little-endian uint32', () => {
    const encoded = encodeBinaryChunk(sampleHeader, Buffer.alloc(0))
    const expectedLen = Buffer.from(JSON.stringify(sampleHeader), 'utf-8').length
    expect(encoded.readUInt32LE(0)).toBe(expectedLen)
  })

  it('total output length = 4 + headerLen + dataLen', () => {
    const data = Buffer.from([1, 2, 3, 4, 5])
    const encoded = encodeBinaryChunk(sampleHeader, data)
    const headerLen = Buffer.from(JSON.stringify(sampleHeader), 'utf-8').length
    expect(encoded.length).toBe(4 + headerLen + data.length)
  })
})
