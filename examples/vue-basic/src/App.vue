<script setup lang="ts">
import { provideLiveConnection } from '@fluxstack/live-vue'
import Counter from './components/Counter.vue'
import Chat from './components/Chat.vue'

const { connected, error } = provideLiveConnection({
  url: `ws://${window.location.host}/api/live/ws`,
  debug: true,
})
</script>

<template>
  <div class="app">
    <h1>Vue + @fluxstack/live</h1>
    <p class="subtitle">Real-time Live Components with Vue 3</p>

    <Counter />

    <hr class="divider" />

    <Chat />

    <div :class="['status', connected ? 'connected' : 'disconnected']">
      {{ connected ? 'Connected' : 'Disconnected' }}
      <span v-if="error" class="error-msg">{{ error }}</span>
    </div>
  </div>
</template>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: system-ui, sans-serif;
  background: #0f172a;
  color: #e2e8f0;
  display: flex;
  justify-content: center;
  padding: 2rem 1rem;
  min-height: 100vh;
}
.app {
  background: #1e293b;
  border-radius: 16px;
  padding: 2rem;
  max-width: 520px;
  width: 100%;
  box-shadow: 0 4px 24px rgba(0,0,0,.3);
  text-align: center;
}
.divider {
  border: none;
  border-top: 1px solid #334155;
  margin: 1.5rem 0;
}
h1 { font-size: 1.5rem; margin-bottom: .25rem; }
.subtitle { color: #94a3b8; margin-bottom: 1.5rem; font-size: .875rem; }
.status {
  margin-top: 1.5rem;
  padding: .75rem;
  border-radius: 8px;
  background: #0f172a;
  font-size: .8rem;
  color: #94a3b8;
}
.status.connected { border: 1px solid #22c55e44; }
.status.disconnected { border: 1px solid #ef444444; }
.error-msg { color: #ef4444; margin-left: .5rem; }
</style>
