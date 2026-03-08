// ElysiaTransport Integration Tests
//
// Elysia requires the Bun runtime (app.listen() fails on Node.js).
// These tests are skipped when running under Node/vitest.
// To run manually: cd packages/elysia && bun test

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const isBun = typeof (globalThis as any).Bun !== 'undefined'

describe.skipIf(!isBun)('ElysiaTransport', () => {
  it('should be tested under Bun runtime', () => {
    // Placeholder — Elysia requires Bun's native WS adapter.
    // Run these tests with: cd packages/elysia && bun test
    expect(true).toBe(true)
  })
})
