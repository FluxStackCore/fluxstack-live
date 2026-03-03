import { LiveComponent } from '@fluxstack/live'

interface ChatMessage {
  id: string
  user: string
  text: string
  time: number
  color: string
}

// Deterministic color from username
const USER_COLORS = [
  '#38bdf8', '#22c55e', '#f59e0b', '#ef4444', '#a78bfa',
  '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#8b5cf6',
]

function hashColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length]
}

export class Chat extends LiveComponent<typeof Chat.defaultState> {
  static componentName = 'Chat'
  static publicActions = ['join', 'sendMessage', 'typing'] as const
  static defaultState = {
    messages: [] as ChatMessage[],
    username: '',
    userColor: '',
    joined: false,
    onlineUsers: [] as { name: string; color: string }[],
    typingUsers: [] as string[],
  }

  private _typingTimeout: ReturnType<typeof setTimeout> | null = null

  async join(payload: { username: string }) {
    const username = (payload.username || '').trim()
    if (!username) return { success: false, error: 'Username required' }

    const color = hashColor(username)
    this.state.username = username
    this.state.userColor = color
    this.state.joined = true

    // Join the shared chat room
    this.$room('chat-global').join()

    // Listen for messages from other users
    this.$room('chat-global').on('chat:message', (msg: ChatMessage) => {
      this.setState({
        messages: [...(this._rawState().messages), msg],
      })
    })

    // Listen for user join/leave notifications
    this.$room('chat-global').on('chat:system', (msg: ChatMessage) => {
      this.setState({
        messages: [...(this._rawState().messages), msg],
      })
    })

    // Listen for online users list updates
    this.$room('chat-global').on('chat:online', (users: { name: string; color: string }[]) => {
      this.setState({ onlineUsers: users })
    })

    // Listen for typing indicator updates
    this.$room('chat-global').on('chat:typing', (typingUsers: string[]) => {
      // Filter out myself from typing list
      const filtered = typingUsers.filter(u => u !== this.state.username)
      this.setState({ typingUsers: filtered })
    })

    // Notify others that user joined
    this.$room('chat-global').emit('chat:system', {
      id: `sys-${Date.now()}`,
      user: 'system',
      text: `${username} entrou no chat`,
      time: Date.now(),
      color: '',
    })

    // Broadcast updated online users
    this.$room('chat-global').emit('chat:user-joined', { name: username, color })

    // Set own online users list (will be updated by broadcasts)
    this.state.onlineUsers = [{ name: username, color }]

    return { success: true, username, color }
  }

  async sendMessage(payload: { text: string }) {
    const text = (payload.text || '').trim()
    if (!text) return { success: false, error: 'Message required' }
    if (!this.state.joined) return { success: false, error: 'Not joined' }

    const msg: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      user: this.state.username,
      text,
      time: Date.now(),
      color: this.state.userColor,
    }

    // Add to MY state
    this.setState({
      messages: [...(this._rawState().messages), msg],
    })

    // Broadcast to others in the room
    this.$room('chat-global').emit('chat:message', msg)

    // Clear my typing state
    this.$room('chat-global').emit('chat:user-stopped-typing', this.state.username)

    return { success: true }
  }

  async typing() {
    if (!this.state.joined) return
    this.$room('chat-global').emit('chat:user-typing', this.state.username)
    return { success: true }
  }

  protected onDestroy() {
    if (this.state.joined && this.state.username) {
      this.$room('chat-global').emit('chat:system', {
        id: `sys-${Date.now()}`,
        user: 'system',
        text: `${this.state.username} saiu do chat`,
        time: Date.now(),
        color: '',
      })
      this.$room('chat-global').emit('chat:user-left', this.state.username)
    }
    if (this._typingTimeout) clearTimeout(this._typingTimeout)
  }

  // Helper to read raw state (avoids proxy triggering emit when reading arrays)
  private _rawState() {
    return (this as any)._state as typeof Chat.defaultState
  }
}
