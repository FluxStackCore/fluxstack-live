import { LiveComponent, type GenericWebSocket } from '@fluxstack/live'

const ROOM_ID = 'shared-counter'

export class SharedCounter extends LiveComponent<typeof SharedCounter.defaultState> {
  static componentName = 'SharedCounter'
  static publicActions = ['increment', 'decrement', 'reset'] as const
  static defaultState = {
    count: 0,
    lastUser: null as string | null,
    viewers: 0,
  }

  constructor(initialState: Partial<typeof SharedCounter.defaultState>, ws: GenericWebSocket, options?: { room?: string; userId?: string }) {
    super(initialState, ws, options)

    this.$room(ROOM_ID).join()

    // Sync with current room state (if other instances already changed the count)
    const roomState = this.$room(ROOM_ID).state
    if (roomState.count !== undefined) {
      this.setState({ count: roomState.count, lastUser: roomState.lastUser ?? null })
    }

    // Listen for changes from OTHER instances
    this.$room(ROOM_ID).on('counter:update', (data: { count: number; lastUser: string }) => {
      this.setState({ count: data.count, lastUser: data.lastUser })
    })

    this.$room(ROOM_ID).on('counter:viewers', (data: { viewers: number }) => {
      this.setState({ viewers: data.viewers })
    })

    // Broadcast updated viewer count
    const viewers = this.getRoomMemberCount()
    this.$room(ROOM_ID).setState({ viewers })
    this.setState({ viewers })
    this.$room(ROOM_ID).emit('counter:viewers', { viewers })
  }

  private getRoomMemberCount(): number {
    // Room state tracks the count; we update it on join/leave
    return (this.$room(ROOM_ID).state.viewers ?? 0) + 1
  }

  async increment() {
    const count = (this.$room(ROOM_ID).state.count ?? 0) + 1
    const userId = this.id.slice(-6)

    // Update room state (shared source of truth)
    this.$room(ROOM_ID).setState({ count, lastUser: userId })

    // Update own state
    this.setState({ count, lastUser: userId })

    // Notify others
    this.$room(ROOM_ID).emit('counter:update', { count, lastUser: userId })

    return { success: true, count }
  }

  async decrement() {
    const count = (this.$room(ROOM_ID).state.count ?? 0) - 1
    const userId = this.id.slice(-6)

    this.$room(ROOM_ID).setState({ count, lastUser: userId })
    this.setState({ count, lastUser: userId })
    this.$room(ROOM_ID).emit('counter:update', { count, lastUser: userId })

    return { success: true, count }
  }

  async reset() {
    const userId = this.id.slice(-6)

    this.$room(ROOM_ID).setState({ count: 0, lastUser: userId })
    this.setState({ count: 0, lastUser: userId })
    this.$room(ROOM_ID).emit('counter:update', { count: 0, lastUser: userId })

    return { success: true, count: 0 }
  }

  destroy() {
    // Update viewer count when leaving
    const viewers = Math.max(0, (this.$room(ROOM_ID).state.viewers ?? 1) - 1)
    this.$room(ROOM_ID).setState({ viewers })
    this.$room(ROOM_ID).emit('counter:viewers', { viewers })
    super.destroy()
  }
}
