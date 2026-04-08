// Room System Performance Benchmarks
//
// Measures baseline performance of: broadcast, emit, state updates,
// join/leave, event bus, cleanup, and serialization overhead.
// Run BEFORE and AFTER optimizations to compare.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LiveRoomManager } from '../../rooms/LiveRoomManager'
import { RoomEventBus } from '../../rooms/RoomEventBus'
import { createMockWS, spyOnConsole } from '../helpers'
import type { GenericWebSocket } from '../../transport/types'

// ===== Helpers =====

function createMockWSFast(id: string): GenericWebSocket & { _messages: string[], _bytes: number } {
  const messages: string[] = []
  let bytes = 0
  return {
    send: (msg: string | ArrayBuffer | Uint8Array) => {
      const str = typeof msg === 'string' ? msg : ''
      messages.push(str)
      bytes += str.length
    },
    close: () => {},
    data: {
      connectionId: id,
      components: new Map(),
      subscriptions: new Set(),
      connectedAt: new Date(),
    },
    remoteAddress: '127.0.0.1',
    readyState: 1 as const,
    _messages: messages,
    _bytes: bytes,
  } as any
}

async function populateRoom(
  manager: LiveRoomManager,
  roomId: string,
  memberCount: number,
): Promise<{ members: (GenericWebSocket & { _messages: string[] })[] }> {
  const members: (GenericWebSocket & { _messages: string[] })[] = []
  for (let i = 0; i < memberCount; i++) {
    const ws = createMockWSFast(`comp-${i}`)
    await manager.joinRoom(`comp-${i}`, roomId, ws)
    members.push(ws)
  }
  return { members }
}

function measure(fn: () => void, iterations: number = 1): { totalMs: number; avgMs: number; opsPerSec: number } {
  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    fn()
  }
  const totalMs = performance.now() - start
  return {
    totalMs: Math.round(totalMs * 100) / 100,
    avgMs: Math.round((totalMs / iterations) * 1000) / 1000,
    opsPerSec: Math.round(iterations / (totalMs / 1000)),
  }
}

async function measureAsync(fn: () => Promise<void>, iterations: number = 1): Promise<{ totalMs: number; avgMs: number; opsPerSec: number }> {
  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    await fn()
  }
  const totalMs = performance.now() - start
  return {
    totalMs: Math.round(totalMs * 100) / 100,
    avgMs: Math.round((totalMs / iterations) * 1000) / 1000,
    opsPerSec: Math.round(iterations / (totalMs / 1000)),
  }
}

// ===== Benchmarks =====

