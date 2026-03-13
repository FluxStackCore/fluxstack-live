// @fluxstack/live - Room Registry
//
// Maps room type names to LiveRoom classes.
// Used by LiveRoomManager to instantiate room instances with lifecycle hooks.

import { LiveRoom, type LiveRoomClass } from './LiveRoom'

export class RoomRegistry {
  private rooms = new Map<string, LiveRoomClass>()

  /**
   * Register a LiveRoom subclass.
   * @throws If the class doesn't define a static roomName
   */
  register(roomClass: LiveRoomClass): void {
    const name = roomClass.roomName
    if (!name) {
      throw new Error('LiveRoom subclass must define static roomName')
    }
    if (this.rooms.has(name)) {
      throw new Error(`LiveRoom '${name}' is already registered`)
    }
    this.rooms.set(name, roomClass)
  }

  /**
   * Get a registered room class by name.
   */
  get(name: string): LiveRoomClass | undefined {
    return this.rooms.get(name)
  }

  /**
   * Check if a room class is registered.
   */
  has(name: string): boolean {
    return this.rooms.has(name)
  }

  /**
   * Resolve a compound room ID (e.g. "chat:lobby") to its registered class.
   * Returns undefined if the prefix doesn't match any registered room.
   */
  resolveFromId(roomId: string): LiveRoomClass | undefined {
    const colonIdx = roomId.indexOf(':')
    if (colonIdx === -1) return undefined
    const prefix = roomId.substring(0, colonIdx)
    return this.rooms.get(prefix)
  }

  /**
   * Get all registered room names.
   */
  getRegisteredNames(): string[] {
    return Array.from(this.rooms.keys())
  }

  /**
   * Check if a value is a LiveRoom subclass.
   */
  static isLiveRoomClass(cls: unknown): cls is LiveRoomClass {
    if (typeof cls !== 'function' || !cls.prototype) return false
    if (typeof (cls as any).roomName !== 'string') return false
    let proto = Object.getPrototypeOf(cls.prototype)
    while (proto) {
      if (proto.constructor === LiveRoom) return true
      proto = Object.getPrototypeOf(proto)
    }
    return false
  }
}
