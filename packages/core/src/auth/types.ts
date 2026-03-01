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

// ===== Authenticated user =====

/**
 * Authenticated user information.
 * Returned by LiveAuthProvider after validation.
 */
export interface LiveAuthUser {
  /** Unique user identifier */
  id: string
  /** Roles assigned to the user (e.g., 'admin', 'moderator') */
  roles?: string[]
  /** Granular permissions (e.g., 'chat.write', 'chat.admin') */
  permissions?: string[]
  /** Additional fields (name, email, etc.) */
  [key: string]: unknown
}

// ===== Auth context =====

/**
 * Auth context available inside LiveComponent via this.$auth.
 * Provides type-safe helpers for checking roles and permissions.
 */
export interface LiveAuthContext {
  /** Whether the user is authenticated */
  readonly authenticated: boolean
  /** User data (undefined if not authenticated) */
  readonly user?: LiveAuthUser
  /** Original token used for authentication */
  readonly token?: string
  /** Timestamp of when authentication occurred */
  readonly authenticatedAt?: number

  /** Check if user has a specific role */
  hasRole(role: string): boolean
  /** Check if user has ANY of the roles */
  hasAnyRole(roles: string[]): boolean
  /** Check if user has ALL roles */
  hasAllRoles(roles: string[]): boolean
  /** Check if user has a specific permission */
  hasPermission(permission: string): boolean
  /** Check if user has ALL permissions */
  hasAllPermissions(permissions: string[]): boolean
  /** Check if user has ANY of the permissions */
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

// ===== Component auth config =====

/**
 * Declarative auth configuration for a LiveComponent.
 * Defined as a static property on the class.
 */
export interface LiveComponentAuth {
  /** Whether authentication is required to mount the component. Default: false */
  required?: boolean
  /** Required roles (OR logic - any role suffices) */
  roles?: string[]
  /** Required permissions (AND logic - all must be present) */
  permissions?: string[]
}

/**
 * Per-action auth configuration.
 */
export interface LiveActionAuth {
  /** Required roles for this action (OR logic) */
  roles?: string[]
  /** Required permissions for this action (AND logic) */
  permissions?: string[]
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
