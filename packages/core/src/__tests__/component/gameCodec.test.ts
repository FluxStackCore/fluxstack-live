// Tests for gameCodec binary encode/decode roundtrip.
// The codec is copied from battle-tanks into fixtures/ for self-contained testing.
import { describe, it, expect } from 'vitest'
import { encodeGameState, decodeGameState } from './fixtures/gameCodec'

describe('gameCodec encode/decode', () => {
  it('roundtrips matchTime only (no arrays)', () => {
    const input = { matchTime: 12345 }
    const encoded = encodeGameState(input)
    const decoded = decodeGameState(encoded)

    expect(decoded.matchTime).toBe(12345)
    expect(decoded.tanks).toBeUndefined()
    expect(decoded.bullets).toBeUndefined()
  })

  it('roundtrips tanks', () => {
    const input = {
      matchTime: 5000,
      tanks: [
        { id: 'p1', x: 10.5, z: 20.3, rot: 1.57, tRot: 3.14, hp: 100, alive: true, laserCharge: 0.75 },
        { id: 'p2', x: -5.0, z: 0.0, rot: 0, tRot: 0, hp: 50, alive: false, laserCharge: 0 },
      ],
    }
    const decoded = decodeGameState(encodeGameState(input))

    expect(decoded.tanks).toHaveLength(2)
    expect(decoded.tanks[0].id).toBe('p1')
    expect(decoded.tanks[0].x).toBeCloseTo(10.5, 2)
    expect(decoded.tanks[0].z).toBeCloseTo(20.3, 2)
    expect(decoded.tanks[0].rot).toBeCloseTo(1.57, 2)
    expect(decoded.tanks[0].tRot).toBeCloseTo(3.14, 2)
    expect(decoded.tanks[0].hp).toBe(100)
    expect(decoded.tanks[0].alive).toBe(true)
    expect(decoded.tanks[0].laserCharge).toBeCloseTo(0.75, 2)

    expect(decoded.tanks[1].id).toBe('p2')
    expect(decoded.tanks[1].alive).toBe(false)
    expect(decoded.tanks[1].hp).toBe(50)
  })

  it('roundtrips bullets', () => {
    const input = {
      matchTime: 100,
      bullets: [
        { id: 'b1', x: 1.0, z: 2.0, vx: 10.0, vz: -5.0, bulletType: 0 },
        { id: 'b2', x: 50.0, z: 50.0, vx: 0, vz: 15.0, bulletType: 2 },
      ],
    }
    const decoded = decodeGameState(encodeGameState(input))

    expect(decoded.bullets).toHaveLength(2)
    expect(decoded.bullets[0].id).toBe('b1')
    expect(decoded.bullets[0].x).toBeCloseTo(1.0)
    expect(decoded.bullets[0].vx).toBeCloseTo(10.0)
    expect(decoded.bullets[0].bulletType).toBe(0)
    expect(decoded.bullets[1].bulletType).toBe(2)
  })

  it('roundtrips explosions', () => {
    const input = {
      matchTime: 200,
      explosions: [
        { x: 5.0, z: 10.0, radius: 3.5 },
      ],
    }
    const decoded = decodeGameState(encodeGameState(input))

    expect(decoded.explosions).toHaveLength(1)
    expect(decoded.explosions[0].x).toBeCloseTo(5.0)
    expect(decoded.explosions[0].z).toBeCloseTo(10.0)
    expect(decoded.explosions[0].radius).toBeCloseTo(3.5)
  })

  it('roundtrips laserBeams', () => {
    const input = {
      matchTime: 300,
      laserBeams: [
        { x1: 0, z1: 0, x2: 100, z2: 50, shooterId: 'player-abc', team: 0 },
      ],
    }
    const decoded = decodeGameState(encodeGameState(input))

    expect(decoded.laserBeams).toHaveLength(1)
    expect(decoded.laserBeams[0].x2).toBeCloseTo(100)
    expect(decoded.laserBeams[0].shooterId).toBe('player-abc')
    expect(decoded.laserBeams[0].team).toBe(0)
  })

  it('roundtrips vampireBeams', () => {
    const input = {
      matchTime: 400,
      vampireBeams: [
        { shooterId: 'vamp1', x1: 10, z1: 20, x2: 30, z2: 40, team: 1, hitting: true },
        { shooterId: 'vamp2', x1: 0, z1: 0, x2: 5, z2: 5, team: 0, hitting: false },
      ],
    }
    const decoded = decodeGameState(encodeGameState(input))

    expect(decoded.vampireBeams).toHaveLength(2)
    expect(decoded.vampireBeams[0].shooterId).toBe('vamp1')
    expect(decoded.vampireBeams[0].hitting).toBe(true)
    expect(decoded.vampireBeams[0].team).toBe(1)
    expect(decoded.vampireBeams[1].hitting).toBe(false)
  })

  it('roundtrips all fields together', () => {
    const input = {
      matchTime: 99999,
      tanks: [
        { id: 't1', x: 1, z: 2, rot: 0.5, tRot: 1.0, hp: 200, alive: true, laserCharge: 1.0 },
      ],
      bullets: [
        { id: 'b1', x: 3, z: 4, vx: 5, vz: 6, bulletType: 1 },
      ],
      explosions: [
        { x: 7, z: 8, radius: 9 },
      ],
      laserBeams: [
        { x1: 10, z1: 11, x2: 12, z2: 13, shooterId: 'laser1', team: 0 },
      ],
      vampireBeams: [
        { shooterId: 'v1', x1: 14, z1: 15, x2: 16, z2: 17, team: 1, hitting: true },
      ],
    }
    const decoded = decodeGameState(encodeGameState(input))

    expect(decoded.matchTime).toBe(99999)
    expect(decoded.tanks).toHaveLength(1)
    expect(decoded.bullets).toHaveLength(1)
    expect(decoded.explosions).toHaveLength(1)
    expect(decoded.laserBeams).toHaveLength(1)
    expect(decoded.vampireBeams).toHaveLength(1)
  })

  it('handles empty arrays', () => {
    const input = {
      matchTime: 0,
      tanks: [],
      bullets: [],
      explosions: [],
      laserBeams: [],
      vampireBeams: [],
    }
    const decoded = decodeGameState(encodeGameState(input))

    expect(decoded.matchTime).toBe(0)
    expect(decoded.tanks).toHaveLength(0)
    expect(decoded.bullets).toHaveLength(0)
    expect(decoded.explosions).toHaveLength(0)
    expect(decoded.laserBeams).toHaveLength(0)
    expect(decoded.vampireBeams).toHaveLength(0)
  })

  it('produces compact output (no field names on wire)', () => {
    const input = {
      matchTime: 1000,
      tanks: [
        { id: 'p1', x: 10, z: 20, rot: 1, tRot: 2, hp: 100, alive: true, laserCharge: 0.5 },
      ],
    }

    const binary = encodeGameState(input)
    const json = new TextEncoder().encode(JSON.stringify(input))

    // Binary should be significantly smaller than JSON
    expect(binary.length).toBeLessThan(json.length)
  })

  it('handles long player IDs', () => {
    const longId = 'player-' + 'a'.repeat(200)
    const input = {
      matchTime: 0,
      tanks: [
        { id: longId, x: 0, z: 0, rot: 0, tRot: 0, hp: 0, alive: false, laserCharge: 0 },
      ],
    }
    const decoded = decodeGameState(encodeGameState(input))
    expect(decoded.tanks[0].id).toBe(longId)
  })
})
