#!/usr/bin/env bun
// =============================================================================
// FluxStack Live - WebSocket Test Script
//
// Simula múltiplos clientes WebSocket conectando simultaneamente ao LiveServer.
// Testa: conexão, mount, actions, rooms, stress, e desconexão.
//
// Uso:
//   bun scripts/ws-test.ts                    # roda todos os cenários
//   bun scripts/ws-test.ts --scenario stress  # roda só o stress test
//   bun scripts/ws-test.ts --clients 50       # stress com 50 clientes
//   bun scripts/ws-test.ts --url ws://host:port/api/live/ws
// =============================================================================

const WS_URL = getArg('--url') || 'ws://localhost:3000/api/live/ws'
const SCENARIO = getArg('--scenario') || 'all'
const NUM_CLIENTS = parseInt(getArg('--clients') || '20', 10)
const TIMEOUT_MS = 5000

// ===== Helpers =====

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx !== -1 ? process.argv[idx + 1] : undefined
}

function reqId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

interface TestResult {
  name: string
  passed: boolean
  duration: number
  detail?: string
  error?: string
}

const results: TestResult[] = []
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
}

function log(msg: string) { console.log(msg) }
function pass(name: string, duration: number, detail?: string) {
  results.push({ name, passed: true, duration, detail })
  log(`  ${colors.green}✓${colors.reset} ${name} ${colors.dim}(${duration}ms)${colors.reset}${detail ? ` - ${detail}` : ''}`)
}
function fail(name: string, duration: number, error: string) {
  results.push({ name, passed: false, duration, error })
  log(`  ${colors.red}✗${colors.reset} ${name} ${colors.dim}(${duration}ms)${colors.reset} - ${colors.red}${error}${colors.reset}`)
}

// ===== WebSocket Client Wrapper =====

class TestClient {
  private ws!: WebSocket
  private messageQueue: any[] = []
  private pendingResolvers = new Map<string, { resolve: (msg: any) => void; reject: (err: Error) => void }>()
  private stateUpdates: any[] = []
  public connectionId?: string
  public connected = false

