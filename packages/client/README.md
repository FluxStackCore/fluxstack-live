# @fluxstack/live-client

Framework-agnostic browser client for `@fluxstack/live`.

Works with any UI framework (React, Vue, Svelte, vanilla JS) or no framework at all. For React-specific bindings, see `@fluxstack/live-react`.

## Installation

### NPM/Bun

```bash
bun add @fluxstack/live-client
```

### Browser (IIFE)

```html
<script src="/live-client.js"></script>
<script>
  const counter = FluxstackLive.useLive('Counter', { count: 0 })
</script>
```

The IIFE bundle is served automatically by any transport adapter at `/live-client.js`.

## Quick Start

### Vanilla JS (useLive)

```typescript
import { useLive, onConnectionChange } from '@fluxstack/live-client'

// Mount a component (uses singleton connection)
const counter = useLive('Counter', { count: 0 })

// Listen for state changes
counter.on(state => {
  document.getElementById('count').textContent = state.count
})

// Call server actions
document.getElementById('btn').onclick = () => counter.call('increment')

// Connection status
onConnectionChange(connected => {
  console.log(connected ? 'Online' : 'Offline')
})
```

### Manual Connection

```typescript
import { LiveConnection, LiveComponentHandle } from '@fluxstack/live-client'

const conn = new LiveConnection({
  url: 'ws://localhost:3000/api/live/ws',
  autoReconnect: true,
  reconnectInterval: 1000,
})
await conn.connect()

const counter = new LiveComponentHandle(conn, {
  componentName: 'Counter',
  defaultState: { count: 0 },
})

counter.on(state => console.log('Count:', state.count))
await counter.call('increment')
```

## API

### `useLive(componentName, defaultState, options?)`

High-level API using a shared connection singleton:

```typescript
const handle = useLive('Counter', { count: 0 }, {
  url: 'ws://localhost:3000/api/live/ws',  // Auto-detected if omitted
  room: 'my-room',                          // Optional room
  singleton: true,                           // Singleton mount
})

handle.on(state => { ... })    // State change listener
handle.call('action', payload) // Call server action
handle.destroy()               // Unmount component
```

### `onConnectionChange(callback)`

Subscribe to connection status changes:

```typescript
const unsubscribe = onConnectionChange(connected => { ... })
```

### `getConnection()`

Access the shared connection singleton:

```typescript
const conn = getConnection()
```

### `LiveConnection`

WebSocket connection manager with auto-reconnect, state rehydration, and message routing:

```typescript
const conn = new LiveConnection({
  url: 'ws://localhost:3000/api/live/ws',
  autoReconnect: true,
  reconnectInterval: 1000,
  auth: {
    token: 'my-jwt-token',
    provider: 'jwt',
  },
})
```

### `LiveComponentHandle`

Handle to a remote component. Manages mounting, state updates, and action calls:

```typescript
const handle = new LiveComponentHandle(conn, {
  componentName: 'Counter',
  defaultState: { count: 0 },
  room: 'optional-room',
})

handle.on(state => { ... })     // State listener
handle.call('action', payload)  // Call action
handle.$state                   // Current state
handle.$connected               // Connection status
handle.destroy()                // Unmount
```

### `RoomManager`

Client-side room event management:

```typescript
const rooms = new RoomManager(conn)
const room = rooms.join('chat-room')
room.on('message:new', data => { ... })
room.emit('typing', { user: 'Alice' })
room.leave()
```

### `ChunkedUploader`

Stream file uploads over WebSocket:

```typescript
const uploader = new ChunkedUploader(conn, {
  chunkSize: 64 * 1024,
  onProgress: (progress) => { ... },
})
await uploader.upload(file)
```

### State Persistence

```typescript
import { persistState, getPersistedState, clearPersistedState } from '@fluxstack/live-client'

persistState('Counter', componentId, state, signature)
const saved = getPersistedState('Counter', componentId)
clearPersistedState('Counter', componentId)
```

## Browser IIFE Build

The package includes a pre-built browser bundle at `dist/live-client.browser.global.js` that exposes a `FluxstackLive` global with all exports. Transport adapters serve this automatically at `/live-client.js`.

## License

MIT
