// @fluxstack/live-cli — Minimal msgpack decoder for binary room frames
// Decodes the subset used by FluxStack wire protocol (no external deps)

const decoder = new TextDecoder()

export function decodeMsgpack(buf: Uint8Array): unknown {
  const result = decodeAt(buf, 0)
  return result.value
}

function decodeAt(buf: Uint8Array, pos: number): { value: unknown; offset: number } {
  if (pos >= buf.length) return { value: null, offset: pos }

  const b = buf[pos]
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  // positive fixint
  if (b <= 0x7f) return { value: b, offset: pos + 1 }
  // fixmap
  if ((b & 0xf0) === 0x80) return readMap(buf, pos + 1, b & 0x0f)
  // fixarray
  if ((b & 0xf0) === 0x90) return readArray(buf, pos + 1, b & 0x0f)
  // fixstr
  if ((b & 0xe0) === 0xa0) {
    const n = b & 0x1f
    return { value: decoder.decode(buf.subarray(pos + 1, pos + 1 + n)), offset: pos + 1 + n }
  }
  // negative fixint
  if (b >= 0xe0) return { value: b - 256, offset: pos + 1 }

  switch (b) {
    case 0xc0: return { value: null, offset: pos + 1 }
    case 0xc2: return { value: false, offset: pos + 1 }
    case 0xc3: return { value: true, offset: pos + 1 }

    // bin 8/16/32
    case 0xc4: { const n = buf[pos + 1]; return { value: buf.slice(pos + 2, pos + 2 + n), offset: pos + 2 + n } }
    case 0xc5: { const n = view.getUint16(pos + 1, false); return { value: buf.slice(pos + 3, pos + 3 + n), offset: pos + 3 + n } }
    case 0xc6: { const n = view.getUint32(pos + 1, false); return { value: buf.slice(pos + 5, pos + 5 + n), offset: pos + 5 + n } }

    // float32/64
    case 0xca: return { value: view.getFloat32(pos + 1, false), offset: pos + 5 }
    case 0xcb: return { value: view.getFloat64(pos + 1, false), offset: pos + 9 }

    // uint 8/16/32
    case 0xcc: return { value: buf[pos + 1], offset: pos + 2 }
    case 0xcd: return { value: view.getUint16(pos + 1, false), offset: pos + 3 }
    case 0xce: return { value: view.getUint32(pos + 1, false), offset: pos + 5 }

    // int 8/16/32
    case 0xd0: return { value: view.getInt8(pos + 1), offset: pos + 2 }
    case 0xd1: return { value: view.getInt16(pos + 1, false), offset: pos + 3 }
    case 0xd2: return { value: view.getInt32(pos + 1, false), offset: pos + 5 }

    // str 8/16/32
    case 0xd9: { const n = buf[pos + 1]; return { value: decoder.decode(buf.subarray(pos + 2, pos + 2 + n)), offset: pos + 2 + n } }
    case 0xda: { const n = view.getUint16(pos + 1, false); return { value: decoder.decode(buf.subarray(pos + 3, pos + 3 + n)), offset: pos + 3 + n } }
    case 0xdb: { const n = view.getUint32(pos + 1, false); return { value: decoder.decode(buf.subarray(pos + 5, pos + 5 + n)), offset: pos + 5 + n } }

    // array 16/32
    case 0xdc: return readArray(buf, pos + 3, view.getUint16(pos + 1, false))
    case 0xdd: return readArray(buf, pos + 5, view.getUint32(pos + 1, false))

    // map 16/32
    case 0xde: return readMap(buf, pos + 3, view.getUint16(pos + 1, false))
    case 0xdf: return readMap(buf, pos + 5, view.getUint32(pos + 1, false))

    default:
      return { value: `<0x${b.toString(16)}>`, offset: pos + 1 }
  }
}

function readArray(buf: Uint8Array, offset: number, count: number): { value: unknown[]; offset: number } {
  const arr: unknown[] = []
  for (let i = 0; i < count; i++) {
    const r = decodeAt(buf, offset)
    arr.push(r.value)
    offset = r.offset
  }
  return { value: arr, offset }
}

function readMap(buf: Uint8Array, offset: number, count: number): { value: Record<string, unknown>; offset: number } {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < count; i++) {
    const k = decodeAt(buf, offset)
    const v = decodeAt(buf, k.offset)
    obj[String(k.value)] = v.value
    offset = v.offset
  }
  return { value: obj, offset }
}

/** Decode a FluxStack binary room frame */
export function decodeBinaryFrame(buf: Uint8Array): {
  frameType: number
  componentId: string
  roomId: string
  event: string
  data: unknown
} | null {
  try {
    if (buf.length < 6) return null
    let pos = 0

    const frameType = buf[pos++]
    const compIdLen = buf[pos++]
    if (pos + compIdLen > buf.length) return null
    const componentId = decoder.decode(buf.subarray(pos, pos + compIdLen))
    pos += compIdLen

    const roomIdLen = buf[pos++]
    if (pos + roomIdLen > buf.length) return null
    const roomId = decoder.decode(buf.subarray(pos, pos + roomIdLen))
    pos += roomIdLen

    if (pos + 2 > buf.length) return null
    const eventLen = (buf[pos] << 8) | buf[pos + 1]
    pos += 2

    if (pos + eventLen > buf.length) return null
    const event = decoder.decode(buf.subarray(pos, pos + eventLen))
    pos += eventLen

    const payload = buf.subarray(pos)
    const data = payload.length > 0 ? decodeMsgpack(payload) : null

    return { frameType, componentId, roomId, event, data }
  } catch {
    return null
  }
}
