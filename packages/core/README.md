# @fluxstack/live

Framework-agnostic core for real-time server-client state synchronization.

Live Components turn server-side classes into reactive state that syncs automatically with connected clients over WebSocket. Write your logic once on the server, and clients receive state updates in real-time.

## Installation

```bash
bun add @fluxstack/live
```

## Quick Start

```typescript
import { LiveServer, LiveComponent } from '@fluxstack/live'

// 1. Define a component
class Counter extends LiveComponent<{ count: number }> {
  static componentName = 'Counter'
  static defaultState = { count: 0 }
  static publicActions = ['increment', 'decrement'] as const

  increment() {
    this.count++
  }

  decrement() {
    this.count--
  }
}

// 2. Create server with your transport adapter
import { ElysiaTransport } from '@fluxstack/live-elysia'

const server = new LiveServer({
  transport: new ElysiaTransport(app),
  componentsPath: './src/components',
})

await server.start()
```

## Features

- **LiveComponent** — Base class with reactive state proxy, auto-sync, and lifecycle hooks
- **LiveServer** — Orchestrator that wires transport, components, auth, rooms, and cluster
- **ComponentRegistry** — Auto-discovers components from a directory or manual registration
- **Rooms** — Built-in room system with typed events and cross-instance pub/sub
- **Auth** — Per-component and per-action authorization (`static auth`, `static actionAuth`)
- **State Signing** — HMAC-SHA256 state signing with hybrid nonce replay protection
- **Rate Limiting** — Token bucket rate limiter per connection
- **Security** — Payload sanitization against prototype pollution, message size limits
- **Binary Delta** — Efficient binary state diffs for high-frequency updates
- **File Upload** — Chunked file upload over WebSocket
- **Cluster** — `IClusterAdapter` interface for horizontal scaling (singleton coordination, action forwarding, state mirroring)
- **Monitoring** — Performance monitor with per-component metrics

## Transport Adapters

This package is framework-agnostic. Use it with any transport adapter:

| Adapter | Package |
|---------|---------|
| Elysia | `@fluxstack/live-elysia` |
| Express | `@fluxstack/live-express` |
| Fastify | `@fluxstack/live-fastify` |

## LiveComponent

```typescript
import { LiveComponent } from '@fluxstack/live'

export class TodoList extends LiveComponent<typeof TodoList.defaultState> {
  static componentName = 'TodoList'
  static singleton = true
  static publicActions = ['addTodo', 'toggleTodo'] as const
  static defaultState = {
    todos: [] as { id: string; text: string; done: boolean }[]
  }

  declare todos: typeof TodoList.defaultState['todos']

  addTodo(payload: { text: string }) {
    this.todos = [...this.todos, { id: crypto.randomUUID(), text: payload.text, done: false }]
  }

  toggleTodo(payload: { id: string }) {
    this.todos = this.todos.map(t =>
      t.id === payload.id ? { ...t, done: !t.done } : t
    )
  }
}
```

### Lifecycle Hooks

```typescript
class MyComponent extends LiveComponent<State> {
  protected onConnect() { }           // WebSocket connected
  protected async onMount() { }       // Component fully mounted (async)
  protected onRehydrate(prev) { }     // State restored from client
  protected onStateChange(changes) { } // After state mutation
  protected onRoomJoin(roomId) { }    // Joined a room
  protected onRoomLeave(roomId) { }   // Left a room
  protected onAction(action, payload) { } // Before action (return false to cancel)
  protected onDisconnect() { }        // Connection lost
  protected onDestroy() { }           // Before cleanup (sync)
}
```

## LiveServer Options

```typescript
new LiveServer({
  transport,                         // Required: transport adapter
  componentsPath: './components',    // Auto-discover components
  wsPath: '/api/live/ws',            // WebSocket endpoint (default)
  debug: false,                      // Debug mode
  cluster: clusterAdapter,           // IClusterAdapter for horizontal scaling
  roomPubSub: roomAdapter,           // IRoomPubSubAdapter for cross-instance rooms
  allowedOrigins: ['https://...'],   // CSRF protection
  rateLimitMaxTokens: 100,           // Rate limiter max tokens
  rateLimitRefillRate: 10,           // Tokens refilled per second
  httpPrefix: '/api/live',           // HTTP monitoring routes
})
```

## Horizontal Scaling

```typescript
import { RedisClusterAdapter, RedisRoomAdapter } from '@fluxstack/live-redis'

const server = new LiveServer({
  transport,
  cluster: new RedisClusterAdapter({ redis }),
  roomPubSub: new RedisRoomAdapter({ redis }),
})
```

See `@fluxstack/live-redis` for details.

## License

MIT
