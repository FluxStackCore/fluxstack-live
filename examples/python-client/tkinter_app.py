"""
FluxStack Live - Tkinter GUI Example

A native desktop Counter app powered by @fluxstack/live via WebSocket.
Demonstrates that Live Components work beyond the browser — any Python
GUI can be a real-time client.

Usage:
    pip install websockets
    python tkinter_app.py

Requires the express-basic server running on localhost:4000
"""

import asyncio
import threading
import tkinter as tk
from queue import Queue

# Import the LiveClient from our client module
from client import LiveClient


class CounterApp:
    """Tkinter Counter connected to @fluxstack/live server."""

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("FluxStack Live - Tkinter Counter")
        self.root.configure(bg="#0f172a")
        self.root.resizable(False, False)

        # Queue for thread-safe UI updates from asyncio
        self._ui_queue: Queue = Queue()

        # Asyncio references (set after connect)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._client: LiveClient | None = None
        self._counter = None  # LiveHandle

        self._build_ui()
        self._start_async()
        self._poll_queue()

    # ===== UI =====

    def _build_ui(self):
        root = self.root

        # Card frame
        card = tk.Frame(root, bg="#1e293b", padx=40, pady=30)
        card.pack(padx=30, pady=30)

        # Title
        tk.Label(
            card, text="Live Counter", font=("Segoe UI", 20, "bold"),
            fg="#e2e8f0", bg="#1e293b",
        ).pack()

        tk.Label(
            card, text="Tkinter + @fluxstack/live", font=("Segoe UI", 10),
            fg="#94a3b8", bg="#1e293b",
        ).pack(pady=(0, 15))

        # Count display
        self.count_var = tk.StringVar(value="0")
        tk.Label(
            card, textvariable=self.count_var, font=("Segoe UI", 64, "bold"),
            fg="#38bdf8", bg="#1e293b",
        ).pack(pady=(10, 5))

        # Last action
        self.action_var = tk.StringVar(value="--")
        tk.Label(
            card, textvariable=self.action_var, font=("Segoe UI", 9),
            fg="#94a3b8", bg="#1e293b",
        ).pack(pady=(0, 20))

        # Buttons
        btn_frame = tk.Frame(card, bg="#1e293b")
        btn_frame.pack()

        btn_style = dict(font=("Segoe UI", 14, "bold"), width=6, relief="flat", cursor="hand2")

        tk.Button(
            btn_frame, text="-", bg="#ef4444", fg="white",
            activebackground="#dc2626", activeforeground="white",
            command=lambda: self._call_action("decrement"), **btn_style,
        ).pack(side="left", padx=5)

        tk.Button(
            btn_frame, text="Reset", bg="#64748b", fg="white",
            activebackground="#475569", activeforeground="white",
            command=lambda: self._call_action("reset"), **btn_style,
        ).pack(side="left", padx=5)

        tk.Button(
            btn_frame, text="+", bg="#22c55e", fg="white",
            activebackground="#16a34a", activeforeground="white",
            command=lambda: self._call_action("increment"), **btn_style,
        ).pack(side="left", padx=5)

        # Status bar
        self.status_var = tk.StringVar(value="Connecting...")
        self.status_label = tk.Label(
            card, textvariable=self.status_var, font=("Segoe UI", 9),
            fg="#94a3b8", bg="#0f172a", padx=15, pady=8,
        )
        self.status_label.pack(fill="x", pady=(20, 0))

        # Log area
        self.log_text = tk.Text(
            card, height=6, width=45, font=("Consolas", 8),
            bg="#0f172a", fg="#94a3b8", relief="flat", state="disabled",
            wrap="word",
        )
        self.log_text.pack(fill="x", pady=(10, 0))

    def _log(self, msg: str):
        """Append a message to the log area (must run on main thread)."""
        self.log_text.configure(state="normal")
        self.log_text.insert("end", msg + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    # ===== Async Bridge =====

    def _start_async(self):
        """Start the asyncio event loop in a background thread."""
        def run_loop():
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            self._loop.run_until_complete(self._async_main())

        thread = threading.Thread(target=run_loop, daemon=True)
        thread.start()

    def _poll_queue(self):
        """Poll the UI queue from the main thread (Tkinter-safe)."""
        while not self._ui_queue.empty():
            fn = self._ui_queue.get_nowait()
            fn()
        self.root.after(16, self._poll_queue)  # ~60fps

    def _ui(self, fn):
        """Schedule a function to run on the main (Tkinter) thread."""
        self._ui_queue.put(fn)

    async def _async_main(self):
        """Connect to the server and mount the Counter component."""
        self._client = LiveClient("ws://localhost:4000/api/live/ws")

        try:
            await self._client.connect()
        except Exception as e:
            self._ui(lambda: self.status_var.set(f"Connection failed: {e}"))
            self._ui(lambda: self.status_label.configure(fg="#ef4444"))
            return

        self._ui(lambda: self.status_var.set("Connected"))
        self._ui(lambda: self.status_label.configure(fg="#22c55e"))
        self._ui(lambda: self._log(f"Connected: {self._client.connection_id}"))

        # Mount Counter with reactive useLive()
        self._counter = await self._client.use_live("Counter", {"count": 0})

        self._ui(lambda: self._log(f"Mounted: {self._counter.component_id}"))

        # Per-key watcher on "count" — updates the big number
        self._counter.on("count", lambda value: self._ui(
            lambda v=value: self.count_var.set(str(v))
        ))

        # Per-key watcher on "lastAction" — updates the subtitle
        self._counter.on("lastAction", lambda value: self._ui(
            lambda v=value: self.action_var.set(f"last: {v}" if v else "--")
        ))

        # Full state watcher for logging
        self._counter.on(lambda state, delta: self._ui(
            lambda d=delta: self._log(f"delta: {d}")
        ))

        # Error watcher
        self._counter.on_error(lambda err: self._ui(
            lambda e=err: self._log(f"ERROR: {e}")
        ))

        # Keep the async loop alive (recv_loop runs as a task)
        try:
            while True:
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            pass

    def _call_action(self, action: str):
        """Schedule a server action call from a Tkinter button click."""
        if not self._loop or not self._counter:
            return
        asyncio.run_coroutine_threadsafe(
            self._counter.call(action), self._loop
        )

    # ===== Run =====

    def run(self):
        self.root.mainloop()

    def destroy(self):
        if self._loop and self._counter:
            asyncio.run_coroutine_threadsafe(
                self._counter.destroy(), self._loop
            )
        if self._loop and self._client:
            asyncio.run_coroutine_threadsafe(
                self._client.disconnect(), self._loop
            )


if __name__ == "__main__":
    app = CounterApp()
    try:
        app.run()
    finally:
        app.destroy()