  async connect(url: string = WS_URL): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), TIMEOUT_MS)
      this.ws = new WebSocket(url)

      this.ws.onopen = () => {
        this.connected = true
      }

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())

        if (msg.type === 'CONNECTION_ESTABLISHED') {
          this.connectionId = msg.connectionId
          clearTimeout(timeout)
          resolve()
          return
        }

        // Match request-response (only for explicit response types)
        const isResponse = msg.type === 'ACTION_RESPONSE' || msg.type === 'MESSAGE_RESPONSE' ||
          msg.type === 'COMPONENT_MOUNTED' || msg.type === 'COMPONENT_REHYDRATED' ||
          msg.type === 'AUTH_RESPONSE' || msg.type === 'ERROR' || msg.type === 'COMPONENT_PONG'
        if (isResponse && msg.requestId && this.pendingResolvers.has(msg.requestId)) {
          const resolver = this.pendingResolvers.get(msg.requestId)!
          this.pendingResolvers.delete(msg.requestId)
          resolver.resolve(msg)
          return
        }

        // Unmatched ERROR (e.g. rate limit) - resolve oldest pending request
        if (msg.type === 'ERROR' && !msg.requestId && this.pendingResolvers.size > 0) {
          const [firstId, resolver] = this.pendingResolvers.entries().next().value!
          this.pendingResolvers.delete(firstId)
          resolver.resolve({ success: false, error: msg.error, type: 'ERROR' })
          return
        }

        // Track state updates
        if (msg.type === 'STATE_UPDATE' || msg.type === 'STATE_DELTA' || msg.type === 'STATE_REHYDRATED') {
          this.stateUpdates.push(msg)
        }

        this.messageQueue.push(msg)
      }

      this.ws.onerror = (err) => {
        clearTimeout(timeout)
        reject(new Error(`WebSocket error: ${err}`))
      }

      this.ws.onclose = () => {
        this.connected = false
        // Reject all pending requests
        for (const [, resolver] of this.pendingResolvers) {
          resolver.reject(new Error('Connection closed'))
        }
        this.pendingResolvers.clear()
      }
    })
  }

  async send(msg: any, expectResponse = true): Promise<any> {
    const id = msg.requestId || reqId()
    msg.requestId = id
    msg.timestamp = Date.now()

    if (!expectResponse) {
      this.ws.send(JSON.stringify(msg))
      return null
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResolvers.delete(id)
        reject(new Error(`Request timeout for ${msg.type}`))
      }, TIMEOUT_MS)

      this.pendingResolvers.set(id, {
        resolve: (response) => {
          clearTimeout(timeout)
          resolve(response)
        },
        reject: (err) => {
          clearTimeout(timeout)
          reject(err)
        },
      })

      this.ws.send(JSON.stringify(msg))
    })
  }

  async mount(component: string, props: Record<string, unknown> = {}, room?: string): Promise<any> {
    return this.send({
      type: 'COMPONENT_MOUNT',
      componentId: `mount-${component}`,
      payload: { component, props, room },
    })
  }

  async callAction(componentId: string, action: string, payload: any = {}): Promise<any> {
    return this.send({
      type: 'CALL_ACTION',
      componentId,
      action,
      payload,
      expectResponse: true,  // must be at message root for registry to return result
    })
  }

  async unmount(componentId: string): Promise<void> {
    this.ws.send(JSON.stringify({
      type: 'COMPONENT_UNMOUNT',
      componentId,
      timestamp: Date.now(),
    }))
  }

  getStateUpdates(): any[] { return this.stateUpdates }
  drainMessages(): any[] { const msgs = [...this.messageQueue]; this.messageQueue = []; return msgs }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close()
    }
  }

  // Wait for any incoming messages (state updates, broadcasts, etc.)
  async waitForMessages(count: number, timeoutMs = 3000): Promise<any[]> {
    const start = this.messageQueue.length + this.stateUpdates.length
    const deadline = Date.now() + timeoutMs
    while ((this.messageQueue.length + this.stateUpdates.length) - start < count && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    return [...this.stateUpdates.slice(Math.max(0, this.stateUpdates.length - count)), ...this.messageQueue.splice(0)]
  }
}

// ===== Test Scenarios =====

async function testBasicConnection() {
  log(`\n${colors.cyan}[1] Basic Connection${colors.reset}`)
  const t = Date.now()
  const client = new TestClient()
  try {
    await client.connect()
    if (!client.connectionId) throw new Error('No connectionId received')
    pass('Connect + receive connectionId', Date.now() - t, `id: ${client.connectionId}`)
  } catch (e: any) {
    fail('Connect + receive connectionId', Date.now() - t, e.message)
  } finally {
    client.close()
  }
}

async function testMountAndAction() {
  log(`\n${colors.cyan}[2] Mount + Action (LiveCounter)${colors.reset}`)
  const client = new TestClient()
  try {
    await client.connect()

    // Mount
    let t = Date.now()
    const mountRes = await client.mount('LiveCounter', {}, 'test-room-1')
    if (!mountRes.success) throw new Error(`Mount failed: ${mountRes.error}`)
    const compId = mountRes.result?.componentId
    if (!compId) throw new Error('No componentId in mount response')
    pass('Mount LiveCounter', Date.now() - t, `componentId: ${compId}`)

    // Increment
    t = Date.now()
    const incRes = await client.callAction(compId, 'increment', {})
    if (!incRes.success) throw new Error(`Increment failed: ${incRes.error}`)
    pass('Call increment', Date.now() - t, `count: ${incRes.result?.count}`)

    // Decrement
    t = Date.now()
    const decRes = await client.callAction(compId, 'decrement', {})
    if (!decRes.success) throw new Error(`Decrement failed: ${decRes.error}`)
    pass('Call decrement', Date.now() - t, `count: ${decRes.result?.count}`)

    // Reset
    t = Date.now()
    const resetRes = await client.callAction(compId, 'reset', {})
    if (!resetRes.success) throw new Error(`Reset failed: ${resetRes.error}`)
    pass('Call reset', Date.now() - t, `count: ${resetRes.result?.count}`)

    // Unmount
    t = Date.now()
    await client.unmount(compId)
    pass('Unmount', Date.now() - t)
  } catch (e: any) {
    fail('Mount/Action flow', Date.now(), e.message)
  } finally {
    client.close()
  }
}

