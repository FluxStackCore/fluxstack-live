/**
 * Plugin manager.
 *
 * Orchestrates the full plugin lifecycle: discovery, registration,
 * context setup, hook dispatch, metrics, and shutdown.
 *
 * The manager is generic over `TConfig` — the host app's config shape.
 * Plugins registered via this manager receive a `PluginContext<TConfig>`
 * with the concrete config instance.
 *
 * Key dependencies injected via the constructor:
 * - `logger`       — structural Logger interface
 * - `config`       — the host app's full config (passed through to plugin contexts)
 * - `settings`     — the plugin-related slice of config (enabled/disabled/etc.)
 * - `clientHooks`  — implementation of `PluginClientHooksAPI` (the registry
 *                     lives in the host app because it knows how to serve JS
 *                     to the browser; the manager just holds the reference)
 * - `app`          — optional host-app handle (e.g. Elysia app instance)
 */

import type {
  FluxStack,
  PluginHook,
  PluginHookResult,
  PluginLoadResult,
  PluginMetrics,
  PluginExecutionContext,
  HookExecutionOptions,
  RequestContext,
  ResponseContext,
  ErrorContext,
  BuildContext,
  PluginContext,
  PluginClientHooksAPI,
} from '../types'
import type { Logger } from '../types/logger'
import { PluginRegistry, type PluginRegistrySettings } from './registry'
import { createPluginUtils } from './utils'
import { PluginError } from './errors'
import { EventEmitter } from 'events'

// See registry.ts for why this uses `any` instead of `unknown`. The
// manager is generic over TConfig (PluginManager<TConfig>) and flows
// the host-app config through to PluginContext<TConfig>, but the
// internal Plugin type alias here is intentionally erased so a
// consumer can pass Plugin<HostConfig> to registerPlugin() without
// variance errors.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Plugin = FluxStack.Plugin<any>

/**
 * Helper: safely parse `request.url` which might be relative or absolute.
 */
function parseRequestURL(request: Request): URL {
  try {
    return new URL(request.url)
  } catch {
    const host = request.headers.get('host') || 'localhost'
    const protocol = request.headers.get('x-forwarded-proto') || 'http'
    return new URL(request.url, `${protocol}://${host}`)
  }
}

export interface PluginManagerConfig<TConfig = unknown> {
  /** The host app's full config — passed through to every plugin context */
  config: TConfig
  /** Plugin-related settings slice (enabled/disabled/discovery/whitelist) */
  settings: PluginRegistrySettings
  /** Structural Logger */
  logger: Logger
  /** Client-side hook registry (implementation lives in the host app) */
  clientHooks: PluginClientHooksAPI
  /** Optional host-app handle, typically the web framework instance */
  app?: unknown
}

export class PluginManager<TConfig = unknown> extends EventEmitter {
  private registry: PluginRegistry
  private config: TConfig
  private settings: PluginRegistrySettings
  private logger: Logger
  private clientHooks: PluginClientHooksAPI
  private app?: unknown
  private metrics: Map<string, PluginMetrics> = new Map()
  private contexts: Map<string, PluginContext<TConfig>> = new Map()
  private initialized = false

  constructor(options: PluginManagerConfig<TConfig>) {
    super()
    this.config = options.config
    this.settings = options.settings
    this.logger = options.logger
    this.clientHooks = options.clientHooks
    this.app = options.app

    this.registry = new PluginRegistry({
      logger: this.logger,
      settings: this.settings,
    })
  }

