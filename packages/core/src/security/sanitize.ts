// @fluxstack/live - Payload Sanitization
//
// Strips prototype pollution keys (__proto__, constructor, prototype)
// from incoming client payloads recursively.
// Optimized: only clones when dangerous keys are found.

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_DEPTH = 10

/**
 * Recursively strip dangerous keys from an object.
 * Returns the original reference if no dangerous keys are found (zero-copy fast path).
 * Only creates a new object when sanitization is actually needed.
 */
export function sanitizePayload<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return value

  if (Array.isArray(value)) {
    let cloned = false
    let result = value as any[]
    for (let i = 0; i < value.length; i++) {
      const sanitized = sanitizePayload(value[i], depth + 1)
      if (sanitized !== value[i]) {
        if (!cloned) { result = value.slice(); cloned = true }
        result[i] = sanitized
      }
    }
    return result as T
  }

  if (typeof value === 'function') return undefined as T

  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as object)
    let clean: Record<string, unknown> | null = null

    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) {
        // Lazy clone: only create new object when we find a dangerous key
        if (!clean) {
          clean = {}
          for (const k of keys) {
            if (k === key) break
            clean[k] = sanitizePayload((value as any)[k], depth + 1)
          }
        }
        continue
      }

      const val = (value as Record<string, unknown>)[key]
      if (typeof val === 'function') {
        if (!clean) {
          clean = {}
          for (const k of keys) {
            if (k === key) break
            clean[k] = sanitizePayload((value as any)[k], depth + 1)
          }
        }
        continue
      }

      const sanitized = sanitizePayload(val, depth + 1)
      if (clean) {
        clean[key] = sanitized
      } else if (sanitized !== val) {
        // A nested value changed — need to clone from here
        clean = {}
        for (const k of keys) {
          if (k === key) break
          clean[k] = (value as any)[k]
        }
        clean[key] = sanitized
      }
    }

    return (clean ?? value) as T
  }

  return value
}
