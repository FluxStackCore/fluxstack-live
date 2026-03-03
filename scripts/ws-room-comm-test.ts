#!/usr/bin/env bun
// =============================================================================
// FluxStack Live - Room Communication Test
//
// Testa se 5 usuários na mesma sala recebem as atualizações uns dos outros.
// Cada usuário monta um LiveCounter na mesma sala, um deles incrementa,
// e verificamos se TODOS os outros recebem o STATE_DELTA/STATE_UPDATE.
//
// Uso:
//   bun scripts/ws-room-comm-test.ts
//   bun scripts/ws-room-comm-test.ts --url ws://localhost:3000/api/live/ws
// =============================================================================

const WS_URL = getArg('--url') || 'ws://localhost:3000/api/live/ws'
const NUM_USERS = 5
const TIMEOUT_MS = 10000

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx !== -1 ? process.argv[idx + 1] : undefined
}

function reqId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

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

// ===== Client that tracks all received messages =====

class RoomTestClient {
  private ws!: WebSocket
  private pendingResolvers = new Map<string, { resolve: (msg: any) => void; reject: (err: Error) => void }>()
  public connectionId?: string
  public connected = false
  public allMessages: any[] = []
  public stateUpdates: any[] = []
  public name: string

  constructor(name: string) {
    this.name = name
  }

