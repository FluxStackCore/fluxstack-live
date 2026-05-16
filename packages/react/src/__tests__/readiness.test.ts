// Tests for the readiness helpers used by useLiveComponent (#35).

import { describe, it, expect } from 'vitest'
import { computeStatus, isReady, notReadyError } from '../hooks/readiness'

const base = {
  connected: false,
  rehydrating: false,
  loading: false,
  error: null as string | null,
  componentId: null as string | null,
}

describe('computeStatus (#35)', () => {
  it('reports "connecting" when the WS is down', () => {
    expect(computeStatus({ ...base, connected: false })).toBe('connecting')
  })

  it('reports "reconnecting" when rehydrating', () => {
    expect(computeStatus({ ...base, connected: true, rehydrating: true })).toBe('reconnecting')
  })

  it('reports "loading" when the component is loading', () => {
    expect(computeStatus({ ...base, connected: true, loading: true })).toBe('loading')
  })

  it('reports "error" when an error string is set', () => {
    expect(computeStatus({ ...base, connected: true, error: 'oops' })).toBe('error')
  })

  it('reports "mounting" when connected but no componentId yet (the #35 window)', () => {
    expect(computeStatus({ ...base, connected: true, componentId: null })).toBe('mounting')
  })

  it('reports "synced" only when connected AND mounted AND idle', () => {
    expect(computeStatus({ ...base, connected: true, componentId: 'c-1' })).toBe('synced')
  })

  it('error precedence: rehydrating beats loading', () => {
    expect(computeStatus({ ...base, connected: true, rehydrating: true, loading: true })).toBe('reconnecting')
  })

  it('error precedence: loading beats error (loading is an in-flight state)', () => {
    expect(computeStatus({ ...base, connected: true, loading: true, error: 'x' })).toBe('loading')
  })

  it('error precedence: disconnected beats everything', () => {
    expect(computeStatus({ ...base, connected: false, rehydrating: true, loading: true, error: 'x', componentId: 'c-1' })).toBe('connecting')
  })
})

describe('isReady (#35)', () => {
  it('is true only on synced', () => {
    expect(isReady({ ...base, connected: true, componentId: 'c-1' })).toBe(true)
  })

  it('is false during the #35 "WS connected but not mounted" window', () => {
    expect(isReady({ ...base, connected: true, componentId: null })).toBe(false)
  })

  it('is false while loading', () => {
    expect(isReady({ ...base, connected: true, componentId: 'c-1', loading: true })).toBe(false)
  })

  it('is false while disconnected even with a stale componentId', () => {
    expect(isReady({ ...base, connected: false, componentId: 'c-1' })).toBe(false)
  })
})

describe('notReadyError (#35)', () => {
  it('mentions the action and a status when WS is down', () => {
    const err = notReadyError('move', 'TrophyHunt', { ...base, connected: false })
    expect(err.message).toContain(`'move'`)
    expect(err.message).toContain('WebSocket')
    expect(err.message).toContain('status=connecting')
  })

  it('mentions the component name and "not mounted" when WS up but no id', () => {
    const err = notReadyError('move', 'TrophyHunt', { ...base, connected: true, componentId: null })
    expect(err.message).toContain(`'TrophyHunt'`)
    expect(err.message).toContain('not mounted')
    expect(err.message).toContain('status=mounting')
  })

  it('directs the developer to wait on $ready', () => {
    const err = notReadyError('whatever', 'C', { ...base, connected: true, componentId: null })
    expect(err.message).toContain('$ready')
  })

  it('returns an Error instance', () => {
    const err = notReadyError('a', 'C', { ...base })
    expect(err).toBeInstanceOf(Error)
  })

  it('uses different wording for WS-down vs not-mounted (covers the #35 confusion)', () => {
    const down = notReadyError('a', 'C', { ...base, connected: false })
    const notMounted = notReadyError('a', 'C', { ...base, connected: true, componentId: null })
    expect(down.message).not.toBe(notMounted.message)
    expect(down.message).toContain('WebSocket')
    expect(notMounted.message).toContain('not mounted')
  })
})
