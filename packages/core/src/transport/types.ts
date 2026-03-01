// @fluxstack/live - Transport Abstraction Layer
//
// These interfaces decouple Live Components from any specific WebSocket framework.
// Each adapter (Elysia, Express, Fastify, etc.) implements LiveTransport.

import type { LiveAuthContext } from '../auth/types'

// ===== Generic WebSocket (replaces FluxStackWebSocket) =====

/**
 * Minimal WebSocket interface that any server framework can implement.
 * Compatible with Bun ServerWebSocket, Elysia WS, `ws` package, etc.
 */
export interface GenericWebSocket {
  /** Send data to the client */
  send(data: string | ArrayBuffer | Uint8Array, compress?: boolean): void | number
  /** Close the connection */
  close(code?: number, reason?: string): void
  /** Connection data storage */
  data: LiveWSData
  /** Remote address of the client */
  readonly remoteAddress: string
  /** WebSocket ready state: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED */
  readonly readyState: 0 | 1 | 2 | 3
}

/**
 * Data stored on each WebSocket connection.
 * Attached to ws.data by the transport adapter on open.
 */
export interface LiveWSData {
  connectionId: string
  components: Map<string, any> // Map<string, LiveComponent>
  subscriptions: Set<string>
  connectedAt: Date
  userId?: string
  /** Auth context for the connection */
  authContext?: LiveAuthContext
}

// ===== Backward Compatibility Aliases =====

/** @deprecated Use GenericWebSocket instead */
export type FluxStackWebSocket = GenericWebSocket

/** @deprecated Use LiveWSData instead */
export type FluxStackWSData = LiveWSData

// ===== Transport Interface =====

/**
 * The transport layer that each server adapter must implement.
 * LiveServer calls these methods to register WS and HTTP handlers.
 */
export interface LiveTransport {
  /** Register the main WebSocket endpoint for Live Components */
  registerWebSocket(config: WebSocketConfig): void | Promise<void>
  /** Register HTTP monitoring/debug routes */
  registerHttpRoutes(routes: HttpRouteDefinition[]): void | Promise<void>
  /** Optional startup hook */
  start?(): void | Promise<void>
  /** Optional shutdown hook */
  shutdown?(): void | Promise<void>
}

/**
 * Configuration for the Live Components WebSocket endpoint.
 * The transport adapter wires these callbacks to its own WS implementation.
 */
export interface WebSocketConfig {
  /** Path for the WebSocket endpoint (e.g., '/api/live/ws') */
  path: string
  /** Called when a new client connects */
  onOpen(ws: GenericWebSocket): void | Promise<void>
  /** Called when a message is received (JSON or binary) */
  onMessage(ws: GenericWebSocket, message: unknown, isBinary: boolean): void | Promise<void>
  /** Called when a client disconnects */
  onClose(ws: GenericWebSocket, code: number, reason: string): void | Promise<void>
  /** Called on WebSocket error */
  onError?(ws: GenericWebSocket, error: Error): void
}

// ===== HTTP Route Abstraction =====

/**
 * Framework-agnostic HTTP route definition.
 * Each transport adapter maps these to its own router.
 */
export interface HttpRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  handler: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>
  metadata?: {
    summary?: string
    description?: string
    tags?: string[]
  }
}

/**
 * Normalized HTTP request object passed to route handlers.
 */
export interface HttpRequest {
  params: Record<string, string>
  query: Record<string, string | undefined>
  body: unknown
  headers: Record<string, string | undefined>
}

/**
 * Normalized HTTP response returned by route handlers.
 */
export interface HttpResponse {
  status?: number
  body: unknown
  headers?: Record<string, string>
}