  /**
   * Initialize the plugin manager.
   *
   * Discovers plugins, sets up their contexts, and runs the `setup` hook.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    this.logger.debug('Initializing plugin manager')

    try {
      this.logger.debug('Starting plugin discovery...')
      await this.discoverPlugins()
      this.logger.debug('Plugin discovery completed')

      this.logger.debug('Setting up plugin contexts...')
      this.setupPluginContexts()
      this.logger.debug('Plugin contexts setup completed')

      this.logger.debug('Executing setup hooks...')
      await this.executeHook('setup')
      this.logger.debug('Setup hooks execution completed')

      this.initialized = true
      const stats = this.registry.getStats()
      this.logger.debug('Plugin manager initialized successfully', {
        totalPlugins: stats.totalPlugins,
        enabledPlugins: stats.enabledPlugins,
        loadOrder: stats.loadOrder,
      })
    } catch (error) {
      this.logger.error('Failed to initialize plugin manager', {
        error:
          error instanceof Error
            ? {
                message: error.message,
                stack: error.stack,
                name: error.name,
              }
            : error,
      })
      throw error
    }
  }

  /**
   * Shutdown the plugin manager.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) {
      return
    }

    this.logger.info('Shutting down plugin manager')

    try {
      await this.executeHook('onServerStop')
      this.initialized = false
      this.logger.info('Plugin manager shut down successfully')
    } catch (error) {
      this.logger.error('Error during plugin manager shutdown', { error })
    }
  }

  getRegistry(): PluginRegistry {
    return this.registry
  }

  async registerPlugin(plugin: Plugin): Promise<void> {
    await this.registry.register(plugin)
    this.setupPluginContext(plugin)

    if (this.initialized && plugin.setup) {
      await this.executePluginHook(plugin, 'setup')
    }
  }

  unregisterPlugin(name: string): void {
    this.registry.unregister(name)
    this.contexts.delete(name)
    this.metrics.delete(name)
  }

  /**
   * Execute a hook on all enabled plugins.
   */
  async executeHook(
    hook: PluginHook,
    context?: unknown,
    options: HookExecutionOptions = {},
  ): Promise<PluginHookResult[]> {
    const { timeout = 30000, parallel = false, stopOnError = false, retries = 0 } = options

    const results: PluginHookResult[] = []
    const loadOrder = this.registry.getLoadOrder()
    const enabledPlugins = this.getEnabledPlugins()
    const enabledSet = new Set(enabledPlugins.map(p => p.name))

    this.logger.debug(`Executing hook '${hook}' on ${enabledPlugins.length} plugins`, {
      hook,
      plugins: enabledPlugins.map(p => p.name),
      parallel,
      timeout,
    })

    const executePlugin = async (plugin: Plugin): Promise<PluginHookResult> => {
      if (!enabledSet.has(plugin.name)) {
        return {
          success: true,
          duration: 0,
          plugin: plugin.name,
          hook,
        }
      }

      return this.executePluginHook(plugin, hook, context, { timeout, retries })
    }

    try {
      if (parallel) {
        const promises = loadOrder
          .map(name => this.registry.get(name))
          .filter(Boolean)
          .map(plugin => executePlugin(plugin!))

        const settled = await Promise.allSettled(promises)

        for (const result of settled) {
          if (result.status === 'fulfilled') {
            results.push(result.value)
          } else {
            results.push({
              success: false,
              error: result.reason,
              duration: 0,
              plugin: 'unknown',
              hook,
            })
          }
        }
      } else {
        for (const pluginName of loadOrder) {
          const plugin = this.registry.get(pluginName)
          if (!plugin) continue

          const result = await executePlugin(plugin)
          results.push(result)

          if (!result.success && stopOnError) {
            this.logger.error(
              `Hook execution stopped due to error in plugin '${plugin.name}'`,
              {
                hook,
                plugin: plugin.name,
                error: result.error,
              },
            )
            break
          }
        }
      }

      this.emit('hook:after', { hook, results, context })

      return results
    } catch (error) {
      this.logger.error(`Hook '${hook}' execution failed`, { error })
      this.emit('hook:error', { hook, error, context })
      throw error
    }
  }