async function testChatFlow() {
  log(`\n${colors.cyan}[3] Chat Flow (LiveChat + Room Sync)${colors.reset}`)
  const clientA = new TestClient()
  const clientB = new TestClient()
  try {
    await Promise.all([clientA.connect(), clientB.connect()])

    const room = `test-chat-${Date.now()}`

    // Mount both in same room
    let t = Date.now()
    const [mountA, mountB] = await Promise.all([
      clientA.mount('LiveChat', {}, room),
      clientB.mount('LiveChat', {}, room),
    ])
    if (!mountA.success || !mountB.success) throw new Error('Mount failed')
    const compIdA = mountA.result.componentId
    const compIdB = mountB.result.componentId
    pass('Mount 2 clients in same room', Date.now() - t)

    // Client A sends message
    t = Date.now()
    const sendRes = await clientA.callAction(compIdA, 'sendMessage', { user: 'Alice', text: 'Hello from stress test!' })
    if (!sendRes.success) throw new Error(`sendMessage failed: ${sendRes.error}`)
    pass('Client A sends message', Date.now() - t)

    // Client B should receive state update (via room event broadcast)
    t = Date.now()
    const updates = await clientB.waitForMessages(1, 3000)
    if (updates.length === 0) {
      fail('Client B receives room update', Date.now() - t, 'No messages received within 3s')
    } else {
      pass('Client B receives room update', Date.now() - t, `got ${updates.length} message(s)`)
    }

    // Cleanup
    await Promise.all([clientA.unmount(compIdA), clientB.unmount(compIdB)])
  } catch (e: any) {
    fail('Chat flow', Date.now(), e.message)
  } finally {
    clientA.close()
    clientB.close()
  }
}

async function testRapidActions() {
  log(`\n${colors.cyan}[4] Rapid Actions (burst de 100 incrementos)${colors.reset}`)
  const client = new TestClient()
  try {
    await client.connect()
    const mountRes = await client.mount('LiveCounter', {}, `rapid-${Date.now()}`)
    if (!mountRes.success) throw new Error('Mount failed')
    const compId = mountRes.result.componentId

    const count = 100
    const batchSize = 10
    const t = Date.now()
    let successes = 0
    let rateLimited = 0

    // Send in batches to avoid overwhelming the single-threaded server
    for (let i = 0; i < count; i += batchSize) {
      const batch = Array.from({ length: Math.min(batchSize, count - i) }, () =>
        client.callAction(compId, 'increment', {}),
      )
      const batchResults = await Promise.all(batch)
      successes += batchResults.filter(r => r.success).length
      rateLimited += batchResults.filter(r => !r.success && r.error?.includes('Rate limit')).length
    }

    const duration = Date.now() - t
    const rps = Math.round(count / (duration / 1000))
    const detail = `${rps} req/s, ${successes} ok${rateLimited > 0 ? `, ${rateLimited} rate-limited` : ''}`

    if (successes + rateLimited === count) {
      pass(`${count} rapid increments`, duration, detail)
    } else {
      fail(`${count} rapid increments`, duration, `${successes}/${count} succeeded, ${rateLimited} rate-limited (${rps} req/s)`)
    }

    await client.unmount(compId)
  } catch (e: any) {
    fail('Rapid actions', Date.now(), e.message)
  } finally {
    client.close()
  }
}

async function testMultipleClients() {
  // Use Bun Workers for large client counts (>100), single-thread for small
  const useWorkers = NUM_CLIENTS > 100
  if (useWorkers) {
    await testMultipleClientsWorkers()
  } else {
    await testMultipleClientsSingle()
  }
}

