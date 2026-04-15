import { describe, it, expect } from 'vitest'
import { queueWsMessage, queuePreSerialized } from '../../transport/WsSendBatcher'

// ===== Mock WebSocket =====
function createMockWs(): any {
  const sent: string[] = []
  return {
    readyState: 1,
    data: { connectionId: 'test', components: new Map(), subscriptions: new Set() },
    send(data: string) { sent.push(data) },
    _sent: sent,
  }
}

// ===== Test 1: Broadcast serialization =====
describe('Broadcast serialization: N×stringify vs 1×stringify + preSerialized', () => {
  it('measures broadcast to N connections', () => {
    const CONNECTION_COUNTS = [10, 50, 100, 500]
    const broadcastMessage = {
      type: 'BROADCAST',
      componentId: 'comp-1',
      payload: {
        type: 'chatMessage',
        data: {
          user: 'john',
          message: 'Hello everyone! This is a test broadcast message.',
          timestamp: 1234567890,
          room: 'lobby',
          metadata: { color: '#ff0000', role: 'admin' }
        }
      },
      timestamp: Date.now(),
      room: 'lobby',
    }

    console.log(`\n${''.padEnd(65, '─')}`)
    console.log(`  Broadcast: queueWsMessage (N×stringify) vs queuePreSerialized`)
    console.log(`${''.padEnd(65, '─')}`)
    console.log(`  ${'Conns'.padEnd(8)} ${'N×stringify'.padStart(14)} ${'1×preSerialized'.padStart(17)} ${'Speedup'.padStart(10)}`)
    console.log(`  ${''.padEnd(55, '─')}`)

    for (const N of CONNECTION_COUNTS) {
      const RUNS = N > 100 ? 100 : 500

      // Old way: queueWsMessage for each (each will JSON.stringify internally)
      const oldTime = (() => {
        const start = performance.now()
        for (let r = 0; r < RUNS; r++) {
          const connections = Array.from({ length: N }, () => createMockWs())
          for (const ws of connections) {
            queueWsMessage(ws, broadcastMessage as any)
          }
        }
        return performance.now() - start
      })()

      // New way: stringify once, queuePreSerialized for each
      const newTime = (() => {
        const start = performance.now()
        for (let r = 0; r < RUNS; r++) {
          const serialized = JSON.stringify(broadcastMessage)
          const connections = Array.from({ length: N }, () => createMockWs())
          for (const ws of connections) {
            queuePreSerialized(ws, serialized)
          }
        }
        return performance.now() - start
      })()

      const speedup = (oldTime / newTime).toFixed(2)
      console.log(`  ${String(N).padEnd(8)} ${(oldTime.toFixed(2) + 'ms').padStart(14)} ${(newTime.toFixed(2) + 'ms').padStart(17)} ${(speedup + 'x').padStart(10)}`)
    }
    console.log(`${''.padEnd(65, '─')}\n`)
  })
})

// ===== Test 2: TextDecoder allocation =====
describe('TextDecoder: new per-call vs singleton', () => {
  it('measures decode performance', () => {
    const componentIds = Array.from({ length: 100 }, (_, i) =>
      new TextEncoder().encode(`comp-${String(i).padStart(4, '0')}`)
    )
    const N = 100_000

    // Warmup
    for (let i = 0; i < 1000; i++) new TextDecoder().decode(componentIds[i % 100])

    // Old: new TextDecoder each time
    const oldStart = performance.now()
    for (let i = 0; i < N; i++) {
      new TextDecoder().decode(componentIds[i % 100])
    }
    const oldTime = performance.now() - oldStart

    // New: singleton
    const decoder = new TextDecoder()
    const newStart = performance.now()
    for (let i = 0; i < N; i++) {
      decoder.decode(componentIds[i % 100])
    }
    const newTime = performance.now() - newStart

    console.log(`\n${''.padEnd(55, '─')}`)
    console.log(`  TextDecoder: new() vs singleton — ${N.toLocaleString()} decodes`)
    console.log(`${''.padEnd(55, '─')}`)
    console.log(`  new TextDecoder(): ${oldTime.toFixed(2)}ms`)
    console.log(`  singleton:         ${newTime.toFixed(2)}ms`)
    console.log(`  Speedup: ${(oldTime / newTime).toFixed(2)}x`)
    console.log(`${''.padEnd(55, '─')}\n`)

    expect(newTime).toBeLessThan(oldTime)
  })
})

