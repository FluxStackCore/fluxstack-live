import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    proxy: {
      '/api/live/ws': {
        target: 'http://localhost:4002',
        ws: true,
      },
      '/api': 'http://localhost:4002',
    },
  },
})
