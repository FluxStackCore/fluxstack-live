"""
FluxStack Live - Python Client Example

Connects to an express-basic (or any @fluxstack/live) server via WebSocket,
mounts a Counter component, and interacts with it from Python.

Features:
    - Reactive state proxy (like React's useState / Vue's ref)
    - useLive() high-level API matching the JS client
    - Per-key watchers: counter.on("count", lambda v: ...)
    - Full state watchers: counter.on(lambda state, delta: ...)

Usage:
    pip install websockets
    python client.py

Requires the express-basic server running on localhost:4000
"""

import asyncio
import json
import time
import uuid
from typing import Any, Callable

import websockets


# ===== Reactive State Proxy =====

class ReactiveState:
    """Reactive state container that notifies watchers on changes.

    Mirrors the behavior of React's useState / Vue's reactive():
    - Access properties directly: state.count
    - Watch all changes: state.on(callback)
    - Watch specific keys: state.on("count", callback)

    State is read-only from the consumer side — updates come from the server
    via WebSocket STATE_UPDATE / STATE_DELTA messages.
    """

    def __init__(self, initial: dict):
        object.__setattr__(self, '_data', dict(initial))
        object.__setattr__(self, '_watchers', [])       # list of (state, delta) -> None
        object.__setattr__(self, '_key_watchers', {})    # key -> list of (value) -> None

    def __getattr__(self, name: str) -> Any:
        data = object.__getattribute__(self, '_data')
        if name in data:
            return data[name]
        raise AttributeError(f"State has no property '{name}'")

    def __setattr__(self, name: str, value: Any):
        # State is server-driven — block direct writes from user code
        raise AttributeError(
            "State is read-only. Use call() to trigger server actions."
        )

    def __getitem__(self, key: str) -> Any:
        return object.__getattribute__(self, '_data')[key]

    def __contains__(self, key: str) -> bool:
        return key in object.__getattribute__(self, '_data')

    def __repr__(self) -> str:
        return f"ReactiveState({object.__getattribute__(self, '_data')})"

    def _to_dict(self) -> dict:
        return dict(object.__getattribute__(self, '_data'))

    def _update_full(self, new_state: dict):
        """Replace entire state (from STATE_UPDATE). Notifies watchers."""
        data = object.__getattribute__(self, '_data')
        old = dict(data)
        data.clear()
        data.update(new_state)
        delta = {k: v for k, v in new_state.items() if old.get(k) != v}
        self._fire(new_state, delta)

    def _update_delta(self, delta: dict):
        """Merge delta into state (from STATE_DELTA). Notifies watchers."""
        data = object.__getattribute__(self, '_data')
        data.update(delta)
        self._fire(dict(data), delta)

    def _fire(self, state: dict, delta: dict):
        """Notify all watchers."""
        for cb in object.__getattribute__(self, '_watchers'):
            cb(state, delta)
        key_watchers = object.__getattribute__(self, '_key_watchers')
        for key, value in delta.items():
            for cb in key_watchers.get(key, []):
                cb(value)

    def _watch(self, callback) -> Callable:
        """Watch all state changes. Returns unsubscribe function."""
        watchers = object.__getattribute__(self, '_watchers')
        watchers.append(callback)
        return lambda: watchers.remove(callback)

    def _watch_key(self, key: str, callback) -> Callable:
        """Watch a single key. Returns unsubscribe function."""
        key_watchers = object.__getattribute__(self, '_key_watchers')
        key_watchers.setdefault(key, []).append(callback)
        return lambda: key_watchers[key].remove(callback)


# ===== LiveHandle (useLive result) =====

class LiveHandle:
    """High-level handle for a live component — mirrors JS useLive() API.

    Usage:
        counter = await client.use_live("Counter", {"count": 0})
        counter.state.count          # reactive read
        counter.on(lambda s, d: ...) # watch all changes
        counter.on("count", cb)      # watch single key
        await counter.call("increment")
        await counter.destroy()
    """

    def __init__(self, client: 'LiveClient', component_id: str, state: ReactiveState):
        self._client = client
        self._component_id = component_id
        self.state = state
        self._error_cbs: list[Callable] = []

    async def call(self, action: str, payload: dict = None) -> Any:
        """Call a server action."""
        return await self._client.call(self._component_id, action, payload)

    def on(self, key_or_callback, callback=None) -> Callable:
        """Subscribe to state changes.

        Overloaded:
            handle.on(callback)          -> watch all state changes
            handle.on("count", callback) -> watch a single key
        Returns an unsubscribe function.
        """
        if callback is None:
            # on(callback) — full state watcher
            return self.state._watch(key_or_callback)
        else:
            # on("key", callback) — per-key watcher
            return self.state._watch_key(key_or_callback, callback)

    def on_error(self, callback: Callable[[str], None]) -> Callable:
        """Subscribe to errors. Returns unsubscribe function."""
        self._error_cbs.append(callback)
        return lambda: self._error_cbs.remove(callback)

    @property
    def component_id(self) -> str:
        return self._component_id

    @property
    def mounted(self) -> bool:
        return self._component_id in self._client.components

    async def destroy(self):
        """Unmount the component and clean up."""
        await self._client.unmount(self._component_id)

    def __repr__(self) -> str:
        return f"LiveHandle({self._component_id}, {self.state})"


