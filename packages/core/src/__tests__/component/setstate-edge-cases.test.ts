// Regression suite for issue #6 edge cases in setState / computeDeepDiff /
// deepAssign. Originally bug-hunt/setstate-edge-cases.test.ts; promoted here
// after the fixes for top-level null and undefined drift.
//
// Sections:
//   - "fixes #6": assertions encode the post-fix behaviour.
//   - "documented limitations": behaviours that are intentional and have
//     no fix today (shallow proxy, Map/Set-as-state, Date reference compare).
//     Captured here so any future change is an explicit decision.
//   - "existing behaviour preserved": other edge cases that already worked
//     but are cheap to keep locked down.

import { describe, it, expect, vi } from 'vitest'
import { LiveComponent } from '../../component/LiveComponent'
import { computeDeepDiff, deepAssign } from '../../utils/deepDiff'
import type { FluxStackWebSocket } from '../../transport/types'

// ===== Helpers (adapted from ComponentStateManager.deepDiff.test.ts) =====

function createMockWs(): FluxStackWebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    data: {} as any,
    remoteAddress: '127.0.0.1',
  } as any
}

const flush = () => new Promise<void>(r => queueMicrotask(r))

function extractDeltas(ws: FluxStackWebSocket): any[] {
  const deltas: any[] = []
  for (const call of (ws.send as any).mock.calls) {
    try {
      const parsed = JSON.parse(call[0])
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      for (const msg of messages) {
        if (msg.type === 'STATE_DELTA') {
          deltas.push(msg.payload.delta)
        }
      }
    } catch {}
  }
  return deltas
}

// ==========================================================================
// fixes #6 — setState({ x: null }) preserves the null value
// ==========================================================================
describe('fixes #6: top-level null is a real value, not a deletion', () => {
  it('setState({ selected: null }) keeps the key and stores null on the server', async () => {
    type S = { selected: { id: string } | null; other: number }
    class C extends LiveComponent<S> {
      static componentName = 'NullTopLevelComponent'
      static publicActions = [] as const
      static defaultState: S = { selected: { id: 'abc' }, other: 1 }
    }
    const ws = createMockWs()
    const comp = new C({}, ws)

    comp.setState({ selected: null })
    await flush()

    const state = comp.getSerializableState() as any
    expect('selected' in state).toBe(true)
    expect(state.selected).toBeNull()

    // And the delta carries the null through to the wire so the client
    // can apply it (client-side deepMerge also knows top-level null = set).
    const deltas = extractDeltas(ws)
    expect(deltas.length).toBe(1)
    expect(deltas[0]).toEqual({ selected: null })
  })

  it('setState({ x: null }) when x was already a primitive', async () => {
    type S = { label: string | null }
    class C extends LiveComponent<S> {
      static componentName = 'NullPrimitiveComponent'
      static publicActions = [] as const
      static defaultState: S = { label: 'hello' }
    }
    const ws = createMockWs()
    const comp = new C({}, ws)

    comp.setState({ label: null })
    await flush()

    expect((comp.getSerializableState() as any).label).toBeNull()
    const deltas = extractDeltas(ws)
    expect(deltas[0]).toEqual({ label: null })
  })

  it('nested null in a Record<string, T> still deletes the key', async () => {
    // The issue #1/#3 scenario: player B leaves a game room. This is the
    // whole reason deepAssign has null-as-deletion semantics in nested
    // contexts. The top-level fix in #6 must not break this.
    type Player = { name: string; x: number }
    type S = { players: Record<string, Player>; hostId: string }
    class C extends LiveComponent<S> {
      static componentName = 'NestedNullComponent'
      static publicActions = [] as const
      static defaultState: S = {
        players: { A: { name: 'A', x: 0 }, B: { name: 'B', x: 5 } },
        hostId: 'A',
      }
    }
    const ws = createMockWs()
    const comp = new C({}, ws)

    comp.setState({
      players: { A: { name: 'A', x: 1 } },
      hostId: 'A',
    })
    await flush()

    const state = comp.getSerializableState() as any
    expect('B' in state.players).toBe(false)
    expect(state.players).toEqual({ A: { name: 'A', x: 1 } })

    const deltas = extractDeltas(ws)
    expect(deltas.length).toBe(1)
    // computeDeepDiff at depth > 0 emits null for removed B, and only
    // the changed A.x field.
    expect(deltas[0]).toEqual({ players: { A: { x: 1 }, B: null } })
  })
})

