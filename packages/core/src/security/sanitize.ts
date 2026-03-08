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

  if (value !== null && typeof value === 'object') {
    const clean: Record<string, unknown> = {}
    for (const key of Object.keys(value as object)) {
      if (DANGEROUS_KEYS.has(key)) continue
      clean[key] = sanitizePayload((value as Record<string, unknown>)[key], depth + 1)
    }
    return clean as T
  }

  return value
}
