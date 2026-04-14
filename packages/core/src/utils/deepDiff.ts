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
 *
 * Semantics (fixes #6):
 * - Arrays are compared by reference (===). A new array reference produces
 *   a full replacement in the delta.
 * - `undefined` values in `next` are skipped entirely. They would desync
 *   server↔wire (JSON strips undefined) so we never include them in the
 *   delta. Callers wanting to "clear" a field should pass `null` if the
 *   type allows it, or use a typed sentinel.
 * - `null` is treated as a regular value in top-level (depth === 0): if the
 *   old value was non-null, the delta carries `{ key: null }` and the
 *   server/client apply it as a real null via `deepAssign`.
 * - At nested depths (depth > 0), keys present in `prev` but absent in
 *   `next` are emitted as `null` — this is the deletion sentinel the
 *   `Record<string, T>` scenario from issue #1/#3 relies on.
 *
 * Safe against circular references (tracked via `seen` Set).
 *
 * @param maxDepth - Maximum recursion depth (default: 3). Beyond this, falls back to reference equality.
 */
export function computeDeepDiff(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  depth: number = 0,
  maxDepth: number = 100,
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

    // Skip undefined entirely — it would be stripped by JSON.stringify
    // on the wire, creating server↔client drift.
    if (newVal === undefined) continue

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
  //
  // IMPORTANT: Callers using setState with nested objects MUST pass
  // complete objects (all fields), not partial updates. If only some
  // fields are included, the missing fields will be treated as removals.
  // Use the spread operator: setState({ players: { p1: { ...player, position: newPos } } })
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
 *
 * Semantics (fixes #6):
 * - At the TOP LEVEL (depth === 0), `null` is a real value: `target[key]`
 *   is set to `null`. Top-level state keys come from the component's
 *   `defaultState` schema — they are not dynamically added/removed by the
 *   user, so there is no ambiguity with a "delete" signal here. This is
 *   what lets `Nullable<T>` state fields work in `setState({ x: null })`.
 * - At NESTED levels (depth > 0), `null` is the deletion sentinel emitted
 *   by `computeDeepDiff` when a key is removed from a `Record<string, T>`
 *   map: `delete target[key]`. This is what issue #1/#3 needed.
 * - Plain objects are merged recursively; everything else is overwritten.
 * - `undefined` is a no-op (skipped) to avoid server↔wire drift: JSON
 *   serialization strips `undefined`, so accepting it on the server would
 *   leave the two sides out of sync.
 *
 * Ownership (fixes #13):
 * - Plain objects assigned into `target` are deep-cloned via `structuredClone`
 *   instead of being aliased in by reference. This preserves the invariant
 *   that `computeDeepDiff` relies on: the "previous" state held by the
 *   framework is owned exclusively by the framework and cannot be mutated
 *   from outside. Without this, mirroring shared data (e.g. `LiveRoom.state`)
 *   into a component via `setState({ x: room.state.x })` would cause the
 *   next diff to short-circuit on `oldVal === newVal` and silently drop
 *   legitimate updates.
 *
 * Safe against circular references (tracked via `seen` Set).
 */
export function deepAssign(target: any, source: any, seen?: Set<object>): void {
  // The public API accepts Set<object> for backward compatibility,
  // but internally we use Map<object, Set<object>> for proper pair tracking.
  deepAssignImpl(target, source, 0)
}

function deepAssignImpl(target: any, source: any, depth: number, seen?: Map<object, Set<object>>): void {
  if (source == null || typeof source !== 'object') return
  // Circular reference guard: track which (source → target) pairs we've
  // already processed. This prevents infinite recursion from circular refs
  // while still allowing the same source object to be applied to different
  // targets (e.g., multiple players sharing the same item reference in a diff).
  if (!seen) seen = new Map()
  let targets = seen.get(source)
  if (targets?.has(target)) return // already applied this source to this target
  if (!targets) { targets = new Set(); seen.set(source, targets) }
  targets.add(target)

  for (const key of Object.keys(source)) {
    const value = source[key]
    if (value === undefined) {
      // No-op: JSON.stringify would strip this, so accepting it on the
      // server would silently desync from the client.
      continue
    }
    if (value === null) {
      if (depth === 0) {
        // Top-level: set the key to null (real value).
        target[key] = null
      } else {
        // Nested: deletion sentinel from computeDeepDiff — remove the key.
        delete target[key]
      }
      continue
    }
    if (isPlainObject(target[key]) && isPlainObject(value)) {
      deepAssignImpl(target[key], value, depth + 1, seen)
    } else if (isPlainObject(value)) {
      // The source holds a plain object that the caller may still mutate
      // (e.g. a slice of LiveRoom state mirrored into a component). Store
      // a structural clone so the framework owns its copy. This is what
      // fixes issue #13: subsequent diffs will not be fooled by external
      // in-place mutations of the original object.
      target[key] = structuredClone(value)
    } else {
      // Primitives, arrays, and other non-plain values: keep the existing
      // reference-assign behaviour. Arrays are intentionally compared by
      // reference everywhere in this module (see computeDeepDiff docs).
      target[key] = value
    }
  }
}
