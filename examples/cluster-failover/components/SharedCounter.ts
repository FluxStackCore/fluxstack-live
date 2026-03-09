import { LiveComponent } from '@fluxstack/live'

export class SharedCounter extends LiveComponent<typeof SharedCounter.defaultState> {
  static componentName = 'SharedCounter'
  static singleton = true
  static publicActions = ['increment', 'decrement', 'reset'] as const
  static defaultState = {
    count: 0,
    lastServer: '' as string,
    history: [] as string[],
  }

  private get serverLabel(): string {
    // Read PORT from environment — each server process sets this
    return `Server ${process.env.SERVER_PORT || '?'}`
  }

  private pushHistory(entry: string) {
    const history = [...((this.state as any).history || [])]
    history.push(entry)
    if (history.length > 20) history.shift()
    return history
  }

  increment() {
    const count = (this.state as any).count + 1
    const history = this.pushHistory(`+1 → ${count} (${this.serverLabel})`)
    this.setState({ count, lastServer: this.serverLabel, history })
    return { count }
  }

  decrement() {
    const count = (this.state as any).count - 1
    const history = this.pushHistory(`-1 → ${count} (${this.serverLabel})`)
    this.setState({ count, lastServer: this.serverLabel, history })
    return { count }
  }

  reset() {
    const history = this.pushHistory(`reset → 0 (${this.serverLabel})`)
    this.setState({ count: 0, lastServer: this.serverLabel, history })
    return { count: 0 }
  }
}
