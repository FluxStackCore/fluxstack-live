// Limites do decoder msgpack do core (auditoria 2026-09-26).
import { describe, it, expect } from 'vitest'
import { msgpackCodec, MSGPACK_MAX_DEPTH } from '../../rooms/RoomCodec'
const msgpackEncode = (v: unknown) => msgpackCodec.encode(v)
const msgpackDecode = (b: Uint8Array) => msgpackCodec.decode(b)

describe('msgpackDecode — limites de segurança', () => {
  it('rejeita aninhamento acima de MSGPACK_MAX_DEPTH', () => {
    // fixarray(1) repetido: 0x91 0x91 ... 0x01
    const buf = new Uint8Array(MSGPACK_MAX_DEPTH + 10).fill(0x91)
    buf[buf.length - 1] = 0x01
    expect(() => msgpackDecode(buf)).toThrow(/too deep/)
  })

  it('aceita aninhamento dentro do limite', () => {
    let v: unknown = 1
    for (let i = 0; i < 20; i++) v = [v]
    expect(msgpackDecode(msgpackEncode(v))).toEqual(v)
  })

  it('não aloca array gigante a partir de contagem mentirosa', () => {
    // array32 com count = 0xFFFFFFFF e nenhum item
    const buf = new Uint8Array([0xdd, 0xff, 0xff, 0xff, 0xff])
    expect(() => msgpackDecode(buf)).toThrow(/exceeds remaining/)
  })

  it('descarta chaves __proto__ / constructor', () => {
    const obj = msgpackDecode(msgpackEncode({ ['__proto__']: { admin: true }, ok: 1 } as any)) as any
    expect(obj.ok).toBe(1)
    expect(({} as any).admin).toBeUndefined()
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype)
  })
})
