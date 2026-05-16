# @fluxstack/live-react

React bindings for `@fluxstack/live-client`.

## Installation

```bash
bun add @fluxstack/live-react @fluxstack/live-client @fluxstack/live react zustand
```

## Quick Start

### 1. Provider

```tsx
import { LiveComponentsProvider } from '@fluxstack/live-react'

function App() {
  return (
    <LiveComponentsProvider
      url="ws://localhost:3000/api/live/ws"
      autoConnect={true}
      reconnectInterval={1000}
    >
      <MyComponents />
    </LiveComponentsProvider>
  )
}
```

### 2. Use Components

```tsx
import { Live } from '@fluxstack/live-react'
import type { Counter } from '../server/components/Counter'

function CounterDemo() {
  const counter = Live.use<Counter>('Counter')

  return (
    <div>
      <p>Count: {counter.$state.count}</p>
      <p>{counter.$connected ? 'Online' : 'Offline'}</p>
      <button onClick={() => counter.increment()}>+</button>
      <button onClick={() => counter.decrement()}>-</button>
    </div>
  )
}
```

## API

### `<LiveComponentsProvider>`

Wraps your app and manages the WebSocket connection:

```tsx
<LiveComponentsProvider
  url="ws://localhost:3000/api/live/ws"
  autoConnect={true}
  reconnectInterval={1000}
  debug={false}
  auth={{ token: 'jwt-token', provider: 'jwt' }}
>
  {children}
</LiveComponentsProvider>
```

### `Live.use<T>(name, options?)`

Mount a Live Component and get a reactive proxy:

```tsx
const component = Live.use<MyComponent>('MyComponent', {
  room: 'optional-room',
  singleton: true,
  initialState: { count: 0 },
  auth: { token: '...', provider: 'jwt' },
})

// Reactive state (triggers re-render on change)
component.$state.count

// Connection & loading status
component.$connected   // WebSocket open?         (transport-level)
component.$ready       // WebSocket open AND      (use this to gate actions)
                       // server-side mount done
component.$status      // detailed lifecycle phase
component.$loading
component.$error

// Call server actions (type-safe from generic)
await component.increment()
await component.sendMessage({ text: 'Hello' })
```

### Wait for `$ready` before calling actions

`$connected` reflects only the underlying WebSocket. Live Components have a
**second lifecycle step** — the server has to create the component instance
and respond with its `componentId` — that runs **after** the WebSocket
opens. Between those two events there's a brief window where `$connected`
is already `true` but the component isn't mounted yet, and any action call
will throw.

```tsx
// ❌ wrong — racy: actions fire during the "mounting" window
useEffect(() => {
  if (!hunt.$connected) return
  hunt.move({ lat, lng })   // → "component not mounted yet"
}, [hunt.$connected])

// ✅ correct — waits until the server-side mount completes
useEffect(() => {
  if (!hunt.$ready) return
  hunt.move({ lat, lng })
}, [hunt.$ready])
```

`$ready` is `true` iff `$status === 'synced'`. The full status progression:

| `$status`        | meaning                                                |
|------------------|--------------------------------------------------------|
| `connecting`     | WebSocket still opening (or down)                      |
| `reconnecting`   | WebSocket open; restoring state from before disconnect |
| `loading`        | mount request in flight                                |
| `mounting`       | WebSocket open, waiting for the server `componentId`   |
| `error`          | mount failed                                           |
| `synced`         | **`$ready === true`** — safe to call actions           |

If you call an action before `$ready`, the error message distinguishes the
two failure modes (`WebSocket is not connected` vs `component '<name>' is
not mounted yet`) so you can tell which signal to wait on.

### `useLiveComponent(name, options?)`

Hook equivalent of `Live.use()`:

```tsx
const { $state, $ready, call } = useLiveComponent('Counter', {
  defaultState: { count: 0 },
})

if (!$ready) return <Spinner />     // gate actions on $ready, not $connected
await call('increment')
```

### `$field(name, options?)`

Form field binding with automatic sync:

```tsx
const form = Live.use<MyForm>('MyForm')

// Sync on blur
<input {...form.$field('name', { syncOn: 'blur' })} />

// Sync on change with debounce
<input {...form.$field('email', { syncOn: 'change', debounce: 500 })} />

// Manual sync
await form.$sync()
```

### `useChunkedUpload(options)`

File upload over WebSocket:

```tsx
import { useChunkedUpload } from '@fluxstack/live-react'

const { upload, progress, uploading, error } = useChunkedUpload({
  chunkSize: 64 * 1024,
})

<input type="file" onChange={e => upload(e.target.files[0])} />
<p>Progress: {progress}%</p>
```

### `useLiveDebugger(options?)`

Debug hook for development:

```tsx
import { useLiveDebugger } from '@fluxstack/live-react'

const { events, components, snapshot } = useLiveDebugger({
  maxEvents: 100,
  filter: { types: ['state', 'action'] },
})
```

### `useLiveComponents()`

Access the connection context:

```tsx
const { connection, connected } = useLiveComponents()
```

## State Management

Uses [Zustand](https://github.com/pmndrs/zustand) internally for reactive state. Each component gets its own store, ensuring efficient re-renders — only components that use changed state re-render.

## Requirements

- React `>=18.0.0`
- Zustand `>=4.0.0`

## License

MIT
