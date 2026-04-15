import { describe, it, expect } from 'vitest'
import { generateId } from '../../utils/generateId'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

describe('generateId', () => {
  it('returns a string of 8 characters', () => {
    const id = generateId()
    expect(id).toHaveLength(8)
  })

  it('only uses chars from the 64-char alphabet', () => {
    for (let i = 0; i < 1000; i++) {
      const id = generateId()
      for (const ch of id) {
        expect(ALPHABET).toContain(ch)
      }
    }
  })

  it('generates unique IDs', () => {
    const ids = new Set<string>()
    const count = 100_000
    for (let i = 0; i < count; i++) {
      ids.add(generateId())
    }
    expect(ids.size).toBe(count)
  })

  it('has reasonable character distribution', () => {
    const freq = new Map<string, number>()
    const runs = 50_000
    for (let i = 0; i < runs; i++) {
      const id = generateId()
      for (const ch of id) {
        freq.set(ch, (freq.get(ch) || 0) + 1)
      }
    }

    const totalChars = runs * 8
    const expected = totalChars / 64
    // Each char should appear within ±30% of the expected frequency
    for (const [ch, count] of freq) {
      expect(count).toBeGreaterThan(expected * 0.7)
      expect(count).toBeLessThan(expected * 1.3)
    }
    // All 64 chars should appear
    expect(freq.size).toBe(64)
  })

  describe('performance', () => {
    it('generates 100k IDs under 200ms', () => {
      const count = 100_000
      // warmup
      for (let i = 0; i < 1000; i++) generateId()

      const start = performance.now()
      for (let i = 0; i < count; i++) {
        generateId()
      }
      const elapsed = performance.now() - start
      console.log(`generateId: ${count} IDs in ${elapsed.toFixed(2)}ms (${(elapsed / count * 1000).toFixed(2)}µs/id)`)
      expect(elapsed).toBeLessThan(200)
    })

    it('compares with crypto.randomUUID()', () => {
      const count = 100_000
      // warmup both
      for (let i = 0; i < 1000; i++) { generateId(); crypto.randomUUID() }

      const startUUID = performance.now()
      for (let i = 0; i < count; i++) {
        crypto.randomUUID()
      }
      const elapsedUUID = performance.now() - startUUID

      const startId = performance.now()
      for (let i = 0; i < count; i++) {
        generateId()
      }
      const elapsedId = performance.now() - startId

      console.log(`crypto.randomUUID(): ${elapsedUUID.toFixed(2)}ms (${(36 * count / 1024).toFixed(0)}KB output)`)
      console.log(`generateId():        ${elapsedId.toFixed(2)}ms (${(8 * count / 1024).toFixed(0)}KB output)`)
      console.log(`Speed ratio: ${(elapsedUUID / elapsedId).toFixed(2)}x`)
      console.log(`Size ratio:  ${(36 / 8).toFixed(1)}x smaller`)
    })

    it('output is 78% smaller than UUID', () => {
      const id = generateId()
      const uuid = crypto.randomUUID()
      const saving = ((1 - id.length / uuid.length) * 100).toFixed(0)
      console.log(`generateId: ${id.length} chars ("${id}")`)
      console.log(`UUID:       ${uuid.length} chars ("${uuid}")`)
      console.log(`Size reduction: ${saving}%`)
      expect(id.length).toBeLessThan(uuid.length)
    })
  })
})
