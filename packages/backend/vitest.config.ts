import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'edge-runtime',
    // Many tests run Convex functions over thousands of rows, or Argon2id; on a machine busy
    // with other builds (CI shares one with agents) they can take several seconds.
    testTimeout: 30_000,
    server: { deps: { inline: ['convex-test'] } },
  },
})
