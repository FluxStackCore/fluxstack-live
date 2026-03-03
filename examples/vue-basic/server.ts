// Vue + Express + @fluxstack/live — Backend Server
//
// Serves the Live Components (Counter) over WebSocket.
// The Vue frontend connects from Vite dev server (port 5174) via WS proxy.

import express from 'express'
import { expressLive } from '@fluxstack/live-express'
import path from 'path'

const app = express()
const PORT = 4002

app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', transport: 'express', timestamp: Date.now() })
})

// expressLive() creates an httpServer with the WS server attached.
// MUST use httpServer.listen() (not app.listen()) so WebSocket works.
const { httpServer, liveServer } = await expressLive(app, {
  componentsPath: path.join(import.meta.dirname, 'components'),
  debug: true,
})

httpServer.listen(PORT, () => {
  console.log(`\n  Vue + @fluxstack/live backend`)
  console.log(`  -> http://localhost:${PORT}`)
  console.log(`  -> ws://localhost:${PORT}/api/live/ws`)
  console.log(`\n  Start Vue frontend: bun run dev:client\n`)
})
