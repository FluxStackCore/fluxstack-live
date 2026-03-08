// Copied from battle-tanks/app/shared/codec/gameCodec.ts for testing.
// This is the game-specific binary codec — tests verify encode/decode roundtrip.

interface TankDynamic {
  id: string
  x: number
  z: number
  rot: number
  tRot: number
  hp: number
  alive: boolean
  laserCharge: number
}

// Field presence flags (bitmask)
const FLAG_TANKS      = 0x01
const FLAG_BULLETS    = 0x02
const FLAG_EXPLOSIONS = 0x04
const FLAG_LASERS     = 0x08
const FLAG_VAMPIRES   = 0x10

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function writeString(dv: DataView, offset: number, str: string): number {
  const bytes = textEncoder.encode(str)
  dv.setUint8(offset, bytes.length)
  offset += 1
  for (let i = 0; i < bytes.length; i++) {
    dv.setUint8(offset + i, bytes[i])
  }
  return offset + bytes.length
}

function readString(dv: DataView, offset: number): [string, number] {
  const len = dv.getUint8(offset)
  offset += 1
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset + offset, len)
  return [textDecoder.decode(bytes), offset + len]
}

export function encodeGameState(delta: Record<string, any>): Uint8Array {
  let size = 1 + 4
  let flags = 0

  const tanks: TankDynamic[] | undefined = delta.tanks
  if (tanks) {
    flags |= FLAG_TANKS
    size += 2
    for (const t of tanks) {
      const idBytes = textEncoder.encode(t.id)
      size += 1 + idBytes.length + 16 + 2 + 1 + 4
    }
  }

  const bullets: any[] | undefined = delta.bullets
  if (bullets) {
    flags |= FLAG_BULLETS
    size += 2
    for (const b of bullets) {
      const idBytes = textEncoder.encode(b.id)
      size += 1 + idBytes.length + 16 + 1
    }
  }

  const explosions: any[] | undefined = delta.explosions
  if (explosions) {
    flags |= FLAG_EXPLOSIONS
    size += 2 + explosions.length * 12
  }

  const laserBeams: any[] | undefined = delta.laserBeams
  if (laserBeams) {
    flags |= FLAG_LASERS
    size += 2
    for (const lb of laserBeams) {
      const idBytes = textEncoder.encode(lb.shooterId)
      size += 16 + 1 + idBytes.length + 1
    }
  }

  const vampireBeams: any[] | undefined = delta.vampireBeams
  if (vampireBeams) {
    flags |= FLAG_VAMPIRES
    size += 2
    for (const vb of vampireBeams) {
      const idBytes = textEncoder.encode(vb.shooterId)
      size += 1 + idBytes.length + 16 + 1 + 1
    }
  }

  const buffer = new ArrayBuffer(size)
  const dv = new DataView(buffer)
  let offset = 0

  dv.setUint8(offset, flags); offset += 1
  dv.setUint32(offset, delta.matchTime ?? 0, true); offset += 4

  if (tanks) {
    dv.setUint16(offset, tanks.length, true); offset += 2
    for (const t of tanks) {
      offset = writeString(dv, offset, t.id)
      dv.setFloat32(offset, t.x, true); offset += 4
      dv.setFloat32(offset, t.z, true); offset += 4
      dv.setFloat32(offset, t.rot, true); offset += 4
      dv.setFloat32(offset, t.tRot, true); offset += 4
      dv.setUint16(offset, t.hp, true); offset += 2
      dv.setUint8(offset, t.alive ? 1 : 0); offset += 1
      dv.setFloat32(offset, t.laserCharge, true); offset += 4
    }
  }

  if (bullets) {
    dv.setUint16(offset, bullets.length, true); offset += 2
    for (const b of bullets) {
      offset = writeString(dv, offset, b.id)
      dv.setFloat32(offset, b.x, true); offset += 4
      dv.setFloat32(offset, b.z, true); offset += 4
      dv.setFloat32(offset, b.vx, true); offset += 4
      dv.setFloat32(offset, b.vz, true); offset += 4
      dv.setUint8(offset, b.bulletType); offset += 1
    }
  }

  if (explosions) {
    dv.setUint16(offset, explosions.length, true); offset += 2
    for (const e of explosions) {
      dv.setFloat32(offset, e.x, true); offset += 4
      dv.setFloat32(offset, e.z, true); offset += 4
      dv.setFloat32(offset, e.radius, true); offset += 4
    }
  }

  if (laserBeams) {
    dv.setUint16(offset, laserBeams.length, true); offset += 2
    for (const lb of laserBeams) {
      dv.setFloat32(offset, lb.x1, true); offset += 4
      dv.setFloat32(offset, lb.z1, true); offset += 4
      dv.setFloat32(offset, lb.x2, true); offset += 4
      dv.setFloat32(offset, lb.z2, true); offset += 4
      offset = writeString(dv, offset, lb.shooterId)
      dv.setUint8(offset, lb.team); offset += 1
    }
  }

  if (vampireBeams) {
    dv.setUint16(offset, vampireBeams.length, true); offset += 2
    for (const vb of vampireBeams) {
      offset = writeString(dv, offset, vb.shooterId)
      dv.setFloat32(offset, vb.x1, true); offset += 4
      dv.setFloat32(offset, vb.z1, true); offset += 4
      dv.setFloat32(offset, vb.x2, true); offset += 4
      dv.setFloat32(offset, vb.z2, true); offset += 4
      dv.setUint8(offset, vb.team); offset += 1
      dv.setUint8(offset, vb.hitting ? 1 : 0); offset += 1
    }
  }

  return new Uint8Array(buffer)
}