describe('Room Performance Benchmarks', () => {
  let roomEvents: RoomEventBus
  let manager: LiveRoomManager
  let consoleSpy: ReturnType<typeof spyOnConsole>

  beforeEach(() => {
    roomEvents = new RoomEventBus()
    manager = new LiveRoomManager(roomEvents)
    consoleSpy = spyOnConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
  })

  // ===== 1. BROADCAST PERFORMANCE =====

  describe('broadcastToRoom / emitToRoom', () => {
    it('emit to room with 10 members x 1000 iterations', async () => {
      await populateRoom(manager, 'bench-10', 10)

      const result = measure(() => {
        manager.emitToRoom('bench-10', 'test:event', { x: 1, y: 2, text: 'hello world' })
      }, 1000)

      console.log(`[BENCH] emitToRoom 10 members x1000: ${result.totalMs}ms (${result.avgMs}ms/op, ${result.opsPerSec} ops/s)`)
      expect(result.totalMs).toBeLessThan(5000) // sanity guard
    })

    it('emit to room with 100 members x 1000 iterations', async () => {
      await populateRoom(manager, 'bench-100', 100)

      const result = measure(() => {
        manager.emitToRoom('bench-100', 'test:event', { x: 1, y: 2, text: 'hello world' })
      }, 1000)

      console.log(`[BENCH] emitToRoom 100 members x1000: ${result.totalMs}ms (${result.avgMs}ms/op, ${result.opsPerSec} ops/s)`)
      expect(result.totalMs).toBeLessThan(10000)
    })

    it('emit to room with 500 members x 500 iterations', async () => {
      await populateRoom(manager, 'bench-500', 500)

      const result = measure(() => {
        manager.emitToRoom('bench-500', 'test:event', { x: 1, y: 2, text: 'hello world' })
      }, 500)

      console.log(`[BENCH] emitToRoom 500 members x500: ${result.totalMs}ms (${result.avgMs}ms/op, ${result.opsPerSec} ops/s)`)
      expect(result.totalMs).toBeLessThan(30000)
    })

    it('emit to room with 1000 members x 100 iterations', async () => {
      await populateRoom(manager, 'bench-1000', 1000)

      const result = measure(() => {
        manager.emitToRoom('bench-1000', 'test:event', { x: 1, y: 2, text: 'hello world' })
      }, 100)

      console.log(`[BENCH] emitToRoom 1000 members x100: ${result.totalMs}ms (${result.avgMs}ms/op, ${result.opsPerSec} ops/s)`)
      expect(result.totalMs).toBeLessThan(30000)
    })
  })

  // ===== 2. ROOM STATE UPDATE PERFORMANCE =====

  describe('setRoomState', () => {
    it('state update small object x 1000 iterations (100 members)', async () => {
      await populateRoom(manager, 'state-bench', 100)

      const result = measure(() => {
        manager.setRoomState('state-bench', { count: Math.random(), label: 'updated' })
      }, 1000)

      console.log(`[BENCH] setRoomState small x1000 (100m): ${result.totalMs}ms (${result.avgMs}ms/op, ${result.opsPerSec} ops/s)`)
      expect(result.totalMs).toBeLessThan(5000)
    })

    it('state update large object x 100 iterations (100 members)', async () => {
      await populateRoom(manager, 'state-large', 100)
      // seed initial state
      const bigState: Record<string, any> = {}
      for (let i = 0; i < 100; i++) {
        bigState[`field_${i}`] = `value_${i}_${'x'.repeat(100)}`
      }
      manager.setRoomState('state-large', bigState)

      const result = measure(() => {
        manager.setRoomState('state-large', { field_0: `updated_${Math.random()}` })
      }, 100)

      console.log(`[BENCH] setRoomState large x100 (100m): ${result.totalMs}ms (${result.avgMs}ms/op, ${result.opsPerSec} ops/s)`)
      expect(result.totalMs).toBeLessThan(5000)
    })
  })

  // ===== 3. JOIN/LEAVE PERFORMANCE =====

  describe('joinRoom / leaveRoom', () => {
    it('join 1000 members sequentially', async () => {
      const result = await measureAsync(async () => {
        const ws = createMockWSFast(`join-bench-${Math.random()}`)
        await manager.joinRoom(ws.data.connectionId, 'join-bench', ws)
      }, 1000)

      console.log(`[BENCH] joinRoom x1000: ${result.totalMs}ms (${result.avgMs}ms/op, ${result.opsPerSec} ops/s)`)
      expect(result.totalMs).toBeLessThan(5000)
    })

    it('leave 500 members from room with 500', async () => {
      const { members } = await populateRoom(manager, 'leave-bench', 500)

      const result = await measureAsync(async () => {
        const member = members.pop()
        if (member) {
          await manager.leaveRoom(member.data.connectionId, 'leave-bench')
        }
      }, 500)

      console.log(`[BENCH] leaveRoom x500: ${result.totalMs}ms (${result.avgMs}ms/op, ${result.opsPerSec} ops/s)`)
      expect(result.totalMs).toBeLessThan(5000)
    })
  })

  // ===== 4. EVENT BUS PERFORMANCE =====

  describe('RoomEventBus', () => {
    it('emit with 100 subscribers x 1000 iterations', () => {
      for (let i = 0; i < 100; i++) {
        roomEvents.on('room', 'bench-room', 'test:event', `comp-${i}`, () => {})
      }

      const result = measure(() => {
        roomEvents.emit('room', 'bench-room', 'test:event', { x: 1 })
      }, 1000)

      console.log(`[BENCH] RoomEventBus.emit 100 subs x1000: ${result.totalMs}ms (${result.avgMs}ms/op, ${result.opsPerSec} ops/s)`)
      expect(result.totalMs).toBeLessThan(3000)
    })

    it('emit with 500 subscribers x 500 iterations', () => {
      for (let i = 0; i < 500; i++) {
        roomEvents.on('room', 'bench-500', 'test:event', `comp-${i}`, () => {})
      }

      const result = measure(() => {
        roomEvents.emit('room', 'bench-500', 'test:event', { x: 1 })
      }, 500)

      console.log(`[BENCH] RoomEventBus.emit 500 subs x500: ${result.totalMs}ms (${result.avgMs}ms/op, ${result.opsPerSec} ops/s)`)
      expect(result.totalMs).toBeLessThan(5000)
    })

    it('unsubscribeAll with 50 rooms x 10 events each (500 total subs)', () => {
      // Register subs for comp-target across 50 rooms
      for (let r = 0; r < 50; r++) {
        for (let e = 0; e < 10; e++) {
          roomEvents.on('room', `room-${r}`, `event-${e}`, 'comp-target', () => {})
        }
      }
      // Add noise: other components
      for (let r = 0; r < 50; r++) {
        for (let e = 0; e < 10; e++) {
          for (let c = 0; c < 5; c++) {
            roomEvents.on('room', `room-${r}`, `event-${e}`, `comp-noise-${c}`, () => {})
          }
        }
      }
      // Total subs: 500 (target) + 2500 (noise) = 3000

      const result = measure(() => {
        roomEvents.unsubscribeAll('comp-target')
      }, 1) // only once since it removes them

      console.log(`[BENCH] unsubscribeAll (500 target in 3000 total): ${result.totalMs}ms`)
      expect(result.totalMs).toBeLessThan(1000)
    })

    it('unsubscribeAll scaling: 100 components with 10 subs each', () => {
      // Setup: 100 components x 10 rooms each = 1000 subs
      for (let c = 0; c < 100; c++) {
        for (let r = 0; r < 10; r++) {
          roomEvents.on('room', `room-${r}`, 'event', `comp-${c}`, () => {})
        }
      }

      // Cleanup all components one by one
      const result = measure(() => {
        for (let c = 0; c < 100; c++) {
          roomEvents.unsubscribeAll(`comp-${c}`)
        }
      }, 1)

      console.log(`[BENCH] unsubscribeAll x100 components (1000 subs): ${result.totalMs}ms`)
      expect(result.totalMs).toBeLessThan(1000)
    })
  })

  // ===== 5. CLEANUP PERFORMANCE =====

  describe('cleanupComponent', () => {
    it('cleanup component in 20 rooms (200 member room)', async () => {
      // Component comp-0 joins 20 rooms, each with 200 other members
      for (let r = 0; r < 20; r++) {
        await populateRoom(manager, `cleanup-room-${r}`, 200)
        const targetWs = createMockWSFast('comp-target')
        await manager.joinRoom('comp-target', `cleanup-room-${r}`, targetWs)
      }

      const result = await measureAsync(async () => {
        await manager.cleanupComponent('comp-target')
      }, 1)

      console.log(`[BENCH] cleanupComponent (20 rooms, 200 members each): ${result.totalMs}ms`)
      expect(result.totalMs).toBeLessThan(1000)
    })
  })

  // ===== 6. SERIALIZATION OVERHEAD =====

  describe('serialization overhead', () => {
    it('measure JSON.stringify cost per broadcast (500 members, same message)', () => {
      const message = {
        type: 'ROOM_EVENT',
        componentId: '',
        roomId: 'serial-bench',
        event: 'chat:message',
        data: {
          id: 'msg-123',
          user: 'TestUser',
          text: 'Hello, this is a test message for benchmarking purposes!',
          timestamp: Date.now(),
          metadata: { color: '#ff0000', badge: 'premium' }
        },
        timestamp: Date.now()
      }

      // Measure: stringify once vs N times
      const N = 500

      const resultNTimes = measure(() => {
        for (let i = 0; i < N; i++) {
          JSON.stringify({ ...message, componentId: `comp-${i}` })
        }
      }, 100)

      const resultOnce = measure(() => {
        const base = JSON.stringify(message)
        for (let i = 0; i < N; i++) {
          // Simulate pre-serialized approach: just string concat for componentId
          // In real impl we'd use a smarter strategy
          void base
        }
      }, 100)

      console.log(`[BENCH] JSON.stringify x${N} per broadcast (x100): ${resultNTimes.totalMs}ms`)
      console.log(`[BENCH] JSON.stringify x1 + reuse (x100): ${resultOnce.totalMs}ms`)
      console.log(`[BENCH] Serialization speedup potential: ${(resultNTimes.totalMs / resultOnce.totalMs).toFixed(1)}x`)
    })

    it('measure object spread cost per member', () => {
      const baseMessage = {
        type: 'ROOM_EVENT',
        componentId: '',
        roomId: 'spread-bench',
        event: 'update',
        data: { x: 1, y: 2, z: 3 },
        timestamp: Date.now()
      }

      const N = 1000

      const resultSpread = measure(() => {
        for (let i = 0; i < N; i++) {
          const msg = { ...baseMessage, componentId: `comp-${i}` }
          JSON.stringify(msg)
        }
      }, 100)

      const resultPreSerialized = measure(() => {
        const json = JSON.stringify(baseMessage)
        for (let i = 0; i < N; i++) {
          void json // reuse same string
        }
      }, 100)

      console.log(`[BENCH] spread + stringify x${N} (x100): ${resultSpread.totalMs}ms`)
      console.log(`[BENCH] pre-serialized reuse x${N} (x100): ${resultPreSerialized.totalMs}ms`)
      console.log(`[BENCH] Spread+serialize overhead: ${(resultSpread.totalMs / resultPreSerialized.totalMs).toFixed(1)}x`)
    })
  })

  // ===== 7. COMBINED SCENARIO =====

  describe('realistic scenario', () => {
    it('simulate chat room: 200 users, 100 messages', async () => {
      await populateRoom(manager, 'chat-sim', 200)

      // Also add event bus listeners (simulating server-side handlers)
      for (let i = 0; i < 200; i++) {
        roomEvents.on('room', 'chat-sim', 'message:new', `comp-${i}`, () => {})
      }

      const result = measure(() => {
        manager.emitToRoom('chat-sim', 'message:new', {
          id: `msg-${Math.random()}`,
          user: 'BenchUser',
          text: 'This is a benchmark chat message',
          timestamp: Date.now()
        })
      }, 100)

      console.log(`[BENCH] Chat sim (200 users, 100 msgs): ${result.totalMs}ms (${result.avgMs}ms/msg, ${result.opsPerSec} msgs/s)`)
      expect(result.totalMs).toBeLessThan(5000)
    })

    it('simulate game room: 50 players, 1000 position updates', async () => {
      await populateRoom(manager, 'game-sim', 50)

      for (let i = 0; i < 50; i++) {
        roomEvents.on('room', 'game-sim', 'pos:update', `comp-${i}`, () => {})
      }

      const result = measure(() => {
        manager.emitToRoom('game-sim', 'pos:update', {
          playerId: 'p1',
          x: Math.random() * 1000,
          y: Math.random() * 1000,
          rotation: Math.random() * 360,
          velocity: { x: Math.random(), y: Math.random() },
          timestamp: Date.now()
        })
      }, 1000)

      console.log(`[BENCH] Game sim (50 players, 1000 updates): ${result.totalMs}ms (${result.avgMs}ms/update, ${result.opsPerSec} updates/s)`)
      expect(result.totalMs).toBeLessThan(5000)
    })

    it('simulate join storm: 500 users joining same room rapidly', async () => {
      const result = await measureAsync(async () => {
        const id = `storm-${Math.random().toString(36).slice(2, 6)}`
        const ws = createMockWSFast(id)
        await manager.joinRoom(id, 'storm-room', ws)
      }, 500)

      console.log(`[BENCH] Join storm (500 joins): ${result.totalMs}ms (${result.avgMs}ms/join, ${result.opsPerSec} joins/s)`)
      expect(result.totalMs).toBeLessThan(5000)
    })

    it('simulate mass disconnect: 200 users leaving 5 rooms each', async () => {
      // Setup: 200 components in 5 rooms each
      for (let c = 0; c < 200; c++) {
        for (let r = 0; r < 5; r++) {
          const ws = createMockWSFast(`disc-comp-${c}`)
          await manager.joinRoom(`disc-comp-${c}`, `disc-room-${r}`, ws)
        }
      }

      const result = await measureAsync(async () => {
        for (let c = 0; c < 200; c++) {
          await manager.cleanupComponent(`disc-comp-${c}`)
        }
      }, 1)

      console.log(`[BENCH] Mass disconnect (200 users x 5 rooms): ${result.totalMs}ms`)
      expect(result.totalMs).toBeLessThan(5000)
    })
  })

  // ===== 8. MEMORY =====

  describe('memory usage', () => {
    it('measure memory for 1000 members in a room', async () => {
      const memBefore = process.memoryUsage().heapUsed

      await populateRoom(manager, 'mem-bench', 1000)

      // Force GC if available
      if (global.gc) global.gc()

      const memAfter = process.memoryUsage().heapUsed
      const deltaKB = Math.round((memAfter - memBefore) / 1024)

      console.log(`[BENCH] Memory for 1000-member room: ~${deltaKB}KB (negative = GC ran during test)`)
      // Just informational, GC is non-deterministic
      expect(true).toBe(true)
    })
  })
})
