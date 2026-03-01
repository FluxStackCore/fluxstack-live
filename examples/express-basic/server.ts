// Express + @fluxstack/live example
//
// Run:  bun run server.ts
// Test: open http://localhost:4000 in browser
//       open a second tab to test real-time rooms

import express from 'express'
import { live } from '@fluxstack/live-express'
import path from 'path'

const app = express()

// JSON body parsing
app.use(express.json())

// @fluxstack/live — WebSocket + components + client bundle auto-wired
app.use(live(app, {
  componentsPath: path.join(import.meta.dirname, 'components'),
  debug: true,
}))

// Custom API routes
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', transport: 'express', timestamp: Date.now() })
})

// Static files (index.html, style.css, app.js)
app.use(express.static(path.join(import.meta.dirname, 'public')))

// Start
const PORT = 4000
app.listen(PORT, () => {
  console.log(`\n  Express + @fluxstack/live test server`)
  console.log(`  -> http://localhost:${PORT}`)
  console.log(`  -> ws://localhost:${PORT}/api/live/ws`)
  console.log()
})
