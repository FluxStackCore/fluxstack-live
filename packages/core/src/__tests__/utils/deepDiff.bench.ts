import { bench, describe } from 'vitest'
import { computeDeepDiff, deepAssign } from '../../utils/deepDiff'

// ---------------------------------------------------------------------------
// Helpers to build realistic state objects
// ---------------------------------------------------------------------------

function flatObject(n: number, prefix = 'key'): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < n; i++) obj[`${prefix}${i}`] = i
  return obj
}

function nestedObject(breadth: number, depth: number, leaf = 0): Record<string, unknown> {
  if (depth === 0) return flatObject(breadth, `leaf${leaf}_`)
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < breadth; i++) {
    obj[`level${depth}_${i}`] = nestedObject(breadth, depth - 1, leaf + i)
  }
  return obj
}

/** Simulates a game room state: 100+ players with position, health, meta */
function gameRoomState(playerCount: number): Record<string, unknown> {
  const players: Record<string, unknown> = {}
  for (let i = 0; i < playerCount; i++) {
    players[`player_${i}`] = {
      x: Math.random() * 1000,
      y: Math.random() * 1000,
      health: 100,
      name: `Player${i}`,
      team: i % 2 === 0 ? 'red' : 'blue',
      inventory: [1, 2, 3],
    }
  }
  return { players, tick: 0, status: 'running', mapId: 'arena_01' }
}

function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

// ---------------------------------------------------------------------------
// 1. Small objects (5 keys, flat)
// ---------------------------------------------------------------------------

describe('computeDeepDiff — small flat (5 keys)', () => {
  const base = flatObject(5)

  bench('no changes', () => {
    computeDeepDiff(base, { ...base })
  })

  const someChanged = { ...base, key1: 'changed', key3: 'changed' }
  bench('2/5 keys changed', () => {
    computeDeepDiff(base, someChanged)
  })

  const allChanged = { key0: 'a', key1: 'b', key2: 'c', key3: 'd', key4: 'e' }
  bench('all keys changed', () => {
    computeDeepDiff(base, allChanged)
  })
})

// ---------------------------------------------------------------------------
// 2. Medium objects (50 keys, flat)
// ---------------------------------------------------------------------------

describe('computeDeepDiff — medium flat (50 keys)', () => {
  const base = flatObject(50)

  bench('no changes', () => {
    computeDeepDiff(base, { ...base })
  })

  const someChanged = { ...base, key5: 'x', key15: 'x', key25: 'x', key35: 'x', key45: 'x' }
  bench('5/50 keys changed', () => {
    computeDeepDiff(base, someChanged)
  })
})

// ---------------------------------------------------------------------------
// 3. Deeply nested (3 levels, 5 keys each)
// ---------------------------------------------------------------------------

describe('computeDeepDiff — nested (depth=3, breadth=5)', () => {
  const base = nestedObject(5, 3)

  bench('no changes (identical structure)', () => {
    const next = clone(base)
    computeDeepDiff(base, next)
  })

  bench('leaf value change', () => {
    const next = clone(base)
    ;(
      (next['level3_0'] as any)['level2_0'] as any
    )['level1_0']['leaf0_0'] = 'CHANGED'
    computeDeepDiff(base, next)
  })

  bench('nested key removal', () => {
    const next = clone(base)
    const inner = (next['level3_0'] as any)['level2_0'] as any
    delete inner['level1_2']
    computeDeepDiff(base, next)
  })
})

// ---------------------------------------------------------------------------
// 4. Wide game room state (100+ players)
// ---------------------------------------------------------------------------

