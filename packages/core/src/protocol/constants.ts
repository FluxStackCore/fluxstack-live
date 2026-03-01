// @fluxstack/live - Protocol Constants

/** Current protocol version */
export const PROTOCOL_VERSION = 1

/** Default WebSocket path */
export const DEFAULT_WS_PATH = '/api/live/ws'

/** Default chunk size for file uploads (64KB) */
export const DEFAULT_CHUNK_SIZE = 64 * 1024

/** Default rate limit: max tokens per connection */
export const DEFAULT_RATE_LIMIT_MAX_TOKENS = 100

/** Default rate limit: tokens refilled per second */
export const DEFAULT_RATE_LIMIT_REFILL_RATE = 50

/** Maximum room state size (10MB) */
export const MAX_ROOM_STATE_SIZE = 10 * 1024 * 1024

/** Maximum room name length */
export const MAX_ROOM_NAME_LENGTH = 64

/** Room name validation regex */
export const ROOM_NAME_REGEX = /^[a-zA-Z0-9_:.-]{1,64}$/
