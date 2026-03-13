# @fluxstack/live

Real-time server-client state synchronization for any Node.js framework.

Live Components turn server-side classes into reactive state that syncs automatically with connected clients over WebSocket. Write your logic once on the server, and clients receive state updates in real-time.

## Packages

| Package | Description |
|---|---|
| `@fluxstack/live` | Framework-agnostic core (LiveServer, ComponentRegistry, auth, security, rooms) |
| `@fluxstack/live-elysia` | Elysia.js transport adapter |
| `@fluxstack/live-express` | Express transport adapter |
| `@fluxstack/live-fastify` | Fastify transport adapter |
| `@fluxstack/live-client` | Browser WebSocket client |
| `@fluxstack/live-react` | React hooks and providers (`Live.use()`) |
| `@fluxstack/live-vue` | Vue 3 composables (`useLive()`, `provideLiveConnection()`) |
| `@fluxstack/live-redis` | Redis adapters for horizontal scaling (rooms + cluster) |

## Quick Start

### Server (Elysia)

```typescript
import { Elysia } from 'elysia'
import { LiveServer } from '@fluxstack/live'
import { ElysiaTransport } from '@fluxstack/live-elysia'

const app = new Elysia()
const server = new LiveServer({
  transport: new ElysiaTransport(app),
  componentsPath: './src/components',  // auto-discovers LiveComponent classes
})

await server.start()
app.listen(3000)
```

### Component

```typescript
import { LiveComponent } from '@fluxstack/live'

export class Counter extends LiveComponent<{ count: number }> {
  static componentName = 'Counter'
  static defaultState = { count: 0 }
  static publicActions = ['increment', 'decrement'] as const

  increment() {
    this.setState({ count: this.state.count + 1 })
  }

  decrement() {
    this.setState({ count: this.state.count - 1 })
  }
}
```

### Client (React)

```tsx
import { Live } from '@fluxstack/live-react'
import type { Counter } from '../server/components/Counter'

function App() {
  const { state, call } = Live.use<Counter>('Counter')

  return (
    <div>
      <p>Count: {state.count}</p>
      <button onClick={() => call('increment')}>+</button>
      <button onClick={() => call('decrement')}>-</button>
    </div>
  )
}
```

## Features

- **Auto-discovery**: Point `componentsPath` to a directory and components are registered automatically
- **Singletons**: `static singleton = true` — one instance shared by all clients
- **Typed Rooms**: `LiveRoom<TState, TEvents>` with end-to-end type inference and binary msgpack codec
- **Auth**: Per-component and per-action authorization (`static auth`, `static actionAuth`)
- **State signing**: HMAC-SHA256 state signing for tamper detection + rehydration on reconnect
- **Rate limiting**: Per-action rate limits (`static actionRateLimit`)
- **Binary delta**: Deep diff + msgpack — only changed fields sent over the wire, zero npm dependencies
- **Horizontal scaling**: Cluster adapter for multi-server singleton coordination

## Typed Rooms (LiveRoom)

Define rooms as classes with typed state, events, and metadata. The binary codec (msgpack) is used automatically — no configuration needed.

### Room Definition

```typescript
import { LiveRoom } from '@fluxstack/live'

export class ChatRoom extends LiveRoom<
  { messages: Message[]; userCount: number },           // TState
  { 'message:new': Message; 'user:joined': { name: string } },  // TEvents
  { topic: string }                                      // TMeta (optional)
> {
  static prefix = 'chat'  // rooms created as "chat:{id}"

  onJoin(componentId: string, context?: { userId?: string }) {
    this.setState({ userCount: this.state.userCount + 1 })
    this.emit('user:joined', { name: context?.userId ?? 'Anonymous' })
  }

  onLeave(componentId: string) {
    this.setState({ userCount: this.state.userCount - 1 })
  }

  sendMessage(from: string, text: string) {
    const msg = { from, text, timestamp: Date.now() }
    this.emit('message:new', msg)  // binary msgpack broadcast to all members
    return msg
  }
}
```

### Server Component

```typescript
import { LiveComponent } from '@fluxstack/live'
import { ChatRoom } from './rooms/ChatRoom'

export class LiveChat extends LiveComponent<{ messages: Message[] }> {
  static componentName = 'LiveChat'
  static defaultState = { messages: [] }
  static publicActions = ['send'] as const

  constructor(initialState: any, ws: any, options: any) {
    super(initialState, ws, options)
    const room = this.$room(ChatRoom, 'general')  // fully typed
    room.join()
    room.on('message:new', (msg) => {              // msg is typed as Message
      this.setState({ messages: [...this.state.messages, msg] })
    })
  }

  send(payload: { text: string }) {
    const room = this.$room(ChatRoom, 'general')
    room.emit('message:new', { from: 'user', text: payload.text })
  }
}
```

### Client (React)

```tsx
import { Live } from '@fluxstack/live-react'
import type { LiveChat } from '../server/components/LiveChat'
import type { ChatRoom } from '../server/rooms/ChatRoom'

function Chat() {
  const { state, call, $room } = Live.use<LiveChat>('LiveChat')

  // Listen to binary room events (typed!)
  $room<ChatRoom>('chat:general').on('message:new', (msg) => {
    console.log(msg.from, msg.text)  // fully typed
  })

  return (
    <div>
      {state.messages.map(m => <p key={m.timestamp}>{m.text}</p>)}
      <button onClick={() => call('send', { text: 'Hello!' })}>Send</button>
    </div>
  )
}
```

