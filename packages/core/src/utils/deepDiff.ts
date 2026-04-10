// @fluxstack/live - Deep Diff Utilities
//
// Shared functions for deep-diffing plain objects in state updates.
// Used by ComponentStateManager (component state) and LiveRoomManager (room state).
//
// Both computeDeepDiff and deepAssign are safe against circular references:
// they track visited objects with a Set and skip cycles.

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype
}

/**
 * Recursively compute the diff between two plain objects.
 * Returns null if nothing changed, or an object with only the changed keys.
 * Keys present in `prev` but absent in `next` are emitted as `null` (deletion signal).
 * Arrays are compared by reference (===).
 * Safe against circular references (tracked via `seen` Set).
 *
 * @param maxDepth - Maximum recursion depth (default: 3). Beyond this, falls back to reference equality.
 */
export function computeDeepDiff(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  depth: number = 0,
  maxDepth: number = 3,
  seen?: Set<object>,
): Record<string, unknown> | null {
  if (depth > maxDepth) return prev === next ? null : next

  // Circular reference guard
  if (!seen) seen = new Set()
  if (seen.has(next)) return prev === next ? null : next
  seen.add(next)

  let result: Record<string, unknown> | null = null
  for (const key of Object.keys(next)) {
    const oldVal = prev[key]
    const newVal = next[key]

    if (oldVal === newVal) continue

    if (isPlainObject(oldVal) && isPlainObject(newVal)) {
      const nested = computeDeepDiff(oldVal, newVal, depth + 1, maxDepth, seen)
      if (nested !== null) {
        result ??= {}
        result[key] = nested
      }
    } else {
      result ??= {}
      result[key] = newVal
    }
  }

  // Detect removed keys in nested objects (depth > 0).
  // At depth 0 the caller passes a partial update (only changed fields),
  // so missing keys are not removals. Inside nested objects, the caller
  // provides the complete replacement value, so missing keys ARE removals.
  if (depth > 0) {
    for (const key of Object.keys(prev)) {
      if (!(key in next)) {
        result ??= {}
        result[key] = null
      }
    }
  }

  return result
}

/**
 * Recursively merge source into target (mutates target).
 * Plain objects are merged recursively; everything else is overwritten.
 * A `null` value in source deletes the corresponding key from target.
 * Safe against circular references (tracked via `seen` Set).
 */
export function deepAssign(target: any, source: any, seen?: Set<object>): void {
  if (!seen) seen = new Set()
  if (seen.has(source)) return
  seen.add(source)

  for (const key of Object.keys(source)) {
    if (source[key] === null) {
      delete target[key]
    } else if (isPlainObject(target[key]) && isPlainObject(source[key])) {
      deepAssign(target[key], source[key], seen)
    } else {
      target[key] = source[key]
    }
  }
}
