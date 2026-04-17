# Serialization & Performance Limits

> This document records our findings from benchmarking serialization alternatives for the WebSocket protocol. It serves as a reference to avoid re-investigating the same approaches.

## TL;DR

**JSON is the best option for our use case.** It's implemented in C++ inside V8 and outperforms every JavaScript-based alternative. The only approaches that beat JSON require native C++ addons or only work with fixed-schema numeric data (game scenarios).

## Benchmark Results

Tested on Bun with vitest bench, comparing encode/decode performance and wire size.

### Encode Performance (server-side)

| Approach | Small (1 field) | Medium (6 fields) | Game (5 numbers) | Chat (100 msgs) |
|---|---|---|---|---|
| **JSON.stringify** | 4.7M ops/s | 1.7M ops/s | 1.9M ops/s | 28K ops/s |
| msgpack (JS) | 800K ops/s | 150K ops/s | 200K ops/s | 2K ops/s |
| Manual typed encoder | 1.7M ops/s | 280K ops/s | — | — |
| DataView (zero-copy) | 9M ops/s | 3.4M ops/s | **1.25M ops/s** | — |
| JSON + deflate | 75K ops/s | 59K ops/s | — | 9K ops/s |

### Decode Performance (client-side)

| Approach | Small | Medium | Game 10 players | Game 100 players |
|---|---|---|---|---|
| **JSON.parse** | 2.7M ops/s | 1.3M ops/s | 134K ops/s | 15K ops/s |
| msgpack (JS) | 2.3M ops/s | 492K ops/s | 57K ops/s | 5.7K ops/s |
| DataView | 5.5M ops/s | 1.4M ops/s | **4.1M ops/s** | **825K ops/s** |

### Wire Size

| Approach | Game delta (5 fields) | Full envelope |
|---|---|---|
| JSON | 51 bytes | 119 bytes |
| JSON + deflate | **56 bytes (larger!)** | 114 bytes (-4%) |
| msgpack | 36 bytes | N/A |
| Binary codec (auto) | 41 bytes | 51 bytes (-57%) |
| Binary codec (typed) | 15 bytes | **25 bytes (-79%)** |

## Why JSON Wins

1. **V8 native C++** — `JSON.stringify` and `JSON.parse` are implemented in C++ inside the V8 engine with 15+ years of optimization. Any JS-based serializer runs one layer above.

2. **JIT-optimized hot paths** — V8 recognizes JSON operations and applies special optimizations that user-space code doesn't get.

3. **Zero setup** — No schemas, no code generation, no build steps. Works with any JavaScript value.

## Why Each Alternative Loses

### msgpack (our JS implementation)
- **9-17x slower** than JSON for encoding
- Written in JS — runs on V8 as user code, not native
- Creates many intermediate `Uint8Array` allocations → GC pressure
- Only advantage: ~30% smaller wire size
- **Verdict:** Keep in rooms for binary broadcasts only

### FlatBuffers
- Requires `.fbs` schema files compiled ahead of time
- Schemaless mode doesn't work properly (crashed in benchmarks)
- Massive API complexity for minimal gain
- **Verdict:** Not viable without native addon

### Compression (deflate/gzip)
- **26x slower** encode, **13x slower** decode
- For payloads < 200 bytes (99% of state deltas), the deflate header (~15 bytes) is larger than the compression savings
- Game delta actually **increased** from 51 to 56 bytes
- **Verdict:** Never compress individual deltas. If needed, use WebSocket `permessage-deflate` extension (handled by the runtime, not application code)

### DataView (manual binary encoding)
- **Extremely fast** for fixed-schema numeric data (38-83x faster than JSON)
- But requires manual schema definition and only works with fixed-size fields
- No support for dynamic arrays, nested objects, or variable-length strings without complexity
- **Verdict:** Best option for game-like scenarios, but too rigid for general-purpose components

## JavaScript Runtime Limits

### Single-threaded event loop
- One `ws.onmessage` handler runs at a time per connection
- Heavy processing blocks all other messages in the queue
- Worker Threads can't share WebSocket connections

### WebSocket is serial per direction
- Full-duplex: send and receive happen on independent channels
- But within each direction, messages are processed in FIFO order
- Chunked uploads via WS compete with actions in the input queue

### The real bottleneck isn't serialization
For most applications, the actual bottleneck is:
1. **Network latency** (ms) — not encoding speed (microseconds)
2. **Number of connections** — solved by horizontal scaling (cluster), not faster encoding
3. **Broadcast fan-out** — `ws.send()` × N connections, which is I/O bound, not CPU bound

## Recommendations

| Scenario | Recommendation |
|---|---|
| Apps (forms, chat, dashboard) | **JSON** — already optimal, don't change |
| High-frequency updates | Use the **WsSendBatcher** (already built-in) — batches + deduplicates deltas |
| Many connections | **Cluster** with Redis (already supported) — distribute across processes |
| Game-like scenarios | Consider **DataView manual encoding** or a dedicated game framework |
| Large payloads | Consider **HTTP upload** instead of WS chunking |

## What We Already Optimize

The framework already includes several wire-level optimizations:

- **WsSendBatcher** — batches messages per microtask, deduplicates STATE_DELTA per componentId
- **Pre-serialized broadcasts** — `JSON.stringify` once, send the same string to N connections
- **Binary room events** — msgpack-encoded room state deltas (0x03 frame type)
- **Dead field removal** — `timestamp`, `originalType`, `responseId` removed from protocol messages
- **8-char component IDs** — 5x smaller than UUID, generated via buffer pool
