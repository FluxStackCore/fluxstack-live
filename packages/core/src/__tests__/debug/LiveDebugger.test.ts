// Tests for LiveDebugger — event tracking, snapshots, debug clients, sanitization
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LiveDebugger } from '../../debug/LiveDebugger'
import type { GenericWebSocket } from '../../transport/types'

function createMockDebugClient(): GenericWebSocket & { _sent: string[] } {
  const sent: string[] = []
  return {
    send: vi.fn((data: string) => { sent.push(data) }),
    close: vi.fn(),
    data: {} as any,
    remoteAddress: '127.0.0.1',
    readyState: 1,
    _sent: sent,
  } as any
}

describe('LiveDebugger', () => {
  describe('constructor + enabled', () => {
    it('disabled by default', () => {
      const dbg = new LiveDebugger()
      expect(dbg.enabled).toBe(false)
    })

    it('can be enabled via constructor', () => {
      const dbg = new LiveDebugger(true)
      expect(dbg.enabled).toBe(true)
    })

    it('can toggle enabled', () => {
      const dbg = new LiveDebugger()
      dbg.enabled = true
      expect(dbg.enabled).toBe(true)
      dbg.enabled = false
      expect(dbg.enabled).toBe(false)
    })
  })

  describe('emit() — when disabled', () => {
    it('does not record events when disabled', () => {
      const dbg = new LiveDebugger(false)
      dbg.emit('STATE_CHANGE', 'c1', 'TestComp', { delta: { x: 1 } })
      expect(dbg.getEvents()).toHaveLength(0)
    })
  })

  describe('emit() — when enabled', () => {
    let dbg: LiveDebugger

    beforeEach(() => {
      dbg = new LiveDebugger(true)
    })

    it('records events in circular buffer', () => {
      dbg.emit('STATE_CHANGE', 'c1', 'TestComp', { delta: { x: 1 } })
      dbg.emit('ACTION_CALL', 'c1', 'TestComp', { action: 'click' })

      const events = dbg.getEvents()
      expect(events).toHaveLength(2)
      expect(events[0].type).toBe('STATE_CHANGE')
      expect(events[1].type).toBe('ACTION_CALL')
    })

    it('assigns unique sequential IDs', () => {
      dbg.emit('STATE_CHANGE', 'c1', 'TestComp', {})
      dbg.emit('ACTION_CALL', 'c1', 'TestComp', {})

      const events = dbg.getEvents()
      expect(events[0].id).toBe('dbg-1')
      expect(events[1].id).toBe('dbg-2')
    })

    it('limits buffer to 500 events (circular buffer)', () => {
      for (let i = 0; i < 600; i++) {
        dbg.emit('STATE_CHANGE', 'c1', 'TestComp', { i })
      }

      const events = dbg.getEvents({ limit: 1000 })
      expect(events.length).toBeLessThanOrEqual(500)
    })

    it('broadcasts events to debug clients', () => {
      const client = createMockDebugClient()
      dbg.registerDebugClient(client)

      // Clear welcome messages
      client._sent.length = 0

      dbg.emit('STATE_CHANGE', 'c1', 'TestComp', { delta: {} })

      expect(client._sent).toHaveLength(1)
      const msg = JSON.parse(client._sent[0])
      expect(msg.type).toBe('DEBUG_EVENT')
      expect(msg.event.type).toBe('STATE_CHANGE')
    })
  })

  describe('trackComponentMount()', () => {
    it('creates snapshot and emits COMPONENT_MOUNT', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Counter', { count: 0 })

      const snapshot = dbg.getComponentState('c1')
      expect(snapshot).not.toBeNull()
      expect(snapshot!.componentName).toBe('Counter')
      expect(snapshot!.state).toEqual({ count: 0 })
      expect(snapshot!.actionCount).toBe(0)

      const events = dbg.getEvents()
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('COMPONENT_MOUNT')
    })

    it('stores debugLabel when provided', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Counter', { count: 0 }, undefined, 'main-counter')

      const snapshot = dbg.getComponentState('c1')
      expect(snapshot!.debugLabel).toBe('main-counter')
    })

    it('is a no-op when disabled', () => {
      const dbg = new LiveDebugger(false)
      dbg.trackComponentMount('c1', 'Counter', { count: 0 })
      expect(dbg.getComponentState('c1')).toBeNull()
    })
  })

  describe('trackComponentUnmount()', () => {
    it('removes snapshot and emits COMPONENT_UNMOUNT', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Counter', { count: 0 })
      dbg.trackComponentUnmount('c1')

      expect(dbg.getComponentState('c1')).toBeNull()
      const events = dbg.getEvents({ type: 'COMPONENT_UNMOUNT' })
      expect(events).toHaveLength(1)
    })
  })

  describe('trackStateChange()', () => {
    it('updates snapshot state and increments counter', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Counter', { count: 0 })
      dbg.trackStateChange('c1', { count: 1 }, { count: 1 })

      const snapshot = dbg.getComponentState('c1')
      expect(snapshot!.state).toEqual({ count: 1 })
      expect(snapshot!.stateChangeCount).toBe(1)
    })
  })

  describe('trackActionCall() + trackActionResult() + trackActionError()', () => {
    it('increments action count on call', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Counter', { count: 0 })
      dbg.trackActionCall('c1', 'increment', {})

      expect(dbg.getComponentState('c1')!.actionCount).toBe(1)
    })

    it('emits ACTION_RESULT with duration', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Counter', { count: 0 })
      dbg.trackActionResult('c1', 'increment', { count: 1 }, 15)

      const events = dbg.getEvents({ type: 'ACTION_RESULT' })
      expect(events).toHaveLength(1)
      expect(events[0].data.duration).toBe(15)
    })

    it('increments error count on error', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Counter', { count: 0 })
      dbg.trackActionError('c1', 'badAction', 'Something failed', 5)

      expect(dbg.getComponentState('c1')!.errorCount).toBe(1)
    })
  })

  describe('trackRoomJoin() + trackRoomLeave()', () => {
    it('tracks room membership in snapshot', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Chat', {})
      dbg.trackRoomJoin('c1', 'chat:lobby')

      expect(dbg.getComponentState('c1')!.rooms).toContain('chat:lobby')
    })

    it('removes room on leave', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Chat', {})
      dbg.trackRoomJoin('c1', 'chat:lobby')
      dbg.trackRoomLeave('c1', 'chat:lobby')

      expect(dbg.getComponentState('c1')!.rooms).not.toContain('chat:lobby')
    })

    it('does not duplicate room on multiple joins', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Chat', {})
      dbg.trackRoomJoin('c1', 'chat:lobby')
      dbg.trackRoomJoin('c1', 'chat:lobby')

      expect(dbg.getComponentState('c1')!.rooms.filter(r => r === 'chat:lobby')).toHaveLength(1)
    })
  })

  describe('trackConnection() + trackDisconnection()', () => {
    it('emits WS_CONNECT', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackConnection('conn-1')

      const events = dbg.getEvents({ type: 'WS_CONNECT' })
      expect(events).toHaveLength(1)
      expect(events[0].data.connectionId).toBe('conn-1')
    })

    it('emits WS_DISCONNECT', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackDisconnection('conn-1', 3)

      const events = dbg.getEvents({ type: 'WS_DISCONNECT' })
      expect(events).toHaveLength(1)
      expect(events[0].data.componentCount).toBe(3)
    })
  })

  describe('trackError()', () => {
    it('emits ERROR and increments component error count', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Counter', { count: 0 })
      dbg.trackError('c1', 'Something bad happened')

      expect(dbg.getComponentState('c1')!.errorCount).toBe(1)
      const events = dbg.getEvents({ type: 'ERROR' })
      expect(events).toHaveLength(1)
    })

    it('works without componentId', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackError(null, 'System error')

      const events = dbg.getEvents({ type: 'ERROR' })
      expect(events).toHaveLength(1)
      expect(events[0].componentId).toBeNull()
    })
  })

  describe('registerDebugClient()', () => {
    it('sends welcome message with snapshot', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Counter', { count: 0 })

      const client = createMockDebugClient()
      dbg.registerDebugClient(client)

      const welcome = JSON.parse(client._sent[0])
      expect(welcome.type).toBe('DEBUG_WELCOME')
      expect(welcome.enabled).toBe(true)
      expect(welcome.snapshot.components).toHaveLength(1)
    })

    it('sends recent events after welcome', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Counter', { count: 0 })
      dbg.trackStateChange('c1', { count: 1 }, { count: 1 })

      const client = createMockDebugClient()
      dbg.registerDebugClient(client)

      // 1 welcome + 2 recent events
      expect(client._sent.length).toBe(3)
    })

    it('sends DEBUG_DISABLED and closes when debugger is disabled', () => {
      const dbg = new LiveDebugger(false)
      const client = createMockDebugClient()

      dbg.registerDebugClient(client)

      const msg = JSON.parse(client._sent[0])
      expect(msg.type).toBe('DEBUG_DISABLED')
      expect(client.close).toHaveBeenCalled()
    })
  })

  describe('unregisterDebugClient()', () => {
    it('stops broadcasting to client', () => {
      const dbg = new LiveDebugger(true)
      const client = createMockDebugClient()
      dbg.registerDebugClient(client)

      client._sent.length = 0
      dbg.unregisterDebugClient(client)

      dbg.emit('STATE_CHANGE', 'c1', 'TestComp', {})
      expect(client._sent).toHaveLength(0)
    })
  })

  describe('getSnapshot()', () => {
    it('returns full snapshot', () => {
      const dbg = new LiveDebugger(true)
      dbg.trackComponentMount('c1', 'Counter', { count: 0 })
      dbg.trackComponentMount('c2', 'Timer', { seconds: 0 })

      const snapshot = dbg.getSnapshot()
      expect(snapshot.components).toHaveLength(2)
      expect(snapshot.totalEvents).toBeGreaterThan(0)
      expect(snapshot.uptime).toBeGreaterThanOrEqual(0)
    })
  })

  describe('getEvents() filtering', () => {
    it('filters by componentId', () => {
      const dbg = new LiveDebugger(true)
      dbg.emit('STATE_CHANGE', 'c1', 'A', {})
      dbg.emit('STATE_CHANGE', 'c2', 'B', {})

      const events = dbg.getEvents({ componentId: 'c1' })
      expect(events).toHaveLength(1)
      expect(events[0].componentId).toBe('c1')
    })

    it('filters by type', () => {
      const dbg = new LiveDebugger(true)
      dbg.emit('STATE_CHANGE', 'c1', 'A', {})
      dbg.emit('ACTION_CALL', 'c1', 'A', {})

      const events = dbg.getEvents({ type: 'ACTION_CALL' })
      expect(events).toHaveLength(1)
    })

    it('respects limit', () => {
      const dbg = new LiveDebugger(true)
      for (let i = 0; i < 20; i++) {
        dbg.emit('STATE_CHANGE', 'c1', 'A', { i })
      }

      const events = dbg.getEvents({ limit: 5 })
      expect(events).toHaveLength(5)
    })
  })

  describe('clearEvents()', () => {
    it('clears all events', () => {
      const dbg = new LiveDebugger(true)
      dbg.emit('STATE_CHANGE', 'c1', 'A', {})
      dbg.emit('ACTION_CALL', 'c1', 'A', {})

      dbg.clearEvents()
      expect(dbg.getEvents()).toHaveLength(0)
    })
  })

  describe('sanitization', () => {
    it('truncates oversized data (>50KB)', () => {
      const dbg = new LiveDebugger(true)
      const bigData = { huge: 'x'.repeat(60_000) }
      dbg.emit('STATE_CHANGE', 'c1', 'A', bigData)

      const events = dbg.getEvents()
      expect((events[0].data as any)._truncated).toBe(true)
      expect((events[0].data as any)._size).toBeGreaterThan(50_000)
    })

    it('truncates oversized state in snapshots', () => {
      const dbg = new LiveDebugger(true)
      const bigState = { huge: 'x'.repeat(60_000) }
      dbg.trackComponentMount('c1', 'Big', bigState)

      const snapshot = dbg.getComponentState('c1')
      expect((snapshot!.state as any)._truncated).toBe(true)
    })

    it('handles non-serializable data gracefully', () => {
      const dbg = new LiveDebugger(true)
      const circular: any = {}
      circular.self = circular
      dbg.emit('STATE_CHANGE', 'c1', 'A', circular)

      const events = dbg.getEvents()
      expect((events[0].data as any)._serialization_error).toBe(true)
    })
  })
})
