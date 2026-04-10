// Regression tests for issue #4 (replay attack via nonce eviction).
//
// Before the fix, when the usedNonces Map exceeded MAX_NONCES the manager
// would evict the oldest 10% of entries by insertion order. Since those
// entries could still be within nonceTTL, an attacker holding a previously
// captured SignedState could replay it after forcing the map to fill.
//
// Fix: track a high-water mark of the newest *embedded* timestamp we ever
// evicted. Any subsequent nonce whose embedded timestamp is at or before
// that mark is rejected as "predates replay-protection window".

import { describe, it, expect, beforeEach } from 'vitest'
import { StateSignatureManager } from '../../security/StateSignature'

describe('StateSignature — replay protection across nonce eviction (issue #4)', () => {
  let mgr: StateSignatureManager

  beforeEach(() => {
    mgr = new StateSignatureManager({
      secret: 'test-secret-1234567890123456',
      nonceEnabled: true,
      // Generous TTL so we never fail validation for unrelated age reasons.
      nonceTTL: 10 * 60 * 1000,
    })
  })

  /** Seed the usedNonces Map with synthetic entries whose embedded ts is
   *  comfortably in the past but still within TTL. Keyed in the real
   *  `ts:rand:mac` format so the eviction path can parse the embedded ts. */
  function seedSyntheticNonces(count: number, baseTs: number): void {
    const map = (mgr as any).usedNonces as Map<string, number>
    for (let i = 0; i < count; i++) {
      const ts = baseTs + i
      const key = `${ts}:aaaaaaaaaaaaaaaa:0000000000000000`
      map.set(key, Date.now())
    }
  }

  it('replay of an already-used nonce is blocked (baseline)', () => {
    const signed = mgr.signState('c', { a: 1 }, 1)
    expect(mgr.validateState(signed).valid).toBe(true)
    const replay = mgr.validateState(signed)
    expect(replay.valid).toBe(false)
    expect(replay.error).toMatch(/already used/i)
  })

  it('replay is blocked even after the nonce is manually cleared from the map', () => {
    // Simulates the post-eviction scenario the bug exploited: the attacker's
    // nonce is gone from usedNonces but still cryptographically valid and
    // within TTL. With the fix, the high-water mark should reject it.
    const signed = mgr.signState('c', { a: 1 }, 1)
    expect(mgr.validateState(signed).valid).toBe(true)

    // Force the manager into "just evicted through this ts" state.
    const attackerTs = Number(signed.nonce!.split(':')[0])
    ;(mgr as any).usedNonces.clear()
    ;(mgr as any).evictionHighWaterMark = attackerTs

    const replay = mgr.validateState(signed)
    expect(replay.valid).toBe(false)
    expect(replay.error).toMatch(/predates replay-protection window/)
  })

  it('evictOldNoncesIfNeeded advances the high-water mark to the newest evicted embedded ts', () => {
    const baseTs = Date.now() - 60_000
    // Seed just over the cap so eviction has to remove ~10% (= 10_000 entries).
    const MAX = (StateSignatureManager as any).MAX_NONCES as number
    seedSyntheticNonces(MAX + 1, baseTs)

    // Trigger eviction via the private method (what validateState does too).
    ;(mgr as any).evictOldNoncesIfNeeded()

    const mark = (mgr as any).evictionHighWaterMark as number
    // Eviction removes 10% by insertion order, so the newest evicted ts is
    // (baseTs + floor((MAX + 1) * 0.1) - 1).
    const expectedEvicted = Math.floor((MAX + 1) * 0.1)
    expect(mark).toBe(baseTs + expectedEvicted - 1)
  })

  it('a fresh nonce signed after an eviction still validates (no false positives)', () => {
    // Seed with ancient entries, evict, then sign a new state and check it.
    const ancientBase = Date.now() - 5 * 60_000
    const MAX = (StateSignatureManager as any).MAX_NONCES as number
    seedSyntheticNonces(MAX + 1, ancientBase)
    ;(mgr as any).evictOldNoncesIfNeeded()

    const mark = (mgr as any).evictionHighWaterMark as number
    expect(mark).toBeGreaterThan(0)
    expect(mark).toBeLessThan(Date.now()) // well in the past

    // New sign uses Date.now() which is > mark → must validate.
    const fresh = mgr.signState('c', { hello: 'world' }, 1)
    const result = mgr.validateState(fresh)
    expect(result.valid).toBe(true)
  })

  it('a captured nonce from before the eviction window is rejected, but fresh nonces still work', async () => {
    // Realistic end-to-end: attacker captured a nonce in the past, server's
    // nonce map later fills up and evicts a window that covers that nonce,
    // then the attacker replays. The captured nonce must be rejected by the
    // high-water mark, while fresh nonces signed *after* the eviction still
    // validate normally.
    //
    // The eviction window is driven by the oldest nonces in the map, so we
    // seed them in the comfortable past. The captured nonce must lie inside
    // that window. We also wait a millisecond before signing the fresh nonce
    // so that Date.now() advances past the high-water mark.

    const MAX = (StateSignatureManager as any).MAX_NONCES as number
    const pastBase = Date.now() - 60_000 // 60s ago

    // Craft a "captured" nonce whose embedded ts falls inside the eviction
    // window. We sign it by mutating an already-valid nonce's timestamp and
    // recomputing the outer signature via signState — but the simplest way
    // is to sign fresh and manually rewrite the nonce+signature.
    const raw = mgr.signState('c', { a: 1 }, 1)
    // Replace the nonce timestamp so it looks like it was minted in the past.
    // We need to regenerate the HMAC with the manager's secret. The secret
    // is private, but we can piggyback on generateNonce via reflection.
    const fakePastTs = pastBase + 2 // inside the eviction window
    const fakeNonce = ((mgr as any).generateNonceAt
      ? (mgr as any).generateNonceAt(fakePastTs)
      : null)
    // Fall back: sign a brand-new state but with the nonce monkey-patched.
    // Since the outer signature binds the nonce, we can't just swap it. So
    // instead, we seed the eviction window at a time that *contains* the
    // raw nonce's real ts.
    void fakeNonce

    const capturedTs = Number(raw.nonce!.split(':')[0])

    // Clear the map, then seed 10% below capturedTs and 90% above, so
    // capturedTs sits inside the eviction window (oldest 10%).
    ;(mgr as any).usedNonces.clear()
    // Base is capturedTs - toRemove, so the window [base .. base+toRemove-1]
    // straddles capturedTs as its last entry (= capturedTs - 1). Bump by 2
    // extra so the window clearly includes capturedTs itself.
    const toRemove = Math.floor((MAX + 1) * 0.1)
    const seedBase = capturedTs - toRemove + 2
    seedSyntheticNonces(MAX + 1, seedBase)
    ;(mgr as any).evictOldNoncesIfNeeded()

    const mark = (mgr as any).evictionHighWaterMark as number
    expect(mark).toBeGreaterThanOrEqual(capturedTs)

    // Attacker replay: the captured nonce's embedded ts is at or below the mark.
    const replay = mgr.validateState(raw)
    expect(replay.valid).toBe(false)
    expect(replay.error).toMatch(/predates replay-protection window/)

    // Wait until Date.now() advances past the high-water mark so a freshly
    // signed nonce is strictly newer. The mark is ≈ capturedTs which is ≈
    // Date.now() at the time of sign; 5ms is enough to step past it.
    await new Promise((r) => setTimeout(r, 5))

    const fresh = mgr.signState('c', { b: 2 }, 1)
    const freshTs = Number(fresh.nonce!.split(':')[0])
    expect(freshTs).toBeGreaterThan(mark)
    expect(mgr.validateState(fresh).valid).toBe(true)
  })
})
