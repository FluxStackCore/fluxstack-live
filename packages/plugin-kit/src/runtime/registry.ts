/**
 * Plugin registry.
 *
 * Central store for registered plugins + their manifests. Handles:
 * - Registration (sync and async)
 * - Unregistration with dependent checks
 * - Dependency-aware load order (priority-weighted topological sort)
 * - Plugin discovery from `plugins/` (project) and `node_modules/` (npm)
 * - Whitelist enforcement for npm plugins (supply-chain protection)
 * - Lifecycle hook dispatch (`onPluginRegister` / `onPluginUnregister`)
 *
 * The registry does NOT know about the host app's concrete config shape.
 * It accepts a minimal `PluginRegistrySettings` interface via its options;
 * host apps pass their own config slice that matches this shape.
 */

import type {
  FluxStack,
  PluginManifest,
  PluginLoadResult,
  PluginDiscoveryOptions,
  PluginPriority,
} from '../types'
import type { Logger } from '../types/logger'
import { PluginError } from './errors'
import { PluginDependencyManager } from './dependency-manager'
import { readdir, readFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { existsSync, readFileSync } from 'fs'

type FluxStackPlugin = FluxStack.Plugin

/**
 * Minimal plugin-related settings the registry consumes from the host app.
 *
 * The host app (e.g. FluxStack) typically has a larger config object;
 * this interface describes only the slice the registry needs. Host apps
 * pass `hostConfig.plugins` here when constructing the registry.
 */
export interface PluginRegistrySettings {
  /** Plugins enabled via configuration (names only) */
  enabled?: string[]
  /** Plugins disabled via configuration (names only) */
  disabled?: string[]
  /** Per-plugin config objects, keyed by plugin name */
  config?: Record<string, unknown>
  /** Whitelist of allowed plugin names (enforced for npm plugins only) */
  allowedPlugins?: string[]
  /** Whether to scan `plugins/` directory at startup */
  discoverProjectPlugins?: boolean
  /** Whether to scan `node_modules/` for `fluxstack-plugin-*` packages */
  discoverNpmPlugins?: boolean
}

export interface PluginRegistryConfig {
  logger?: Logger
  /** Plugin-related settings from the host app's config */
  settings?: PluginRegistrySettings
  discoveryOptions?: PluginDiscoveryOptions
}

const PRIORITY_MAP: Record<string, number> = {
  highest: 1000,
  high: 750,
  normal: 500,
  low: 250,
  lowest: 0,
}

function normalizePriority(priority?: number | PluginPriority): number {
  if (typeof priority === 'number') return priority
  if (typeof priority === 'string' && priority in PRIORITY_MAP) return PRIORITY_MAP[priority]
  return 500 // default to normal
}

export class PluginRegistry {
  private plugins: Map<string, FluxStackPlugin> = new Map()
  private manifests: Map<string, PluginManifest> = new Map()
  private loadOrder: string[] = []
  private dependencies: Map<string, string[]> = new Map()
  private conflicts: string[] = []
  private logger: Logger | undefined
  private settings: PluginRegistrySettings | undefined
  private dependencyManager: PluginDependencyManager

  constructor(options: PluginRegistryConfig = {}) {
    this.logger = options.logger
    this.settings = options.settings
    this.dependencyManager = new PluginDependencyManager({
      // Spread guards against exactOptionalPropertyTypes: only include
      // `logger` in the options if we actually have one.
      ...(this.logger ? { logger: this.logger } : {}),
      autoInstall: true,
      packageManager: 'bun',
    })
  }

  /**
   * Register a plugin with the registry.
   */
  async register(plugin: FluxStackPlugin, manifest?: PluginManifest): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new PluginError(
        `Plugin '${plugin.name}' is already registered`,
        'PLUGIN_ALREADY_REGISTERED',
        400,
      )
    }

    this.validatePlugin(plugin)

    this.plugins.set(plugin.name, plugin)

    if (manifest) {
      this.manifests.set(plugin.name, manifest)
    }

    if (plugin.dependencies) {
      this.dependencies.set(plugin.name, plugin.dependencies)
    }

    this.updateLoadOrder()

    this.logger?.debug(`Plugin '${plugin.name}' registered successfully`, {
      plugin: plugin.name,
      version: plugin.version,
      dependencies: plugin.dependencies,
    })

    await this.executePluginRegisterHooks(plugin)
  }

  private async executePluginRegisterHooks(registeredPlugin: FluxStackPlugin): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.onPluginRegister && typeof plugin.onPluginRegister === 'function') {
        try {
          // Build payload without undefined keys (exactOptionalPropertyTypes)
          await plugin.onPluginRegister({
            pluginName: registeredPlugin.name,
            ...(registeredPlugin.version ? { pluginVersion: registeredPlugin.version } : {}),
            timestamp: Date.now(),
            data: { plugin: registeredPlugin },
          })
        } catch (error) {
          this.logger?.error(`Plugin '${plugin.name}' onPluginRegister hook failed`, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  private async executePluginUnregisterHooks(
    unregisteredPluginName: string,
    version?: string,
  ): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.onPluginUnregister && typeof plugin.onPluginUnregister === 'function') {
        try {
          // Build payload without undefined keys (exactOptionalPropertyTypes)
          await plugin.onPluginUnregister({
            pluginName: unregisteredPluginName,
            ...(version ? { pluginVersion: version } : {}),
            timestamp: Date.now(),
          })
        } catch (error) {
          this.logger?.error(`Plugin '${plugin.name}' onPluginUnregister hook failed`, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  /**
   * Unregister a plugin from the registry.
   */
  async unregister(name: string): Promise<void> {
    if (!this.plugins.has(name)) {
      throw new PluginError(`Plugin '${name}' is not registered`, 'PLUGIN_NOT_FOUND', 404)
    }

    const dependents = this.getDependents(name)
    if (dependents.length > 0) {
      throw new PluginError(
        `Cannot unregister plugin '${name}' because it is required by: ${dependents.join(', ')}`,
        'PLUGIN_HAS_DEPENDENTS',
        400,
      )
    }

    const plugin = this.plugins.get(name)
    const version = plugin?.version

    this.plugins.delete(name)
    this.manifests.delete(name)
    this.dependencies.delete(name)
    this.loadOrder = this.loadOrder.filter(pluginName => pluginName !== name)

    this.logger?.debug(`Plugin '${name}' unregistered successfully`)

    await this.executePluginUnregisterHooks(name, version)
  }

  get(name: string): FluxStackPlugin | undefined {
    return this.plugins.get(name)
  }

  getManifest(name: string): PluginManifest | undefined {
    return this.manifests.get(name)
  }

  getAll(): FluxStackPlugin[] {
    return Array.from(this.plugins.values())
  }

  getAllManifests(): PluginManifest[] {
    return Array.from(this.manifests.values())
  }

  getLoadOrder(): string[] {
    return [...this.loadOrder]
  }

  getDependents(pluginName: string): string[] {
    const dependents: string[] = []

    for (const [name, deps] of this.dependencies.entries()) {
      if (deps.includes(pluginName)) {
        dependents.push(name)
      }
    }

    return dependents
  }

  getDependencies(pluginName: string): string[] {
    return this.dependencies.get(pluginName) || []
  }

  has(name: string): boolean {
    return this.plugins.has(name)
  }

  /**
   * Synchronous register (no async lifecycle hooks).
   *
   * Used by the framework to add plugins via `.use()` and during automatic
   * plugin discovery, where the full async `register()` flow (which fires
   * `onPluginRegister` hooks) is not needed — setup hooks run later in start().
   */
  registerSync(plugin: FluxStackPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new PluginError(
        `Plugin '${plugin.name}' is already registered`,
        'PLUGIN_ALREADY_REGISTERED',
        400,
      )
    }

    this.validatePlugin(plugin)
    this.plugins.set(plugin.name, plugin)

    if (plugin.dependencies) {
      this.dependencies.set(plugin.name, plugin.dependencies)
    }

    this.updateLoadOrder()
  }

  /**
   * Refresh the load order.
   *
   * Falls back to insertion order if the topological sort fails
   * (e.g. an unresolvable external dependency listed but not yet registered).
   */
  refreshLoadOrder(): void {
    try {
      this.updateLoadOrder()
    } catch {
      this.loadOrder = Array.from(this.plugins.keys())
    }
  }

  /**
   * Read-only snapshot of the internal plugin map.
   */
  getPluginsMap(): ReadonlyMap<string, FluxStackPlugin> {
    return this.plugins
  }

  /**
   * Returns the list of plugin dependencies NOT present in the host
   * project's `package.json` (dependencies + devDependencies).
   *
   * Public so the host app can warn at startup.
   */
  checkMissingDependencies(pluginDeps: Record<string, string>): string[] {
    try {
      const mainPackageJsonPath = join(process.cwd(), 'package.json')
      if (!existsSync(mainPackageJsonPath)) {
        return Object.keys(pluginDeps)
      }

      const mainPackageJson = JSON.parse(readFileSync(mainPackageJsonPath, 'utf-8'))

      const allDeps = {
        ...mainPackageJson.dependencies,
        ...mainPackageJson.devDependencies,
      }

      return Object.keys(pluginDeps).filter(dep => !allDeps[dep])
    } catch {
      return Object.keys(pluginDeps)
    }
  }

  /**
   * Check if a plugin is allowed to be loaded (whitelist enforcement).
   *
   * Security model:
   * - Project plugins (plugins/) are ALWAYS trusted (developer put them there)
   * - NPM plugins (node_modules/) REQUIRE whitelist (supply chain protection)
   */
  private isPluginAllowed(pluginName: string, source: 'npm' | 'project'): boolean {
    const allowedPlugins = this.settings?.allowedPlugins || []

    // Project plugins are always trusted — developer explicitly added them
    if (source === 'project') {
      if (!this.settings?.discoverProjectPlugins) {
        this.logger?.debug(`Project plugin '${pluginName}' skipped: discovery disabled`)
        return false
      }

      this.logger?.debug(`Project plugin '${pluginName}' allowed (trusted source)`)
      return true
    }

    if (allowedPlugins.length === 0) {
      this.logger?.warn(
        `NPM plugin '${pluginName}' blocked: No plugins in whitelist (allowedPlugins is empty)`,
      )
      return false
    }

    if (!allowedPlugins.includes(pluginName)) {
      this.logger?.warn(
        `NPM plugin '${pluginName}' blocked: Not in whitelist (allowedPlugins)`,
        {
          pluginName,
          allowedPlugins,
        },
      )
      return false
    }

    return true
  }

  getStats() {
    return {
      totalPlugins: this.plugins.size,
      enabledPlugins: this.settings?.enabled?.length ?? 0,
      disabledPlugins: this.settings?.disabled?.length ?? 0,
      conflicts: this.conflicts.length,
      loadOrder: this.loadOrder.length,
    }
  }

  /**
   * Validate all registered plugin dependencies are present.
   */
  validateDependencies(): void {
    this.conflicts = []

    for (const plugin of this.plugins.values()) {
      if (plugin.dependencies) {
        for (const dependency of plugin.dependencies) {
          if (!this.plugins.has(dependency)) {
            const error = `Plugin '${plugin.name}' depends on '${dependency}' which is not registered`
            this.conflicts.push(error)
            this.logger?.error(error, { plugin: plugin.name, dependency })
          }
        }
      }
    }

    if (this.conflicts.length > 0) {
      throw new PluginError(
        `Plugin dependency validation failed: ${this.conflicts.join('; ')}`,
        'PLUGIN_DEPENDENCY_ERROR',
        400,
      )
    }
  }

  /**
   * Discover FluxStack plugins from `node_modules`.
   *
   * Matches packages named:
   * - `fluxstack-plugin-*`
   * - `fplugin-*`
   * - `@fluxstack/plugin-*`
   * - `@fplugin/*`
   * - `@org/fluxstack-plugin-*`
   * - `@org/fplugin-*`
   *
   * Respects `settings.discoverNpmPlugins` and `settings.allowedPlugins`.
   */
  async discoverNpmPlugins(): Promise<PluginLoadResult[]> {
    const results: PluginLoadResult[] = []
    const nodeModulesDir = 'node_modules'

    if (!this.settings?.discoverNpmPlugins) {
      this.logger?.debug('NPM plugin discovery is disabled')
      return results
    }

    if (!existsSync(nodeModulesDir)) {
      this.logger?.debug('node_modules directory not found')
      return results
    }

    try {
      const entries = await readdir(nodeModulesDir, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name.startsWith('@')) {
            const scopeDir = join(nodeModulesDir, entry.name)
            const scopedEntries = await readdir(scopeDir, { withFileTypes: true })

            for (const scopedEntry of scopedEntries) {
              if (scopedEntry.isDirectory()) {
                const packageName = `${entry.name}/${scopedEntry.name}`
                let isFluxStackPlugin = false

                if (entry.name === '@fluxstack' && scopedEntry.name.startsWith('plugin-')) {
                  isFluxStackPlugin = true
                } else if (entry.name === '@fplugin') {
                  isFluxStackPlugin = true
                } else if (scopedEntry.name.startsWith('fluxstack-plugin-')) {
                  isFluxStackPlugin = true
                } else if (scopedEntry.name.startsWith('fplugin-')) {
                  isFluxStackPlugin = true
                }

                if (isFluxStackPlugin) {
                  if (!this.isPluginAllowed(packageName, 'npm')) {
                    this.logger?.debug(`Skipping npm plugin (not in whitelist): ${packageName}`)
                    results.push({
                      success: false,
                      error: `Plugin '${packageName}' is not in the allowed plugins whitelist`,
                    })
                    continue
                  }

                  const pluginPath = join(scopeDir, scopedEntry.name)
                  this.logger?.debug(`Loading whitelisted npm plugin: ${packageName}`)

                  const result = await this.loadPlugin(pluginPath)
                  results.push(result)
                }
              }
            }
          } else if (
            entry.name.startsWith('fluxstack-plugin-') ||
            entry.name.startsWith('fplugin-')
          ) {
            if (!this.isPluginAllowed(entry.name, 'npm')) {
              this.logger?.debug(`Skipping npm plugin (not in whitelist): ${entry.name}`)
              results.push({
                success: false,
                error: `Plugin '${entry.name}' is not in the allowed plugins whitelist`,
              })
              continue
            }

            const pluginPath = join(nodeModulesDir, entry.name)
            this.logger?.debug(`Loading whitelisted npm plugin: ${entry.name}`)

            const result = await this.loadPlugin(pluginPath)
            results.push(result)
          }
        }
      }

      const successful = results.filter(r => r.success).length
      const blocked = results.filter(r => !r.success && r.error?.includes('whitelist')).length
      const failed = results.filter(r => !r.success && !r.error?.includes('whitelist')).length

      if (blocked > 0) {
        this.logger?.warn(
          `🔒 Security: Blocked ${blocked} npm plugin(s) not in whitelist (allowedPlugins)`,
        )
      }

      this.logger?.info(`Discovered ${successful} allowed npm plugin(s)`, {
        total: results.length,
        successful,
        blocked,
        failed,
      })
    } catch (error) {
      this.logger?.error('Failed to discover npm plugins', { error })
    }

    return results
  }

  /**
   * Discover plugins from filesystem.
   *
   * Respects `settings.discoverProjectPlugins`.
   */
  async discoverPlugins(options: PluginDiscoveryOptions = {}): Promise<PluginLoadResult[]> {
    const results: PluginLoadResult[] = []
    const {
      directories = ['plugins'],
      patterns: _patterns = ['**/plugin.{js,ts}', '**/index.{js,ts}'],
    } = options

    if (!this.settings?.discoverProjectPlugins) {
      this.logger?.debug('Project plugin discovery is disabled')
      return results
    }

    for (const directory of directories) {
      this.logger?.debug(`Scanning directory: ${directory}`)
      if (!existsSync(directory)) {
        this.logger?.warn(`Directory does not exist: ${directory}`)
        continue
      }

      try {
        const pluginResults = await this.discoverPluginsInDirectory(directory, _patterns)
        this.logger?.debug(`Found ${pluginResults.length} plugins in ${directory}`)

        for (const pluginResult of pluginResults) {
          if (pluginResult.success && pluginResult.plugin) {
            if (!this.isPluginAllowed(pluginResult.plugin.name, 'project')) {
              results.push({
                success: false,
                error: `Plugin '${pluginResult.plugin.name}' is not in the allowed plugins whitelist`,
              })
              continue
            }
          }

          results.push(pluginResult)
        }
      } catch (error) {
        this.logger?.warn(`Failed to discover plugins in directory '${directory}'`, { error })
        results.push({
          success: false,
          error: `Failed to scan directory: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }

    await this.resolveDependencies(results)

    return results
  }

  /**
   * Load a plugin from a file path.
   */
  async loadPlugin(pluginPath: string): Promise<PluginLoadResult> {
    try {
      const manifestPath = join(pluginPath, 'plugin.json')
      let manifest: PluginManifest | undefined

      if (existsSync(manifestPath)) {
        const manifestContent = await readFile(manifestPath, 'utf-8')
        manifest = JSON.parse(manifestContent)
      } else {
        const packagePath = join(pluginPath, 'package.json')
        if (existsSync(packagePath)) {
          try {
            const packageContent = await readFile(packagePath, 'utf-8')
            const packageJson = JSON.parse(packageContent)

            if (packageJson.fluxstack) {
              manifest = {
                name: packageJson.name,
                version: packageJson.version,
                description: packageJson.description || '',
                author: packageJson.author || '',
                license: packageJson.license || '',
                homepage: packageJson.homepage,
                repository: packageJson.repository,
                keywords: packageJson.keywords || [],
                dependencies: packageJson.dependencies || {},
                peerDependencies: packageJson.peerDependencies,
                fluxstack: packageJson.fluxstack,
              }
            }
          } catch (error) {
            this.logger?.warn(`Failed to parse package.json in '${pluginPath}'`, { error })
          }
        }
      }

      if (manifest && manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
        const isProjectPlugin = pluginPath.includes('plugins' + sep)

        if (isProjectPlugin) {
          this.logger?.debug(
            `Installing dependencies for plugin '${manifest.name}' in ${pluginPath}`,
            { dependencies: Object.keys(manifest.dependencies).length },
          )

          try {
            await this.dependencyManager.installDependenciesInPath(
              pluginPath,
              manifest.dependencies,
            )
          } catch {
            this.logger?.warn(
              `Failed to install dependencies for plugin '${manifest.name}'. ` +
                `You can install manually with: cd ${pluginPath} && bun install`,
            )
          }
        } else {
          this.logger?.warn(
            `Plugin '${manifest.name}' declares dependencies. Install them manually.`,
          )
        }
      }

      const pluginModule = await import(resolve(pluginPath))
      const plugin: FluxStackPlugin = pluginModule.default || pluginModule

      if (!plugin || typeof plugin !== 'object' || !plugin.name) {
        return {
          success: false,
          error: 'Invalid plugin: must export a plugin object with a name property',
        }
      }

      await this.register(plugin, manifest)

      return {
        success: true,
        plugin,
        warnings: manifest ? [] : ['No plugin manifest found'],
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private validatePlugin(plugin: FluxStackPlugin): void {
    if (!plugin.name || typeof plugin.name !== 'string') {
      throw new PluginError(
        'Plugin must have a valid name property',
        'INVALID_PLUGIN_STRUCTURE',
        400,
      )
    }

    if (plugin.version && typeof plugin.version !== 'string') {
      throw new PluginError('Plugin version must be a string', 'INVALID_PLUGIN_STRUCTURE', 400)
    }

    if (plugin.dependencies && !Array.isArray(plugin.dependencies)) {
      throw new PluginError(
        'Plugin dependencies must be an array',
        'INVALID_PLUGIN_STRUCTURE',
        400,
      )
    }

    if (
      plugin.priority !== undefined &&
      typeof plugin.priority !== 'number' &&
      !(typeof plugin.priority === 'string' && plugin.priority in PRIORITY_MAP)
    ) {
      throw new PluginError(
        `Plugin priority must be a number or one of: ${Object.keys(PRIORITY_MAP).join(', ')}`,
        'INVALID_PLUGIN_STRUCTURE',
        400,
      )
    }
  }

  /**
   * Update the load order based on dependencies and priorities.
   *
   * Uses a priority-aware topological sort: at each round, picks all plugins
   * whose dependencies are already placed, then sorts that group by priority
   * (highest first) before appending. This preserves dependency constraints
   * while respecting priority within each dependency level.
   */
  private updateLoadOrder(): void {
    const visiting = new Set<string>()
    const visited = new Set<string>()

    const detectCycles = (pluginName: string) => {
      if (visiting.has(pluginName)) {
        throw new PluginError(
          `Circular dependency detected involving plugin '${pluginName}'`,
          'CIRCULAR_DEPENDENCY',
          400,
        )
      }
      if (visited.has(pluginName)) return

      visiting.add(pluginName)
      const plugin = this.plugins.get(pluginName)
      if (plugin?.dependencies) {
        for (const dep of plugin.dependencies) {
          if (this.plugins.has(dep)) {
            detectCycles(dep)
          }
        }
      }
      visiting.delete(pluginName)
      visited.add(pluginName)
    }

    for (const pluginName of this.plugins.keys()) {
      detectCycles(pluginName)
    }

    // Kahn's algorithm with priority-aware group selection
    const placed = new Set<string>()
    const order: string[] = []
    const remaining = new Set(this.plugins.keys())

    while (remaining.size > 0) {
      const ready: string[] = []
      for (const name of remaining) {
        const plugin = this.plugins.get(name)
        const deps = plugin?.dependencies ?? []
        const allDepsPlaced = deps.every(d => !this.plugins.has(d) || placed.has(d))
        if (allDepsPlaced) {
          ready.push(name)
        }
      }

      if (ready.length === 0) {
        break
      }

      ready.sort((a, b) => {
        const pluginA = this.plugins.get(a)
        const pluginB = this.plugins.get(b)
        return normalizePriority(pluginB?.priority) - normalizePriority(pluginA?.priority)
      })

      for (const name of ready) {
        order.push(name)
        placed.add(name)
        remaining.delete(name)
      }
    }

    this.loadOrder = order
  }

  private async resolveDependencies(results: PluginLoadResult[]): Promise<void> {
    // Dependencies are installed during plugin loading in loadPlugin().
    // This method only checks for dependency conflicts.
    for (const result of results) {
      if (result.success && result.plugin) {
        try {
          const pluginDir = this.findPluginDirectory(result.plugin.name)
          if (pluginDir) {
            const resolution = await this.dependencyManager.resolvePluginDependencies(pluginDir)

            if (!resolution.resolved) {
              this.logger?.warn(`Plugin '${result.plugin.name}' has dependency conflicts`, {
                conflicts: resolution.conflicts.length,
              })
            }
          }
        } catch (error) {
          this.logger?.warn(
            `Failed to check dependencies for plugin '${result.plugin.name}'`,
            { error },
          )
        }
      }
    }
  }

  private findPluginDirectory(pluginName: string): string | null {
    const possiblePaths = [`plugins/${pluginName}`, `core/plugins/built-in/${pluginName}`]

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        return path
      }
    }

    return null
  }

  private async discoverPluginsInDirectory(
    directory: string,
    _patterns: string[],
  ): Promise<PluginLoadResult[]> {
    const results: PluginLoadResult[] = []

    try {
      const entries = await readdir(directory, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const pluginDir = join(directory, entry.name)

          // Skip if it's just an index file in the root of built-in directory
          if (directory === 'core/plugins/built-in' && entry.name === 'index.ts') {
            continue
          }

          const hasPluginFile =
            existsSync(join(pluginDir, 'index.ts')) ||
            existsSync(join(pluginDir, 'index.js')) ||
            existsSync(join(pluginDir, 'plugin.ts')) ||
            existsSync(join(pluginDir, 'plugin.js'))

          if (hasPluginFile) {
            this.logger?.debug(`Loading plugin from: ${pluginDir}`)
            const result = await this.loadPlugin(pluginDir)
            results.push(result)
          }
        }
      }
    } catch (error) {
      this.logger?.error(`Failed to read directory '${directory}'`, { error })
    }

    return results
  }
}
