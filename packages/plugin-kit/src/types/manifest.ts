/**
 * Plugin metadata types — manifest, registry state, metrics, install/discovery
 * options, validation results.
 */

import type { PluginHook } from './hooks'
import type { PluginConfigSchema } from './context'
import type { Plugin } from './plugin'

export interface PluginManifest {
  name: string
  version: string
  description: string
  author: string
  license: string
  homepage?: string
  repository?: string
  keywords: string[]
  dependencies: Record<string, string>
  peerDependencies?: Record<string, string>
  fluxstack: {
    version: string
    hooks: PluginHook[]
    config?: PluginConfigSchema
    category?: string
    tags?: string[]
  }
}

export interface PluginLoadResult<TConfig = unknown> {
  success: boolean
  plugin?: Plugin<TConfig>
  error?: string
  warnings?: string[]
}

export interface PluginRegistryState<TConfig = unknown> {
  plugins: Map<string, Plugin<TConfig>>
  manifests: Map<string, PluginManifest>
  loadOrder: string[]
  dependencies: Map<string, string[]>
  conflicts: string[]
}

export interface PluginHookResult {
  success: boolean
  error?: Error
  duration: number
  plugin: string
  hook: PluginHook
  context?: unknown
}

export interface PluginMetrics {
  loadTime: number
  setupTime: number
  hookExecutions: Map<PluginHook, number>
  errors: number
  warnings: number
  lastExecution?: Date
}

export interface PluginDiscoveryOptions {
  directories?: string[]
  patterns?: string[]
  includeBuiltIn?: boolean
  includeExternal?: boolean
  includeNpm?: boolean
}

export interface PluginInstallOptions {
  version?: string
  registry?: string
  force?: boolean
  dev?: boolean
  source?: 'npm' | 'git' | 'local'
}

export interface PluginExecutionContext<TConfig = unknown> {
  plugin: Plugin<TConfig>
  hook: PluginHook
  startTime: number
  timeout?: number
  retries?: number
}

export interface PluginValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}
