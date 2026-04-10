# Changelog

All notable changes to the `@fluxstack/live*` monorepo are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the `0.x` convention where minor bumps may include breaking changes.

## [0.7.0] - 2026-04-10

Six issues closed (#2–#7) across security, lifecycle, state semantics,
and the binary/JSON transport surface. The common theme is **failing
loudly instead of silently dropping data**: the framework now surfaces
classes of bugs that previously produced silent server↔client drift.

### Security

- **Replay attack across nonce eviction is closed** (#4). The nonce map
  cap (added in 0.6.1 to prevent DoS) used to evict legitimate nonces
  that were still within their TTL, opening a replay window for an
  attacker holding a captured `SignedState`. The manager now tracks an
  `evictionHighWaterMark` set to the newest embedded timestamp ever
  evicted, and `validateNonce` rejects any nonce whose embedded ts is at
  or below that mark. Fail-closed. `StateSignature.ts`.
- **`$auth.session` is now deep-frozen** (#4). `AuthenticatedContext`
  used to store the caller's session by reference, so a handler bug
  that mutated `this.$auth.session.roles.push('admin')` silently
  altered every subsequent `authorize()` decision in the same process.
  The constructor now copies `roles`/`permissions`, freezes them,
  freezes the session, and freezes the context instance itself.
  `ANONYMOUS_CONTEXT` (a shared singleton) is also frozen.
  `LiveAuthContext.ts`.
- **`authorize()` return value is strictly coerced** (#4). A
  user-supplied `authorize()` that returned a primitive (`'true'`, `0`,
  `null`, `undefined`, or an object without `allowed`) used to land in
  `result.allowed === undefined`. Callers using `if (!result.allowed)`
  were fail-closed by accident, but strict consumers checking
  `result.allowed === false` would miss the deny. New
  `coerceAuthResult` helper accepts only `true`, `false`, or objects
  with explicit `allowed: true/false`. `LiveAuthManager.ts`.

### Added

- **`getBatcherStats()` / `resetBatcherStats()`** exported from
  `@fluxstack/live` (#7). Running totals of messages dropped by the
  `WsSendBatcher` across three drop paths:
  - `droppedBackpressure` — per-connection queue reached
    `MAX_QUEUE_SIZE`.
  - `droppedClosed` — WebSocket was closed at queue or flush time.
  - `droppedSerializationError` — `JSON.stringify` / `ws.send` threw
    during flush.
- **One-shot backpressure warning** per connection (#7). When the
  batcher starts dropping for a given ws, a single `liveWarn` is
  emitted (gated by a `WeakSet`) so operators notice churn without log
  spam.
- **Regression suites** totalling 92 new tests across the fixes:
  - `StateSignature.replay-eviction.test.ts` (5)
  - `auth/session-freeze.test.ts` (8)
  - `auth/authorize-strict-return.test.ts` (13)
  - `rooms/LiveRoomManager.lifecycle-hooks.test.ts` (14, 1 skipped)
  - `component/setstate-edge-cases.test.ts` (15)
  - `transport/protocol-codec.test.ts` (28)
  - `utils/deepDiff.test.ts` (+8)

### Changed — Breaking

- **`setState({ x: null })` at the top level now stores `null`** instead
  of deleting the key (#6). Top-level state keys come from the
  component's `defaultState` schema and are not dynamically added or
  removed. Any `Nullable<T>` field is now expressible; any code that
  was (accidentally) using null-at-root to delete a key needs to
  restructure. Nested `null` inside a `Record<string, T>` still works
  as a deletion sentinel — this is what the issue #1/#3 fix needed and
  what game rooms rely on. Applied consistently in all five
  server/client deep-merge implementations. `deepDiff.ts`,
  `react/useLiveComponent.ts`, `vue/index.ts`, `client/component.ts`,
  `client/rooms.ts`.
- **`setState({ x: undefined })` is now a no-op** (#6). `undefined`
  values used to leak into internal state and then be stripped by
  `JSON.stringify` on the wire, silently desyncing server and client.
  Both `computeDeepDiff` and `deepAssign` now skip `undefined` values
  entirely. Callers wanting to clear a field should pass `null` if the
  type allows it.
- **`LiveComponent.$options.deepDiff` default flipped to `true`** (#3).
  Aligns with `LiveRoomManager` which already defaulted to `true`. In
  the old shallow default, `setState({ players: {...next} })` emitted
  `{ players: { A: ... } }` without marking removed keys as `null`, so
  the client's deepMerge never deleted them. Opt out with
  `static $options = { deepDiff: false }`.
- **`onCreate` now runs BEFORE the first `onJoin`** on a `LiveRoom`
  (#5). The previous order contradicted the `LiveRoom.ts:148` docs
  ("Called once when the room is first created (first member joins)")
  — the first member saw uninitialized state. Any room that relied on
  the buggy order should move its first-member initialization into
  `onCreate`.
- **`onJoin` throwing is now treated as an implicit rejection** (#5).
  Previously a sync throw propagated out of `joinRoom` and crashed the
  transport; an async rejection became `unhandledRejection`. Both now
  take the same path as `return false` and reject the join cleanly.
- **`onDestroy` is now awaited** so `Promise<false>` can cancel
  destruction (#5). The documented `async onDestroy() { return false }`
  cancel signal was silently ignored because the code compared a
  Promise to `false`. The empty-room cleanup is extracted into a
  private `scheduleEmptyRoomDestruction` helper that awaits the result,
  honours `Promise<false>`, and isolates throws.
- **`onEvent` is observer-only** (#5). `emitToRoom` is synchronous and
  the broadcast cannot be cancelled or mutated by a hook return value.
  The hook can still be declared `async` but its completion is not
  awaited before the broadcast. Sync throws and async rejections are
  now caught and logged instead of crashing / surfacing as
  `unhandledRejection`.
- **`msgpackEncode` now throws on unsupported types** instead of
  silently emitting nil or empty maps (#7). Previously `Date` became
  `{}` (because `Object.keys(new Date())` is `[]`), and `BigInt`,
  `Symbol`, `Function`, `Map`, `Set`, `RegExp` all fell through to the
  `0xc0` (nil) fallback — silent data loss. Each type now throws
  `TypeError` with a clear message pointing at the supported
  alternative (store timestamps as numbers, convert `Map` to a plain
  object, etc.).
- **Binary frame field limits are enforced** (#7). `sendBinaryDelta`,
  `buildRoomFrame`, `buildRoomFrameTail`, and `prependMemberHeader`
  now `throw` when `componentId` or `roomId` exceeds the u8 length
  prefix (255 bytes), or when `event` exceeds u16 (65535 bytes).
  Framework-generated ids are ~41 bytes so normal use is unaffected;
  custom id schemes that were silently wrapping are now caught.
- **`msgpackDecode` rejects truncated input** (#7). Previously
  `decodeAt` returned `{ value: null, offset }` on buffer underrun and
  kept decoding, so a truncated frame produced a corrupt object where
  truncated fields were indistinguishable from real nulls. Every read
  site now asserts `needBytes` and throws `RangeError`. Unknown type
  bytes throw `TypeError` instead of silently returning `null`.
- **`sendBinaryImmediate` / `sendImmediate` now flush the per-WS batch
  queue first** (#7). Previously
  `queueWsMessage(A); sendBinaryImmediate(B)` sent `B` before `A`
  because batched messages waited for the next microtask while binary
  writes were synchronous. A binary state delta could therefore
  overtake the JSON `STATE_UPDATE` that established its keys. Both
  immediate senders now call a new `flushOne()` helper on the same ws
  before writing, preserving caller ordering.

### Fixed

- **`@fluxstack/live-react` `useEffect` re-registered the component on
  every `STATE_DELTA`** (#2). The register effect had `stateData` and
  the caller's handler props (`onStateChange`, `onRehydrate`,
  `onError`) in its dependency array, causing an unregister → register
  cycle per delta — unnecessary overhead and a risk of message loss in
  the gap. Deps reduced to
  `[componentId, registerComponent, registerBinaryHandler, updateState]`;
  handlers, persist metadata, and the binary decoder are now read via
  refs (`handlersRef`, `persistMetaRef`, `binaryDecoderRef`).
  `useLiveComponent.ts`.
- **Key removal not detected in nested `Record<string, T>`** (#3). See
  the `deepDiff` default change above.
- **`cleanupComponent` could leak members on `onLeave` throw** (#5).
  The for-of loop wrapped `await instance.onLeave(...)` without a
  try/catch, so a single bad hook stopped the loop and left the
  component as a member of every subsequent room. Each iteration is
  now wrapped individually; the single-room `leaveRoom()` path got the
  same protection.
- **`WsSendBatcher` swallowed serialization errors** (#7). The `catch`
  block inside `flushAll` was empty, so circular refs, `BigInt`,
  getter throws, and post-close `ws.send` failures were all silenced
  with no telemetry. Now each failure increments
  `droppedSerializationError` and emits `liveWarn`. This is also what
  turns a circular state into a visible error instead of a stack
  overflow.

### Not fixed — documented limitations

Captured as pinned tests in the new regression suites so any future
change is an explicit decision:

- **Shallow state proxy** — `this.state.nested.x = y` emits no delta.
  Users should call
  `setState({ nested: { ...this.state.nested, x } })`.
- **`Map` / `Set` as state values** serialize as `{}` on the wire.
  State must remain JSON-serializable; the msgpack path now `throws`
  (see breaking changes above), but the JSON path still silently
  serializes them as empty.
- **`Date` is reference-compared** by `computeDeepDiff`; two equivalent
  Date instances emit a delta. Store timestamps as numbers.
- **`ComponentMessaging.emit()` accepts any string as `type`** — the
  `LiveMessage['type']` union is TypeScript-only. No runtime whitelist.
- **`onStateChange` reentrancy guard** — cascading `setState` inside
  `onStateChange` applies the change and emits a delta, but the hook
  itself is not re-entered. Intentional.

## [0.6.1] - 2026-04-10

- `fix: add null-deletion to React/Vue deepMerge, add benchmarks` (3c5f7b3)
- `fix: detect and apply key removals in deepDiff/deepAssign (fixes #1)` (b5a96bf)
- `fix: nonce Map capped at 100k entries to prevent DoS` (18424af)

## [0.6.0] - earlier

- Initial public baseline with async lifecycle, security fixes, and
  stability improvements. See commit `ce2844d`.
