// SpatialGrid — pure data-structure tests. No LiveRoom coupling.

import { describe, it, expect, beforeEach } from 'vitest'
import { SpatialGrid } from '../SpatialGrid'

describe('SpatialGrid — construction', () => {
  it('defaults to 2D with cellSize=100, defaultRange=1', () => {
    const g = new SpatialGrid()
    expect(g.dimensions).toBe(2)
    expect(g.cellSize).toBe(100)
    expect(g.defaultRange).toBe(1)
  })

  it('accepts 3D configuration', () => {
    const g = new SpatialGrid({ dimensions: 3, cellSize: 50, defaultRange: 2 })
    expect(g.dimensions).toBe(3)
    expect(g.cellSize).toBe(50)
    expect(g.defaultRange).toBe(2)
  })

  it('rejects non-positive cellSize', () => {
    expect(() => new SpatialGrid({ cellSize: 0 })).toThrow(/cellSize/)
    expect(() => new SpatialGrid({ cellSize: -1 })).toThrow(/cellSize/)
    expect(() => new SpatialGrid({ cellSize: NaN })).toThrow(/cellSize/)
    expect(() => new SpatialGrid({ cellSize: Infinity })).toThrow(/cellSize/)
  })

  it('rejects negative or non-integer defaultRange', () => {
    expect(() => new SpatialGrid({ defaultRange: -1 })).toThrow(/defaultRange/)
    expect(() => new SpatialGrid({ defaultRange: 1.5 })).toThrow(/defaultRange/)
  })
})

describe('SpatialGrid — position math', () => {
  it('positionToCellKey rounds DOWN to cell (Math.floor)', () => {
    const g = new SpatialGrid({ cellSize: 100 })
    expect(g.positionToCellKey([0, 0])).toBe('0:0')
    expect(g.positionToCellKey([99.9, 50])).toBe('0:0')
    expect(g.positionToCellKey([100, 100])).toBe('1:1')
    expect(g.positionToCellKey([-1, -1])).toBe('-1:-1') // floor(-0.01) = -1
    expect(g.positionToCellKey([-100.5, 0])).toBe('-2:0')
  })

  it('positionToCellKey works in 3D', () => {
    const g = new SpatialGrid({ dimensions: 3, cellSize: 10 })
    expect(g.positionToCellKey([5, 15, 25])).toBe('0:1:2')
  })
})

describe('SpatialGrid — setPosition / getCell / remove', () => {
  let g: SpatialGrid<string>
  beforeEach(() => { g = new SpatialGrid({ cellSize: 100 }) })

  it('adds a new member and reports its cell', () => {
    g.setPosition('alice', [50, 50])
    expect(g.getCell('alice')).toBe('0:0')
    expect(g.size).toBe(1)
    expect(g.cellCount).toBe(1)
  })

  it('moving inside the same cell returns false and is a no-op', () => {
    g.setPosition('alice', [10, 10])
    expect(g.setPosition('alice', [90, 90])).toBe(false)
    expect(g.getCell('alice')).toBe('0:0')
  })

  it('crossing a cell boundary returns true and updates indexes', () => {
    g.setPosition('alice', [50, 50])
    expect(g.setPosition('alice', [150, 50])).toBe(true)
    expect(g.getCell('alice')).toBe('1:0')
    // Old cell is gone
    expect(g.cellCount).toBe(1)
  })

  it('remove() cleans both the cell index and the membership map', () => {
    g.setPosition('alice', [50, 50])
    g.remove('alice')
    expect(g.has('alice')).toBe(false)
    expect(g.getCell('alice')).toBeUndefined()
    expect(g.size).toBe(0)
    expect(g.cellCount).toBe(0)
  })

  it('remove() on unknown member is a no-op', () => {
    expect(() => g.remove('ghost')).not.toThrow()
  })

  it('two members in the same cell coexist; removing one keeps the cell', () => {
    g.setPosition('alice', [10, 10])
    g.setPosition('bob', [20, 20])
    expect(g.cellCount).toBe(1)
    g.remove('alice')
    expect(g.cellCount).toBe(1) // cell still has bob
  })

  it('clear() resets everything', () => {
    g.setPosition('alice', [10, 10])
    g.setPosition('bob', [200, 200])
    g.clear()
    expect(g.size).toBe(0)
    expect(g.cellCount).toBe(0)
  })
})

