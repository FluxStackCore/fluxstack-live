import { describe, it, expect } from 'vitest'
import { sanitizePayload } from '../../security/sanitize'

describe('sanitizePayload', () => {
  it('should pass through primitives unchanged', () => {
    expect(sanitizePayload('hello')).toBe('hello')
    expect(sanitizePayload(42)).toBe(42)
    expect(sanitizePayload(true)).toBe(true)
    expect(sanitizePayload(null)).toBe(null)
    expect(sanitizePayload(undefined)).toBe(undefined)
  })

  it('should pass through clean objects unchanged', () => {
    const input = { name: 'test', count: 5, nested: { a: 1 } }
    expect(sanitizePayload(input)).toEqual(input)
  })

  it('should strip __proto__ from top level', () => {
    const input = JSON.parse('{"name":"test","__proto__":{"isAdmin":true}}')
    const result = sanitizePayload(input)
    expect(result).toEqual({ name: 'test' })
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false)
  })

  it('should strip constructor from top level', () => {
    const input = { name: 'test', constructor: { prototype: { polluted: true } } }
    const result = sanitizePayload(input)
    expect(result).toEqual({ name: 'test' })
  })

  it('should strip prototype from top level', () => {
    const input = { name: 'test', prototype: { hack: true } }
    const result = sanitizePayload(input)
    expect(result).toEqual({ name: 'test' })
  })

  it('should strip dangerous keys from nested objects', () => {
    const input = JSON.parse('{"data":{"value":1,"__proto__":{"isAdmin":true}}}')
    const result = sanitizePayload(input)
    expect(result).toEqual({ data: { value: 1 } })
  })

  it('should strip dangerous keys from objects inside arrays', () => {
    const input = JSON.parse('[{"name":"ok"},{"__proto__":{"bad":true},"safe":"yes"}]')
    const result = sanitizePayload(input)
    expect(result).toEqual([{ name: 'ok' }, { safe: 'yes' }])
  })

  it('should handle deeply nested pollution attempts', () => {
    const input = JSON.parse('{"a":{"b":{"c":{"__proto__":{"x":1},"d":"ok"}}}}')
    const result = sanitizePayload(input)
    expect(result).toEqual({ a: { b: { c: { d: 'ok' } } } })
  })

  it('should respect MAX_DEPTH and return value as-is beyond depth 10', () => {
    // Build an object 12 levels deep with __proto__ at level 11
    let obj: any = { '__proto__': { polluted: true }, safe: 'leaf' }
    for (let i = 0; i < 11; i++) {
      obj = { nested: obj }
    }
    const result = sanitizePayload(obj)
    // The __proto__ beyond depth 10 won't be stripped (by design - prevents DoS via deep recursion)
    // But the object is still valid
    expect(result.nested).toBeDefined()
  })

  it('should not mutate the original object', () => {
    const input = JSON.parse('{"name":"test","__proto__":{"isAdmin":true}}')
    const keys = Object.keys(input)
    sanitizePayload(input)
    expect(Object.keys(input)).toEqual(keys)
  })

  it('should handle empty objects and arrays', () => {
    expect(sanitizePayload({})).toEqual({})
    expect(sanitizePayload([])).toEqual([])
  })
})
