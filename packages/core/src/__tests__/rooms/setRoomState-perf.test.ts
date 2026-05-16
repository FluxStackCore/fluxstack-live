// Perf measurement for setRoomState — the hot path that fires on every
// LiveRoom state update. Documents the gain from replacing JSON.stringify
// (used only for byte-size estimate) with a cheap walk.

import { describe, it } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { RoomEventBus } from '../../rooms/RoomEventBus'

function makeWs() {
  return {
    readyState: 1,
    data: { connectionId: 'x', components: new Map(), subscriptions: new Set() },
    send() {},
  } as any
}

describe('setRoomState — flush cost', () => {
  it('measures throughput of repeated state updates', async () => {
    console.log('\n────────────────────────────────────────────────')
    console.log('  setRoomState — 10k updates on a fixed room')
    console.log('────────────────────────────────────────────────')

    const mgr = new LiveRoomManager(new RoomEventBus())
    await mgr.joinRoom('c-1', 'perf:r', makeWs(), { players: {} as any, count: 0 } as any)

    const RUNS = 10_000
    // Warm
    for (let i = 0; i < 100; i++) mgr.setRoomState('perf:r', { count: i })

    const t0 = performance.now()
    for (let i = 0; i < RUNS; i++) {
      mgr.setRoomState('perf:r', { count: i })
    }
    const elapsed = performance.now() - t0
    console.log(`  small delta (1 key)      ${(elapsed / RUNS * 1000).toFixed(2)}µs/op  (${RUNS} runs in ${elapsed.toFixed(0)}ms)`)

    // Larger delta
    const t1 = performance.now()
    for (let i = 0; i < RUNS; i++) {
      mgr.setRoomState('perf:r', { players: { [`p${i % 20}`]: { hp: i, x: i * 1.5, y: -i, name: `player${i}` } } })
    }
    const elapsed2 = performance.now() - t1
    console.log(`  nested delta (player+4)  ${(elapsed2 / RUNS * 1000).toFixed(2)}µs/op  (${RUNS} runs in ${elapsed2.toFixed(0)}ms)`)

    console.log('────────────────────────────────────────────────\n')
  }, 30_000)
})
