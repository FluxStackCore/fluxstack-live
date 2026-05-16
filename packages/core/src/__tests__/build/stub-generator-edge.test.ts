// Edge-case coverage for the stub generator (issue #33).
// The base stub-generator.test.ts file covers the headline regression; this
// suite hunts for additional ways the scan can be tricked.

import { describe, it, expect } from 'vitest'
import { _internals } from '../../build/index'

const { stripAsCasts, extractDefaultState, buildStub } = _internals

// Helper: assert the stub is valid JS that round-trips to the expected object.
function evalStub(stub: string): any {
  // buildStub emits `export class X { static foo = ... }` — wrap to evaluate.
  const src = stub.replace(/^export /gm, '')
  const fn = new Function(`${src}; return ({ defaultState: typeof X !== 'undefined' ? X.defaultState : null })`.replace(/X/g, extractClassName(stub)))
  return fn()
}
function extractClassName(stub: string): string {
  return stub.match(/class (\w+)/)?.[1] ?? 'X'
}

describe('stripAsCasts — string literal edge cases (#33)', () => {
  it('preserves a string ending in a backslash before the closing quote', () => {
    const out = stripAsCasts(`{ s: 'ends with backslash\\\\' as string }`)
    expect(out).toContain(`'ends with backslash\\\\'`)
    expect(out).not.toContain(' as string')
  })

  it('preserves a string containing both kinds of quotes', () => {
    const out = stripAsCasts(`{ s: 'has "double" inside' as string }`)
    expect(out).toContain(`'has "double" inside'`)
    expect(out).not.toContain(' as string')
  })

  it('preserves a string containing a brace', () => {
    // Braces inside strings must not trip the cast-end detector.
    const out = stripAsCasts(`{ s: 'has } inside' as string, n: 1 }`)
    expect(out).toContain(`'has } inside'`)
    expect(out).toContain('n: 1')
    expect(out).not.toContain(' as string')
  })

  it('preserves a string containing a comma', () => {
    const out = stripAsCasts(`{ s: 'a, b, c' as string, n: 1 }`)
    expect(out).toContain(`'a, b, c'`)
    expect(out).toContain('n: 1')
  })

  it('preserves a string containing a slash that could look like a comment', () => {
    const out = stripAsCasts(`{ s: 'a/b//c' as string, t: 'x/*y*/z' as string }`)
    expect(out).toContain(`'a/b//c'`)
    expect(out).toContain(`'x/*y*/z'`)
  })

  it('handles template literal with interpolation that mentions "as"', () => {
    const out = stripAsCasts('{ s: `prefix ${x as number} suffix as fallback` as string }')
    // The user-facing text inside the template stays intact:
    expect(out).toContain('suffix as fallback')
    // The outer ` as string ` cast is stripped:
    expect(out).not.toMatch(/`\s*as\s+string\b/)
  })

  it('handles nested template literals', () => {
    const out = stripAsCasts('{ s: `outer ${`inner as nested`} end` as string }')
    expect(out).toContain('inner as nested')
    expect(out).not.toMatch(/`\s*as\s+string\b/)
  })

  it('handles multi-line string via escaped newline (template)', () => {
    const out = stripAsCasts('{ s: `line1\nline2 as token\nline3` as string }')
    expect(out).toContain('line2 as token')
  })
})

describe('stripAsCasts — token-boundary edge cases (#33)', () => {
  it('does not strip "as" embedded in identifiers (class, was, has, gas)', () => {
    const out = stripAsCasts(`{ className: 'x', wasReady: true, hasUser: false, gasoline: 1 }`)
    expect(out).toContain('className')
    expect(out).toContain('wasReady')
    expect(out).toContain('hasUser')
    expect(out).toContain('gasoline')
  })

  it('strips cast when preceded by closing bracket/paren', () => {
    const out = stripAsCasts(`{ a: foo() as number, b: arr[0] as string }`)
    expect(out).not.toContain(' as number')
    expect(out).not.toContain(' as string')
    expect(out).toContain('foo()')
    expect(out).toContain('arr[0]')
  })

  it('strips chained casts (as A as B)', () => {
    // Two casts in a row — both should disappear.
    const out = stripAsCasts(`{ x: 1 as unknown as Foo, y: 2 }`)
    expect(out).not.toContain(' as ')
    expect(out).toContain('x: 1')
    expect(out).toContain('y: 2')
  })
})

describe('stripAsCasts — comment edge cases (#33)', () => {
  it('still strips casts that come after a line comment on the same source', () => {
    const out = stripAsCasts(`{
      // a comment mentioning as
      x: 1 as number,
      y: 2,
    }`)
    expect(out).toContain('// a comment mentioning as')
    expect(out).not.toContain(' as number')
    expect(out).toContain('y: 2')
  })

  it('handles a block comment immediately before a cast', () => {
    const out = stripAsCasts(`{ x: /* note */ 1 as number, y: 2 }`)
    expect(out).toContain('/* note */')
    expect(out).not.toContain(' as number')
    expect(out).toContain('y: 2')
  })

  it('does not get confused by `//` inside a string', () => {
    const out = stripAsCasts(`{ url: 'http://example.com' as string, n: 1 as number }`)
    expect(out).toContain(`'http://example.com'`)
    // The cast on n: must still be stripped — the "//" inside the URL must
    // not have switched us into line-comment mode for the rest of the input.
    expect(out).not.toMatch(/n:\s*1\s*as\s+number/)
  })
})

describe('extractDefaultState — full-object edge cases (#33)', () => {
  it('handles deeply nested object with strings containing "as"', () => {
    const body = `
      static defaultState = {
        meta: {
          tagline: 'cool as ice',
          tips: ['Use as needed', 'eat your veggies'] as string[],
        },
        ready: false as boolean,
      }
    `
    const out = extractDefaultState(body)
    expect(out).toContain(`'cool as ice'`)
    expect(out).toContain(`'Use as needed'`)
    expect(out).not.toContain(' as string')
    expect(out).not.toContain(' as boolean')
  })

  it('handles TS type annotation on defaultState itself', () => {
    const body = `
      static defaultState: Record<string, any> = {
        s: 'use as a hint',
        n: 0 as number,
      }
    `
    const out = extractDefaultState(body)
    expect(out).toContain(`'use as a hint'`)
    expect(out).not.toContain(' as number')
  })

  it('returns "{}" when defaultState is missing', () => {
    expect(extractDefaultState(`class Foo {}`)).toBe('{}')
  })
})

describe('buildStub — validity (#33)', () => {
  it('produces JS that parses for issue #33 minimal reproducer', () => {
    const stub = buildStub([{
      className: 'LiveTrophyHunt',
      componentName: 'LiveTrophyHunt',
      defaultState: `{ status: 'Procure o trofeu pelo mundo. Use as dicas!' }`,
      publicActions: `['move']`,
    }])
    // Wrap to evaluate without `export`.
    const src = stub.replace(/^export /gm, '')
    const fn = new Function(`${src}; return LiveTrophyHunt.defaultState`)
    const state = fn()
    expect(state).toEqual({ status: 'Procure o trofeu pelo mundo. Use as dicas!' })
  })

  it('produces JS that parses for a state object with arrays and nested objects', () => {
    const stub = buildStub([{
      className: 'X',
      componentName: 'X',
      defaultState: `{ items: [], meta: { tip: 'use as needed' }, ok: false }`,
      publicActions: '[]',
    }])
    const fn = new Function(`${stub.replace(/^export /gm, '')}; return X.defaultState`)
    expect(fn()).toEqual({ items: [], meta: { tip: 'use as needed' }, ok: false })
  })
})
