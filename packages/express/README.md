# @fluxstack/live-express

Express transport adapter for `@fluxstack/live`.

## Installation

```bash
npm install @fluxstack/live @fluxstack/live-express express ws
```

## Usage

### Middleware (Simplest)

```typescript
import express from 'express'
import { live } from '@fluxstack/live-express'

const app = express()
app.use(live({ componentsPath: './components' }))
app.listen(3000)
```

### Factory (Access to LiveServer)

```typescript
import express from 'express'
import { expressLive } from '@fluxstack/live-express'

const app = express()
const { httpServer, liveServer } = await expressLive(app, {
  componentsPath: './components',
})
httpServer.listen(3000)
```

### Advanced (Manual Wiring)

```typescript
import express from 'express'
import { createServer } from 'http'
import { LiveServer } from '@fluxstack/live'
import { ExpressTransport } from '@fluxstack/live-express'

const app = express()
const httpServer = createServer(app)
const transport = new ExpressTransport(app, httpServer)

const liveServer = new LiveServer({
  transport,
  componentsPath: './components',
})

await liveServer.start()
httpServer.listen(3000)
```

## How It Works

`ExpressTransport` implements the `LiveTransport` interface from `@fluxstack/live`:

- **WebSocket** — Creates a `ws` WebSocketServer attached to the HTTP server at `/api/live/ws`
- **HTTP Routes** — Registers monitoring routes on the Express app
- **Client Bundle** — Serves the browser IIFE bundle at `/live-client.js`

All security logic is handled by `@fluxstack/live` core.

## API

### `live(options)`

Express middleware that auto-creates an HTTP server and wires everything up:

```typescript
app.use(live({
  componentsPath: './components',
  debug: false,
}))
```

### `expressLive(app, options)`

Factory function that returns `{ httpServer, liveServer }`:

```typescript
const { httpServer, liveServer } = await expressLive(app, {
  componentsPath: './components',
})
```

### `ExpressTransport`

Low-level transport class for manual wiring:

```typescript
new ExpressTransport(app, httpServer, {
  maxPayload: 10 * 1024 * 1024,  // 10MB (default)
  perMessageDeflate: false,        // Compression (default: off)
})
```

## Requirements

- Express `>=4.0.0`
- ws `>=8.0.0`
- Node.js or Bun runtime

## License

MIT