class LiveClient:
    """Minimal Python client for @fluxstack/live WebSocket protocol."""

    def __init__(self, url: str = "ws://localhost:4000/api/live/ws"):
        self.url = url
        self.ws = None
        self.connection_id: str | None = None
        self.components: dict[str, dict] = {}  # componentId -> state (raw dict)
        self._handles: dict[str, LiveHandle] = {}  # componentId -> LiveHandle
        self._pending: dict[str, asyncio.Future] = {}  # requestId -> Future
        self._listeners: dict[str, list] = {}  # componentId -> [callbacks]
        self._running = False

    # --- Connection ---

    async def connect(self):
        self.ws = await websockets.connect(self.url)
        self._running = True
        self._recv_task = asyncio.create_task(self._recv_loop())

        # Wait for CONNECTION_ESTABLISHED
        msg = await asyncio.wait_for(self._wait_for_type("CONNECTION_ESTABLISHED"), timeout=5)
        self.connection_id = msg.get("connectionId")
        print(f"[connected] id={self.connection_id}")

    async def disconnect(self):
        self._running = False
        if self.ws:
            await self.ws.close()
        if hasattr(self, "_recv_task"):
            self._recv_task.cancel()
            try:
                await self._recv_task
            except asyncio.CancelledError:
                pass

    # --- Component Lifecycle ---

    async def mount(self, component_name: str, initial_state: dict = None) -> str:
        """Mount a component. Returns the server-assigned componentId."""
        request_id = self._make_request_id()
        msg = {
            "type": "COMPONENT_MOUNT",
            "componentId": f"mount-{component_name}",
            "payload": {
                "component": component_name,
                "props": initial_state or {},
            },
            "timestamp": self._now(),
            "expectResponse": True,
            "requestId": request_id,
        }
        result = await self._send_and_wait(msg, request_id)

        component_id = result.get("result", {}).get("componentId", result.get("componentId"))
        state = result.get("result", {}).get("initialState", initial_state or {})
        self.components[component_id] = state
        print(f"[mounted] {component_name} -> {component_id}")
        print(f"  state: {state}")
        return component_id

    async def unmount(self, component_id: str):
        """Unmount a component."""
        request_id = self._make_request_id()
        msg = {
            "type": "COMPONENT_UNMOUNT",
            "componentId": component_id,
            "timestamp": self._now(),
            "expectResponse": True,
            "requestId": request_id,
        }
        await self._send_and_wait(msg, request_id)
        self.components.pop(component_id, None)
        self._handles.pop(component_id, None)
        print(f"[unmounted] {component_id}")

    # --- Actions ---

    async def call(self, component_id: str, action: str, payload: dict = None):
        """Call a server action. Returns the action result."""
        request_id = self._make_request_id()
        msg = {
            "type": "CALL_ACTION",
            "componentId": component_id,
            "action": action,
            "payload": payload or {},
            "timestamp": self._now(),
            "expectResponse": True,
            "requestId": request_id,
        }
        result = await self._send_and_wait(msg, request_id)

        if not result.get("success", False):
            raise Exception(f"Action failed: {result.get('error', 'unknown')}")

        print(f"[action] {action} -> {result.get('result')}")
        return result.get("result")

    # --- State ---

    def get_state(self, component_id: str) -> dict:
        return self.components.get(component_id, {})

    def on_state(self, component_id: str, callback):
        """Register a callback for state changes on a component."""
        self._listeners.setdefault(component_id, []).append(callback)

    # --- useLive (high-level reactive API) ---

    async def use_live(self, component_name: str, initial_state: dict = None) -> LiveHandle:
        """Mount a component and return a reactive handle — mirrors JS useLive().

        Usage:
            counter = await client.use_live("Counter", {"count": 0})
            counter.state.count               # reactive read
            counter.on("count", lambda v: ...) # per-key watcher
            counter.on(lambda s, d: ...)       # full state watcher
            await counter.call("increment")
            await counter.destroy()
        """
        component_id = await self.mount(component_name, initial_state)
        state = ReactiveState(self.components.get(component_id, initial_state or {}))
        handle = LiveHandle(self, component_id, state)
        self._handles[component_id] = handle
        return handle

    # --- Internals ---

    def _now(self) -> int:
        return int(time.time() * 1000)

    def _make_request_id(self) -> str:
        return f"py-{self._now()}-{uuid.uuid4().hex[:8]}"

    async def _send(self, msg: dict):
        await self.ws.send(json.dumps(msg))

    async def _send_and_wait(self, msg: dict, request_id: str, timeout: float = 10) -> dict:
        future = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future
        await self._send(msg)
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(request_id, None)

    async def _wait_for_type(self, msg_type: str, timeout: float = 5) -> dict:
        """Wait for a specific message type (used for CONNECTION_ESTABLISHED)."""
        future = asyncio.get_event_loop().create_future()
        self._pending[f"__type__{msg_type}"] = future
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(f"__type__{msg_type}", None)

    async def _recv_loop(self):
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                msg_type = msg.get("type", "")
                request_id = msg.get("requestId")
                component_id = msg.get("componentId")

                # Resolve type-based waiters (CONNECTION_ESTABLISHED, etc.)
                type_key = f"__type__{msg_type}"
                if type_key in self._pending:
                    self._pending[type_key].set_result(msg)
                    continue

                # Resolve request-based waiters
                if request_id and request_id in self._pending:
                    self._pending[request_id].set_result(msg)

                # Handle state updates
                if msg_type == "STATE_UPDATE" and component_id:
                    state = msg.get("payload", {}).get("state", {})
                    self.components[component_id] = state
                    # Update reactive state on LiveHandle (if exists)
                    handle = self._handles.get(component_id)
                    if handle:
                        handle.state._update_full(state)
                    self._notify(component_id, state, None)

                elif msg_type == "STATE_DELTA" and component_id:
                    delta = msg.get("payload", {}).get("delta", {})
                    if component_id in self.components:
                        self.components[component_id].update(delta)
                    # Update reactive state on LiveHandle (if exists)
                    handle = self._handles.get(component_id)
                    if handle:
                        handle.state._update_delta(delta)
                    self._notify(component_id, self.components.get(component_id, {}), delta)

                elif msg_type == "ERROR":
                    error_msg = msg.get("error", "unknown error")
                    print(f"[error] {error_msg}")
                    # Notify error callbacks on relevant LiveHandle
                    if component_id:
                        handle = self._handles.get(component_id)
                        if handle:
                            for cb in handle._error_cbs:
                                cb(error_msg)

        except websockets.ConnectionClosed:
            print("[disconnected]")
        except asyncio.CancelledError:
            pass

    def _notify(self, component_id: str, state: dict, delta: dict | None):
        for cb in self._listeners.get(component_id, []):
            cb(state, delta)


