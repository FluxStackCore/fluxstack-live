// Regression tests for the stub generator (issue #33).
// stripAsCasts must skip string/template literals and comments so it cannot
// truncate user content like `'Use as dicas!'`.

import { describe, it, expect } from 'vitest'
import { _internals } from '../../build/index'

const { stripAsCasts, extractDefaultState, buildStub } = _internals

describe('stripAsCasts (issue #33)', () => {
  it('preserves single-quoted string containing " as "', () => {
    const out = stripAsCasts(`{ status: 'Use as dicas!' as string }`)
    expect(out).toContain(`'Use as dicas!'`)
    expect(out).not.toMatch(/'\s*as\s+string/)
  })

  it('preserves double-quoted string containing " as "', () => {
    const out = stripAsCasts(`{ status: "use as a hint" as string }`)
    expect(out).toContain(`"use as a hint"`)
    expect(out).not.toMatch(/"\s*as\s+string/)
  })

  it('preserves backtick template literal containing " as "', () => {
    const out = stripAsCasts(`{ status: \`use as a hint\` as string }`)
    expect(out).toContain('`use as a hint`')
    expect(out).not.toMatch(/`\s*as\s+string/)
  })

  it('handles escaped quotes inside strings', () => {
    const out = stripAsCasts(`{ s: 'it\\'s as good' as string }`)
    expect(out).toContain(`'it\\'s as good'`)
  })

  it('still strips genuine `as <Type>` casts on arrays and primitives', () => {
    const out = stripAsCasts(`{ items: [] as string[], ready: false as boolean }`)
    expect(out).not.toContain(' as string')
    expect(out).not.toContain(' as boolean')
    expect(out).toContain('items: []')
    expect(out).toContain('ready: false')
  })

  it('strips casts with generics', () => {
    const out = stripAsCasts(`{ map: {} as Record<string, number> }`)
    expect(out).not.toContain('Record<string, number>')
    expect(out).toContain('map: {}')
  })

  it('does not strip identifiers that merely contain "as" (e.g. "class")', () => {
    const out = stripAsCasts(`{ className: 'foo', bar: 1 }`)
    expect(out).toContain(`className: 'foo'`)
    expect(out).toContain('bar: 1')
  })

  it('skips line comments containing the word "as"', () => {
    const out = stripAsCasts(`{
      // use as a hint
      n: 1 as number,
    }`)
    expect(out).toContain('// use as a hint')
    expect(out).not.toContain(' as number')
  })

  it('skips block comments containing the word "as"', () => {
    const out = stripAsCasts(`{
      /* use as a hint */
      n: 1 as number,
    }`)
    expect(out).toContain('use as a hint')
    expect(out).not.toContain(' as number')
  })
})

describe('extractDefaultState (issue #33)', () => {
  it('preserves user strings ending in punctuation', () => {
    const body = `
      static defaultState = {
        status: 'Procure o trofeu pelo mundo. Use as dicas!' as string,
        count: 0,
      }
    `
    const out = extractDefaultState(body)
    expect(out).toContain(`'Procure o trofeu pelo mundo. Use as dicas!'`)
    expect(out).toContain('count: 0')
  })
})

describe('buildStub (issue #33)', () => {
  it('round-trips a defaultState with strings containing "as" into valid JS', () => {
    const stub = buildStub([{
      className: 'LiveTrophyHunt',
      componentName: 'LiveTrophyHunt',
      defaultState: `{ status: 'Use as dicas!', count: 0 }`,
      publicActions: '[]',
    }])
    // Sanity check: the stub must parse as valid JS.
    expect(() => new Function(stub.replace(/^export /gm, ''))).not.toThrow()
    expect(stub).toContain(`'Use as dicas!'`)
  })
})