async function testMultipleClientsWorkers(opts: { isolatedRooms?: boolean; label?: string } = {}) {
  const cpuCount = navigator.hardwareConcurrency || 4
  // Cap workers: too many threads competing for server accept queue hurts more than helps
  const numWorkers = Math.min(Math.min(cpuCount, 8), Math.ceil(NUM_CLIENTS / 100))
  const clientsPerWorker = Math.ceil(NUM_CLIENTS / numWorkers)
  const room = `stress-${Date.now()}`
  const roomMode = opts.isolatedRooms ? 'salas isoladas' : 'sala compartilhada'
  const label = opts.label || '[5]'

  log(`\n${colors.cyan}${label} Stress - ${NUM_CLIENTS} clientes (${numWorkers} workers x ~${clientsPerWorker}, ${roomMode})${colors.reset}`)

  interface PhaseAgg { success: number; failed: number; rateLimited: number; duration: number; errors: string[] }
  const phases: Record<string, PhaseAgg> = {
    connect: { success: 0, failed: 0, rateLimited: 0, duration: 0, errors: [] },
    mount: { success: 0, failed: 0, rateLimited: 0, duration: 0, errors: [] },
    action: { success: 0, failed: 0, rateLimited: 0, duration: 0, errors: [] },
    unmount: { success: 0, failed: 0, rateLimited: 0, duration: 0, errors: [] },
  }

  const startTime = Date.now()

  await new Promise<void>((resolve) => {
    let doneCount = 0
    const workers: Worker[] = []

    for (let i = 0; i < numWorkers; i++) {
      const count = i < numWorkers - 1 ? clientsPerWorker : NUM_CLIENTS - clientsPerWorker * (numWorkers - 1)
      const worker = new Worker(new URL('./ws-stress-worker.ts', import.meta.url).href)
      workers.push(worker)

      worker.onmessage = (event) => {
        const result = event.data as { workerId: number; phase: string; success: number; failed: number; rateLimited: number; duration: number; errors?: string[] }

        if (result.phase === 'done') {
          doneCount++
          worker.terminate()
          if (doneCount === numWorkers) resolve()
          return
        }

        const agg = phases[result.phase]
        if (agg) {
          agg.success += result.success
          agg.failed += result.failed
          agg.rateLimited += result.rateLimited
          agg.duration = Math.max(agg.duration, result.duration)
          if (result.errors) agg.errors.push(...result.errors)
        }
      }

      worker.onerror = (err) => {
        log(`  ${colors.red}Worker ${i} error: ${err.message}${colors.reset}`)
        doneCount++
        if (doneCount === numWorkers) resolve()
      }

      worker.postMessage({
        workerId: i,
        wsUrl: WS_URL,
        numClients: count,
        room,
        timeoutMs: Math.max(TIMEOUT_MS, Math.ceil(NUM_CLIENTS / 50) * 1000),
        isolatedRooms: opts.isolatedRooms ?? false,
      })
    }
  })

  const totalTime = Date.now() - startTime

  // Report connect
  const c = phases.connect
  const totalConnect = c.success + c.failed
  if (c.failed === 0) {
    pass(`Connect ${c.success} clients`, c.duration, `${numWorkers} workers`)
  } else {
    fail(`Connect ${totalConnect} clients`, c.duration, `${c.success}/${totalConnect} connected`)
  }

  // Report mount
  const m = phases.mount
  const totalRequested = c.success
  if (m.failed === 0) {
    pass(`Mount ${m.success} counters`, m.duration, `${Math.round(m.success / (m.duration / 1000))} mounts/s`)
  } else {
    const pct = Math.round(m.success / totalRequested * 100)
    if (pct >= 90) {
      pass(`Mount ${m.success}/${totalRequested} counters (${pct}%)`, m.duration, `${m.failed} failed`)
    } else {
      fail(`Mount ${totalRequested} counters`, m.duration, `${m.success}/${totalRequested} mounted (${pct}%)`)
    }
  }

  // Report action
  const a = phases.action
  const actionTotal = a.success + a.failed + a.rateLimited
  const actionDetail = `${a.success} ok${a.rateLimited > 0 ? `, ${a.rateLimited} rate-limited` : ''}${a.failed > 0 ? `, ${a.failed} failed` : ''}`
  const rps = a.duration > 0 ? Math.round(actionTotal / (a.duration / 1000)) : 0
  if (a.success + a.rateLimited >= actionTotal * 0.9) {
    pass(`${actionTotal} increments`, a.duration, `${rps} req/s, ${actionDetail}`)
  } else {
    fail(`${actionTotal} increments`, a.duration, `${rps} req/s, ${actionDetail}`)
  }

  // Report unmount
  pass(`Unmount ${phases.unmount.success} components`, phases.unmount.duration)

  // Summary line
  log(`\n  ${colors.dim}Total: ${totalTime}ms | Workers: ${numWorkers} | Throughput: ~${Math.round(NUM_CLIENTS / (totalTime / 1000))} clients/s${colors.reset}`)

  // Show sample errors if any
  const allErrors = [...phases.connect.errors, ...phases.mount.errors, ...phases.action.errors].slice(0, 5)
  if (allErrors.length > 0) {
    log(`  ${colors.dim}Sample errors: ${allErrors.join('; ')}${colors.reset}`)
  }
}

