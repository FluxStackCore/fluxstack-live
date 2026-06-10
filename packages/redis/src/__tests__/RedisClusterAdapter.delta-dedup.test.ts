// Cluster delta dedup + ordering (spec 05 FP-2). Redis pub/sub can redeliver on
// reconnect and the network can reorder — a stale/duplicate delta must not be
// relayed to local clients (it would clobber newer state). publishDelta stamps a
// monotonic per-component seq; handleDelta drops seq <= last seen.
//
// These tests use a tiny in-memory Redis stub (no Docker needed) and drive the
// adapter's internal publish/handle directly.
import { describe, it, expect, beforeEach } from 'vitest'
import { RedisClusterAdapter } from '../RedisClusterAdapter'

/** Minimal ioredis stub: just enough for the adapter constructor + publish. */
function fakeRedis(): any {
  return {
    duplicate() { return fakeRedis() },
    on() { return this },
    publish() { return Promise.resolve(1) },
    set() { return Promise.resolve('OK') },
    get() { return Promise.resolve(null) },
    del() { return Promise.resolve(1) },
    quit() { return Promise.resolve('OK') },
  }
}

function makeAdapter() {
  return new RedisClusterAdapter({ redis: fakeRedis() }) as any
}

/** Capture published messages by spying on redis.publish. */
function withCapturedPublish(adapter: any): any[] {
  const sent: any[] = []
  adapter.redis.publish = (_ch: string, raw: string) => { sent.push(JSON.parse(raw)); return Promise.resolve(1) }
  return sent
}

describe('RedisClusterAdapter — delta dedup + ordering', () => {
  let a: any
  beforeEach(() => { a = makeAdapter() })

  it('publishDelta stamps a monotonic per-component seq', async () => {
    const sent = withCapturedPublish(a)
    await a.publishDelta('c1', 'Counter', { x: 1 })
    await a.publishDelta('c1', 'Counter', { x: 2 })
    await a.publishDelta('c2', 'Other', { y: 1 })
    expect(sent.map(m => m.seq)).toEqual([1, 2, 1]) // per-component counters
  })

  it('relays a fresh delta exactly once', () => {
    const seen: any[] = []
    a.onDelta((id: string, _n: string, delta: any) => seen.push({ id, delta }))
    a.handleDelta({ type: 'delta', origin: 'other', componentId: 'c1', componentName: 'Counter', delta: { x: 1 }, seq: 1 })
    expect(seen).toHaveLength(1)
  })

  it('drops a duplicate (same seq redelivered)', () => {
    const seen: any[] = []
    a.onDelta(() => seen.push(1))
    const msg = { type: 'delta', origin: 'other', componentId: 'c1', componentName: 'Counter', delta: {}, seq: 5 }
    a.handleDelta(msg)
    a.handleDelta(msg) // redelivery
    expect(seen).toHaveLength(1)
  })

  it('drops an out-of-order (older) delta', () => {
    const seen: number[] = []
    a.onDelta((_id: string, _n: string, d: any) => seen.push(d.v))
    a.handleDelta({ type: 'delta', origin: 'o', componentId: 'c1', componentName: 'C', delta: { v: 2 }, seq: 2 })
    a.handleDelta({ type: 'delta', origin: 'o', componentId: 'c1', componentName: 'C', delta: { v: 1 }, seq: 1 }) // late
    expect(seen).toEqual([2]) // the stale seq=1 is dropped
  })

  it('tracks seq independently per origin and per component', () => {
    const seen: string[] = []
    a.onDelta((id: string, _n: string, d: any) => seen.push(`${id}:${d.v}`))
    // same seq=1 from two different origins → both delivered
    a.handleDelta({ type: 'delta', origin: 'A', componentId: 'c1', componentName: 'C', delta: { v: 1 }, seq: 1 })
    a.handleDelta({ type: 'delta', origin: 'B', componentId: 'c1', componentName: 'C', delta: { v: 1 }, seq: 1 })
    // different component, seq=1 → delivered
    a.handleDelta({ type: 'delta', origin: 'A', componentId: 'c2', componentName: 'C', delta: { v: 9 }, seq: 1 })
    expect(seen).toEqual(['c1:1', 'c1:1', 'c2:9'])
  })

  it('always delivers messages without a seq (back-compat with old publishers)', () => {
    const seen: any[] = []
    a.onDelta(() => seen.push(1))
    a.handleDelta({ type: 'delta', origin: 'o', componentId: 'c1', componentName: 'C', delta: {} })
    a.handleDelta({ type: 'delta', origin: 'o', componentId: 'c1', componentName: 'C', delta: {} })
    expect(seen).toHaveLength(2)
  })
})
