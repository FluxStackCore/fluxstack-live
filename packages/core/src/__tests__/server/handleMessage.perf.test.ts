import { describe, it, expect } from 'vitest'
import { sanitizePayload } from '../../security/sanitize'

// ===== Old sanitizePayload (before optimization) =====
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function oldSanitizePayload<T>(value: T, depth = 0): T {
  if (depth > 10) return value
  if (Array.isArray(value)) {
    return value.map(item => oldSanitizePayload(item, depth + 1)) as T
  }
  if (typeof value === 'function') return undefined as T
  if (value !== null && typeof value === 'object') {
    const clean: Record<string, unknown> = {}
    for (const key of Object.keys(value as object)) {
      if (DANGEROUS_KEYS.has(key)) continue
      const val = (value as Record<string, unknown>)[key]
      if (typeof val === 'function') continue
      clean[key] = oldSanitizePayload(val, depth + 1)
    }
    return clean as T
  }
  return value
}

// ===== Old JSON depth check =====
function oldJsonDepthCheck(str: string): boolean {
  let maxDepth = 0
  let currentDepth = 0
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    if (ch === 123 || ch === 91) {
      currentDepth++
      if (currentDepth > maxDepth) maxDepth = currentDepth
      if (maxDepth > 32) return false
    } else if (ch === 125 || ch === 93) {
      currentDepth--
    }
  }
  return true
}

// ===== Old response builder (with dead fields) =====
function oldBuildResponse(message: any, result: any) {
  return JSON.stringify({
    type: 'ACTION_RESPONSE',
    originalType: message.type,
    componentId: message.componentId,
    success: result.success,
    result: result.result,
    error: result.error,
    requestId: message.requestId,
    responseId: message.responseId,
    timestamp: Date.now()
  })
}

function newBuildResponse(message: any, result: any) {
  return JSON.stringify({
    type: 'ACTION_RESPONSE',
    componentId: message.componentId,
    success: result.success,
    result: result.result,
    error: result.error,
    requestId: message.requestId,
  })
}

// ===== Simulated handleMessage flow =====
function oldHandleMessage(str: string) {
  // 1. Depth check
  oldJsonDepthCheck(str)
  // 2. Parse
  const message = JSON.parse(str)
  // 3. Sanitize
  if (message.payload) message.payload = oldSanitizePayload(message.payload)
  // 4. Build response
  const result = { success: true, result: { count: 1 } }
  return oldBuildResponse(message, result)
}

function newHandleMessage(str: string) {
  // 1. No depth check (removed)
  // 2. Parse
  const message = JSON.parse(str)
  // 3. Sanitize (optimized — zero-copy for clean payloads)
  if (message.payload) message.payload = sanitizePayload(message.payload)
  // 4. Build response (no dead fields)
  const result = { success: true, result: { count: 1 } }
  return newBuildResponse(message, result)
}

// ===== Test data =====
const simpleAction = JSON.stringify({
  type: 'CALL_ACTION',
  componentId: 'abc12345',
  action: 'increment',
  payload: {},
  requestId: 'req123',
  expectResponse: true,
  timestamp: Date.now()
})

const mediumPayload = JSON.stringify({
  type: 'CALL_ACTION',
  componentId: 'abc12345',
  action: 'updateProfile',
  payload: {
    name: 'John Doe',
    email: 'john@example.com',
    settings: { theme: 'dark', lang: 'en', notifications: true },
    tags: ['admin', 'user', 'premium']
  },
  requestId: 'req456',
  expectResponse: true,
  timestamp: Date.now()
})

const largePayload = JSON.stringify({
  type: 'CALL_ACTION',
  componentId: 'abc12345',
  action: 'batchUpdate',
  payload: {
    items: Array.from({ length: 50 }, (_, i) => ({
      id: `item-${i}`,
      name: `Item ${i}`,
      value: Math.random(),
      meta: { created: Date.now(), updated: Date.now() }
    }))
  },
  requestId: 'req789',
  expectResponse: true,
  timestamp: Date.now()
})

const WARMUP = 5000
const N = 50_000

