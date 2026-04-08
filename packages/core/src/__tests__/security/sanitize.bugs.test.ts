// BUG #7: Prototype pollution sanitization is incomplete
// Only blocks __proto__, constructor, prototype — misses other dangerous patterns
import { describe, it, expect } from 'vitest'
import { sanitizePayload } from '../../security/sanitize'

describe('BUG: sanitizePayload misses dangerous patterns', () => {
  it('should strip __proto__ (already works)', () => {
    const input = JSON.parse('{"__proto__": {"isAdmin": true}, "name": "test"}')
    const result = sanitizePayload(input)
    expect(result).toEqual({ name: 'test' })
  })

  it('should strip constructor (already works)', () => {
    const input = { constructor: { prototype: { polluted: true } }, name: 'ok' }
    const result = sanitizePayload(input)
    expect(result).toEqual({ name: 'ok' })
  })

  it('should block constructor.prototype pollution via nested path', () => {
    // Attack vector: { "constructor": { "prototype": { "isAdmin": true } } }
    // This is caught by blocking "constructor" key entirely.
    // But what about accessing it through a different path?
    const input = JSON.parse('{"a": {"constructor": {"prototype": {"polluted": true}}}}')
    const result = sanitizePayload(input)
    expect(result).toEqual({ a: {} })
  })

  it('should handle toString override attempts', () => {
    // toString override can cause unexpected behavior when object is coerced to string
    const input = { toString: () => 'malicious', name: 'test' }
    const result = sanitizePayload(input)

    // The function value for toString should be stripped.
    // The result should NOT have its own toString property (it inherits from Object.prototype).
    expect(Object.prototype.hasOwnProperty.call(result, 'toString')).toBe(false)
    expect(result.name).toBe('test')
  })

  it('should strip function values from payloads', () => {
    // Functions in JSON payloads are always suspicious — JSON.parse can't produce them,
    // so they must have been injected programmatically
    const input = {
      name: 'test',
      callback: function() { return 'evil' },
      arrow: () => 'also evil',
    }
    const result = sanitizePayload(input)

    // BUG: Functions pass through sanitization unchanged.
    // JSON payloads should never contain functions.
    expect(typeof result.callback).not.toBe('function')
    expect(typeof result.arrow).not.toBe('function')
  })

  it('should handle Symbol.toPrimitive override attempts', () => {
    // Symbol properties can't be set via JSON, so this is less critical
    // but good to verify the sanitizer doesn't crash on them
    const input: any = { name: 'test' }
    input[Symbol.toPrimitive] = () => 'hacked'

    // Should not crash
    const result = sanitizePayload(input)
    expect(result.name).toBe('test')
  })

  it('should handle very wide objects (DoS via many keys)', () => {
    // An object with 100k keys could slow down sanitization
    const input: Record<string, number> = {}
    for (let i = 0; i < 10000; i++) {
      input[`key_${i}`] = i
    }

    const start = performance.now()
    const result = sanitizePayload(input)
    const elapsed = performance.now() - start

    expect(Object.keys(result)).toHaveLength(10000)
    // Should complete in reasonable time (< 100ms for 10k keys)
    expect(elapsed).toBeLessThan(100)
  })
})
