// FileUploadManager — security & correctness tests.
// This manager is the gatekeeper between attacker-supplied bytes and the
// host filesystem. It has many defenses (allowedTypes, blockedExtensions,
// magic-byte validation, quota, double-extension detection, filename
// sanitization) and zero tests prior to this file.
//
// Strategy: use a custom assembleFile so we never touch disk, then drive
// real attack scenarios through startUpload / receiveChunk / completeUpload.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FileUploadManager } from '../../upload/FileUploadManager'
import type { ActiveUpload } from '../../protocol/messages'

vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
}))

// ── Magic bytes for fixtures ───────────────────────────────────────────
const PNG_HEADER = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
const JPEG_HEADER = [0xFF, 0xD8, 0xFF]
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46] // "%PDF"

function makeChunk(prefix: number[], padBytes = 100): string {
  const buf = Buffer.alloc(prefix.length + padBytes)
  for (let i = 0; i < prefix.length; i++) buf[i] = prefix[i]!
  return buf.toString('base64')
}

interface MgrSetup {
  mgr: FileUploadManager
  assembled: ActiveUpload[]
}

function makeMgr(config?: ConstructorParameters<typeof FileUploadManager>[0]): MgrSetup {
  const assembled: ActiveUpload[] = []
  const mgr = new FileUploadManager({
    ...config,
    assembleFile: async (upload) => {
      assembled.push(upload)
      return `/fake/${upload.uploadId}`
    },
  })
  return { mgr, assembled }
}

let mgr: FileUploadManager
beforeEach(() => { /* fresh per-test */ })
afterEach(() => { mgr?.shutdown() })

// ─────────────────────────────────────────────────────────────────────────
// Size + quota
// ─────────────────────────────────────────────────────────────────────────

describe('FileUploadManager — size & quota', () => {
  it('rejects upload above maxUploadSize', async () => {
    const setup = makeMgr({ maxUploadSize: 1024 })
    mgr = setup.mgr
    const r = await mgr.startUpload({
      uploadId: 'u1', componentId: 'c1', filename: 'x.png', fileType: 'image/png',
      fileSize: 2048, chunkSize: 1024,
    } as any)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/too large/i)
  })

  it('rejects upload above per-user quota', async () => {
    const setup = makeMgr({ maxBytesPerUser: 1000 })
    mgr = setup.mgr
    const r = await mgr.startUpload(
      { uploadId: 'u1', componentId: 'c1', filename: 'x.png', fileType: 'image/png', fileSize: 2000 } as any,
      'alice',
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/quota/i)
  })

  it('accumulates quota across multiple uploads from same user', async () => {
    const setup = makeMgr({ maxBytesPerUser: 1000 })
    mgr = setup.mgr
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize: 600 } as any, 'alice')
    const second = await mgr.startUpload({ uploadId: 'u2', componentId: 'c1', filename: 'b.png', fileType: 'image/png', fileSize: 500 } as any, 'alice')
    expect(second.success).toBe(false)
    expect(second.error).toMatch(/quota/i)
  })

  it('isolates quota between different users', async () => {
    const setup = makeMgr({ maxBytesPerUser: 1000 })
    mgr = setup.mgr
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize: 900 } as any, 'alice')
    const bob = await mgr.startUpload({ uploadId: 'u2', componentId: 'c2', filename: 'b.png', fileType: 'image/png', fileSize: 900 } as any, 'bob')
    expect(bob.success).toBe(true)
  })

  it('getUserUploadUsage reports current usage and remaining', async () => {
    const setup = makeMgr({ maxBytesPerUser: 1000 })
    mgr = setup.mgr
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize: 400 } as any, 'alice')
    expect(mgr.getUserUploadUsage('alice')).toEqual({ used: 400, limit: 1000, remaining: 600 })
  })

  it('anonymous uploads (no userId) skip quota check', async () => {
    const setup = makeMgr({ maxBytesPerUser: 10 })
    mgr = setup.mgr
    const r = await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize: 999999 } as any)
    expect(r.success).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// MIME type allowlist
