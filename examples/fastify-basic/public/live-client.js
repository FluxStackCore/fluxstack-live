"use strict";
var FluxstackLive = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/index.ts
  var src_exports = {};
  __export(src_exports, {
    AdaptiveChunkSizer: () => AdaptiveChunkSizer,
    ChunkedUploader: () => ChunkedUploader,
    LiveComponentHandle: () => LiveComponentHandle,
    LiveConnection: () => LiveConnection,
    RoomManager: () => RoomManager,
    StateValidator: () => StateValidator,
    clearPersistedState: () => clearPersistedState,
    createBinaryChunkMessage: () => createBinaryChunkMessage,
    getConnection: () => getConnection,
    getPersistedState: () => getPersistedState,
    onConnectionChange: () => onConnectionChange,
    persistState: () => persistState,
    useLive: () => useLive
  });

  // src/connection.ts
  var LiveConnection = class {
    constructor(options = {}) {
      __publicField(this, "ws", null);
      __publicField(this, "options");
      __publicField(this, "reconnectAttempts", 0);
      __publicField(this, "reconnectTimeout", null);
      __publicField(this, "heartbeatInterval", null);
      __publicField(this, "componentCallbacks", /* @__PURE__ */ new Map());
      __publicField(this, "pendingRequests", /* @__PURE__ */ new Map());
      __publicField(this, "stateListeners", /* @__PURE__ */ new Set());
      __publicField(this, "_state", {
        connected: false,
        connecting: false,
        error: null,
        connectionId: null,
        authenticated: false
      });
      this.options = {
        url: options.url,
        auth: options.auth,
        autoConnect: options.autoConnect ?? true,
        reconnectInterval: options.reconnectInterval ?? 1e3,
        maxReconnectAttempts: options.maxReconnectAttempts ?? 5,
        heartbeatInterval: options.heartbeatInterval ?? 3e4,
        debug: options.debug ?? false
      };
      if (this.options.autoConnect) {
        this.connect();
      }
    }
    get state() {
      return { ...this._state };
    }
    /** Subscribe to connection state changes */
    onStateChange(callback) {
      this.stateListeners.add(callback);
      return () => {
        this.stateListeners.delete(callback);
      };
    }
    setState(patch) {
      this._state = { ...this._state, ...patch };
      for (const cb of this.stateListeners) {
        cb(this._state);
      }
    }
    getWebSocketUrl() {
      const auth = this.options.auth;
      let baseUrl;
      if (this.options.url) {
        baseUrl = this.options.url;
      } else if (typeof window === "undefined") {
        baseUrl = "ws://localhost:3000/api/live/ws";
      } else {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        baseUrl = `${protocol}//${window.location.host}/api/live/ws`;
      }
      if (auth?.token) {
        const separator = baseUrl.includes("?") ? "&" : "?";
        return `${baseUrl}${separator}token=${encodeURIComponent(auth.token)}`;
      }
      return baseUrl;
    }
    log(message, data) {
      if (this.options.debug) {
        console.log(`[LiveConnection] ${message}`, data || "");
      }
    }
    /** Generate unique request ID */
    generateRequestId() {
      return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    /** Connect to WebSocket server */
    connect() {
      if (this.ws?.readyState === WebSocket.CONNECTING) {
        this.log("Already connecting, skipping...");
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.log("Already connected, skipping...");
        return;
      }
      this.setState({ connecting: true, error: null });
      const url = this.getWebSocketUrl();
      this.log("Connecting...", { url });
      try {
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.onopen = () => {
          this.log("Connected");
          this.setState({ connected: true, connecting: false });
          this.reconnectAttempts = 0;
          this.startHeartbeat();
        };
        ws.onmessage = (event) => {
          try {
            const response = JSON.parse(event.data);
            this.log("Received", { type: response.type, componentId: response.componentId });
            this.handleMessage(response);
          } catch {
            this.log("Failed to parse message");
            this.setState({ error: "Failed to parse message" });
          }
        };
        ws.onclose = () => {
          this.log("Disconnected");
          this.setState({ connected: false, connecting: false, connectionId: null });
          this.stopHeartbeat();
          this.attemptReconnect();
        };
        ws.onerror = () => {
          this.log("WebSocket error");
          this.setState({ error: "WebSocket connection error", connecting: false });
        };
      } catch (error) {
        this.setState({
          connecting: false,
          error: error instanceof Error ? error.message : "Connection failed"
        });
      }
    }
    /** Disconnect from WebSocket server */
    disconnect() {
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      this.stopHeartbeat();
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.reconnectAttempts = this.options.maxReconnectAttempts;
      this.setState({ connected: false, connecting: false, connectionId: null });
    }
    /** Manual reconnect */
    reconnect() {
      this.disconnect();
      this.reconnectAttempts = 0;
      setTimeout(() => this.connect(), 100);
    }
    attemptReconnect() {
      if (this.reconnectAttempts < this.options.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.log(`Reconnecting... (${this.reconnectAttempts}/${this.options.maxReconnectAttempts})`);
        this.reconnectTimeout = setTimeout(() => this.connect(), this.options.reconnectInterval);
      } else {
        this.setState({ error: "Max reconnection attempts reached" });
      }
    }
    startHeartbeat() {
      this.stopHeartbeat();
      this.heartbeatInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          for (const componentId of this.componentCallbacks.keys()) {
            this.sendMessage({
              type: "COMPONENT_PING",
              componentId,
              timestamp: Date.now()
            }).catch(() => {
            });
          }
        }
      }, this.options.heartbeatInterval);
    }
    stopHeartbeat() {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
    }
    handleMessage(response) {
      if (response.type === "CONNECTION_ESTABLISHED") {
        this.setState({
          connectionId: response.connectionId || null,
          authenticated: response.authenticated || false
        });
        const auth = this.options.auth;
        if (auth && !auth.token && Object.keys(auth).some((k) => auth[k])) {
          this.sendMessageAndWait({ type: "AUTH", payload: auth }).then((authResp) => {
            if (authResp.authenticated) {
              this.setState({ authenticated: true });
            }
          }).catch(() => {
          });
        }
      }
      if (response.type === "AUTH_RESPONSE") {
        this.setState({ authenticated: response.authenticated || false });
      }
      if (response.requestId && this.pendingRequests.has(response.requestId)) {
        const request = this.pendingRequests.get(response.requestId);
        clearTimeout(request.timeout);
        this.pendingRequests.delete(response.requestId);
        if (response.success !== false) {
          request.resolve(response);
        } else {
          if (response.error?.includes?.("COMPONENT_REHYDRATION_REQUIRED")) {
            request.resolve(response);
          } else {
            request.reject(new Error(response.error || "Request failed"));
          }
        }
        return;
      }
      if (response.type === "BROADCAST") {
        this.componentCallbacks.forEach((callback, compId) => {
          if (compId !== response.componentId) {
            callback(response);
          }
        });
        return;
      }
      if (response.componentId) {
        const callback = this.componentCallbacks.get(response.componentId);
        if (callback) {
          callback(response);
        } else {
          this.log("No callback registered for component:", response.componentId);
        }
      }
    }
    /** Send message without waiting for response */
    async sendMessage(message) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket is not connected");
      }
      const messageWithTimestamp = { ...message, timestamp: Date.now() };
      this.ws.send(JSON.stringify(messageWithTimestamp));
      this.log("Sent", { type: message.type, componentId: message.componentId });
    }
    /** Send message and wait for response */
    async sendMessageAndWait(message, timeout = 1e4) {
      return new Promise((resolve, reject) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          reject(new Error("WebSocket is not connected"));
          return;
        }
        const requestId = this.generateRequestId();
        const timeoutHandle = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(new Error(`Request timeout after ${timeout}ms`));
        }, timeout);
        this.pendingRequests.set(requestId, { resolve, reject, timeout: timeoutHandle });
        try {
          const messageWithRequestId = {
            ...message,
            requestId,
            expectResponse: true,
            timestamp: Date.now()
          };
          this.ws.send(JSON.stringify(messageWithRequestId));
          this.log("Sent with requestId", { requestId, type: message.type });
        } catch (error) {
          clearTimeout(timeoutHandle);
          this.pendingRequests.delete(requestId);
          reject(error);
        }
      });
    }
    /** Send binary data and wait for response (for file uploads) */
    async sendBinaryAndWait(data, requestId, timeout = 1e4) {
      return new Promise((resolve, reject) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          reject(new Error("WebSocket is not connected"));
          return;
        }
        const timeoutHandle = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(new Error(`Binary request timeout after ${timeout}ms`));
        }, timeout);
        this.pendingRequests.set(requestId, { resolve, reject, timeout: timeoutHandle });
        try {
          this.ws.send(data);
          this.log("Sent binary", { requestId, size: data.byteLength });
        } catch (error) {
          clearTimeout(timeoutHandle);
          this.pendingRequests.delete(requestId);
          reject(error);
        }
      });
    }
    /** Register a component message callback */
    registerComponent(componentId, callback) {
      this.log("Registering component", componentId);
      this.componentCallbacks.set(componentId, callback);
      return () => {
        this.componentCallbacks.delete(componentId);
        this.log("Unregistered component", componentId);
      };
    }
    /** Unregister a component */
    unregisterComponent(componentId) {
      this.componentCallbacks.delete(componentId);
    }
    /** Authenticate (or re-authenticate) the WebSocket connection */
    async authenticate(credentials) {
      try {
        const response = await this.sendMessageAndWait(
          { type: "AUTH", payload: credentials },
          5e3
        );
        const success = response.authenticated || false;
        this.setState({ authenticated: success });
        return success;
      } catch {
        return false;
      }
    }
    /** Get the raw WebSocket instance */
    getWebSocket() {
      return this.ws;
    }
    /** Destroy the connection and clean up all resources */
    destroy() {
      this.disconnect();
      this.componentCallbacks.clear();
      for (const [, req] of this.pendingRequests) {
        clearTimeout(req.timeout);
        req.reject(new Error("Connection destroyed"));
      }
      this.pendingRequests.clear();
      this.stateListeners.clear();
    }
  };

  // src/component.ts
  var LiveComponentHandle = class {
    constructor(connection, componentName, options = {}) {
      __publicField(this, "connection");
      __publicField(this, "componentName");
      __publicField(this, "options");
      __publicField(this, "_componentId", null);
      __publicField(this, "_state");
      __publicField(this, "_mounted", false);
      __publicField(this, "_mounting", false);
      __publicField(this, "_error", null);
      __publicField(this, "stateListeners", /* @__PURE__ */ new Set());
      __publicField(this, "errorListeners", /* @__PURE__ */ new Set());
      __publicField(this, "unregisterComponent", null);
      __publicField(this, "unsubConnection", null);
      this.connection = connection;
      this.componentName = componentName;
      this._state = options.initialState ?? {};
      this.options = {
        initialState: options.initialState ?? {},
        room: options.room,
        userId: options.userId,
        autoMount: options.autoMount ?? true,
        debug: options.debug ?? false
      };
      if (this.options.autoMount) {
        if (this.connection.state.connected) {
          this.mount();
        }
        this.unsubConnection = this.connection.onStateChange((connState) => {
          if (connState.connected && !this._mounted && !this._mounting) {
            this.mount();
          }
        });
      }
    }
    // ── Getters ──
    /** Current component state */
    get state() {
      return this._state;
    }
    /** Server-assigned component ID (null before mount) */
    get componentId() {
      return this._componentId;
    }
    /** Whether the component has been mounted */
    get mounted() {
      return this._mounted;
    }
    /** Whether the component is currently mounting */
    get mounting() {
      return this._mounting;
    }
    /** Last error message */
    get error() {
      return this._error;
    }
    // ── Lifecycle ──
    /** Mount the component on the server */
    async mount() {
      if (this._mounted || this._mounting) return;
      if (!this.connection.state.connected) {
        throw new Error("Cannot mount: not connected");
      }
      this._mounting = true;
      this._error = null;
      this.log("Mounting...");
      try {
        const response = await this.connection.sendMessageAndWait({
          type: "COMPONENT_MOUNT",
          componentId: `mount-${this.componentName}`,
          payload: {
            component: this.componentName,
            props: this.options.initialState,
            room: this.options.room,
            userId: this.options.userId
          }
        });
        if (!response.success) {
          throw new Error(response.error || "Mount failed");
        }
        const result = response.result;
        this._componentId = result.componentId;
        this._mounted = true;
        this._mounting = false;
        const serverState = result.initialState || {};
        this._state = { ...this._state, ...serverState };
        this.unregisterComponent = this.connection.registerComponent(
          this._componentId,
          (msg) => this.handleServerMessage(msg)
        );
        this.log("Mounted", { componentId: this._componentId });
        this.notifyStateChange(this._state, null);
      } catch (err) {
        this._mounting = false;
        const errorMsg = err instanceof Error ? err.message : String(err);
        this._error = errorMsg;
        this.notifyError(errorMsg);
        throw err;
      }
    }
    /** Unmount the component from the server */
    async unmount() {
      if (!this._mounted || !this._componentId) return;
      this.log("Unmounting...");
      try {
        await this.connection.sendMessage({
          type: "COMPONENT_UNMOUNT",
          componentId: this._componentId
        });
      } catch {
      }
      this.cleanup();
    }
    /** Destroy the handle and clean up all resources */
    destroy() {
      this.unmount().catch(() => {
      });
      if (this.unsubConnection) {
        this.unsubConnection();
        this.unsubConnection = null;
      }
      this.stateListeners.clear();
      this.errorListeners.clear();
    }
    // ── Actions ──
    /**
     * Call an action on the server component.
     * Returns the action's return value.
     */
    async call(action, payload = {}) {
      if (!this._mounted || !this._componentId) {
        throw new Error(`Cannot call '${action}': component not mounted`);
      }
      this.log(`Calling action: ${action}`, payload);
      const response = await this.connection.sendMessageAndWait({
        type: "CALL_ACTION",
        componentId: this._componentId,
        action,
        payload
      });
      if (!response.success) {
        const errorMsg = response.error || `Action '${action}' failed`;
        this._error = errorMsg;
        this.notifyError(errorMsg);
        throw new Error(errorMsg);
      }
      return response.result;
    }
    // ── State ──
    /**
     * Subscribe to state changes.
     * Callback receives the full new state and the delta (or null for full updates).
     * Returns an unsubscribe function.
     */
    onStateChange(callback) {
      this.stateListeners.add(callback);
      return () => {
        this.stateListeners.delete(callback);
      };
    }
    /**
     * Subscribe to errors.
     * Returns an unsubscribe function.
     */
    onError(callback) {
      this.errorListeners.add(callback);
      return () => {
        this.errorListeners.delete(callback);
      };
    }
    // ── Internal ──
    handleServerMessage(msg) {
      switch (msg.type) {
        case "STATE_UPDATE": {
          const newState = msg.payload?.state;
          if (newState) {
            this._state = { ...this._state, ...newState };
            this.notifyStateChange(this._state, null);
          }
          break;
        }
        case "STATE_DELTA": {
          const delta = msg.payload?.delta;
          if (delta) {
            this._state = { ...this._state, ...delta };
            this.notifyStateChange(this._state, delta);
          }
          break;
        }
        case "ERROR": {
          const error = msg.error || "Unknown error";
          this._error = error;
          this.notifyError(error);
          break;
        }
        default:
          this.log("Unhandled message type:", msg.type);
      }
    }
    notifyStateChange(state, delta) {
      for (const cb of this.stateListeners) {
        cb(state, delta);
      }
    }
    notifyError(error) {
      for (const cb of this.errorListeners) {
        cb(error);
      }
    }
    cleanup() {
      if (this.unregisterComponent) {
        this.unregisterComponent();
        this.unregisterComponent = null;
      }
      this._componentId = null;
      this._mounted = false;
      this._mounting = false;
    }
    log(message, data) {
      if (this.options.debug) {
        console.log(`[Live:${this.componentName}] ${message}`, data ?? "");
      }
    }
  };

  // src/rooms.ts
  var RoomManager = class {
    constructor(options) {
      __publicField(this, "componentId");
      __publicField(this, "defaultRoom");
      __publicField(this, "rooms", /* @__PURE__ */ new Map());
      __publicField(this, "handles", /* @__PURE__ */ new Map());
      __publicField(this, "sendMessage");
      __publicField(this, "sendMessageAndWait");
      __publicField(this, "globalUnsubscribe", null);
      this.componentId = options.componentId;
      this.defaultRoom = options.defaultRoom || null;
      this.sendMessage = options.sendMessage;
      this.sendMessageAndWait = options.sendMessageAndWait;
      this.globalUnsubscribe = options.onMessage((msg) => this.handleServerMessage(msg));
    }
    handleServerMessage(msg) {
      if (msg.componentId !== this.componentId) return;
      const room = this.rooms.get(msg.roomId);
      if (!room) return;
      switch (msg.type) {
        case "ROOM_EVENT":
        case "ROOM_SYSTEM": {
          const handlers = room.handlers.get(msg.event);
          if (handlers) {
            for (const handler of handlers) {
              try {
                handler(msg.data);
              } catch (error) {
                console.error(`[Room:${msg.roomId}] Handler error for '${msg.event}':`, error);
              }
            }
          }
          break;
        }
        case "ROOM_STATE": {
          room.state = { ...room.state, ...msg.data };
          const stateHandlers = room.handlers.get("$state:change");
          if (stateHandlers) {
            for (const handler of stateHandlers) handler(msg.data);
          }
          break;
        }
        case "ROOM_JOINED":
          room.joined = true;
          if (msg.data?.state) room.state = msg.data.state;
          break;
        case "ROOM_LEFT":
          room.joined = false;
          break;
      }
    }
    getOrCreateRoom(roomId) {
      if (!this.rooms.has(roomId)) {
        this.rooms.set(roomId, {
          joined: false,
          state: {},
          handlers: /* @__PURE__ */ new Map()
        });
      }
      return this.rooms.get(roomId);
    }
    /** Create handle for a specific room (cached) */
    createHandle(roomId) {
      if (this.handles.has(roomId)) return this.handles.get(roomId);
      const room = this.getOrCreateRoom(roomId);
      const handle = {
        get id() {
          return roomId;
        },
        get joined() {
          return room.joined;
        },
        get state() {
          return room.state;
        },
        join: async (initialState) => {
          if (!this.componentId) throw new Error("Component not mounted");
          if (room.joined) return;
          if (initialState) room.state = initialState;
          const response = await this.sendMessageAndWait({
            type: "ROOM_JOIN",
            componentId: this.componentId,
            roomId,
            data: { initialState: room.state },
            timestamp: Date.now()
          }, 5e3);
          if (response?.success) {
            room.joined = true;
            if (response.state) room.state = response.state;
          }
        },
        leave: async () => {
          if (!this.componentId || !room.joined) return;
          await this.sendMessageAndWait({
            type: "ROOM_LEAVE",
            componentId: this.componentId,
            roomId,
            timestamp: Date.now()
          }, 5e3);
          room.joined = false;
          room.handlers.clear();
        },
        emit: (event, data) => {
          if (!this.componentId) return;
          this.sendMessage({
            type: "ROOM_EMIT",
            componentId: this.componentId,
            roomId,
            event,
            data,
            timestamp: Date.now()
          });
        },
        on: (event, handler) => {
          const eventKey = event;
          if (!room.handlers.has(eventKey)) room.handlers.set(eventKey, /* @__PURE__ */ new Set());
          room.handlers.get(eventKey).add(handler);
          return () => {
            room.handlers.get(eventKey)?.delete(handler);
          };
        },
        onSystem: (event, handler) => {
          const eventKey = `$${event}`;
          if (!room.handlers.has(eventKey)) room.handlers.set(eventKey, /* @__PURE__ */ new Set());
          room.handlers.get(eventKey).add(handler);
          return () => {
            room.handlers.get(eventKey)?.delete(handler);
          };
        },
        setState: (updates) => {
          if (!this.componentId) return;
          room.state = { ...room.state, ...updates };
          this.sendMessage({
            type: "ROOM_STATE_SET",
            componentId: this.componentId,
            roomId,
            data: updates,
            timestamp: Date.now()
          });
        }
      };
      this.handles.set(roomId, handle);
      return handle;
    }
    /** Create the $room proxy */
    createProxy() {
      const self = this;
      const proxyFn = function(roomId) {
        return self.createHandle(roomId);
      };
      const defaultHandle = this.defaultRoom ? this.createHandle(this.defaultRoom) : null;
      Object.defineProperties(proxyFn, {
        id: { get: () => this.defaultRoom },
        joined: { get: () => defaultHandle?.joined ?? false },
        state: { get: () => defaultHandle?.state ?? {} },
        join: {
          value: async (initialState) => {
            if (!defaultHandle) throw new Error("No default room set");
            return defaultHandle.join(initialState);
          }
        },
        leave: {
          value: async () => {
            if (!defaultHandle) throw new Error("No default room set");
            return defaultHandle.leave();
          }
        },
        emit: {
          value: (event, data) => {
            if (!defaultHandle) throw new Error("No default room set");
            return defaultHandle.emit(event, data);
          }
        },
        on: {
          value: (event, handler) => {
            if (!defaultHandle) throw new Error("No default room set");
            return defaultHandle.on(event, handler);
          }
        },
        onSystem: {
          value: (event, handler) => {
            if (!defaultHandle) throw new Error("No default room set");
            return defaultHandle.onSystem(event, handler);
          }
        },
        setState: {
          value: (updates) => {
            if (!defaultHandle) throw new Error("No default room set");
            return defaultHandle.setState(updates);
          }
        }
      });
      return proxyFn;
    }
    /** List of rooms currently joined */
    getJoinedRooms() {
      const joined = [];
      for (const [id, room] of this.rooms) {
        if (room.joined) joined.push(id);
      }
      return joined;
    }
    /** Update componentId (when component mounts) */
    setComponentId(id) {
      this.componentId = id;
    }
    /** Cleanup */
    destroy() {
      this.globalUnsubscribe?.();
      for (const [, room] of this.rooms) {
        room.handlers.clear();
      }
      this.rooms.clear();
      this.handles.clear();
    }
  };

  // src/upload.ts
  var AdaptiveChunkSizer = class {
    constructor(config = {}) {
      __publicField(this, "config");
      __publicField(this, "currentChunkSize");
      __publicField(this, "metrics", []);
      __publicField(this, "consecutiveErrors", 0);
      __publicField(this, "consecutiveSuccesses", 0);
      this.config = {
        minChunkSize: config.minChunkSize ?? 16 * 1024,
        maxChunkSize: config.maxChunkSize ?? 1024 * 1024,
        initialChunkSize: config.initialChunkSize ?? 64 * 1024,
        targetLatency: config.targetLatency ?? 200,
        adjustmentFactor: config.adjustmentFactor ?? 1.5,
        measurementWindow: config.measurementWindow ?? 3
      };
      this.currentChunkSize = this.config.initialChunkSize;
    }
    getChunkSize() {
      return this.currentChunkSize;
    }
    recordChunkStart(_chunkIndex) {
      return Date.now();
    }
    recordChunkComplete(chunkIndex, chunkSize, startTime, success) {
      const endTime = Date.now();
      const latency = endTime - startTime;
      const throughput = success ? chunkSize / latency * 1e3 : 0;
      this.metrics.push({ chunkIndex, chunkSize, startTime, endTime, latency, throughput, success });
      if (this.metrics.length > this.config.measurementWindow * 2) {
        this.metrics = this.metrics.slice(-this.config.measurementWindow * 2);
      }
      if (success) {
        this.consecutiveSuccesses++;
        this.consecutiveErrors = 0;
        this.adjustUp(latency);
      } else {
        this.consecutiveErrors++;
        this.consecutiveSuccesses = 0;
        this.adjustDown();
      }
    }
    adjustUp(latency) {
      if (this.consecutiveSuccesses < 2) return;
      if (latency > this.config.targetLatency) return;
      const latencyRatio = this.config.targetLatency / latency;
      let newSize = Math.floor(this.currentChunkSize * Math.min(latencyRatio, this.config.adjustmentFactor));
      newSize = Math.min(newSize, this.config.maxChunkSize);
      if (newSize > this.currentChunkSize) this.currentChunkSize = newSize;
    }
    adjustDown() {
      const decreaseFactor = this.consecutiveErrors > 1 ? 2 : this.config.adjustmentFactor;
      let newSize = Math.floor(this.currentChunkSize / decreaseFactor);
      newSize = Math.max(newSize, this.config.minChunkSize);
      if (newSize < this.currentChunkSize) this.currentChunkSize = newSize;
    }
    getAverageThroughput() {
      const recent = this.metrics.slice(-this.config.measurementWindow).filter((m) => m.success);
      if (recent.length === 0) return 0;
      return recent.reduce((sum, m) => sum + m.throughput, 0) / recent.length;
    }
    getStats() {
      return {
        currentChunkSize: this.currentChunkSize,
        averageThroughput: this.getAverageThroughput(),
        consecutiveSuccesses: this.consecutiveSuccesses,
        consecutiveErrors: this.consecutiveErrors,
        totalMeasurements: this.metrics.length
      };
    }
    reset() {
      this.currentChunkSize = this.config.initialChunkSize;
      this.metrics = [];
      this.consecutiveErrors = 0;
      this.consecutiveSuccesses = 0;
    }
  };
  function createBinaryChunkMessage(header, chunkData) {
    const headerJson = JSON.stringify(header);
    const headerBytes = new TextEncoder().encode(headerJson);
    const totalSize = 4 + headerBytes.length + chunkData.length;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const uint8View = new Uint8Array(buffer);
    view.setUint32(0, headerBytes.length, true);
    uint8View.set(headerBytes, 4);
    uint8View.set(chunkData, 4 + headerBytes.length);
    return buffer;
  }
  var ChunkedUploader = class {
    constructor(componentId, options) {
      this.componentId = componentId;
      __publicField(this, "options");
      __publicField(this, "abortController", null);
      __publicField(this, "adaptiveSizer", null);
      __publicField(this, "_state", {
        uploading: false,
        progress: 0,
        error: null,
        uploadId: null,
        bytesUploaded: 0,
        totalBytes: 0
      });
      __publicField(this, "stateListeners", /* @__PURE__ */ new Set());
      this.options = {
        chunkSize: options.chunkSize ?? 64 * 1024,
        maxFileSize: options.maxFileSize ?? 50 * 1024 * 1024,
        allowedTypes: options.allowedTypes ?? [],
        useBinaryProtocol: options.useBinaryProtocol ?? true,
        adaptiveChunking: options.adaptiveChunking ?? false,
        ...options
      };
      if (this.options.adaptiveChunking) {
        this.adaptiveSizer = new AdaptiveChunkSizer({
          initialChunkSize: this.options.chunkSize,
          minChunkSize: this.options.chunkSize,
          maxChunkSize: 1024 * 1024,
          ...options.adaptiveConfig
        });
      }
    }
    get state() {
      return { ...this._state };
    }
    onStateChange(callback) {
      this.stateListeners.add(callback);
      return () => {
        this.stateListeners.delete(callback);
      };
    }
    setState(patch) {
      this._state = { ...this._state, ...patch };
      for (const cb of this.stateListeners) cb(this._state);
    }
    async uploadFile(file) {
      const { allowedTypes, maxFileSize, chunkSize, sendMessageAndWait, sendBinaryAndWait, useBinaryProtocol } = this.options;
      const canUseBinary = useBinaryProtocol && sendBinaryAndWait;
      if (allowedTypes.length > 0 && !allowedTypes.includes(file.type)) {
        const error = `Invalid file type: ${file.type}. Allowed: ${allowedTypes.join(", ")}`;
        this.setState({ error });
        this.options.onError?.(error);
        return;
      }
      if (file.size > maxFileSize) {
        const error = `File too large: ${file.size} bytes. Max: ${maxFileSize} bytes`;
        this.setState({ error });
        this.options.onError?.(error);
        return;
      }
      try {
        const uploadId = `upload-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        this.abortController = new AbortController();
        this.adaptiveSizer?.reset();
        this.setState({ uploading: true, progress: 0, error: null, uploadId, bytesUploaded: 0, totalBytes: file.size });
        const initialChunkSize = this.adaptiveSizer?.getChunkSize() ?? chunkSize;
        const startMessage = {
          type: "FILE_UPLOAD_START",
          componentId: this.componentId,
          uploadId,
          filename: file.name,
          fileType: file.type,
          fileSize: file.size,
          chunkSize,
          requestId: `start-${uploadId}`
        };
        const startResponse = await sendMessageAndWait(startMessage, 1e4);
        if (!startResponse?.success) throw new Error(startResponse?.error || "Failed to start upload");
        let offset = 0;
        let chunkIndex = 0;
        const estimatedTotalChunks = Math.ceil(file.size / initialChunkSize);
        while (offset < file.size) {
          if (this.abortController?.signal.aborted) throw new Error("Upload cancelled");
          const currentChunkSize = this.adaptiveSizer?.getChunkSize() ?? chunkSize;
          const chunkEnd = Math.min(offset + currentChunkSize, file.size);
          const sliceBuffer = await file.slice(offset, chunkEnd).arrayBuffer();
          const chunkBytes = new Uint8Array(sliceBuffer);
          const chunkStartTime = this.adaptiveSizer?.recordChunkStart(chunkIndex) ?? 0;
          const requestId = `chunk-${uploadId}-${chunkIndex}`;
          try {
            let progressResponse;
            if (canUseBinary) {
              const header = {
                type: "FILE_UPLOAD_CHUNK",
                componentId: this.componentId,
                uploadId,
                chunkIndex,
                totalChunks: estimatedTotalChunks,
                requestId
              };
              const binaryMessage = createBinaryChunkMessage(header, chunkBytes);
              progressResponse = await sendBinaryAndWait(binaryMessage, requestId, 1e4);
            } else {
              let binary = "";
              for (let j = 0; j < chunkBytes.length; j++) binary += String.fromCharCode(chunkBytes[j]);
              const chunkMessage = {
                type: "FILE_UPLOAD_CHUNK",
                componentId: this.componentId,
                uploadId,
                chunkIndex,
                totalChunks: estimatedTotalChunks,
                data: btoa(binary),
                requestId
              };
              progressResponse = await sendMessageAndWait(chunkMessage, 1e4);
            }
            if (progressResponse) {
              this.setState({ progress: progressResponse.progress, bytesUploaded: progressResponse.bytesUploaded });
              this.options.onProgress?.(progressResponse.progress, progressResponse.bytesUploaded, file.size);
            }
            this.adaptiveSizer?.recordChunkComplete(chunkIndex, chunkBytes.length, chunkStartTime, true);
          } catch (error) {
            this.adaptiveSizer?.recordChunkComplete(chunkIndex, chunkBytes.length, chunkStartTime, false);
            throw error;
          }
          offset += chunkBytes.length;
          chunkIndex++;
          if (!this.options.adaptiveChunking) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        const completeMessage = {
          type: "FILE_UPLOAD_COMPLETE",
          componentId: this.componentId,
          uploadId,
          requestId: `complete-${uploadId}`
        };
        const completeResponse = await sendMessageAndWait(completeMessage, 1e4);
        if (completeResponse?.success) {
          this.setState({ uploading: false, progress: 100, bytesUploaded: file.size });
          this.options.onComplete?.(completeResponse);
        } else {
          throw new Error(completeResponse?.error || "Upload completion failed");
        }
      } catch (error) {
        this.setState({ uploading: false, error: error.message });
        this.options.onError?.(error.message);
      }
    }
    cancelUpload() {
      if (this.abortController) {
        this.abortController.abort();
        this.setState({ uploading: false, error: "Upload cancelled" });
      }
    }
    reset() {
      this._state = { uploading: false, progress: 0, error: null, uploadId: null, bytesUploaded: 0, totalBytes: 0 };
      for (const cb of this.stateListeners) cb(this._state);
    }
  };

  // src/persistence.ts
  var STORAGE_KEY_PREFIX = "fluxstack_component_";
  var STATE_MAX_AGE = 24 * 60 * 60 * 1e3;
  function persistState(enabled, name, signedState, room, userId) {
    if (!enabled) return;
    try {
      localStorage.setItem(`${STORAGE_KEY_PREFIX}${name}`, JSON.stringify({
        componentName: name,
        signedState,
        room,
        userId,
        lastUpdate: Date.now()
      }));
    } catch {
    }
  }
  function getPersistedState(enabled, name) {
    if (!enabled) return null;
    try {
      const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${name}`);
      if (!stored) return null;
      const state = JSON.parse(stored);
      if (Date.now() - state.lastUpdate > STATE_MAX_AGE) {
        localStorage.removeItem(`${STORAGE_KEY_PREFIX}${name}`);
        return null;
      }
      return state;
    } catch {
      return null;
    }
  }
  function clearPersistedState(enabled, name) {
    if (!enabled) return;
    try {
      localStorage.removeItem(`${STORAGE_KEY_PREFIX}${name}`);
    } catch {
    }
  }

  // src/state-validator.ts
  var StateValidator = class {
    static generateChecksum(state) {
      const json = JSON.stringify(state, Object.keys(state).sort());
      let hash = 0;
      for (let i = 0; i < json.length; i++) {
        const char = json.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
      }
      return Math.abs(hash).toString(16);
    }
    static createValidation(state, source = "client") {
      return {
        checksum: this.generateChecksum(state),
        version: Date.now(),
        timestamp: Date.now(),
        source
      };
    }
    static detectConflicts(clientState, serverState, excludeFields = ["lastUpdated", "version"]) {
      const conflicts = [];
      const clientKeys = Object.keys(clientState);
      const serverKeys = Object.keys(serverState);
      const allKeys = Array.from(/* @__PURE__ */ new Set([...clientKeys, ...serverKeys]));
      for (const key of allKeys) {
        if (excludeFields.includes(key)) continue;
        const clientValue = clientState?.[key];
        const serverValue = serverState?.[key];
        if (JSON.stringify(clientValue) !== JSON.stringify(serverValue)) {
          conflicts.push({
            property: key,
            clientValue,
            serverValue,
            timestamp: Date.now(),
            resolved: false
          });
        }
      }
      return conflicts;
    }
    static mergeStates(clientState, serverState, conflicts, strategy = "smart") {
      const merged = { ...clientState };
      for (const conflict of conflicts) {
        switch (strategy) {
          case "client":
            break;
          case "server":
            merged[conflict.property] = conflict.serverValue;
            break;
          case "smart":
            if (conflict.property === "lastUpdated") {
              merged[conflict.property] = conflict.serverValue;
            } else if (typeof conflict.serverValue === "number" && typeof conflict.clientValue === "number") {
              merged[conflict.property] = Math.max(conflict.serverValue, conflict.clientValue);
            } else {
              merged[conflict.property] = conflict.serverValue;
            }
            break;
        }
      }
      return merged;
    }
    static validateState(hybridState) {
      const currentChecksum = this.generateChecksum(hybridState.data);
      return currentChecksum === hybridState.validation.checksum;
    }
    static updateValidation(hybridState, source = "client") {
      return {
        ...hybridState,
        validation: this.createValidation(hybridState.data, source),
        status: "synced"
      };
    }
  };

  // src/index.ts
  var _sharedConnection = null;
  var _sharedConnectionUrl = null;
  var _statusListeners = /* @__PURE__ */ new Set();
  function getOrCreateConnection(url) {
    const resolvedUrl = url ?? `ws://${typeof location !== "undefined" ? location.host : "localhost:3000"}/api/live/ws`;
    if (_sharedConnection && _sharedConnectionUrl === resolvedUrl) {
      return _sharedConnection;
    }
    if (_sharedConnection) {
      _sharedConnection.destroy();
    }
    _sharedConnection = new LiveConnection({ url: resolvedUrl });
    _sharedConnectionUrl = resolvedUrl;
    _sharedConnection.onStateChange((state) => {
      for (const cb of _statusListeners) {
        cb(state.connected);
      }
    });
    return _sharedConnection;
  }
  function useLive(componentName, initialState, options = {}) {
    const { url, room, userId, autoMount = true, debug = false } = options;
    const connection = getOrCreateConnection(url);
    const handle = new LiveComponentHandle(connection, componentName, {
      initialState,
      room,
      userId,
      autoMount,
      debug
    });
    return {
      call: (action, payload) => handle.call(action, payload ?? {}),
      on: (callback) => handle.onStateChange(callback),
      onError: (callback) => handle.onError(callback),
      get state() {
        return handle.state;
      },
      get mounted() {
        return handle.mounted;
      },
      get componentId() {
        return handle.componentId;
      },
      get error() {
        return handle.error;
      },
      destroy: () => handle.destroy(),
      handle
    };
  }
  function onConnectionChange(callback) {
    _statusListeners.add(callback);
    if (_sharedConnection) {
      callback(_sharedConnection.state.connected);
    }
    return () => {
      _statusListeners.delete(callback);
    };
  }
  function getConnection(url) {
    return getOrCreateConnection(url);
  }
  return __toCommonJS(src_exports);
})();
//# sourceMappingURL=live-client.browser.global.js.map