describe('computeDeepDiff — game room (120 players)', () => {
  const base = gameRoomState(120)

  bench('no changes', () => {
    const next = clone(base)
    computeDeepDiff(base, next)
  })

  bench('10 players moved (position update)', () => {
    const next = clone(base)
    const players = next.players as Record<string, any>
    for (let i = 0; i < 10; i++) {
      players[`player_${i}`] = { ...players[`player_${i}`], x: 999, y: 999 }
    }
    computeDeepDiff(base, next)
  })

  bench('5 players added + 5 removed', () => {
    const next = clone(base)
    const players = next.players as Record<string, any>
    // Remove 5
    for (let i = 0; i < 5; i++) delete players[`player_${i}`]
    // Add 5 new
    for (let i = 120; i < 125; i++) {
      players[`player_${i}`] = {
        x: 0, y: 0, health: 100, name: `Player${i}`, team: 'blue', inventory: [],
      }
    }
    computeDeepDiff(base, next)
  })

  bench('all players health changed (bulk update)', () => {
    const next = clone(base)
    const players = next.players as Record<string, any>
    for (const key of Object.keys(players)) {
      players[key] = { ...players[key], health: 50 }
    }
    computeDeepDiff(base, next)
  })
})

// ---------------------------------------------------------------------------
// 5. Worst-case scenarios
// ---------------------------------------------------------------------------

describe('computeDeepDiff — worst case', () => {
  bench('max depth fallback (depth > maxDepth)', () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } }
    const next = { a: { b: { c: { d: { e: 2 } } } } }
    computeDeepDiff(deep as any, next as any, 0, 3)
  })

  bench('many removals (50 keys removed from nested)', () => {
    const prev = { data: flatObject(80) }
    const next = { data: flatObject(30) } // 50 keys gone
    computeDeepDiff(prev, next)
  })

  bench('large flat (500 keys) — reference equality fast path', () => {
    const base = flatObject(500)
    // Same object refs for values => all skipped via ===
    computeDeepDiff(base, base)
  })

  bench('circular reference guard', () => {
    const a: any = { value: 1 }
    const b: any = { value: 1 }
    a.self = a
    b.self = b
    computeDeepDiff(a, b)
  })
})

// ---------------------------------------------------------------------------
// 6. deepAssign benchmarks
// ---------------------------------------------------------------------------

describe('deepAssign — with null deletions', () => {
  bench('small merge, no deletions (5 keys)', () => {
    const target = flatObject(5)
    deepAssign(target, { key0: 'updated', key2: 'updated' })
  })

  bench('small merge with null deletions', () => {
    const target = flatObject(5)
    deepAssign(target, { key0: null, key2: null, key4: 'updated' })
  })

  bench('nested merge, no deletions', () => {
    const target = {
      player: { x: 0, y: 0, health: 100, name: 'Alice' },
      meta: { tick: 1, status: 'running' },
    }
    deepAssign(target, { player: { x: 10, y: 20 }, meta: { tick: 2 } })
  })

  bench('nested merge with null deletions', () => {
    const target = {
      player: { x: 0, y: 0, health: 100, name: 'Alice', buff: 'shield' },
      meta: { tick: 1, status: 'running' },
    }
    deepAssign(target, { player: { health: 80, buff: null }, meta: { tick: 2 } })
  })

  bench('game room delta apply (10 player updates + 3 removals)', () => {
    const target = gameRoomState(120)
    const delta: Record<string, unknown> = { players: {} as Record<string, unknown> }
    const playersDelta = delta.players as Record<string, unknown>
    // 10 position updates
    for (let i = 0; i < 10; i++) {
      playersDelta[`player_${i}`] = { x: 500, y: 500 }
    }
    // 3 removals
    for (let i = 117; i < 120; i++) {
      playersDelta[`player_${i}`] = null
    }
    delta.tick = 1
    deepAssign(target, delta)
  })
})

describe('deepAssign — large operations', () => {
  bench('overwrite 50 flat keys', () => {
    const target = flatObject(100)
    const source: Record<string, unknown> = {}
    for (let i = 0; i < 50; i++) source[`key${i}`] = `new_${i}`
    deepAssign(target, source)
  })

  bench('delete 50 flat keys via null', () => {
    const target = flatObject(100)
    const source: Record<string, unknown> = {}
    for (let i = 0; i < 50; i++) source[`key${i}`] = null
    deepAssign(target, source)
  })

  bench('circular reference guard', () => {
    const target = { a: 1, b: 2 }
    const source: any = { a: 10 }
    source.self = source
    deepAssign(target, source)
  })
})
