import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  base: '/laser-marketplace/',
  plugins: [react()],
  server: { proxy: { '/workshop-api': { target: 'http://127.0.0.1:4318', changeOrigin: true } } },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
})
