# @fluxstack/live-fastify

Fastify transport adapter for `@fluxstack/live`.

## Installation

```bash
npm install @fluxstack/live @fluxstack/live-fastify fastify @fastify/websocket
```

## Usage

### Plugin (Recommended)

```typescript
import Fastify from 'fastify'
import { live } from '@fluxstack/live-fastify'

const app = Fastify()
await app.register(live, { componentsPath: './components' })
await app.listen({ port: 3000 })
```

The `liveServer` instance is accessible via `app.liveServer` after registration.

### Factory (Access to LiveServer)

```typescript
import Fastify from 'fastify'
import { fastifyLive } from '@fluxstack/live-fastify'

const app = Fastify()
const { liveServer } = await fastifyLive(app, {
  componentsPath: './components',
})
await app.listen({ port: 3000 })
```

### Advanced (Manual Wiring)

```typescript
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { LiveServer } from '@fluxstack/live'
import { FastifyTransport } from '@fluxstack/live-fastify'

const app = Fastify()
await app.register(websocket)

const transport = new FastifyTransport(app)
const liveServer = new LiveServer({
  transport,
  componentsPath: './components',
})

await liveServer.start()
await app.listen({ port: 3000 })
```

## How It Works

`FastifyTransport` implements the `LiveTransport` interface from `@fluxstack/live`:

- **WebSocket** — Registers a WebSocket route via `@fastify/websocket` at `/api/live/ws`
- **HTTP Routes** — Registers monitoring routes on the Fastify instance
- **Client Bundle** — Serves the browser IIFE bundle at `/live-client.js`

All security logic is handled by `@fluxstack/live` core.

## API

### `live`

Fastify plugin (via `fastify-plugin`):

```typescript
await app.register(live, {
  componentsPath: './components',
  debug: false,
})

// Access LiveServer after registration
app.liveServer
```

### `fastifyLive(app, options)`

Factory function that returns `{ liveServer }`:

```typescript
const { liveServer } = await fastifyLive(app, {
  componentsPath: './components',
})
```

### `FastifyTransport`

Low-level transport class for manual wiring:

```typescript
new FastifyTransport(app, {
  maxPayload: 10 * 1024 * 1024,  // 10MB (default)
  perMessageDeflate: false,        // Compression (default: off)
})
```

## Requirements

- Fastify `>=4.0.0`
- @fastify/websocket `>=10.0.0`
- Node.js or Bun runtime

## License

MIT
