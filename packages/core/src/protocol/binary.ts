// @fluxstack/live - Binary Protocol for File Uploads
//
// Wire format: [4 bytes headerLength (LE)][JSON header][binary data]

import type { BinaryChunkHeader } from './messages'

/**
 * Encode a binary chunk message for transmission.
 * @param header - JSON metadata about the chunk
 * @param data - Raw binary data
 * @returns Combined buffer ready to send over WebSocket
 */
export function encodeBinaryChunk(header: BinaryChunkHeader, data: Buffer | Uint8Array): Buffer {
  const headerJson = JSON.stringify(header)
  const headerBuffer = Buffer.from(headerJson, 'utf-8')

  // Total: 4 bytes (header length) + header + data
  const result = Buffer.alloc(4 + headerBuffer.length + data.length)
  result.writeUInt32LE(headerBuffer.length, 0)
  headerBuffer.copy(result, 4)
  Buffer.from(data).copy(result, 4 + headerBuffer.length)

  return result
}

/**
 * Decode a binary chunk message received over WebSocket.
 * @param raw - Raw ArrayBuffer or Uint8Array from WebSocket
 * @returns Parsed header and binary chunk data
 */
export function decodeBinaryChunk(raw: ArrayBuffer | Uint8Array): { header: BinaryChunkHeader; data: Buffer } {
  const buffer = raw instanceof ArrayBuffer
    ? Buffer.from(raw)
    : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)

  const headerLength = buffer.readUInt32LE(0)
  const headerJson = buffer.slice(4, 4 + headerLength).toString('utf-8')
  const header = JSON.parse(headerJson) as BinaryChunkHeader
  const data = buffer.slice(4 + headerLength)

  return { header, data }
}