// ===== Test 3: Heartbeat overhead =====
describe('Heartbeat: N pings per-component vs 1 ping per-connection', () => {
  it('measures message overhead', () => {
    const COMPONENT_COUNTS = [1, 5, 10, 20, 50]
    const HEARTBEAT_INTERVAL = 30 // seconds
    const SESSION_MINUTES = 5

    console.log(`\n${''.padEnd(70, '─')}`)
    console.log(`  Heartbeat overhead in ${SESSION_MINUTES}-minute session (${HEARTBEAT_INTERVAL}s interval)`)
    console.log(`${''.padEnd(70, '─')}`)
    console.log(`  ${'Comps'.padEnd(8)} ${'Old msgs'.padStart(10)} ${'New msgs'.padStart(10)} ${'Old bytes'.padStart(12)} ${'New bytes'.padStart(12)} ${'Savings'.padStart(10)}`)
    console.log(`  ${''.padEnd(64, '─')}`)

    const beats = (SESSION_MINUTES * 60) / HEARTBEAT_INTERVAL

    for (const comps of COMPONENT_COUNTS) {
      const oldMsgs = beats * comps
      const newMsgs = beats // 1 per connection

      // Old: {"type":"COMPONENT_PING","componentId":"comp-XXXX","timestamp":1234567890123}
      const oldMsgSize = JSON.stringify({
        type: 'COMPONENT_PING',
        componentId: 'comp-0001',
        timestamp: Date.now(),
      }).length
      const oldBytes = oldMsgs * oldMsgSize

      // New: single ping frame (WS native ping or minimal JSON)
      const newMsgSize = JSON.stringify({ type: 'PING' }).length
      const newBytes = newMsgs * newMsgSize

      const savings = ((1 - newBytes / oldBytes) * 100).toFixed(0)
      console.log(`  ${String(comps).padEnd(8)} ${String(oldMsgs).padStart(10)} ${String(newMsgs).padStart(10)} ${(oldBytes + 'B').padStart(12)} ${(newBytes + 'B').padStart(12)} ${(savings + '%').padStart(10)}`)
    }
    console.log(`${''.padEnd(70, '─')}\n`)
  })

  it('measures JSON.stringify overhead of old heartbeat', () => {
    const N = 50_000
    const componentIds = Array.from({ length: 10 }, (_, i) => `comp-${i}`)

    // Old: stringify per component
    const oldStart = performance.now()
    for (let i = 0; i < N; i++) {
      for (const componentId of componentIds) {
        JSON.stringify({
          type: 'COMPONENT_PING',
          componentId,
          timestamp: Date.now(),
        })
      }
    }
    const oldTime = performance.now() - oldStart

    // New: single ping
    const newStart = performance.now()
    for (let i = 0; i < N; i++) {
      JSON.stringify({ type: 'PING' })
    }
    const newTime = performance.now() - newStart

    console.log(`\n${''.padEnd(55, '─')}`)
    console.log(`  Heartbeat stringify — ${N.toLocaleString()} beats × 10 components`)
    console.log(`${''.padEnd(55, '─')}`)
    console.log(`  Old (10 per beat): ${oldTime.toFixed(2)}ms`)
    console.log(`  New (1 per beat):  ${newTime.toFixed(2)}ms`)
    console.log(`  Speedup: ${(oldTime / newTime).toFixed(2)}x`)
    console.log(`${''.padEnd(55, '─')}\n`)

    expect(newTime).toBeLessThan(oldTime)
  })
})

// ===== Test 4: Reconnect backoff =====
describe('Reconnect: fixed vs exponential backoff', () => {
  it('shows delay schedule comparison', () => {
    const MAX_ATTEMPTS = 5
    const BASE_INTERVAL = 1000

    console.log(`\n${''.padEnd(50, '─')}`)
    console.log(`  Reconnect delay schedule (${MAX_ATTEMPTS} attempts)`)
    console.log(`${''.padEnd(50, '─')}`)
    console.log(`  ${'Attempt'.padEnd(10)} ${'Fixed'.padStart(10)} ${'Exponential'.padStart(14)}`)
    console.log(`  ${''.padEnd(38, '─')}`)

    let fixedTotal = 0
    let expTotal = 0
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const fixed = BASE_INTERVAL
      const exp = Math.min(BASE_INTERVAL * Math.pow(2, i - 1), 16000)
      fixedTotal += fixed
      expTotal += exp
      console.log(`  ${String(i).padEnd(10)} ${(fixed + 'ms').padStart(10)} ${(exp + 'ms').padStart(14)}`)
    }
    console.log(`  ${''.padEnd(38, '─')}`)
    console.log(`  ${'Total'.padEnd(10)} ${(fixedTotal + 'ms').padStart(10)} ${(expTotal + 'ms').padStart(14)}`)
    console.log(`${''.padEnd(50, '─')}\n`)
  })
})
