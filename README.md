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
- **Rooms**: Built-in room system with typed events and cross-instance pub/sub
- **Auth**: Per-component and per-action authorization (`static auth`, `static actionAuth`)
- **State signing**: HMAC-SHA256 state signing for tamper detection + rehydration on reconnect
- **Rate limiting**: Per-action rate limits (`static actionRateLimit`)
- **Binary delta**: Efficient binary state diffs for high-frequency updates (games, real-time)
- **Horizontal scaling**: Cluster adapter for multi-server singleton coordination

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