# ===== Interactive Demo — Reactive useLive() API =====

async def main():
    client = LiveClient("ws://localhost:4000/api/live/ws")

    print("=" * 50)
    print("  FluxStack Live - Python Reactive Client")
    print("=" * 50)
    print()

    # Connect
    await client.connect()
    print()

    # Mount Counter using reactive useLive() — mirrors the JS API
    counter = await client.use_live("Counter", {"count": 0})
    print()

    # Per-key watcher: fires only when "count" changes
    counter.on("count", lambda value: print(f"  >> count is now: {value}"))

    # Full state watcher (like JS counter.on(state => ...))
    counter.on(lambda state, delta: print(f"  [reactive] state={state} delta={delta}"))

    # Error watcher
    counter.on_error(lambda err: print(f"  [error] {err}"))

    await asyncio.sleep(0.5)

    # Call actions using the handle — no component_id needed
    print("--- Incrementing 3 times ---")
    for i in range(3):
        await counter.call("increment")
        await asyncio.sleep(0.3)

    # Read state reactively — just access the property
    print()
    print(f"counter.state.count = {counter.state.count}")
    print(f"counter.state = {counter.state}")
    print()

    # Decrement
    print("--- Decrementing once ---")
    await counter.call("decrement")
    await asyncio.sleep(0.3)
    print(f"counter.state.count = {counter.state.count}")
    print()

    # Reset
    print("--- Resetting ---")
    await counter.call("reset")
    await asyncio.sleep(0.3)
    print(f"counter.state.count = {counter.state.count}")
    print()

    # Verify state is read-only
    print("--- Testing read-only protection ---")
    try:
        counter.state.count = 999
    except AttributeError as e:
        print(f"  (blocked) {e}")
    print()

    # Destroy (unmount + cleanup)
    await counter.destroy()
    print()

    # Disconnect
    await client.disconnect()
    print("Done!")


if __name__ == "__main__":
    asyncio.run(main())
