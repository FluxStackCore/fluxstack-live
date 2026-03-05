// @fluxstack/live - Room Event Bus (Pub/Sub server-side)

type EventHandler<T = any> = (data: T) => void

interface RoomSubscription {
  roomType: string
  roomId: string
  event: string
  handler: EventHandler
  componentId: string
}

export function createTypedRoomEventBus<TRoomEvents extends Record<string, Record<string, any>>>() {
  const subscriptions = new Map<string, Set<RoomSubscription>>()
  /** Reverse index: componentId -> Set of subscription keys for O(1) unsubscribeAll */
  const componentIndex = new Map<string, Set<string>>()

  const getKey = (roomType: string, roomId: string, event: string) =>
    `${roomType}:${roomId}:${event}`

  const getRoomKey = (roomType: string, roomId: string) =>
    `${roomType}:${roomId}`

  return {
    on<K extends keyof TRoomEvents, E extends keyof TRoomEvents[K]>(
      roomType: K,
      roomId: string,
      event: E,
      componentId: string,
      handler: EventHandler<TRoomEvents[K][E]>
    ): () => void {
      const key = getKey(roomType as string, roomId, event as string)

      if (!subscriptions.has(key)) {
        subscriptions.set(key, new Set())
      }

      const subscription: RoomSubscription = {
        roomType: roomType as string,
        roomId,
        event: event as string,
        handler,
        componentId
      }

      subscriptions.get(key)!.add(subscription)

      // Update reverse index
      if (!componentIndex.has(componentId)) {
        componentIndex.set(componentId, new Set())
      }
      componentIndex.get(componentId)!.add(key)

      return () => {
        subscriptions.get(key)?.delete(subscription)
        if (subscriptions.get(key)?.size === 0) {
          subscriptions.delete(key)
        }
      }
    },

    emit<K extends keyof TRoomEvents, E extends keyof TRoomEvents[K]>(
      roomType: K,
      roomId: string,
      event: E,
      data: TRoomEvents[K][E],
      excludeComponentId?: string
    ): number {
      const key = getKey(roomType as string, roomId, event as string)
      const subs = subscriptions.get(key)

      if (!subs || subs.size === 0) return 0

      let notified = 0
      for (const sub of subs) {
        if (excludeComponentId && sub.componentId === excludeComponentId) continue

        try {
          sub.handler(data)
          notified++
        } catch (error) {
          console.error(`[RoomEventBus] Error in handler [${key}]:`, error)
        }
      }

      return notified
    },

    unsubscribeAll(componentId: string): number {
      const keys = componentIndex.get(componentId)
      if (!keys) return 0

      let removed = 0

      for (const key of keys) {
        const subs = subscriptions.get(key)
        if (!subs) continue

        for (const sub of subs) {
          if (sub.componentId === componentId) {
            subs.delete(sub)
            removed++
          }
        }

        if (subs.size === 0) {
          subscriptions.delete(key)
        }
      }

      componentIndex.delete(componentId)
      return removed
    },

    clearRoom<K extends keyof TRoomEvents>(roomType: K, roomId: string): number {
      const prefix = getRoomKey(roomType as string, roomId)
      let removed = 0

      for (const key of subscriptions.keys()) {
        if (key.startsWith(prefix)) {
          const subs = subscriptions.get(key)
          if (subs) {
            // Clean reverse index for all affected components
            for (const sub of subs) {
              componentIndex.get(sub.componentId)?.delete(key)
            }
            removed += subs.size
          }
          subscriptions.delete(key)
        }
      }

      return removed
    },

    getStats(): { totalSubscriptions: number; rooms: Record<string, { events: Record<string, number> }> } {
      const rooms: Record<string, { events: Record<string, number> }> = {}
      let total = 0

      for (const [key, subs] of subscriptions) {
        const parts = key.split(':')
        const roomKey = `${parts[0]}:${parts[1]}`
        const event = parts[2] ?? ''

        if (!rooms[roomKey]) {
          rooms[roomKey] = { events: {} }
        }

        rooms[roomKey]!.events[event] = subs.size
        total += subs.size
      }

      return { totalSubscriptions: total, rooms }
    }
  }
}

export class RoomEventBus {
  private subscriptions = new Map<string, Set<RoomSubscription>>()
  /** Reverse index: componentId -> Set of subscription keys for O(1) unsubscribeAll */
  private componentIndex = new Map<string, Set<string>>()

  private getKey(roomType: string, roomId: string, event: string): string {
    return `${roomType}:${roomId}:${event}`
  }

  on(roomType: string, roomId: string, event: string, componentId: string, handler: EventHandler): () => void {
    const key = this.getKey(roomType, roomId, event)

    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, new Set())
    }

    const subscription: RoomSubscription = { roomType, roomId, event, handler, componentId }
    this.subscriptions.get(key)!.add(subscription)

    // Update reverse index
    if (!this.componentIndex.has(componentId)) {
      this.componentIndex.set(componentId, new Set())
    }
    this.componentIndex.get(componentId)!.add(key)

    return () => {
      this.subscriptions.get(key)?.delete(subscription)
      if (this.subscriptions.get(key)?.size === 0) {
        this.subscriptions.delete(key)
      }
      // Cleanup reverse index (lazy: remove key entry only in unsubscribeAll)
    }
  }

  emit(roomType: string, roomId: string, event: string, data: any, excludeComponentId?: string): number {
    const key = this.getKey(roomType, roomId, event)
    const subs = this.subscriptions.get(key)

    if (!subs || subs.size === 0) return 0

    let notified = 0
    for (const sub of subs) {
      if (excludeComponentId && sub.componentId === excludeComponentId) continue

      try {
        sub.handler(data)
        notified++
      } catch (error) {
        console.error(`[RoomEventBus] Error in handler [${key}]:`, error)
      }
    }

    return notified
  }

  unsubscribeAll(componentId: string): number {
    const keys = this.componentIndex.get(componentId)
    if (!keys) return 0

    let removed = 0

    for (const key of keys) {
      const subs = this.subscriptions.get(key)
      if (!subs) continue

      for (const sub of subs) {
        if (sub.componentId === componentId) {
          subs.delete(sub)
          removed++
        }
      }

      if (subs.size === 0) {
        this.subscriptions.delete(key)
      }
    }

    this.componentIndex.delete(componentId)
    return removed
  }

  clearRoom(roomType: string, roomId: string): number {
    const prefix = `${roomType}:${roomId}`
    let removed = 0

    for (const key of this.subscriptions.keys()) {
      if (key.startsWith(prefix)) {
        const subs = this.subscriptions.get(key)
        if (subs) {
          // Clean reverse index for all affected components
          for (const sub of subs) {
            this.componentIndex.get(sub.componentId)?.delete(key)
          }
          removed += subs.size
        }
        this.subscriptions.delete(key)
      }
    }

    return removed
  }

  getStats() {
    const rooms: Record<string, { events: Record<string, number> }> = {}
    let total = 0

    for (const [key, subs] of this.subscriptions) {
      const parts = key.split(':')
      const roomKey = `${parts[0]}:${parts[1]}`
      const event = parts[2] ?? ''

      if (!rooms[roomKey]) {
        rooms[roomKey] = { events: {} }
      }

      rooms[roomKey]!.events[event] = subs.size
      total += subs.size
    }

    return { totalSubscriptions: total, rooms }
  }
}

export type { EventHandler, RoomSubscription }