### Binary Protocol

Room events and state updates are automatically serialized with msgpack (zero npm dependencies). The wire format:

```
[frameType:u8][compIdLen:u8][compId:utf8][roomIdLen:u8][roomId:utf8][eventLen:u16BE][event:utf8][payload:msgpack]
```

- Frame type `0x02`: Room event broadcast
- Frame type `0x03`: Room state update (deep diff — only changed fields)

The server encodes the payload once and prepends a per-member header, so broadcast cost is O(1) encode + O(n) header prepend.

### Custom Codec

Override the default msgpack codec per room:

```typescript
export class MyRoom extends LiveRoom<...> {
  static prefix = 'my'
  static $options = { codec: 'json' }        // JSON over binary frames
  // or: static $options = { codec: myCustomCodec }  // { encode, decode }
}
```

### State Delta Sync

Room state updates use deep diff by default. When you call `setState({ score: 10 })`, the server:

1. Computes `computeDeepDiff(currentState, updates)` — only changed fields
2. Encodes the delta with msgpack
3. Broadcasts the binary frame to all room members
4. Client applies `deepMerge(localState, delta)` — preserves unchanged fields

## Horizontal Scaling (Cluster)

When running multiple server instances behind a load balancer, singletons need coordination — only one server should own the instance, and others must proxy to it.

The cluster adapter handles this transparently:

```typescript
import Redis from 'ioredis'
import { LiveServer } from '@fluxstack/live'
import { ElysiaTransport } from '@fluxstack/live-elysia'
import { RedisClusterAdapter } from '@fluxstack/live-redis'

const app = new Elysia()
const redis = new Redis(process.env.REDIS_URL)

const server = new LiveServer({
  transport: new ElysiaTransport(app),
  componentsPath: './src/components',
  cluster: new RedisClusterAdapter({ redis }),
})
```

No changes to components or client code. The cluster adapter manages:

- **Singleton ownership**: Atomic claim via Redis `SET NX EX`. First server wins, others create transparent proxies.
- **Action forwarding**: Actions on proxy servers are forwarded to the owner via Redis pub/sub.
- **State delta broadcasting**: Owner publishes state changes; proxy servers relay to their local clients.
- **Failover recovery**: If the owner crashes, its claim expires (TTL). The next server claims ownership and recovers state from Redis.
- **Split-brain protection**: Heartbeat verifies ownership before renewing. If another server took over, the old owner is notified and stops serving.

### Architecture

```
                    Load Balancer
                   /             \
            Server A              Server B
            (owner)               (proxy)
               |                     |
         [CounterSingleton]    [RemoteProxy]
          state: {count: 5}     lastState: {count: 5}
               |                     |
            clients               clients
            ws1, ws2              ws3, ws4
               \                   /
                \                 /
              Redis (pub/sub + state mirror)
              - singleton:Counter → "instA:live-xxx"
              - singleton-state:Counter → {count: 5}
```

### Redis Keys

| Key Pattern | TTL | Purpose |
|---|---|---|
| `fluxstack:cluster:singleton:{name}` | 30s (heartbeat) | Ownership claim (atomic SET NX) |
| `fluxstack:cluster:singleton-state:{name}` | 1h | State mirror (survives crash) |
| `fluxstack:cluster:state:{componentId}` | 1h | Per-component state snapshot |
| `fluxstack:cluster:delta` (channel) | - | State delta pub/sub (global) |
| `fluxstack:cluster:actions:{instanceId}` (channel) | - | Action forwarding (per-instance) |

### Configuration

```typescript
new RedisClusterAdapter({
  redis,                          // ioredis client (required)
  subscriber: subscriberRedis,    // separate client for subscriptions (optional, auto-created)
  prefix: 'fluxstack:cluster:',   // key prefix (default)
  stateTtl: 3600,                 // state mirror TTL in seconds (default: 1h)
  singletonTtl: 30,               // singleton claim TTL in seconds (default: 30s)
  heartbeatInterval: 10_000,      // heartbeat interval in ms (default: 10s)
  actionTimeout: 5_000,           // action forwarding timeout in ms (default: 5s)
})
```

### Custom Adapter

Implement `IClusterAdapter` to use a different backend (e.g., NATS, Kafka, etcd):

```typescript
import type { IClusterAdapter } from '@fluxstack/live'

class MyClusterAdapter implements IClusterAdapter {
  readonly instanceId: string
  // ... implement all methods
}
```

## Room Scaling

For cross-instance room events (separate from singleton coordination):

```typescript
import { RedisRoomAdapter } from '@fluxstack/live-redis'

const server = new LiveServer({
  transport: new ElysiaTransport(app),
  roomPubSub: new RedisRoomAdapter({ redis }),   // room events across instances
  cluster: new RedisClusterAdapter({ redis }),    // singleton coordination
})
```

## Development

```bash
# Install
bun install

# Build all packages
bun run build

# Build specific package
bun run build:core
bun run build:client
bun run build:react

# Run tests
bunx vitest run

# Type check
bunx tsc -p packages/core/tsconfig.json --noEmit
```

## License

MIT
