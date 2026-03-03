// Fastify + @fluxstack/live example
//
// Run:  bun run server.ts
// Test: open http://localhost:4001 in browser
//       open a second tab to test real-time rooms

import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { live } from '@fluxstack/live-fastify'
import path from 'path'

const app = Fastify({ logger: false })

// @fluxstack/live -- WebSocket + components + client bundle auto-wired
await app.register(live, {
  componentsPath: path.join(import.meta.dirname, 'components'),
  debug: true,
})

// Custom API routes
app.get('/api/health', async () => {
  return { status: 'ok', transport: 'fastify', timestamp: Date.now() }
})

// Static files (index.html)
await app.register(fastifyStatic, {
  root: path.join(import.meta.dirname, 'public'),
})

// Start
const PORT = 4001
await app.listen({ port: PORT })
console.log(`\n  Fastify + @fluxstack/live test server`)
console.log(`  -> http://localhost:${PORT}`)
console.log(`  -> ws://localhost:${PORT}/api/live/ws`)
console.log()
