#!/usr/bin/env node
// FluxStack Live load test script (WebSocket)
//
// Usage:
//   node scripts/load-test.mjs --url ws://localhost:3000/api/live/ws --component BattleTank --clients 100 --hz 20 --duration 30
//
// Notes:
// - Requires the server to be running and the component to exist.
// - Uses CALL_ACTION with expectResponse=false by default (fire-and-forget).

import WebSocket from 'ws'

const args = parseArgs(process.argv.slice(2))

if (!args.url) {
  console.error('Missing --url')
  process.exit(1)
}
if (!args.component && !args.noMount) {
  console.error('Missing --component (or use --no-mount)')
  process.exit(1)
}

const clients = Number(args.clients ?? 1)
const hz = Number(args.hz ?? 1)
const durationSec = Number(args.duration ?? 30)
const rampMs = Number(args.rampMs ?? 0)
const payloadSize = Number(args.payloadSize ?? 16)
const expectResponse = Boolean(args.expectResponse ?? false)
const action = args.action ?? 'sendInput'
const room = args.room
const authToken = args.authToken
const debug = Boolean(args.debug ?? false)

const state = {
  startedAt: Date.now(),
  sent: 0,
  received: 0,
  errors: 0,
  connects: 0,
  closes: 0,
  responses: 0,
  rtt: [],
}

const connections = []

const payload = makePayload(payloadSize)

const stopAt = Date.now() + durationSec * 1000

console.log(`Starting load test: clients=${clients}, hz=${hz}, duration=${durationSec}s, expectResponse=${expectResponse}`)
console.log(`url=${args.url}, component=${args.component ?? '(no-mount)'}, action=${action}, room=${room ?? 'none'}`)

for (let i = 0; i < clients; i++) {
  const delay = rampMs > 0 ? i * rampMs : 0
  setTimeout(() => connectClient(i), delay)
}

const statsTimer = setInterval(() => {
  const elapsed = (Date.now() - state.startedAt) / 1000
  const rtt = summarizeRtt(state.rtt)
  console.log(
    `t=${elapsed.toFixed(1)}s ` +
    `conn=${state.connects} closed=${state.closes} ` +
    `sent=${state.sent} recv=${state.received} ` +
    `resp=${state.responses} err=${state.errors} ` +
    `rtt(ms) avg=${rtt.avg.toFixed(1)} p95=${rtt.p95.toFixed(1)}`
  )
}, 1000)

setTimeout(() => {
  clearInterval(statsTimer)
  for (const c of connections) {
    c.stop()
  }
  setTimeout(() => process.exit(0), 500)
}, durationSec * 1000 + 1500)

function connectClient(index) {
  const ws = new WebSocket(args.url)
  ws.binaryType = 'arraybuffer'

  const client = createClient(ws, index)
  connections.push(client)

  ws.on('open', () => {
    state.connects++
    if (authToken) {
      send(ws, { type: 'AUTH', payload: { token: authToken }, timestamp: Date.now() })
    }
    if (!args.noMount) {
      send(ws, {
        type: 'COMPONENT_MOUNT',
        payload: { component: args.component, props: {}, room, debugLabel: `load-${index}` },
        timestamp: Date.now()
      })
    } else {
      client.startSending(null)
    }
  })

  ws.on('message', (data) => {
    state.received++
    let msg
    try {
      const text = typeof data === 'string' ? data : data.toString()
      msg = JSON.parse(text)
    } catch {
      return
    }

    if (Array.isArray(msg)) {
      for (const m of msg) handleMessage(m, client)
    } else {
      handleMessage(msg, client)
    }
  })

  ws.on('close', () => {
    state.closes++
    client.stop()
  })

  ws.on('error', () => {
    state.errors++
  })
}

function handleMessage(msg, client) {
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'MESSAGE_RESPONSE' && msg.originalType === 'COMPONENT_MOUNT' && msg.success) {
    const componentId = msg.result?.componentId
    if (componentId) client.startSending(componentId)
  }

  if (msg.type === 'ACTION_RESPONSE' && msg.requestId) {
    state.responses++
    const sentAt = client.pending.get(msg.requestId)
    if (sentAt) {
      state.rtt.push(Date.now() - sentAt)
      client.pending.delete(msg.requestId)
    }
  }
}

function createClient(ws, index) {
  const pending = new Map()
  let timer = null
  let componentId = null

  function startSending(id) {
    if (timer) return
    componentId = id
    if (!componentId && !args.noMount) return

    const intervalMs = Math.max(1, Math.floor(1000 / hz))
    timer = setInterval(() => {
      if (Date.now() >= stopAt) return
      if (ws.readyState !== 1) return

      const message = {
        type: 'CALL_ACTION',
        componentId,
        action,
        payload,
        expectResponse,
        timestamp: Date.now()
      }

      if (expectResponse) {
        const requestId = `${index}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        message.requestId = requestId
        pending.set(requestId, Date.now())
      }

      send(ws, message)
      state.sent++
    }, intervalMs)
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { startSending, stop, pending }
}

function send(ws, msg) {
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    state.errors++
  }
}

function makePayload(size) {
  const s = 'x'.repeat(Math.max(0, size))
  return { data: s }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

function summarizeRtt(values) {
  if (values.length === 0) return { avg: 0, p95: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1]
  return { avg, p95 }
}
