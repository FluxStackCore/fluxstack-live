/**
 * Plugin dependency manager.
 *
 * Reads a plugin's `package.json`, registers its declared dependencies,
 * detects version conflicts against other plugins, and (optionally)
 * auto-installs them into the plugin's local `node_modules/` via the
 * configured package manager.
 *
 * The "install locally first" strategy is deliberate: it isolates each
 * plugin's deps so a version conflict in one plugin doesn't break
 * another. The module resolver then cascades local → project root when
 * loading modules at runtime.
 */

import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { execSync } from 'child_process'

import type { Logger } from '../types/logger'

export interface PluginDependency {
  name: string
  version: string
  type: 'dependency' | 'devDependency' | 'peerDependency'
  optional?: boolean
}

export interface DependencyResolution {
  plugin: string
  dependencies: PluginDependency[]
  conflicts: DependencyConflict[]
  resolved: boolean
}

export interface DependencyConflict {
  package: string
  versions: Array<{
    plugin: string
    version: string
  }>
  resolution?: string
}

export interface DependencyManagerConfig {
  logger?: Logger
  autoInstall?: boolean
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun'
  workspaceRoot?: string
}

export class PluginDependencyManager {
  private logger: Logger | undefined
  private config: DependencyManagerConfig
  private installedDependencies: Map<string, string> = new Map()
  private pluginDependencies: Map<string, PluginDependency[]> = new Map()

  constructor(config: DependencyManagerConfig = {}) {
    this.config = {
      autoInstall: true,
      packageManager: 'bun',
      workspaceRoot: process.cwd(),
      ...config,
    }
    this.logger = config.logger

    this.loadInstalledDependencies()
  }

  /**
   * Register a plugin's declared dependencies.
   */
  registerPluginDependencies(pluginName: string, dependencies: PluginDependency[]): void {
    this.pluginDependencies.set(pluginName, dependencies)
    this.logger?.debug(`Dependencies registered for plugin '${pluginName}'`, {
      plugin: pluginName,
      dependencies: dependencies.length,
    })
  }

