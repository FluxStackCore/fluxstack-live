/**
 * Regression tests for computeDeepDiff + deepAssign (0.6.0 vs 0.6.1)
 *
 * Tests real-time multiplayer game scenarios: players with nested
 * position objects, items, effects, worldObjects, etc.
 *
 * Findings:
 * - 0.6.1 treats missing keys at depth>0 as removals (emits null)
 * - 0.6.1 deepAssign deletes keys when value is null at depth>0
 * - 0.6.1 structuredClone isolates new objects from external mutations
 * - These changes break partial updates: any setState that doesn't include
 *   ALL fields of a nested object will DELETE the missing fields
 *
 * Bug report: partial updates at depth>0 delete missing fields,
 * causing state corruption in game rooms where setState is called with
 * only changed fields (e.g., { position, rotation, speed } without
 * lap, checkpoint, heldItem, etc.)
 */

import { describe, it, expect } from 'vitest'
import { computeDeepDiff as computeDeepDiff_061, deepAssign as deepAssign_061 } from '../../utils/deepDiff'

// ─── 0.6.0 reference implementations (inline, no key removal detection) ────
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype
}

function computeDeepDiff_060(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  depth = 0,
  maxDepth = 3,
  seen?: Set<object>,
): Record<string, unknown> | null {
  if (depth > maxDepth) return prev === next ? null : next
  if (!seen) seen = new Set()
  if (seen.has(next)) return prev === next ? null : next
  seen.add(next)
  let result: Record<string, unknown> | null = null
  for (const key of Object.keys(next)) {
    const oldVal = prev[key]
    const newVal = next[key]
    if (oldVal === newVal) continue
    if (isPlainObject(oldVal) && isPlainObject(newVal)) {
      const nested = computeDeepDiff_060(oldVal, newVal, depth + 1, maxDepth, seen)
      if (nested !== null) {
        result ??= {}
        result[key] = nested
      }
    } else {
      result ??= {}
      result[key] = newVal
    }
  }
  return result
}

function deepAssign_060(target: any, source: any, seen?: Set<object>): void {
  if (!seen) seen = new Set()
  if (seen.has(source)) return
  seen.add(source)
  for (const key of Object.keys(source)) {
    if (isPlainObject(target[key]) && isPlainObject(source[key])) {
      deepAssign_060(target[key], source[key], seen)
    } else {
      target[key] = source[key]
    }
  }
}

// ─── 0.6.1 imported from real source ────────────────────────────────────────
// computeDeepDiff_061 and deepAssign_061 are imported at the top from '../../utils/deepDiff'

// ─── Helpers ────────────────────────────────────────────────────────────────
function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

function makePlayer(id: string, x: number, z: number, rotation = 0, speed = 0) {
  return {
    id,
    nickname: id,
    position: { x, y: 0.5, z },
    rotation,
    speed,
    ready: true,
    lap: 0,
    driftStage: 0,
  }
}

/**
 * Simula o fluxo completo: diff → apply → diff novamente
 * Reproduz: movePlayer → setState → deepAssign → próximo movePlayer → setState
 */
