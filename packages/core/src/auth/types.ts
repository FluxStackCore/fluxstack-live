// @fluxstack/live - Authentication Types
//
// Declarative auth system for Live Components.
// Allows per-component and per-action auth configuration.

// ===== Credentials sent by the client =====

/**
 * Credentials sent by the client during WebSocket authentication.
 * Extensible to support any auth strategy (JWT, API key, crypto, etc.)
 */
export interface LiveAuthCredentials {
  /** JWT or opaque token */
  token?: string
  /** Public key (for crypto-auth) */
  publicKey?: string
  /** Signature (for crypto-auth) */
  signature?: string
  /** Signature timestamp */
  timestamp?: number
  /** Anti-replay nonce */
  nonce?: string
  /** Additional fields for custom providers */
  [key: string]: unknown
}

// ===== Auth session =====

/**
 * Authenticated session data.
 * Returned by LiveAuthProvider after validation.
 *
 * Shape is generic — the dev defines what goes here (user, bot, service, device, etc.)
 * Only `id` is required. Everything else is up to the provider.
 */
export interface LiveAuthSession {
  /** Unique identifier for the authenticated entity */
  id: string
  /** Roles (e.g., 'admin', 'moderator', 'service') */
  roles?: string[]
  /** Granular permissions (e.g., 'chat.write', 'chat.admin') */
  permissions?: string[]
  /** Additional fields — dev defines freely */
  [key: string]: unknown
}

/** @deprecated Use LiveAuthSession instead */
export type LiveAuthUser = LiveAuthSession

// ===== Auth context =====

/**
 * Auth context available inside LiveComponent via this.$auth.
 * Provides type-safe helpers for checking roles and permissions.
 */
export interface LiveAuthContext {
  /** Whether the connection is authenticated */
  readonly authenticated: boolean
  /** Session data (undefined if not authenticated). Shape defined by your provider. */
  readonly session?: LiveAuthSession
  /** @deprecated Use `session` instead */
  readonly user?: LiveAuthSession
  /** Original token used for authentication */
  readonly token?: string
  /** Timestamp of when authentication occurred */
  readonly authenticatedAt?: number

  /** Check if session has a specific role */
  hasRole(role: string): boolean
  /** Check if session has ANY of the roles */
  hasAnyRole(roles: string[]): boolean
  /** Check if session has ALL roles */
  hasAllRoles(roles: string[]): boolean
  /** Check if session has a specific permission */
  hasPermission(permission: string): boolean
  /** Check if session has ALL permissions */
  hasAllPermissions(permissions: string[]): boolean
  /** Check if session has ANY of the permissions */
  hasAnyPermission(permissions: string[]): boolean
}

// ===== Auth provider =====

/**
 * Interface for authentication strategy implementations.
 * Each provider implements its own validation logic.
 *
 * Examples: JWTAuthProvider, CryptoAuthProvider, SessionAuthProvider
 */
export interface LiveAuthProvider {
  /** Unique provider name (e.g., 'jwt', 'crypto', 'session') */
  readonly name: string

  /**
   * Validate credentials and return auth context.
   * Returns null if credentials are invalid.
   */
  authenticate(credentials: LiveAuthCredentials): Promise<LiveAuthContext | null>

  /**
   * (Optional) Custom per-action authorization.
   * Returns true if the user can execute the action.
   */
  authorizeAction?(
    context: LiveAuthContext,
    componentName: string,
    action: string
  ): Promise<boolean>

  /**
   * (Optional) Custom per-room authorization.
   * Returns true if the user can join the room.
   */
  authorizeRoom?(
    context: LiveAuthContext,
    roomId: string
  ): Promise<boolean>
}

// ===== Auth authorize functions =====

/**
 * Custom authorization function for component mount.
 * Return true/false, or a LiveAuthResult for a custom denial reason.
 */
export type LiveComponentAuthorize = (
  auth: LiveAuthContext,
) => boolean | LiveAuthResult | Promise<boolean | LiveAuthResult>

/**
 * Custom authorization function for a specific action.
 * Receives the auth context and the action payload.
 */
export type LiveActionAuthorize = (
  auth: LiveAuthContext,
  payload: unknown,
) => boolean | LiveAuthResult | Promise<boolean | LiveAuthResult>

// ===== Component auth config =====

/**
 * Declarative auth configuration for a LiveComponent.
 * Defined as a static property on the class.
 *
 * By default, all components are public (no auth required).
 * Use `required: true` to require authentication.
 * Use `authorize` for custom logic (DB checks, feature flags, plans, etc.)
 *
 * Auth rules are composable — create reusable objects and share across components:
 * @example
 * // auth/rules.ts
 * export const adminOnly = { required: true, roles: ['admin'] }
 * export const proOnly = { required: true, authorize: async (auth) => checkPlan(auth.session?.id) }
 *
 * // components/MyComponent.ts
 * static auth = adminOnly
 */
export interface LiveComponentAuth {
  /** Whether authentication is required to mount the component. Default: false */
  required?: boolean
  /** Required roles (OR logic - any role suffices) */
  roles?: string[]
  /** Required permissions (AND logic - all must be present) */
  permissions?: string[]
  /**
   * Custom authorization function. Runs AFTER declarative checks (required, roles, permissions).
   * Return true to allow, false to deny, or a LiveAuthResult for a custom reason.
   */
  authorize?: LiveComponentAuthorize
}

/**
 * Per-action auth configuration.
 *
 * @example
 * static actionAuth = {
 *   deleteUser: { roles: ['admin'], permissions: ['users.delete'] },
 *   editProfile: { authorize: async (auth, payload) => auth.session?.id === payload.userId },
 * }
 */
export interface LiveActionAuth {
  /** Required roles for this action (OR logic) */
  roles?: string[]
  /** Required permissions for this action (AND logic) */
  permissions?: string[]
  /**
   * Custom authorization function. Runs AFTER declarative checks (roles, permissions).
   * Receives the auth context and the action payload.
   */
  authorize?: LiveActionAuthorize
}

/** Map of action name -> auth configuration */
export type LiveActionAuthMap = Record<string, LiveActionAuth>

// ===== Auth result =====

/**
 * Result of an authorization check.
 */
export interface LiveAuthResult {
  /** Whether authorization was successful */
  allowed: boolean
  /** Denial reason (if allowed === false) */
  reason?: string
}
