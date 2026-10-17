import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/spelling-checker/',
  plugins: [react()],
  server: {
    port: 3036,
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3035',
        changeOrigin: true,
      },
      '/bloom': {
        target: 'http://127.0.0.1:3035',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 3036,
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3035',
        changeOrigin: true,
      },
      '/bloom': {
        target: 'http://127.0.0.1:3035',
        changeOrigin: true,
      },
    },
  },
})