  /**
   * Resolve a plugin's dependencies from its `package.json`.
   */
  async resolvePluginDependencies(pluginPath: string): Promise<DependencyResolution> {
    const pluginName = this.getPluginNameFromPath(pluginPath)
    const packageJsonPath = join(pluginPath, 'package.json')

    if (!existsSync(packageJsonPath)) {
      return {
        plugin: pluginName,
        dependencies: [],
        conflicts: [],
        resolved: true,
      }
    }

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
      const dependencies: PluginDependency[] = []

      if (packageJson.dependencies) {
        for (const [name, version] of Object.entries(packageJson.dependencies)) {
          dependencies.push({
            name,
            version: version as string,
            type: 'dependency',
          })
        }
      }

      if (packageJson.peerDependencies) {
        for (const [name, version] of Object.entries(packageJson.peerDependencies)) {
          const isOptional = packageJson.peerDependenciesMeta?.[name]?.optional || false
          dependencies.push({
            name,
            version: version as string,
            type: 'peerDependency',
            optional: isOptional,
          })
        }
      }

      this.registerPluginDependencies(pluginName, dependencies)

      const conflicts = this.detectConflicts(pluginName, dependencies)

      return {
        plugin: pluginName,
        dependencies,
        conflicts,
        resolved: conflicts.length === 0,
      }
    } catch (error) {
      this.logger?.error(`Error resolving dependencies for plugin '${pluginName}'`, { error })
      return {
        plugin: pluginName,
        dependencies: [],
        conflicts: [],
        resolved: false,
      }
    }
  }

  /**
   * Install dependencies for a set of plugin resolutions.
   *
   * Strategy: installs into each plugin's own `node_modules/` first. The
   * module resolver handles falling back to the project root at import time.
   */
  async installPluginDependencies(resolutions: DependencyResolution[]): Promise<void> {
    if (!this.config.autoInstall) {
      this.logger?.debug('Auto-install disabled, skipping dependency installation')
      return
    }

    for (const resolution of resolutions) {
      if (resolution.dependencies.length === 0) continue

      const pluginPath = this.findPluginDirectory(resolution.plugin)
      if (!pluginPath) {
        this.logger?.warn(`Could not find directory for plugin '${resolution.plugin}'`)
        continue
      }

      this.logger?.debug(`📦 Installing dependencies locally for plugin '${resolution.plugin}'`, {
        plugin: resolution.plugin,
        path: pluginPath,
        dependencies: resolution.dependencies.length,
      })

      try {
        await this.installPluginDependenciesLocally(pluginPath, resolution.dependencies)
        this.logger?.debug(`✅ Dependencies for plugin '${resolution.plugin}' installed locally`)
      } catch (error) {
        this.logger?.error(
          `❌ Error installing dependencies for plugin '${resolution.plugin}'`,
          { error },
        )
        // Continue with other plugins
      }
    }
  }

  /**
   * Install dependencies into a plugin's local `node_modules/`.
   */
  async installPluginDependenciesLocally(
    pluginPath: string,
    dependencies: PluginDependency[],
  ): Promise<void> {
    if (dependencies.length === 0) return

    const regularDeps = dependencies.filter(d => d.type === 'dependency')
    const peerDeps = dependencies.filter(d => d.type === 'peerDependency' && !d.optional)

    const allDeps = [...regularDeps, ...peerDeps]
    if (allDeps.length === 0) return

    const toInstall = allDeps.filter(dep => {
      const depPath = join(pluginPath, 'node_modules', dep.name, 'package.json')
      if (!existsSync(depPath)) {
        return true
      }

      try {
        const installedPkg = JSON.parse(readFileSync(depPath, 'utf-8'))
        const installedVersion = installedPkg.version

        if (!this.isVersionCompatible(installedVersion, dep.version)) {
          this.logger?.debug(
            `📦 Dependency '${dep.name}' is outdated (${installedVersion} → ${dep.version})`,
          )
          return true
        }

        return false
      } catch {
        return true
      }
    })

    if (toInstall.length === 0) {
      this.logger?.debug('✅ All plugin dependencies are already installed')
      return
    }

    const packages = toInstall.map(d => `${d.name}@${d.version}`).join(' ')
    const command = this.getInstallCommand(packages, false)

    this.logger?.debug(`🔧 Installing ${toInstall.length} dependencies: ${command}`, {
      cwd: pluginPath,
    })

    try {
      execSync(command, {
        cwd: pluginPath,
        stdio: 'inherit',
      })
      this.logger?.debug(`✅ Packages installed locally in ${pluginPath}`)
    } catch (error) {
      this.logger?.error('❌ Failed to install dependencies locally', { error, pluginPath })
      throw error
    }
  }

  /**
   * Install dependencies directly into a specific path.
   */
  async installDependenciesInPath(
    pluginPath: string,
    dependencies: Record<string, string>,
  ): Promise<void> {
    if (!this.config.autoInstall) {
      this.logger?.debug('Auto-install disabled')
      return
    }

    if (Object.keys(dependencies).length === 0) {
      return
    }

    const pluginDeps: PluginDependency[] = Object.entries(dependencies).map(([name, version]) => ({
      name,
      version,
      type: 'dependency',
    }))

    this.logger?.debug(`📦 Installing ${pluginDeps.length} dependencies in ${pluginPath}`)

    try {
      await this.installPluginDependenciesLocally(pluginPath, pluginDeps)
      this.logger?.debug(`✅ Dependencies installed successfully in ${pluginPath}`)
    } catch (error) {
      this.logger?.error(`❌ Error installing dependencies in ${pluginPath}`, { error })
      throw error
    }
  }

  private findPluginDirectory(pluginName: string): string | null {
    const possiblePaths = [`plugins/${pluginName}`, `core/plugins/built-in/${pluginName}`]

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        return resolve(path)
      }
    }

    return null
  }

  private detectConflicts(pluginName: string, dependencies: PluginDependency[]): DependencyConflict[] {
    const conflicts: DependencyConflict[] = []

    for (const dep of dependencies) {
      const existingVersions: Array<{ plugin: string; version: string }> = []

      for (const [otherPlugin, otherDeps] of this.pluginDependencies.entries()) {
        if (otherPlugin === pluginName) continue

        const conflictingDep = otherDeps.find(d => d.name === dep.name)
        if (conflictingDep && !this.isVersionCompatible(conflictingDep.version, dep.version)) {
          existingVersions.push({
            plugin: otherPlugin,
            version: conflictingDep.version,
          })
        }
      }

      if (existingVersions.length > 0) {
        existingVersions.push({
          plugin: pluginName,
          version: dep.version,
        })

        conflicts.push({
          package: dep.name,
          versions: existingVersions,
        })
      }
    }

    return conflicts
  }

  /**
   * Resolve version conflicts. Simple strategy: pick the highest version.
   * Kept for API symmetry with the old code — not currently wired into
   * installPluginDependencies but may be re-enabled by callers.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-private-class-members
  private async resolveConflicts(conflicts: DependencyConflict[]): Promise<void> {
    this.logger?.warn(`Detected ${conflicts.length} dependency conflicts`, {
      conflicts: conflicts.map(c => ({
        package: c.package,
        versions: c.versions.length,
      })),
    })

    for (const conflict of conflicts) {
      const sortedVersions = conflict.versions.sort((a, b) => {
        return this.compareVersions(b.version, a.version)
      })

      const resolution = sortedVersions[0].version
      conflict.resolution = resolution

      this.logger?.debug(
        `Conflict resolved for '${conflict.package}': using version ${resolution}`,
        {
          package: conflict.package,
          resolution,
          conflictingVersions: conflict.versions,
        },
      )
    }
  }

  private getInstallCommand(packages: string, dev: boolean): string {
    const devFlag = dev ? '--save-dev' : ''

    switch (this.config.packageManager) {
      case 'npm':
        return `npm install ${devFlag} ${packages}`
      case 'yarn':
        return `yarn add ${dev ? '--dev' : ''} ${packages}`
      case 'pnpm':
        return `pnpm add ${devFlag} ${packages}`
      case 'bun':
        return `bun add ${devFlag} ${packages}`
      default:
        return `npm install ${devFlag} ${packages}`
    }
  }

  private loadInstalledDependencies(): void {
    const packageJsonPath = join(this.config.workspaceRoot!, 'package.json')

    if (!existsSync(packageJsonPath)) {
      return
    }

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))

      if (packageJson.dependencies) {
        for (const [name, version] of Object.entries(packageJson.dependencies)) {
          this.installedDependencies.set(name, version as string)
        }
      }

      if (packageJson.devDependencies) {
        for (const [name, version] of Object.entries(packageJson.devDependencies)) {
          this.installedDependencies.set(name, version as string)
        }
      }
    } catch (error) {
      this.logger?.warn('Error loading main package.json', { error })
    }
  }

  private isVersionCompatible(installed: string, required: string): boolean {
    // Simple implementation — production should use semver
    if (required.startsWith('^') || required.startsWith('~')) {
      const requiredVersion = required.slice(1)
      return this.compareVersions(installed, requiredVersion) >= 0
    }

    return installed === required
  }

  private compareVersions(a: string, b: string): number {
    const aParts = a.replace(/[^\d.]/g, '').split('.').map(Number)
    const bParts = b.replace(/[^\d.]/g, '').split('.').map(Number)

    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aPart = aParts[i] || 0
      const bPart = bParts[i] || 0

      if (aPart > bPart) return 1
      if (aPart < bPart) return -1
    }

    return 0
  }

  private getPluginNameFromPath(pluginPath: string): string {
    return pluginPath.split('/').pop() || 'unknown'
  }

  getStats() {
    return {
      totalPlugins: this.pluginDependencies.size,
      totalDependencies: Array.from(this.pluginDependencies.values()).reduce(
        (sum, deps) => sum + deps.length,
        0,
      ),
      installedDependencies: this.installedDependencies.size,
      packageManager: this.config.packageManager,
    }
  }
}