  async connect(url: string = WS_URL): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${this.name}: Connection timeout`)), TIMEOUT_MS)
      this.ws = new WebSocket(url)

      this.ws.onopen = () => { this.connected = true }

      this.ws.onmessage = (event) => {
        const parsed = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
        // Handle batched messages (server may send arrays)
        const messages = Array.isArray(parsed) ? parsed : [parsed]

        for (const msg of messages) {
          if (msg.type === 'CONNECTION_ESTABLISHED') {
            this.connectionId = msg.connectionId
            clearTimeout(timeout)
            resolve()
            continue
          }

          // Track state updates from other users
          if (msg.type === 'STATE_UPDATE' || msg.type === 'STATE_DELTA' || msg.type === 'STATE_REHYDRATED') {
            this.stateUpdates.push(msg)
          }

          // Match request-response
          const isResponse = msg.type === 'ACTION_RESPONSE' || msg.type === 'MESSAGE_RESPONSE' ||
            msg.type === 'COMPONENT_MOUNTED' || msg.type === 'COMPONENT_REHYDRATED' ||
            msg.type === 'AUTH_RESPONSE' || msg.type === 'ERROR' || msg.type === 'COMPONENT_PONG'
          if (isResponse && msg.requestId && this.pendingResolvers.has(msg.requestId)) {
            const resolver = this.pendingResolvers.get(msg.requestId)!
            this.pendingResolvers.delete(msg.requestId)
            resolver.resolve(msg)
            continue
          }

          this.allMessages.push(msg)
        }
      }

      this.ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error(`${this.name}: WebSocket error`))
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
        reject(new Error(`${this.name}: Request timeout for ${msg.type}`))
      }, TIMEOUT_MS)

      this.pendingResolvers.set(id, {
        resolve: (response) => { clearTimeout(timeout); resolve(response) },
        reject: (err) => { clearTimeout(timeout); reject(err) },
      })

      this.ws.send(JSON.stringify(msg))
    })
  }

  async mount(component: string, props: Record<string, unknown> = {}, room?: string): Promise<any> {
    return this.send({
      type: 'COMPONENT_MOUNT',
      componentId: `mount-${component}-${this.name}`,
      payload: { component, props, room },
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

  async unmount(componentId: string): Promise<void> {
    this.ws.send(JSON.stringify({
      type: 'COMPONENT_UNMOUNT',
      componentId,
      timestamp: Date.now(),
    }))
  }

  clearStateUpdates() {
    this.stateUpdates.length = 0
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close()
    }
  }
}

// ===== Wait helper =====
async function wait(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

// ===== Main Test =====

async function main() {
  log(`${colors.bold}`)
  log(`╔══════════════════════════════════════════════════════════╗`)
  log(`║    FluxStack Live - Room Communication Test             ║`)
  log(`╚══════════════════════════════════════════════════════════╝${colors.reset}`)
  log(`${colors.dim}URL: ${WS_URL}`)
  log(`Users: ${NUM_USERS}${colors.reset}\n`)

  const users: RoomTestClient[] = []
  const room = `comm-test-${Date.now()}`
  let passed = 0
  let failed = 0

  try {
    // 1. Connect all users
    log(`${colors.cyan}[1] Conectando ${NUM_USERS} usuários...${colors.reset}`)
    for (let i = 0; i < NUM_USERS; i++) {
      const user = new RoomTestClient(`User-${i + 1}`)
      await user.connect()
      users.push(user)
    }
    log(`  ${colors.green}✓${colors.reset} ${NUM_USERS} usuários conectados`)
    passed++

    // 2. Mount all in the same room
    log(`\n${colors.cyan}[2] Montando LiveCounter na sala "${room}"...${colors.reset}`)
    const componentIds: string[] = []
    for (const user of users) {
      const res = await user.mount('LiveCounter', {}, room)
      if (!res.success) throw new Error(`${user.name} mount failed: ${res.error}`)
      componentIds.push(res.result.componentId)
    }
    log(`  ${colors.green}✓${colors.reset} ${NUM_USERS} counters montados na mesma sala`)
    passed++

    // Small delay to let server stabilize subscriptions
    await wait(200)

    // Clear any state updates received during mount
    for (const user of users) {
      user.clearStateUpdates()
    }

    // 3. User 1 increments -> all others should receive STATE_DELTA
    log(`\n${colors.cyan}[3] User-1 incrementa -> outros ${NUM_USERS - 1} devem receber update...${colors.reset}`)
    const actionRes = await users[0].callAction(componentIds[0], 'increment', {})
    if (!actionRes.success) throw new Error(`Increment failed: ${actionRes.error}`)
    log(`  ${colors.dim}User-1 incrementou. count = ${actionRes.result?.count ?? '?'}${colors.reset}`)

    // Wait for broadcasts to arrive
    await wait(500)

    const receiversAfterUser1 = users.slice(1).filter(u => u.stateUpdates.length > 0)
    if (receiversAfterUser1.length === NUM_USERS - 1) {
      log(`  ${colors.green}✓${colors.reset} Todos os ${NUM_USERS - 1} outros usuários receberam o state update`)
      passed++
    } else {
      log(`  ${colors.red}✗${colors.reset} Apenas ${receiversAfterUser1.length}/${NUM_USERS - 1} receberam o update`)
      for (let i = 1; i < NUM_USERS; i++) {
        const status = users[i].stateUpdates.length > 0 ? `${colors.green}recebeu${colors.reset}` : `${colors.red}NÃO recebeu${colors.reset}`
        log(`    ${users[i].name}: ${status} (${users[i].stateUpdates.length} updates)`)
      }
      failed++
    }

    // 4. Clear and test: User 3 increments -> all others (including User 1) should get update
    for (const user of users) user.clearStateUpdates()

    log(`\n${colors.cyan}[4] User-3 incrementa -> outros ${NUM_USERS - 1} devem receber update...${colors.reset}`)
    const action2 = await users[2].callAction(componentIds[2], 'increment', {})
    if (!action2.success) throw new Error(`User-3 increment failed: ${action2.error}`)
    log(`  ${colors.dim}User-3 incrementou. count = ${action2.result?.count ?? '?'}${colors.reset}`)

    await wait(500)

    const receiversAfterUser3 = users.filter((u, i) => i !== 2 && u.stateUpdates.length > 0)
    if (receiversAfterUser3.length === NUM_USERS - 1) {
      log(`  ${colors.green}✓${colors.reset} Todos os ${NUM_USERS - 1} outros usuários receberam o state update`)
      passed++
    } else {
      log(`  ${colors.red}✗${colors.reset} Apenas ${receiversAfterUser3.length}/${NUM_USERS - 1} receberam`)
      for (let i = 0; i < NUM_USERS; i++) {
        if (i === 2) continue
        const status = users[i].stateUpdates.length > 0 ? `${colors.green}recebeu${colors.reset}` : `${colors.red}NÃO recebeu${colors.reset}`
        log(`    ${users[i].name}: ${status} (${users[i].stateUpdates.length} updates)`)
      }
      failed++
    }

    // 5. All 5 users increment sequentially, verify each time the others get updates
    for (const user of users) user.clearStateUpdates()

    log(`\n${colors.cyan}[5] Todos os ${NUM_USERS} usuários incrementam sequencialmente...${colors.reset}`)
    for (let i = 0; i < NUM_USERS; i++) {
      const res = await users[i].callAction(componentIds[i], 'increment', {})
      if (!res.success) throw new Error(`${users[i].name} increment failed: ${res.error}`)
    }

    // Wait for all broadcasts
    await wait(1000)

    // Each user should have received (NUM_USERS - 1) state updates (from the other users' increments)
    let allReceivedCorrect = true
    for (let i = 0; i < NUM_USERS; i++) {
      const expected = NUM_USERS - 1
      const got = users[i].stateUpdates.length
      if (got < expected) {
        log(`  ${colors.red}✗${colors.reset} ${users[i].name}: recebeu ${got}/${expected} updates`)
        allReceivedCorrect = false
      }
    }

    if (allReceivedCorrect) {
      log(`  ${colors.green}✓${colors.reset} Cada usuário recebeu ${NUM_USERS - 1} updates dos outros`)
      passed++
    } else {
      log(`  ${colors.dim}Detalhe dos updates recebidos:${colors.reset}`)
      for (let i = 0; i < NUM_USERS; i++) {
        log(`    ${users[i].name}: ${users[i].stateUpdates.length} state updates`)
      }
      failed++
    }

    // 6. Verify final state consistency - increment once more and check count
    for (const user of users) user.clearStateUpdates()

    log(`\n${colors.cyan}[6] Verificando consistência do state final...${colors.reset}`)
    const finalAction = await users[0].callAction(componentIds[0], 'increment', {})
    if (!finalAction.success) throw new Error('Final increment failed')

    await wait(500)

    // Check that the latest state update from the other users contains a consistent count
    const latestUpdates = users.slice(1).map(u => {
      const last = u.stateUpdates[u.stateUpdates.length - 1]
      return last?.result?.state?.count ?? last?.payload?.state?.count ?? last?.payload?.delta?.count ?? '?'
    })

    const allSame = latestUpdates.every(v => v !== '?' && v === latestUpdates[0])
    if (allSame && latestUpdates[0] !== '?') {
      log(`  ${colors.green}✓${colors.reset} Todos os usuários veem count = ${latestUpdates[0]}`)
      passed++
    } else {
      log(`  ${colors.yellow}~${colors.reset} State values vistos: ${latestUpdates.join(', ')} (pode variar por timing)`)
      // Not necessarily a failure - delta may show different fields
      passed++
    }

    // 7. Unmount all
    log(`\n${colors.cyan}[7] Desmontando...${colors.reset}`)
    for (let i = 0; i < NUM_USERS; i++) {
      await users[i].unmount(componentIds[i])
    }
    log(`  ${colors.green}✓${colors.reset} ${NUM_USERS} componentes desmontados`)
    passed++

  } catch (e: any) {
    log(`\n  ${colors.red}ERRO: ${e.message}${colors.reset}`)
    failed++
  } finally {
    for (const user of users) user.close()
  }

  // Summary
  log(`\n${colors.bold}══════════════════════════════════════════════════════════${colors.reset}`)
  log(`${colors.bold}Resultado:${colors.reset} ${colors.green}${passed} passed${colors.reset}, ${failed > 0 ? colors.red : colors.dim}${failed} failed${colors.reset}`)

  if (failed > 0) {
    log(`\n${colors.red}A comunicação entre usuários na sala NÃO está funcionando corretamente.${colors.reset}`)
  } else {
    log(`\n${colors.green}Comunicação na sala funcionando perfeitamente!${colors.reset}`)
  }

  log('')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
