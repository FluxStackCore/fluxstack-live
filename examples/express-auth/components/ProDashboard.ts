// Pro-only component — uses authorize() for plan check
// Demonstrates: custom authorize with async logic
import { LiveComponent } from '@fluxstack/live'
import type { LiveComponentAuth } from '@fluxstack/live'

export class ProDashboard extends LiveComponent<typeof ProDashboard.defaultState> {
  static componentName = 'ProDashboard'
  static publicActions = ['getStats'] as const
  static defaultState = { stats: { views: 0, revenue: 0 } }

  // Custom authorize: only pro or enterprise plans
  static auth: LiveComponentAuth = {
    required: true,
    authorize: (auth) => {
      const plan = (auth.session as any)?.plan
      if (plan !== 'pro' && plan !== 'enterprise') {
        return { allowed: false, reason: `Pro or Enterprise plan required (current: ${plan || 'none'})` }
      }
      return true
    }
  }

  async getStats() {
    return {
      plan: (this.$auth.session as any)?.plan,
      stats: this.state.stats,
    }
  }
}