async function testMultipleClientsSingle() {
  log(`\n${colors.cyan}[5] Stress - ${NUM_CLIENTS} clientes simultâneos${colors.reset}`)
  const clients: TestClient[] = []

  try {
    // Connect all
    let t = Date.now()
    const connectPromises = Array.from({ length: NUM_CLIENTS }, () => {
      const c = new TestClient()
      clients.push(c)
      return c.connect().then(() => true).catch(() => false)
    })

    const connectResults = await Promise.all(connectPromises)
    const connected = connectResults.filter(Boolean).length
    const connectTime = Date.now() - t

    if (connected === NUM_CLIENTS) {
      pass(`Connect ${NUM_CLIENTS} clients`, connectTime, `all connected`)
    } else {
      fail(`Connect ${NUM_CLIENTS} clients`, connectTime, `${connected}/${NUM_CLIENTS} connected`)
    }

    // Mount all on same room
    t = Date.now()
    const room = `stress-${Date.now()}`
    const mountPromises = clients
      .filter((_, i) => connectResults[i])
      .map(c => c.mount('LiveCounter', {}, room).catch(e => ({ success: false, error: e.message })))

    const mountResults = await Promise.all(mountPromises)
    const mounted = mountResults.filter((r: any) => r.success).length
    const mountTime = Date.now() - t
    const compIds = mountResults.filter((r: any) => r.success).map((r: any) => r.result?.componentId)

    if (mounted === connected) {
      pass(`Mount ${connected} counters`, mountTime)
    } else {
      fail(`Mount ${connected} counters`, mountTime, `${mounted}/${connected} mounted`)
    }

    // Each client increments once
    t = Date.now()
    const actionPromises = clients
      .filter((_, i) => connectResults[i])
      .map((c, i) => {
        const cid = compIds[i]
        if (!cid) return Promise.resolve({ success: false })
        return c.callAction(cid, 'increment', {}).catch(e => ({ success: false, error: e.message }))
      })

    const actionResults = await Promise.all(actionPromises)
    const actionSuccesses = actionResults.filter((r: any) => r.success).length
    const actionTime = Date.now() - t

    if (actionSuccesses === mounted) {
      pass(`${mounted} concurrent increments`, actionTime, `${Math.round(mounted / (actionTime / 1000))} req/s`)
    } else {
      fail(`${mounted} concurrent increments`, actionTime, `${actionSuccesses}/${mounted} succeeded`)
    }

    // Unmount all
    t = Date.now()
    await Promise.all(
      clients
        .filter((_, i) => connectResults[i])
        .map((c, i) => compIds[i] ? c.unmount(compIds[i]) : Promise.resolve()),
    )
    pass(`Unmount ${mounted} components`, Date.now() - t)
  } catch (e: any) {
    fail('Stress test', Date.now(), e.message)
  } finally {
    clients.forEach(c => c.close())
  }
}

