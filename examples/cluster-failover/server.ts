// Cluster Failover Demo — Single server instance
//
// Run TWO instances in separate terminals:
//   Terminal 1:  SERVER_PORT=3001 bun run server.ts
//   Terminal 2:  SERVER_PORT=3002 bun run server.ts
//
// Then open http://localhost:3001 in your browser.

import { Elysia } from 'elysia'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import Redis from 'ioredis'
import { LiveServer } from '@fluxstack/live'
import { ElysiaTransport } from '@fluxstack/live-elysia'
import { RedisClusterAdapter } from '@fluxstack/live-redis'
import { SharedCounter } from './components/SharedCounter'

const PORT = parseInt(process.env.SERVER_PORT || '3001', 10)
const REDIS_PORT = 16379
const REDIS_HOST = '127.0.0.1'

// ── Redis + Cluster Adapter ─────────────────────────

const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT })
const cluster = new RedisClusterAdapter({
  redis,
  prefix: 'demo:cluster:',
  singletonTtl: 15,
  heartbeatInterval: 5_000,
  actionTimeout: 5_000,
})

// ── Elysia App ──────────────────────────────────────

const app = new Elysia()
const transport = new ElysiaTransport(app)

const liveServer = new LiveServer({
  transport,
  cluster,
  debug: true,
})

liveServer.registry.registerComponentClass('SharedCounter', SharedCounter as any)

// ── Serve client bundle ─────────────────────────────

let clientBundle: string
try {
  const bundlePath = resolve(dirname(import.meta.path), '../../packages/client/dist/live-client.browser.global.js')
  clientBundle = readFileSync(bundlePath, 'utf-8')
} catch {
  console.error('[!] Client bundle not found. Run: cd packages/client && bunx tsup')
  process.exit(1)
}

app.get('/live-client.js', () => {
  return new Response(clientBundle, {
    headers: { 'Content-Type': 'application/javascript' },
  })
})

// ── Serve static files ──────────────────────────────

const publicDir = resolve(dirname(import.meta.path), 'public')

app.get('/', () => {
  return new Response(readFileSync(resolve(publicDir, 'index.html'), 'utf-8'), {
    headers: { 'Content-Type': 'text/html' },
  })
})

app.get('/app.js', () => {
  return new Response(readFileSync(resolve(publicDir, 'app.js'), 'utf-8'), {
    headers: { 'Content-Type': 'application/javascript' },
  })
})

// ── Start ───────────────────────────────────────────

await liveServer.start()
app.listen(PORT)

console.log()
console.log(`  ┌─────────────────────────────────────────┐`)
console.log(`  │  Cluster Failover Demo                  │`)
console.log(`  │  Server ${PORT}                            │`)
console.log(`  │  http://localhost:${PORT}                   │`)
console.log(`  │  ws://localhost:${PORT}/api/live/ws         │`)
console.log(`  │  Redis: ${REDIS_HOST}:${REDIS_PORT}              │`)
console.log(`  │  Instance: ${cluster.instanceId}  │`)
console.log(`  └─────────────────────────────────────────┘`)
console.log()

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n  Shutting down...')
  await liveServer.shutdown()
  redis.disconnect()
  process.exit(0)
})
