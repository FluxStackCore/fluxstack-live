// =============================================================================
// FluxStack Live - Stress Test Worker (Bun Worker Thread)
//
// Each worker manages a batch of WebSocket clients independently.
// Communicates results back to the main thread via postMessage.
// =============================================================================

declare var self: Worker

interface WorkerConfig {
  workerId: number
  wsUrl: string
  numClients: number
  room: string
  timeoutMs: number
  isolatedRooms?: boolean // each client gets its own room
}

interface WorkerResult {
  workerId: number
  phase: 'connect' | 'mount' | 'action' | 'unmount' | 'done'
  success: number
  failed: number
  rateLimited: number
  duration: number
  errors?: string[]
}

function reqId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

class StressClient {
  private ws!: WebSocket
  private pendingResolvers = new Map<string, { resolve: (msg: any) => void; reject: (err: Error) => void }>()
  public connectionId?: string
  public connected = false
  private timeoutMs: number

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs
  }

  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), this.timeoutMs)
      this.ws = new WebSocket(url)

      this.ws.onopen = () => { this.connected = true }

      this.ws.onmessage = (event) => {
        const parsed = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
        // Server may send batched messages as a JSON array
        const messages = Array.isArray(parsed) ? parsed : [parsed]

        for (const msg of messages) {
          if (msg.type === 'CONNECTION_ESTABLISHED') {
            this.connectionId = msg.connectionId
            clearTimeout(timeout)
            resolve()
            continue
          }

          const isResponse = msg.type === 'ACTION_RESPONSE' || msg.type === 'MESSAGE_RESPONSE' ||
            msg.type === 'COMPONENT_MOUNTED' || msg.type === 'COMPONENT_REHYDRATED' ||
            msg.type === 'AUTH_RESPONSE' || msg.type === 'ERROR' || msg.type === 'COMPONENT_PONG'

          if (isResponse && msg.requestId && this.pendingResolvers.has(msg.requestId)) {
            const resolver = this.pendingResolvers.get(msg.requestId)!
            this.pendingResolvers.delete(msg.requestId)
            resolver.resolve(msg)
            continue
          }

          // Unmatched ERROR (rate limit) -> resolve oldest pending
          if (msg.type === 'ERROR' && !msg.requestId && this.pendingResolvers.size > 0) {
            const [firstId, resolver] = this.pendingResolvers.entries().next().value!
            this.pendingResolvers.delete(firstId)
            resolver.resolve({ success: false, error: msg.error, type: 'ERROR' })
            continue
          }
        }
      }

      this.ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error('WebSocket error'))
      }

      this.ws.onclose = () => {
        this.connected = false
        for (const [, resolver] of this.pendingResolvers) {
          resolver.reject(new Error('Connection closed'))
        }
        this.pendingResolvers.clear()
      }
    })
  }

  async send(msg: any): Promise<any> {
    const id = msg.requestId || reqId()
    msg.requestId = id
    msg.timestamp = Date.now()

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResolvers.delete(id)
        reject(new Error(`Timeout: ${msg.type}`))
      }, this.timeoutMs)

      this.pendingResolvers.set(id, {
        resolve: (response) => { clearTimeout(timeout); resolve(response) },
        reject: (err) => { clearTimeout(timeout); reject(err) },
      })

      this.ws.send(JSON.stringify(msg))
    })
  }

  async mount(component: string, room: string): Promise<any> {
    return this.send({
      type: 'COMPONENT_MOUNT',
      componentId: `mount-${component}`,
      payload: { component, props: {}, room },
    })
  }

  async callAction(componentId: string, action: string, payload: any = {}): Promise<any> {
    return this.send({
      type: 'CALL_ACTION',
      componentId,
      action,
      payload,
      expectResponse: true,
    })
  }

  unmount(componentId: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'COMPONENT_UNMOUNT',
        componentId,
        timestamp: Date.now(),
      }))
    }
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close()
    }
  }
}

function report(result: WorkerResult) {
  self.postMessage(result)
}

