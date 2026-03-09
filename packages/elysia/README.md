# @fluxstack/live-elysia

Elysia transport adapter for `@fluxstack/live`.

## Installation

```bash
bun add @fluxstack/live @fluxstack/live-elysia elysia
```

## Quick Start

```typescript
import { Elysia } from 'elysia'
import { LiveServer } from '@fluxstack/live'
import { ElysiaTransport } from '@fluxstack/live-elysia'

const app = new Elysia()

const server = new LiveServer({
  transport: new ElysiaTransport(app),
  componentsPath: './src/components',
})

await server.start()
app.listen(3000)
```

## How It Works

`ElysiaTransport` implements the `LiveTransport` interface from `@fluxstack/live`:

- **WebSocket** — Registers a WebSocket route at `/api/live/ws` using Elysia's native `ws()` plugin
- **HTTP Routes** — Maps `GET`/`POST`/`PUT`/`DELETE` monitoring routes (e.g. `/api/live/stats`)
- **Client Bundle** — Serves the browser IIFE bundle at `/live-client.js` for vanilla JS usage

All security logic (auth, rate limiting, state signing, payload sanitization) is handled by `@fluxstack/live` core — the transport adapter is a thin pass-through wrapper.

## API

### `ElysiaTransport`

```typescript
import { ElysiaTransport } from '@fluxstack/live-elysia'

const transport = new ElysiaTransport(app)
```

### `wrapElysiaWs()`

Helper to wrap Elysia's `ServerWebSocket` into the generic `GenericWebSocket` interface:

```typescript
import { wrapElysiaWs } from '@fluxstack/live-elysia'

const genericWs = wrapElysiaWs(elysiaWs)
```

## Requirements

- Elysia `>=1.0.0`
- Bun runtime

## License

MIT
