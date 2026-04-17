import { describe, it, expect } from 'vitest'
import { BinaryStateCodec } from '../../protocol/BinaryStateCodec'

describe('BinaryStateCodec', () => {
  describe('constructor & info', () => {
    it('should infer field types from defaultState', () => {
      const codec = new BinaryStateCodec({
        count: 0,
        name: '',
        active: false,
      })
      const info = codec.info
      expect(info.fieldCount).toBe(3)
      expect(info.fields).toEqual(['count', 'name', 'active'])
      expect(info.unsupported).toEqual([])
      expect(info.fullCoverage).toBe(true)
    })

    it('should detect unsupported types', () => {
      const codec = new BinaryStateCodec({
        count: 0,
        tags: ['a', 'b'],
        nested: { x: 1 },
        nullable: null,
      })
      const info = codec.info
      expect(info.fieldCount).toBe(1) // only count
      expect(info.fields).toEqual(['count'])
      expect(info.unsupported).toEqual(['tags', 'nested', 'nullable'])
      expect(info.fullCoverage).toBe(false)
    })

    it('should handle empty state', () => {
      const codec = new BinaryStateCodec({})
      expect(codec.hasFields).toBe(false)
      expect(codec.fullCoverage).toBe(true)
    })
  })

  describe('encodeDelta / decodeDelta - numbers', () => {
    const codec = new BinaryStateCodec({ x: 0, y: 0, hp: 100, score: 0 })

    it('should round-trip a single number field', () => {
      const delta = { x: 42.5 }
      const { binary } = codec.encodeDelta(delta)
      expect(binary).not.toBeNull()
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ x: 42.5 })
    })

    it('should round-trip multiple number fields', () => {
      const delta = { x: 100.25, y: -50.75, hp: 80 }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ x: 100.25, y: -50.75, hp: 80 })
    })

    it('should round-trip all fields', () => {
      const delta = { x: 1, y: 2, hp: 3, score: 4 }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual(delta)
    })

    it('should handle large numbers', () => {
      const delta = { score: 1776278454844 }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ score: 1776278454844 })
    })

    it('should handle negative numbers', () => {
      const delta = { x: -999.99, y: -0.001 }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded.x).toBeCloseTo(-999.99)
      expect(decoded.y).toBeCloseTo(-0.001)
    })

    it('should handle zero', () => {
      const delta = { x: 0, y: 0 }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ x: 0, y: 0 })
    })

    it('should handle Infinity and NaN', () => {
      const delta = { x: Infinity, y: -Infinity }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded.x).toBe(Infinity)
      expect(decoded.y).toBe(-Infinity)
    })
  })

  describe('encodeDelta / decodeDelta - booleans', () => {
    const codec = new BinaryStateCodec({ active: false, visible: true, paused: false })

    it('should round-trip boolean fields', () => {
      const delta = { active: true, paused: true }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ active: true, paused: true })
    })

    it('should handle false values', () => {
      const delta = { active: false, visible: false, paused: false }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ active: false, visible: false, paused: false })
    })
  })

  describe('encodeDelta / decodeDelta - strings', () => {
    const codec = new BinaryStateCodec({ name: '', email: '', role: '' })

    it('should round-trip string fields', () => {
      const delta = { name: 'Marcos Silva', role: 'admin' }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ name: 'Marcos Silva', role: 'admin' })
    })

    it('should handle empty strings', () => {
      const delta = { name: '' }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ name: '' })
    })

    it('should handle unicode strings', () => {
      const delta = { name: 'João André 日本語 🎮' }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ name: 'João André 日本語 🎮' })
    })

    it('should handle long strings', () => {
      const longStr = 'a'.repeat(10000)
      const delta = { name: longStr }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ name: longStr })
    })
  })

  describe('encodeDelta / decodeDelta - mixed types', () => {
    const codec = new BinaryStateCodec({
      count: 0,
      name: '',
      active: false,
      score: 0,
      email: '',
      visible: true,
    })

    it('should round-trip mixed delta', () => {
      const delta = { count: 42, name: 'Marcos', active: true }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual(delta)
    })

    it('should round-trip all mixed fields', () => {
      const delta = {
        count: 99,
        name: 'Test User',
        active: true,
        score: 1234.56,
        email: 'test@example.com',
        visible: false,
      }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual(delta)
    })
  })

  describe('hybrid mode (binary + JSON fallback)', () => {
    const codec = new BinaryStateCodec({
      count: 0,
      name: '',
      tags: ['a'],
      metadata: { key: 'val' },
    })

    it('should separate binary and JSON fields', () => {
      const delta = { count: 5, name: 'test', tags: ['x', 'y'], metadata: { a: 1 } }
      const { binary, jsonFallback } = codec.encodeDelta(delta as any)

      expect(binary).not.toBeNull()
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ count: 5, name: 'test' })

      expect(jsonFallback).toEqual({ tags: ['x', 'y'], metadata: { a: 1 } })
    })

    it('should return null binary when only unsupported fields', () => {
      const delta = { tags: ['a', 'b'] }
      const { binary, jsonFallback } = codec.encodeDelta(delta as any)
      expect(binary).toBeNull()
      expect(jsonFallback).toEqual({ tags: ['a', 'b'] })
    })

    it('should return null jsonFallback when only supported fields', () => {
      const delta = { count: 10 }
      const { binary, jsonFallback } = codec.encodeDelta(delta as any)
      expect(binary).not.toBeNull()
      expect(jsonFallback).toBeNull()
    })
  })

  describe('wire size', () => {
    it('should be smaller than JSON for number-only state', () => {
      const codec = new BinaryStateCodec({ x: 0, y: 0, hp: 100, score: 0 })
      const delta = { x: 42.5, y: 100.0, hp: 80, score: 9999 }
      const { binary } = codec.encodeDelta(delta)
      const jsonSize = JSON.stringify(delta).length
      expect(binary!.length).toBeLessThan(jsonSize)
    })

    it('should produce minimal size for single number', () => {
      const codec = new BinaryStateCodec({ count: 0 })
      const { binary } = codec.encodeDelta({ count: 42 })
      // 1 byte bitmask + 8 bytes float64 = 9 bytes
      // vs JSON '{"count":42}' = 12 bytes
      expect(binary!.length).toBe(9)
    })

    it('should produce minimal size for boolean', () => {
      const codec = new BinaryStateCodec({ active: false })
      const { binary } = codec.encodeDelta({ active: true })
      // 1 byte bitmask + 1 byte uint8 = 2 bytes
      // vs JSON '{"active":true}' = 15 bytes
      expect(binary!.length).toBe(2)
    })
  })

  describe('many fields (bitmask > 1 byte)', () => {
    it('should handle up to 16 fields (2 bitmask bytes)', () => {
      const state: Record<string, number> = {}
      for (let i = 0; i < 16; i++) state[`f${i}`] = 0

      const codec = new BinaryStateCodec(state)
      expect(codec.info.fieldCount).toBe(16)

      // Set fields 0, 8, 15
      const delta: Record<string, number> = { f0: 1, f8: 2, f15: 3 }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ f0: 1, f8: 2, f15: 3 })
    })

    it('should handle 32 fields (4 bitmask bytes)', () => {
      const state: Record<string, number> = {}
      for (let i = 0; i < 32; i++) state[`f${i}`] = 0

      const codec = new BinaryStateCodec(state)
      expect(codec.info.fieldCount).toBe(32)

      const delta: Record<string, number> = { f0: 10, f15: 20, f31: 30 }
      const { binary } = codec.encodeDelta(delta)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ f0: 10, f15: 20, f31: 30 })
    })
  })

  describe('edge cases', () => {
    it('should return null binary for empty delta', () => {
      const codec = new BinaryStateCodec({ count: 0 })
      const { binary, jsonFallback } = codec.encodeDelta({})
      expect(binary).toBeNull()
      expect(jsonFallback).toBeNull()
    })

    it('should ignore unknown fields in delta', () => {
      const codec = new BinaryStateCodec({ count: 0 })
      const { binary } = codec.encodeDelta({ count: 5, unknown: 'test' } as any)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded).toEqual({ count: 5 })
    })

    it('should handle buffer reuse correctly across multiple encodes', () => {
      const codec = new BinaryStateCodec({ x: 0, y: 0 })

      const { binary: b1 } = codec.encodeDelta({ x: 1 })
      const { binary: b2 } = codec.encodeDelta({ y: 2 })
      const { binary: b3 } = codec.encodeDelta({ x: 3, y: 4 })

      // Decode all — they should be independent (sliced copies)
      expect(codec.decodeDelta(b1!)).toEqual({ x: 1 })
      expect(codec.decodeDelta(b2!)).toEqual({ y: 2 })
      expect(codec.decodeDelta(b3!)).toEqual({ x: 3, y: 4 })
    })
  })

  describe('explicit schema (typed wire types)', () => {
    it('should use uint8 for small integers', () => {
      const codec = new BinaryStateCodec(
        { hp: 100, level: 1 },
        { hp: 'uint8', level: 'uint8' }
      )
      const delta = { hp: 200, level: 50 }
      const { binary } = codec.encodeDelta(delta)
      // 1 byte bitmask + 1 byte hp + 1 byte level = 3 bytes
      // vs auto (float64): 1 + 8 + 8 = 17 bytes
      expect(binary!.length).toBe(3)
      expect(codec.decodeDelta(binary!)).toEqual(delta)
    })

    it('should use float32 for game positions', () => {
      const codec = new BinaryStateCodec(
        { x: 0, y: 0 },
        { x: 'float32', y: 'float32' }
      )
      const delta = { x: 42.5, y: 100.25 }
      const { binary } = codec.encodeDelta(delta)
      // 1 byte bitmask + 4 bytes x + 4 bytes y = 9 bytes
      // vs auto (float64): 1 + 8 + 8 = 17 bytes
      expect(binary!.length).toBe(9)
      const decoded = codec.decodeDelta(binary!)
      expect(decoded.x).toBeCloseTo(42.5, 2)
      expect(decoded.y).toBeCloseTo(100.25, 2)
    })

    it('should use uint16 for medium integers', () => {
      const codec = new BinaryStateCodec(
        { port: 0, itemCount: 0 },
        { port: 'uint16', itemCount: 'uint16' }
      )
      const delta = { port: 8080, itemCount: 65000 }
      const { binary } = codec.encodeDelta(delta)
      // 1 + 2 + 2 = 5 bytes
      expect(binary!.length).toBe(5)
      expect(codec.decodeDelta(binary!)).toEqual(delta)
    })

    it('should use uint32 for scores/timestamps', () => {
      const codec = new BinaryStateCodec(
        { score: 0 },
        { score: 'uint32' }
      )
      const delta = { score: 4000000000 }
      const { binary } = codec.encodeDelta(delta)
      // 1 + 4 = 5 bytes (vs float64: 1 + 8 = 9 bytes)
      expect(binary!.length).toBe(5)
      expect(codec.decodeDelta(binary!)).toEqual(delta)
    })

    it('should use int8 for small signed values', () => {
      const codec = new BinaryStateCodec(
        { dx: 0, dy: 0 },
        { dx: 'int8', dy: 'int8' }
      )
      const delta = { dx: -50, dy: 127 }
      const { binary } = codec.encodeDelta(delta)
      // 1 + 1 + 1 = 3 bytes
      expect(binary!.length).toBe(3)
      expect(codec.decodeDelta(binary!)).toEqual(delta)
    })

    it('should use int16 for tile coordinates', () => {
      const codec = new BinaryStateCodec(
        { tileX: 0, tileY: 0 },
        { tileX: 'int16', tileY: 'int16' }
      )
      const delta = { tileX: -1000, tileY: 30000 }
      const { binary } = codec.encodeDelta(delta)
      // 1 + 2 + 2 = 5 bytes
      expect(binary!.length).toBe(5)
      expect(codec.decodeDelta(binary!)).toEqual(delta)
    })

    it('should use int32 for large signed values', () => {
      const codec = new BinaryStateCodec(
        { balance: 0 },
        { balance: 'int32' }
      )
      const delta = { balance: -2000000000 }
      const { binary } = codec.encodeDelta(delta)
      expect(binary!.length).toBe(5)
      expect(codec.decodeDelta(binary!)).toEqual(delta)
    })

    it('should mix explicit and auto-inferred types', () => {
      const codec = new BinaryStateCodec(
        { x: 0, y: 0, name: '', active: false },
        { x: 'float32', y: 'float32' } // only x,y explicit; name,active auto-inferred
      )
      const info = codec.info
      expect(info.fieldCount).toBe(4)

      const delta = { x: 1.5, y: 2.5, name: 'test', active: true }
      const { binary } = codec.encodeDelta(delta as any)
      const decoded = codec.decodeDelta(binary!)
      expect((decoded as any).x).toBeCloseTo(1.5, 2)
      expect((decoded as any).y).toBeCloseTo(2.5, 2)
      expect((decoded as any).name).toBe('test')
      expect((decoded as any).active).toBe(true)
    })

    it('game state: massive byte savings with typed schema', () => {
      // Auto-infer: all float64
      const autoCodec = new BinaryStateCodec({ x: 0, y: 0, hp: 100, score: 0, level: 1 })
      // Explicit: optimized types
      const typedCodec = new BinaryStateCodec(
        { x: 0, y: 0, hp: 100, score: 0, level: 1 },
        { x: 'float32', y: 'float32', hp: 'uint8', score: 'uint32', level: 'uint8' }
      )

      const delta = { x: 42.5, y: 100.0, hp: 80, score: 99999, level: 15 }
      const auto = autoCodec.encodeDelta(delta)
      const typed = typedCodec.encodeDelta(delta)

      // Auto: 1 bitmask + 5*8 = 41 bytes
      expect(auto.binary!.length).toBe(41)
      // Typed: 1 bitmask + 4+4+1+4+1 = 15 bytes (63% smaller!)
      expect(typed.binary!.length).toBe(15)

      // JSON comparison
      const jsonSize = JSON.stringify(delta).length // ~52 bytes
      expect(typed.binary!.length).toBeLessThan(jsonSize)

      // Both decode correctly
      const autoDecoded = autoCodec.decodeDelta(auto.binary!)
      expect(autoDecoded).toEqual(delta)

      const typedDecoded = typedCodec.decodeDelta(typed.binary!)
      expect((typedDecoded as any).x).toBeCloseTo(42.5, 2)
      expect((typedDecoded as any).y).toBeCloseTo(100.0, 2)
      expect((typedDecoded as any).hp).toBe(80)
      expect((typedDecoded as any).score).toBe(99999)
      expect((typedDecoded as any).level).toBe(15)
    })
  })
})
