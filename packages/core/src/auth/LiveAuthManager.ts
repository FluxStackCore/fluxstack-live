// @fluxstack/live - Auth Manager
//
// Manages auth providers and executes auth checks.

import type {
  LiveAuthProvider,
  LiveAuthCredentials,
  LiveAuthContext,
  LiveComponentAuth,
  LiveActionAuth,
  LiveAuthResult,
} from './types'
import { ANONYMOUS_CONTEXT } from './LiveAuthContext'

export class LiveAuthManager {
  private providers = new Map<string, LiveAuthProvider>()
  private defaultProviderName?: string

  /**
   * Register an auth provider.
   */
  register(provider: LiveAuthProvider): void {
    this.providers.set(provider.name, provider)

    if (!this.defaultProviderName) {
      this.defaultProviderName = provider.name
    }

    console.log(`[Auth] Provider registered: ${provider.name}`)
  }

  /**
   * Remove an auth provider.
   */
  unregister(name: string): void {
    this.providers.delete(name)
    if (this.defaultProviderName === name) {
      this.defaultProviderName = this.providers.keys().next().value
    }
  }

  /**
   * Set the default auth provider.
   */
  setDefault(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Auth provider '${name}' not registered`)
    }
    this.defaultProviderName = name
  }

  /**
   * Returns true if at least one provider is registered.
   */
  hasProviders(): boolean {
    return this.providers.size > 0
  }

  /**
   * Returns the default provider or undefined.
   */
  getDefaultProvider(): LiveAuthProvider | undefined {
    if (!this.defaultProviderName) return undefined
    return this.providers.get(this.defaultProviderName)
  }

  /**
   * Authenticate credentials using the specified provider, or try all providers.
   * Returns ANONYMOUS_CONTEXT if no credentials or no providers.
   */
  async authenticate(
    credentials: LiveAuthCredentials,
    providerName?: string
  ): Promise<LiveAuthContext> {
    if (!credentials || Object.keys(credentials).every(k => !credentials[k])) {
      return ANONYMOUS_CONTEXT
    }

    if (this.providers.size === 0) {
      return ANONYMOUS_CONTEXT
    }

    if (providerName) {
      const provider = this.providers.get(providerName)
      if (!provider) {
        console.warn(`[Auth] Provider '${providerName}' not found`)
        return ANONYMOUS_CONTEXT
      }
      try {
        const context = await provider.authenticate(credentials)
        return context || ANONYMOUS_CONTEXT
      } catch (error: any) {
        console.error(`[Auth] Failed via '${providerName}':`, error.message)
        return ANONYMOUS_CONTEXT
      }
    }

    // Try all providers (default first)
    const providersToTry: LiveAuthProvider[] = []

    if (this.defaultProviderName) {
      const defaultProvider = this.providers.get(this.defaultProviderName)
      if (defaultProvider) providersToTry.push(defaultProvider)
    }

    for (const [name, provider] of this.providers) {
      if (name !== this.defaultProviderName) {
        providersToTry.push(provider)
      }
    }

    for (const provider of providersToTry) {
      try {
        const context = await provider.authenticate(credentials)
        if (context && context.authenticated) {
          return context
        }
      } catch {
        // Silently continue to next provider
      }
    }

    return ANONYMOUS_CONTEXT
  }

  /**
   * Verify auth context meets component requirements.
   */
  authorizeComponent(
    authContext: LiveAuthContext,
    authConfig: LiveComponentAuth | undefined
  ): LiveAuthResult {
    if (!authConfig) {
      return { allowed: true }
    }

    if (authConfig.required && !authContext.authenticated) {
      return { allowed: false, reason: 'Authentication required' }
    }

    if (authConfig.roles?.length) {
      if (!authContext.authenticated) {
        return { allowed: false, reason: `Authentication required. Roles needed: ${authConfig.roles.join(', ')}` }
      }
      if (!authContext.hasAnyRole(authConfig.roles)) {
        return { allowed: false, reason: `Insufficient roles. Required one of: ${authConfig.roles.join(', ')}` }
      }
    }

    if (authConfig.permissions?.length) {
      if (!authContext.authenticated) {
        return { allowed: false, reason: `Authentication required. Permissions needed: ${authConfig.permissions.join(', ')}` }
      }
      if (!authContext.hasAllPermissions(authConfig.permissions)) {
        return { allowed: false, reason: `Insufficient permissions. Required all: ${authConfig.permissions.join(', ')}` }
      }
    }

    return { allowed: true }
  }

  /**
   * Verify auth context allows executing a specific action.
   */
  async authorizeAction(
    authContext: LiveAuthContext,
    componentName: string,
    action: string,
    actionAuth: LiveActionAuth | undefined,
    providerName?: string
  ): Promise<LiveAuthResult> {
    if (!actionAuth) {
      return { allowed: true }
    }

    if (actionAuth.roles?.length) {
      if (!authContext.authenticated) {
        return { allowed: false, reason: `Authentication required for action '${action}'` }
      }
      if (!authContext.hasAnyRole(actionAuth.roles)) {
        return { allowed: false, reason: `Insufficient roles for action '${action}'. Required one of: ${actionAuth.roles.join(', ')}` }
      }
    }

    if (actionAuth.permissions?.length) {
      if (!authContext.authenticated) {
        return { allowed: false, reason: `Authentication required for action '${action}'` }
      }
      if (!authContext.hasAllPermissions(actionAuth.permissions)) {
        return { allowed: false, reason: `Insufficient permissions for action '${action}'. Required all: ${actionAuth.permissions.join(', ')}` }
      }
    }

    const name = providerName || this.defaultProviderName
    if (name) {
      const provider = this.providers.get(name)
      if (provider?.authorizeAction) {
        const allowed = await provider.authorizeAction(authContext, componentName, action)
        if (!allowed) {
          return { allowed: false, reason: `Action '${action}' denied by auth provider '${name}'` }
        }
      }
    }

    return { allowed: true }
  }

  /**
   * Verify auth context allows joining a room.
   */
  async authorizeRoom(
    authContext: LiveAuthContext,
    roomId: string,
    providerName?: string
  ): Promise<LiveAuthResult> {
    const name = providerName || this.defaultProviderName
    if (!name) return { allowed: true }

    const provider = this.providers.get(name)
    if (!provider?.authorizeRoom) return { allowed: true }

    try {
      const allowed = await provider.authorizeRoom(authContext, roomId)
      if (!allowed) {
        return { allowed: false, reason: `Access to room '${roomId}' denied by auth provider '${name}'` }
      }
      return { allowed: true }
    } catch (error: any) {
      return { allowed: false, reason: `Room authorization error: ${error.message}` }
    }
  }

  /**
   * Get info about registered providers.
   */
  getInfo(): { providers: string[]; defaultProvider?: string } {
    return {
      providers: Array.from(this.providers.keys()),
      defaultProvider: this.defaultProviderName,
    }
  }
}
