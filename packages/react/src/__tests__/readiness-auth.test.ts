// Auth × $ready interaction (#35). The hook keeps auth state separate from
// the lifecycle status — these tests pin down the expected behaviour so
// future refactors don't silently re-couple them.

import { describe, it, expect } from 'vitest'
import { computeStatus, isReady, notReadyError } from '../hooks/readiness'

const base = {
  connected: false,
  rehydrating: false,
  loading: false,
  error: null as string | null,
  componentId: null as string | null,
}

describe('readiness × auth (#35)', () => {
  it('AUTH_DENIED from server mount sets error → $ready=false, status=error', () => {
    // The hook's mount() path catches AUTH_DENIED, calls setError, and bails
    // before setting componentId. From computeStatus' perspective this is
    // indistinguishable from any other mount failure — and that's correct.
    const s = { ...base, connected: true, error: 'AUTH_DENIED: roles=admin required' }
    expect(computeStatus(s)).toBe('error')
    expect(isReady(s)).toBe(false)
  })

  it('after authenticate() succeeds, the hook retries mount; $ready stays false during retry', () => {
    // Phase 1: post-AUTH_DENIED, before retry kicks in.
    const denied = { ...base, connected: true, error: 'AUTH_DENIED' }
    expect(isReady(denied)).toBe(false)

    // Phase 2: hook clears error, sets loading=true, sends a new COMPONENT_MOUNT.
    const retrying = { ...base, connected: true, loading: true, error: null }
    expect(computeStatus(retrying)).toBe('loading')
    expect(isReady(retrying)).toBe(false)

    // Phase 3: mount succeeds — componentId arrives, all flags clear.
    const synced = { ...base, connected: true, componentId: 'c-1' }
    expect(isReady(synced)).toBe(true)
  })

  it('anonymous user on a public component reaches $ready normally', () => {
    // Public components (no `static auth = { required: true }`) don't depend
    // on $authenticated to mount. The hook should treat them like any other.
    const s = { ...base, connected: true, componentId: 'c-1' }
    expect(isReady(s)).toBe(true)
  })

  it('notReadyError for an action called after AUTH_DENIED says "not mounted", not "not connected"', () => {
    // WS is up but mount failed → error message must point at the component,
    // not the websocket, so the developer hunts in the right place.
    const err = notReadyError('deleteUser', 'AdminPanel', {
      ...base,
      connected: true,
      error: 'AUTH_DENIED',
    })
    expect(err.message).toContain('not mounted')
    expect(err.message).not.toContain('WebSocket is not connected')
    expect(err.message).toContain('AdminPanel')
  })

  it('disconnect during an authenticated session → status flips to connecting, ready=false', () => {
    // User was happily synced; WS dropped (e.g. server restart).
    // Even though the auth context is still cached, $ready must be false.
    const wasSynced = { ...base, connected: true, componentId: 'c-1' }
    expect(isReady(wasSynced)).toBe(true)

    const dropped = { ...wasSynced, connected: false }
    expect(computeStatus(dropped)).toBe('connecting')
    expect(isReady(dropped)).toBe(false)
  })

  it('reconnect with rehydration: rehydrating beats componentId — $ready stays false until done', () => {
    // After reconnect, the hook may try to restore the prior componentId by
    // re-mounting on the new socket. While rehydration is in progress, even
    // though componentId is still set from before, $ready must be false.
    const rehyd = { ...base, connected: true, rehydrating: true, componentId: 'c-1' }
    expect(computeStatus(rehyd)).toBe('reconnecting')
    expect(isReady(rehyd)).toBe(false)
  })

  it('partial denial path: WS auth fails but mount is public-friendly', () => {
    // Imagine: server-level auth rejected the token (so $authenticated=false)
    // but the component itself is public. The hook ignores auth status and
    // still mounts; $ready=true once componentId arrives.
    const s = { ...base, connected: true, componentId: 'c-pub' }
    expect(isReady(s)).toBe(true)
  })
})
