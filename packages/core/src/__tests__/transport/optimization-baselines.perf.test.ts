// Baseline benchmarks for the remaining optimization candidates.
// Captures cost BEFORE we touch the code so the PR diff is honest.

import { describe, it } from 'vitest'
import { BinaryStateCodec } from '../../protocol/BinaryStateCodec'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { RoomEventBus } from '../../rooms/RoomEventBus'

function makeWs() {
  return {
    readyState: 1,
    data: { connectionId: 'x', components: new Map(), subscriptions: new Set() },
    send() {},
  } as any
}

function bench(label: string, runs: number, fn: () => void) {
  // Warm
  for (let i = 0; i < 3; i++) fn()
  const t0 = performance.now()
  for (let i = 0; i < runs; i++) fn()
  const elapsed = performance.now() - t0
  console.log(`  ${label.padEnd(60)} ${(elapsed / runs * 1000).toFixed(2)}µs/op`)
}

describe('Optimization baselines', () => {
  it('measures broadcastToRoom (legacy JSON path, per-member splice)', async () => {
    console.log('\n────────────────────────────────────────────────')
    console.log('  broadcastToRoom — JSON path (no codec)')
    console.log('────────────────────────────────────────────────')

    for (const memberCount of [10, 100, 500, 1000]) {
      const mgr = new LiveRoomManager(new RoomEventBus())
      // Join N members to a legacy room (no LiveRoom class → JSON codec)
      for (let i = 0; i < memberCount; i++) {
        await mgr.joinRoom(`c-${i}`, 'legacy:r', makeWs(), { x: 0 } as any)
      }
      bench(`broadcastToRoom × ${memberCount} members`, 200, () => {
        ;(mgr as any).broadcastToRoom('legacy:r', {
          type: 'ROOM_EVENT',
          componentId: 'system',
          roomId: 'legacy:r',
          event: 'tick',
          data: { value: 42, time: Date.now() },
          timestamp: Date.now(),
        })
      })
    }
  }, 30_000)

  it('measures queue.shift() cost when at MAX_QUEUE_SIZE', async () => {
    console.log('\n────────────────────────────────────────────────')
    console.log('  Batcher overflow: O(n) shift cost per push')
    console.log('────────────────────────────────────────────────')
    const { queuePreSerialized, resetBatcherStats } = await import('../../transport/WsSendBatcher')

    // Fill a single ws's queue to the cap, then keep pushing.
    // Each push beyond cap triggers an O(n) shift().
    const ws = makeWs()
    // Don't await microtask — we want the queue to stay full.
    for (let i = 0; i < 1000; i++) queuePreSerialized(ws, '{"i":' + i + '}')
    resetBatcherStats()
    bench('queuePreSerialized while at cap (1000 items)', 5_000, () => {
      queuePreSerialized(ws, '{"overflow":true}')
    })
  }, 30_000)

  it('measures BinaryStateCodec encode (allocation-heavy)', () => {
    console.log('\n────────────────────────────────────────────────')
    console.log('  BinaryStateCodec.encodeDelta')
    console.log('────────────────────────────────────────────────')

    const small = new BinaryStateCodec({ x: 0, y: 0, hp: 0 }, { x: 'float32', y: 'float32', hp: 'uint16' })
    const big = new BinaryStateCodec(
      { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0, i: 0, j: 0 },
      { a: 'float32', b: 'float32', c: 'float32', d: 'float32', e: 'float32',
        f: 'float32', g: 'float32', h: 'float32', i: 'float32', j: 'float32' },
    )

    bench('small delta (1 field, 3-field schema)', 100_000, () => {
      small.encodeDelta({ x: 3.14 } as any)
    })

    bench('small delta (3 fields, full)', 100_000, () => {
      small.encodeDelta({ x: 3.14, y: 2.71, hp: 100 } as any)
    })

    bench('big delta (10 fields)', 50_000, () => {
      big.encodeDelta({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 } as any)
    })

    bench('string delta (UTF-8 short)', 50_000, () => {
      const codec = new BinaryStateCodec({ name: '' }, { name: 'string' })
      codec.encodeDelta({ name: 'hello world' } as any)
    })
  }, 30_000)
})
