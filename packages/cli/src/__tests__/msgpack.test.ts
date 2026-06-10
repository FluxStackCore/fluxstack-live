// Tests for the CLI's dependency-free msgpack decoder, focused on the depth
// guard (spec 05 FP-3): a deeply-nested or malicious frame must fail loudly
// (RangeError) instead of overflowing the stack.
import { describe, it, expect } from 'vitest'
import { decodeMsgpack } from '../msgpack'

describe('CLI msgpack decoder', () => {
  it('decodes a fixint', () => {
    expect(decodeMsgpack(new Uint8Array([0x05]))).toBe(5)
  })

  it('decodes a fixarray', () => {
    // 0x92 = array(2): [1, 2]
    expect(decodeMsgpack(new Uint8Array([0x92, 0x01, 0x02]))).toEqual([1, 2])
  })

  it('decodes a fixmap', () => {
    // 0x81 = map(1): { "a": 1 } → key fixstr 0xa1 'a' (0x61), value 0x01
    expect(decodeMsgpack(new Uint8Array([0x81, 0xa1, 0x61, 0x01]))).toEqual({ a: 1 })
  })

  it('decodes moderate nesting (under the limit)', () => {
    // 50 nested 1-element arrays, then a fixint.
    const depth = 50
    const buf = new Uint8Array([...Array(depth).fill(0x91), 0x07])
    let v: any = decodeMsgpack(buf)
    for (let i = 0; i < depth; i++) { expect(Array.isArray(v)).toBe(true); v = v[0] }
    expect(v).toBe(7)
  })

  it('throws RangeError on pathological nesting (over the limit)', () => {
    // 5000 nested 1-element arrays would overflow a naive recursive decoder.
    const buf = new Uint8Array([...Array(5000).fill(0x91), 0x00])
    expect(() => decodeMsgpack(buf)).toThrow(RangeError)
  })

  it('respects a custom maxDepth', () => {
    const buf = new Uint8Array([...Array(10).fill(0x91), 0x00])
    expect(() => decodeMsgpack(buf, 5)).toThrow(/max nesting depth 5/)
  })
})
