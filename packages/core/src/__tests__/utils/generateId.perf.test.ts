import { describe, it, expect } from 'vitest'
import { generateId } from '../../utils/generateId'

// ===== Old generators (before this change) =====

function oldComponentId(): string {
  return `live-${crypto.randomUUID()}`
}

function oldConnectionId(): string {
  return `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function oldRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

function oldUploadId(): string {
  return `upload-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
}

function oldInstanceId(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

// ===== Benchmark helper =====

function bench(fn: () => string, warmup = 5000, iterations = 100_000) {
  for (let i = 0; i < warmup; i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  return performance.now() - start
}

describe('generateId — performance comparison: old vs new', () => {

  it('individual generator comparison', () => {
    const N = 100_000

    const results = [
      { name: 'componentId', old: bench(oldComponentId, 5000, N), new: bench(generateId, 5000, N), oldLen: oldComponentId().length, newLen: 8 },
      { name: 'connectionId', old: bench(oldConnectionId, 5000, N), new: bench(generateId, 5000, N), oldLen: oldConnectionId().length, newLen: 8 },
      { name: 'requestId', old: bench(oldRequestId, 5000, N), new: bench(generateId, 5000, N), oldLen: oldRequestId().length, newLen: 8 },
      { name: 'uploadId', old: bench(oldUploadId, 5000, N), new: bench(generateId, 5000, N), oldLen: oldUploadId().length, newLen: 8 },
      { name: 'instanceId', old: bench(() => oldInstanceId('Counter'), 5000, N), new: bench(generateId, 5000, N), oldLen: oldInstanceId('Counter').length, newLen: 8 },
    ]

    console.log(`\n${''.padEnd(70, '─')}`)
    console.log(`  generateId() perf comparison — ${N.toLocaleString()} iterations each`)
    console.log(`${''.padEnd(70, '─')}`)
    console.log(`  ${'Generator'.padEnd(16)} ${'Old (ms)'.padStart(10)} ${'New (ms)'.padStart(10)} ${'Speedup'.padStart(10)} ${'Old len'.padStart(9)} ${'New len'.padStart(9)}`)
    console.log(`  ${''.padEnd(64, '─')}`)

    for (const r of results) {
      const speedup = (r.old / r.new).toFixed(2)
      console.log(`  ${r.name.padEnd(16)} ${r.old.toFixed(2).padStart(10)} ${r.new.toFixed(2).padStart(10)} ${(speedup + 'x').padStart(10)} ${String(r.oldLen).padStart(9)} ${String(r.newLen).padStart(9)}`)
    }
    console.log(`${''.padEnd(70, '─')}\n`)
  })

  it('simulates realistic server load: 1000 connections, 5 components each', () => {
    const CONNECTIONS = 1000
    const COMPONENTS_PER_CONN = 5
    const ACTIONS_PER_COMPONENT = 10

    // Old way
    const oldStart = performance.now()
    for (let c = 0; c < CONNECTIONS; c++) {
      oldConnectionId()
      for (let comp = 0; comp < COMPONENTS_PER_CONN; comp++) {
        oldComponentId()
        for (let a = 0; a < ACTIONS_PER_COMPONENT; a++) {
          oldRequestId()
        }
      }
    }
    const oldElapsed = performance.now() - oldStart

    // New way
    const newStart = performance.now()
    for (let c = 0; c < CONNECTIONS; c++) {
      generateId()
      for (let comp = 0; comp < COMPONENTS_PER_CONN; comp++) {
        generateId()
        for (let a = 0; a < ACTIONS_PER_COMPONENT; a++) {
          generateId()
        }
      }
    }
    const newElapsed = performance.now() - newStart

    const totalIds = CONNECTIONS * (1 + COMPONENTS_PER_CONN * (1 + ACTIONS_PER_COMPONENT))
    const oldBytes = totalIds * 35 // avg old ID length ~35
    const newBytes = totalIds * 8

    console.log(`\n${''.padEnd(60, '─')}`)
    console.log(`  Realistic simulation: ${CONNECTIONS} conns × ${COMPONENTS_PER_CONN} comps × ${ACTIONS_PER_COMPONENT} actions`)
    console.log(`  Total IDs: ${totalIds.toLocaleString()}`)
    console.log(`${''.padEnd(60, '─')}`)
    console.log(`  Old: ${oldElapsed.toFixed(2)}ms | ~${(oldBytes / 1024).toFixed(0)}KB on wire`)
    console.log(`  New: ${newElapsed.toFixed(2)}ms | ~${(newBytes / 1024).toFixed(0)}KB on wire`)
    console.log(`  Speedup: ${(oldElapsed / newElapsed).toFixed(2)}x faster`)
    console.log(`  Wire savings: ${((1 - newBytes / oldBytes) * 100).toFixed(0)}% smaller`)
    console.log(`${''.padEnd(60, '─')}\n`)

    expect(newElapsed).toBeLessThan(oldElapsed)
  })

  it('measures memory: 10k IDs stored in a Map', () => {
    const N = 10_000

    // Old IDs
    const oldMap = new Map<string, number>()
    const oldStart = performance.now()
    for (let i = 0; i < N; i++) oldMap.set(oldComponentId(), i)
    const oldElapsed = performance.now() - oldStart

    // New IDs
    const newMap = new Map<string, number>()
    const newStart = performance.now()
    for (let i = 0; i < N; i++) newMap.set(generateId(), i)
    const newElapsed = performance.now() - newStart

    // Estimate string memory (2 bytes per char in V8/JSC)
    const oldCharTotal = [...oldMap.keys()].reduce((sum, k) => sum + k.length, 0)
    const newCharTotal = [...newMap.keys()].reduce((sum, k) => sum + k.length, 0)

    console.log(`\n${''.padEnd(50, '─')}`)
    console.log(`  Map with ${N.toLocaleString()} IDs`)
    console.log(`${''.padEnd(50, '─')}`)
    console.log(`  Old: ${oldElapsed.toFixed(2)}ms | ~${(oldCharTotal * 2 / 1024).toFixed(0)}KB strings`)
    console.log(`  New: ${newElapsed.toFixed(2)}ms | ~${(newCharTotal * 2 / 1024).toFixed(0)}KB strings`)
    console.log(`  Memory savings: ${((1 - newCharTotal / oldCharTotal) * 100).toFixed(0)}%`)
    console.log(`${''.padEnd(50, '─')}\n`)
  })

  it('Map lookup speed: old long keys vs new short keys', () => {
    const N = 10_000
    const LOOKUPS = 100_000

    // Build maps
    const oldKeys: string[] = []
    const newKeys: string[] = []
    const oldMap = new Map<string, number>()
    const newMap = new Map<string, number>()
    for (let i = 0; i < N; i++) {
      const ok = oldComponentId(); oldKeys.push(ok); oldMap.set(ok, i)
      const nk = generateId(); newKeys.push(nk); newMap.set(nk, i)
    }

    // Lookup old
    const oldStart = performance.now()
    for (let i = 0; i < LOOKUPS; i++) {
      oldMap.get(oldKeys[i % N])
    }
    const oldElapsed = performance.now() - oldStart

    // Lookup new
    const newStart = performance.now()
    for (let i = 0; i < LOOKUPS; i++) {
      newMap.get(newKeys[i % N])
    }
    const newElapsed = performance.now() - newStart

    console.log(`\n${''.padEnd(50, '─')}`)
    console.log(`  Map.get() — ${LOOKUPS.toLocaleString()} lookups in ${N.toLocaleString()}-entry Map`)
    console.log(`${''.padEnd(50, '─')}`)
    console.log(`  Old keys (~41 chars): ${oldElapsed.toFixed(2)}ms`)
    console.log(`  New keys (8 chars):   ${newElapsed.toFixed(2)}ms`)
    console.log(`  Ratio: ${(oldElapsed / newElapsed).toFixed(2)}x`)
    console.log(`${''.padEnd(50, '─')}\n`)
  })
})
