// Regression guard for issue #49: the action proxy forwards a SINGLE payload
// object. Calling an action with extra positional args silently drops them.
// We warn loudly in dev. The react package has no DOM test infra, so (matching
// proxy-ready.test.ts) we assert the guard structurally over the source.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const HOOK_SRC = readFileSync(
  join(__dirname, '..', 'hooks', 'useLiveComponent.ts'),
  'utf-8',
)

describe('action positional-args footgun guard (#49)', () => {
  it('the action proxy collects args with a rest param (so length is observable)', () => {
    // The returned action function must use `...args` to even see arg count.
    expect(HOOK_SRC).toMatch(/return async \(\.\.\.args:\s*any\[\]\)\s*=>/)
  })

  it('warns in dev when called with more than one positional argument', () => {
    // A dev-only guard: NODE_ENV check + args.length > 1 + console.warn.
    expect(HOOK_SRC).toContain('args.length > 1')
    expect(HOOK_SRC).toMatch(/process\.env\.NODE_ENV !== 'production'/)
    // The warning mentions the action name and that only one payload is forwarded.
    const warnIdx = HOOK_SRC.indexOf('positional')
    expect(warnIdx).toBeGreaterThan(-1)
  })

  it('still forwards exactly the first arg as the payload', () => {
    // payload must be args[0] — not the whole args array.
    expect(HOOK_SRC).toMatch(/const payload = args\[0\]/)
  })
})
