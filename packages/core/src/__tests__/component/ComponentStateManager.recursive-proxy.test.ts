// Recursive state proxy (opt-in via $options.recursiveProxy). By default the
// state proxy is shallow: `state.nested.x = y` mutates but emits no delta
// (spec 01 FP-1). With recursiveProxy:true, nested mutations are detected and
// synced, while reference identity is preserved.
import { describe, it, expect, vi } from 'vitest'
import { ComponentStateManager } from '../../component/managers/ComponentStateManager'

function makeManager(initial: any, recursiveProxy: boolean) {
  const deltas: any[] = []
  const mgr = new ComponentStateManager<any>({
    componentId: 'c1',
    initialState: initial,
    ws: {} as any,
    emitFn: (type: string, payload: any) => { if (type === 'STATE_DELTA') deltas.push(payload.delta) },
    onStateChangeFn: () => {},
    deepDiff: true,
    recursiveProxy,
  })
  return { state: mgr.proxyState as any, deltas, mgr }
}

describe('ComponentStateManager — recursive proxy (opt-in)', () => {
  it('DEFAULT (shallow): nested mutation emits NO delta', () => {
    const { state, deltas } = makeManager({ nested: { x: 1 } }, false)
    state.nested.x = 2
    expect(deltas).toHaveLength(0) // documents the shallow footgun
  })

  it('recursiveProxy: nested mutation emits a delta', () => {
    const { state, deltas } = makeManager({ nested: { x: 1 } }, true)
    state.nested.x = 2
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toEqual({ nested: { x: 2 } })
    expect(state.nested.x).toBe(2) // value is actually applied
  })

  it('recursiveProxy: deep (2+ levels) mutation emits a delta', () => {
    const { state, deltas } = makeManager({ a: { b: { c: 1 } } }, true)
    state.a.b.c = 9
    expect(deltas[0]).toEqual({ a: { b: { c: 9 } } })
  })

  it('recursiveProxy: array element mutation emits a delta', () => {
    const { state, deltas } = makeManager({ list: [{ v: 1 }] }, true)
    state.list[0].v = 5
    expect(deltas.length).toBeGreaterThan(0)
    expect(state.list[0].v).toBe(5)
  })

  it('recursiveProxy: deleting a nested key emits a delta', () => {
    const { state, deltas } = makeManager({ obj: { a: 1, b: 2 } }, true)
    delete state.obj.a
    expect(deltas.length).toBeGreaterThan(0)
    expect(state.obj).toEqual({ b: 2 })
  })

  it('recursiveProxy: preserves reference identity (state.x === state.x)', () => {
    const { state } = makeManager({ nested: { x: 1 } }, true)
    expect(state.nested).toBe(state.nested)
  })

  it('recursiveProxy: setting the same value emits no delta', () => {
    const { state, deltas } = makeManager({ nested: { x: 1 } }, true)
    state.nested.x = 1
    expect(deltas).toHaveLength(0)
  })

  it('top-level mutation still works with recursiveProxy on', () => {
    const { state, deltas } = makeManager({ count: 0, nested: { x: 1 } }, true)
    state.count = 5
    expect(deltas[0]).toEqual({ count: 5 })
  })
})