  /**
   * Execute a specific hook on a specific plugin, with timeout + retry.
   */
  async executePluginHook(
    plugin: Plugin,
    hook: PluginHook,
    context?: unknown,
    options: { timeout?: number; retries?: number } = {},
  ): Promise<PluginHookResult> {
    const { timeout = 30000, retries = 0 } = options
    const startTime = Date.now()

    const hookFunction = (plugin as Record<string, unknown>)[hook]
    if (!hookFunction || typeof hookFunction !== 'function') {
      return {
        success: true,
        duration: 0,
        plugin: plugin.name,
        hook,
      }
    }

    this.emit('hook:before', { plugin: plugin.name, hook, context })

    let attempt = 0
    let lastError: Error | undefined

    while (attempt <= retries) {
      try {
        const pluginContext = this.getPluginContext(plugin.name)
        const executionContext: PluginExecutionContext<TConfig> = {
          plugin,
          hook,
          startTime: Date.now(),
          timeout,
          retries,
        }

        let timeoutId: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new PluginError(
                `Plugin '${plugin.name}' hook '${hook}' timed out after ${timeout}ms`,
                'PLUGIN_TIMEOUT',
                408,
              ),
            )
          }, timeout)
        })

        let hookPromise: Promise<unknown>

        switch (hook) {
          case 'setup':
          case 'onServerStart':
          case 'onServerStop':
            hookPromise = Promise.resolve((hookFunction as Function)(pluginContext))
            break
          case 'onRequest':
          case 'onResponse':
          case 'onError':
            hookPromise = Promise.resolve((hookFunction as Function)(context))
            break
          case 'onBuild':
          case 'onBuildComplete':
            hookPromise = Promise.resolve((hookFunction as Function)(context))
            break
          default:
            hookPromise = Promise.resolve((hookFunction as Function)(context || pluginContext))
        }

        try {
          await Promise.race([hookPromise, timeoutPromise])
        } finally {
          clearTimeout(timeoutId)
        }

        const duration = Date.now() - startTime

        this.updatePluginMetrics(plugin.name, hook, duration, true)

        this.logger.debug(`Plugin '${plugin.name}' hook '${hook}' completed successfully`, {
          plugin: plugin.name,
          hook,
          duration,
          attempt: attempt + 1,
        })

        return {
          success: true,
          duration,
          plugin: plugin.name,
          hook,
          context: executionContext,
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        attempt++

        this.logger.warn(
          `Plugin '${plugin.name}' hook '${hook}' failed (attempt ${attempt}/${retries + 1})`,
          {
            plugin: plugin.name,
            hook,
            error: lastError.message,
            attempt,
          },
        )

        if (attempt <= retries) {
          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt - 1) * 1000))
        }
      }
    }

    const duration = Date.now() - startTime

    this.updatePluginMetrics(plugin.name, hook, duration, false)

    this.emit('plugin:error', { plugin: plugin.name, hook, error: lastError })

    // Build result without undefined `error` key to respect
    // exactOptionalPropertyTypes: true on PluginHookResult.error
    return {
      success: false,
      ...(lastError ? { error: lastError } : {}),
      duration,
      plugin: plugin.name,
      hook,
    }
  }

  getPluginMetrics(pluginName?: string): PluginMetrics | Map<string, PluginMetrics> {
    if (pluginName) {
      return (
        this.metrics.get(pluginName) || {
          loadTime: 0,
          setupTime: 0,
          hookExecutions: new Map(),
          errors: 0,
          warnings: 0,
        }
      )
    }
    return this.metrics
  }

  private getEnabledPlugins(): Plugin[] {
    const allPlugins = this.registry.getAll()
    const enabledNames = this.settings.enabled ?? []
    const disabledNames = this.settings.disabled ?? []

    return allPlugins.filter(plugin => {
      if (disabledNames.includes(plugin.name)) {
        return false
      }

      if (enabledNames.length === 0) {
        return true
      }

      return enabledNames.includes(plugin.name)
    })
  }

  private async discoverPlugins(): Promise<void> {
    try {
      const results: PluginLoadResult[] = []

      // Project plugins (plugins/ directory)
      this.logger.debug('Discovering project plugins in directory: plugins')
      const projectResults = await this.registry.discoverPlugins({
        directories: ['plugins'],
        includeBuiltIn: false,
        includeExternal: true,
      })
      results.push(...projectResults)

      // NPM plugins
      if (this.settings.discoverNpmPlugins) {
        this.logger.debug('Discovering npm plugins in node_modules...')
        const npmResults = await this.registry.discoverNpmPlugins()
        results.push(...npmResults)
      } else {
        this.logger.debug('🔒 NPM plugin discovery disabled for security')
      }

      let loaded = 0
      let failed = 0

      for (const result of results) {
        if (result.success) {
          loaded++
          if (result.warnings && result.warnings.length > 0) {
            this.logger.warn(`Plugin '${result.plugin?.name}' loaded with warnings`, {
              warnings: result.warnings,
            })
          }
        } else {
          failed++
          this.logger.error(`Failed to load plugin: ${result.error}`)
        }
      }

      this.logger.debug('Plugin discovery completed', { loaded, failed })
    } catch (error) {
      this.logger.error('Plugin discovery failed', { error })
      throw error
    }
  }

  private setupPluginContexts(): void {
    const plugins = this.registry.getAll()

    for (const plugin of plugins) {
      this.setupPluginContext(plugin)
    }
  }

  private setupPluginContext(plugin: Plugin): void {
    const context: PluginContext<TConfig> = {
      config: this.config,
      logger: this.logger.child ? this.logger.child({ plugin: plugin.name }) : this.logger,
      app: this.app,
      utils: createPluginUtils(this.logger),
      registry: this.registry,
      clientHooks: this.clientHooks,
    }

    this.contexts.set(plugin.name, context)

    this.metrics.set(plugin.name, {
      loadTime: 0,
      setupTime: 0,
      hookExecutions: new Map(),
      errors: 0,
      warnings: 0,
    })
  }

  private getPluginContext(pluginName: string): PluginContext<TConfig> {
    const context = this.contexts.get(pluginName)
    if (!context) {
      throw new PluginError(
        `Plugin context not found for '${pluginName}'`,
        'PLUGIN_CONTEXT_NOT_FOUND',
        500,
      )
    }
    return context
  }

  private updatePluginMetrics(
    pluginName: string,
    hook: PluginHook,
    duration: number,
    success: boolean,
  ): void {
    const metrics = this.metrics.get(pluginName)
    if (!metrics) return

    const currentCount = metrics.hookExecutions.get(hook) || 0
    metrics.hookExecutions.set(hook, currentCount + 1)

    if (success) {
      if (hook === 'setup') {
        metrics.setupTime = duration
      }
    } else {
      metrics.errors++
    }

    metrics.lastExecution = new Date()
  }
}