// ─────────────────────────────────────────────────────────────────────────

describe('FileUploadManager — type allowlist', () => {
  it('rejects MIME types not in allowedTypes', async () => {
    const setup = makeMgr({ allowedTypes: ['image/png'] })
    mgr = setup.mgr
    const r = await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'x.exe', fileType: 'application/x-msdownload', fileSize: 100 } as any)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not allowed/i)
  })

  it('empty allowedTypes acts as wildcard (default off-the-shelf is restrictive)', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    const r = await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'x.png', fileType: 'image/png', fileSize: 100 } as any)
    expect(r.success).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Blocked extensions + double-extension
// ─────────────────────────────────────────────────────────────────────────

describe('FileUploadManager — extension blocking', () => {
  it('rejects executable extension (.exe)', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    const r = await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'malware.exe', fileType: 'application/octet-stream', fileSize: 100 } as any)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/extension not allowed/i)
  })

  it('detects double-extension (malware.exe.png)', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    const r = await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'innocent.exe.png', fileType: 'image/png', fileSize: 100 } as any)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/double extension/i)
  })

  it('detects double-extension with bash (file.sh.txt)', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    const r = await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'innocent.sh.txt', fileType: 'text/plain', fileSize: 100 } as any)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/double extension/i)
  })

  it('accepts single dot extension files normally', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    const r = await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'photo.png', fileType: 'image/png', fileSize: 100 } as any)
    expect(r.success).toBe(true)
  })

  it('rejects filename longer than 255 chars', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    const longName = 'a'.repeat(260) + '.png'
    const r = await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: longName, fileType: 'image/png', fileSize: 100 } as any)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/too long/i)
  })

  it('basename strips path traversal (../../etc/passwd)', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    // Should succeed because basename strips the directory traversal,
    // leaving just "passwd" (no extension, no block).
    const r = await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: '../../etc/passwd', fileType: 'text/plain', fileSize: 100 } as any)
    expect(r.success).toBe(true)
    // Confirm the active upload kept the (raw) filename — the basename
    // strip only happens at validation. The actual disk path is generated
    // by defaultAssembleFile using crypto.randomUUID(), so traversal can't
    // escape the uploads dir even if validation passed.
    expect(mgr.getUploadStatus('u1')?.filename).toBe('../../etc/passwd')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// uploadId collisions
// ─────────────────────────────────────────────────────────────────────────

describe('FileUploadManager — uploadId collisions', () => {
  it('rejects starting an upload with an in-progress uploadId', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    await mgr.startUpload({ uploadId: 'dup', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize: 100 } as any)
    const r = await mgr.startUpload({ uploadId: 'dup', componentId: 'c1', filename: 'b.png', fileType: 'image/png', fileSize: 100 } as any)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/already in progress/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Chunk handling — bounds and integrity
// ─────────────────────────────────────────────────────────────────────────

describe('FileUploadManager — chunk handling', () => {
  it('rejects negative chunk index', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize: 100, chunkSize: 50 } as any)
    await expect(
      mgr.receiveChunk({ uploadId: 'u1', chunkIndex: -1, totalChunks: 2, data: '' } as any, null),
    ).rejects.toThrow(/invalid chunk index/i)
  })

  it('rejects chunk index >= totalChunks', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize: 100, chunkSize: 50 } as any)
    await expect(
      mgr.receiveChunk({ uploadId: 'u1', chunkIndex: 99, totalChunks: 2, data: '' } as any, null),
    ).rejects.toThrow(/invalid chunk index/i)
  })

  it('rejects chunk for unknown uploadId', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    await expect(
      mgr.receiveChunk({ uploadId: 'ghost', chunkIndex: 0, totalChunks: 1, data: '' } as any, null),
    ).rejects.toThrow(/not found/i)
  })

  it('duplicate chunk index is idempotent (does not double-count bytes)', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize: 200, chunkSize: 100 } as any)
    const chunk0 = Buffer.alloc(100).toString('base64')
    await mgr.receiveChunk({ uploadId: 'u1', chunkIndex: 0, totalChunks: 2, data: chunk0 } as any, null)
    await mgr.receiveChunk({ uploadId: 'u1', chunkIndex: 0, totalChunks: 2, data: chunk0 } as any, null)
    expect(mgr.getUploadStatus('u1')?.bytesReceived).toBe(100)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Magic bytes — content-spoofing defense