async function testIsolatedRooms() {
  if (NUM_CLIENTS > 100) {
    await testMultipleClientsWorkers({ isolatedRooms: true, label: '[8]' })
  } else {
    // Small count: single-thread with isolated rooms
    log(`\n${colors.cyan}[8] Stress - ${NUM_CLIENTS} clientes (salas isoladas)${colors.reset}`)
    const clients: TestClient[] = []
    try {
      let t = Date.now()
      const connectPromises = Array.from({ length: NUM_CLIENTS }, () => {
        const c = new TestClient()
        clients.push(c)
        return c.connect().then(() => true).catch(() => false)
      })
      const connectResults = await Promise.all(connectPromises)
      const connected = connectResults.filter(Boolean).length
      if (connected === NUM_CLIENTS) {
        pass(`Connect ${NUM_CLIENTS} clients`, Date.now() - t, `all connected`)
      } else {
        fail(`Connect ${NUM_CLIENTS} clients`, Date.now() - t, `${connected}/${NUM_CLIENTS}`)
      }

      t = Date.now()
      const mountResults = await Promise.all(
        clients.filter((_, i) => connectResults[i]).map((c, i) =>
          c.mount('LiveCounter', {}, `isolated-${Date.now()}-${i}`).catch(e => ({ success: false, error: e.message }))
        )
      )
      const mounted = mountResults.filter((r: any) => r.success).length
      const compIds = mountResults.filter((r: any) => r.success).map((r: any) => r.result?.componentId)
      pass(`Mount ${mounted} counters (isolated rooms)`, Date.now() - t)

      t = Date.now()
      const actionResults = await Promise.all(
        clients.filter((_, i) => connectResults[i]).map((c, i) => {
          const cid = compIds[i]
          if (!cid) return Promise.resolve({ success: false })
          return c.callAction(cid, 'increment', {}).catch(e => ({ success: false, error: e.message }))
        })
      )
      const successes = actionResults.filter((r: any) => r.success).length
      const actionTime = Date.now() - t
      if (successes === mounted) {
        pass(`${mounted} increments (isolated)`, actionTime, `${Math.round(mounted / (actionTime / 1000))} req/s`)
      } else {
        fail(`${mounted} increments (isolated)`, actionTime, `${successes}/${mounted}`)
      }

      await Promise.all(clients.filter((_, i) => connectResults[i]).map((c, i) => compIds[i] ? c.unmount(compIds[i]) : Promise.resolve()))
      pass(`Unmount ${mounted}`, 0)
    } catch (e: any) {
      fail('Isolated rooms', Date.now(), e.message)
    } finally {
      clients.forEach(c => c.close())
    }
  }
}

async function testMultipleComponents() {
  log(`\n${colors.cyan}[6] Múltiplos componentes por conexão${colors.reset}`)
  const client = new TestClient()
  try {
    await client.connect()

    const components = ['LiveCounter', 'LiveChat', 'LiveForm']
    const compIds: string[] = []

    // Mount multiple components on same WS
    let t = Date.now()
    for (const comp of components) {
      const res = await client.mount(comp, {}, `multi-${Date.now()}`)
      if (!res.success) throw new Error(`Mount ${comp} failed: ${res.error}`)
      compIds.push(res.result.componentId)
    }
    pass(`Mount ${components.length} different components`, Date.now() - t, components.join(', '))

    // Action on counter
    t = Date.now()
    const incRes = await client.callAction(compIds[0], 'increment', {})
    if (!incRes.success) throw new Error('increment failed')
    pass('Action on LiveCounter', Date.now() - t)

    // Action on chat
    t = Date.now()
    const chatRes = await client.callAction(compIds[1], 'sendMessage', { user: 'Tester', text: 'multi-comp test' })
    if (!chatRes.success) throw new Error('sendMessage failed')
    pass('Action on LiveChat', Date.now() - t)

    // Unmount all
    t = Date.now()
    for (const id of compIds) await client.unmount(id)
    pass('Unmount all', Date.now() - t)
  } catch (e: any) {
    fail('Multiple components', Date.now(), e.message)
  } finally {
    client.close()
  }
}

