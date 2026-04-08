// @fluxstack/live - Payload Sanitization
//
// Strips prototype pollution keys (__proto__, constructor, prototype)
// from incoming client payloads recursively.

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_DEPTH = 10

/**
 * Recursively strip dangerous keys from an object.
 * Returns a clean copy (does not mutate the original).
 */
export function sanitizePayload<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return value

  if (Array.isArray(value)) {
    return value.map(item => sanitizePayload(item, depth + 1)) as T
  }

  // Strip functions — JSON payloads should never contain them
  if (typeof value === 'function') return undefined as T

  if (value !== null && typeof value === 'object') {
    const clean: Record<string, unknown> = {}
    for (const key of Object.keys(value as object)) {
      if (DANGEROUS_KEYS.has(key)) continue
      const val = (value as Record<string, unknown>)[key]
      // Skip function values in object properties
      if (typeof val === 'function') continue
      clean[key] = sanitizePayload(val, depth + 1)
    }
    return clean as T
  }

  return value
}
