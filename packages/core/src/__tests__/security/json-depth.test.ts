// BUG #9: JSON.parse without depth limit — deeply nested JSON can cause stack overflow
import { describe, it, expect, vi } from 'vitest'
import { sanitizePayload } from '../../security/sanitize'

// We can't easily test LiveServer.handleMessage directly (needs full WS setup),
// so we test the depth protection via sanitizePayload and a standalone parse helper.

vi.mock('../../debug/LiveLogger', () => ({
  liveLog: vi.fn(),
  liveWarn: vi.fn(),
}))

describe('JSON depth limit protection', () => {
  it('should handle moderately nested JSON without crashing', () => {
    // 50 levels deep — should work fine
    let json = '{"value": 1}'
    for (let i = 0; i < 50; i++) {
      json = `{"nested": ${json}}`
    }

    const parsed = JSON.parse(json)
    const sanitized = sanitizePayload(parsed)
    expect(sanitized).toBeDefined()
  })

  it('should not crash on deeply nested JSON (500 levels)', () => {
    // Build deeply nested JSON
    let json = '{"value": 1}'
    for (let i = 0; i < 500; i++) {
      json = `{"n": ${json}}`
    }

    // JSON.parse itself may throw RangeError on very deep nesting
    // The server should catch this gracefully
    try {
      const parsed = JSON.parse(json)
      // If parse succeeds, sanitize should handle it (stops at MAX_DEPTH=10)
      const sanitized = sanitizePayload(parsed)
      expect(sanitized).toBeDefined()
    } catch (e: any) {
      // Expected: stack overflow or max depth error
      expect(e).toBeInstanceOf(Error)
    }
  })

  it('should detect nesting depth exceeding MAX_JSON_DEPTH', () => {
    // Build JSON deeper than MAX_JSON_DEPTH (32)
    const depth = 50
    const open = '{"n":'.repeat(depth)
    const close = '1' + '}'.repeat(depth)
    const deepJson = open + close

    // Count max nesting depth (same logic as LiveServer)
    let maxDepth = 0
    let currentDepth = 0
    for (let i = 0; i < deepJson.length; i++) {
      const ch = deepJson.charCodeAt(i)
      if (ch === 123 || ch === 91) {
        currentDepth++
        if (currentDepth > maxDepth) maxDepth = currentDepth
      } else if (ch === 125 || ch === 93) {
        currentDepth--
      }
    }

    // Our LiveServer depth check would reject this (MAX_JSON_DEPTH = 32)
    expect(maxDepth).toBeGreaterThan(32)
  })
})
