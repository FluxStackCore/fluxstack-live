/**
 * Plugin module resolver.
 *
 * Resolves a module name (e.g. `@noble/curves`) to an absolute filesystem
 * path using a cascading strategy:
 *
 *   1. The plugin's own `node_modules/` (local, plugin-scoped deps)
 *   2. The host project's `node_modules/` (shared deps)
 *
 * Used by the plugin discovery + loader pipeline so plugins can import
 * packages that aren't necessarily hoisted to the host project root.
 */

import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

import type { Logger } from '../types/logger'

export interface ModuleResolverConfig {
  projectRoot: string
  logger?: Logger
}

export class PluginModuleResolver {
  private config: ModuleResolverConfig
  private logger?: Logger
  private static readonly MAX_CACHE_SIZE = 1000
  private resolveCache: Map<string, string> = new Map()

  constructor(config: ModuleResolverConfig) {
    this.config = config
    this.logger = config.logger
  }

  private cacheSet(key: string, value: string): void {
    if (this.resolveCache.size >= PluginModuleResolver.MAX_CACHE_SIZE) {
      const firstKey = this.resolveCache.keys().next().value
      if (firstKey !== undefined) {
        this.resolveCache.delete(firstKey)
      }
    }
    this.resolveCache.set(key, value)
  }

  /**
   * Resolve a module using the cascading strategy.
   */
  resolveModule(moduleName: string, pluginPath: string): string | null {
    const cacheKey = `${pluginPath}::${moduleName}`

    if (this.resolveCache.has(cacheKey)) {
      return this.resolveCache.get(cacheKey)!
    }

    this.logger?.debug(`Resolving module '${moduleName}' for plugin at '${pluginPath}'`)

    // 1. Try the plugin's local node_modules
    const localPath = this.tryResolveLocal(moduleName, pluginPath)
    if (localPath) {
      this.logger?.debug(`✅ Module '${moduleName}' found locally: ${localPath}`)
      this.cacheSet(cacheKey, localPath)
      return localPath
    }

    // 2. Try the project's node_modules
    const projectPath = this.tryResolveProject(moduleName)
    if (projectPath) {
      this.logger?.debug(`✅ Module '${moduleName}' found in project: ${projectPath}`)
      this.cacheSet(cacheKey, projectPath)
      return projectPath
    }

    this.logger?.warn(`❌ Module '${moduleName}' not found in any context`)
    return null
  }

  private tryResolveLocal(moduleName: string, pluginPath: string): string | null {
    const pluginDir = resolve(pluginPath)
    const localNodeModules = join(pluginDir, 'node_modules', moduleName)

    if (existsSync(localNodeModules)) {
      const packageJsonPath = join(localNodeModules, 'package.json')
      if (existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
          const entry = pkg.module || pkg.main || 'index.js'
          const entryPath = join(localNodeModules, entry)

          if (existsSync(entryPath)) {
            return entryPath
          }
        } catch (error) {
          this.logger?.debug(`Error reading package.json for '${moduleName}'`, { error })
        }
      }

      // Fallback: try index.js/index.ts
      const indexJs = join(localNodeModules, 'index.js')
      const indexTs = join(localNodeModules, 'index.ts')

      if (existsSync(indexJs)) return indexJs
      if (existsSync(indexTs)) return indexTs

      return localNodeModules
    }

    return null
  }

  private tryResolveProject(moduleName: string): string | null {
    const projectNodeModules = join(this.config.projectRoot, 'node_modules', moduleName)

    if (existsSync(projectNodeModules)) {
      const packageJsonPath = join(projectNodeModules, 'package.json')
      if (existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
          const entry = pkg.module || pkg.main || 'index.js'
          const entryPath = join(projectNodeModules, entry)

          if (existsSync(entryPath)) {
            return entryPath
          }
        } catch (error) {
          this.logger?.debug(`Error reading package.json for '${moduleName}'`, { error })
        }
      }

      // Fallback: try index.js/index.ts
      const indexJs = join(projectNodeModules, 'index.js')
      const indexTs = join(projectNodeModules, 'index.ts')

      if (existsSync(indexJs)) return indexJs
      if (existsSync(indexTs)) return indexTs

      return projectNodeModules
    }

    return null
  }

  /**
   * Resolve subpaths like `@noble/curves/ed25519`.
   */
  resolveSubpath(moduleName: string, subpath: string, pluginPath: string): string | null {
    const fullModule = `${moduleName}/${subpath}`
    const cacheKey = `${pluginPath}::${fullModule}`

    if (this.resolveCache.has(cacheKey)) {
      return this.resolveCache.get(cacheKey)!
    }

    this.logger?.debug(`Resolving subpath '${fullModule}' for plugin at '${pluginPath}'`)

    // 1. Plugin's local node_modules
    const pluginDir = resolve(pluginPath)
    const localPath = join(pluginDir, 'node_modules', fullModule)

    if (this.existsWithExtension(localPath)) {
      const resolvedLocal = this.findFileWithExtension(localPath)
      if (resolvedLocal) {
        this.logger?.debug(`✅ Subpath '${fullModule}' found locally: ${resolvedLocal}`)
        this.cacheSet(cacheKey, resolvedLocal)
        return resolvedLocal
      }
    }

    // 2. Project's node_modules
    const projectPath = join(this.config.projectRoot, 'node_modules', fullModule)

    if (this.existsWithExtension(projectPath)) {
      const resolvedProject = this.findFileWithExtension(projectPath)
      if (resolvedProject) {
        this.logger?.debug(`✅ Subpath '${fullModule}' found in project: ${resolvedProject}`)
        this.cacheSet(cacheKey, resolvedProject)
        return resolvedProject
      }
    }

    this.logger?.warn(`❌ Subpath '${fullModule}' not found in any context`)
    return null
  }

  private existsWithExtension(basePath: string): boolean {
    const extensions = ['', '.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '/index.js', '/index.ts']
    return extensions.some(ext => existsSync(basePath + ext))
  }

  private findFileWithExtension(basePath: string): string | null {
    const extensions = ['', '.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '/index.js', '/index.ts']

    for (const ext of extensions) {
      const fullPath = basePath + ext
      if (existsSync(fullPath)) {
        return fullPath
      }
    }

    return null
  }

  clearCache(): void {
    this.resolveCache.clear()
  }

  getStats() {
    return {
      cachedModules: this.resolveCache.size,
      projectRoot: this.config.projectRoot,
    }
  }
}
