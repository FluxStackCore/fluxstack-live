<script setup lang="ts">
import { useLive } from '@fluxstack/live-vue'

const { state, call, error } = useLive('Counter', {
  count: 0,
  lastAction: null as string | null,
})
</script>

<template>
  <div class="counter">
    <div class="count">{{ state.count }}</div>
    <div class="last-action">
      {{ state.lastAction ? `last: ${state.lastAction}` : '--' }}
    </div>

    <div class="buttons">
      <button class="dec" @click="call('decrement')">-</button>
      <button class="reset" @click="call('reset')">Reset</button>
      <button class="inc" @click="call('increment')">+</button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.counter { padding: 1rem 0; }
.count {
  font-size: 4rem;
  font-weight: 700;
  text-align: center;
  margin: 1rem 0;
  color: #38bdf8;
}
.last-action {
  text-align: center;
  color: #94a3b8;
  font-size: .8rem;
  margin-bottom: 1.5rem;
}
.buttons {
  display: flex;
  gap: .75rem;
  justify-content: center;
}
button {
  padding: .6rem 1.5rem;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  cursor: pointer;
  font-weight: 600;
  transition: transform .1s;
}
button:active { transform: scale(.95); }
.dec { background: #ef4444; color: #fff; }
.reset { background: #64748b; color: #fff; }
.inc { background: #22c55e; color: #fff; }
.error { color: #ef4444; text-align: center; margin-top: 1rem; font-size: .85rem; }
</style>