// ─────────────────────────────────────────────────────────────────────────

describe('FileUploadManager — magic byte validation', () => {
  it('rejects PNG content claiming to be JPEG', async () => {
    const setup = makeMgr({ allowedTypes: ['image/jpeg'] })
    mgr = setup.mgr
    const fileSize = 108
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'x.jpg', fileType: 'image/jpeg', fileSize, chunkSize: fileSize } as any)
    // Send a chunk with PNG magic bytes despite the declared type.
    await mgr.receiveChunk({ uploadId: 'u1', chunkIndex: 0, totalChunks: 1, data: makeChunk(PNG_HEADER) } as any, null)
    const r = await mgr.completeUpload({ uploadId: 'u1' } as any)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/disguised|does not match/i)
  })

  it('accepts JPEG content with matching JPEG header', async () => {
    const setup = makeMgr({ allowedTypes: ['image/jpeg'] })
    mgr = setup.mgr
    const fileSize = 103
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'x.jpg', fileType: 'image/jpeg', fileSize, chunkSize: fileSize } as any)
    await mgr.receiveChunk({ uploadId: 'u1', chunkIndex: 0, totalChunks: 1, data: makeChunk(JPEG_HEADER) } as any, null)
    const r = await mgr.completeUpload({ uploadId: 'u1' } as any)
    expect(r.success).toBe(true)
  })

  it('accepts PDF content with matching %PDF header', async () => {
    const setup = makeMgr({ allowedTypes: ['application/pdf'] })
    mgr = setup.mgr
    const fileSize = 104
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'doc.pdf', fileType: 'application/pdf', fileSize, chunkSize: fileSize } as any)
    await mgr.receiveChunk({ uploadId: 'u1', chunkIndex: 0, totalChunks: 1, data: makeChunk(PDF_HEADER) } as any, null)
    const r = await mgr.completeUpload({ uploadId: 'u1' } as any)
    expect(r.success).toBe(true)
  })

  it('rejects PDF disguised as ZIP', async () => {
    const setup = makeMgr({ allowedTypes: ['application/zip'] })
    mgr = setup.mgr
    const fileSize = 104
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'fake.zip', fileType: 'application/zip', fileSize, chunkSize: fileSize } as any)
    await mgr.receiveChunk({ uploadId: 'u1', chunkIndex: 0, totalChunks: 1, data: makeChunk(PDF_HEADER) } as any, null)
    const r = await mgr.completeUpload({ uploadId: 'u1' } as any)
    expect(r.success).toBe(false)
  })

  it('skips magic-byte check for types without a signature (e.g. text/plain)', async () => {
    const setup = makeMgr({ allowedTypes: ['text/plain'] })
    mgr = setup.mgr
    const data = Buffer.from('hello world', 'utf-8').toString('base64')
    const fileSize = 11
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'note.txt', fileType: 'text/plain', fileSize, chunkSize: fileSize } as any)
    await mgr.receiveChunk({ uploadId: 'u1', chunkIndex: 0, totalChunks: 1, data } as any, null)
    const r = await mgr.completeUpload({ uploadId: 'u1' } as any)
    expect(r.success).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// completeUpload — integrity
// ─────────────────────────────────────────────────────────────────────────