// ==========================================================================
// fixes #6 — undefined never crosses the wire
// ==========================================================================
describe('fixes #6: undefined values are skipped server-side to avoid wire drift', () => {
  it('setState({ x: undefined, y: 2 }) applies y and leaves x untouched', async () => {
    type S = { x: number; y: number }
    class C extends LiveComponent<S> {
      static componentName = 'UndefinedComponent'
      static publicActions = [] as const
      static defaultState: S = { x: 42, y: 1 }
    }
    const ws = createMockWs()
    const comp = new C({}, ws)

    comp.setState({ x: undefined as any, y: 2 })
    await flush()

    const state = comp.getSerializableState() as any
    // x unchanged (undefined was a no-op)
    expect(state.x).toBe(42)
    expect(state.y).toBe(2)

    const deltas = extractDeltas(ws)
    expect(deltas.length).toBe(1)
    // The delta only carries y — undefined is never emitted.
    expect(deltas[0]).toEqual({ y: 2 })
    expect('x' in deltas[0]).toBe(false)
  })

  it('deepAssign with undefined in the source leaves target untouched', () => {
    const target: Record<string, unknown> = { a: 1, b: 2 }
    deepAssign(target, { a: undefined })
    expect(target).toEqual({ a: 1, b: 2 })
    expect('a' in target).toBe(true)
    expect(target.a).toBe(1)
  })
})

// ==========================================================================
// Regression coverage for existing correct behaviour
// ==========================================================================
describe('regression: back-to-back setStates land on the wire', () => {
  it('two setStates in same tick both reach the wire', async () => {
    type S = { a: number; b: number }
    class C extends LiveComponent<S> {
      static componentName = 'BackToBackComponent'
      static publicActions = [] as const
      static defaultState: S = { a: 0, b: 0 }
    }
    const ws = createMockWs()
    const comp = new C({}, ws)

    comp.setState({ a: 1 })
    comp.setState({ b: 2 })
    await flush()

    const deltas = extractDeltas(ws)
    const merged = Object.assign({}, ...deltas)
    expect(merged.a).toBe(1)
    expect(merged.b).toBe(2)
  })
})

describe('regression: shared sub-tree in next is diffed on both paths', () => {
  it('two keys pointing at the same new object both produce deltas', async () => {
    type S = { a: { count: number }; b: { count: number } }
    class C extends LiveComponent<S> {
      static componentName = 'SharedSubtreeComponent'
      static publicActions = [] as const
      static defaultState: S = { a: { count: 0 }, b: { count: 0 } }
    }
    const ws = createMockWs()
    const comp = new C({}, ws)

    const shared = { count: 9 }
    comp.setState({ a: shared, b: shared })
    await flush()

    const deltas = extractDeltas(ws)
    expect(deltas.length).toBe(1)
    expect(deltas[0]).toHaveProperty('a')
    expect(deltas[0]).toHaveProperty('b')
  })
})

describe('regression: maxDepth boundary does not leak user references', () => {
  it('mutating the original update object after setState does not corrupt state', async () => {
    type S = { l1: { l2: { l3: { l4: { val: number } } } } }
    class C extends LiveComponent<S> {
      static componentName = 'MaxDepthComponent'
      static publicActions = [] as const
      static defaultState: S = { l1: { l2: { l3: { l4: { val: 0 } } } } }
    }
    const ws = createMockWs()
    const comp = new C({}, ws)

    const userUpdate = { l1: { l2: { l3: { l4: { val: 42 } } } } }
    comp.setState(userUpdate)
    await flush()

    userUpdate.l1.l2.l3.l4.val = 999
    const state = comp.getSerializableState() as any
    expect(state.l1.l2.l3.l4.val).toBe(42)
  })
})

describe('regression: setState with the same reference object is a no-op', () => {
  it('passing the current state object emits nothing', async () => {
    type S = { obj: { a: number; b: number } }
    class C extends LiveComponent<S> {
      static componentName = 'SameRefComponent'
      static publicActions = [] as const
      static defaultState: S = { obj: { a: 1, b: 2 } }
    }
    const ws = createMockWs()
    const comp = new C({}, ws)

    const currentObj = (comp.getSerializableState() as any).obj
    comp.setState({ obj: currentObj })
    await flush()

    expect(extractDeltas(ws).length).toBe(0)
  })
})

describe('regression: array replacement inside nested object', () => {
  it('new array ref inside nested plain object is emitted whole', async () => {
    type S = { list: { items: number[]; title: string } }
    class C extends LiveComponent<S> {
      static componentName = 'ArrayInNestedComponent'
      static publicActions = [] as const
      static defaultState: S = { list: { items: [1, 2, 3], title: 'todo' } }
    }
    const ws = createMockWs()
    const comp = new C({}, ws)

    comp.setState({ list: { items: [1, 2, 3, 4], title: 'todo' } })
    await flush()

    const deltas = extractDeltas(ws)
    expect(deltas.length).toBe(1)
    expect(deltas[0]).toEqual({ list: { items: [1, 2, 3, 4] } })
  })
})

