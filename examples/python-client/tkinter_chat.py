"""
FluxStack Live - Tkinter Chat Client

A native desktop chat app powered by @fluxstack/live ChatRoom component.
Supports multiple rooms, real-time messages, and user presence.

Usage:
    pip install websockets
    python tkinter_chat.py

Requires the express-basic server running on localhost:4000
"""

import asyncio
import threading
import tkinter as tk
from tkinter import ttk
from queue import Queue

from client import LiveClient


class ChatApp:
    """Tkinter Chat connected to @fluxstack/live ChatRoom component."""

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("FluxStack Live Chat")
        self.root.configure(bg="#0f172a")
        self.root.geometry("700x560")
        self.root.minsize(600, 480)

        self._ui_queue: Queue = Queue()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._client: LiveClient | None = None
        self._chat = None  # LiveHandle
        self._chat_active = False  # Guard: True only while chat UI exists

        self._build_login_screen()
        self._start_async()
        self._poll_queue()

    # ===== UI: Login Screen =====

    def _build_login_screen(self):
        self._login_frame = tk.Frame(self.root, bg="#0f172a")
        self._login_frame.pack(expand=True, fill="both")

        inner = tk.Frame(self._login_frame, bg="#1e293b", padx=40, pady=35)
        inner.place(relx=0.5, rely=0.5, anchor="center")

        tk.Label(
            inner, text="FluxStack Live Chat", font=("Segoe UI", 22, "bold"),
            fg="#e2e8f0", bg="#1e293b",
        ).pack(pady=(0, 5))

        tk.Label(
            inner, text="Tkinter + @fluxstack/live WebSocket",
            font=("Segoe UI", 10), fg="#94a3b8", bg="#1e293b",
        ).pack(pady=(0, 25))

        # Username
        tk.Label(
            inner, text="Username", font=("Segoe UI", 10, "bold"),
            fg="#94a3b8", bg="#1e293b", anchor="w",
        ).pack(fill="x")

        self._username_entry = tk.Entry(
            inner, font=("Segoe UI", 13), bg="#0f172a", fg="#e2e8f0",
            insertbackground="#e2e8f0", relief="flat", width=28,
        )
        self._username_entry.pack(pady=(3, 15), ipady=6)
        self._username_entry.insert(0, "User")

        # Room buttons
        tk.Label(
            inner, text="Join a Room", font=("Segoe UI", 10, "bold"),
            fg="#94a3b8", bg="#1e293b", anchor="w",
        ).pack(fill="x", pady=(0, 8))

        rooms_frame = tk.Frame(inner, bg="#1e293b")
        rooms_frame.pack()

        btn_kw = dict(
            font=("Segoe UI", 12, "bold"), width=10, relief="flat",
            cursor="hand2", fg="white",
        )

        tk.Button(
            rooms_frame, text="general", bg="#3b82f6", activebackground="#2563eb",
            activeforeground="white",
            command=lambda: self._join("general"), **btn_kw,
        ).pack(side="left", padx=5)

        tk.Button(
            rooms_frame, text="tech", bg="#8b5cf6", activebackground="#7c3aed",
            activeforeground="white",
            command=lambda: self._join("tech"), **btn_kw,
        ).pack(side="left", padx=5)

        tk.Button(
            rooms_frame, text="random", bg="#f59e0b", activebackground="#d97706",
            activeforeground="white",
            command=lambda: self._join("random"), **btn_kw,
        ).pack(side="left", padx=5)

        # Status
        self._login_status = tk.StringVar(value="Connecting...")
        self._login_status_label = tk.Label(
            inner, textvariable=self._login_status, font=("Segoe UI", 9),
            fg="#94a3b8", bg="#1e293b",
        )
        self._login_status_label.pack(pady=(20, 0))

    # ===== UI: Chat Screen =====

    def _build_chat_screen(self):
        self._chat_active = True
        self._chat_frame = tk.Frame(self.root, bg="#0f172a")
        self._chat_frame.pack(expand=True, fill="both")

        # Top bar
        top = tk.Frame(self._chat_frame, bg="#1e293b", pady=8, padx=12)
        top.pack(fill="x")

        self._room_var = tk.StringVar(value="")
        tk.Label(
            top, textvariable=self._room_var, font=("Segoe UI", 14, "bold"),
            fg="#e2e8f0", bg="#1e293b",
        ).pack(side="left")

        # Room switch buttons
        for room, color in [("general", "#3b82f6"), ("tech", "#8b5cf6"), ("random", "#f59e0b")]:
            tk.Button(
                top, text=room, font=("Segoe UI", 9, "bold"), bg=color,
                fg="white", relief="flat", cursor="hand2", width=7,
                activebackground=color, activeforeground="white",
                command=lambda r=room: self._switch_room(r),
            ).pack(side="right", padx=2)

        tk.Label(
            top, text="Rooms:", font=("Segoe UI", 9),
            fg="#94a3b8", bg="#1e293b",
        ).pack(side="right", padx=(0, 5))

        tk.Button(
            top, text="Leave", font=("Segoe UI", 9, "bold"), bg="#ef4444",
            fg="white", relief="flat", cursor="hand2", width=5,
            activebackground="#dc2626", activeforeground="white",
            command=self._leave_room,
        ).pack(side="right", padx=(0, 10))

        # Main area: messages + users sidebar
        body = tk.Frame(self._chat_frame, bg="#0f172a")
        body.pack(expand=True, fill="both", padx=8, pady=(4, 0))

        # Messages area
        msg_frame = tk.Frame(body, bg="#1e293b")
        msg_frame.pack(side="left", expand=True, fill="both")

        self._messages_text = tk.Text(
            msg_frame, font=("Consolas", 10), bg="#1e293b", fg="#e2e8f0",
            relief="flat", state="disabled", wrap="word", padx=10, pady=8,
            spacing3=2,
        )
        self._messages_text.pack(expand=True, fill="both")

        # Message tags for styling
        self._messages_text.tag_configure("system", foreground="#94a3b8", font=("Consolas", 9, "italic"))
        self._messages_text.tag_configure("username", foreground="#38bdf8", font=("Consolas", 10, "bold"))
        self._messages_text.tag_configure("time", foreground="#64748b", font=("Consolas", 8))
        self._messages_text.tag_configure("msg", foreground="#e2e8f0")

        # Scrollbar
        scroll = ttk.Scrollbar(msg_frame, command=self._messages_text.yview)
        scroll.pack(side="right", fill="y")
        self._messages_text.configure(yscrollcommand=scroll.set)

        # Users sidebar
        users_frame = tk.Frame(body, bg="#0f172a", width=140)
        users_frame.pack(side="right", fill="y", padx=(6, 0))
        users_frame.pack_propagate(False)

        tk.Label(
            users_frame, text="Online", font=("Segoe UI", 10, "bold"),
            fg="#94a3b8", bg="#0f172a", anchor="w",
        ).pack(fill="x", pady=(4, 4))

        self._users_listbox = tk.Listbox(
            users_frame, font=("Segoe UI", 10), bg="#1e293b", fg="#22c55e",
            relief="flat", selectbackground="#334155", activestyle="none",
            highlightthickness=0,
        )
        self._users_listbox.pack(expand=True, fill="both")

        # Input bar
        input_frame = tk.Frame(self._chat_frame, bg="#1e293b", pady=8, padx=8)
        input_frame.pack(fill="x", padx=8, pady=(0, 8))

        self._msg_entry = tk.Entry(
            input_frame, font=("Segoe UI", 12), bg="#0f172a", fg="#e2e8f0",
            insertbackground="#e2e8f0", relief="flat",
        )
        self._msg_entry.pack(side="left", expand=True, fill="x", ipady=6, padx=(0, 8))
        self._msg_entry.bind("<Return>", lambda e: self._send_message())

        tk.Button(
            input_frame, text="Send", font=("Segoe UI", 11, "bold"),
            bg="#3b82f6", fg="white", relief="flat", cursor="hand2",
            width=8, activebackground="#2563eb", activeforeground="white",
            command=self._send_message,
        ).pack(side="right")

        # Connection status bar
        status_bar = tk.Frame(self._chat_frame, bg="#0f172a")
        status_bar.pack(fill="x", padx=8, pady=(0, 6))

        self._conn_status = tk.StringVar(value="Connected")
        tk.Label(
            status_bar, textvariable=self._conn_status, font=("Segoe UI", 8),
            fg="#22c55e", bg="#0f172a",
        ).pack(side="left")

    # ===== UI Helpers =====

    def _render_messages(self, messages):
        """Render all messages in the text widget."""
        if not self._chat_active:
            return
        self._messages_text.configure(state="normal")
        self._messages_text.delete("1.0", "end")

        for msg in messages:
            user = msg.get("user", "?")
            text = msg.get("text", "")
            time_str = msg.get("time", "")

            if user == "System":
                self._messages_text.insert("end", f"  {text}\n", "system")
            else:
                self._messages_text.insert("end", f"{user}", "username")
                self._messages_text.insert("end", f": {text} ", "msg")
                self._messages_text.insert("end", f"{time_str}\n", "time")

        self._messages_text.configure(state="disabled")
        self._messages_text.see("end")

    def _render_users(self, users):
        """Update the users listbox."""
        if not self._chat_active:
            return
        self._users_listbox.delete(0, "end")
        for user in users:
            self._users_listbox.insert("end", f"  {user}")

    # ===== Async Bridge =====

    def _start_async(self):
        def run_loop():
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            self._loop.run_until_complete(self._async_connect())

        thread = threading.Thread(target=run_loop, daemon=True)
        thread.start()

    def _poll_queue(self):
        while not self._ui_queue.empty():
            fn = self._ui_queue.get_nowait()
            fn()
        self.root.after(16, self._poll_queue)

    def _ui(self, fn):
        self._ui_queue.put(fn)

    async def _async_connect(self):
        """Connect to the server (no mount yet — wait for user to pick a room)."""
        self._client = LiveClient("ws://localhost:4000/api/live/ws")

        try:
            await self._client.connect()
        except Exception as e:
            self._ui(lambda: self._login_status.set(f"Failed: {e}"))
            return

        self._ui(lambda: self._login_status.set("Connected — choose a room"))
        self._ui(lambda: self._login_status_label.configure(fg="#22c55e"))

        # Keep alive
        try:
            while True:
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            pass

    async def _async_join(self, username: str, room_id: str):
        """Mount ChatRoom, set username, join room."""
        if self._chat:
            # Already mounted — just switch room
            try:
                await self._chat.call("joinRoom", {"roomId": room_id})
                self._ui(lambda: self._room_var.set(f"# {room_id}"))
            except Exception as e:
                self._ui(lambda: self._conn_status.set(f"Error: {e}"))
            return

        # Mount ChatRoom component
        self._chat = await self._client.use_live("ChatRoom", {
            "messages": [], "users": [], "currentRoom": "", "username": "",
        })

        # Watch messages
        self._chat.on("messages", lambda msgs: self._ui(
            lambda m=msgs: self._render_messages(m)
        ))

        # Watch users
        self._chat.on("users", lambda users: self._ui(
            lambda u=users: self._render_users(u)
        ))

        # Watch current room
        self._chat.on("currentRoom", lambda room: self._ui(
            lambda r=room: self._room_var.set(f"# {r}" if r else "No room") if self._chat_active else None
        ))

        # Set username and join
        try:
            await self._chat.call("setUsername", {"username": username})
            await self._chat.call("joinRoom", {"roomId": room_id})
        except Exception as e:
            self._ui(lambda: self._conn_status.set(f"Error: {e}"))

    async def _async_send(self, text: str):
        if not self._chat:
            return
        try:
            await self._chat.call("sendMessage", {"text": text})
        except Exception as e:
            self._ui(lambda: self._conn_status.set(f"Send error: {e}"))

    async def _async_leave(self):
        if not self._chat:
            return
        try:
            await self._chat.call("leaveRoom")
            await self._chat.destroy()
            self._chat = None
        except Exception:
            pass

    # ===== Actions (from Tkinter buttons) =====

    def _join(self, room_id: str):
        """Called from login screen — transition to chat."""
        if not self._loop or not self._client:
            return

        username = self._username_entry.get().strip() or "User"

        # Switch to chat screen
        self._login_frame.destroy()
        self._build_chat_screen()
        self._room_var.set(f"# {room_id}")
        self._msg_entry.focus_set()

        asyncio.run_coroutine_threadsafe(
            self._async_join(username, room_id), self._loop
        )

    def _switch_room(self, room_id: str):
        """Switch to another room (already in chat screen)."""
        if not self._loop or not self._chat:
            return
        asyncio.run_coroutine_threadsafe(
            self._async_join("", room_id), self._loop
        )

    def _send_message(self):
        """Send message from entry field."""
        if not self._loop or not self._chat:
            return
        text = self._msg_entry.get().strip()
        if not text:
            return
        self._msg_entry.delete(0, "end")
        asyncio.run_coroutine_threadsafe(
            self._async_send(text), self._loop
        )

    def _leave_room(self):
        """Leave current room and go back to login."""
        self._chat_active = False  # Stop watchers from updating destroyed widgets

        if self._loop:
            asyncio.run_coroutine_threadsafe(
                self._async_leave(), self._loop
            )

        # Switch back to login screen
        self._chat_frame.destroy()
        self._build_login_screen()
        if self._client:
            self._ui(lambda: self._login_status.set("Connected — choose a room"))
            self._ui(lambda: self._login_status_label.configure(fg="#22c55e"))

    # ===== Run =====

    def run(self):
        self.root.mainloop()

    def destroy(self):
        if self._loop and self._chat:
            asyncio.run_coroutine_threadsafe(self._async_leave(), self._loop)
        if self._loop and self._client:
            asyncio.run_coroutine_threadsafe(self._client.disconnect(), self._loop)


if __name__ == "__main__":
    app = ChatApp()
    try:
        app.run()
    finally:
        app.destroy()
