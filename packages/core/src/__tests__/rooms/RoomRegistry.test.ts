// RoomRegistry — registration, lookup, compound-id resolution, type guard.
// Zero coverage previously despite being the single source of truth for
// LiveRoom dispatch.

import { describe, it, expect, beforeEach } from 'vitest'
import { RoomRegistry } from '../../rooms/RoomRegistry'
import { LiveRoom } from '../../rooms/LiveRoom'

class ChatRoom extends LiveRoom<{ messages: string[] }> {
  static roomName = 'chat'
  static defaultState = { messages: [] as string[] }
}

class GameRoom extends LiveRoom<{ score: number }> {
  static roomName = 'game'
  static defaultState = { score: 0 }
}

class HyphenatedRoom extends LiveRoom<{ x: number }> {
  static roomName = 'my-room'
  static defaultState = { x: 0 }
}

let reg: RoomRegistry
beforeEach(() => { reg = new RoomRegistry() })

describe('RoomRegistry.register', () => {
  it('registers a valid LiveRoom subclass', () => {
    reg.register(ChatRoom as any)
    expect(reg.has('chat')).toBe(true)
  })

  it('throws when roomName is missing', () => {
    class NoName extends LiveRoom<{ x: number }> {
      static defaultState = { x: 0 }
    }
    expect(() => reg.register(NoName as any)).toThrow(/must define static roomName/)
  })

  it('throws on duplicate registration', () => {
    reg.register(ChatRoom as any)
    expect(() => reg.register(ChatRoom as any)).toThrow(/already registered/)
  })

  it('allows distinct roomNames to coexist', () => {
    reg.register(ChatRoom as any)
    reg.register(GameRoom as any)
    expect(reg.getRegisteredNames().sort()).toEqual(['chat', 'game'])
  })
})

describe('RoomRegistry.get / has', () => {
  it('returns the class for a registered name', () => {
    reg.register(ChatRoom as any)
    expect(reg.get('chat')).toBe(ChatRoom)
  })

  it('returns undefined for an unknown name', () => {
    expect(reg.get('ghost')).toBeUndefined()
    expect(reg.has('ghost')).toBe(false)
  })
})

describe('RoomRegistry.resolveFromId', () => {
  beforeEach(() => {
    reg.register(ChatRoom as any)
    reg.register(GameRoom as any)
    reg.register(HyphenatedRoom as any)
  })

  it('resolves chat:lobby → ChatRoom', () => {
    expect(reg.resolveFromId('chat:lobby')).toBe(ChatRoom)
  })

  it('resolves my-room:any → HyphenatedRoom (hyphens in prefix allowed)', () => {
    expect(reg.resolveFromId('my-room:test')).toBe(HyphenatedRoom)
  })

  it('returns undefined for ids without a colon', () => {
    expect(reg.resolveFromId('chat')).toBeUndefined()
    expect(reg.resolveFromId('justaroom')).toBeUndefined()
  })

  it('returns undefined for unknown prefix', () => {
    expect(reg.resolveFromId('unknown:x')).toBeUndefined()
  })

  it('uses only the prefix before the FIRST colon (chat:a:b → ChatRoom)', () => {
    expect(reg.resolveFromId('chat:a:b:c')).toBe(ChatRoom)
  })

  it('empty prefix (":lobby") resolves to undefined', () => {
    expect(reg.resolveFromId(':lobby')).toBeUndefined()
  })
})

describe('RoomRegistry.getRegisteredNames', () => {
  it('returns an empty array when nothing is registered', () => {
    expect(reg.getRegisteredNames()).toEqual([])
  })

  it('returns all registered names', () => {
    reg.register(ChatRoom as any)
    reg.register(GameRoom as any)
    expect(reg.getRegisteredNames().sort()).toEqual(['chat', 'game'])
  })
})

describe('RoomRegistry.isLiveRoomClass', () => {
  it('recognizes a LiveRoom subclass', () => {
    expect(RoomRegistry.isLiveRoomClass(ChatRoom)).toBe(true)
  })

  it('rejects a plain function', () => {
    expect(RoomRegistry.isLiveRoomClass(() => {})).toBe(false)
  })

  it('rejects null / undefined / primitives', () => {
    expect(RoomRegistry.isLiveRoomClass(null)).toBe(false)
    expect(RoomRegistry.isLiveRoomClass(undefined)).toBe(false)
    expect(RoomRegistry.isLiveRoomClass('chat')).toBe(false)
    expect(RoomRegistry.isLiveRoomClass(42)).toBe(false)
  })

  it('rejects a class without roomName', () => {
    class Bare {}
    expect(RoomRegistry.isLiveRoomClass(Bare)).toBe(false)
  })

  it('rejects a class with roomName but not extending LiveRoom', () => {
    class Fake {
      static roomName = 'fake'
    }
    expect(RoomRegistry.isLiveRoomClass(Fake)).toBe(false)
  })

  it('recognizes a subclass of a LiveRoom subclass (deep prototype chain)', () => {
    class GameTournamentRoom extends GameRoom {
      static roomName = 'tournament'
    }
    expect(RoomRegistry.isLiveRoomClass(GameTournamentRoom)).toBe(true)
  })
})
