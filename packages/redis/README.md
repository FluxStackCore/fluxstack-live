# @fluxstack/live-redis

Redis adapters for `@fluxstack/live` horizontal scaling.

Provides two adapters:

| Adapter | Purpose |
|---|---|
| `RedisRoomAdapter` | Cross-instance room event pub/sub |
| `RedisClusterAdapter` | Singleton coordination, state mirroring, action forwarding |

## Installation

```bash
bun add @fluxstack/live-redis ioredis
```

## RedisClusterAdapter

Enables multiple server instances to share singleton components transparently. One server owns the singleton, others create proxies that forward actions and receive state updates.

### Usage

```typescript
import Redis from 'ioredis'
import { LiveServer } from '@fluxstack/live'
import { ElysiaTransport } from '@fluxstack/live-elysia'
import { RedisClusterAdapter } from '@fluxstack/live-redis'

const redis = new Redis(process.env.REDIS_URL)

const server = new LiveServer({
  transport: new ElysiaTransport(app),
  componentsPath: './src/components',
  cluster: new RedisClusterAdapter({ redis }),
})
```

### How It Works

1. **Client mounts a singleton** on Server A. Server A claims ownership via `SET NX EX` (atomic, with TTL).
2. **Client mounts same singleton** on Server B. Server B sees the claim, creates a remote proxy instead of a local instance.
3. **Client on Server B calls an action**. The action is forwarded to Server A via Redis pub/sub. Server A executes it and returns the result.
4. **Server A's singleton changes state**. The delta is published via Redis pub/sub. Server B receives it and forwards to its local WebSocket clients.
5. **Server A crashes**. The claim TTL (30s) expires. Server B mounts the singleton, claims it, and recovers state from `singleton-state:{name}` (persisted with 1h TTL).

### Split-Brain Protection

- **Heartbeat verification**: Every 10s, the owner verifies its claim still exists in Redis before renewing. If another instance took over, the owner stops serving and notifies clients.
- **Action guard**: Before executing a forwarded action, the owner verifies ownership in Redis. Rejects with `OWNERSHIP_LOST` if stolen.
- **Ownership lost callback**: When split-brain is detected, local singleton is destroyed and clients are notified.

### Options

```typescript
interface RedisClusterAdapterOptions {
  redis: Redis                // ioredis client for commands
  subscriber?: Redis          // separate client for subscriptions (auto-created if omitted)
  prefix?: string             // key prefix (default: 'fluxstack:cluster:')
  stateTtl?: number           // state mirror TTL in seconds (default: 3600)
  singletonTtl?: number       // singleton claim TTL in seconds (default: 30)
  heartbeatInterval?: number  // heartbeat interval in ms (default: 10000)
  actionTimeout?: number      // action forwarding timeout in ms (default: 5000)
}
```

### Redis Keys

| Key | TTL | Description |
|---|---|---|
| `{prefix}singleton:{componentName}` | `singletonTtl` | Ownership claim. Value: `instanceId:componentId` |
| `{prefix}singleton-state:{componentName}` | `stateTtl` | Last known state. Survives owner crash |
| `{prefix}state:{componentId}` | `stateTtl` | Per-component state snapshot |
| `{prefix}delta` (pub/sub) | - | State delta broadcast channel |
| `{prefix}actions:{instanceId}` (pub/sub) | - | Action forwarding channel (per instance) |

## RedisRoomAdapter

Cross-instance room event propagation. When a component emits to a room, the event reaches components on all server instances.

### Usage

```typescript
import Redis from 'ioredis'
import { LiveServer } from '@fluxstack/live'
import { RedisRoomAdapter } from '@fluxstack/live-redis'

const redis = new Redis(process.env.REDIS_URL)

const server = new LiveServer({
  transport: new ElysiaTransport(app),
  roomPubSub: new RedisRoomAdapter({ redis }),
})
```

## Full Scaling Setup

For complete horizontal scaling (singletons + rooms):

```typescript
const redis = new Redis(process.env.REDIS_URL)

const server = new LiveServer({
  transport: new ElysiaTransport(app),
  componentsPath: './src/components',
  roomPubSub: new RedisRoomAdapter({ redis }),
  cluster: new RedisClusterAdapter({ redis }),
})
```

## Custom Adapter

Implement `IClusterAdapter` from `@fluxstack/live` to use a different backend:

```typescript
import type { IClusterAdapter } from '@fluxstack/live'

class NatsClusterAdapter implements IClusterAdapter {
  readonly instanceId: string
  // ... implement all IClusterAdapter methods
}
```

## License

MIT
