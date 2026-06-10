// Tests for npm plugin whitelist enforcement at registration time (.use()).
//
// Security model (specs/06-plugin-kit FP-1): a 3rd-party npm plugin (scoped
// name `@scope/...` or `fluxstack-plugin-*` prefix) must be in `allowedPlugins`
// to be registered. Built-in (`category:'built-in'`), first-party
// (`@fluxstack/live*`) and project plugins (free names) are always trusted.
import { describe, it, expect } from 'vitest'
import { PluginRegistry } from '../runtime/registry'
import type { FluxStackPlugin } from '../types'

function plugin(name: string, extra: Partial<FluxStackPlugin> = {}): FluxStackPlugin {
  return { name, ...extra } as FluxStackPlugin
}

describe('PluginRegistry — npm whitelist enforcement', () => {
  it('blocks an npm plugin (scoped) that is not whitelisted', () => {
    const reg = new PluginRegistry({ settings: { allowedPlugins: [] } })
    expect(() => reg.registerSync(plugin('@acme/fplugin-payments')))
      .toThrowError(/not whitelisted/i)
    expect(reg.has('@acme/fplugin-payments')).toBe(false)
  })

  it('blocks an npm plugin (fluxstack-plugin-* prefix) that is not whitelisted', () => {
    const reg = new PluginRegistry({ settings: { allowedPlugins: ['something-else'] } })
    expect(() => reg.registerSync(plugin('fluxstack-plugin-auth')))
      .toThrowError(/not whitelisted/i)
  })

  it('allows an npm plugin that IS whitelisted', () => {
    const reg = new PluginRegistry({ settings: { allowedPlugins: ['@acme/fplugin-payments'] } })
    expect(() => reg.registerSync(plugin('@acme/fplugin-payments'))).not.toThrow()
    expect(reg.has('@acme/fplugin-payments')).toBe(true)
  })

  it('always trusts project plugins (free names) regardless of whitelist', () => {
    const reg = new PluginRegistry({ settings: { allowedPlugins: [] } })
    expect(() => reg.registerSync(plugin('csrf-protection'))).not.toThrow()
    expect(reg.has('csrf-protection')).toBe(true)
  })

  it('always trusts built-in plugins (category: built-in)', () => {
    const reg = new PluginRegistry({ settings: { allowedPlugins: [] } })
    expect(() => reg.registerSync(plugin('@scope/whatever', { category: 'built-in' } as any)))
      .not.toThrow()
  })

  it('always trusts first-party @fluxstack/live* packages', () => {
    const reg = new PluginRegistry({ settings: { allowedPlugins: [] } })
    expect(() => reg.registerSync(plugin('@fluxstack/live-elysia'))).not.toThrow()
  })

  it('opt-out: enforceNpmWhitelist=false trusts all .use()-d plugins', () => {
    const reg = new PluginRegistry({
      settings: { allowedPlugins: [], enforceNpmWhitelist: false },
    })
    expect(() => reg.registerSync(plugin('@acme/fplugin-payments'))).not.toThrow()
    expect(reg.has('@acme/fplugin-payments')).toBe(true)
  })
})