describe('regression: top-level key removal is not emitted (documented)', () => {
  // Top-level state keys are part of the component schema. Adding/removing
  // them dynamically is not supported; only nested Record<string,T> maps
  // get deletion semantics. computeDeepDiff encodes this by only emitting
  // removals at depth > 0.

  it('computeDeepDiff at depth 0 does not emit removals', () => {
    const prev = { a: 1, b: 2, c: 3 }
    const next = { a: 1, b: 2 }
    const diff = computeDeepDiff(prev, next)
    expect(diff).toBeNull()
  })

  it('computeDeepDiff at depth > 0 DOES emit removals', () => {
    const prev = { outer: { a: 1, b: 2, c: 3 } }
    const next = { outer: { a: 1, b: 2 } }
    const diff = computeDeepDiff(prev, next)
    expect(diff).toEqual({ outer: { c: null } })
  })
})

// ==========================================================================
// Documented limitations — not bugs, captured here so changes are explicit
// ==========================================================================
describe('documented limitation: shallow proxy does not intercept nested mutations', () => {
  // `this.state.nested.x = 42` mutates the internal state but emits no
  // delta because the state proxy only traps top-level set. The fix for
  // users is to call `this.setState({ nested: { ...this.state.nested, x: 42 } })`.
  // A recursive proxy would be a breaking change + perf hit; a dev warning
  // would need to detect nested writes without slowing the hot path. Both
  // are out of scope for #6.
  it('mutating nested fields via the state proxy emits no delta', async () => {
    type S = { nested: { x: number } }
    class C extends LiveComponent<S> {
      static componentName = 'ShallowProxyComponent'
      static publicActions = [] as const
      static defaultState: S = { nested: { x: 0 } }
    }
    const ws = createMockWs()
    const comp = new C({}, ws)

    const state = comp.getSerializableState() as any
    state.nested.x = 42
    await flush()

    expect(extractDeltas(ws).length).toBe(0)
    expect((comp.getSerializableState() as any).nested.x).toBe(42)
  })
})

describe('documented limitation: Map/Set as state values serialize to empty objects', () => {
  // `JSON.stringify(new Map())` returns `{}`. We do not reject Maps at
  // runtime — the framework would need a type-system-level guarantee or a
  // blanket deep inspection to do so correctly. Users are expected to keep
  // state JSON-serializable; see README.
  it('a Map put into state serializes as {} on the wire', async () => {
    type S = { cache: Map<string, number>; n: number }
    class C extends LiveComponent<S> {
      static componentName = 'MapStateComponent'
      static publicActions = [] as const
      static defaultState: S = { cache: new Map(), n: 0 }
    }
    const ws = createMockWs()
    const comp = new C({}, ws)

    comp.setState({ cache: new Map<string, number>([['k', 1]]) })
    await flush()

    const deltas = extractDeltas(ws)
    expect(deltas.length).toBe(1)
    expect(deltas[0].cache).toEqual({})
  })
})

describe('documented limitation: Date values are reference-compared', () => {
  // Two equivalent Date instances produce a delta because `computeDeepDiff`
  // uses `===` for non-plain values. Users who care about wall-clock
  // equality should store timestamps as numbers (Date.now()) in state.
  it('two equal-by-time Date instances (different refs) emit a delta', async () => {
    type S = { updatedAt: Date; count: number }
    class C extends LiveComponent<S> {
      static componentName = 'DateStateComponent'
      static publicActions = [] as const
      static defaultState: S = { updatedAt: new Date(1000), count: 0 }
    }
    const ws = createMockWs()
    const comp = new C({}, ws)

    comp.setState({ updatedAt: new Date(1000) })
    await flush()

    expect(extractDeltas(ws).length).toBe(1)
  })
})

