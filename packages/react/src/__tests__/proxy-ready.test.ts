// Tests that pin $ready into the proxy contract (#35).
//
// We can't render the hook here — the package has no DOM/react-dom test
// infra — but we can still lock down three guarantees:
//
//   1. $ready appears in the RESERVED_PROPS set (otherwise it would be
//      interpreted as a server action and any access would fire a CALL_ACTION).
//   2. The hook source maps $ready to `getStatus() === 'synced'` — and not
//      something like `connected`, which would re-introduce the #35 bug.
//   3. $ready appears in the ownKeys list returned by the proxy.
//
// These are structural assertions over the implementation file. They protect
// against silent regressions where someone removes the case from the switch,
// or rewires it incorrectly, without spinning up React.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { _RESERVED_PROPS } from '../hooks/useLiveComponent'

const HOOK_SRC = readFileSync(
  join(__dirname, '..', 'hooks', 'useLiveComponent.ts'),
  'utf-8',
)

describe('$ready proxy contract (#35)', () => {
  it('is registered as a reserved prop', () => {
    expect(_RESERVED_PROPS.has('$ready')).toBe(true)
  })

  it('is mapped to status === "synced" inside the proxy get handler', () => {
    // Look for `case '$ready': return ... 'synced'` — the exact mapping that
    // makes $ready the correct action gate. If someone rewires this to
    // `connected`, the #35 bug returns and this test fails.
    const m = HOOK_SRC.match(/case\s+['"]\$ready['"]\s*:\s*return\s+([^\n]+)/)
    expect(m, 'proxy switch must have a case for $ready').not.toBeNull()
    const expr = m![1]!
    expect(expr).toContain("'synced'")
    expect(expr).toContain('getStatus()')
  })

  it('appears in the ownKeys list so it is enumerable', () => {
    // The ownKeys() array literal must include $ready.
    const ownKeysBlock = HOOK_SRC.match(/ownKeys\(\)\s*\{\s*return\s*\[([\s\S]*?)\]/)
    expect(ownKeysBlock, 'ownKeys block not found').not.toBeNull()
    expect(ownKeysBlock![1]).toContain("'$ready'")
  })

  it('is documented on the LiveComponentProxy interface', () => {
    // The TS interface that documents the public proxy surface must declare
    // `readonly $ready: boolean`. Without this, TS apps don't see the prop.
    expect(HOOK_SRC).toMatch(/readonly\s+\$ready\s*:\s*boolean/)
  })

  it('docstring on $ready mentions $status === "synced" so devs know the relation', () => {
    // Pin the documentation that distinguishes $ready from $connected — this
    // is the educational fix for the #35 confusion.
    const idx = HOOK_SRC.indexOf('readonly $ready')
    expect(idx).toBeGreaterThan(0)
    const preceding = HOOK_SRC.slice(Math.max(0, idx - 1200), idx)
    expect(preceding).toContain('synced')
  })
})

describe('$ready ↔ readiness helper consistency (#35)', () => {
  // The hook computes $ready via `getStatus() === 'synced'`. The standalone
  // helper `isReady()` must agree, so any test of one is meaningful for the
  // other. This is a sanity check that the helper exports exist.
  it('exports computeStatus and isReady', async () => {
    const mod = await import('../hooks/readiness')
    expect(typeof mod.computeStatus).toBe('function')
    expect(typeof mod.isReady).toBe('function')
  })

  it('isReady agrees with the "synced" branch of computeStatus', async () => {
    const { computeStatus, isReady } = await import('../hooks/readiness')
    const inputs = { connected: true, rehydrating: false, loading: false, error: null, componentId: 'c-1' }
    expect(computeStatus(inputs)).toBe('synced')
    expect(isReady(inputs)).toBe(true)
  })

  it('isReady is false in every non-synced status', async () => {
    const { isReady } = await import('../hooks/readiness')
    const cases = [
      { connected: false, rehydrating: false, loading: false, error: null, componentId: 'c-1' },
      { connected: true, rehydrating: true, loading: false, error: null, componentId: 'c-1' },
      { connected: true, rehydrating: false, loading: true, error: null, componentId: 'c-1' },
      { connected: true, rehydrating: false, loading: false, error: 'x', componentId: 'c-1' },
      { connected: true, rehydrating: false, loading: false, error: null, componentId: null },
    ]
    for (const c of cases) expect(isReady(c)).toBe(false)
  })
})