// ─── Context factory helpers ────────────────────────────────

/**
 * Create a RequestContext from an HTTP Request.
 */
export function createRequestContext(
  request: Request,
  additionalData: Record<string, unknown> = {},
): RequestContext {
  const url = parseRequestURL(request)

  return {
    request,
    path: url.pathname,
    method: request.method,
    headers: (() => {
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => {
        headers[key] = value
      })
      return headers
    })(),
    query: Object.fromEntries(url.searchParams.entries()),
    params: {},
    startTime: Date.now(),
    ...additionalData,
  }
}

/**
 * Create a ResponseContext from a RequestContext + Response.
 */
export function createResponseContext(
  requestContext: RequestContext,
  response: Response,
  additionalData: Record<string, unknown> = {},
): ResponseContext {
  return {
    ...requestContext,
    response,
    statusCode: response.status,
    duration: Date.now() - requestContext.startTime,
    size: parseInt(response.headers.get('content-length') || '0'),
    ...additionalData,
  }
}

/**
 * Create an ErrorContext from a RequestContext + Error.
 */
export function createErrorContext(
  requestContext: RequestContext,
  error: Error,
  additionalData: Record<string, unknown> = {},
): ErrorContext {
  return {
    ...requestContext,
    error,
    duration: Date.now() - requestContext.startTime,
    handled: false,
    ...additionalData,
  }
}

/**
 * Create a BuildContext. Generic over `TConfig` so the host app's
 * concrete config flows through to build hooks.
 */
export function createBuildContext<TConfig = unknown>(
  target: string,
  outDir: string,
  mode: 'development' | 'production',
  config: TConfig,
): BuildContext<TConfig> {
  return {
    target,
    outDir,
    mode,
    config,
  }
}