describe('FileUploadManager — completeUpload integrity', () => {
  it('rejects complete when bytesReceived !== fileSize', async () => {
    const setup = makeMgr({ allowedTypes: ['image/png'] })
    mgr = setup.mgr
    const declaredSize = 1000
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize: declaredSize, chunkSize: declaredSize } as any)
    // Send only 100 bytes
    await mgr.receiveChunk({ uploadId: 'u1', chunkIndex: 0, totalChunks: 1, data: makeChunk(PNG_HEADER, 92) } as any, null)
    const r = await mgr.completeUpload({ uploadId: 'u1' } as any)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/incomplete/i)
  })

  it('rejects complete for unknown uploadId', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    const r = await mgr.completeUpload({ uploadId: 'ghost' } as any)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not found/i)
  })

  it('removes upload from active list after successful complete', async () => {
    const setup = makeMgr({ allowedTypes: ['image/png'] })
    mgr = setup.mgr
    const fileSize = 108
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize, chunkSize: fileSize } as any)
    await mgr.receiveChunk({ uploadId: 'u1', chunkIndex: 0, totalChunks: 1, data: makeChunk(PNG_HEADER) } as any, null)
    expect(mgr.getUploadStatus('u1')).toBeTruthy()
    await mgr.completeUpload({ uploadId: 'u1' } as any)
    expect(mgr.getUploadStatus('u1')).toBeNull()
  })

  it('invokes custom assembleFile and returns its URL', async () => {
    const setup = makeMgr({ allowedTypes: ['image/png'] })
    mgr = setup.mgr
    const fileSize = 108
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize, chunkSize: fileSize } as any)
    await mgr.receiveChunk({ uploadId: 'u1', chunkIndex: 0, totalChunks: 1, data: makeChunk(PNG_HEADER) } as any, null)
    const r = await mgr.completeUpload({ uploadId: 'u1' } as any)
    expect(r.success).toBe(true)
    expect(r.fileUrl).toBe('/fake/u1')
    expect(setup.assembled).toHaveLength(1)
    expect(setup.assembled[0]!.filename).toBe('a.png')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────

describe('FileUploadManager — cancellation', () => {
  it('cancelUpload removes the upload', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize: 100 } as any)
    expect(mgr.cancelUpload('u1')).toBe(true)
    expect(mgr.getUploadStatus('u1')).toBeNull()
  })

  it('cancelUpload returns false for unknown id', () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    expect(mgr.cancelUpload('ghost')).toBe(false)
  })

  it('cancelComponentUploads removes all uploads for the component', async () => {
    const setup = makeMgr({ allowedTypes: [] })
    mgr = setup.mgr
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize: 100 } as any)
    await mgr.startUpload({ uploadId: 'u2', componentId: 'c1', filename: 'b.png', fileType: 'image/png', fileSize: 100 } as any)
    await mgr.startUpload({ uploadId: 'u3', componentId: 'c2', filename: 'c.png', fileType: 'image/png', fileSize: 100 } as any)
    expect(mgr.cancelComponentUploads('c1')).toBe(2)
    expect(mgr.getUploadStatus('u1')).toBeNull()
    expect(mgr.getUploadStatus('u2')).toBeNull()
    expect(mgr.getUploadStatus('u3')).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Known limitation: quota is not refunded on cancel
// ─────────────────────────────────────────────────────────────────────────

describe('FileUploadManager — known limitations (regression guards)', () => {
  it('quota is NOT refunded when an upload is cancelled (documents current behavior)', async () => {
    const setup = makeMgr({ maxBytesPerUser: 1000 })
    mgr = setup.mgr
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize: 600 } as any, 'alice')
    mgr.cancelUpload('u1')
    // Alice still shows 600 used because cancelUpload doesn't refund.
    // Documenting this so a future "fix" knows there's a known gap.
    expect(mgr.getUserUploadUsage('alice').used).toBe(600)
  })

  it('quota is NOT refunded on failed/incomplete upload (documents current behavior)', async () => {
    const setup = makeMgr({ maxBytesPerUser: 1000, allowedTypes: ['image/png'] })
    mgr = setup.mgr
    await mgr.startUpload({ uploadId: 'u1', componentId: 'c1', filename: 'a.png', fileType: 'image/png', fileSize: 500, chunkSize: 500 } as any, 'alice')
    // Complete fails (no chunk uploaded) — quota still counts.
    await mgr.completeUpload({ uploadId: 'u1' } as any)
    expect(mgr.getUserUploadUsage('alice').used).toBe(500)
  })
})