async function testErrorCases() {
  log(`\n${colors.cyan}[7] Error Cases${colors.reset}`)
  const client = new TestClient()
  try {
    await client.connect()

    // Mount non-existent component
    let t = Date.now()
    const res = await client.mount('NonExistentComponent')
    if (res.success) {
      fail('Mount unknown component', Date.now() - t, 'Should have failed but succeeded')
    } else {
      pass('Mount unknown component -> error', Date.now() - t, `"${res.error}"`)
    }

    // Action on non-existent componentId
    t = Date.now()
    const actionRes = await client.callAction('fake-component-id', 'doSomething', {})
    if (actionRes.success) {
      fail('Action on invalid componentId', Date.now() - t, 'Should have failed')
    } else {
      pass('Action on invalid componentId -> error', Date.now() - t, `"${actionRes.error}"`)
    }

    // Chat: empty message
    t = Date.now()
    const mountChat = await client.mount('LiveChat', {}, `err-${Date.now()}`)
    if (mountChat.success) {
      const emptyRes = await client.callAction(mountChat.result.componentId, 'sendMessage', { user: 'X', text: '' })
      if (emptyRes.success) {
        fail('Send empty chat message', Date.now() - t, 'Should have failed')
      } else {
        pass('Send empty chat message -> error', Date.now() - t, `"${emptyRes.error}"`)
      }
      await client.unmount(mountChat.result.componentId)
    }
  } catch (e: any) {
    fail('Error cases', Date.now(), e.message)
  } finally {
    client.close()
  }
}

// ===== Main =====

async function main() {
  log(`${colors.bold}`)
  log(`╔══════════════════════════════════════════════════════════╗`)
  log(`║       FluxStack Live - WebSocket Test Suite             ║`)
  log(`╚══════════════════════════════════════════════════════════╝${colors.reset}`)
  log(`${colors.dim}URL: ${WS_URL}`)
  log(`Scenario: ${SCENARIO}`)
  log(`Stress clients: ${NUM_CLIENTS}${colors.reset}`)

  const scenarios: Record<string, () => Promise<void>> = {
    connection: testBasicConnection,
    mount: testMountAndAction,
    chat: testChatFlow,
    rapid: testRapidActions,
    stress: testMultipleClients,
    isolated: testIsolatedRooms,
    multi: testMultipleComponents,
    errors: testErrorCases,
  }

  const startTime = Date.now()

  if (SCENARIO === 'all') {
    for (const fn of Object.values(scenarios)) {
      await fn()
    }
  } else if (scenarios[SCENARIO]) {
    await scenarios[SCENARIO]()
  } else {
    log(`${colors.red}Unknown scenario: ${SCENARIO}${colors.reset}`)
    log(`Available: ${Object.keys(scenarios).join(', ')}`)
    process.exit(1)
  }

  // Summary
  const totalTime = Date.now() - startTime
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length

  log(`\n${colors.bold}══════════════════════════════════════════════════════════${colors.reset}`)
  log(`${colors.bold}Results:${colors.reset} ${colors.green}${passed} passed${colors.reset}, ${failed > 0 ? colors.red : colors.dim}${failed} failed${colors.reset} ${colors.dim}(${totalTime}ms)${colors.reset}`)

  if (failed > 0) {
    log(`\n${colors.red}Failed tests:${colors.reset}`)
    for (const r of results.filter(r => !r.passed)) {
      log(`  ${colors.red}✗${colors.reset} ${r.name}: ${r.error}`)
    }
  }

  log('')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
