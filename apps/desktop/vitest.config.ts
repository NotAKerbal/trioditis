import { defineConfig } from 'vitest/config'

// Tests run in Node without the app's Vite plugins (route generation, Tailwind, the dev proxy).
export default defineConfig({
  resolve: { alias: { '~': new URL('./src', import.meta.url).pathname } },
  test: { include: ['test/**/*.test.ts'] },
})
