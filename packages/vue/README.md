# @fluxstack/live-vue

Vue 3 bindings for `@fluxstack/live-client`.

## Installation

```bash
bun add @fluxstack/live-vue @fluxstack/live-client @fluxstack/live vue
```

## Quick Start

### 1. Provide Connection (Root Component)

```vue
<script setup>
import { provideLiveConnection } from '@fluxstack/live-vue'

provideLiveConnection({
  url: 'ws://localhost:3000/api/live/ws',
  autoConnect: true,
  reconnectInterval: 1000,
})
</script>

<template>
  <router-view />
</template>
```

### 2. Use Components

```vue
<script setup>
import { useLive } from '@fluxstack/live-vue'

const { state, call, connected, error } = useLive('Counter', {
  count: 0,
  lastAction: null,
})
</script>

<template>
  <div>
    <p>Count: {{ state.count }}</p>
    <p>{{ connected ? 'Online' : 'Offline' }}</p>
    <button @click="call('increment')">+</button>
    <button @click="call('decrement')">-</button>
    <button @click="call('reset')">Reset</button>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>
```

## API

### `provideLiveConnection(options)`

Provides a `LiveConnection` to all child components via Vue's `provide/inject`. Call in your root component's `setup()`:

```typescript
const ctx = provideLiveConnection({
  url: 'ws://localhost:3000/api/live/ws',
  autoConnect: true,
  reconnectInterval: 1000,
  auth: { token: 'jwt-token', provider: 'jwt' },
})

// ctx.connected    - Ref<boolean>
// ctx.connecting   - Ref<boolean>
// ctx.error        - Ref<string | null>
// ctx.connectionId - Ref<string | null>
// ctx.authenticated - Ref<boolean>
// ctx.reconnect()  - Force reconnect
// ctx.authenticate(credentials) - Authenticate
```

Automatically disconnects and cleans up on component unmount.

### `useLiveConnection()`

Access the connection context from any child component:

```vue
<script setup>
import { useLiveConnection } from '@fluxstack/live-vue'

const { connected, error, reconnect } = useLiveConnection()
</script>
```

### `useLive(componentName, initialState, options?)`

Composable to use a Live Component. Returns reactive state that auto-syncs with the server:

```typescript
const {
  state,       // DeepReadonly<TState> - reactive, use in templates
  mounted,     // Ref<boolean> - component mounted on server
  mounting,    // Ref<boolean> - currently mounting
  connected,   // Ref<boolean> - WebSocket connected
  error,       // Ref<string | null> - last error
  componentId, // Ref<string | null> - server-assigned ID
  call,        // (action, payload?) => Promise<R> - call server action
  mount,       // () => Promise<void> - manual mount
  unmount,     // () => Promise<void> - manual unmount
} = useLive('Counter', { count: 0 }, {
  room: 'optional-room',
  userId: 'user-123',
  autoMount: true,    // Mount when connected (default: true)
  debug: false,       // Log to console (default: false)
})
```

`useLiveComponent` is an alias for `useLive`.

### State Reactivity

The `state` object is a Vue `reactive()` wrapped in `readonly()`. It updates automatically when the server pushes `STATE_UPDATE` or `STATE_DELTA` messages:

```vue
<template>
  <!-- Reactive - re-renders on server state changes -->
  <p>{{ state.count }}</p>
  <p>{{ state.users.length }} users online</p>

  <!-- Computed works too -->
  <p>{{ doubleCount }}</p>
</template>

<script setup>
import { computed } from 'vue'
import { useLive } from '@fluxstack/live-vue'

const { state } = useLive('Counter', { count: 0 })
const doubleCount = computed(() => state.count * 2)
</script>
```

### Auto-Reconnect

When the WebSocket connection drops and reconnects, `useLive` automatically re-mounts the component and resumes state sync. No manual handling needed.

## Complete Example

```vue
<script setup>
import { ref } from 'vue'
import { useLive } from '@fluxstack/live-vue'

const { state, call, connected, error } = useLive('TodoList', {
  todos: [],
})

const newTodo = ref('')

async function addTodo() {
  if (!newTodo.value.trim()) return
  await call('addTodo', { text: newTodo.value })
  newTodo.value = ''
}

async function toggleTodo(id: string) {
  await call('toggleTodo', { id })
}
</script>

<template>
  <div>
    <span :class="connected ? 'online' : 'offline'">
      {{ connected ? 'Connected' : 'Disconnected' }}
    </span>

    <form @submit.prevent="addTodo">
      <input v-model="newTodo" placeholder="New todo..." />
      <button type="submit">Add</button>
    </form>

    <ul>
      <li
        v-for="todo in state.todos"
        :key="todo.id"
        :class="{ done: todo.done }"
        @click="toggleTodo(todo.id)"
      >
        {{ todo.text }}
      </li>
    </ul>

    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>
```

## Requirements

- Vue `>=3.3.0`

## License

MIT
