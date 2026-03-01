// @fluxstack/live - Performance Monitor
//
// Tracks and reports on component performance metrics.

import { EventEmitter } from 'events'
import { liveLog, liveWarn } from '../debug/LiveLogger'

export interface ComponentPerformanceMetrics {
  componentId: string
  componentName: string
  mountTime: number
  actionTimes: Map<string, number[]>
  renderTimes: number[]
  stateChanges: number
  errorCount: number
  lastActivity: number
}

export interface PerformanceAlert {
  type: 'slow_action' | 'slow_render' | 'high_error_rate' | 'memory_warning'
  componentId: string
  componentName: string
  message: string
  value: number
  threshold: number
  timestamp: number
}

export interface PerformanceConfig {
  /** Threshold for slow action warnings (ms) */
  slowActionThreshold?: number
  /** Threshold for slow render warnings (ms) */
  slowRenderThreshold?: number
  /** Max errors before warning */
  highErrorRateThreshold?: number
  /** Enable performance alerts */
  alertsEnabled?: boolean
}

export class PerformanceMonitor extends EventEmitter {
  private components = new Map<string, ComponentPerformanceMetrics>()
  private alerts: PerformanceAlert[] = []
  private config: Required<PerformanceConfig>

  constructor(config: PerformanceConfig = {}) {
    super()
    this.config = {
      slowActionThreshold: config.slowActionThreshold ?? 1000,
      slowRenderThreshold: config.slowRenderThreshold ?? 500,
      highErrorRateThreshold: config.highErrorRateThreshold ?? 10,
      alertsEnabled: config.alertsEnabled ?? true,
    }
  }

  initializeComponent(componentId: string, componentName: string): void {
    this.components.set(componentId, {
      componentId,
      componentName,
      mountTime: Date.now(),
      actionTimes: new Map(),
      renderTimes: [],
      stateChanges: 0,
      errorCount: 0,
      lastActivity: Date.now()
    })
  }

  recordRenderTime(componentId: string, time: number): void {
    const metrics = this.components.get(componentId)
    if (!metrics) return

    metrics.renderTimes.push(time)
    metrics.lastActivity = Date.now()

    if (this.config.alertsEnabled && time > this.config.slowRenderThreshold) {
      this.addAlert({
        type: 'slow_render',
        componentId,
        componentName: metrics.componentName,
        message: `Slow render: ${time}ms (threshold: ${this.config.slowRenderThreshold}ms)`,
        value: time,
        threshold: this.config.slowRenderThreshold,
        timestamp: Date.now()
      })
    }
  }

  recordActionTime(componentId: string, action: string, time: number, error?: Error): void {
    const metrics = this.components.get(componentId)
    if (!metrics) return

    if (!metrics.actionTimes.has(action)) {
      metrics.actionTimes.set(action, [])
    }
    metrics.actionTimes.get(action)!.push(time)
    metrics.lastActivity = Date.now()

    if (error) {
      metrics.errorCount++
      if (this.config.alertsEnabled && metrics.errorCount >= this.config.highErrorRateThreshold) {
        this.addAlert({
          type: 'high_error_rate',
          componentId,
          componentName: metrics.componentName,
          message: `High error rate: ${metrics.errorCount} errors`,
          value: metrics.errorCount,
          threshold: this.config.highErrorRateThreshold,
          timestamp: Date.now()
        })
      }
    }

    if (this.config.alertsEnabled && time > this.config.slowActionThreshold) {
      this.addAlert({
        type: 'slow_action',
        componentId,
        componentName: metrics.componentName,
        message: `Slow action '${action}': ${time}ms (threshold: ${this.config.slowActionThreshold}ms)`,
        value: time,
        threshold: this.config.slowActionThreshold,
        timestamp: Date.now()
      })
    }
  }

  recordStateChange(componentId: string): void {
    const metrics = this.components.get(componentId)
    if (metrics) {
      metrics.stateChanges++
      metrics.lastActivity = Date.now()
    }
  }

  removeComponent(componentId: string): void {
    this.components.delete(componentId)
  }

  getComponentMetrics(componentId: string): ComponentPerformanceMetrics | null {
    return this.components.get(componentId) ?? null
  }

  getAllMetrics(): ComponentPerformanceMetrics[] {
    return Array.from(this.components.values())
  }

  getAlerts(limit = 50): PerformanceAlert[] {
    return this.alerts.slice(-limit)
  }

  clearAlerts(): void {
    this.alerts = []
  }

  getStats() {
    return {
      totalComponents: this.components.size,
      totalAlerts: this.alerts.length,
      components: Array.from(this.components.entries()).map(([id, m]) => ({
        id,
        name: m.componentName,
        renderCount: m.renderTimes.length,
        avgRenderTime: m.renderTimes.length > 0
          ? m.renderTimes.reduce((a, b) => a + b, 0) / m.renderTimes.length
          : 0,
        actionCount: Array.from(m.actionTimes.values()).reduce((sum, times) => sum + times.length, 0),
        stateChanges: m.stateChanges,
        errorCount: m.errorCount,
      }))
    }
  }

  private addAlert(alert: PerformanceAlert): void {
    this.alerts.push(alert)
    if (this.alerts.length > 1000) {
      this.alerts = this.alerts.slice(-500)
    }
    liveWarn('performance', alert.componentId, alert.message)
    this.emit('alert', alert)
  }
}
