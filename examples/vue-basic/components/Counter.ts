import { LiveComponent } from '@fluxstack/live'

export class Counter extends LiveComponent<typeof Counter.defaultState> {
  static componentName = 'Counter'
  static publicActions = ['increment', 'decrement', 'reset'] as const
  static defaultState = {
    count: 0,
    lastAction: null as string | null,
  }

  async increment() {
    this.state.count++
    this.state.lastAction = 'increment'
    return { success: true, count: this.state.count }
  }

  async decrement() {
    this.state.count--
    this.state.lastAction = 'decrement'
    return { success: true, count: this.state.count }
  }

  async reset() {
    this.state.count = 0
    this.state.lastAction = 'reset'
    return { success: true, count: 0 }
  }
}
