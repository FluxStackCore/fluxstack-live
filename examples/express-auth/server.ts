// Express + @fluxstack/live — Auth Demo
//
// Tests:
//  1. Provider with custom session data (user, bot, device)
//  2. static auth + authorize() custom
//  3. static actionAuth + authorize(auth, payload)
//  4. $auth.session access in actions
//  5. $private for server-only state
//  6. $auth on frontend with session data
//  7. Token always via WebSocket message (never URL)
//
// Run:  bun run server.ts
// Open: http://localhost:4001

import express from 'express'
import { live } from '@fluxstack/live-express'
import { AuthenticatedContext } from '@fluxstack/live'
import type { LiveAuthProvider, LiveAuthCredentials, LiveAuthContext } from '@fluxstack/live'
import path from 'path'

// ===== Auth Provider =====

// Simulated database
const USERS: Record<string, { id: string; name: string; plan: string; roles: string[]; permissions: string[] }> = {
  'admin-token': { id: 'admin-1', name: 'Admin', plan: 'enterprise', roles: ['admin', 'user'], permissions: ['chat.write', 'chat.admin', 'users.delete'] },
  'pro-token':   { id: 'pro-1',   name: 'Pro User', plan: 'pro', roles: ['user'], permissions: ['chat.write'] },
  'free-token':  { id: 'free-1',  name: 'Free User', plan: 'free', roles: ['user'], permissions: ['chat.write'] },
  'bot-token':   { id: 'bot-1',   name: 'NotifyBot', plan: 'bot', roles: ['bot'], permissions: ['chat.write'] },
}

class DemoAuthProvider implements LiveAuthProvider {
  readonly name = 'demo'

  async authenticate(credentials: LiveAuthCredentials): Promise<LiveAuthContext | null> {
    const token = credentials.token as string
    if (!token) return null

    const user = USERS[token]
    if (!user) return null

    // Everything here goes to $auth.session
    return new AuthenticatedContext({
      id: user.id,
      name: user.name,
      plan: user.plan,
      roles: user.roles,
      permissions: user.permissions,
    }, token)
  }
}

// ===== Express App =====

const app = express()
app.use(express.json())

// @fluxstack/live with auth
const liveMiddleware = live(app, {
  componentsPath: path.join(import.meta.dirname, 'components'),
  debug: true,
})
app.use(liveMiddleware)

// Serve client bundle manually (workaround for Bun resolve)
import { readFileSync } from 'fs'
const clientBundle = readFileSync(
  path.join(import.meta.dirname, '..', '..', 'packages', 'client', 'dist', 'live-client.browser.global.js'),
  'utf-8'
)
app.get('/live-client.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript')
  res.send(clientBundle)
})

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', auth: 'enabled', timestamp: Date.now() })
})

// Static files
app.use(express.static(path.join(import.meta.dirname, 'public')))

// Start — liveServer is available after listen()
const PORT = 4001
app.listen(PORT, () => {
  // Register auth provider after server starts
  if (liveMiddleware.liveServer) {
    liveMiddleware.liveServer.useAuth(new DemoAuthProvider())
    console.log('  Auth provider registered')
  }

  console.log(`\n  Express + @fluxstack/live Auth Demo`)
  console.log(`  -> http://localhost:${PORT}`)
  console.log(`  -> ws://localhost:${PORT}/api/live/ws`)
  console.log(`\n  Tokens: admin-token, pro-token, free-token, bot-token\n`)
})
