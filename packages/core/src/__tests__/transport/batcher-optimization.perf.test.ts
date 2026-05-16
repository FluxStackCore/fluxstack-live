// Baseline benchmark — captures current batcher cost before optimization.
// Re-run after the optimization PR to measure the gain.
//
// Three hot scenarios:
//   1. Pure-object batch (typical state update fan-out)
//   2. Mixed object + pre-serialized batch (room broadcast + state update)
//   3. Already-deduplicated batch (the common case — no duplicate componentIds)

import { describe, it } from 'vitest'
import { queueWsMessage, queuePreSerialized } from '../../transport/WsSendBatcher'

function makeWs() {
  return {
    readyState: 1,
    data: { connectionId: 'test', components: new Map(), subscriptions: new Set() },
    send() {},
  } as any
}

function makeMsg(i: number) {
  return {
    type: 'STATE_DELTA',
    componentId: `comp-${i}`,
    payload: { delta: { count: i, name: `player-${i}`, hp: 100 } },
    timestamp: Date.now(),
  }
}

async function flushAndMeasure(label: string, setup: () => void) {
  // Warm up
  for (let i = 0; i < 3; i++) {
    setup()
    await Promise.resolve()
  }
  const RUNS = 200
  const t0 = performance.now()
  for (let r = 0; r < RUNS; r++) {
    setup()
    await Promise.resolve() // let microtask flush
  }
  const elapsed = performance.now() - t0
  console.log(`  ${label.padEnd(50)} ${(elapsed / RUNS).toFixed(3)}ms/run`)
}

describe('WsSendBatcher — flush cost baseline', () => {
  it('measures the three hot paths', async () => {
    console.log('\n────────────────────────────────────────────────────────')
    console.log('  Batcher flush cost (per-batch)')
    console.log('────────────────────────────────────────────────────────')

    await flushAndMeasure('100 objects (unique componentIds)', () => {
      const ws = makeWs()
      for (let i = 0; i < 100; i++) queueWsMessage(ws, makeMsg(i))
    })

    await flushAndMeasure('100 objects (50% dup componentIds, dedup work)', () => {
      const ws = makeWs()
      for (let i = 0; i < 100; i++) queueWsMessage(ws, makeMsg(i % 50))
    })

    await flushAndMeasure('100 pre-serialized strings', () => {
      const ws = makeWs()
      for (let i = 0; i < 100; i++) queuePreSerialized(ws, `{"n":${i}}`)
    })

    await flushAndMeasure('50 objects + 50 pre-serialized (mixed)', () => {
      const ws = makeWs()
      for (let i = 0; i < 50; i++) {
        queueWsMessage(ws, makeMsg(i))
        queuePreSerialized(ws, `{"n":${i}}`)
      }
    })

    await flushAndMeasure('1000 objects (large batch, unique ids)', () => {
      const ws = makeWs()
      for (let i = 0; i < 1000; i++) queueWsMessage(ws, makeMsg(i))
    })

    console.log('────────────────────────────────────────────────────────\n')
  }, 30_000)
})