function simulateStateUpdateCycle(
  computeDeepDiff: typeof computeDeepDiff_060,
  deepAssign: typeof deepAssign_060,
  state: Record<string, unknown>,
  updates: Record<string, unknown>[],
  maxDepth = 3,
) {
  const diffs: (Record<string, unknown> | null)[] = []
  for (const update of updates) {
    const diff = computeDeepDiff(state, update, 0, maxDepth)
    diffs.push(diff ? clone(diff) : null)
    if (diff) {
      deepAssign(state, diff)
    }
  }
  return diffs
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Deep Diff Regression: Player Position Sync', () => {

  describe('Basic position changes', () => {
    it('detects position.x change at depth 4 (maxDepth=3)', () => {
      const state = { players: { p1: makePlayer('p1', 5, -4) } }
      const update = { players: { p1: { ...state.players.p1, position: { x: 10, y: 0.5, z: -4 } } } }

      const diff060 = computeDeepDiff_060(state as any, update as any, 0, 3)
      const diff061 = computeDeepDiff_061(state as any, update as any, 0, 3)

      // Depth structure: players(0) → p1(1) → position(2) → x(3)
      // At depth 3, maxDepth=3: depth > maxDepth is FALSE, should recurse
      // At depth 4 for x,y,z: depth > maxDepth IS TRUE → fallback to reference equality
      console.log('0.6.0 diff:', JSON.stringify(diff060))
      console.log('0.6.1 diff:', JSON.stringify(diff061))

      // position objects are different references → should detect
      expect(diff060).not.toBeNull()
      expect(diff061).not.toBeNull()
    })

    it('detects position.x change at depth 4 (maxDepth=4)', () => {
      const state = { players: { p1: makePlayer('p1', 5, -4) } }
      const update = { players: { p1: { ...state.players.p1, position: { x: 10, y: 0.5, z: -4 } } } }

      const diff060 = computeDeepDiff_060(state as any, update as any, 0, 4)
      const diff061 = computeDeepDiff_061(state as any, update as any, 0, 4)

      console.log('0.6.0 diff (depth 4):', JSON.stringify(diff060))
      console.log('0.6.1 diff (depth 4):', JSON.stringify(diff061))

      expect(diff060?.players).toBeDefined()
      expect(diff061?.players).toBeDefined()
    })
  })

  describe('Sequential moves — deepAssign mutation', () => {
    it('0.6.0: detects position after deepAssign mutated state', () => {
      const state: any = { players: { p1: makePlayer('p1', 5, -4) } }

      // Move 1: p1 moves to (10, -3)
      const update1 = { players: { p1: { ...state.players.p1, position: { x: 10, y: 0.5, z: -3 }, rotation: 1.0, speed: 0.5 } } }
      const diff1 = computeDeepDiff_060(state, update1, 0, 3)
      expect(diff1).not.toBeNull()
      if (diff1) deepAssign_060(state, diff1)

      // Move 2: p1 moves to (20, -2)
      const update2 = { players: { p1: { ...state.players.p1, position: { x: 20, y: 0.5, z: -2 }, rotation: 1.5, speed: 0.6 } } }
      const diff2 = computeDeepDiff_060(state, update2, 0, 3)

      console.log('0.6.0 diff2:', JSON.stringify(diff2))
      // Must detect position change
      const p1Diff = (diff2?.players as any)?.p1
      expect(p1Diff).toBeDefined()
      // Position must be in the diff
      expect(p1Diff?.position).toBeDefined()
    })

    it('0.6.1: detects position after deepAssign mutated state', () => {
      const state: any = { players: { p1: makePlayer('p1', 5, -4) } }

      const update1 = { players: { p1: { ...state.players.p1, position: { x: 10, y: 0.5, z: -3 }, rotation: 1.0, speed: 0.5 } } }
      const diff1 = computeDeepDiff_061(state, update1, 0, 3)
      expect(diff1).not.toBeNull()
      if (diff1) deepAssign_061(state, diff1)

      const update2 = { players: { p1: { ...state.players.p1, position: { x: 20, y: 0.5, z: -2 }, rotation: 1.5, speed: 0.6 } } }
      const diff2 = computeDeepDiff_061(state, update2, 0, 3)

      console.log('0.6.1 diff2:', JSON.stringify(diff2))
      const p1Diff = (diff2?.players as any)?.p1
      expect(p1Diff).toBeDefined()
      expect(p1Diff?.position).toBeDefined()
    })
  })

  describe('Shared reference via deepAssign mutation', () => {
    it('0.6.0: position shared reference after deepAssign', () => {
      const state: any = { players: { p1: makePlayer('p1', 5, -4) } }

      // Simulate movePlayer → setState → deepAssign
      const newPos = { x: 10, y: 0.5, z: -3 }
      const update = { players: { p1: { ...state.players.p1, position: newPos, rotation: 1.0 } } }
      const diff = computeDeepDiff_060(state, update, 0, 3)
      if (diff) deepAssign_060(state, diff)

      // After deepAssign, is state.players.p1.position the SAME object as newPos?
      const isSameRef = state.players.p1.position === newPos
      console.log('0.6.0 sameRef after deepAssign:', isSameRef)
      console.log('0.6.0 state.pos:', JSON.stringify(state.players.p1.position))

      // Now simulate the emitToRoom receiving the SAME position object
      // and the LiveKartGame handler building a new update
      const eventData = { id: 'p1', position: newPos, rotation: 1.0, speed: 0.5 }
      const handlerUpdate = {
        players: {
          p1: { ...state.players.p1, position: eventData.position, rotation: eventData.rotation, speed: eventData.speed }
        }
      }
      const diff2 = computeDeepDiff_060(state, handlerUpdate as any, 0, 3)
      console.log('0.6.0 diff2 (shared ref):', JSON.stringify(diff2))

      // This is the actual bug scenario — if deepAssign mutated newPos in-place,
      // then state.players.p1.position and eventData.position point to same object
      // and the diff should still detect changes if values are different
    })

    it('0.6.1: position shared reference after deepAssign', () => {
      const state: any = { players: { p1: makePlayer('p1', 5, -4) } }

      const newPos = { x: 10, y: 0.5, z: -3 }
      const update = { players: { p1: { ...state.players.p1, position: newPos, rotation: 1.0 } } }
      const diff = computeDeepDiff_061(state, update, 0, 3)
      if (diff) deepAssign_061(state, diff)

      const isSameRef = state.players.p1.position === newPos
      console.log('0.6.1 sameRef after deepAssign:', isSameRef)
      console.log('0.6.1 state.pos:', JSON.stringify(state.players.p1.position))

      const eventData = { id: 'p1', position: newPos, rotation: 1.0, speed: 0.5 }
      const handlerUpdate = {
        players: {
          p1: { ...state.players.p1, position: eventData.position, rotation: eventData.rotation, speed: eventData.speed }
        }
      }
      const diff2 = computeDeepDiff_061(state, handlerUpdate as any, 0, 3)
      console.log('0.6.1 diff2 (shared ref):', JSON.stringify(diff2))
    })
  })

  describe('Full game cycle simulation', () => {
    it('0.6.0: 10 sequential position updates all detected', () => {
      const state: any = { players: { p1: makePlayer('p1', 5, -4) } }
      let detected = 0
      for (let i = 0; i < 10; i++) {
        const newX = 5 + i * 3
        const newZ = -4 + i * 0.5
        const update = {
          players: {
            p1: { ...state.players.p1, position: { x: newX, y: 0.5, z: newZ }, rotation: i * 0.1, speed: 0.4 + i * 0.05 }
          }
        }
        const diff = computeDeepDiff_060(state, update, 0, 3)
        if (diff) {
          deepAssign_060(state, diff)
          const p1 = (diff.players as any)?.p1
          if (p1?.position) detected++
        }
      }
      console.log(`0.6.0: detected position in ${detected}/10 updates`)
      // First frame has same position as initial spawn — 9/10 is expected
      expect(detected).toBeGreaterThanOrEqual(9)
    })

    it('0.6.1: 10 sequential position updates all detected', () => {
      const state: any = { players: { p1: makePlayer('p1', 5, -4) } }
      let detected = 0
      for (let i = 0; i < 10; i++) {
        const newX = 5 + i * 3
        const newZ = -4 + i * 0.5
        const update = {
          players: {
            p1: { ...state.players.p1, position: { x: newX, y: 0.5, z: newZ }, rotation: i * 0.1, speed: 0.4 + i * 0.05 }
          }
        }
        const diff = computeDeepDiff_061(state, update, 0, 3)
        if (diff) {
          deepAssign_061(state, diff)
          const p1 = (diff.players as any)?.p1
          if (p1?.position) detected++
        }
      }
      console.log(`0.6.1: detected position in ${detected}/10 updates`)
      expect(detected).toBeGreaterThanOrEqual(9)
    })
  })

  describe('Room state + LiveComponent state double-diff (actual bug path)', () => {
    // This simulates the EXACT flow:
    // 1. KartRaceRoom.movePlayer → this.setState({ players }) → computeDeepDiff on room.state
    // 2. deepAssign(room.state, diff) — MUTATES room.state
    // 3. emitToRoom('player:moved', { position }) — position may be shared ref
    // 4. LiveKartGame handler → this.setState({ players }) → computeDeepDiff on component._state
    // 5. deepAssign(component._state, diff2)

    it('0.6.0: double-diff path detects position', () => {
      // Room state
      const roomState: any = { players: { p1: makePlayer('p1', 5, -4, 0, 0) } }
      // Component state (clone of room state initially)
      const compState: any = clone(roomState)

      // Player moves to (10, -3)
      const movePos = { x: 10, y: 0.5, z: -3 }
      const moveRot = 1.0
      const moveSpeed = 0.5

      // Step 1: Room setState
      const roomUpdate = { players: { p1: { ...roomState.players.p1, position: movePos, rotation: moveRot, speed: moveSpeed } } }
      const roomDiff = computeDeepDiff_060(roomState, roomUpdate, 0, 3)
      expect(roomDiff).not.toBeNull()
      if (roomDiff) deepAssign_060(roomState, roomDiff)

      // Step 2: emitToRoom — passes the SAME movePos object
      const eventData = { id: 'p1', position: movePos, rotation: moveRot, speed: moveSpeed, driftStage: 0 }

      // Step 3: LiveKartGame handler
      const player = compState.players.p1
      const compUpdate = {
        players: {
          p1: { ...player, position: eventData.position, rotation: eventData.rotation, speed: eventData.speed }
        }
      }
      const compDiff = computeDeepDiff_060(compState, compUpdate as any, 0, 3)
      console.log('0.6.0 compDiff:', JSON.stringify(compDiff))

      const p1Diff = (compDiff?.players as any)?.p1
      expect(p1Diff).toBeDefined()
      // CRITICAL: position MUST be in the component diff
      expect(p1Diff?.position).toBeDefined()
      expect(p1Diff?.position?.x).toBe(10)
    })

    it('0.6.1: double-diff path detects position', () => {
      const roomState: any = { players: { p1: makePlayer('p1', 5, -4, 0, 0) } }
      const compState: any = clone(roomState)

      const movePos = { x: 10, y: 0.5, z: -3 }
      const moveRot = 1.0
      const moveSpeed = 0.5

      const roomUpdate = { players: { p1: { ...roomState.players.p1, position: movePos, rotation: moveRot, speed: moveSpeed } } }
      const roomDiff = computeDeepDiff_061(roomState, roomUpdate, 0, 3)
      expect(roomDiff).not.toBeNull()
      if (roomDiff) deepAssign_061(roomState, roomDiff)

      const eventData = { id: 'p1', position: movePos, rotation: moveRot, speed: moveSpeed, driftStage: 0 }

      const player = compState.players.p1
      const compUpdate = {
        players: {
          p1: { ...player, position: eventData.position, rotation: eventData.rotation, speed: eventData.speed }
        }
      }
      const compDiff = computeDeepDiff_061(compState, compUpdate as any, 0, 3)
      console.log('0.6.1 compDiff:', JSON.stringify(compDiff))

      const p1Diff = (compDiff?.players as any)?.p1
      expect(p1Diff).toBeDefined()
      expect(p1Diff?.position).toBeDefined()
      expect(p1Diff?.position?.x).toBe(10)
    })

    it('0.6.0: double-diff with structuredClone in deepAssign (simulate 0.6.1 behavior)', () => {
      // This tests if structuredClone in deepAssign changes behavior
      const roomState: any = { players: { p1: makePlayer('p1', 5, -4, 0, 0) } }
      const compState: any = clone(roomState)

      const movePos = { x: 10, y: 0.5, z: -3 }

      // Room update
      const roomUpdate = { players: { p1: { ...roomState.players.p1, position: movePos, rotation: 1.0, speed: 0.5 } } }
      const roomDiff = computeDeepDiff_060(roomState, roomUpdate, 0, 3)
      if (roomDiff) deepAssign_060(roomState, roomDiff)

      // Check if deepAssign mutated movePos
      console.log('movePos after deepAssign:', JSON.stringify(movePos))
      console.log('roomState.p1.pos === movePos:', roomState.players.p1.position === movePos)

      // Now do SECOND move
      const movePos2 = { x: 20, y: 0.5, z: -2 }
      const roomUpdate2 = { players: { p1: { ...roomState.players.p1, position: movePos2, rotation: 1.5, speed: 0.6 } } }
      const roomDiff2 = computeDeepDiff_060(roomState, roomUpdate2, 0, 3)
      console.log('0.6.0 roomDiff2:', JSON.stringify(roomDiff2))
      if (roomDiff2) deepAssign_060(roomState, roomDiff2)

      // emitToRoom with movePos2
      const eventData2 = { id: 'p1', position: movePos2, rotation: 1.5, speed: 0.6 }

      // LiveKartGame handler for component state
      const compUpdate2 = {
        players: {
          p1: { ...compState.players.p1, position: eventData2.position, rotation: eventData2.rotation, speed: eventData2.speed }
        }
      }
      const compDiff2 = computeDeepDiff_060(compState, compUpdate2 as any, 0, 3)
      console.log('0.6.0 compDiff2:', JSON.stringify(compDiff2))

      const p1 = (compDiff2?.players as any)?.p1
      expect(p1?.position).toBeDefined()
    })
  })

  describe('maxDepth boundary cases', () => {
    for (const maxDepth of [2, 3, 4, 5]) {
      it(`0.6.0: maxDepth=${maxDepth} — position at depth 4`, () => {
        const state = { players: { p1: makePlayer('p1', 5, -4) } } as any
        const update = { players: { p1: { ...state.players.p1, position: { x: 99, y: 0.5, z: 99 } } } }
        const diff = computeDeepDiff_060(state, update, 0, maxDepth)
        const hasPos = !!(diff?.players as any)?.p1?.position
        console.log(`0.6.0 maxDepth=${maxDepth}: hasPosition=${hasPos}, diff=${JSON.stringify(diff)}`)
        if (maxDepth >= 3) expect(hasPos).toBe(true)
      })

      it(`0.6.1: maxDepth=${maxDepth} — position at depth 4`, () => {
        const state = { players: { p1: makePlayer('p1', 5, -4) } } as any
        const update = { players: { p1: { ...state.players.p1, position: { x: 99, y: 0.5, z: 99 } } } }
        const diff = computeDeepDiff_061(state, update, 0, maxDepth)
        const hasPos = !!(diff?.players as any)?.p1?.position
        console.log(`0.6.1 maxDepth=${maxDepth}: hasPosition=${hasPos}, diff=${JSON.stringify(diff)}`)
        if (maxDepth >= 3) expect(hasPos).toBe(true)
      })
    }
  })

  describe('Multi-player simultaneous moves', () => {
    it('0.6.0: two players move in same tick', () => {
      const state: any = {
        players: {
          p1: makePlayer('p1', 5, -4),
          p2: makePlayer('p2', 10, 4),
        }
      }

      // Both move
      const update = {
        players: {
          p1: { ...state.players.p1, position: { x: 15, y: 0.5, z: -3 }, rotation: 1.0 },
          p2: { ...state.players.p2, position: { x: 20, y: 0.5, z: 3 }, rotation: 2.0 },
        }
      }
      const diff = computeDeepDiff_060(state, update, 0, 3)
      console.log('0.6.0 multi-player diff:', JSON.stringify(diff))

      expect((diff?.players as any)?.p1?.position).toBeDefined()
      expect((diff?.players as any)?.p2?.position).toBeDefined()
    })

    it('0.6.1: two players move in same tick', () => {
      const state: any = {
        players: {
          p1: makePlayer('p1', 5, -4),
          p2: makePlayer('p2', 10, 4),
        }
      }

      const update = {
        players: {
          p1: { ...state.players.p1, position: { x: 15, y: 0.5, z: -3 }, rotation: 1.0 },
          p2: { ...state.players.p2, position: { x: 20, y: 0.5, z: 3 }, rotation: 2.0 },
        }
      }
      const diff = computeDeepDiff_061(state, update, 0, 3)
      console.log('0.6.1 multi-player diff:', JSON.stringify(diff))

      expect((diff?.players as any)?.p1?.position).toBeDefined()
      expect((diff?.players as any)?.p2?.position).toBeDefined()
    })
  })

  describe('REAL BUG: room deepAssign + component deepAssign + emitToRoom shared ref', () => {
    // Simulates the EXACT server flow that caused the position sync bug:
    // 1. KartRaceRoom has its own state managed by LiveRoomManager (setRoomState)
    // 2. LiveKartGame has its own _state managed by ComponentStateManager (setState)
    // 3. emitToRoom sends the position object — which may be mutated by deepAssign

    function runBugTest(
      computeDeepDiff: typeof computeDeepDiff_060,
      deepAssignFn: typeof deepAssign_060,
      label: string,
    ) {
      // Room state (managed by LiveRoomManager)
      const roomState: any = { players: { p1: makePlayer('p1', 5, -4, 0, 0) } }
      // Component state (managed by ComponentStateManager) — initially synced from room
      const compState: any = clone(roomState)

      const positionsDetected: boolean[] = []

      for (let frame = 0; frame < 20; frame++) {
        const newX = 5 + frame * 2
        const newZ = -4 + frame * 0.3
        const newRot = frame * 0.1
        const newSpeed = 0.3 + frame * 0.02

        // === Step 1: KartRaceRoom.movePlayer → setState on room ===
        const roomPlayer = roomState.players.p1
        const roomUpdate = {
          players: {
            p1: { ...roomPlayer, position: { x: newX, y: 0.5, z: newZ }, rotation: newRot, speed: newSpeed }
          }
        }
        const roomDiff = computeDeepDiff(roomState, roomUpdate, 0, 3)
        if (roomDiff) deepAssignFn(roomState, roomDiff)

        // === Step 2: emitToRoom('player:moved', { position, ... }) ===
        // The position passed to emitToRoom is the SAME object from the update
        const emittedPos = roomUpdate.players.p1.position

        // === Step 3: LiveKartGame handler receives the event ===
        // Handler reads from compState.players.p1 and builds new update
        const compPlayer = compState.players.p1
        if (!compPlayer) continue

        const compUpdate = {
          players: {
            p1: { ...compPlayer, position: emittedPos, rotation: newRot, speed: newSpeed }
          }
        }

        // === Step 4: LiveKartGame.setState → computeDeepDiff on component state ===
        const compDiff = computeDeepDiff(compState, compUpdate as any, 0, 3)
        const hasPosition = !!(compDiff?.players as any)?.p1?.position
        positionsDetected.push(hasPosition)

        if (compDiff) deepAssignFn(compState, compDiff)
      }

      const detected = positionsDetected.filter(Boolean).length
      console.log(`${label}: position detected in ${detected}/20 frames — [${positionsDetected.map(b => b ? '✓' : '✗').join('')}]`)
      return { detected, positionsDetected }
    }

    it('0.6.0: all position changes detected in double-diff flow', () => {
      const { detected } = runBugTest(computeDeepDiff_060, deepAssign_060, '0.6.0')
      // First frame has same position as initial — expect 19/20
      expect(detected).toBeGreaterThanOrEqual(19)
    })

    it('0.6.1: all position changes detected in double-diff flow', () => {
      const { detected } = runBugTest(computeDeepDiff_061, deepAssign_061, '0.6.1')
      expect(detected).toBeGreaterThanOrEqual(19)
    })

    it('cross-version: 0.6.1 deepAssign on room + 0.6.0 deepAssign on component', () => {
      // What if room uses 0.6.1 and component uses 0.6.0?
      const roomState: any = { players: { p1: makePlayer('p1', 5, -4, 0, 0) } }
      const compState: any = clone(roomState)
      let detected = 0

      for (let frame = 0; frame < 20; frame++) {
        const newX = 5 + frame * 2
        const newZ = -4 + frame * 0.3

        const roomUpdate = {
          players: { p1: { ...roomState.players.p1, position: { x: newX, y: 0.5, z: newZ }, rotation: frame * 0.1, speed: 0.3 } }
        }
        const roomDiff = computeDeepDiff_061(roomState, roomUpdate, 0, 3)
        if (roomDiff) deepAssign_061(roomState, roomDiff)

        const emittedPos = roomUpdate.players.p1.position
        const compPlayer = compState.players.p1
        if (!compPlayer) continue

        const compUpdate = {
          players: { p1: { ...compPlayer, position: emittedPos, rotation: frame * 0.1, speed: 0.3 } }
        }
        const compDiff = computeDeepDiff_060(compState, compUpdate as any, 0, 3)
        if ((compDiff?.players as any)?.p1?.position) detected++
        if (compDiff) deepAssign_060(compState, compDiff)
      }

      console.log(`cross-version: detected ${detected}/20`)
      expect(detected).toBeGreaterThanOrEqual(19)
    })
  })

  describe('deepAssign depth behavior differences', () => {
    // 0.6.1 deepAssignImpl has depth-aware behavior:
    // - depth=0: null → target[key] = null (top-level)
    // - depth>0: null → delete target[key] (nested deletion)
    // - structuredClone for new plain objects
    // 0.6.0 has NO depth awareness

    it('0.6.0: deepAssign does NOT delete key on null', () => {
      const target = { players: { p1: { x: 1 }, p2: { x: 2 } } } as any
      deepAssign_060(target, { players: { p2: null } })
      // 0.6.0 sets it to null but doesn't delete
      expect(target.players.p2).toBeNull()
      expect('p2' in target.players).toBe(true)
    })

    it('0.6.1: deepAssign deletes key on null at depth>0', () => {
      const target = { players: { p1: { x: 1 }, p2: { x: 2 } } } as any
      deepAssign_061(target, { players: { p2: null } })
      // 0.6.1 deletes the key at depth > 0
      expect('p2' in target.players).toBe(false)
    })

    it('0.6.1: deepAssign keeps null at depth=0', () => {
      const target = { players: { p1: { x: 1 } }, score: 10 } as any
      deepAssign_061(target, { score: null })
      expect(target.score).toBeNull()
      expect('score' in target).toBe(true)
    })

    it('0.6.0: deepAssign mutates position object in-place', () => {
      const state = { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0 } } } as any
      const diff = { players: { p1: { position: { x: 10, z: -3 } } } }
      deepAssign_060(state, diff)
      // 0.6.0 mutates the EXISTING position object
      expect(state.players.p1.position).toEqual({ x: 10, y: 0.5, z: -3 })
    })

    it('0.6.1: deepAssign mutates position object in-place (same behavior)', () => {
      const state = { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0 } } } as any
      const diff = { players: { p1: { position: { x: 10, z: -3 } } } }
      deepAssign_061(state, diff)
      expect(state.players.p1.position).toEqual({ x: 10, y: 0.5, z: -3 })
    })

    it('0.6.0: deepAssign preserves reference when both are plain objects', () => {
      const pos = { x: 5, y: 0.5, z: -4 }
      const state = { players: { p1: { position: pos } } } as any
      const diff = { players: { p1: { position: { x: 10 } } } }
      deepAssign_060(state, diff)
      // Same object, mutated in-place
      expect(state.players.p1.position).toBe(pos)
      expect(pos.x).toBe(10) // mutated!
    })

    it('0.6.1: deepAssign preserves reference when both are plain objects', () => {
      const pos = { x: 5, y: 0.5, z: -4 }
      const state = { players: { p1: { position: pos } } } as any
      const diff = { players: { p1: { position: { x: 10 } } } }
      deepAssign_061(state, diff)
      expect(state.players.p1.position).toBe(pos)
      expect(pos.x).toBe(10) // also mutated in-place
    })

    it('0.6.1: structuredClone when target[key] is NOT a plain object but value IS', () => {
      const state = { players: { p1: { position: 'invalid' } } } as any
      const diff = { players: { p1: { position: { x: 10, y: 0.5, z: -3 } } } }
      deepAssign_061(state, diff)
      // structuredClone kicks in because target["position"] is a string, not plain object
      expect(state.players.p1.position).toEqual({ x: 10, y: 0.5, z: -3 })
    })

    it('0.6.0: direct assignment when target[key] is NOT a plain object', () => {
      const state = { players: { p1: { position: 'invalid' } } } as any
      const newPos = { x: 10, y: 0.5, z: -3 }
      const diff = { players: { p1: { position: newPos } } }
      deepAssign_060(state, diff)
      // 0.6.0 does direct assignment — SAME reference
      expect(state.players.p1.position).toBe(newPos)
    })

    it('0.6.1: structuredClone when target[key] is undefined (new player added)', () => {
      const state = { players: {} } as any
      const newPlayer = { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0 }
      const diff = { players: { p1: newPlayer } }
      deepAssign_061(state, diff)
      // Should be a clone, not same reference
      expect(state.players.p1).not.toBe(newPlayer)
      expect(state.players.p1).toEqual(newPlayer)
    })

    it('0.6.0: new player is SAME reference (no clone)', () => {
      const state = { players: {} } as any
      const newPlayer = { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0 }
      const diff = { players: { p1: newPlayer } }
      deepAssign_060(state, diff)
      expect(state.players.p1).toBe(newPlayer)
    })
  })

  describe('structuredClone side effects in full cycle', () => {
    // The 0.6.1 structuredClone on new player objects means:
    // When a new player joins and deepAssign adds them, the state gets a CLONE.
    // But the emitToRoom passes the ORIGINAL object. If later code mutates
    // the clone (via another deepAssign), the original stays unchanged.
    // This BREAKS the reference chain that 0.6.0 relies on.

    it('0.6.0: after diff+assign, external object reflects mutations', () => {
      const state: any = { players: {} }
      const player = makePlayer('p1', 5, -4)
      const diff1 = computeDeepDiff_060(state, { players: { p1: player } } as any, 0, 3)
      if (diff1) deepAssign_060(state, diff1)

      // In 0.6.0, state.players.p1 IS player (same ref after direct assignment)
      const sameRef = state.players.p1 === player
      console.log('0.6.0 new player sameRef:', sameRef)

      // Now mutate via deepAssign (simulating a second setState)
      const diff2 = { players: { p1: { position: { x: 10 } } } }
      deepAssign_060(state, diff2)

      // Does the original player object reflect the mutation?
      console.log('0.6.0 original player.pos.x:', player.position.x)
      console.log('0.6.0 state player.pos.x:', state.players.p1.position.x)
    })

    it('0.6.1: after diff+assign, external object is ISOLATED (structuredClone)', () => {
      const state: any = { players: {} }
      const player = makePlayer('p1', 5, -4)
      const diff1 = computeDeepDiff_061(state, { players: { p1: player } } as any, 0, 3)
      if (diff1) deepAssign_061(state, diff1)

      // In 0.6.1, state.players.p1 is a CLONE (structuredClone)
      const sameRef = state.players.p1 === player
      console.log('0.6.1 new player sameRef:', sameRef)

      // Mutate via deepAssign
      const diff2 = { players: { p1: { position: { x: 10 } } } }
      deepAssign_061(state, diff2)

      // The original player object should NOT be affected
      console.log('0.6.1 original player.pos.x:', player.position.x)
      console.log('0.6.1 state player.pos.x:', state.players.p1.position.x)
    })

    it('BUG REPRODUCER: room emits object that later gets mutated differently in 0.6.0 vs 0.6.1', () => {
      // Room state — player joins
      const roomState: any = { players: {} }
      const compState: any = { players: {} }

      const newPlayer = makePlayer('p1', 5, -4, 0, 0)

      // Room adds player
      const roomDiff1 = computeDeepDiff_060(roomState, { players: { p1: newPlayer } } as any, 0, 3)
      if (roomDiff1) deepAssign_060(roomState, roomDiff1)

      // Component adds player (separate state)
      const compDiff1 = computeDeepDiff_060(compState, { players: { p1: clone(newPlayer) } } as any, 0, 3)
      if (compDiff1) deepAssign_060(compState, compDiff1)

      // Now: 5 frames of movement
      const results060: boolean[] = []
      for (let i = 1; i <= 5; i++) {
        const newPos = { x: 5 + i * 10, y: 0.5, z: -4 + i }
        const roomPlayer = roomState.players.p1
        const roomUpdate = { players: { p1: { ...roomPlayer, position: newPos, rotation: i, speed: i * 0.1 } } }
        const roomDiff = computeDeepDiff_060(roomState, roomUpdate, 0, 3)
        if (roomDiff) deepAssign_060(roomState, roomDiff)

        // emitToRoom passes newPos — in 0.6.0, deepAssign may have mutated roomState.p1.position
        // BUT newPos is a DIFFERENT object, so no issue here
        const compPlayer = compState.players.p1
        const compUpdate = { players: { p1: { ...compPlayer, position: newPos, rotation: i, speed: i * 0.1 } } }
        const compDiff = computeDeepDiff_060(compState, compUpdate as any, 0, 3)
        results060.push(!!(compDiff?.players as any)?.p1?.position)
        if (compDiff) deepAssign_060(compState, compDiff)
      }

      // Same test with 0.6.1
      const roomState2: any = { players: {} }
      const compState2: any = { players: {} }

      const roomDiff1b = computeDeepDiff_061(roomState2, { players: { p1: clone(newPlayer) } } as any, 0, 3)
      if (roomDiff1b) deepAssign_061(roomState2, roomDiff1b)

      const compDiff1b = computeDeepDiff_061(compState2, { players: { p1: clone(newPlayer) } } as any, 0, 3)
      if (compDiff1b) deepAssign_061(compState2, compDiff1b)

      const results061: boolean[] = []
      for (let i = 1; i <= 5; i++) {
        const newPos = { x: 5 + i * 10, y: 0.5, z: -4 + i }
        const roomPlayer2 = roomState2.players.p1
        const roomUpdate2 = { players: { p1: { ...roomPlayer2, position: newPos, rotation: i, speed: i * 0.1 } } }
        const roomDiff2 = computeDeepDiff_061(roomState2, roomUpdate2, 0, 3)
        if (roomDiff2) deepAssign_061(roomState2, roomDiff2)

        const compPlayer2 = compState2.players.p1
        const compUpdate2 = { players: { p1: { ...compPlayer2, position: newPos, rotation: i, speed: i * 0.1 } } }
        const compDiff2 = computeDeepDiff_061(compState2, compUpdate2 as any, 0, 3)
        results061.push(!!(compDiff2?.players as any)?.p1?.position)
        if (compDiff2) deepAssign_061(compState2, compDiff2)
      }

      console.log('0.6.0 positions detected:', results060.map(b => b ? '✓' : '✗').join(''))
      console.log('0.6.1 positions detected:', results061.map(b => b ? '✓' : '✗').join(''))

      expect(results060.filter(Boolean).length).toBe(5)
      expect(results061.filter(Boolean).length).toBe(5)
    })

    it('BUG REPRODUCER: SAME position object passed to room AND emitToRoom (exact server flow)', () => {
      // This is the EXACT scenario from KartRaceRoom.movePlayer:
      // const position = payload.position (from client)
      // players[userId] = { ...player, position, rotation, speed }
      // this.setState({ players })  ← deepAssign mutates room.state
      // this._manager.emitToRoom(id, 'player:moved', { position, ... })
      //   ↑ SAME position object passed to both setState and emitToRoom

      for (const [label, diffFn, assignFn] of [
        ['0.6.0', computeDeepDiff_060, deepAssign_060],
        ['0.6.1', computeDeepDiff_061, deepAssign_061],
      ] as const) {
        const roomState: any = { players: { p1: makePlayer('p1', 5, -4) } }
        const compState: any = clone(roomState)
        const results: boolean[] = []

        for (let i = 1; i <= 10; i++) {
          // Client sends position
          const clientPos = { x: 5 + i * 5, y: 0.5, z: -4 + i * 0.5 }

          // KartRaceRoom.movePlayer:
          const roomPlayer = roomState.players.p1
          const roomUpdate = {
            players: { p1: { ...roomPlayer, position: clientPos, rotation: i * 0.1, speed: 0.5 } }
          }

          // Room setState (diff + deepAssign on room.state)
          const roomDiff = (diffFn as any)(roomState, roomUpdate, 0, 3)
          if (roomDiff) (assignFn as any)(roomState, roomDiff)

          // emitToRoom passes the SAME clientPos object
          // LiveKartGame handler receives it
          const compPlayer = compState.players.p1
          const compUpdate = {
            players: { p1: { ...compPlayer, position: clientPos, rotation: i * 0.1, speed: 0.5 } }
          }

          // Component setState (diff + deepAssign on comp._state)
          const compDiff = (diffFn as any)(compState, compUpdate, 0, 3)
          const hasPos = !!(compDiff?.players as any)?.p1?.position
          results.push(hasPos)
          if (compDiff) (assignFn as any)(compState, compDiff)
        }

        console.log(`${label} SAME-OBJ: [${results.map(b => b ? '✓' : '✗').join('')}] (${results.filter(Boolean).length}/10)`)
        // ALL 10 must detect position
        expect(results.filter(Boolean).length).toBe(10)
      }
    })
  })

  describe('Stress test: 30 varied diff scenarios', () => {
    // Cada cenário testa uma variação diferente de mudança no state de players
    // para encontrar divergências entre 0.6.0 e 0.6.1

    const scenarios: { name: string; prev: any; next: any }[] = [
      // 1-5: Mudanças simples de position
      { name: '1: position.x muda', prev: { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0 } } }, next: { players: { p1: { position: { x: 10, y: 0.5, z: -4 }, rotation: 0, speed: 0 } } } },
      { name: '2: position.z muda', prev: { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0 } } }, next: { players: { p1: { position: { x: 5, y: 0.5, z: 10 }, rotation: 0, speed: 0 } } } },
      { name: '3: position.x e z mudam', prev: { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0 } } }, next: { players: { p1: { position: { x: 99, y: 0.5, z: 99 }, rotation: 0, speed: 0 } } } },
      { name: '4: position inteira muda (todos os eixos)', prev: { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0 } } }, next: { players: { p1: { position: { x: 100, y: 10, z: 200 }, rotation: 0, speed: 0 } } } },
      { name: '5: position igual (sem mudança)', prev: { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0 } } }, next: { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0 } } } },

      // 6-10: Position + outros campos
      { name: '6: position + rotation mudam', prev: { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0 } } }, next: { players: { p1: { position: { x: 20, y: 0.5, z: 3 }, rotation: 1.5, speed: 0 } } } },
      { name: '7: position + speed mudam', prev: { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0 } } }, next: { players: { p1: { position: { x: 15, y: 0.5, z: 2 }, rotation: 0, speed: 0.8 } } } },
      { name: '8: position + rotation + speed mudam', prev: { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0 } } }, next: { players: { p1: { position: { x: 30, y: 0.5, z: 10 }, rotation: 3.14, speed: 0.6 } } } },
      { name: '9: só rotation muda', prev: { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0 } } }, next: { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 2.0, speed: 0 } } } },
      { name: '10: só speed muda', prev: { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0 } } }, next: { players: { p1: { position: { x: 5, y: 0.5, z: -4 }, rotation: 0, speed: 0.5 } } } },

      // 11-15: Múltiplos players
      { name: '11: 2 players, ambos mudam position', prev: { players: { p1: { position: { x: 5, y: 0, z: -4 }, rotation: 0 }, p2: { position: { x: 10, y: 0, z: 4 }, rotation: 0 } } }, next: { players: { p1: { position: { x: 50, y: 0, z: -3 }, rotation: 0 }, p2: { position: { x: 60, y: 0, z: 3 }, rotation: 0 } } } },
      { name: '12: 2 players, só p2 muda', prev: { players: { p1: { position: { x: 5, y: 0, z: -4 }, rotation: 0 }, p2: { position: { x: 10, y: 0, z: 4 }, rotation: 0 } } }, next: { players: { p1: { position: { x: 5, y: 0, z: -4 }, rotation: 0 }, p2: { position: { x: 99, y: 0, z: 99 }, rotation: 0 } } } },
      { name: '13: 3 players, todos mudam', prev: { players: { p1: { position: { x: 1, y: 0, z: 1 } }, p2: { position: { x: 2, y: 0, z: 2 } }, p3: { position: { x: 3, y: 0, z: 3 } } } }, next: { players: { p1: { position: { x: 10, y: 0, z: 10 } }, p2: { position: { x: 20, y: 0, z: 20 } }, p3: { position: { x: 30, y: 0, z: 30 } } } } },
      { name: '14: player novo aparece', prev: { players: { p1: { position: { x: 5, y: 0, z: -4 } } } }, next: { players: { p1: { position: { x: 5, y: 0, z: -4 } }, p2: { position: { x: 10, y: 0, z: 4 } } } } },
      { name: '15: player removido (0.6.1 only)', prev: { players: { p1: { position: { x: 5, y: 0, z: -4 } }, p2: { position: { x: 10, y: 0, z: 4 } } } }, next: { players: { p1: { position: { x: 5, y: 0, z: -4 } } } } },

      // 16-20: Objetos nested mais profundos
      { name: '16: position dentro de stats nested', prev: { players: { p1: { stats: { position: { x: 0, y: 0, z: 0 } } } } }, next: { players: { p1: { stats: { position: { x: 10, y: 0, z: 10 } } } } } },
      { name: '17: campo extra no player', prev: { players: { p1: { position: { x: 5, y: 0, z: -4 }, hp: 100 } } }, next: { players: { p1: { position: { x: 10, y: 0, z: 2 }, hp: 80 } } } },
      { name: '18: null no position (substituição)', prev: { players: { p1: { position: { x: 5, y: 0, z: -4 } } } }, next: { players: { p1: { position: null } } } },
      { name: '19: position era null, agora é objeto', prev: { players: { p1: { position: null, rotation: 0 } } }, next: { players: { p1: { position: { x: 10, y: 0, z: 5 }, rotation: 0 } } } },
      { name: '20: position muda de objeto para número', prev: { players: { p1: { position: { x: 5, y: 0, z: -4 } } } }, next: { players: { p1: { position: 42 } } } },

      // 21-25: Edge cases de referência
      { name: '21: mesma referência de position (noop)', prev: (() => { const p = { x: 5, y: 0, z: -4 }; return { players: { p1: { position: p } } } })(), next: (() => { const p = { x: 5, y: 0, z: -4 }; return { players: { p1: { position: p } } } })() },
      { name: '22: array no lugar de objeto', prev: { players: { p1: { position: { x: 5, y: 0, z: -4 } } } }, next: { players: { p1: { position: [10, 0, 5] } } } },
      { name: '23: objeto vazio como position', prev: { players: { p1: { position: { x: 5, y: 0, z: -4 } } } }, next: { players: { p1: { position: {} } } } },
      { name: '24: float precision change', prev: { players: { p1: { position: { x: 5.000000001, y: 0.5, z: -4.000000001 } } } }, next: { players: { p1: { position: { x: 5.000000002, y: 0.5, z: -4.000000002 } } } } },
      { name: '25: valores muito grandes', prev: { players: { p1: { position: { x: 0, y: 0, z: 0 } } } }, next: { players: { p1: { position: { x: 999999.99, y: 999999.99, z: 999999.99 } } } } },

      // 26-30: Cenários de ciclo completo (diff → assign → diff)
      { name: '26: campo undefined no next', prev: { players: { p1: { position: { x: 5, y: 0, z: -4 }, rotation: 1 } } }, next: { players: { p1: { position: { x: 10, y: 0, z: 2 }, rotation: undefined } } } },
      { name: '27: key vazia como player id', prev: { players: { '': { position: { x: 0, y: 0, z: 0 } } } }, next: { players: { '': { position: { x: 10, y: 0, z: 10 } } } } },
      { name: '28: campo extra no position', prev: { players: { p1: { position: { x: 5, y: 0, z: -4 } } } }, next: { players: { p1: { position: { x: 10, y: 0, z: 2, w: 1 } } } } },
      { name: '29: position com campo removido', prev: { players: { p1: { position: { x: 5, y: 0, z: -4, w: 1 } } } }, next: { players: { p1: { position: { x: 10, y: 0, z: 2 } } } } },
      { name: '30: objeto profundo (5 níveis)', prev: { a: { b: { c: { d: { e: { x: 1 } } } } } }, next: { a: { b: { c: { d: { e: { x: 2 } } } } } } },
    ]

    for (const maxDepth of [3, 4, 5]) {
      describe(`maxDepth=${maxDepth}`, () => {
        for (const { name, prev, next } of scenarios) {
          it(`${name}`, () => {
            const prev060 = clone(prev)
            const prev061 = clone(prev)
            const next060 = clone(next)
            const next061 = clone(next)

            const diff060 = computeDeepDiff_060(prev060, next060, 0, maxDepth)
            const diff061 = computeDeepDiff_061(prev061, next061, 0, maxDepth)

            // Aplicar diff e verificar estado final
            if (diff060) deepAssign_060(prev060, diff060)
            if (diff061) deepAssign_061(prev061, diff061)

            // Comparar resultados
            const d060 = JSON.stringify(diff060)
            const d061 = JSON.stringify(diff061)
            const state060 = JSON.stringify(prev060)
            const state061 = JSON.stringify(prev061)

            if (d060 !== d061) {
              console.log(`  ⚠️ DIFF DIVERGE [${name}] depth=${maxDepth}`)
              console.log(`    0.6.0 diff: ${d060}`)
              console.log(`    0.6.1 diff: ${d061}`)
            }
            if (state060 !== state061) {
              console.log(`  ⚠️ STATE DIVERGE [${name}] depth=${maxDepth}`)
              console.log(`    0.6.0 state: ${state060}`)
              console.log(`    0.6.1 state: ${state061}`)
            }

            // Cenários com divergência conhecida entre 0.6.0 e 0.6.1:
            // - #15: player removido (0.6.1 detecta remoção, 0.6.0 não)
            // - #18: position=null (0.6.1 deleta key em depth>0, 0.6.0 atribui null)
            // - #23: position={} vazio (0.6.1 emite x:null,y:null,z:null para keys ausentes)
            // - #26: campo undefined (0.6.1 trata como remoção, 0.6.0 ignora)
            // - #29: campo removido do position (0.6.1 emite w:null, 0.6.0 ignora)
            const knownDivergent = ['removido', 'null no position', 'objeto vazio', 'undefined', 'campo removido']
            const isDivergent = knownDivergent.some(k => name.includes(k))
            if (!isDivergent) {
              expect(state060).toBe(state061)
            }
          })
        }
      })
    }
  })

  describe('Complex game state stress tests', () => {
    // Estado completo de KartPlayer como no jogo real
    function fullPlayer(id: string, x: number, z: number, overrides: any = {}) {
      return {
        id,
        nickname: `Player_${id}`,
        color: '#ff0000',
        weight: 3,
        position: { x, y: 0.5, z },
        rotation: 0,
        speed: 0,
        lap: 0,
        checkpoint: 0,
        finished: false,
        finishTime: null,
        ready: true,
        driftStage: 0,
        heldItem: null,
        activeEffect: null,
        stunUntil: null,
        ...overrides,
      }
    }

    // Estado completo do LiveKartGame como no jogo real
    function fullGameState(players: Record<string, any>) {
      return {
        nickname: 'TestHost',
        screen: 'racing' as const,
        availableRooms: [{ id: 'room-1', name: 'Test', host: 'TestHost', players: Object.keys(players).length, maxPlayers: 8, status: 'racing', track: 'speedway', trackName: 'Speedway', createdAt: 1000 }],
        onlineCount: Object.keys(players).length,
        currentRoomId: 'room-1',
        currentRoomName: 'Test Room',
        currentTrackId: 'speedway',
        players,
        raceStatus: 'racing' as const,
        countdown: 0,
        myId: Object.keys(players)[0] || '',
        hostId: Object.keys(players)[0] || '',
        raceStartTime: 1000,
        totalLaps: 3,
        rankings: [] as any[],
        forcedPosition: null as any,
        worldObjects: {} as Record<string, any>,
      }
    }

    function runCycle(
      diffFn: typeof computeDeepDiff_060,
      assignFn: typeof deepAssign_060,
      state: any,
      updates: any[],
      maxDepth = 3,
    ) {
      const results: { diff: any; hasPosition: Record<string, boolean> }[] = []
      for (const update of updates) {
        const diff = diffFn(state, update, 0, maxDepth)
        const hasPosition: Record<string, boolean> = {}
        if (diff?.players) {
          for (const [pid, p] of Object.entries(diff.players as Record<string, any>)) {
            hasPosition[pid] = p && typeof p === 'object' && 'position' in p
          }
        }
        results.push({ diff: diff ? clone(diff) : null, hasPosition })
        if (diff) assignFn(state, diff)
      }
      return results
    }

    describe('Full game state with all KartPlayer fields', () => {
      it('position change detected in full player object', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          const state = fullGameState({
            p1: fullPlayer('p1', 5, -4),
            p2: fullPlayer('p2', 10, 4),
          })
          const s = clone(state) as any

          // p1 moves
          const update = clone(s)
          update.players.p1 = { ...s.players.p1, position: { x: 50, y: 0.5, z: 10 }, rotation: 1.5, speed: 0.7 }

          const diff = (diffFn as any)(s, update, 0, 3)
          console.log(`${label} full-state diff keys:`, diff ? Object.keys((diff.players as any)?.p1 || {}) : 'null')
          expect((diff?.players as any)?.p1?.position).toBeDefined()
        }
      })

      it('20 frames of movement with full game state', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          const state = fullGameState({
            p1: fullPlayer('p1', 5, -4),
            p2: fullPlayer('p2', 10, 4),
            p3: fullPlayer('p3', 15, -4),
            p4: fullPlayer('p4', 20, 4),
          }) as any

          const posDetected = { p1: 0, p2: 0, p3: 0, p4: 0 }
          for (let frame = 1; frame <= 20; frame++) {
            const update = clone(state)
            // All 4 players move
            for (const pid of ['p1', 'p2', 'p3', 'p4']) {
              const p = update.players[pid]
              update.players[pid] = {
                ...p,
                position: { x: p.position.x + frame * 2, y: 0.5, z: p.position.z + frame * 0.3 },
                rotation: p.rotation + frame * 0.1,
                speed: Math.min(0.8, frame * 0.04),
              }
            }
            const diff = (diffFn as any)(state, update, 0, 3)
            if (diff?.players) {
              for (const pid of ['p1', 'p2', 'p3', 'p4']) {
                if ((diff.players as any)[pid]?.position) (posDetected as any)[pid]++
              }
            }
            if (diff) (assignFn as any)(state, diff)
          }
          console.log(`${label} 4-player 20 frames:`, posDetected)
          for (const pid of ['p1', 'p2', 'p3', 'p4']) {
            expect((posDetected as any)[pid]).toBe(20)
          }
        }
      })
    })

    describe('Item system interactions', () => {
      it('heldItem changes while position also changes', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          const state = { players: { p1: fullPlayer('p1', 5, -4) } } as any
          const update = clone(state)
          update.players.p1 = {
            ...state.players.p1,
            position: { x: 30, y: 0.5, z: 10 },
            heldItem: { id: 'banana', name: 'Banana', usedAt: null },
            speed: 0.5,
          }
          const diff = (diffFn as any)(state, update, 0, 3)
          console.log(`${label} item+pos diff keys:`, Object.keys((diff?.players as any)?.p1 || {}))
          expect((diff?.players as any)?.p1?.position).toBeDefined()
          expect((diff?.players as any)?.p1?.heldItem).toBeDefined()
        }
      })

      it('heldItem set to null (item used) while moving', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          const state = { players: { p1: fullPlayer('p1', 5, -4, { heldItem: { id: 'turbo', name: 'Turbo' } }) } } as any
          const s = clone(state)
          const update = clone(s)
          update.players.p1 = { ...s.players.p1, position: { x: 20, y: 0.5, z: 3 }, heldItem: null, speed: 0.8 }

          const diff = (diffFn as any)(s, update, 0, 3)
          if (diff) (assignFn as any)(s, diff)

          console.log(`${label} item→null: diff keys=${Object.keys((diff?.players as any)?.p1 || {})}`)
          console.log(`${label} item→null: state.heldItem=${JSON.stringify(s.players.p1.heldItem)}`)
          // Position must still be in diff
          expect((diff?.players as any)?.p1?.position).toBeDefined()
        }
      })

      it('activeEffect added while position changes', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          const state = { players: { p1: fullPlayer('p1', 5, -4) } } as any
          const s = clone(state)
          const update = clone(s)
          update.players.p1 = {
            ...s.players.p1,
            position: { x: 40, y: 0.5, z: -2 },
            activeEffect: { id: 'shield', expiresAt: Date.now() + 5000 },
            stunUntil: Date.now() + 2000,
          }
          const diff = (diffFn as any)(s, update, 0, 3)
          console.log(`${label} effect+pos: diff keys=${Object.keys((diff?.players as any)?.p1 || {})}`)
          expect((diff?.players as any)?.p1?.position).toBeDefined()
          expect((diff?.players as any)?.p1?.activeEffect).toBeDefined()
        }
      })
    })

    describe('worldObjects + player state simultaneous changes', () => {
      it('bomb added to world while player moves', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          const state = fullGameState({ p1: fullPlayer('p1', 5, -4) }) as any
          state.worldObjects = {}
          const s = clone(state)

          const update = clone(s)
          update.players.p1 = { ...s.players.p1, position: { x: 20, y: 0.5, z: 3 } }
          update.worldObjects = { 'bomb-1': { id: 'bomb-1', type: 'bomb', position: { x: 50, y: 0, z: 10 }, createdAt: Date.now() } }

          const diff = (diffFn as any)(s, update, 0, 3)
          console.log(`${label} bomb+move: has position=${!!(diff?.players as any)?.p1?.position}, has worldObj=${!!diff?.worldObjects}`)
          expect((diff?.players as any)?.p1?.position).toBeDefined()
          expect(diff?.worldObjects).toBeDefined()
        }
      })

      it('bomb removed (null) from worldObjects', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          const state = fullGameState({ p1: fullPlayer('p1', 5, -4) }) as any
          state.worldObjects = { 'bomb-1': { id: 'bomb-1', type: 'bomb', position: { x: 50, y: 0, z: 10 } } }
          const s = clone(state)

          const update = clone(s)
          update.worldObjects = { 'bomb-1': null }
          update.players.p1 = { ...s.players.p1, position: { x: 25, y: 0.5, z: 5 } }

          const diff = (diffFn as any)(s, update, 0, 3)
          if (diff) (assignFn as any)(s, diff)

          console.log(`${label} bomb-remove: worldObjects=${JSON.stringify(s.worldObjects)}, hasBomb=${'bomb-1' in s.worldObjects}`)
          // 0.6.0: worldObjects['bomb-1'] = null (kept)
          // 0.6.1: delete worldObjects['bomb-1']
        }
      })
    })

    describe('Race state transitions', () => {
      it('race status changes while players update', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          const state = fullGameState({ p1: fullPlayer('p1', 5, -4), p2: fullPlayer('p2', 10, 4) }) as any
          const s = clone(state)

          const update = clone(s)
          update.raceStatus = 'finished'
          update.rankings = [{ id: 'p1', nickname: 'P1', time: 60000 }]
          update.players.p1 = { ...s.players.p1, finished: true, finishTime: 60000, position: { x: 0, y: 0.5, z: 0 } }

          const diff = (diffFn as any)(s, update, 0, 3)
          console.log(`${label} race-finish: diff keys=${diff ? Object.keys(diff) : 'null'}`)
          expect(diff?.raceStatus).toBe('finished')
          expect((diff?.players as any)?.p1?.finished).toBe(true)
        }
      })

      it('lap completion with checkpoint reset', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          const state = { players: { p1: fullPlayer('p1', 5, -4, { lap: 1, checkpoint: 15 }) } } as any
          const s = clone(state)

          const update = clone(s)
          update.players.p1 = { ...s.players.p1, lap: 2, checkpoint: 0, position: { x: 3, y: 0.5, z: 0 } }

          const diff = (diffFn as any)(s, update, 0, 3)
          console.log(`${label} lap-complete: diff p1 keys=${Object.keys((diff?.players as any)?.p1 || {})}`)
          expect((diff?.players as any)?.p1?.lap).toBe(2)
          expect((diff?.players as any)?.p1?.checkpoint).toBe(0)
          expect((diff?.players as any)?.p1?.position).toBeDefined()
        }
      })
    })

    describe('Drift and stun state changes at high frequency', () => {
      it('driftStage changes rapidly with position updates', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          const state = { players: { p1: fullPlayer('p1', 5, -4) } } as any
          const driftSequence = [0, 1, 1, 2, 2, 2, 3, 3, 0, 0, 1, 2, 3, 0, 0]
          let posDetected = 0
          let driftDetected = 0

          for (let i = 0; i < driftSequence.length; i++) {
            const update = clone(state)
            update.players.p1 = {
              ...state.players.p1,
              position: { x: 5 + i * 3, y: 0.5, z: -4 + i * 0.5 },
              rotation: i * 0.2,
              speed: 0.3 + i * 0.02,
              driftStage: driftSequence[i],
            }
            const diff = (diffFn as any)(state, update, 0, 3)
            if ((diff?.players as any)?.p1?.position) posDetected++
            if ((diff?.players as any)?.p1?.driftStage !== undefined) driftDetected++
            if (diff) (assignFn as any)(state, diff)
          }
          console.log(`${label} drift-sequence: pos=${posDetected}/${driftSequence.length}, drift=${driftDetected}/${driftSequence.length}`)
          // First frame: x=5+0*3=5 same as initial spawn — no position change detected
          expect(posDetected).toBeGreaterThanOrEqual(driftSequence.length - 1)
        }
      })

      it('stunUntil set and cleared with concurrent position updates', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          const state = { players: { p1: fullPlayer('p1', 5, -4) } } as any
          const s = clone(state)

          // Stun applied
          const update1 = clone(s)
          update1.players.p1 = { ...s.players.p1, stunUntil: Date.now() + 3000, position: { x: 10, y: 0.5, z: -3 }, speed: 0 }
          const diff1 = (diffFn as any)(s, update1, 0, 3)
          if (diff1) (assignFn as any)(s, diff1)

          // Stun cleared
          const update2 = clone(s)
          update2.players.p1 = { ...s.players.p1, stunUntil: null, position: { x: 12, y: 0.5, z: -2 }, speed: 0.3 }
          const diff2 = (diffFn as any)(s, update2, 0, 3)

          console.log(`${label} stun-cycle: diff1 keys=${Object.keys((diff1?.players as any)?.p1 || {})}, diff2 keys=${Object.keys((diff2?.players as any)?.p1 || {})}`)
          expect((diff1?.players as any)?.p1?.stunUntil).toBeDefined()
          expect((diff2?.players as any)?.p1?.position).toBeDefined()
        }
      })
    })

    describe('8 players simultaneous updates (worst case)', () => {
      it('all 8 players move simultaneously', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          const players: Record<string, any> = {}
          for (let i = 0; i < 8; i++) {
            players[`p${i}`] = fullPlayer(`p${i}`, 5 + i * 5, i % 2 === 0 ? -4 : 4)
          }
          const state = { players } as any
          let allDetected = true

          for (let frame = 1; frame <= 30; frame++) {
            const update = clone(state)
            for (let i = 0; i < 8; i++) {
              const pid = `p${i}`
              update.players[pid] = {
                ...state.players[pid],
                position: { x: state.players[pid].position.x + Math.sin(frame * 0.1 + i) * 5, y: 0.5, z: state.players[pid].position.z + Math.cos(frame * 0.1 + i) * 5 },
                rotation: frame * 0.1 + i * 0.5,
                speed: 0.3 + Math.sin(frame * 0.05) * 0.2,
                driftStage: frame % 4 === 0 ? (i % 4) : 0,
              }
            }
            const diff = (diffFn as any)(state, update, 0, 3)
            if (diff?.players) {
              for (let i = 0; i < 8; i++) {
                if (!(diff.players as any)[`p${i}`]?.position) allDetected = false
              }
            } else {
              allDetected = false
            }
            if (diff) (assignFn as any)(state, diff)
          }
          console.log(`${label} 8-player 30-frame: allDetected=${allDetected}`)
          expect(allDetected).toBe(true)
        }
      })
    })

    describe('Partial updates (spread com campos faltando)', () => {
      // Este é o cenário mais perigoso: spread que deixa campos undefined
      it('spread de player sem todos os campos (simula bug real)', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          const state = { players: { p1: fullPlayer('p1', 5, -4, { heldItem: { id: 'banana', name: 'Banana' } }) } } as any
          const s = clone(state)

          // Simula um update que só tem position, rotation, speed
          // Os outros campos vêm do spread de player que pode ter undefined
          const player = s.players.p1
          const partialUpdate = {
            players: {
              p1: {
                ...player,
                position: { x: 20, y: 0.5, z: 3 },
                rotation: 1.5,
                speed: 0.6,
              }
            }
          }

          const diff = (diffFn as any)(s, partialUpdate, 0, 3)
          if (diff) (assignFn as any)(s, diff)

          console.log(`${label} partial-update: heldItem=${JSON.stringify(s.players.p1.heldItem)}, pos=${JSON.stringify(s.players.p1.position)}`)
          // heldItem should NOT be removed
          expect(s.players.p1.heldItem).toBeDefined()
          expect(s.players.p1.heldItem).not.toBeNull()
          expect(s.players.p1.position.x).toBe(20)
        }
      })

      it('FOOTGUN: partial update without spread DELETES missing fields', () => {
        // computeDeepDiff at depth>0 treats missing keys as removals.
        // Callers MUST use { ...player, position: newPos } instead of { position: newPos }
        // This test documents the expected behavior — NOT a bug, but a footgun.
        const state = { players: { p1: fullPlayer('p1', 5, -4, { lap: 2, checkpoint: 10 }) } } as any
        const s = clone(state)

        // WRONG: partial update without spread — will delete everything else
        const update = { players: { p1: { position: { x: 30, y: 0.5, z: 5 }, speed: 0.7 } } }
        const diff = computeDeepDiff_061(s, update, 0, 3)
        if (diff) deepAssign_061(s, diff)

        // Fields not in the partial update are DELETED (by design)
        expect('lap' in s.players.p1).toBe(false)
        expect('checkpoint' in s.players.p1).toBe(false)
      })

      it('CORRECT: full spread preserves all fields', () => {
        const state = { players: { p1: fullPlayer('p1', 5, -4, { lap: 2, checkpoint: 10 }) } } as any
        const s = clone(state)

        // CORRECT: spread operator includes all existing fields
        const update = { players: { p1: { ...s.players.p1, position: { x: 30, y: 0.5, z: 5 }, speed: 0.7 } } }
        const diff = computeDeepDiff_061(s, update, 0, 3)
        if (diff) deepAssign_061(s, diff)

        // All fields preserved because spread included them
        expect(s.players.p1.lap).toBe(2)
        expect(s.players.p1.checkpoint).toBe(10)
        expect(s.players.p1.nickname).toBe('Player_p1')
        expect(s.players.p1.position.x).toBe(30)
      })

      it('heldItem: null with full spread works correctly', () => {
        const state = { players: { p1: fullPlayer('p1', 5, -4, { heldItem: { id: 'turbo', name: 'Turbo' } }) } } as any
        const s = clone(state)

        // Full spread + heldItem: null
        const update = clone(s)
        update.players.p1 = { ...s.players.p1, heldItem: null, position: { x: 20, y: 0.5, z: 3 } }

        const diff = computeDeepDiff_061(s, update, 0, 3)
        if (diff) deepAssign_061(s, diff)

        // heldItem is at depth 2 — null means deletion
        // Caller should use a sentinel like { id: 'none' } if they want to keep the key
        expect('heldItem' in s.players.p1).toBe(false)
      })

      it('position set to empty object — x/y/z deleted as expected', () => {
        const state = { players: { p1: { position: { x: 5, y: 0, z: -4 }, rotation: 0 } } } as any
        const s = clone(state)

        const update = { players: { p1: { position: {}, rotation: 0 } } }
        const diff = computeDeepDiff_061(s, update, 0, 3)

        // At depth 3, x/y/z are missing from {} → emitted as null → deleted
        const posDiff = (diff?.players as any)?.p1?.position
        expect(posDiff).toEqual({ x: null, y: null, z: null })
      })
    })

    describe('Double-diff with full game state (actual LiveKartGame flow)', () => {
      it('room diff + component diff: 30 frames, full state', () => {
        for (const [label, diffFn, assignFn] of [
          ['0.6.0', computeDeepDiff_060, deepAssign_060],
          ['0.6.1', computeDeepDiff_061, deepAssign_061],
        ] as const) {
          // Room state (KartRaceRoom.state)
          const roomState = {
            players: {
              p1: fullPlayer('p1', 5, -4),
              p2: fullPlayer('p2', 10, 4),
            },
            status: 'racing',
            countdown: 0,
            track: 'speedway',
            maxPlayers: 8,
            hostId: 'p1',
            raceStartTime: 1000,
            totalLaps: 3,
            worldObjects: {},
          } as any

          // Component state (LiveKartGame._state) — subset focused on players
          const compState = fullGameState(clone(roomState.players)) as any

          let posDetected = 0
          let posLost = 0
          let fieldsLost = 0

          for (let frame = 1; frame <= 30; frame++) {
            // p2 moves
            const newPos = { x: 10 + frame * 3, y: 0.5, z: 4 - frame * 0.2 }
            const roomPlayer = roomState.players.p2

            // Step 1: Room setState
            const roomUpdate = {
              players: {
                ...roomState.players,
                p2: { ...roomPlayer, position: newPos, rotation: frame * 0.1, speed: 0.5 }
              }
            }
            const roomDiff = (diffFn as any)(roomState, roomUpdate, 0, 3)
            if (roomDiff) (assignFn as any)(roomState, roomDiff)

            // Step 2: emitToRoom — same newPos object
            // Step 3: LiveKartGame handler
            const compPlayer = compState.players.p2
            if (!compPlayer) { posLost++; continue }

            const compUpdate = {
              players: {
                ...compState.players,
                p2: { ...compPlayer, position: newPos, rotation: frame * 0.1, speed: 0.5, driftStage: frame % 4 === 0 ? 1 : 0 }
              }
            }
            const compDiff = (diffFn as any)(compState, compUpdate, 0, 3)
            const hasPos = !!(compDiff?.players as any)?.p2?.position
            if (hasPos) posDetected++
            else posLost++

            // Check if p2 still has all fields after deepAssign
            if (compDiff) (assignFn as any)(compState, compDiff)
            const p2 = compState.players.p2
            if (!p2 || !('lap' in p2) || !('nickname' in p2)) fieldsLost++
          }

          console.log(`${label} double-diff 30f: posDetected=${posDetected}, posLost=${posLost}, fieldsLost=${fieldsLost}`)
          expect(posDetected).toBe(30)
          expect(fieldsLost).toBe(0)
        }
      })
    })
  })

  describe('Key removal regression (#3)', () => {
    it('0.6.1: detects player removal', () => {
      const state: any = { players: { p1: makePlayer('p1', 5, -4), p2: makePlayer('p2', 10, 4) } }
      const update = { players: { p1: state.players.p1 } } // p2 removed
      const diff = computeDeepDiff_061(state, update, 0, 3)
      expect((diff?.players as any)?.p2).toBeNull()
    })

    it('0.6.0: does NOT detect player removal (known limitation)', () => {
      const state: any = { players: { p1: makePlayer('p1', 5, -4), p2: makePlayer('p2', 10, 4) } }
      const update = { players: { p1: state.players.p1 } }
      const diff = computeDeepDiff_060(state, update, 0, 3)
      // 0.6.0 doesn't detect removals — this is the known limitation
      expect((diff?.players as any)?.p2).toBeUndefined()
    })
  })
})
