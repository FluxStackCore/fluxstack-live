// Public component — no auth required
import { LiveComponent } from '@fluxstack/live'

export class PublicCounter extends LiveComponent<typeof PublicCounter.defaultState> {
  static componentName = 'PublicCounter'
  static publicActions = ['increment', 'decrement'] as const
  static defaultState = { count: 0 }

  async increment() {
    this.state.count++
    return { count: this.state.count }
  }

  async decrement() {
    this.state.count--
    return { count: this.state.count }
  }
}