export function decodeGameState(buffer: Uint8Array): Record<string, any> {
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let offset = 0

  const flags = dv.getUint8(offset); offset += 1
  const matchTime = dv.getUint32(offset, true); offset += 4

  const result: Record<string, any> = { matchTime }

  if (flags & FLAG_TANKS) {
    const count = dv.getUint16(offset, true); offset += 2
    const tanks: TankDynamic[] = []
    for (let i = 0; i < count; i++) {
      let id: string
      ;[id, offset] = readString(dv, offset)
      const x = dv.getFloat32(offset, true); offset += 4
      const z = dv.getFloat32(offset, true); offset += 4
      const rot = dv.getFloat32(offset, true); offset += 4
      const tRot = dv.getFloat32(offset, true); offset += 4
      const hp = dv.getUint16(offset, true); offset += 2
      const alive = dv.getUint8(offset) === 1; offset += 1
      const laserCharge = dv.getFloat32(offset, true); offset += 4
      tanks.push({ id, x, z, rot, tRot, hp, alive, laserCharge })
    }
    result.tanks = tanks
  }

  if (flags & FLAG_BULLETS) {
    const count = dv.getUint16(offset, true); offset += 2
    const bullets: any[] = []
    for (let i = 0; i < count; i++) {
      let id: string
      ;[id, offset] = readString(dv, offset)
      const x = dv.getFloat32(offset, true); offset += 4
      const z = dv.getFloat32(offset, true); offset += 4
      const vx = dv.getFloat32(offset, true); offset += 4
      const vz = dv.getFloat32(offset, true); offset += 4
      const bulletType = dv.getUint8(offset); offset += 1
      bullets.push({ id, x, z, vx, vz, bulletType })
    }
    result.bullets = bullets
  }

  if (flags & FLAG_EXPLOSIONS) {
    const count = dv.getUint16(offset, true); offset += 2
    const explosions: any[] = []
    for (let i = 0; i < count; i++) {
      const x = dv.getFloat32(offset, true); offset += 4
      const z = dv.getFloat32(offset, true); offset += 4
      const radius = dv.getFloat32(offset, true); offset += 4
      explosions.push({ x, z, radius })
    }
    result.explosions = explosions
  }

  if (flags & FLAG_LASERS) {
    const count = dv.getUint16(offset, true); offset += 2
    const laserBeams: any[] = []
    for (let i = 0; i < count; i++) {
      const x1 = dv.getFloat32(offset, true); offset += 4
      const z1 = dv.getFloat32(offset, true); offset += 4
      const x2 = dv.getFloat32(offset, true); offset += 4
      const z2 = dv.getFloat32(offset, true); offset += 4
      let shooterId: string
      ;[shooterId, offset] = readString(dv, offset)
      const team = dv.getUint8(offset); offset += 1
      laserBeams.push({ x1, z1, x2, z2, shooterId, team })
    }
    result.laserBeams = laserBeams
  }

  if (flags & FLAG_VAMPIRES) {
    const count = dv.getUint16(offset, true); offset += 2
    const vampireBeams: any[] = []
    for (let i = 0; i < count; i++) {
      let shooterId: string
      ;[shooterId, offset] = readString(dv, offset)
      const x1 = dv.getFloat32(offset, true); offset += 4
      const z1 = dv.getFloat32(offset, true); offset += 4
      const x2 = dv.getFloat32(offset, true); offset += 4
      const z2 = dv.getFloat32(offset, true); offset += 4
      const team = dv.getUint8(offset); offset += 1
      const hitting = dv.getUint8(offset) === 1; offset += 1
      vampireBeams.push({ shooterId, x1, z1, x2, z2, team, hitting })
    }
    result.vampireBeams = vampireBeams
  }

  return result
}
