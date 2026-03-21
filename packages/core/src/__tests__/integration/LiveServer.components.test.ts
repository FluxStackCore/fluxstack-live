import { describe, it, expect, afterEach } from 'vitest'
import { LiveServer } from '../../server/LiveServer'
import { LiveComponent } from '../../component/LiveComponent'
import { createMockWS, spyOnConsole } from '../helpers'
import type { LiveTransport, WebSocketConfig, HttpRouteDefinition } from '../../transport/types'

// ===== Fake transport (no real server) =====

function createNoopTransport(): LiveTransport {
  return {
    async registerWebSocket(_config: WebSocketConfig) {},
    async registerHttpRoutes(_routes: HttpRouteDefinition[]) {},
  }
}

// ===== Test components (simulates what the generator exports) =====

class CounterComponent extends LiveComponent<{ count: number }> {
  static componentName = 'Counter'
  static defaultState = { count: 0 }
  static publicActions = ['increment'] as const

  increment() {
    this.state.count++
    return { count: this.state.count }
  }
}

class ChatComponent extends LiveComponent<{ messages: string[] }> {
  static componentName = 'Chat'
  static defaultState = { messages: [] }
  static publicActions = ['send'] as const

  send(payload: { text: string }) {
    this.state.messages = [...this.state.messages, payload.text]
  }
}

// Component without static componentName — should fall back to class.name
class FormWidget extends LiveComponent<{ value: string }> {
  static defaultState = { value: '' }
  static publicActions = [] as const
}

// ===== Tests =====

describe('LiveServer components[] option', () => {
  let consoleSpy: ReturnType<typeof spyOnConsole>

  afterEach(() => {
    consoleSpy?.restore()
  })

  it('should register all components passed via components[]', () => {
    consoleSpy = spyOnConsole()

    const server = new LiveServer({
      transport: createNoopTransport(),
      components: [CounterComponent, ChatComponent],
    })

    const names = server.registry.getRegisteredComponentNames()
    expect(names).toContain('Counter')
    expect(names).toContain('Chat')
    expect(names).toHaveLength(2)
  })

  it('should mount a component registered via components[]', async () => {
    consoleSpy = spyOnConsole()

    const server = new LiveServer({
      transport: createNoopTransport(),
      components: [CounterComponent],
    })

    const ws = createMockWS()
    const result = await server.registry.mountComponent(ws, 'Counter')

    expect(result.componentId).toBeDefined()
    expect(result.initialState).toEqual({ count: 0 })
    expect(result.signedState).toBeDefined()
  })

  it('should execute actions on a component registered via components[]', async () => {
    consoleSpy = spyOnConsole()

    const server = new LiveServer({
      transport: createNoopTransport(),
      components: [CounterComponent],
    })

    const ws = createMockWS()
    const { componentId } = await server.registry.mountComponent(ws, 'Counter')
    const actionResult = await server.registry.executeAction(componentId, 'increment', {})

    expect(actionResult).toEqual({ count: 1 })
  })

  it('should fall back to class.name when componentName is absent', () => {
    consoleSpy = spyOnConsole()

    const server = new LiveServer({
      transport: createNoopTransport(),
      components: [FormWidget],
    })

    const names = server.registry.getRegisteredComponentNames()
    expect(names).toContain('FormWidget')
  })

  it('should register zero components when components[] is empty', () => {
    consoleSpy = spyOnConsole()

    const server = new LiveServer({
      transport: createNoopTransport(),
      components: [],
    })

    const names = server.registry.getRegisteredComponentNames()
    expect(names).toHaveLength(0)
  })

  it('should register zero components when components is omitted', () => {
    consoleSpy = spyOnConsole()

    const server = new LiveServer({
      transport: createNoopTransport(),
    })

    const names = server.registry.getRegisteredComponentNames()
    expect(names).toHaveLength(0)
  })

  it('should make registered components visible to getRegisteredComponentNames()', () => {
    consoleSpy = spyOnConsole()

    const server = new LiveServer({
      transport: createNoopTransport(),
      components: [CounterComponent, ChatComponent, FormWidget],
    })

    const names = server.registry.getRegisteredComponentNames()
    expect(names).toEqual(
      expect.arrayContaining(['Counter', 'Chat', 'FormWidget']),
    )
    expect(names).toHaveLength(3)
  })

  it('should reject mounting a component not in the array', async () => {
    consoleSpy = spyOnConsole()

    const server = new LiveServer({
      transport: createNoopTransport(),
      components: [CounterComponent],
    })

    const ws = createMockWS()
    await expect(server.registry.mountComponent(ws, 'NotRegistered'))
      .rejects.toThrow()
  })
})
