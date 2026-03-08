// Tests for PerformanceMonitor — metrics tracking, alerts, thresholds
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PerformanceMonitor } from '../../monitoring/PerformanceMonitor'

// Mock LiveLogger
vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
}))

describe('PerformanceMonitor', () => {
  let monitor: PerformanceMonitor

  beforeEach(() => {
    monitor = new PerformanceMonitor({
      slowActionThreshold: 100,
      slowRenderThreshold: 50,
      highErrorRateThreshold: 3,
      alertsEnabled: true,
    })
  })

  describe('initializeComponent()', () => {
    it('creates component metrics entry', () => {
      monitor.initializeComponent('c1', 'Counter')
      const metrics = monitor.getComponentMetrics('c1')

      expect(metrics).not.toBeNull()
      expect(metrics!.componentId).toBe('c1')
      expect(metrics!.componentName).toBe('Counter')
      expect(metrics!.stateChanges).toBe(0)
      expect(metrics!.errorCount).toBe(0)
    })
  })

  describe('recordRenderTime()', () => {
    it('records render time', () => {
      monitor.initializeComponent('c1', 'Counter')
      monitor.recordRenderTime('c1', 10)
      monitor.recordRenderTime('c1', 20)

      const metrics = monitor.getComponentMetrics('c1')
      expect(metrics!.renderTimes).toEqual([10, 20])
    })

    it('generates alert for slow render', () => {
      monitor.initializeComponent('c1', 'Counter')
      monitor.recordRenderTime('c1', 100) // Exceeds 50ms threshold

      const alerts = monitor.getAlerts()
      expect(alerts).toHaveLength(1)
      expect(alerts[0].type).toBe('slow_render')
      expect(alerts[0].value).toBe(100)
    })

    it('does not alert for fast render', () => {
      monitor.initializeComponent('c1', 'Counter')
      monitor.recordRenderTime('c1', 10)

      expect(monitor.getAlerts()).toHaveLength(0)
    })

    it('is a no-op for unknown component', () => {
      // Should not throw
      monitor.recordRenderTime('unknown', 10)
    })
  })

  describe('recordActionTime()', () => {
    it('records action time per action name', () => {
      monitor.initializeComponent('c1', 'Counter')
      monitor.recordActionTime('c1', 'increment', 10)
      monitor.recordActionTime('c1', 'increment', 20)
      monitor.recordActionTime('c1', 'decrement', 5)

      const metrics = monitor.getComponentMetrics('c1')
      expect(metrics!.actionTimes.get('increment')).toEqual([10, 20])
      expect(metrics!.actionTimes.get('decrement')).toEqual([5])
    })

    it('generates alert for slow action', () => {
      monitor.initializeComponent('c1', 'Counter')
      monitor.recordActionTime('c1', 'slowAction', 200)

      const alerts = monitor.getAlerts()
      expect(alerts.some(a => a.type === 'slow_action')).toBe(true)
    })

    it('tracks errors and generates alert at threshold', () => {
      monitor.initializeComponent('c1', 'Counter')
      monitor.recordActionTime('c1', 'fail', 10, new Error('err1'))
      monitor.recordActionTime('c1', 'fail', 10, new Error('err2'))

      expect(monitor.getAlerts().filter(a => a.type === 'high_error_rate')).toHaveLength(0)

      monitor.recordActionTime('c1', 'fail', 10, new Error('err3')) // hits threshold of 3

      expect(monitor.getAlerts().filter(a => a.type === 'high_error_rate')).toHaveLength(1)
    })
  })

  describe('recordStateChange()', () => {
    it('increments state change counter', () => {
      monitor.initializeComponent('c1', 'Counter')
      monitor.recordStateChange('c1')
      monitor.recordStateChange('c1')

      expect(monitor.getComponentMetrics('c1')!.stateChanges).toBe(2)
    })
  })

  describe('removeComponent()', () => {
    it('removes component metrics', () => {
      monitor.initializeComponent('c1', 'Counter')
      monitor.removeComponent('c1')

      expect(monitor.getComponentMetrics('c1')).toBeNull()
    })
  })

  describe('getAllMetrics()', () => {
    it('returns all component metrics', () => {
      monitor.initializeComponent('c1', 'Counter')
      monitor.initializeComponent('c2', 'Timer')

      expect(monitor.getAllMetrics()).toHaveLength(2)
    })
  })

  describe('getAlerts()', () => {
    it('returns alerts with limit', () => {
      monitor.initializeComponent('c1', 'Counter')
      for (let i = 0; i < 10; i++) {
        monitor.recordRenderTime('c1', 100) // Each generates alert
      }

      const alerts = monitor.getAlerts(5)
      expect(alerts).toHaveLength(5)
    })
  })

  describe('clearAlerts()', () => {
    it('clears all alerts', () => {
      monitor.initializeComponent('c1', 'Counter')
      monitor.recordRenderTime('c1', 100)

      monitor.clearAlerts()
      expect(monitor.getAlerts()).toHaveLength(0)
    })
  })

  describe('getStats()', () => {
    it('returns aggregated statistics', () => {
      monitor.initializeComponent('c1', 'Counter')
      monitor.recordRenderTime('c1', 10)
      monitor.recordRenderTime('c1', 20)
      monitor.recordActionTime('c1', 'increment', 5)
      monitor.recordStateChange('c1')

      const stats = monitor.getStats()
      expect(stats.totalComponents).toBe(1)
      expect(stats.components[0].renderCount).toBe(2)
      expect(stats.components[0].avgRenderTime).toBe(15)
      expect(stats.components[0].actionCount).toBe(1)
      expect(stats.components[0].stateChanges).toBe(1)
    })
  })

  describe('event emission', () => {
    it('emits alert event', () => {
      const handler = vi.fn()
      monitor.on('alert', handler)

      monitor.initializeComponent('c1', 'Counter')
      monitor.recordRenderTime('c1', 100) // Slow render

      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls[0][0].type).toBe('slow_render')
    })
  })

  describe('alerts disabled', () => {
    it('does not generate alerts when disabled', () => {
      const noAlerts = new PerformanceMonitor({ alertsEnabled: false })
      noAlerts.initializeComponent('c1', 'Counter')
      noAlerts.recordRenderTime('c1', 1000) // Very slow
      noAlerts.recordActionTime('c1', 'slow', 5000)

      expect(noAlerts.getAlerts()).toHaveLength(0)
    })
  })

  describe('alert buffer overflow', () => {
    it('trims alerts when buffer exceeds 1000', () => {
      monitor.initializeComponent('c1', 'Counter')
      for (let i = 0; i < 1100; i++) {
        monitor.recordRenderTime('c1', 100) // Each generates alert
      }

      // Buffer trims to last 500 when it hits 1001
      const alerts = monitor.getAlerts(2000)
      expect(alerts.length).toBeLessThanOrEqual(1000)
    })
  })
})
