/**
 * @fluxstack/plugin-kit
 *
 * Shared plugin system for FluxStack — types and runtime for authoring
 * plugins, consumed by both the FluxStack app and external plugin packages.
 *
 * This is the single source of truth for `Plugin`, `PluginContext`, all the
 * hook context types, and (starting in v0.3.0) the PluginManager runtime.
 *
 * @example
 * ```ts
 * import type { Plugin, PluginContext } from '@fluxstack/plugin-kit'
 *
 * export const myPlugin: Plugin = {
 *   name: 'my-plugin',
 *   setup: async (ctx) => {
 *     ctx.logger.info('Plugin ready')
 *   }
 * }
 * ```
 */

export const VERSION = '0.4.0'

// Re-export every public type from the types barrel.
export * from './types'

// Re-export runtime (classes + helper functions) from the runtime barrel.
export * from './runtime'