// ==========================================================================
// fixes #13 — setState must not silently drop updates when the "next" values
// share references with a "previous" state that has been mutated through an
// external alias (e.g. a LiveRoom whose state is mirrored into a component).
//
// Root cause: computeDeepDiff(prev, next) uses `prev === next` as a fast-path.
// That is only correct when the framework OWNS the previous state. The moment
// a caller does `component.setState({ players: { ...room.state.players } })`,
// the component's internal `_state.players[id]` and the room's
// `room.state.players[id]` become the SAME reference. If the room then
// mutates that player in-place (which LiveRoomManager does via deepAssign),
// the component's "previous" state is silently updated too — so the next
// `setState` with the "new" snapshot compares `oldVal === newVal` and emits
// no delta. The client never sees the change.
//
// The fix must make setState honest: the previous-state snapshot used by
// the diff must reflect what the CLIENT last saw, not whatever the aliased
// object currently holds.
// ==========================================================================
describe('fixes #13: setState survives external mutation of aliased refs', () => {
  it('emits a delta for a player that was mutated through a shared reference', async () => {
    type Player = { name: string; ready: boolean; score: number }
    type S = { players: Record<string, Player>; hostId: string }
    class Game extends LiveComponent<S> {
      static componentName = 'Issue13GameComponent'
      static publicActions = [] as const
      static defaultState: S = { players: {}, hostId: '' }
    }

    const ws = createMockWs()
    const comp = new Game({}, ws)

    // Simulates a LiveRoom that owns the source of truth. The component
    // mirrors this map into its own state. Exactly the pattern the issue
    // describes: same JS references, no defensive clone.
    const roomPlayers: Record<string, Player> = {
      A: { name: 'Alice', ready: false, score: 0 },
      B: { name: 'Bob', ready: false, score: 0 },
    }

    // First mirror: component takes a spread of the room container. The
    // inner Player objects are still shared with `roomPlayers`.
    comp.setState({ players: { ...roomPlayers }, hostId: 'A' })
    await flush()

    // Baseline: the client saw the initial mirror.
    let deltas = extractDeltas(ws)
    expect(deltas.length).toBe(1)
    expect(deltas[0]).toEqual({
      players: {
        A: { name: 'Alice', ready: false, score: 0 },
        B: { name: 'Bob', ready: false, score: 0 },
      },
      hostId: 'A',
    })
    ;(ws.send as any).mockClear()

    // ---- the bug trigger ----
    // The "room" mutates player A in-place. This is what LiveRoomManager
    // does via deepAssign: it does NOT replace `roomPlayers.A` with a new
    // object, it mutates the existing one. Because the component's
    // `_state.players.A` is the SAME reference, `_state` now silently
    // reflects `ready: true` — without any delta having been emitted.
    roomPlayers.A.ready = true

    // The component re-mirrors. This is the documented sync pattern:
    //   this.setState({ players: { ...room.state.players } })
    comp.setState({ players: { ...roomPlayers } })
    await flush()

    deltas = extractDeltas(ws)

    // Before the fix: 0 deltas (diff short-circuits on oldVal === newVal).
    // After the fix: exactly one delta carrying the ready=true change.
    expect(deltas.length).toBe(1)
    expect(deltas[0]).toEqual({ players: { A: { ready: true } } })
  })

  it('emits a delta when a nested primitive is mutated through an alias', async () => {
    // Minimal isolation of the bug: a single nested object mutated in-place
    // between two setState calls. No Record, no room, just aliasing.
    type S = { config: { volume: number; muted: boolean } }
    class C extends LiveComponent<S> {
      static componentName = 'Issue13AliasComponent'
      static publicActions = [] as const
      static defaultState: S = { config: { volume: 50, muted: false } }
    }

    const ws = createMockWs()
    const comp = new C({}, ws)

    const externalConfig = { volume: 50, muted: false }
    comp.setState({ config: externalConfig })
    await flush()
    ;(ws.send as any).mockClear()

    // Mutate through the alias — component's _state.config is the same ref.
    externalConfig.muted = true

    // Re-sync with the same reference.
    comp.setState({ config: externalConfig })
    await flush()

    const deltas = extractDeltas(ws)
    expect(deltas.length).toBe(1)
    expect(deltas[0]).toEqual({ config: { muted: true } })
  })

  it('does not emit spurious deltas when nothing changed (regression guard)', async () => {
    // The fix must still be a no-op when the state is genuinely unchanged.
    type S = { config: { volume: number } }
    class C extends LiveComponent<S> {
      static componentName = 'Issue13NoopComponent'
      static publicActions = [] as const
      static defaultState: S = { config: { volume: 50 } }
    }

    const ws = createMockWs()
    const comp = new C({}, ws)

    comp.setState({ config: { volume: 50 } })
    await flush()

    expect(extractDeltas(ws).length).toBe(0)
  })
})

// ==========================================================================
// fixes #13 — end-to-end against a real LiveRoomManager.
//
// The isolated tests above use a plain object to stand in for LiveRoom state.
// This suite wires up a genuine LiveRoomManager + LiveRoom subclass and walks
// through the exact sequence the issue author described:
//   1) Component mirrors room.state into its own state via setState.
//   2) Room mutates a player via setRoomState — deepAssign mutates in place.
//   3) Component re-mirrors room.state.
// Before the fix, step 3 emitted no delta because the component's _state was
// aliased with room.state's internals. After the fix, _state is structurally
// independent and the re-mirror produces a correct delta.
// ==========================================================================