describe('SpatialGrid.neighborCells — iteration', () => {
  it('range=0 yields exactly the cell containing pos (2D)', () => {
    const g = new SpatialGrid({ cellSize: 100 })
    const cells = [...g.neighborCells([50, 50], 0)]
    expect(cells).toEqual(['0:0'])
  })

  it('range=1 yields a 3×3 neighborhood (9 cells) in 2D', () => {
    const g = new SpatialGrid({ cellSize: 100 })
    const cells = [...g.neighborCells([150, 150], 1)]
    expect(cells.length).toBe(9)
    // Center is 1:1; range 0:0..2:2
    expect(cells.sort()).toEqual([
      '0:0', '0:1', '0:2',
      '1:0', '1:1', '1:2',
      '2:0', '2:1', '2:2',
    ])
  })

  it('range=2 yields 5×5 = 25 cells in 2D', () => {
    const g = new SpatialGrid({ cellSize: 100 })
    expect([...g.neighborCells([0, 0], 2)].length).toBe(25)
  })

  it('range=1 yields 3×3×3 = 27 cells in 3D', () => {
    const g = new SpatialGrid({ dimensions: 3, cellSize: 100 })
    expect([...g.neighborCells([0, 0, 0], 1)].length).toBe(27)
  })
})

describe('SpatialGrid.queryNear — proximity query by position', () => {
  let g: SpatialGrid<string>
  beforeEach(() => {
    g = new SpatialGrid({ cellSize: 100 })
    g.setPosition('alice', [50, 50])    // cell 0:0
    g.setPosition('bob', [150, 50])     // cell 1:0
    g.setPosition('carol', [350, 350])  // cell 3:3 (far away)
  })

  it('returns near members with range=1 (3×3)', () => {
    const near = g.queryNear([50, 50], 1)
    expect(near.has('alice')).toBe(true)
    expect(near.has('bob')).toBe(true) // adjacent cell
    expect(near.has('carol')).toBe(false)
  })

  it('range=0 only returns same-cell members', () => {
    const near = g.queryNear([50, 50], 0)
    expect(near.has('alice')).toBe(true)
    expect(near.has('bob')).toBe(false)
  })

  it('range=4 picks up carol too', () => {
    const near = g.queryNear([50, 50], 4)
    expect(near.has('carol')).toBe(true)
  })

  it('returns an empty Set if no one is nearby', () => {
    const isolated = new SpatialGrid({ cellSize: 100 })
    isolated.setPosition('lonely', [9999, 9999])
    expect(isolated.queryNear([0, 0], 1).size).toBe(0)
  })
})

describe('SpatialGrid.queryNearMember — "broadcast to peers near me"', () => {
  it('excludes the querier by default', () => {
    const g = new SpatialGrid({ cellSize: 100 })
    g.setPosition('alice', [50, 50])
    g.setPosition('bob', [50, 50])
    const near = g.queryNearMember('alice')
    expect(near.has('alice')).toBe(false)
    expect(near.has('bob')).toBe(true)
  })

  it('can include self via flag', () => {
    const g = new SpatialGrid({ cellSize: 100 })
    g.setPosition('alice', [50, 50])
    const near = g.queryNearMember('alice', 1, false)
    expect(near.has('alice')).toBe(true)
  })

  it('returns empty set if member has no position', () => {
    const g = new SpatialGrid({ cellSize: 100 })
    expect(g.queryNearMember('ghost').size).toBe(0)
  })

  it('works in 3D', () => {
    const g = new SpatialGrid({ dimensions: 3, cellSize: 10 })
    g.setPosition('a', [0, 0, 0])
    g.setPosition('b', [5, 5, 5])    // same cell 0:0:0
    g.setPosition('c', [15, 0, 0])   // adjacent cell 1:0:0
    g.setPosition('far', [100, 100, 100])

    const near = g.queryNearMember('a', 1)
    expect(near.has('b')).toBe(true)
    expect(near.has('c')).toBe(true)
    expect(near.has('far')).toBe(false)
  })
})

describe('SpatialGrid — stress / scale (100 members)', () => {
  it('100 random positions, query range=1 returns a reasonable subset', () => {
    const g = new SpatialGrid({ cellSize: 100 })
    // Spread 100 members across a 1000×1000 map (10×10 cells)
    for (let i = 0; i < 100; i++) {
      g.setPosition(`m${i}`, [(i * 71) % 1000, (i * 113) % 1000])
    }
    expect(g.size).toBe(100)
    const near = g.queryNear([500, 500], 1)
    // 3×3 cells out of ~100 cells, expected ~9% of members
    expect(near.size).toBeGreaterThan(0)
    expect(near.size).toBeLessThan(100)
  })
})
