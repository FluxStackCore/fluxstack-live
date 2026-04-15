const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const ID_LENGTH = 8
const BUFFER_SIZE = 8192 // 1024 IDs per refill

// Pre-computed char code lookup table
const CODES = new Uint8Array(64)
for (let i = 0; i < 64; i++) CODES[i] = ALPHABET.charCodeAt(i)

let buffer = new Uint8Array(BUFFER_SIZE)
let offset = BUFFER_SIZE // start exhausted so first call fills
const tmp = new Uint8Array(ID_LENGTH)

/**
 * Generate a compact, cryptographically random ID.
 * 8 chars × 64-char alphabet = ~48 bits of entropy (281 trillion combinations).
 *
 * ~5x faster than crypto.randomUUID() and 4.5x smaller output.
 */
export function generateId(): string {
  if (offset + ID_LENGTH > BUFFER_SIZE) {
    crypto.getRandomValues(buffer)
    offset = 0
  }
  for (let i = 0; i < ID_LENGTH; i++) tmp[i] = CODES[buffer[offset++] & 63]
  return String.fromCharCode(tmp[0], tmp[1], tmp[2], tmp[3], tmp[4], tmp[5], tmp[6], tmp[7])
}