async function run(config: WorkerConfig) {
  const { workerId, wsUrl, numClients, room, timeoutMs } = config
  const clients: StressClient[] = []
  const errors: string[] = []

  // Phase 1: Connect (ramp up gradually to avoid overwhelming server accept queue)
  let t = Date.now()
  let success = 0
  let failed = 0

  const connectBatchSize = 25
  for (let i = 0; i < numClients; i += connectBatchSize) {
    const batch = Array.from({ length: Math.min(connectBatchSize, numClients - i) }, () => {
      const c = new StressClient(timeoutMs)
      clients.push(c)
      return c.connect(wsUrl).then(() => true).catch((e) => { errors.push(e.message); return false })
    })
    const results = await Promise.all(batch)
    success += results.filter(Boolean).length
    failed += results.filter(r => !r).length
    // Small delay between batches to let server process accept queue
    if (i + connectBatchSize < numClients) {
      await new Promise(r => setTimeout(r, 50))
    }
  }

  report({ workerId, phase: 'connect', success, failed, rateLimited: 0, duration: Date.now() - t, errors: errors.slice(0, 5) })

  const connectedClients = clients.filter(c => c.connected)

  // Phase 2: Mount (in batches)
  t = Date.now()
  success = 0
  failed = 0
  errors.length = 0
  const compIds: (string | null)[] = []

  const mountBatchSize = 50
  for (let i = 0; i < connectedClients.length; i += mountBatchSize) {
    const batch = connectedClients.slice(i, i + mountBatchSize).map((c, j) => {
      const clientRoom = config.isolatedRooms ? `${room}-${workerId}-${i + j}` : room
      return c.mount('LiveCounter', clientRoom).then(r => {
        if (r.success) { success++; return r.result?.componentId ?? null }
        failed++; errors.push(r.error || 'mount failed'); return null
      }).catch(e => { failed++; errors.push(e.message); return null })
    })
    const ids = await Promise.all(batch)
    compIds.push(...ids)
  }

  report({ workerId, phase: 'mount', success, failed, rateLimited: 0, duration: Date.now() - t, errors: errors.slice(0, 5) })

  // Phase 3: Action (each client increments once, in batches)
  t = Date.now()
  success = 0
  failed = 0
  let rateLimited = 0
  errors.length = 0

  const actionBatchSize = 50
  for (let i = 0; i < connectedClients.length; i += actionBatchSize) {
    const batch = connectedClients.slice(i, i + actionBatchSize).map((c, j) => {
      const cid = compIds[i + j]
      if (!cid) { failed++; return Promise.resolve() }
      return c.callAction(cid, 'increment', {}).then(r => {
        if (r.success) success++
        else if (r.error?.includes('Rate limit')) rateLimited++
        else { failed++; errors.push(r.error || 'action failed') }
      }).catch(e => { failed++; errors.push(e.message) })
    })
    await Promise.all(batch)
  }

  report({ workerId, phase: 'action', success, failed, rateLimited, duration: Date.now() - t, errors: errors.slice(0, 5) })

  // Phase 4: Unmount + close
  t = Date.now()
  for (let i = 0; i < connectedClients.length; i++) {
    const cid = compIds[i]
    if (cid) connectedClients[i].unmount(cid)
  }
  // Small delay to let unmount messages flush
  await new Promise(r => setTimeout(r, 100))
  clients.forEach(c => c.close())

  report({ workerId, phase: 'unmount', success: connectedClients.length, failed: 0, rateLimited: 0, duration: Date.now() - t })

  // Signal done
  report({ workerId, phase: 'done', success: 0, failed: 0, rateLimited: 0, duration: 0 })
}

// Listen for config from main thread
self.onmessage = (event: MessageEvent<WorkerConfig>) => {
  run(event.data).catch(err => {
    report({ workerId: event.data.workerId, phase: 'done', success: 0, failed: event.data.numClients, rateLimited: 0, duration: 0, errors: [err.message] })
  })
}