function bench(name: string, fn: () => any, iterations = N) {
  for (let i = 0; i < WARMUP; i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  return performance.now() - start
}

describe('handleMessage — performance: old vs new', () => {

  it('simple action (empty payload)', () => {
    const old = bench('old', () => oldHandleMessage(simpleAction))
    const now = bench('new', () => newHandleMessage(simpleAction))

    console.log(`\n${''.padEnd(60, '─')}`)
    console.log(`  Simple action (empty payload) — ${N.toLocaleString()} iterations`)
    console.log(`${''.padEnd(60, '─')}`)
    console.log(`  Old: ${old.toFixed(2)}ms`)
    console.log(`  New: ${now.toFixed(2)}ms`)
    console.log(`  Speedup: ${(old / now).toFixed(2)}x`)
    console.log(`${''.padEnd(60, '─')}`)

    // 15% tolerance — perf timing has natural variance under CI load.
    // The assertion still flags real regressions (e.g. now=2x old).
    expect(now).toBeLessThan(old * 1.15)
  })

  it('medium payload (profile update)', () => {
    const old = bench('old', () => oldHandleMessage(mediumPayload))
    const now = bench('new', () => newHandleMessage(mediumPayload))

    console.log(`\n${''.padEnd(60, '─')}`)
    console.log(`  Medium payload (profile update) — ${N.toLocaleString()} iterations`)
    console.log(`${''.padEnd(60, '─')}`)
    console.log(`  Old: ${old.toFixed(2)}ms`)
    console.log(`  New: ${now.toFixed(2)}ms`)
    console.log(`  Speedup: ${(old / now).toFixed(2)}x`)
    console.log(`${''.padEnd(60, '─')}`)

    // 15% tolerance — perf timing has natural variance under CI load.
    // The assertion still flags real regressions (e.g. now=2x old).
    expect(now).toBeLessThan(old * 1.15)
  })

  it('large payload (50-item batch)', () => {
    const LARGE_N = 10_000
    const old = bench('old', () => oldHandleMessage(largePayload), LARGE_N)
    const now = bench('new', () => newHandleMessage(largePayload), LARGE_N)

    console.log(`\n${''.padEnd(60, '─')}`)
    console.log(`  Large payload (50-item batch) — ${LARGE_N.toLocaleString()} iterations`)
    console.log(`${''.padEnd(60, '─')}`)
    console.log(`  Old: ${old.toFixed(2)}ms`)
    console.log(`  New: ${now.toFixed(2)}ms`)
    console.log(`  Speedup: ${(old / now).toFixed(2)}x`)
    console.log(`${''.padEnd(60, '─')}`)

    // 15% tolerance — perf timing has natural variance under CI load.
    // The assertion still flags real regressions (e.g. now=2x old).
    expect(now).toBeLessThan(old * 1.15)
  })

  it('response size comparison', () => {
    const message = { type: 'CALL_ACTION', componentId: 'abc12345', requestId: 'req123', responseId: undefined }
    const result = { success: true, result: { count: 42 } }

    const oldResp = oldBuildResponse(message, result)
    const newResp = newBuildResponse(message, result)

    console.log(`\n${''.padEnd(60, '─')}`)
    console.log(`  Response size`)
    console.log(`${''.padEnd(60, '─')}`)
    console.log(`  Old: ${oldResp.length} bytes`)
    console.log(`  New: ${newResp.length} bytes`)
    console.log(`  Savings: ${((1 - newResp.length / oldResp.length) * 100).toFixed(0)}%`)
    console.log(`  Old: ${oldResp}`)
    console.log(`  New: ${newResp}`)
    console.log(`${''.padEnd(60, '─')}`)

    expect(newResp.length).toBeLessThan(oldResp.length)
  })

  it('sanitizePayload: clean vs old (no dangerous keys)', () => {
    const cleanPayload = { name: 'test', count: 42, nested: { a: 1, b: 'hello', c: [1, 2, 3] } }

    const old = bench('old', () => oldSanitizePayload(cleanPayload))
    const now = bench('new', () => sanitizePayload(cleanPayload))

    const oldResult = oldSanitizePayload(cleanPayload)
    const newResult = sanitizePayload(cleanPayload)
    const isZeroCopy = newResult === cleanPayload

    console.log(`\n${''.padEnd(60, '─')}`)
    console.log(`  sanitizePayload (clean payload) — ${N.toLocaleString()} iterations`)
    console.log(`${''.padEnd(60, '─')}`)
    console.log(`  Old: ${old.toFixed(2)}ms (always clones)`)
    console.log(`  New: ${now.toFixed(2)}ms (zero-copy: ${isZeroCopy})`)
    console.log(`  Speedup: ${(old / now).toFixed(2)}x`)
    console.log(`${''.padEnd(60, '─')}`)

    expect(isZeroCopy).toBe(true)
    // 15% tolerance — perf timing has natural variance under CI load.
    // The assertion still flags real regressions (e.g. now=2x old).
    expect(now).toBeLessThan(old * 1.15)
  })

  it('sanitizePayload: dirty payload (has __proto__)', () => {
    const dirtyPayload = { name: 'test', __proto__: { evil: true }, count: 42 }

    const old = bench('old', () => oldSanitizePayload(dirtyPayload))
    const now = bench('new', () => sanitizePayload(dirtyPayload))

    console.log(`\n${''.padEnd(60, '─')}`)
    console.log(`  sanitizePayload (dirty payload) — ${N.toLocaleString()} iterations`)
    console.log(`${''.padEnd(60, '─')}`)
    console.log(`  Old: ${old.toFixed(2)}ms`)
    console.log(`  New: ${now.toFixed(2)}ms`)
    console.log(`  Ratio: ${(old / now).toFixed(2)}x`)
    console.log(`${''.padEnd(60, '─')}`)
  })
})
