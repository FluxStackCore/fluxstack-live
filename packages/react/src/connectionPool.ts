// Module-level WebSocket connection pool, shared by all LiveComponentsProvider
// instances. Solves issue #34: React StrictMode mounts effects twice in dev
// (mount → cleanup → mount), and the original Provider created two distinct
// LiveConnection instances — both initiated a WS handshake before the first
// one could be torn down, leaving the server with two simultaneous sockets
// per tab.
//
// Design:
//   1. Connections are pooled by a stable key (URL + serialized auth options).
//   2. Each acquire() bumps a refcount; release() decrements it.
//   3. When the refcount drops to zero we DON'T disconnect immediately —
//      a short grace window (default 50 ms) keeps the socket alive so the
//      StrictMode remount can reuse it. If no one re-acquires within the
//      window, the connection is closed and removed from the pool.
//   4. Concurrent acquires for the same key always get the same instance.
//
// This module is intentionally framework-agnostic: it does not import React
// and has no UI side effects, which makes it trivial to test.

import type { LiveConnection, LiveConnectionOptions } from '@fluxstack/live-client'

interface PoolEntry {
  conn: LiveConnection
  refcount: number
  releaseTimer: ReturnType<typeof setTimeout> | null
}

const pool = new Map<string, PoolEntry>()

/** Grace window before a zero-refcount entry is actually disposed (ms). */
const DEFAULT_GRACE_MS = 50

/**
 * Build a pool key from connection options.
 *
 * URL is the primary discriminator. We also include a hash of auth so two
 * Providers with different credentials get separate sockets.
 */
export function poolKey(options: Pick<LiveConnectionOptions, 'url' | 'auth'>): string {
  const url = options.url ?? '<default>'
  // Stable, cheap hash — JSON.stringify is fine: auth objects are small and
  // the order of keys is consistent within a single Provider's options.
  let authStr = ''
  try { authStr = JSON.stringify(options.auth ?? null) } catch { authStr = '<unserializable>' }
  return `${url}|${authStr}`
}

/**
 * Acquire (or create) a pooled LiveConnection for the given options.
 *
 * @param factory - Called only when no live entry exists for `key`. Must
 *   return a brand new `LiveConnection`. The factory is what binds the
 *   connection to the specific LiveConnection class — keeping this module
 *   free of a direct dependency on @fluxstack/live-client (which is a
 *   dynamic import in the Provider for SSR-safety).
 */
export function acquire(
  key: string,
  factory: () => LiveConnection,
): LiveConnection {
  let entry = pool.get(key)
  if (entry) {
    // Cancel any pending disposal: someone is re-acquiring before the grace
    // window elapsed (this is the StrictMode remount path).
    if (entry.releaseTimer) {
      clearTimeout(entry.releaseTimer)
      entry.releaseTimer = null
    }
    entry.refcount++
    return entry.conn
  }
  entry = { conn: factory(), refcount: 1, releaseTimer: null }
  pool.set(key, entry)
  return entry.conn
}

/**
 * Release a previously-acquired connection. When the refcount reaches zero
 * the connection is disposed after a short grace period — enough to let a
 * StrictMode remount happen synchronously without tearing down the socket.
 *
 * Returns a function that cancels the pending release (useful when the
 * caller knows it will re-acquire imminently). The function is idempotent.
 */
export function release(key: string, graceMs = DEFAULT_GRACE_MS): () => void {
  const entry = pool.get(key)
  if (!entry) return () => {}
  entry.refcount = Math.max(0, entry.refcount - 1)
  if (entry.refcount > 0) return () => {}

  // Schedule disposal. If someone acquires the same key before this fires,
  // acquire() will cancel the timer.
  entry.releaseTimer = setTimeout(() => {
    const cur = pool.get(key)
    if (!cur || cur.refcount > 0) return
    try { cur.conn.disconnect() } catch { /* ignore */ }
    pool.delete(key)
  }, graceMs)

  const timer = entry.releaseTimer
  return () => {
    if (entry.releaseTimer === timer) {
      clearTimeout(timer)
      entry.releaseTimer = null
    }
  }
}

/** @internal Test helper: drop all pooled entries without grace. */
export function _resetPool(): void {
  for (const entry of pool.values()) {
    if (entry.releaseTimer) clearTimeout(entry.releaseTimer)
    try { entry.conn.disconnect() } catch { /* ignore */ }
  }
  pool.clear()
}

/** @internal Test helper: inspect pool size. */
export function _poolSize(): number { return pool.size }

/** @internal Test helper: inspect refcount for a key. */
export function _refcount(key: string): number { return pool.get(key)?.refcount ?? 0 }
