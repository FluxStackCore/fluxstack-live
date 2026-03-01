import { LiveComponent, type GenericWebSocket } from '@fluxstack/live'

interface Message {
  id: number
  user: string
  text: string
  time: string
}

export class ChatRoom extends LiveComponent<typeof ChatRoom.defaultState> {
  static componentName = 'ChatRoom'
  static publicActions = ['sendMessage', 'setUsername', 'joinRoom', 'leaveRoom'] as const
  static defaultState = {
    messages: [] as Message[],
    users: [] as string[],
    currentRoom: '' as string,
    username: '' as string,
  }

  constructor(initialState: Partial<typeof ChatRoom.defaultState>, ws: GenericWebSocket, options?: { room?: string; userId?: string }) {
    super(initialState, ws, options)

    if (this.room) {
      this.setupRoomEvents(this.room)
    }
  }

  private setupRoomEvents(roomId: string) {
    this.$room(roomId).join()

    this.$room(roomId).on('chat:message', (msg: Message) => {
      const messages = [...this.state.messages, msg].slice(-50)
      this.setState({ messages })
    })

    this.$room(roomId).on('chat:user_joined', (data: { user: string; users: string[] }) => {
      this.setState({ users: data.users })
    })

    this.$room(roomId).on('chat:user_left', (data: { user: string; users: string[] }) => {
      this.setState({ users: data.users })
    })
  }

  async setUsername(payload: { username: string }) {
    this.setState({ username: payload.username })
    return { success: true }
  }

  async joinRoom(payload: { roomId: string }) {
    const roomId = payload.roomId
    const username = this.state.username || 'Anonymous'

    // Leave current room if in one
    if (this.state.currentRoom) {
      this.$room(this.state.currentRoom).emit('chat:user_left', {
        user: username,
        users: []
      })
      this.$room(this.state.currentRoom).leave()
    }

    // Join new room
    this.setupRoomEvents(roomId)

    // System message (update own state + notify others)
    const sysMsg: Message = {
      id: Date.now(),
      user: 'System',
      text: `${username} joined the room`,
      time: new Date().toLocaleTimeString()
    }

    // Update own state first
    this.setState({
      currentRoom: roomId,
      messages: [sysMsg],
      users: [username]
    })

    // Notify others in room
    this.$room(roomId).emit('chat:user_joined', {
      user: username,
      users: [username]
    })
    this.$room(roomId).emit('chat:message', sysMsg)

    return { success: true, roomId }
  }

  async leaveRoom() {
    if (!this.state.currentRoom) return { success: false }
    const username = this.state.username || 'Anonymous'
    const roomId = this.state.currentRoom

    this.$room(roomId).emit('chat:user_left', {
      user: username,
      users: []
    })
    this.$room(roomId).leave()
    this.setState({ currentRoom: '', messages: [], users: [] })

    return { success: true }
  }

  async sendMessage(payload: { text: string }) {
    if (!this.state.currentRoom) return { success: false, error: 'Not in a room' }

    const msg: Message = {
      id: Date.now(),
      user: this.state.username || 'Anonymous',
      text: payload.text,
      time: new Date().toLocaleTimeString()
    }

    // 1. Update own state (sender sees their own message immediately)
    const messages = [...this.state.messages, msg].slice(-50)
    this.setState({ messages })

    // 2. Notify others in room (they receive via room event -> setState in their handler)
    this.$room(this.state.currentRoom).emit('chat:message', msg)

    return { success: true }
  }

  destroy() {
    if (this.state.currentRoom) {
      const username = this.state.username || 'Anonymous'
      this.$room(this.state.currentRoom).emit('chat:user_left', {
        user: username,
        users: []
      })
    }
    super.destroy()
  }
}