// Don't mock the WS batcher here — we want the full setState → emit path.
// Also avoid colliding with global LiveLogger noise; it's silent by default
// for these componentNames anyway.

describe('fixes #13: end-to-end LiveRoomManager ↔ LiveComponent', () => {
  // Dynamically import the manager/room/registry so the mocked modules above
  // (WsSendBatcher, LiveLogger) don't interfere with this suite's path.
  it('component re-sync emits a delta after the room mutates a shared player', async () => {
    const { LiveRoomManager } = await import('../../rooms/LiveRoomManager')
    const { LiveRoom } = await import('../../rooms/LiveRoom')
    const { RoomRegistry } = await import('../../rooms/RoomRegistry')
    const { RoomEventBus } = await import('../../rooms/RoomEventBus')

    type Player = { name: string; ready: boolean; score: number }
    type RoomState = { players: Record<string, Player>; hostId: string }

    class KartRaceRoom extends LiveRoom<RoomState> {
      static roomName = 'kart'
      static defaultState: RoomState = {
        players: {
          A: { name: 'Alice', ready: false, score: 0 },
          B: { name: 'Bob', ready: false, score: 0 },
        },
        hostId: 'A',
      }
    }

    const roomEvents = new RoomEventBus()
    const manager = new LiveRoomManager(roomEvents)
    const registry = new RoomRegistry()
    registry.register(KartRaceRoom as any)
    manager.roomRegistry = registry

    // Joining the room materializes the room instance with defaultState.
    const ws1 = createMockWs()
    const joinResult = await manager.joinRoom('comp-1', 'kart:race-1', ws1 as any)
    expect('rejected' in joinResult && joinResult.rejected).toBeFalsy()

    // Component mirrors room state into its own state. This is the documented
    // sync pattern from the issue.
    type CompState = { players: Record<string, Player>; hostId: string }
    class KartGame extends LiveComponent<CompState> {
      static componentName = 'Issue13E2EKartGame'
      static publicActions = [] as const
      static defaultState: CompState = { players: {}, hostId: '' }
    }
    const ws2 = createMockWs()
    const comp = new KartGame({}, ws2)

    const roomState = manager.getRoomState<RoomState>('kart:race-1')
    comp.setState({
      players: { ...roomState.players },
      hostId: roomState.hostId,
    })
    await flush()

    // Baseline: initial mirror landed on the wire.
    let deltas = extractDeltas(ws2)
    expect(deltas.length).toBe(1)
    expect(deltas[0]).toEqual({
      players: {
        A: { name: 'Alice', ready: false, score: 0 },
        B: { name: 'Bob', ready: false, score: 0 },
      },
      hostId: 'A',
    })
    ;(ws2.send as any).mockClear()

    // Room mutates player A: sets ready = true. LiveRoomManager.setRoomState
    // computes a delta and calls deepAssign(room.state, delta), which
    // recursively mutates the existing players.A object in place — keeping
    // the same reference. That is the ownership overlap the issue describes.
    manager.setRoomState('kart:race-1', {
      players: {
        A: { name: 'Alice', ready: true, score: 0 },
        B: { name: 'Bob', ready: false, score: 0 },
      },
    })

    // Sanity: the room's own state reflects the change.
    const roomStateAfter = manager.getRoomState<RoomState>('kart:race-1')
    expect(roomStateAfter.players.A.ready).toBe(true)

    // Component re-mirrors. Before the fix, comp._state.players.A was the
    // same reference as room.state.players.A, and deepAssign on the previous
    // setState mutated it in place via the room's own update — so the diff
    // sees oldVal === newVal and emits nothing.
    comp.setState({
      players: { ...roomStateAfter.players },
      hostId: roomStateAfter.hostId,
    })
    await flush()

    deltas = extractDeltas(ws2)
    expect(deltas.length).toBe(1)
    // Only A.ready should be in the delta. B is unchanged, hostId is unchanged.
    expect(deltas[0]).toEqual({ players: { A: { ready: true } } })

    // And the component's own serialized state must reflect the change.
    const compState = comp.getSerializableState() as CompState
    expect(compState.players.A.ready).toBe(true)
    expect(compState.players.B.ready).toBe(false)

    // Clean up the room to avoid test pollution.
    await manager.cleanupComponent('comp-1')
  })
})
