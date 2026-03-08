// ElysiaTransport Integration Tests (Bun runtime)
//
// Run with: cd packages/elysia && bun test

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { LiveServer, LiveComponent } from '@fluxstack/live'
import { ElysiaTransport } from '../index'

// ── Test Component ──────────────────────────────────

class TestCounter extends LiveComponent<{ count: number }> {
  static componentName = 'TestCounter'
  static defaultState = { count: 0 }
  static publicActions = ['increment', 'getCount'] as const

  increment() {
    this.setState({ count: (this.state as any).count + 1 })
    return { count: (this.state as any).count }
  }

  getCount() {
    return { count: (this.state as any).count }
  }
}

// ── Helpers ─────────────────────────────────────────

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Connect and wait for CONNECTION_ESTABLISHED in one step (avoids race). */
function connectAndWait(port: number, timeout = 5000): Promise<{ ws: WebSocket; connectionId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live/ws`)
    const timer = setTimeout(() => reject(new Error('Timeout waiting for CONNECTION_ESTABLISHED')), timeout)

    ws.onmessage = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string)
      if (msg.type === 'CONNECTION_ESTABLISHED') {
        clearTimeout(timer)
        resolve({ ws, connectionId: msg.connectionId })
      }
    }

    ws.onerror = (event: Event) => {
      clearTimeout(timer)
      reject(new Error('WebSocket error'))
    }
  })
}

/** Attach listener BEFORE sending to avoid race conditions. */
function sendAndWait(ws: WebSocket, message: object, expectedType: string, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler)
      reject(new Error(`Timeout waiting for ${expectedType}`))
    }, timeout)
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string)
      if (msg.type === expectedType) {
        clearTimeout(timer)
        ws.removeEventListener('message', handler)
        resolve(msg)
      }
    }
    ws.addEventListener('message', handler)
    ws.send(JSON.stringify(message))
  })
}

// ── Tests ───────────────────────────────────────────

describe('ElysiaTransport', () => {
  let app: Elysia
  let liveServer: LiveServer
  const PORT = 19004

  beforeEach(async () => {
    app = new Elysia()
    const transport = new ElysiaTransport(app)

    liveServer = new LiveServer({ transport })

    liveServer.registry.registerComponentClass('TestCounter', TestCounter as any)
    await liveServer.start()

    app.listen(PORT)
    await wait(50)
  })

  afterEach(async () => {
    await liveServer.shutdown()
    app.stop()
    await wait(50)
  })

  it('should establish WebSocket connection', async () => {
    const { ws, connectionId } = await connectAndWait(PORT)

    expect(connectionId).toBeDefined()

    ws.close()
  })

  it('should mount a component and receive initial state', async () => {
    const { ws } = await connectAndWait(PORT)

    const stateMsg = await sendAndWait(ws, {
      type: 'COMPONENT_MOUNT',
      payload: { component: 'TestCounter' },
      timestamp: Date.now(),
    }, 'STATE_UPDATE')

    expect(stateMsg.type).toBe('STATE_UPDATE')
    expect(stateMsg.payload.state).toEqual({ count: 0 })
    expect(stateMsg.componentId).toBeDefined()

    ws.close()
  })

  it('should call an action and receive response', async () => {
    const { ws } = await connectAndWait(PORT)

    const stateMsg = await sendAndWait(ws, {
      type: 'COMPONENT_MOUNT',
      payload: { component: 'TestCounter' },
      timestamp: Date.now(),
    }, 'STATE_UPDATE')

    const componentId = stateMsg.componentId

    const actionResponse = await sendAndWait(ws, {
      type: 'CALL_ACTION',
      componentId,
      action: 'increment',
      payload: {},
      expectResponse: true,
      requestId: 'req-1',
      timestamp: Date.now(),
    }, 'ACTION_RESPONSE')

    expect(actionResponse.success).toBe(true)
    expect(actionResponse.result.count).toBe(1)

    ws.close()
  })

  it('should unmount a component', async () => {
    const { ws } = await connectAndWait(PORT)

    const stateMsg = await sendAndWait(ws, {
      type: 'COMPONENT_MOUNT',
      payload: { component: 'TestCounter' },
      timestamp: Date.now(),
    }, 'STATE_UPDATE')

    ws.send(JSON.stringify({
      type: 'COMPONENT_UNMOUNT',
      componentId: stateMsg.componentId,
      timestamp: Date.now(),
    }))

    await wait(100)

    const component = liveServer.registry.getComponent(stateMsg.componentId)
    expect(component).toBeUndefined()

    ws.close()
  })

  it('should reject invalid action', async () => {
    const { ws } = await connectAndWait(PORT)

    const stateMsg = await sendAndWait(ws, {
      type: 'COMPONENT_MOUNT',
      payload: { component: 'TestCounter' },
      timestamp: Date.now(),
    }, 'STATE_UPDATE')

    const errorMsg = await sendAndWait(ws, {
      type: 'CALL_ACTION',
      componentId: stateMsg.componentId,
      action: 'nonExistentAction',
      payload: {},
      expectResponse: true,
      requestId: 'req-bad',
      timestamp: Date.now(),
    }, 'ACTION_RESPONSE')

    expect(errorMsg.success).toBe(false)

    ws.close()
  })
})
